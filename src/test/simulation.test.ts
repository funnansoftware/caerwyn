import * as assert from 'assert';
import { TWITCH_EMOTES } from '../chat/simulation/sampleData';
import { SIMULATED_ACTIONS, SIMULATED_EVENTS, SimulatedChat, isSimulatedEventKind } from '../chat/simulation/simulatedChat';
import { ChatEvent, ChatMessage } from '../chat/types';
import { RecordingSink, delay } from './helpers';

function simulator(seed = 1, rate = 0) {
	const sink = new RecordingSink();
	const chat = new SimulatedChat({ sink, getRate: () => rate, seed, now: () => 1_800_000_000_000 });
	return { sink, chat };
}

const messages = (events: ChatEvent[]) => events.flatMap((event) => (event.type === 'message' ? [event.message] : []));
/** Everything about a message except its ID, which is unique per run by design. */
const content = (message: ChatMessage) => ({ ...message, key: '', id: '' });

suite('SimulatedChat', () => {
	test('the showcase produces every kind of event, through the real mappers', () => {
		const { sink, chat } = simulator();
		chat.emit('showcase');
		const all = messages(sink.events);

		// Every showcase entry yields exactly one event, except removals, which may first create their target.
		assert.ok(sink.events.length >= SIMULATED_EVENTS.length);
		for (const platform of ['twitch', 'youtube'] as const) {
			assert.ok(all.some((m) => m.platform === platform && !m.headline), `${platform} chat`);
			assert.ok(all.some((m) => m.platform === platform && m.headline), `${platform} notices`);
			assert.ok(sink.events.some((e) => e.type === 'delete' && e.key.startsWith(`${platform}:`)), `${platform} delete`);
			assert.ok(sink.events.some((e) => e.type === 'purge' && e.platform === platform), `${platform} purge`);
		}
		// The showcase only removes its own throwaway messages, so every other example stays visible.
		const throwaway = all.filter((m) => m.author.id === 'sim-t99' || m.author.id === 'sim-y99');
		assert.strictEqual(throwaway.length, 4);
		const removedKeys = sink.events.flatMap((e) => (e.type === 'delete' ? [e.key] : []));
		const purgedUsers = sink.events.flatMap((e) => (e.type === 'purge' ? [e.userId] : []));
		assert.ok(removedKeys.every((key) => throwaway.some((m) => m.key === key)));
		assert.deepStrictEqual(purgedUsers.sort(), ['sim-t99', 'sim-y99']);

		assert.ok(all.some((m) => m.action), 'an action message');
		assert.ok(all.some((m) => m.replyTo), 'a reply');
		assert.ok(all.some((m) => m.fragments.some((f) => f.type === 'mention')), 'a mention');
		assert.ok(all.some((m) => m.author.roles.includes('broadcaster') && m.platform === 'twitch'));
		assert.ok(all.some((m) => m.author.roles.includes('broadcaster') && m.platform === 'youtube'));
		assert.ok(all.some((m) => m.author.name === 'Anonymous'), 'an anonymous gifter');
		for (const headline of ['Cheered', 'subscribed at Tier 1', 'gifted a Tier 1 sub', 'raiders from', 'Announcement', 'Super Chat', 'Super Sticker', 'Member for']) {
			assert.ok(all.some((m) => m.headline?.includes(headline)), `a "${headline}" notice`);
		}
	});

	test('messages have unique keys, belong to the simulated sources, and only use known emote images', () => {
		const { sink, chat } = simulator();
		chat.emit('showcase');
		chat.emit('burst');
		chat.emit('twitchEmotes');
		const all = messages(sink.events);
		assert.strictEqual(new Set(all.map((m) => m.key)).size, all.length);
		const knownIds = new Set(Object.values(TWITCH_EMOTES));
		let emotes = 0;
		for (const message of all) {
			assert.strictEqual(message.sourceId, `${message.platform}:simulated`);
			assert.strictEqual(message.timestamp, 1_800_000_000_000);
			for (const fragment of message.fragments) {
				if (fragment.type === 'emote') {
					emotes++;
					const match = /^https:\/\/static-cdn\.jtvnw\.net\/emoticons\/v2\/(\d+)\/static\/dark\/2\.0$/.exec(fragment.url);
					assert.ok(match && knownIds.has(match[1]), fragment.url);
				}
			}
		}
		assert.ok(emotes > 0);
	});

	test('removals target messages that were actually sent, and never the same one twice', () => {
		const { sink, chat } = simulator(7);
		chat.emit('burst');
		for (let i = 0; i < 10; i++) {
			chat.emit('twitchDelete');
			chat.emit('youtubeDelete');
		}
		const keys = new Set(messages(sink.events).map((m) => m.key));
		const deleted = sink.events.flatMap((event) => (event.type === 'delete' ? [event.key] : []));
		assert.strictEqual(deleted.length, 20);
		assert.strictEqual(new Set(deleted).size, 20);
		for (const key of deleted) {
			assert.ok(keys.has(key), key);
		}

		chat.emit('twitchTimeout');
		const purge = sink.events[sink.events.length - 1];
		assert.ok(purge.type === 'purge');
		assert.ok(messages(sink.events).some((m) => m.platform === 'twitch' && m.author.id === purge.userId));
	});

	test('removing from an empty chat creates the message first', () => {
		const { sink, chat } = simulator();
		chat.emit('youtubeDelete');
		assert.deepStrictEqual(sink.events.map((event) => event.type), ['message', 'delete']);
	});

	test('the same seed gives the same chat', () => {
		const first = simulator(42);
		const second = simulator(42);
		const other = simulator(43);
		for (const { chat } of [first, second, other]) {
			chat.emit('burst');
			chat.emit('showcase');
		}
		assert.deepStrictEqual(messages(first.sink.events).map(content), messages(second.sink.events).map(content));
		assert.notDeepStrictEqual(messages(first.sink.events).map(content), messages(other.sink.events).map(content));
	});

	test('clearing and dropping the connection report through the usual channels', async () => {
		const { sink, chat } = simulator();
		chat.start();
		assert.strictEqual(sink.state('twitch:simulated'), 'connected');
		assert.strictEqual(sink.labels.get('youtube:simulated'), 'Simulated YouTube');

		chat.emit('twitchClear');
		assert.deepStrictEqual(sink.events, [{ type: 'clear', platform: 'twitch', channelId: 'simulated-twitch' }]);

		chat.emit('connectionDrop');
		assert.strictEqual(sink.state('twitch:simulated'), 'connecting');
		assert.strictEqual(sink.state('youtube:simulated'), 'connecting');
		chat.dispose();
	});

	test('produces chat on its own at the given rate, and nothing after it is disposed', async () => {
		const { sink, chat } = simulator(3, 50);
		chat.start();
		await delay(400);
		chat.dispose();
		const count = sink.events.length;
		assert.ok(count >= 5, `expected a steady stream, got ${count} events`);
		await delay(200);
		chat.emit('twitchMessage');
		assert.strictEqual(sink.events.length, count);
	});

	test('reports an audience for each stream once started, and raiders join it', () => {
		const { sink, chat } = simulator();
		chat.emit('twitchRaid');
		assert.strictEqual(sink.viewerReports.size, 0, 'no audience before the simulation starts');

		chat.start();
		const before = sink.viewerCount('twitch:simulated') ?? 0;
		assert.ok(before > 0 && (sink.viewerCount('youtube:simulated') ?? 0) > 0);
		sink.events.length = 0;
		chat.emit('twitchRaid');
		const raid = messages(sink.events)[0];
		const raiders = Number(/^(\d+) raiders/.exec(raid.headline ?? '')?.[1]);
		assert.strictEqual(sink.viewerCount('twitch:simulated'), before + raiders);
		chat.dispose();
	});

	test('recognises requestable event names', () => {
		for (const entry of [...SIMULATED_EVENTS, ...SIMULATED_ACTIONS]) {
			assert.ok(isSimulatedEventKind(entry.kind));
		}
		assert.strictEqual(isSimulatedEventKind('nonsense'), false);
		assert.strictEqual(isSimulatedEventKind(undefined), false);
	});
});
