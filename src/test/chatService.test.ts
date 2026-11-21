import * as assert from 'assert';
import { ChatService, PlatformAuth, StateStore } from '../chat/chatService';
import { ChatEvent, ChatMessage, ChatSink, NotSignedInError, TWITCH_SELF, YOUTUBE_SELF } from '../chat/types';
import { waitFor } from './helpers';

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

	setup(() => {
		state = new MemoryState();
		maxMessages = 3;
		service = new ChatService({
			state,
			twitchAuth: signedOut,
			youtubeAuth: signedOut,
			getConfig: () => ({ maxMessages, youtubeTransport: 'stream' }),
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
