import * as assert from 'assert';
import { ChatService, PlatformAuth, StateStore } from '../chat/chatService';
import { ChatEvent, ChatMessage, ChatSink, NotSignedInError, TWITCH_SELF, ViewerCounts, YOUTUBE_SELF } from '../chat/types';
import { delay, waitFor } from './helpers';

class MemoryState implements StateStore {
	readonly values = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}
	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

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

function message(id: string, userId = 'u1', channelId = 'c1'): ChatMessage {
	return {
		key: `twitch:${id}`,
		platform: 'twitch',
		id,
		sourceId: 'twitch:me',
		channelId,
		channelName: 'me',
		author: { id: userId, name: userId, roles: [] },
		fragments: [{ type: 'text', text: id }],
		timestamp: 0,
	};
}

suite('ChatService', () => {
	let service: ChatService;
	let state: MemoryState;
	let maxMessages: number;
	let simulation: { enabled: boolean; messagesPerSecond: number };

	setup(() => {
		state = new MemoryState();
		maxMessages = 3;
		simulation = { enabled: false, messagesPerSecond: 0 };
		service = new ChatService({
			state,
			twitchAuth: signedOut,
			youtubeAuth: signedOut,
			getConfig: () => ({ maxMessages, youtubeTransport: 'stream', simulation }),
			log: () => undefined,
		});
	});

	teardown(() => service.dispose());

	/** Feeds an event in as a connection would. */
	const emit = (event: ChatEvent) => (service as unknown as { sink: ChatSink }).sink.event(event);
	const ids = () => service.messages.map((m) => m.id);

	test('persists sources, ignores duplicates and reports sign-in state once started', async () => {
		assert.strictEqual(await service.addSource(TWITCH_SELF), true);
		assert.strictEqual(await service.addSource(TWITCH_SELF), false);
		await service.addSource(YOUTUBE_SELF);
		assert.deepStrictEqual(state.get('caerwyn.sources'), [TWITCH_SELF, YOUTUBE_SELF]);
		assert.deepStrictEqual(service.sources.map((info) => info.status.state), ['idle', 'idle']);

		service.start();
		await waitFor(() => service.sources.every((info) => info.status.state === 'needsSignIn'), 'both sources to ask for sign-in');

		await service.removeSource(TWITCH_SELF.id);
		assert.deepStrictEqual(state.get('caerwyn.sources'), [YOUTUBE_SELF]);
		service.stop();
		assert.deepStrictEqual(service.sources.map((info) => info.status.state), ['idle']);
	});

	test('keeps a capped, de-duplicated history and batches events to listeners', async () => {
		const batches: ChatEvent[][] = [];
		service.onEvents((events) => batches.push(events));
		for (const id of ['a', 'b', 'b', 'c', 'd']) {
			emit({ type: 'message', message: message(id) });
		}
		assert.deepStrictEqual(ids(), ['b', 'c', 'd']);
		await waitFor(() => batches.length > 0, 'a batch');
		assert.strictEqual(batches.length, 1);
		assert.strictEqual(batches[0].length, 4, 'the duplicate is not forwarded');
	});

	test('keeps viewer counts for known sources, reports changes together, and forgets a source’s count with it', async () => {
		await service.addSource(TWITCH_SELF);
		const sink = (service as unknown as { sink: ChatSink }).sink;
		const fired: ViewerCounts[] = [];
		service.onViewerCounts((counts) => fired.push(counts));

		sink.viewers('twitch:me', 10);
		sink.viewers('twitch:me', 12);
		sink.viewers('youtube:unknown', 5);
		await waitFor(() => fired.length > 0, 'the counts');
		await delay(100);
		assert.deepStrictEqual(fired, [{ 'twitch:me': 12 }], 'one update, without the unknown source');
		assert.deepStrictEqual(service.viewerCounts, { 'twitch:me': 12 });

		sink.viewers('twitch:me', 12);
		await delay(100);
		assert.strictEqual(fired.length, 1, 'an unchanged count is not reported again');

		await service.removeSource('twitch:me');
		await waitFor(() => fired.length === 2, 'the count to go with its source');
		assert.deepStrictEqual(fired[1], {});
	});

	test('simulated viewers appear with simulated chat and go when it is switched off or the last view closes', async () => {
		simulation.enabled = true;
		service.refreshConfig();
		const view = service.acquire();
		await waitFor(() => Object.keys(service.viewerCounts).length === 2, 'both simulated counts');
		assert.ok(Object.values(service.viewerCounts).every((count) => count > 0));

		simulation.enabled = false;
		service.refreshConfig();
		assert.deepStrictEqual(service.viewerCounts, {});

		simulation.enabled = true;
		service.refreshConfig();
		await waitFor(() => Object.keys(service.viewerCounts).length === 2, 'the counts to return');
		view.dispose();
		assert.deepStrictEqual(service.viewerCounts, {});
	});

	test('simulated chat appears as its own sources, feeds the history, and leaves nothing behind when switched off', async () => {
		maxMessages = 500;
		await service.addSource(TWITCH_SELF);
		service.start();
		assert.strictEqual(service.simulate('twitchMessage'), false, 'nothing is simulated while the setting is off');

		simulation.enabled = true;
		service.refreshConfig();
		assert.strictEqual(service.isSimulating, true);
		assert.deepStrictEqual(
			service.sources.map((info) => [info.source.id, info.label, info.status.state]).slice(1),
			[
				['twitch:simulated', 'Simulated Twitch', 'connected'],
				['youtube:simulated', 'Simulated YouTube', 'connected'],
			],
		);

		emit({ type: 'message', message: message('real') });
		assert.strictEqual(service.simulate('showcase'), true);
		const simulated = service.messages.filter((m) => m.sourceId.endsWith(':simulated'));
		assert.ok(simulated.some((m) => m.platform === 'twitch') && simulated.some((m) => m.platform === 'youtube'));

		// After Clear Chat, a requested removal must act on something visible, not on a message that is gone.
		service.clearMessages();
		const seen: ChatEvent[] = [];
		const listening = service.onEvents((events) => seen.push(...events));
		service.simulate('twitchDelete');
		await waitFor(() => seen.length >= 2, 'the message and its removal');
		listening.dispose();
		assert.ok(seen[0].type === 'message' && seen[1].type === 'delete' && seen[1].key === seen[0].message.key);
		emit({ type: 'message', message: message('real') });

		// With a rate of zero nothing arrives on its own.
		const count = service.messages.length;
		await delay(700);
		assert.strictEqual(service.messages.length, count);

		simulation.enabled = false;
		service.refreshConfig();
		assert.deepStrictEqual(ids(), ['real']);
		assert.deepStrictEqual(service.sources.map((info) => info.source.id), ['twitch:me']);
		assert.strictEqual(service.simulate('twitchMessage'), false);
	});

	test('moderation acts on simulated chat and is refused, without side effects, elsewhere', async () => {
		maxMessages = 500;
		await service.addSource(TWITCH_SELF);
		simulation.enabled = true;
		service.refreshConfig();
		service.start();
		assert.deepStrictEqual(
			service.sources.map((info) => [info.source.id, info.canModerate]),
			[
				['twitch:me', false],
				['twitch:simulated', true],
				['youtube:simulated', true],
			],
		);

		service.simulate('twitchMessage');
		const target = service.messages[service.messages.length - 1];
		const seen: ChatEvent[] = [];
		const listening = service.onEvents((events) => seen.push(...events));
		await service.moderate({ sourceId: target.sourceId, action: { type: 'delete', messageKey: target.key } });
		await waitFor(() => seen.some((e) => e.type === 'delete' && e.key === target.key), 'the removal to reach listeners');
		listening.dispose();
		assert.ok(!service.messages.some((m) => m.key === target.key), 'the message left the history');

		await assert.rejects(
			service.moderate({ sourceId: 'twitch:me', action: { type: 'ban', userId: 'u1' } }),
			(error: Error) => error.name === 'ModerationError' && /not available yet/.test(error.message),
		);
		await assert.rejects(
			service.moderate({ sourceId: 'twitch:gone', action: { type: 'ban', userId: 'u1' } }),
			/no longer connected/,
		);

		// A real message cannot be removed by naming the simulated source instead of its own.
		emit({ type: 'message', message: message('real') });
		await assert.rejects(
			service.moderate({ sourceId: 'twitch:simulated', action: { type: 'delete', messageKey: 'twitch:real' } }),
			/not in this chat/,
		);
		assert.ok(ids().includes('real'));
	});

	test('simulated chat arrives on its own at the configured rate and stops with the service', async () => {
		maxMessages = 500;
		simulation = { enabled: true, messagesPerSecond: 50 };
		service.refreshConfig();
		assert.deepStrictEqual(service.sources.map((info) => info.status.state), ['idle', 'idle'], 'not running until the tab opens');

		service.start();
		await waitFor(() => service.messages.length >= 5, 'simulated messages');
		service.stop();
		const count = service.messages.length;
		await delay(300);
		assert.strictEqual(service.messages.length, count);
	});

	test('stays connected until the last viewer is released', async () => {
		simulation = { enabled: true, messagesPerSecond: 0 };
		service.refreshConfig();
		const states = () => service.sources.map((info) => info.status.state);
		const first = service.acquire();
		const second = service.acquire();
		await waitFor(() => states().includes('connected'), 'simulated sources to connect');

		first.dispose();
		first.dispose(); // Releasing twice must not release the other viewer.
		assert.ok(states().includes('connected'), 'still running for the second viewer');

		second.dispose();
		assert.ok(!states().includes('connected'), 'disconnected once nobody is viewing');

		service.acquire().dispose();
		assert.ok(!states().includes('connected'));
	});

	test('drops removed messages from history so they cannot be shown again', () => {
		maxMessages = 10;
		emit({ type: 'message', message: message('a', 'u1') });
		emit({ type: 'message', message: message('b', 'u2') });
		emit({ type: 'message', message: message('c', 'u1') });
		emit({ type: 'message', message: message('d', 'u3', 'c2') });

		emit({ type: 'delete', key: 'twitch:b' });
		assert.deepStrictEqual(ids(), ['a', 'c', 'd']);
		emit({ type: 'purge', platform: 'twitch', channelId: 'c1', userId: 'u1' });
		assert.deepStrictEqual(ids(), ['d']);
		emit({ type: 'message', message: message('e') });
		emit({ type: 'clear', platform: 'twitch', channelId: 'c1' });
		assert.deepStrictEqual(ids(), ['d']);

		let resets = 0;
		service.onReset(() => resets++);
		service.clearMessages();
		assert.deepStrictEqual(ids(), []);
		assert.strictEqual(resets, 1);
	});
});
