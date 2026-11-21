import { Disposable, Emitter } from '../util/emitter';
import { TwitchChat } from './twitch/twitchChat';
import {
	ChatAuth,
	ChatEvent,
	ChatMessage,
	ChatSink,
	ChatSource,
	Platform,
	SourceInfo,
	SourceStatus,
	TwitchSource,
	YouTubeSource,
} from './types';
import { YouTubeChat, YouTubeTransport } from './youtube/youtubeChat';

/** The subset of `vscode.Memento` this needs. */
export interface StateStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

export interface ChatServiceConfig {
	maxMessages: number;
	youtubeTransport: YouTubeTransport;
}

export interface PlatformAuth extends ChatAuth {
	onDidChange(listener: () => void): Disposable;
}

export interface ChatServiceOptions {
	state: StateStore;
	twitchAuth: PlatformAuth;
	youtubeAuth: PlatformAuth;
	getConfig(): ChatServiceConfig;
	log(message: string): void;
}

const SOURCES_KEY = 'caerwyn.sources';
/** Events are handed to listeners in batches, so a busy chat does not post one message at a time. */
const FLUSH_MS = 50;

/**
 * Owns the list of chat sources, the connections that read them, and a capped buffer of recent
 * messages. Connections only run between `start()` and `stop()`, that is while the chat tab is open.
 */
export class ChatService {
	private readonly eventsEmitter = new Emitter<ChatEvent[]>();
	private readonly sourcesEmitter = new Emitter<SourceInfo[]>();
	private readonly resetEmitter = new Emitter<void>();
	readonly onEvents = this.eventsEmitter.event;
	readonly onSources = this.sourcesEmitter.event;
	readonly onReset = this.resetEmitter.event;

	private sourceList: ChatSource[];
	private readonly statuses = new Map<string, SourceStatus>();
	private readonly labels = new Map<string, string>();
	private buffer: ChatMessage[] = [];
	private readonly keys = new Set<string>();
	private pending: ChatEvent[] = [];
	private flushTimer: NodeJS.Timeout | undefined;
	private readonly rebuildTimers = new Map<Platform, NodeJS.Timeout>();
	private running = false;
	private twitch: TwitchChat | undefined;
	private readonly youtube = new Map<string, YouTubeChat>();
	private readonly subscriptions: Disposable[];
	private readonly sink: ChatSink;

	constructor(private readonly options: ChatServiceOptions) {
		this.sourceList = options.state.get<ChatSource[]>(SOURCES_KEY) ?? [];
		this.sink = {
			event: (event) => this.onEvent(event),
			status: (sourceId, status, label) => this.onStatus(sourceId, status, label),
			log: options.log,
		};
		this.subscriptions = [
			options.twitchAuth.onDidChange(() => this.scheduleRebuild('twitch')),
			options.youtubeAuth.onDidChange(() => this.scheduleRebuild('youtube')),
		];
	}

	get messages(): readonly ChatMessage[] {
		return this.buffer;
	}

	get sources(): SourceInfo[] {
		return this.sourceList.map((source) => ({
			source,
			label: this.labels.get(source.id) ?? defaultLabel(source),
			status: this.statuses.get(source.id) ?? { state: 'idle' },
		}));
	}

	start(): void {
		if (this.running) {
			return;
		}
		this.running = true;
		this.rebuild('twitch');
		this.rebuild('youtube');
	}

	stop(): void {
		this.running = false;
		for (const timer of this.rebuildTimers.values()) {
			clearTimeout(timer);
		}
		this.rebuildTimers.clear();
		this.disposeConnections('twitch');
		this.disposeConnections('youtube');
		this.statuses.clear();
		this.sourcesEmitter.fire(this.sources);
	}

	/** Adds a source unless it is already there. Returns whether it was added. */
	async addSource(source: ChatSource): Promise<boolean> {
		if (this.sourceList.some((existing) => existing.id === source.id)) {
			return false;
		}
		this.sourceList = [...this.sourceList, source];
		await this.options.state.update(SOURCES_KEY, this.sourceList);
		this.sourcesEmitter.fire(this.sources);
		this.scheduleRebuild(source.platform);
		return true;
	}

