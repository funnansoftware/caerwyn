import * as assert from 'assert';
import { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { TwitchChat } from '../chat/twitch/twitchChat';
import { mapChatMessage, mapNotification } from '../chat/twitch/twitchMapper';
import { SpendMatcher, mapAutomaticRedemption, mapBitsUse } from '../chat/twitch/twitchSpend';
import { mapAutomodHold, mapAutomodUpdate } from '../chat/twitch/twitchAutomod';
import { ModerationError } from '../chat/moderation';
import { NotSignedInError, TWITCH_SELF, twitchChannelSource } from '../chat/types';
import { FakeAuth, RecordingSink, delay, json, waitFor } from './helpers';

const chatEvent = {
	broadcaster_user_id: '100',
	broadcaster_user_login: 'me',
	broadcaster_user_name: 'Me',
	chatter_user_id: '7',
	chatter_user_login: 'viewer',
	chatter_user_name: 'Viewer',
	message_id: 'abc',
	color: '#1E90FF',
	badges: [{ set_id: 'moderator' }, { set_id: 'subscriber' }, { set_id: 'unknown-badge' }],
	message: {
		text: 'hi Kappa @me',
		fragments: [
			{ type: 'text', text: 'hi ' },
			{ type: 'emote', text: 'Kappa', emote: { id: '25', format: ['static'] } },
			{ type: 'text', text: ' ' },
			{ type: 'mention', text: '@me' },
		],
	},
};

suite('Twitch mapping', () => {
	test('maps a chat message with emotes, mentions, colour and roles', () => {
		const message = mapChatMessage(chatEvent, 'twitch:me', 1234);
		assert.strictEqual(message.key, 'twitch:abc');
		assert.strictEqual(message.channelId, '100');
		assert.strictEqual(message.channelName, 'Me');
		assert.strictEqual(message.timestamp, 1234);
		assert.deepStrictEqual(message.author, { id: '7', login: 'viewer', name: 'Viewer', color: '#1E90FF', roles: ['moderator', 'subscriber'] });
		assert.deepStrictEqual(message.fragments, [
			{ type: 'text', text: 'hi ' },
			{ type: 'emote', text: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/2.0' },
			{ type: 'text', text: ' ' },
			{ type: 'mention', text: '@me' },
		]);
		assert.strictEqual(message.headline, undefined);
	});

	test('never builds an image URL from an unexpected emote ID', () => {
		const message = mapChatMessage(
			{ ...chatEvent, message: { text: 'x', fragments: [{ type: 'emote', text: 'x', emote: { id: '../../evil?x=1' } }] } },
			'twitch:me',
			0,
		);
		assert.deepStrictEqual(message.fragments, [{ type: 'text', text: 'x' }]);
	});

	test('marks /me messages, cheers and replies', () => {
		const message = mapChatMessage(
			{
				...chatEvent,
				color: '',
				cheer: { bits: 100 },
				reply: { parent_user_name: 'Other', parent_message_body: 'question?' },
				message: { text: '\u0001ACTION waves\u0001', fragments: [{ type: 'text', text: '\u0001ACTION waves\u0001' }] },
			},
			'twitch:me',
			0,
		);
		assert.strictEqual(message.action, true);
		assert.deepStrictEqual(message.fragments, [{ type: 'text', text: 'waves' }]);
		assert.strictEqual(message.headline, 'Cheered');
		assert.deepStrictEqual(message.spent, [{ currency: 'bits', amount: 100 }]);
		assert.deepStrictEqual(message.replyTo, { name: 'Other', text: 'question?' });
		assert.strictEqual(message.author.color, undefined);
	});

	test('marks messages sent with channel points or Power-ups', () => {
		const highlighted = mapChatMessage({ ...chatEvent, message_type: 'channel_points_highlighted' }, 'twitch:me', 0);
		assert.strictEqual(highlighted.headline, 'Highlighted');
		assert.deepStrictEqual(highlighted.spent, [{ currency: 'points' }], 'paid with points, amount not yet known');
		assert.strictEqual(highlighted.highlighted, true);

		const effect = mapChatMessage({ ...chatEvent, message_type: 'power_ups_message_effect' }, 'twitch:me', 0);
		assert.strictEqual(effect.headline, 'Sent with a message effect');
		assert.strictEqual(effect.highlighted, undefined);
		assert.deepStrictEqual(effect.spent, [{ currency: 'bits' }], 'paid with Bits, amount not yet known');
		const paidEffect = mapChatMessage({ ...chatEvent, message_type: 'power_ups_message_effect' }, 'twitch:me', 0, { amount: 30, currency: 'bits' });
		assert.strictEqual(paidEffect.headline, 'Sent with a message effect');
		assert.deepStrictEqual(paidEffect.spent, [{ currency: 'bits', amount: 30 }]);

		const both = mapChatMessage({ ...chatEvent, message_type: 'channel_points_highlighted', cheer: { bits: 1 } }, 'twitch:me', 0);
		assert.strictEqual(both.headline, 'Cheered · Highlighted');
		assert.deepStrictEqual(both.spent, [{ currency: 'bits', amount: 1 }, { currency: 'points' }], 'each in the order of its label');

		for (const message_type of ['text', 'some_future_type']) {
			const plain = mapChatMessage({ ...chatEvent, message_type }, 'twitch:me', 0);
			assert.strictEqual(plain.headline, undefined, message_type);
			assert.strictEqual(plain.highlighted, undefined, message_type);
			assert.strictEqual(plain.spent, undefined, message_type);
		}
	});

	test('maps a notification to a headline, hiding anonymous gifters', () => {
		const message = mapNotification(
			{ ...chatEvent, chatter_is_anonymous: true, system_message: 'An anonymous user gifted a sub!', notice_type: 'sub_gift', message: { text: '', fragments: [] } },
			'twitch:me',
			0,
		);
		assert.strictEqual(message.headline, 'An anonymous user gifted a sub!');
		assert.strictEqual(message.author.name, 'Anonymous');
		assert.strictEqual(message.author.id, '');
		assert.deepStrictEqual(message.fragments, []);
	});
});

const highlightedEvent = { ...chatEvent, message_type: 'channel_points_highlighted' };
const redemption = {
	broadcaster_user_id: '100',
	user_id: '7',
	user_login: 'viewer',
	user_name: 'Viewer',
	id: 'r1',
	reward: { type: 'send_highlighted_message', channel_points: 1500, emote: null },
	message: { text: 'hi Kappa @me' },
};

suite('Twitch spending', () => {
	test('maps redemptions and Bits to message costs or rows of their own', () => {
		assert.deepStrictEqual(mapAutomaticRedemption(redemption, 'twitch:me', 5, 'n1'), {
			kind: 'cost',
			cost: {
				broadcasterId: '100',
				userId: '7',
				messageType: 'channel_points_highlighted',
				text: 'hi Kappa @me',
				spent: { amount: 1500, currency: 'points' },
			},
		});

		const unlock = mapAutomaticRedemption(
			{ ...redemption, reward: { type: 'chosen_sub_emote_unlock', channel_points: 4000, emote: { id: '25', name: 'Kappa' } } },
			'twitch:me',
			5,
			'n1',
		);
		assert.ok(unlock?.kind === 'message');
		assert.strictEqual(unlock.message.key, 'twitch:redemption-r1');
		assert.strictEqual(unlock.message.headline, 'Unlocked a sub emote');
		assert.deepStrictEqual(unlock.message.spent, [{ currency: 'points', amount: 4000 }]);
		assert.deepStrictEqual(unlock.message.fragments, [
			{ type: 'emote', text: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/2.0' },
		]);

		const bits = { broadcaster_user_id: '100', user_id: '7', user_name: 'Viewer', bits: 50, message: { text: 'held by AutoMod' } };
		const effect = mapBitsUse({ ...bits, type: 'power_up', power_up: { type: 'message_effect' } }, 'twitch:me', 5, 'n2');
		assert.ok(effect?.kind === 'cost');
		assert.strictEqual(effect.cost.messageType, 'power_ups_message_effect');
		assert.deepStrictEqual(effect.cost.spent, { amount: 50, currency: 'bits' });

		const celebration = mapBitsUse({ ...bits, type: 'power_up', power_up: { type: 'celebration' } }, 'twitch:me', 5, 'n3');
		assert.ok(celebration?.kind === 'message');
		assert.strictEqual(celebration.message.key, 'twitch:bits-n3');
		assert.strictEqual(celebration.message.headline, 'Sent an on-screen celebration');
		assert.deepStrictEqual(celebration.message.spent, [{ currency: 'bits', amount: 50 }]);
		assert.deepStrictEqual(celebration.message.fragments, [], 'the event\'s text is never shown: AutoMod may be holding it');

		const custom = mapBitsUse({ ...bits, type: 'custom_power_up', custom_power_up: { title: 'Hydrate!' } }, 'twitch:me', 5, 'n4');
		assert.ok(custom?.kind === 'message');
		assert.strictEqual(custom.message.headline, 'Used Hydrate!');
		assert.deepStrictEqual(custom.message.spent, [{ currency: 'bits', amount: 50 }]);

		assert.strictEqual(mapBitsUse({ ...bits, type: 'cheer' }, 'twitch:me', 5, 'n5'), undefined, 'a cheer\'s message already shows its Bits');
		assert.strictEqual(mapBitsUse({ ...bits, bits: 0, type: 'power_up', power_up: { type: 'celebration' } }, 'twitch:me', 5, 'n6'), undefined);
		assert.strictEqual(mapAutomaticRedemption({ ...redemption, reward: { type: 'constructor', channel_points: 1 } }, 'twitch:me', 5, 'n7'), undefined);
	});

	test('shows a paid message at once and updates it when its cost follows', () => {
		const matcher = new SpendMatcher();
		const shown = matcher.message(highlightedEvent, 'twitch:me', 5);
		assert.strictEqual(shown.headline, 'Highlighted');
		assert.deepStrictEqual(shown.spent, [{ currency: 'points' }]);

		const cost = mapAutomaticRedemption(redemption, 'twitch:me', 9, 'n1');
		assert.ok(cost?.kind === 'cost');
		const updated = matcher.cost(cost.cost);
		assert.strictEqual(updated?.key, 'twitch:abc');
		assert.strictEqual(updated?.timestamp, 5);
		assert.strictEqual(updated?.headline, 'Highlighted');
		assert.deepStrictEqual(updated?.spent, [{ currency: 'points', amount: 1500 }]);
		assert.strictEqual(updated?.highlighted, true);
		assert.strictEqual(matcher.cost(cost.cost), undefined, 'a message is paid for once');
	});

	test('holds a cost that arrives first, as when AutoMod holds the message, until the message arrives', () => {
		let now = 0;
		const matcher = new SpendMatcher(() => now);
		const cost = mapAutomaticRedemption(redemption, 'twitch:me', 0, 'n1');
		assert.ok(cost?.kind === 'cost');
		assert.strictEqual(matcher.cost(cost.cost), undefined);

		now = 3 * 60_000; // A moderator allows the message a few minutes later.
		assert.deepStrictEqual(matcher.message(highlightedEvent, 'twitch:me', now).spent, [{ currency: 'points', amount: 1500 }]);
		assert.deepStrictEqual(matcher.message({ ...highlightedEvent, message_id: 'again' }, 'twitch:me', now).spent, [{ currency: 'points' }]);

		matcher.cost(cost.cost);
		now += 60 * 60_000; // Never allowed: the cost is forgotten.
		assert.deepStrictEqual(matcher.message({ ...highlightedEvent, message_id: 'late' }, 'twitch:me', now).spent, [{ currency: 'points' }]);
	});

	test('pairs by viewer, kind and text, never across viewers', () => {
		const matcher = new SpendMatcher();
		matcher.message({ ...highlightedEvent, message_id: 'first', message: { text: 'first one' } }, 'twitch:me', 1);
		matcher.message({ ...highlightedEvent, message_id: 'second', message: { text: 'second one' } }, 'twitch:me', 2);
		matcher.message({ ...highlightedEvent, message_id: 'stranger', chatter_user_id: '8' }, 'twitch:me', 3);
		const cost = { broadcasterId: '100', userId: '7', messageType: 'channel_points_highlighted' as const, spent: { amount: 1, currency: 'points' as const } };

		assert.strictEqual(matcher.cost({ ...cost, text: 'second one' })?.key, 'twitch:second', 'matching text wins');
		assert.strictEqual(matcher.cost({ ...cost, text: 'reworded' })?.key, 'twitch:first', 'otherwise the oldest from that viewer');
		assert.strictEqual(matcher.cost({ ...cost, text: '' }), undefined, 'another viewer\'s message is never paired');
		assert.strictEqual(matcher.cost({ ...cost, messageType: 'channel_points_sub_only', text: '' }), undefined);
	});
});

const holdEvent = {
	broadcaster_user_id: '100',
	broadcaster_user_name: 'Me',
	user_id: '7',
	user_login: 'viewer',
	user_name: 'Viewer',
	message_id: 'held-1',
	message: { text: 'rude Kappa', fragments: [{ type: 'text', text: 'rude ' }, { type: 'emote', text: 'Kappa', emote: { id: '25' } }] },
	reason: 'automod',
	automod: { category: 'bullying', level: 3, boundaries: [] },
	blocked_term: null,
	held_at: '2026-11-21T17:11:28.000Z',
};

suite('Twitch AutoMod', () => {
	test('maps a hold with its text kept apart, and its reason in the headline', () => {
		const held = mapAutomodHold(holdEvent, 'twitch:me', 5);
		assert.strictEqual(held?.key, 'twitch:automod-held-1', 'a key of its own, apart from the chat message it may become');
		assert.strictEqual(held?.headline, 'Held by AutoMod: bullying, level 3');
		assert.deepStrictEqual(held?.fragments, []);
		assert.deepStrictEqual(held?.held, {
			messageId: 'held-1',
			state: 'held',
			fragments: [
				{ type: 'text', text: 'rude ' },
				{ type: 'emote', text: 'Kappa', url: 'https://static-cdn.jtvnw.net/emoticons/v2/25/static/dark/2.0' },
			],
		});
		assert.strictEqual(held?.timestamp, Date.parse('2026-11-21T17:11:28.000Z'));
		assert.strictEqual(held?.author.name, 'Viewer');

		assert.strictEqual(mapAutomodHold({ ...holdEvent, reason: 'blocked_term', automod: null }, 'twitch:me', 5)?.headline, 'Held by AutoMod: blocked term');
		assert.strictEqual(mapAutomodHold({ ...holdEvent, reason: 'blocked_link', automod: null }, 'twitch:me', 5)?.headline, 'Held by AutoMod: link');
		assert.strictEqual(mapAutomodHold({ ...holdEvent, message_id: '' }, 'twitch:me', 5), undefined);
	});

	test('maps each outcome, whatever the case of its status', () => {
		const moderator = { moderator_user_login: 'mod', moderator_user_name: 'Mod' };
		const allowed = mapAutomodUpdate({ ...holdEvent, ...moderator, status: 'Approved' }, 'twitch:me', 5);
		assert.strictEqual(allowed?.key, 'twitch:automod-held-1');
		assert.strictEqual(allowed?.held?.state, 'allowed');
		assert.strictEqual(allowed?.headline, 'Held by AutoMod: bullying, level 3 · Allowed by Mod');
		assert.strictEqual(mapAutomodUpdate({ ...holdEvent, ...moderator, status: 'denied' }, 'twitch:me', 5)?.headline, 'Held by AutoMod: bullying, level 3 · Denied by Mod');
		assert.strictEqual(mapAutomodUpdate({ ...holdEvent, status: 'EXPIRED' }, 'twitch:me', 5)?.held?.state, 'expired');
		assert.strictEqual(mapAutomodUpdate({ ...holdEvent, status: 'constructor' }, 'twitch:me', 5), undefined);
		assert.strictEqual(mapAutomodUpdate({ ...holdEvent }, 'twitch:me', 5), undefined);
	});
});

/** A stand-in for Twitch's EventSub WebSocket server. */
class FakeEventSub {
	readonly server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
	readonly connections: WebSocket[] = [];
	private counter = 0;

	constructor() {
		this.server.on('connection', (socket) => {
			this.connections.push(socket);
			this.send(socket, 'session_welcome', { session: { id: `session-${this.connections.length}`, keepalive_timeout_seconds: 30, reconnect_url: null } });
		});
	}

	get url(): string {
		return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
	}

	send(socket: WebSocket, type: string, payload: object, extra: object = {}, id = `id-${++this.counter}`): void {
		socket.send(
			JSON.stringify({
				metadata: { message_id: id, message_type: type, message_timestamp: '2026-11-21T17:11:28.708494458Z', ...extra },
				payload,
			}),
		);
	}

	notify(socket: WebSocket, type: string, event: object, id?: string): void {
		this.send(socket, 'notification', { subscription: { type }, event }, { subscription_type: type }, id);
	}

	close(): Promise<void> {
		for (const socket of this.connections) {
			socket.terminate();
		}
		return new Promise((resolve) => this.server.close(() => resolve()));
	}
}

suite('TwitchChat', () => {
	let eventSub: FakeEventSub;
	let chat: TwitchChat | undefined;

	setup(async () => {
		eventSub = new FakeEventSub();
		await new Promise((resolve) => eventSub.server.once('listening', resolve));
	});

	teardown(async () => {
		chat?.dispose();
		chat = undefined;
		await eventSub.close();
	});

	function helix(url: string): Response {
		if (url.includes('/users')) {
			return json({ data: [{ id: '200', login: 'other', display_name: 'Other' }] });
		}
		return json({ data: [{}] }, 202);
	}

	const subscriptions = (auth: FakeAuth) =>
		auth.requests
			.filter((request) => request.url.endsWith('/eventsub/subscriptions'))
			.map((request) => JSON.parse(String(request.init?.body)) as { type: string; condition: Record<string, string>; transport: Record<string, string> });

	test('subscribes each channel on welcome and delivers chat, removals and duplicates correctly', async () => {
		const sink = new RecordingSink();
		const auth = new FakeAuth(helix);
		const other = twitchChannelSource('other');
		const missing = twitchChannelSource('nobody');
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF, other, missing], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test' });
		chat.start();
		await waitFor(() => sink.state('twitch:me') === 'connected' && sink.state(other.id) === 'connected', 'both channels to connect');

		assert.strictEqual(sink.state(missing.id), 'error');
		assert.strictEqual(sink.labels.get(other.id), 'Other');
		const created = subscriptions(auth);
		assert.strictEqual(created.length, 14, 'five chat subscriptions for each channel, and four more in your own');
		assert.deepStrictEqual(created[0].transport, { method: 'websocket', session_id: 'session-1' });
		assert.deepStrictEqual(
			created.filter((sub) => sub.type === 'channel.chat.message').map((sub) => sub.condition),
			[
				{ broadcaster_user_id: '100', user_id: '100' },
				{ broadcaster_user_id: '200', user_id: '100' },
			],
		);

		const socket = eventSub.connections[0];
		eventSub.notify(socket, 'channel.chat.message', chatEvent, 'dup');
		eventSub.notify(socket, 'channel.chat.message', chatEvent, 'dup');
		eventSub.notify(socket, 'channel.chat.message', { ...chatEvent, broadcaster_user_id: '200', message_id: 'def' });
		eventSub.notify(socket, 'channel.chat.message_delete', { broadcaster_user_id: '100', message_id: 'abc' });
		eventSub.notify(socket, 'channel.chat.clear_user_messages', { broadcaster_user_id: '100', target_user_id: '7' });
		eventSub.notify(socket, 'channel.chat.clear', { broadcaster_user_id: '200' });
		await waitFor(() => sink.events.length >= 5, 'the events');

		assert.strictEqual(sink.events.length, 5, 'the duplicate notification is dropped');
		const [first, second, ...rest] = sink.events;
		assert.ok(first.type === 'message' && first.message.sourceId === 'twitch:me');
		assert.strictEqual(first.message.timestamp, Date.parse('2026-11-21T17:11:28.708Z'));
		assert.ok(second.type === 'message' && second.message.sourceId === other.id);
		assert.deepStrictEqual(rest, [
			{ type: 'delete', key: 'twitch:abc' },
			{ type: 'purge', platform: 'twitch', channelId: '100', userId: '7' },
			{ type: 'clear', platform: 'twitch', channelId: '200' },
		]);
	});

	test('subscribes to spending in your own channel only, and pairs costs with chat', async () => {
		const sink = new RecordingSink();
		const auth = new FakeAuth(helix);
		const other = twitchChannelSource('other');
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF, other], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test' });
		chat.start();
		await waitFor(() => sink.state('twitch:me') === 'connected' && sink.state(other.id) === 'connected', 'both channels to connect');
		assert.strictEqual(sink.statuses.get('twitch:me')?.detail, undefined);

		const spending = subscriptions(auth)
			.filter((sub) => !sub.type.startsWith('channel.chat.') && !sub.type.startsWith('automod.'))
			.map((sub) => ({ type: sub.type, version: (sub as { version?: string }).version, condition: sub.condition }));
		assert.deepStrictEqual(spending, [
			{ type: 'channel.channel_points_automatic_reward_redemption.add', version: '2', condition: { broadcaster_user_id: '100' } },
			{ type: 'channel.bits.use', version: '1', condition: { broadcaster_user_id: '100' } },
		]);

		const socket = eventSub.connections[0];
		eventSub.notify(socket, 'channel.chat.message', highlightedEvent);
		eventSub.notify(socket, 'channel.channel_points_automatic_reward_redemption.add', redemption);
		eventSub.notify(socket, 'channel.bits.use', { broadcaster_user_id: '100', user_id: '7', bits: 100, type: 'cheer' });
		eventSub.notify(socket, 'channel.bits.use', { broadcaster_user_id: '100', user_id: '7', bits: 200, type: 'power_up', power_up: { type: 'gigantify_an_emote' } });
		eventSub.notify(socket, 'channel.chat.message', { ...chatEvent, message_id: 'giant', message_type: 'power_ups_gigantified_emote' });
		await waitFor(() => sink.events.length >= 3, 'the events');
		await delay(50);

		assert.strictEqual(sink.events.length, 3, 'the cheer adds nothing');
		const [first, update, giant] = sink.events;
		assert.ok(first.type === 'message' && first.message.headline === 'Highlighted');
		assert.ok(update.type === 'update' && update.message.key === 'twitch:abc');
		assert.deepStrictEqual(update.message.spent, [{ currency: 'points', amount: 1500 }]);
		assert.ok(giant.type === 'message' && giant.message.headline === 'Gigantified an emote');
		assert.deepStrictEqual(giant.message.spent, [{ currency: 'bits', amount: 200 }], 'a cost that came first');
	});

	test('keeps chat going when Twitch refuses the spending subscriptions, and says why', async () => {
		const sink = new RecordingSink();
		const auth = new FakeAuth((url, init) => {
			const type = url.endsWith('/eventsub/subscriptions') ? (JSON.parse(String(init?.body)) as { type: string }).type : '';
			return type && !type.startsWith('channel.chat.') ? json({ message: 'subscription missing proper authorization' }, 403) : helix(url);
		});
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test' });
		chat.start();
		await waitFor(() => sink.state('twitch:me') === 'connected', 'the channel to connect');
		assert.match(sink.statuses.get('twitch:me')?.detail ?? '', /Sign in to Twitch again/);
		assert.strictEqual(sink.logs.filter((line) => line.includes('missing proper authorization')).length, 4);

		eventSub.notify(eventSub.connections[0], 'channel.chat.message', chatEvent);
		await waitFor(() => sink.events.length === 1, 'chat');
	});

	test('a revoked spending subscription leaves chat alone', async () => {
		const sink = new RecordingSink();
		const auth = new FakeAuth(helix);
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test' });
		chat.start();
		await waitFor(() => sink.state('twitch:me') === 'connected', 'the channel to connect');

		eventSub.send(eventSub.connections[0], 'revocation', {
			subscription: { type: 'channel.bits.use', status: 'authorization_revoked', condition: { broadcaster_user_id: '100' } },
		});
		await delay(300);
		assert.strictEqual(eventSub.connections.length, 1);
		assert.strictEqual(sink.state('twitch:me'), 'connected');
		assert.ok(sink.logs.some((line) => line.includes('channel.bits.use')));
	});

	test('subscribes to AutoMod holds as moderator of your own channel and shows them as they change', async () => {
		const sink = new RecordingSink();
		const auth = new FakeAuth(helix);
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test' });
		chat.start();
		await waitFor(() => sink.state('twitch:me') === 'connected', 'the channel to connect');
		const automod = subscriptions(auth)
			.filter((sub) => sub.type.startsWith('automod.'))
			.map((sub) => ({ type: sub.type, version: (sub as { version?: string }).version, condition: sub.condition }));
		assert.deepStrictEqual(automod, [
			{ type: 'automod.message.hold', version: '2', condition: { broadcaster_user_id: '100', moderator_user_id: '100' } },
			{ type: 'automod.message.update', version: '2', condition: { broadcaster_user_id: '100', moderator_user_id: '100' } },
		]);

		const socket = eventSub.connections[0];
		eventSub.notify(socket, 'automod.message.hold', holdEvent);
		eventSub.notify(socket, 'automod.message.update', { ...holdEvent, status: 'Denied', moderator_user_name: 'Me' });
		await waitFor(() => sink.events.length === 2, 'the hold and its outcome');
		const [hold, update] = sink.events;
		assert.ok(hold.type === 'message' && hold.message.held?.state === 'held');
		assert.ok(update.type === 'update' && update.message.key === 'twitch:automod-held-1' && update.message.held?.state === 'denied');
	});

	test('allows and denies held messages as the signed-in moderator, and explains a refusal', async () => {
		const sink = new RecordingSink();
		let status = 204;
		const auth = new FakeAuth((url) => (url.includes('/moderation/automod/message') ? (status === 204 ? new Response(null, { status }) : json({ message: 'nope' }, status)) : helix(url)));
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test' });
		chat.start();
		await waitFor(() => sink.state('twitch:me') === 'connected', 'the channel to connect');

		await chat.resolveHeld('held-1', true);
		await chat.resolveHeld('held-2', false);
		const sent = auth.requests
			.filter((request) => request.url === 'https://helix.test/moderation/automod/message')
			.map((request) => ({ method: request.init?.method, body: JSON.parse(String(request.init?.body)) as unknown }));
		assert.deepStrictEqual(sent, [
			{ method: 'POST', body: { user_id: '100', msg_id: 'held-1', action: 'ALLOW' } },
			{ method: 'POST', body: { user_id: '100', msg_id: 'held-2', action: 'DENY' } },
		]);

		for (const [code, pattern] of [
			[400, /already allowed or denied, or its hold has expired/],
			[401, /Sign in to Twitch again/],
			[403, /not a moderator/],
			[404, /no longer has that message/],
			[500, /Twitch: nope/],
		] as const) {
			status = code;
			await assert.rejects(chat.resolveHeld('held-3', true), (error: Error) => error instanceof ModerationError && pattern.test(error.message), `HTTP ${code}`);
		}
	});

	test('moves to the reconnect URL without subscribing again', async () => {
		const sink = new RecordingSink();
		const auth = new FakeAuth(helix);
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test' });
		chat.start();
		await waitFor(() => sink.state('twitch:me') === 'connected', 'the channel to connect');

		const first = eventSub.connections[0];
		let firstClosed = false;
		first.on('close', () => (firstClosed = true));
		eventSub.send(first, 'session_reconnect', { session: { id: 'session-1', reconnect_url: `${eventSub.url}/moved` } });
		await waitFor(() => eventSub.connections.length === 2 && firstClosed, 'the client to move to the new connection');

		eventSub.notify(eventSub.connections[1], 'channel.chat.message', chatEvent);
		await waitFor(() => sink.events.length === 1, 'a message on the new connection');
		assert.strictEqual(subscriptions(auth).length, 9, 'subscriptions carry over');
		assert.strictEqual(sink.state('twitch:me'), 'connected');
	});

	test('reconnects and subscribes again after the connection drops', async () => {
		const sink = new RecordingSink();
		const auth = new FakeAuth(helix);
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test' });
		chat.start();
		await waitFor(() => sink.state('twitch:me') === 'connected', 'the channel to connect');

		eventSub.connections[0].terminate();
		await waitFor(() => sink.state('twitch:me') === 'connecting', 'the reconnecting status');
		await waitFor(() => eventSub.connections.length === 2 && sink.state('twitch:me') === 'connected', 'the reconnect');
		assert.strictEqual(subscriptions(auth).length, 18);
		assert.strictEqual(subscriptions(auth)[17].transport.session_id, 'session-2');
	});

	test('stops instead of looping when Twitch refuses the subscriptions', async () => {
		const sink = new RecordingSink();
		const auth = new FakeAuth((url) => (url.includes('/users') ? helix(url) : json({ message: 'Missing scope: user:read:chat' }, 403)));
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test' });
		chat.start();
		await waitFor(() => sink.state('twitch:me') === 'error', 'the error status');
		assert.match(sink.statuses.get('twitch:me')?.detail ?? '', /Missing scope: user:read:chat/);

		await delay(1500); // Longer than the first reconnect delay.
		assert.strictEqual(eventSub.connections.length, 1);
		assert.strictEqual(sink.state('twitch:me'), 'error');
	});

	test('asks for sign-in, without looping, when Twitch rejects the token', async () => {
		const sink = new RecordingSink();
		const auth = new FakeAuth((url) => (url.includes('/users') ? helix(url) : json({ message: 'Invalid OAuth token' }, 401)));
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test' });
		chat.start();
		await waitFor(() => sink.state('twitch:me') === 'needsSignIn', 'the sign-in status');
		assert.match(sink.statuses.get('twitch:me')?.detail ?? '', /Invalid OAuth token/);

		await delay(1500);
		assert.strictEqual(eventSub.connections.length, 1);
	});

	test('resubscribes once when Twitch revokes subscriptions, then reports an error if it happens again', async () => {
		const sink = new RecordingSink();
		const auth = new FakeAuth(helix);
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test' });
		chat.start();
		await waitFor(() => sink.state('twitch:me') === 'connected', 'the channel to connect');

		const revoke = (socket: WebSocket) => {
			// Twitch sends one revocation per subscription.
			for (let i = 0; i < 5; i++) {
				eventSub.send(socket, 'revocation', { subscription: { status: 'authorization_revoked', condition: { broadcaster_user_id: '100' } } });
			}
		};
		revoke(eventSub.connections[0]);
		await waitFor(() => eventSub.connections.length === 2 && sink.state('twitch:me') === 'connected', 'one reconnect');
		assert.strictEqual(subscriptions(auth).length, 18);

		revoke(eventSub.connections[1]);
		await waitFor(() => sink.state('twitch:me') === 'error', 'the error status');
		assert.match(sink.statuses.get('twitch:me')?.detail ?? '', /revoked chat access \(authorization_revoked\)/);
		await delay(1500);
		assert.strictEqual(eventSub.connections.length, 2);
	});

	test('reports each channel’s viewers from one request, counting an offline channel as unknown', async () => {
		const sink = new RecordingSink();
		let live = 42;
		const auth = new FakeAuth((url) =>
			url.includes('/streams') ? json({ data: [{ user_id: '100', viewer_count: live, type: 'live' }] }) : helix(url),
		);
		const other = twitchChannelSource('other');
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF, other], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test', viewerIntervalMs: 30 });
		chat.start();
		await waitFor(() => sink.viewerCount('twitch:me') === 42, 'the first count');
		assert.strictEqual(sink.viewerCount(other.id), undefined, 'a channel Get Streams leaves out is offline');
		assert.ok(sink.viewerReports.has(other.id), 'the offline channel is still reported');
		const query = new URL(auth.requests.find((request) => request.url.includes('/streams'))?.url ?? '').searchParams;
		assert.deepStrictEqual(query.getAll('user_id'), ['100', '200']);

		live = 57;
		await waitFor(() => sink.viewerCount('twitch:me') === 57, 'the next count');
	});

	test('a failing viewer count is logged once, leaves the chat alone, and is cleared once it is stale', async () => {
		const sink = new RecordingSink();
		let failing = false;
		const auth = new FakeAuth((url) => {
			if (!url.includes('/streams')) {
				return helix(url);
			}
			return failing ? json({ message: 'Too many requests' }, 429) : json({ data: [{ user_id: '100', viewer_count: 42 }] });
		});
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test', viewerIntervalMs: 20 });
		chat.start();
		await waitFor(() => sink.state('twitch:me') === 'connected' && sink.viewerCount('twitch:me') === 42, 'the channel and its count');

		failing = true;
		const before = auth.requests.length;
		await waitFor(() => sink.viewerCount('twitch:me') === undefined, 'the stale count to clear');
		const attempts = auth.requests.slice(before).filter((request) => request.url.includes('/streams')).length;
		assert.ok(attempts >= 3, `cleared only after repeated failures, not after ${attempts}`);
		await delay(100);
		assert.strictEqual(sink.logs.filter((line) => line.includes('viewer count')).length, 1);
		assert.strictEqual(sink.state('twitch:me'), 'connected');
	});

	test('asks for sign-in without connecting when there is no session', async () => {
		const sink = new RecordingSink();
		const auth = new FakeAuth(helix);
		auth.ensureValidError = new NotSignedInError();
		chat = new TwitchChat({ auth, sources: [TWITCH_SELF], sink, wsUrl: eventSub.url, helixUrl: 'https://helix.test' });
		chat.start();
		await waitFor(() => sink.state('twitch:me') === 'needsSignIn', 'the sign-in status');
		assert.strictEqual(eventSub.connections.length, 0);
	});
});
