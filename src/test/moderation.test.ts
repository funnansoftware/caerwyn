import * as assert from 'assert';
import { MAX_TIMEOUT_SECONDS, formatDuration, parseModerationRequest } from '../chat/moderation';
import { TWITCH_BROADCASTER, TWITCH_CHATTERS, YOUTUBE_CHATTERS } from '../chat/simulation/sampleData';
import { SimulatedChat } from '../chat/simulation/simulatedChat';
import { ChatEvent, ChatMessage } from '../chat/types';
import { RecordingSink } from './helpers';

const messages = (events: ChatEvent[]) => events.flatMap((event) => (event.type === 'message' ? [event.message] : []));

suite('Moderation requests', () => {
	test('accepts well-formed requests', () => {
		for (const request of [
			{ sourceId: 'twitch:simulated', action: { type: 'delete', messageKey: 'twitch:abc' } },
			{ sourceId: 'twitch:simulated', action: { type: 'ban', userId: 'u1' } },
			{ sourceId: 'youtube:simulated', action: { type: 'timeout', userId: 'u1', durationSeconds: 600 } },
			{ sourceId: 'twitch:me', action: { type: 'automod', messageKey: 'twitch:automod-abc', allow: true } },
			{ sourceId: 'twitch:me', action: { type: 'automod', messageKey: 'twitch:automod-abc', allow: false } },
		]) {
			assert.deepStrictEqual(parseModerationRequest(request), request);
		}
	});

	test('drops anything it does not expect', () => {
		const extra = parseModerationRequest({ sourceId: 's', action: { type: 'ban', userId: 'u', durationSeconds: 5, note: 'x' }, more: 1 });
		assert.deepStrictEqual(extra, { sourceId: 's', action: { type: 'ban', userId: 'u' } });
	});

	test('rejects an AutoMod decision that is not a plain yes or no', () => {
		assert.strictEqual(parseModerationRequest({ sourceId: 's', action: { type: 'automod', messageKey: 'k', allow: 'yes' } }), undefined);
		assert.strictEqual(parseModerationRequest({ sourceId: 's', action: { type: 'automod', messageKey: 'k' } }), undefined);
		assert.strictEqual(parseModerationRequest({ sourceId: 's', action: { type: 'automod', allow: true } }), undefined);
	});

	test('rejects malformed requests', () => {
		for (const value of [
			undefined,
			null,
			'ban',
			{},
			{ sourceId: '', action: { type: 'ban', userId: 'u' } },
			{ sourceId: 's' },
			{ sourceId: 's', action: null },
			{ sourceId: 's', action: { type: 'unknown', userId: 'u' } },
			{ sourceId: 's', action: { type: 'ban' } },
			{ sourceId: 's', action: { type: 'ban', userId: 42 } },
			{ sourceId: 's', action: { type: 'delete', messageKey: '' } },
			{ sourceId: 's', action: { type: 'delete', messageKey: 'x'.repeat(300) } },
			{ sourceId: 's', action: { type: 'timeout', userId: 'u' } },
			{ sourceId: 's', action: { type: 'timeout', userId: 'u', durationSeconds: 0 } },
			{ sourceId: 's', action: { type: 'timeout', userId: 'u', durationSeconds: 1.5 } },
			{ sourceId: 's', action: { type: 'timeout', userId: 'u', durationSeconds: '60' } },
			{ sourceId: 's', action: { type: 'timeout', userId: 'u', durationSeconds: MAX_TIMEOUT_SECONDS + 1 } },
		]) {
			assert.strictEqual(parseModerationRequest(value), undefined, JSON.stringify(value));
		}
	});

	test('describes durations in words', () => {
		assert.strictEqual(formatDuration(1), '1 second');
		assert.strictEqual(formatDuration(60), '1 minute');
		assert.strictEqual(formatDuration(600), '10 minutes');
		assert.strictEqual(formatDuration(3600), '1 hour');
		assert.strictEqual(formatDuration(86400), '1 day');
		assert.strictEqual(formatDuration(90), '90 seconds');
	});
});

suite('Simulated moderation', () => {
	let now: number;
	let sink: RecordingSink;
	let chat: SimulatedChat;

	setup(() => {
		now = 1_800_000_000_000;
		sink = new RecordingSink();
		chat = new SimulatedChat({ sink, getRate: () => 0, seed: 5, now: () => now });
	});

	teardown(() => chat.dispose());

	const last = () => sink.events[sink.events.length - 1];
	const firstFrom = (platform: 'twitch' | 'youtube'): ChatMessage => {
		const found = messages(sink.events).find((m) => m.platform === platform && !m.author.roles.includes('broadcaster'));
		assert.ok(found, `a ${platform} message`);
		return found;
	};

	test('deleting a message reports its removal, and later simulated removals never pick it', () => {
		chat.emit('twitchMessage');
		chat.emit('youtubeMessage');
		const twitch = firstFrom('twitch');
		const youtube = firstFrom('youtube');

		chat.moderate('twitch', { type: 'delete', messageKey: twitch.key });
		assert.deepStrictEqual(last(), { type: 'delete', key: twitch.key });
		// YouTube's removal goes through the YouTube mapper, like the real thing.
		chat.moderate('youtube', { type: 'delete', messageKey: youtube.key });
		assert.deepStrictEqual(last(), { type: 'delete', key: youtube.key });

		chat.emit('twitchDelete');
		const removal = last();
		assert.ok(removal.type === 'delete');
		assert.notStrictEqual(removal.key, twitch.key);
	});

	test('a message from another platform is refused', () => {
		assert.throws(() => chat.moderate('youtube', { type: 'delete', messageKey: 'twitch:abc' }), /not in this chat/);
	});

	test('a banned user is purged and stops chatting', () => {
		const target = TWITCH_CHATTERS[0];
		chat.moderate('twitch', { type: 'ban', userId: target.id });
		assert.deepStrictEqual(last(), { type: 'purge', platform: 'twitch', channelId: 'simulated-twitch', userId: target.id });

		chat.emit('burst');
		chat.emit('burst');
		assert.ok(!messages(sink.events).some((m) => m.author.id === target.id), 'the banned user said nothing');
	});

	test('a timed-out user chats again once the timeout ends', () => {
		const target = YOUTUBE_CHATTERS[0];
		chat.moderate('youtube', { type: 'timeout', userId: target.channelId, durationSeconds: 60 });
		assert.deepStrictEqual(last(), { type: 'purge', platform: 'youtube', channelId: 'simulated-youtube', userId: target.channelId });

		for (let i = 0; i < 200; i++) {
			chat.emit('youtubeMessage');
		}
		const before = messages(sink.events).length;
		assert.ok(!messages(sink.events).some((m) => m.author.id === target.channelId), 'silent during the timeout');

		now += 61_000;
		for (let i = 0; i < 200; i++) {
			chat.emit('youtubeMessage');
		}
		assert.ok(
			messages(sink.events)
				.slice(before)
				.some((m) => m.author.id === target.channelId),
			'back after the timeout',
		);
	});

	test('the broadcaster cannot be banned or timed out', () => {
		assert.throws(() => chat.moderate('twitch', { type: 'ban', userId: TWITCH_BROADCASTER.id }), /broadcaster/);
		assert.throws(() => chat.moderate('twitch', { type: 'timeout', userId: TWITCH_BROADCASTER.id, durationSeconds: 60 }), /broadcaster/);
		assert.strictEqual(sink.events.length, 0);
	});
});