	async removeSource(sourceId: string): Promise<void> {
		const source = this.sourceList.find((existing) => existing.id === sourceId);
		if (!source) {
			return;
		}
		this.sourceList = this.sourceList.filter((existing) => existing.id !== sourceId);
		this.statuses.delete(sourceId);
		this.labels.delete(sourceId);
		await this.options.state.update(SOURCES_KEY, this.sourceList);
		this.sourcesEmitter.fire(this.sources);
		this.scheduleRebuild(source.platform);
	}

	reconnect(): void {
		if (this.running) {
			this.rebuild('twitch');
			this.rebuild('youtube');
		}
	}

	clearMessages(): void {
		this.buffer = [];
		this.keys.clear();
		this.pending = [];
		this.resetEmitter.fire();
	}

	dispose(): void {
		this.stop();
		clearTimeout(this.flushTimer);
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.eventsEmitter.dispose();
		this.sourcesEmitter.dispose();
		this.resetEmitter.dispose();
	}

	/** Coalesces rebuilds, so signing in and adding the account's own source reconnects only once. */
	private scheduleRebuild(platform: Platform): void {
		if (!this.running) {
			return;
		}
		clearTimeout(this.rebuildTimers.get(platform));
		this.rebuildTimers.set(
			platform,
			setTimeout(() => {
				this.rebuildTimers.delete(platform);
				this.rebuild(platform);
			}, FLUSH_MS),
		);
	}

	private rebuild(platform: Platform): void {
		this.disposeConnections(platform);
		if (!this.running) {
			return;
		}
		if (platform === 'twitch') {
			const sources = this.sourceList.filter((source): source is TwitchSource => source.platform === 'twitch');
			if (sources.length > 0) {
				this.twitch = new TwitchChat({ auth: this.options.twitchAuth, sources, sink: this.sink });
				this.twitch.start();
			}
			return;
		}
		const transport = this.options.getConfig().youtubeTransport;
		for (const source of this.sourceList) {
			if (source.platform === 'youtube') {
				const chat = new YouTubeChat({ auth: this.options.youtubeAuth, source: source as YouTubeSource, sink: this.sink, transport });
				this.youtube.set(source.id, chat);
				chat.start();
			}
		}
	}

	private disposeConnections(platform: Platform): void {
		if (platform === 'twitch') {
			this.twitch?.dispose();
			this.twitch = undefined;
			return;
		}
		for (const chat of this.youtube.values()) {
			chat.dispose();
		}
		this.youtube.clear();
	}

	private onStatus(sourceId: string, status: SourceStatus, label?: string): void {
		if (!this.sourceList.some((source) => source.id === sourceId)) {
			return;
		}
		this.statuses.set(sourceId, status);
		if (label) {
			this.labels.set(sourceId, label);
		}
		this.sourcesEmitter.fire(this.sources);
	}

	private onEvent(event: ChatEvent): void {
		switch (event.type) {
			case 'message': {
				if (this.keys.has(event.message.key)) {
					return; // Platforms can deliver a message more than once.
				}
				this.keys.add(event.message.key);
				this.buffer.push(event.message);
				const max = Math.max(1, this.options.getConfig().maxMessages);
				while (this.buffer.length > max) {
					this.keys.delete((this.buffer.shift() as ChatMessage).key);
				}
				break;
			}
			case 'delete':
				this.drop((message) => message.key === event.key);
				break;
			case 'purge':
				this.drop(
					(message) =>
						message.platform === event.platform && message.channelId === event.channelId && message.author.id === event.userId,
				);
				break;
			case 'clear':
				this.drop((message) => message.platform === event.platform && message.channelId === event.channelId);
				break;
		}
		this.pending.push(event);
		this.flushTimer ??= setTimeout(() => {
			this.flushTimer = undefined;
			const events = this.pending;
			this.pending = [];
			if (events.length > 0) {
				this.eventsEmitter.fire(events);
			}
		}, FLUSH_MS);
	}

	/** Removed messages leave the buffer, so reopening the tab never shows them again. */
	private drop(predicate: (message: ChatMessage) => boolean): void {
		this.buffer = this.buffer.filter((message) => {
			if (!predicate(message)) {
				return true;
			}
			this.keys.delete(message.key);
			return false;
		});
	}
}

export function defaultLabel(source: ChatSource): string {
	if (source.kind === 'self') {
		return source.platform === 'twitch' ? 'Your Twitch channel' : 'Your YouTube broadcast';
	}
	return source.kind === 'channel' ? source.login : source.videoId;
}
