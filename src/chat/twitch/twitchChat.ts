import { WebSocket } from 'ws';
import { backoffMs } from '../../util/emitter';
import { Account, ChatAuth, ChatSink, NotSignedInError, SourceStatus, TwitchSource } from '../types';
import { TwitchChatEvent, mapNotification } from './twitchMapper';
import { AutomaticRedemptionEvent, BitsUseEvent, SpendMatcher, SpendResult, mapAutomaticRedemption, mapBitsUse } from './twitchSpend';
import { AutomodEvent, mapAutomodHold, mapAutomodUpdate } from './twitchAutomod';
import { ModerationError } from '../moderation';

// Reads Twitch chat through EventSub over WebSocket, the transport Twitch recommends.
// Protocol: https://dev.twitch.tv/docs/eventsub/handling-websocket-events/

const DEFAULT_WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const DEFAULT_HELIX_URL = 'https://api.twitch.tv/helix';
/** What chat needs, in every channel. Reading chat as the signed-in user, so the condition names them too. */
const CHAT_SUBSCRIPTIONS = [
	'channel.chat.message',
	'channel.chat.notification',
	'channel.chat.message_delete',
	'channel.chat.clear_user_messages',
	'channel.chat.clear',
];
/**
 * In the signed-in user's own channel only: what viewers spent, which Twitch shows to nobody else, and the messages
 * AutoMod holds for review. Chat works without these, so a refusal (such as a sign-in from before they were added)
 * is logged, not fatal. `moderator` subscriptions name the user as the moderator in their condition.
 */
const OWN_CHANNEL_SUBSCRIPTIONS: { type: string; version: string; moderator?: boolean }[] = [
	{ type: 'channel.channel_points_automatic_reward_redemption.add', version: '2' },
	{ type: 'channel.bits.use', version: '1' },
	{ type: 'automod.message.hold', version: '2', moderator: true },
	{ type: 'automod.message.update', version: '2', moderator: true },
];
const OWN_CHANNEL_TYPES = new Set(OWN_CHANNEL_SUBSCRIPTIONS.map((subscription) => subscription.type));
const VALIDATE_INTERVAL_MS = 60 * 60 * 1000;
/** How long past the keepalive interval to wait before treating the connection as dead. */
const WATCHDOG_GRACE_MS = 10_000;
const SEEN_LIMIT = 1000;
/** A revocation this soon after the last one means reconnecting did not help. */
const REVOCATION_RETRY_MS = 60_000;
/** Twitch refreshes `viewer_count` every minute or two, so asking more often shows nothing new. */
const DEFAULT_VIEWER_INTERVAL_MS = 60_000;
/** The most `user_id`s one Get Streams request accepts. */
const STREAMS_PAGE = 100;
/** After this many failed viewer lookups in a row the last count is too old to show as current. */
const VIEWER_FAILURES_BEFORE_CLEARING = 3;

export interface TwitchChatOptions {
	auth: ChatAuth;
	sources: TwitchSource[];
	sink: ChatSink;
	wsUrl?: string;
	helixUrl?: string;
	keepaliveSeconds?: number;
	/** How often to fetch each channel's viewer count. */
	viewerIntervalMs?: number;
}

interface Channel {
	source: TwitchSource;
	broadcasterId: string;
}

interface EventSubMessage {
	metadata?: { message_id?: string; message_type?: string; message_timestamp?: string; subscription_type?: string };
	payload?: {
		session?: { id?: string; keepalive_timeout_seconds?: number | null; reconnect_url?: string | null };
		subscription?: { type?: string; status?: string; condition?: { broadcaster_user_id?: string } };
		event?: TwitchChatEvent & { target_user_id?: string };
	};
}

