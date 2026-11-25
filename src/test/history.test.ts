import * as assert from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatService, PlatformAuth, StateStore } from '../chat/chatService';
import { ChatHistory, parseHistoryQuery } from '../chat/history';
import { SIMULATED_SOURCES } from '../chat/simulation/simulatedChat';
import { ChatMessage, HistoryQuery, NotSignedInError, Platform } from '../chat/types';

const DAY = 24 * 60 * 60 * 1000;

function message(id: string, options: Partial<ChatMessage> & { userId?: string; daysAgo?: number } = {}): ChatMessage {
	const { userId = 'u1', daysAgo = 0, ...rest } = options;
	const platform: Platform = rest.platform ?? 'twitch';
	return {
		key: `${platform}:${id}`,
		platform,
		id,
		sourceId: platform === 'twitch' ? 'twitch:me' : 'youtube:me',
		channelId: 'c1',
		channelName: 'me',
		author: { id: userId, name: userId, roles: [] },
		fragments: [{ type: 'text', text: `said ${id}` }],
		timestamp: Date.now() - daysAgo * DAY,
		...rest,
	};
}

function query(overrides: Partial<HistoryQuery> = {}): HistoryQuery {
	return { platform: 'twitch', sourceId: 'twitch:me', channelId: 'c1', userId: 'u1', limit: 100, ...overrides };
}

