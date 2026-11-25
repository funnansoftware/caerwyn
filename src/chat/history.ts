import { createHash } from 'crypto';
import { promises as fs, appendFileSync, mkdirSync } from 'fs';
import * as path from 'path';
import { asRecord, isRecord, parseJson } from '../util/json';
import { ChatEvent, ChatMessage, HistoryEntry, HistoryPage, HistoryQuery, Platform } from './types';

export type { HistoryEntry, HistoryPage, HistoryQuery };

// Each viewer's messages, saved on this computer so their user card can show more than the chat still holds.
// Neither platform lets a client read a viewer's past chat, so history covers only what Caerwyn has seen.
//
// One append-only JSON Lines file per viewer per chat room. A room is a Twitch channel, or a YouTube source:
// YouTube's chat ID changes with every broadcast, so the source is what stays the same across streams.
// Removals are written as tombstones, so a removed message is never shown again. Its text stays in the file until
// the file is next compacted (see `compact`), which rewrites it without.

export const HISTORY_PAGE_MAX = 1000;
/** The most messages kept for one viewer in one room. Older ones are dropped when the file is next read. */
const KEEP_PER_USER = 5000;
/** A file is rewritten once it holds this many more lines than it keeps, so rewrites are rare. */
const COMPACT_SLACK = 1000;
/** Messages remembered from this session, so a removal (which names a key or a user, not a file) finds its file. */
const INDEX_MAX = 20_000;
const FLUSH_MS = 1000;
const ID_MAX = 256;

type Line = { m: ChatMessage } | { d: string };

interface Indexed {
	file: string;
	platform: Platform;
	channelId: string;
	userId: string;
}

/** What a chat room is called in history. See the note at the top of this file. */
export function historyRoom(platform: Platform, sourceId: string, channelId: string): string {
	return platform === 'twitch' ? channelId : sourceId;
}

/** Checks a saved message has what reading history relies on, since the file may be damaged or from an older version. */
function isStoredMessage(value: unknown): value is ChatMessage {
	return (
		isRecord(value) &&
		typeof value.key === 'string' &&
		(value.platform === 'twitch' || value.platform === 'youtube') &&
		typeof value.channelId === 'string' &&
		typeof value.timestamp === 'number' &&
		isRecord(value.author) &&
		typeof value.author.id === 'string' &&
		Array.isArray(value.fragments)
	);
}

function isId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= ID_MAX;
}

/** Checks a request from the webview, which is untrusted. */
export function parseHistoryQuery(raw: unknown): HistoryQuery | undefined {
	if (!isRecord(raw)) {
		return undefined;
	}
	const value = raw;
	if (value.platform !== 'twitch' && value.platform !== 'youtube') {
		return undefined;
	}
	if (!isId(value.sourceId) || !isId(value.channelId) || !isId(value.userId)) {
		return undefined;
	}
	if (value.before !== undefined && !isId(value.before)) {
		return undefined;
	}
	const limit = typeof value.limit === 'number' && Number.isSafeInteger(value.limit) ? Math.min(Math.max(value.limit, 1), HISTORY_PAGE_MAX) : 100;
	return { platform: value.platform, sourceId: value.sourceId, channelId: value.channelId, userId: value.userId, before: value.before, limit };
}

export interface ChatHistoryOptions {
	/** The folder history is kept in. Created when first written. */
	directory: string;
	/** Whether new messages are saved. Reading what is already saved works either way. */
	isEnabled(): boolean;
	log(message: string): void;
}

export class ChatHistory {
	private pending = new Map<string, string[]>();
	private flushTimer: NodeJS.Timeout | undefined;
	private flushing: Promise<void> = Promise.resolve();
	private readonly index = new Map<string, Indexed>();
	private madeDirectory = false;
	private disposed = false;

	constructor(private readonly options: ChatHistoryOptions) {}

	/** Takes note of a chat event from a real (not simulated) source. */
	record(event: ChatEvent): void {
		if (this.disposed) {
			return;
		}
		switch (event.type) {
			case 'message':
			case 'update': {
				const { message } = event;
				// AutoMod holds are not chat: what they caught stays out of sight, and off the disk.
				// Removals below are recorded even while saving is off, so nothing saved earlier comes back.
				if (!this.options.isEnabled() || message.held || !isId(message.author.id)) {
					return;
				}
				const file = this.fileFor(message.platform, historyRoom(message.platform, message.sourceId, message.channelId), message.author.id);
				this.remember(message.key, { file, platform: message.platform, channelId: message.channelId, userId: message.author.id });
				this.write(file, { m: message });
				break;
			}
			case 'delete': {
				const known = this.index.get(event.key);
				if (known) {
					this.write(known.file, { d: event.key });
				}
				break;
			}
			case 'purge':
			case 'clear':
				// Like the chat itself, these remove what was said recently, not everything a viewer ever wrote.
				for (const [key, known] of this.index) {
					if (
						known.platform === event.platform &&
						known.channelId === event.channelId &&
						(event.type === 'clear' || known.userId === event.userId)
					) {
						this.write(known.file, { d: key });
					}
				}
				break;
		}
	}