/** One EventSub connection carrying every Twitch chat source. */
export class TwitchChat {
	private readonly wsUrl: string;
	private readonly helixUrl: string;
	private readonly channels = new Map<string, Channel>();
	private socket: WebSocket | undefined;
	/** The replacement connection while Twitch is moving us to another server. */
	private nextSocket: WebSocket | undefined;
	private userId = '';
	private keepaliveMs: number;
	private attempt = 0;
	private disposed = false;
	/** Set when retrying cannot help, so a failed connection is not reopened in a loop. */
	private stopped = false;
	private revocationPending = false;
	private lastRevocationRetry = 0;
	private retryTimer: NodeJS.Timeout | undefined;
	private watchdog: NodeJS.Timeout | undefined;
	private validateTimer: NodeJS.Timeout | undefined;
	private viewerTimer: NodeJS.Timeout | undefined;
	/** The last viewer-count failure, so a lasting one is logged once rather than every interval. */
	private viewerFailure: string | undefined;
	private viewerFailures = 0;
	private readonly seen = new Set<string>();
	private readonly spending = new SpendMatcher();

	constructor(private readonly options: TwitchChatOptions) {
		this.keepaliveMs = (options.keepaliveSeconds ?? 30) * 1000;
		this.wsUrl = `${options.wsUrl ?? DEFAULT_WS_URL}?keepalive_timeout_seconds=${options.keepaliveSeconds ?? 30}`;
		this.helixUrl = options.helixUrl ?? DEFAULT_HELIX_URL;
	}