suite('ChatHistory', () => {
	let directory: string;
	let enabled: boolean;
	let history: ChatHistory;

	const open = () => new ChatHistory({ directory, isEnabled: () => enabled, log: () => undefined });
	const keys = async (q: HistoryQuery = query()) => (await history.page(q)).entries.map((entry) => entry.message.id);

	setup(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), 'caerwyn-history-'));
		enabled = true;
		history = open();
	});

	teardown(async () => {
		history.dispose();
		await fs.rm(directory, { recursive: true, force: true });
	});

	test('pages a viewer’s messages across days, oldest first, newest page first', async () => {
		for (let i = 0; i < 25; i++) {
			history.record({ type: 'message', message: message(`m${i}`, { daysAgo: (25 - i) / 5 }) });
		}
		history.record({ type: 'message', message: message('other', { userId: 'u2' }) });

		const newest = await history.page(query({ limit: 10 }));
		assert.deepStrictEqual(newest.entries.map((entry) => entry.message.id), Array.from({ length: 10 }, (_, i) => `m${i + 15}`));
		assert.strictEqual(newest.more, true);
		assert.strictEqual(newest.total, 25, 'another viewer’s messages are not counted');

		const older = await history.page(query({ limit: 10, before: 'twitch:m15' }));
		assert.deepStrictEqual(older.entries.map((entry) => entry.message.id), Array.from({ length: 10 }, (_, i) => `m${i + 5}`));
		const oldest = await history.page(query({ limit: 10, before: 'twitch:m5' }));
		assert.deepStrictEqual(oldest.entries.map((entry) => entry.message.id), ['m0', 'm1', 'm2', 'm3', 'm4']);
		assert.strictEqual(oldest.more, false);
	});

	test('survives a restart, and keeps each message once when two windows saved it', async () => {
		history.record({ type: 'message', message: message('a', { daysAgo: 2 }) });
		history.record({ type: 'message', message: message('b', { daysAgo: 1 }) });
		history.dispose();
		const second = open();
		second.record({ type: 'message', message: message('b', { daysAgo: 1 }) });
		second.dispose();

		history = open();
		assert.deepStrictEqual(await keys(), ['a', 'b']);
	});

	test('an update replaces the saved message', async () => {
		history.record({ type: 'message', message: message('a') });
		history.record({ type: 'update', message: message('a', { headline: 'Cheered', spent: [{ currency: 'bits', amount: 100 }] }) });
		const [entry] = (await history.page(query())).entries;
		assert.strictEqual(entry.message.headline, 'Cheered');
	});

	test('removed messages come back without their text', async () => {
		for (const id of ['a', 'b', 'c']) {
			history.record({ type: 'message', message: message(id) });
		}
		history.record({ type: 'message', message: message('x', { userId: 'u2' }) });
		history.record({ type: 'message', message: message('y', { userId: 'u3' }) });
		history.record({ type: 'delete', key: 'twitch:a' });
		history.record({ type: 'purge', platform: 'twitch', channelId: 'c1', userId: 'u2' });
		history.record({ type: 'clear', platform: 'twitch', channelId: 'other-channel' });

		const page = await history.page(query());
		assert.deepStrictEqual(page.entries.map((entry) => [entry.message.id, entry.deleted]), [['a', true], ['b', false], ['c', false]]);
		assert.deepStrictEqual(page.entries[0].message.fragments, []);
		assert.strictEqual((await history.page(query({ userId: 'u2' }))).entries[0].deleted, true);
		assert.strictEqual((await history.page(query({ userId: 'u3' }))).entries[0].deleted, false, 'a clear elsewhere leaves this room alone');

		history.record({ type: 'clear', platform: 'twitch', channelId: 'c1' });
		assert.ok((await history.page(query({ userId: 'u3' }))).entries.every((entry) => entry.deleted));
	});

	test('a removed message’s text never reaches the disk again after compaction', async () => {
		history.record({ type: 'message', message: message('secret') });
		history.record({ type: 'delete', key: 'twitch:secret' });
		// Enough lines to make the next read rewrite the file.
		for (let i = 0; i < 6100; i++) {
			history.record({ type: 'message', message: message(`m${i}`, { daysAgo: 1 }) });
		}
		const page = await history.page(query({ limit: 1 }));
		assert.strictEqual(page.total, 5000, 'only the newest messages are kept');
		const files = await fs.readdir(directory);
		const text = await fs.readFile(path.join(directory, files[0]), 'utf8');
		assert.ok(!text.includes('said secret'));
	});

	test('keeps YouTube history together across broadcasts, and Twitch history per channel', async () => {
		history.record({ type: 'message', message: message('y1', { platform: 'youtube', channelId: 'live-chat-1', daysAgo: 7 }) });
		history.record({ type: 'message', message: message('y2', { platform: 'youtube', channelId: 'live-chat-2' }) });
		history.record({ type: 'message', message: message('t1', { channelId: 'c1' }) });
		history.record({ type: 'message', message: message('t2', { channelId: 'c2' }) });

		assert.deepStrictEqual(await keys(query({ platform: 'youtube', sourceId: 'youtube:me', channelId: 'live-chat-2' })), ['y1', 'y2']);
		assert.deepStrictEqual(await keys(query({ channelId: 'c1' })), ['t1']);
	});

	test('saves nothing held by AutoMod, and nothing while switched off', async () => {
		history.record({
			type: 'message',
			message: message('held', { fragments: [], held: { messageId: 'held', state: 'held', fragments: [{ type: 'text', text: 'caught' }] } }),
		});
		enabled = false;
		history.record({ type: 'message', message: message('off') });
		enabled = true;
		assert.deepStrictEqual(await keys(), []);
	});

	test('removals are recorded even while saving is off', async () => {
		history.record({ type: 'message', message: message('a') });
		enabled = false;
		history.record({ type: 'delete', key: 'twitch:a' });
		assert.strictEqual((await history.page(query())).entries[0].deleted, true);
	});

	test('clear deletes everything saved', async () => {
		history.record({ type: 'message', message: message('a') });
		await history.flush();
		await history.clear();
		assert.deepStrictEqual(await keys(), []);
		history.record({ type: 'message', message: message('b') });
		assert.deepStrictEqual(await keys(), ['b'], 'saving works again afterwards');
	});

	test('accepts only well-formed requests from the view', () => {
		assert.ok(parseHistoryQuery(query()));
		assert.strictEqual(parseHistoryQuery(query({ limit: 1e9 }))?.limit, 1000);
		assert.strictEqual(parseHistoryQuery({ ...query(), platform: 'kick' }), undefined);
		assert.strictEqual(parseHistoryQuery({ ...query(), userId: '' }), undefined);
		assert.strictEqual(parseHistoryQuery({ ...query(), before: 42 }), undefined);
		assert.strictEqual(parseHistoryQuery(null), undefined);
	});

	test('the chat service saves real chat but never simulated chat', async () => {
		const state: StateStore = { get: () => undefined, update: async () => undefined };
		const signedOut: PlatformAuth = {
			getAccount: async () => undefined,
			ensureValid: async () => {
				throw new NotSignedInError();
			},
			fetch: async () => {
				throw new NotSignedInError();
			},
			onDidChange: () => ({ dispose: () => undefined }),
		};
		const service = new ChatService({
			state,
			twitchAuth: signedOut,
			youtubeAuth: signedOut,
			history,
			getConfig: () => ({ maxMessages: 10, youtubeTransport: 'stream', simulation: { enabled: false, messagesPerSecond: 0 } }),
			log: () => undefined,
		});
		try {
			const sink = service['sink'];
			const simulated = SIMULATED_SOURCES[0];
			sink.event({ type: 'message', message: message('real') });
			sink.event({ type: 'message', message: message('fake', { sourceId: simulated.id }) });
			assert.deepStrictEqual(await keys(), ['real']);
			assert.deepStrictEqual((await service.history(query({ sourceId: simulated.id }))).entries, []);
		} finally {
			service.dispose();
		}
	});
});
