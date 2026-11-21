import * as assert from 'assert';
import { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';
import { TwitchChat } from '../chat/twitch/twitchChat';
import { mapChatMessage, mapNotification } from '../chat/twitch/twitchMapper';
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
		assert.strictEqual(message.headline, 'Cheered 100 bits');
		assert.deepStrictEqual(message.replyTo, { name: 'Other', text: 'question?' });
		assert.strictEqual(message.author.color, undefined);
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
		assert.strictEqual(created.length, 10, 'five subscription types for each of two channels');
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
		assert.strictEqual(subscriptions(auth).length, 5, 'subscriptions carry over');
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
		assert.strictEqual(subscriptions(auth).length, 10);
		assert.strictEqual(subscriptions(auth)[9].transport.session_id, 'session-2');
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
		assert.strictEqual(subscriptions(auth).length, 10);

		revoke(eventSub.connections[1]);
		await waitFor(() => sink.state('twitch:me') === 'error', 'the error status');
		assert.match(sink.statuses.get('twitch:me')?.detail ?? '', /revoked chat access \(authorization_revoked\)/);
		await delay(1500);
		assert.strictEqual(eventSub.connections.length, 2);
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