	start(): void {
		void this.run();
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.retryTimer);
		clearTimeout(this.watchdog);
		clearInterval(this.validateTimer);
		clearTimeout(this.viewerTimer);
		this.socket?.terminate();
		this.nextSocket?.terminate();
	}

	private async run(): Promise<void> {
		this.setAll({ state: 'connecting' });
		try {
			// Twitch requires validating the token at startup and hourly. Channel IDs are resolved here too,
			// because subscriptions must be created within 10 seconds of the socket opening.
			await this.options.auth.ensureValid();
			const account = await this.options.auth.getAccount();
			if (!account) {
				throw new NotSignedInError();
			}
			this.userId = account.id;
			await this.resolveChannels(account);
		} catch (err) {
			if (this.disposed) {
				return;
			}
			if (err instanceof NotSignedInError) {
				this.setAll({ state: 'needsSignIn', detail: err.message });
				return;
			}
			this.options.sink.log(`Twitch: ${String(err)}`);
			this.setAll({ state: 'error', detail: errorText(err) });
			this.retryTimer = setTimeout(() => void this.run(), backoffMs(this.attempt++));
			return;
		}
		if (this.disposed || this.channels.size === 0) {
			return;
		}
		this.validateTimer = setInterval(() => void this.revalidate(), VALIDATE_INTERVAL_MS);
		void this.pollViewers();
		this.connect(this.wsUrl);
	}

	/**
	 * Fetches every channel's viewer count now and then on a timer, until the connection stops for good.
	 * Viewer counts are extra: a failure here is logged and never changes the chat's status.
	 */
	private async pollViewers(): Promise<void> {
		clearTimeout(this.viewerTimer);
		try {
			await this.updateViewers();
			this.viewerFailure = undefined;
			this.viewerFailures = 0;
		} catch (err) {
			const text = errorText(err);
			if (text !== this.viewerFailure && !this.disposed) {
				this.options.sink.log(`Twitch viewer count: ${text}`);
			}
			this.viewerFailure = text;
			if (++this.viewerFailures >= VIEWER_FAILURES_BEFORE_CLEARING) {
				this.clearViewers();
			}
		}
		if (this.disposed) {
			return;
		}
		if (this.stopped) {
			this.clearViewers();
			return;
		}
		this.viewerTimer = setTimeout(() => void this.pollViewers(), this.options.viewerIntervalMs ?? DEFAULT_VIEWER_INTERVAL_MS);
	}

	private async updateViewers(): Promise<void> {
		const ids = [...this.channels.keys()];
		const live = new Map<string, number>();
		for (let start = 0; start < ids.length; start += STREAMS_PAGE) {
			const query = ids
				.slice(start, start + STREAMS_PAGE)
				.map((id) => `user_id=${encodeURIComponent(id)}`)
				.join('&');
			const res = await this.options.auth.fetch(`${this.helixUrl}/streams?${query}&first=${STREAMS_PAGE}`);
			const body = (await res.json().catch(() => ({}))) as {
				message?: string;
				data?: { user_id?: unknown; viewer_count?: unknown }[];
			};
			if (!res.ok) {
				throw new Error(body.message ?? `HTTP ${res.status}`);
			}
			for (const stream of Array.isArray(body.data) ? body.data : []) {
				const count = stream?.viewer_count;
				if (typeof stream?.user_id === 'string' && typeof count === 'number' && Number.isFinite(count) && count >= 0) {
					live.set(stream.user_id, count);
				}
			}
		}
		// A channel Get Streams leaves out is offline.
		for (const [broadcasterId, channel] of this.channels) {
			this.viewers(channel.source.id, live.get(broadcasterId));
		}
	}

	private clearViewers(): void {
		for (const channel of this.channels.values()) {
			this.viewers(channel.source.id, undefined);
		}
	}

	private async resolveChannels(account: Account): Promise<void> {
		this.channels.clear();
		const byLogin = new Map<string, TwitchSource>();
		for (const source of this.options.sources) {
			if (source.kind === 'self') {
				this.channels.set(account.id, { source, broadcasterId: account.id });
				this.status(source.id, { state: 'connecting' }, account.label);
			} else {
				byLogin.set(source.login.toLowerCase(), source);
			}
		}
		if (byLogin.size === 0) {
			return;
		}
		const query = [...byLogin.keys()].map((login) => `login=${encodeURIComponent(login)}`).join('&');
		const res = await this.options.auth.fetch(`${this.helixUrl}/users?${query}`);
		const body = (await res.json().catch(() => ({}))) as {
			message?: string;
			data?: { id: string; login: string; display_name?: string }[];
		};
		if (!res.ok) {
			throw new Error(`Twitch: ${body.message ?? `HTTP ${res.status}`}`);
		}
		for (const user of body.data ?? []) {
			const source = byLogin.get(user.login);
			if (!source) {
				continue;
			}
			byLogin.delete(user.login);
			if (this.channels.has(user.id)) {
				this.status(source.id, { state: 'error', detail: 'This channel is already shown by another source.' });
				continue;
			}
			this.channels.set(user.id, { source, broadcasterId: user.id });
			this.status(source.id, { state: 'connecting' }, user.display_name || user.login);
		}
		for (const source of byLogin.values()) {
			this.status(source.id, { state: 'error', detail: 'Twitch has no channel with this name.' });
		}
	}

	private connect(url: string, replacing = false): void {
		const ws = new WebSocket(url);
		if (replacing) {
			this.nextSocket = ws;
		} else {
			this.socket = ws;
		}
		ws.on('message', (data) => this.onMessage(ws, data.toString()));
		ws.on('error', (err) => {
			if (!this.disposed) {
				this.options.sink.log(`Twitch socket error: ${err.message}`);
			}
		});
		ws.on('close', (code, reason) => this.onClose(ws, code, reason.toString()));
	}

	private onClose(ws: WebSocket, code: number, reason: string): void {
		if (ws === this.nextSocket) {
			this.nextSocket = undefined;
			return;
		}
		if (ws !== this.socket) {
			return; // An old connection that has already been replaced.
		}
		clearTimeout(this.watchdog);
		if (this.disposed || this.stopped) {
			return;
		}
		this.options.sink.log(`Twitch socket closed (${code}${reason ? ` ${reason}` : ''}); reconnecting.`);
		this.setChannels({ state: 'connecting', detail: 'Reconnecting…' });
		this.retryTimer = setTimeout(() => this.connect(this.wsUrl), backoffMs(this.attempt++));
	}

	private onMessage(ws: WebSocket, raw: string): void {
		let message: EventSubMessage;
		try {
			message = JSON.parse(raw) as EventSubMessage;
		} catch {
			return;
		}
		const type = message.metadata?.message_type;
		const session = message.payload?.session;
		if (type === 'session_welcome') {
			if (typeof session?.keepalive_timeout_seconds === 'number') {
				this.keepaliveMs = session.keepalive_timeout_seconds * 1000;
			}
			if (ws === this.nextSocket) {
				// Subscriptions carry over to the replacement connection; the old one may now be closed.
				const old = this.socket;
				this.socket = ws;
				this.nextSocket = undefined;
				old?.close();
			} else if (session?.id) {
				void this.subscribeAll(ws, session.id);
			}
		}
		if (ws === this.socket) {
			this.armWatchdog(ws);
		}
		if (type === 'session_reconnect' && session?.reconnect_url && !this.nextSocket) {
			this.connect(session.reconnect_url, true);
		} else if (type === 'notification') {
			this.onNotification(message);
		} else if (type === 'revocation') {
			this.onRevocation(message);
		}
	}

	/** Twitch sends an event or a keepalive within the keepalive interval; silence means the connection is dead. */
	private armWatchdog(ws: WebSocket): void {
		clearTimeout(this.watchdog);
		this.watchdog = setTimeout(() => {
			this.options.sink.log('Twitch connection went silent; reconnecting.');
			ws.terminate();
		}, this.keepaliveMs + WATCHDOG_GRACE_MS);
	}

	private async subscribeAll(ws: WebSocket, sessionId: string): Promise<void> {
		this.revocationPending = false;
		let subscribed = 0;
		let retryable = false;
		await Promise.all(
			[...this.channels.values()].map(async (channel) => {
				try {
					const [results, spendNote] = await Promise.all([
						Promise.all(
							CHAT_SUBSCRIPTIONS.map((type) =>
								this.subscribe(type, '1', { broadcaster_user_id: channel.broadcasterId, user_id: this.userId }, sessionId),
							),
						),
						channel.broadcasterId === this.userId ? this.subscribeOwnChannel(channel, sessionId) : undefined,
					]);
					const failure = results.find((result) => result !== undefined);
					if (failure) {
						this.status(channel.source.id, { state: 'error', detail: `Twitch refused ${failure.message}` });
					} else {
						subscribed++;
						this.status(channel.source.id, spendNote ? { state: 'connected', detail: spendNote } : { state: 'connected' });
					}
				} catch (err) {
					if (err instanceof NotSignedInError) {
						this.status(channel.source.id, { state: 'needsSignIn', detail: err.message });
					} else {
						retryable = true;
						this.options.sink.log(`Twitch subscription failed: ${String(err)}`);
						this.status(channel.source.id, { state: 'error', detail: errorText(err) });
					}
				}
			}),
		);
		if (this.disposed || ws !== this.socket) {
			return;
		}
		if (subscribed > 0) {
			this.attempt = 0;
			return;
		}
		// Twitch closes a connection that has no subscriptions. Only reconnect if trying again could work.
		this.stopped = !retryable;
		if (this.stopped) {
			clearTimeout(this.viewerTimer);
			this.clearViewers();
		}
		ws.close();
	}

	/**
	 * Subscribes to spending and AutoMod holds in the user's own channel. Never throws: chat works without them.
	 * Returns a note for the channel's status when they could not be had, or `undefined` when they could.
	 */
	private async subscribeOwnChannel(channel: Channel, sessionId: string): Promise<string | undefined> {
		const results = await Promise.all(
			OWN_CHANNEL_SUBSCRIPTIONS.map(async ({ type, version, moderator }) => {
				const condition: Record<string, string> = { broadcaster_user_id: channel.broadcasterId };
				if (moderator) {
					condition.moderator_user_id = this.userId;
				}
				try {
					const refusal = await this.subscribe(type, version, condition, sessionId);
					if (refusal) {
						this.options.sink.log(`Twitch refused ${refusal.message}`);
					}
					return refusal;
				} catch (err) {
					this.options.sink.log(`Twitch subscription to ${type} failed: ${errorText(err)}`);
					return { status: 0, message: errorText(err) };
				}
			}),
		);
		if (results.some((result) => result?.status === 403)) {
			return 'Sign in to Twitch again to show channel points, Bits spent and messages AutoMod holds.';
		}
		if (results.some((result) => result !== undefined)) {
			return 'Some of channel points, Bits spent and AutoMod holds cannot be shown; see the Caerwyn output for why.';
		}
		return undefined;
	}

	/**
	 * Lets a message AutoMod held into chat, or keeps it out. Twitch then sends `automod.message.update`, which is
	 * what changes the held row. Throws `ModerationError` with a message for the user when Twitch refuses.
	 */
	async resolveHeld(messageId: string, allow: boolean): Promise<void> {
		let res: Response;
		try {
			res = await this.options.auth.fetch(`${this.helixUrl}/moderation/automod/message`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ user_id: this.userId, msg_id: messageId, action: allow ? 'ALLOW' : 'DENY' }),
			});
		} catch (err) {
			if (err instanceof NotSignedInError) {
				throw new ModerationError('Sign in to Twitch again to allow or deny held messages.');
			}
			throw new ModerationError(`Could not reach Twitch: ${errorText(err)}`);
		}
		if (res.status === 204 || res.ok) {
			return;
		}
		const body = (await res.json().catch(() => ({}))) as { message?: string };
		this.options.sink.log(`Twitch refused to ${allow ? 'allow' : 'deny'} a held message: HTTP ${res.status} ${body.message ?? ''}`.trim());
		switch (res.status) {
			case 400:
				throw new ModerationError('That message was already allowed or denied, or its hold has expired.');
			case 401:
				throw new ModerationError('Sign in to Twitch again to allow or deny held messages.');
			case 403:
				throw new ModerationError('Twitch says you are not a moderator of this channel.');
			case 404:
				throw new ModerationError('Twitch no longer has that message.');
			default:
				throw new ModerationError(`Twitch: ${body.message ?? `HTTP ${res.status}`}`);
		}
	}

	/** Creates one subscription. Returns `undefined` on success, or Twitch's refusal when retrying will not help. */
	private async subscribe(
		type: string,
		version: string,
		condition: Record<string, string>,
		sessionId: string,
	): Promise<{ status: number; message: string } | undefined> {
		const res = await this.options.auth.fetch(`${this.helixUrl}/eventsub/subscriptions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type, version, condition, transport: { method: 'websocket', session_id: sessionId } }),
		});
		// 409 means this exact subscription already exists on the session.
		if (res.status === 202 || res.status === 409) {
			return undefined;
		}
		const body = (await res.json().catch(() => ({}))) as { message?: string };
		const message = body.message ?? `HTTP ${res.status}`;
		if (res.status === 401) {
			// The token was already refreshed once for this request, so only signing in again can help.
			throw new NotSignedInError(`Twitch rejected the session: ${message}`);
		}
		if (res.status >= 500) {
			throw new Error(`Twitch: ${message}`);
		}
		return { status: res.status, message: `${type}: ${message}` };
	}

	private onNotification(message: EventSubMessage): void {
		const id = message.metadata?.message_id;
		const event = message.payload?.event;
		if (!event) {
			return;
		}
		// Twitch delivers at least once, so the same notification can arrive twice.
		if (id) {
			if (this.seen.has(id)) {
				return;
			}
			this.seen.add(id);
			if (this.seen.size > SEEN_LIMIT) {
				this.seen.delete(this.seen.values().next().value as string);
			}
		}
		const channel = this.channels.get(event.broadcaster_user_id);
		if (!channel) {
			return;
		}
		const sink = this.options.sink;
		const timestamp = Date.parse(message.metadata?.message_timestamp ?? '') || Date.now();
		switch (message.metadata?.subscription_type) {
			case 'channel.chat.message':
				sink.event({ type: 'message', message: this.spending.message(event, channel.source.id, timestamp) });
				break;
			case 'channel.channel_points_automatic_reward_redemption.add': {
				const redemption = event as unknown as AutomaticRedemptionEvent;
				this.spend(mapAutomaticRedemption(redemption, channel.source.id, timestamp, id ?? String(timestamp)));
				break;
			}
			case 'channel.bits.use':
				this.spend(mapBitsUse(event as unknown as BitsUseEvent, channel.source.id, timestamp, id ?? String(timestamp)));
				break;
			case 'automod.message.hold': {
				const held = mapAutomodHold(event as unknown as AutomodEvent, channel.source.id, timestamp);
				if (held) {
					sink.event({ type: 'message', message: held });
				}
				break;
			}
			case 'automod.message.update': {
				const held = mapAutomodUpdate(event as unknown as AutomodEvent, channel.source.id, timestamp);
				if (held) {
					sink.event({ type: 'update', message: held });
				}
				break;
			}
			case 'channel.chat.notification':
				sink.event({ type: 'message', message: mapNotification(event, channel.source.id, timestamp) });
				break;
			case 'channel.chat.message_delete':
				sink.event({ type: 'delete', key: `twitch:${event.message_id}` });
				break;
			case 'channel.chat.clear_user_messages':
				if (event.target_user_id) {
					sink.event({ type: 'purge', platform: 'twitch', channelId: channel.broadcasterId, userId: event.target_user_id });
				}
				break;
			case 'channel.chat.clear':
				sink.event({ type: 'clear', platform: 'twitch', channelId: channel.broadcasterId });
				break;
		}
	}

	/** Shows a viewer's spending: as its own row, or as the cost of a chat message. */
	private spend(result: SpendResult | undefined): void {
		if (result?.kind === 'message') {
			this.options.sink.event({ type: 'message', message: result.message });
		} else if (result?.kind === 'cost') {
			const updated = this.spending.cost(result.cost);
			if (updated) {
				this.options.sink.event({ type: 'update', message: updated });
			}
		}
	}

	private onRevocation(message: EventSubMessage): void {
		const subscription = message.payload?.subscription;
		this.options.sink.log(`Twitch revoked a subscription (${subscription?.type ?? 'unknown type'}, ${subscription?.status ?? 'unknown'}).`);
		if (OWN_CHANNEL_TYPES.has(subscription?.type ?? '')) {
			return; // Chat goes on without it. Signing in again subscribes afresh.
		}
		if (this.revocationPending) {
			return; // A channel's subscriptions are revoked together; the reconnect is already under way.
		}
		if (Date.now() - this.lastRevocationRetry > REVOCATION_RETRY_MS) {
			// Reconnect and subscribe again, in case a fresh token is all that is needed. If Twitch
			// revokes again straight away, retrying will not help and the error is shown instead.
			this.lastRevocationRetry = Date.now();
			this.revocationPending = true;
			this.socket?.close();
			return;
		}
		const channel = this.channels.get(subscription?.condition?.broadcaster_user_id ?? '');
		if (channel) {
			this.status(channel.source.id, {
				state: 'error',
				detail: `Twitch revoked chat access (${subscription?.status ?? 'unknown'}). Sign in again.`,
			});
		}
	}

	private async revalidate(): Promise<void> {
		try {
			await this.options.auth.ensureValid();
		} catch (err) {
			if (err instanceof NotSignedInError && !this.disposed) {
				this.stopped = true;
				clearTimeout(this.viewerTimer);
				this.clearViewers();
				this.setChannels({ state: 'needsSignIn', detail: err.message });
				this.socket?.close();
			} else {
				this.options.sink.log(`Twitch token validation failed: ${String(err)}`);
			}
		}
	}

	/** A disposed connection stays quiet, so it cannot overwrite the status of its replacement. */
	private status(sourceId: string, status: SourceStatus, label?: string): void {
		if (!this.disposed) {
			this.options.sink.status(sourceId, status, label);
		}
	}

	private viewers(sourceId: string, count: number | undefined): void {
		if (!this.disposed) {
			this.options.sink.viewers(sourceId, count);
		}
	}

	private setAll(status: SourceStatus): void {
		for (const source of this.options.sources) {
			this.status(source.id, status);
		}
	}

	private setChannels(status: SourceStatus): void {
		for (const channel of this.channels.values()) {
			this.status(channel.source.id, status);
		}
	}
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