	/** A page of one viewer's saved messages in one room, newest last. */
	async page(query: HistoryQuery): Promise<HistoryPage> {
		const room = historyRoom(query.platform, query.sourceId, query.channelId);
		const file = this.fileFor(query.platform, room, query.userId);
		await this.flush();
		const entries = await this.read(file, (message) =>
			message.platform === query.platform &&
			message.author.id === query.userId &&
			historyRoom(message.platform, message.sourceId, message.channelId) === room,
		);
		let end = entries.length;
		if (query.before !== undefined) {
			end = entries.findIndex((entry) => entry.message.key === query.before);
			if (end < 0) {
				return { entries: [], more: false, total: entries.length };
			}
		}
		const start = Math.max(0, end - query.limit);
		return { entries: entries.slice(start, end), more: start > 0, total: entries.length };
	}

	/** Deletes everything saved. */
	async clear(): Promise<void> {
		this.pending.clear();
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		await this.flushing;
		this.index.clear();
		await fs.rm(this.options.directory, { recursive: true, force: true });
		this.madeDirectory = false;
	}

	/** Writes anything not yet saved. */
	flush(): Promise<void> {
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		const batch = this.pending;
		this.pending = new Map();
		this.flushing = this.flushing.then(async () => {
			if (batch.size === 0) {
				return;
			}
			try {
				await this.ensureDirectory();
				await Promise.all([...batch].map(([file, lines]) => fs.appendFile(file, lines.join(''), 'utf8')));
			} catch (error) {
				this.options.log(`Could not save chat history: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
		return this.flushing;
	}

	/** Saves what is left synchronously, because the extension host may exit before anything asynchronous finishes. */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		clearTimeout(this.flushTimer);
		try {
			if (this.pending.size > 0) {
				mkdirSync(this.options.directory, { recursive: true });
				for (const [file, lines] of this.pending) {
					appendFileSync(file, lines.join(''), 'utf8');
				}
			}
		} catch (error) {
			this.options.log(`Could not save chat history: ${error instanceof Error ? error.message : String(error)}`);
		}
		this.pending.clear();
	}

	private fileFor(platform: Platform, room: string, userId: string): string {
		// IDs are case-sensitive and may hold any character, so the name is a hash. Reads check the IDs themselves.
		const hash = createHash('sha256').update(`${platform}\n${room}\n${userId}`).digest('hex').slice(0, 40);
		return path.join(this.options.directory, `${hash}.jsonl`);
	}

	private remember(key: string, indexed: Indexed): void {
		this.index.delete(key);
		this.index.set(key, indexed);
		if (this.index.size > INDEX_MAX) {
			this.index.delete(this.index.keys().next().value as string);
		}
	}

	private write(file: string, line: Line): void {
		const lines = this.pending.get(file) ?? [];
		lines.push(`${JSON.stringify(line)}\n`);
		this.pending.set(file, lines);
		this.flushTimer ??= setTimeout(() => void this.flush(), FLUSH_MS);
	}

	private async ensureDirectory(): Promise<void> {
		if (!this.madeDirectory) {
			await fs.mkdir(this.options.directory, { recursive: true });
			this.madeDirectory = true;
		}
	}

	private async read(file: string, belongs: (message: ChatMessage) => boolean): Promise<HistoryEntry[]> {
		let text: string;
		try {
			text = await fs.readFile(file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				this.options.log(`Could not read chat history: ${error instanceof Error ? error.message : String(error)}`);
			}
			return [];
		}
		// Later lines win: an update replaces the message, a tombstone removes it. Two VS Code windows reading the
		// same chat both write every message, so repeats are expected. A `Map` keeps each key where it first appeared.
		const messages = new Map<string, ChatMessage>();
		const deleted = new Set<string>();
		const lines = text.split('\n');
		for (const raw of lines) {
			if (!raw) {
				continue;
			}
			const line = asRecord(parseJson(raw)); // Not an object when a crash cut the line short.
			if (!line) {
				continue;
			}
			if (isStoredMessage(line.m) && belongs(line.m)) {
				messages.set(line.m.key, line.m);
			} else if (typeof line.d === 'string') {
				deleted.add(line.d);
			}
		}
		let entries: HistoryEntry[] = [...messages.values()]
			.sort((a, b) => a.timestamp - b.timestamp)
			.map((message) => (deleted.has(message.key) ? { message: stripped(message), deleted: true } : { message, deleted: false }));
		if (entries.length > KEEP_PER_USER) {
			entries = entries.slice(-KEEP_PER_USER);
		}
		if (lines.length > KEEP_PER_USER + COMPACT_SLACK) {
			// Queued with the writes, so nothing appended by this window lands between the rewrite's read and rename.
			const kept = entries;
			this.flushing = this.flushing.then(() => this.compact(file, kept));
			await this.flushing;
		}
		return entries;
	}

	/** Rewrites a file with only what it still needs. Removed messages lose their text for good. */
	private async compact(file: string, entries: HistoryEntry[]): Promise<void> {
		const body = entries
			.map((entry) => `${JSON.stringify({ m: entry.message })}\n${entry.deleted ? `${JSON.stringify({ d: entry.message.key })}\n` : ''}`)
			.join('');
		const temporary = `${file}.${process.pid}.tmp`;
		try {
			await fs.writeFile(temporary, body, 'utf8');
			await fs.rename(temporary, file);
		} catch (error) {
			this.options.log(`Could not compact chat history: ${error instanceof Error ? error.message : String(error)}`);
			await fs.rm(temporary, { force: true });
		}
	}
}

/** What a removed message keeps: enough to show that something was said, and when, but not what. */
function stripped(message: ChatMessage): ChatMessage {
	const { replyTo: _replyTo, headline: _headline, spent: _spent, ...rest } = message;
	return { ...rest, fragments: [] };
}
