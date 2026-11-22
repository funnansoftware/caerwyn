import { backoffMs, sleep } from '../../util/emitter';
import { ChatAuth, ChatSink, NotSignedInError, SourceStatus, YouTubeSource } from '../types';
import { JsonObjectStream } from './jsonStream';
import { YouTubeChatItem, YouTubeMapContext, mapYouTubeItem } from './youtubeMapper';

// Reads one YouTube live chat with the YouTube Data API v3.
// The default transport is the server-streamed `liveChat/messages/stream` method: one request costs
// 5 quota units and stays open, where polling `liveChat/messages` costs 5 units every few seconds.

const DEFAULT_API_URL = 'https://www.googleapis.com/youtube/v3';
const DEFAULT_STREAM_URL = 'https://youtube.googleapis.com/youtube/v3/liveChat/messages/stream';
/** A stream that closes sooner than this counts as a failed attempt, so reconnects back off. */
const SHORT_STREAM_MS = 10_000;
/** Each viewer-count lookup costs 1 quota unit, so once a minute is 60 units an hour. */
const DEFAULT_VIEWER_INTERVAL_MS = 60_000;
/** After this many failed viewer lookups in a row the last count is too old to show as current. */
const VIEWER_FAILURES_BEFORE_CLEARING = 3;

export type YouTubeTransport = 'stream' | 'poll';

export interface YouTubeChatOptions {
	auth: ChatAuth;
	source: YouTubeSource;
	sink: ChatSink;
	transport: YouTubeTransport;
	apiUrl?: string;
	streamUrl?: string;
	/** How long to wait before looking again for a broadcast that is not live yet. */
	lookupIntervalMs?: number;
	/** How often to fetch the stream's viewer count while its chat is being read. */
	viewerIntervalMs?: number;
}

export class YouTubeApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly reason: string,
	) {
		super(message);
		this.name = 'YouTubeApiError';
	}
}

interface ApiErrorBody {
	error?: { code?: number; message?: string; status?: string; errors?: { reason?: string }[] };
}

/** Builds an error from `{ error }`, or from the `[{ error }]` form the streaming method uses. */
export function toApiError(body: unknown, httpStatus: number): YouTubeApiError {
	const wrapper = (Array.isArray(body) ? body[0] : body) as ApiErrorBody | undefined;
	const error = wrapper?.error;
	return new YouTubeApiError(
		error?.message ?? `HTTP ${httpStatus}`,
		error?.code ?? httpStatus,
		error?.errors?.[0]?.reason ?? error?.status ?? 'unknown',
	);
}

function isRetryable(err: unknown): boolean {
	if (err instanceof YouTubeApiError) {
		return err.reason === 'rateLimitExceeded' || err.status >= 500;
	}
	return !(err instanceof NotSignedInError);
}

interface ChatResponse extends ApiErrorBody {
	items?: YouTubeChatItem[];
	nextPageToken?: string;
	pollingIntervalMillis?: number;
}

/** `videoId` is the broadcast's video, where its viewer count is read; without it there is no count. */
type Found = { liveChatId: string; title: string; videoId?: string };
type Lookup = Found | { wait: string } | { ended: string };

interface VideoSnippet {
	channelTitle?: string;
	title?: string;
	/** `live`, `upcoming` or `none`. */
	liveBroadcastContent?: string;
}

interface VideoResponse {
	items?: {
		snippet?: VideoSnippet;
		liveStreamingDetails?: { activeLiveChatId?: string; concurrentViewers?: unknown };
	}[];
}

/** The abort reason used to drop the chat being read and look up the broadcast again. */
class Reconnect {
	constructor(readonly why: string) {}
}

export class YouTubeChat {
	private readonly abort = new AbortController();
	private readonly apiUrl: string;
	private readonly streamUrl: string;
	private readonly lookupIntervalMs: number;
	private readonly viewerIntervalMs: number;
	private pageToken: string | undefined;
	private pollMs = 5000;
	/** The last status reported, so the label can change without changing the status. */
	private current: SourceStatus = { state: 'connecting' };

	constructor(private readonly options: YouTubeChatOptions) {
		this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
		this.streamUrl = options.streamUrl ?? DEFAULT_STREAM_URL;
		this.lookupIntervalMs = options.lookupIntervalMs ?? 60_000;
		this.viewerIntervalMs = options.viewerIntervalMs ?? DEFAULT_VIEWER_INTERVAL_MS;
	}

	start(): void {
		void this.run();
	}

	dispose(): void {
		this.abort.abort();
	}

	private get signal(): AbortSignal {
		return this.abort.signal;
	}

	/** A disposed connection stays quiet, so it cannot overwrite the status of its replacement. */
	private status(status: SourceStatus, label?: string): void {
		if (!this.signal.aborted) {
			this.current = status;
			this.options.sink.status(this.options.source.id, status, label);
		}
	}

	/** The name shown for the chat: the channel for someone else's video, the broadcast title for your own. */
	private labelFor(snippet: VideoSnippet | undefined): string | undefined {
		return (this.options.source.kind === 'video' ? snippet?.channelTitle || snippet?.title : snippet?.title) || undefined;
	}

	private async run(): Promise<void> {
		let attempt = 0;
		this.status({ state: 'connecting' });
		while (!this.signal.aborted) {
			try {
				const found = await this.findChat();
				if ('liveChatId' in found) {
					attempt = 0;
					const context: YouTubeMapContext = { sourceId: this.options.source.id, liveChatId: found.liveChatId, channelName: found.title };
					const watching = new AbortController();
					const signal = AbortSignal.any([this.signal, watching.signal]);
					if (found.videoId) {
						void this.watchBroadcast(found.videoId, context, signal, (why) => watching.abort(new Reconnect(why)));
					}
					try {
						await this.readChat(context, signal);
					} catch (err) {
						if (this.signal.aborted || !(watching.signal.reason instanceof Reconnect)) {
							throw err;
						}
					} finally {
						watching.abort();
						this.viewers(undefined);
					}
					const reconnect: unknown = watching.signal.reason;
					if (reconnect instanceof Reconnect) {
						// Look again straight away: the live broadcast is found before any upcoming one.
						this.options.sink.log(`YouTube: ${reconnect.why}; reconnecting to its chat.`);
						this.status({ state: 'connecting' });
						continue;
					}
					this.status({ state: 'ended', detail: 'The live chat has ended.' });
					if (this.options.source.kind === 'video') {
						return;
					}
					// Your own channel: keep watching for the next broadcast.
				} else if ('ended' in found) {
					this.status({ state: 'ended', detail: found.ended });
					return;
				} else {
					this.status({ state: 'waiting', detail: found.wait });
				}
				await sleep(this.lookupIntervalMs, this.signal);
			} catch (err) {
				if (this.signal.aborted) {
					return;
				}
				if (err instanceof NotSignedInError) {
					this.status({ state: 'needsSignIn', detail: err.message });
					return;
				}
				this.options.sink.log(`YouTube: ${String(err)}`);
				this.status({ state: 'error', detail: describe(err) });
				if (!isRetryable(err)) {
					return;
				}
				await sleep(backoffMs(attempt++), this.signal).catch(() => undefined);
			}
		}
	}

	private async getJson<T>(url: string, signal = this.signal): Promise<T> {
		const res = await this.options.auth.fetch(url, { signal });
		if (!res.ok) {
			throw await failure(res);
		}
		return (await res.json()) as T;
	}

	/** A disposed connection stays quiet, so it cannot overwrite the count of its replacement. */
	private viewers(count: number | undefined): void {
		if (!this.signal.aborted) {
			this.options.sink.viewers(this.options.source.id, count);
		}
	}

	/**
	 * Checks on the broadcast whose chat is being read, now and then on a timer, until `signal` aborts.
	 * It reports the viewer count and picks up a renamed title. It calls `onReconnect` when the chat
	 * should be read afresh:
	 * - when the broadcast goes live, because a chat connection opened before then has been seen to
	 *   receive nothing afterwards, where a new connection does;
	 * - on your own channel, when a different broadcast is live, for example when you went live on a
	 *   new one while the chat of an older scheduled one was being read.
	 * This is extra to the chat: a failure here is logged and never interrupts it.
	 */
	private async watchBroadcast(
		videoId: string,
		context: YouTubeMapContext,
		signal: AbortSignal,
		onReconnect: (why: string) => void,
	): Promise<void> {
		// The parts do not change the price: each lookup costs 1 quota unit.
		const url = `${this.apiUrl}/videos?part=snippet&part=liveStreamingDetails&id=${encodeURIComponent(videoId)}`;
		let lastFailure: string | undefined;
		let failures = 0;
		let seenBeforeLive = false;
		while (!signal.aborted) {
			try {
				const data = await this.getJson<VideoResponse>(url, signal);
				if (signal.aborted) {
					return;
				}
				const video = data?.items?.[0];
				// A string of digits; absent when the stream is not live or its owner hides the count.
				const raw = video?.liveStreamingDetails?.concurrentViewers;
				const count = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : undefined;
				this.viewers(count);

				const title = this.labelFor(video?.snippet);
				if (title && title !== context.channelName) {
					context.channelName = title;
					this.status(this.current, title);
				}

				const content = video?.snippet?.liveBroadcastContent;
				if (content === 'upcoming') {
					seenBeforeLive = true;
				} else if (content === 'live' && seenBeforeLive) {
					// A new connection costs 5 units, once per broadcast.
					onReconnect('the broadcast went live');
					return;
				}

				const live = content === 'live' && video?.liveStreamingDetails?.activeLiveChatId === context.liveChatId;
				if (this.options.source.kind !== 'video' && !live) {
					// Costs 1 more unit, and only while the chat being read is not the live one.
					const active = await this.findBroadcast('active', signal);
					if (!signal.aborted && active && active.liveChatId !== context.liveChatId) {
						onReconnect('a different broadcast went live');
						return;
					}
				}
				lastFailure = undefined;
				failures = 0;
			} catch (err) {
				if (signal.aborted) {
					return;
				}
				const text = describe(err);
				if (text !== lastFailure) {
					this.options.sink.log(`YouTube viewer count: ${text}`);
				}
				lastFailure = text;
				if (++failures >= VIEWER_FAILURES_BEFORE_CLEARING) {
					this.viewers(undefined);
				}
			}
			await sleep(this.viewerIntervalMs, signal).catch(() => undefined);
		}
	}

	private async findChat(): Promise<Lookup> {
		const source = this.options.source;
		if (source.kind === 'video') {
			const data = await this.getJson<VideoResponse>(
				`${this.apiUrl}/videos?part=snippet&part=liveStreamingDetails&id=${encodeURIComponent(source.videoId)}`,
			);
			const video = data.items?.[0];
			if (!video) {
				return { ended: 'YouTube has no video with this ID.' };
			}
			const title = this.labelFor(video.snippet) ?? source.videoId;
			const liveChatId = video.liveStreamingDetails?.activeLiveChatId;
			if (liveChatId) {
				return { liveChatId, title, videoId: source.videoId };
			}
			return video.snippet?.liveBroadcastContent === 'upcoming'
				? { wait: 'This stream has no live chat yet. Checking again every minute.' }
				: { ended: 'This video has no active live chat.' };
		}
		return (
			(await this.findBroadcast('active')) ??
			(await this.findBroadcast('upcoming')) ?? { wait: 'No live or upcoming broadcast on your channel. Checking again every minute.' }
		);
	}

	/**
	 * Your own broadcast with the given status that has a chat. Costs 1 quota unit.
	 * When there are several, the one scheduled closest to now wins: scheduled streams that never went
	 * live stay `upcoming`, and the oldest of those is the least likely to be the one you mean.
	 */
	private async findBroadcast(status: 'active' | 'upcoming', signal = this.signal): Promise<Found | undefined> {
		// `broadcastType` defaults to `event`, which leaves out "stream now" broadcasts.
		const data = await this.getJson<{
			// A broadcast's `id` is the ID of the video it plays as.
			items?: { id?: string; snippet?: { liveChatId?: string; title?: string; scheduledStartTime?: string } }[];
		}>(`${this.apiUrl}/liveBroadcasts?part=snippet&part=status&broadcastStatus=${status}&broadcastType=all&maxResults=50`, signal);
		const now = Date.now();
		const distance = (time: string | undefined) => {
			const ms = Date.parse(time ?? '');
			return Number.isNaN(ms) ? Infinity : Math.abs(ms - now);
		};
		const broadcast = (data.items ?? [])
			.filter((item) => item.snippet?.liveChatId)
			.sort((a, b) => distance(a.snippet?.scheduledStartTime) - distance(b.snippet?.scheduledStartTime))[0];
		const snippet = broadcast?.snippet;
		return snippet?.liveChatId ? { liveChatId: snippet.liveChatId, title: snippet.title || 'YouTube', videoId: broadcast.id || undefined } : undefined;
	}

	/** Reads until the chat ends or `signal` aborts. Throws when the platform refuses for good. */
	private async readChat(context: YouTubeMapContext, signal: AbortSignal): Promise<void> {
		this.pageToken = undefined;
		let failures = 0;
		for (;;) {
			signal.throwIfAborted();
			const startedAt = Date.now();
			let ended: boolean;
			try {
				ended = this.options.transport === 'poll' ? await this.pollOnce(context, signal) : await this.readStream(context, signal);
			} catch (err) {
				if (signal.aborted) {
					throw err;
				}
				if (err instanceof YouTubeApiError && err.reason === 'liveChatEnded') {
					return;
				}
				if (err instanceof YouTubeApiError && err.reason === 'pageTokenInvalid' && this.pageToken) {
					this.pageToken = undefined;
					continue;
				}
				if (!isRetryable(err)) {
					throw err;
				}
				this.options.sink.log(`YouTube chat interrupted: ${String(err)}`);
				this.status({ state: 'connecting', detail: 'Reconnecting…' });
				await sleep(backoffMs(failures++), signal);
				continue;
			}
			if (ended) {
				return;
			}
			if (this.options.transport === 'poll') {
				await sleep(Math.max(this.pollMs, 1000), signal);
				continue;
			}
			// The server closed the stream; resume from the last page token. Each connection costs quota,
			// so back off when connections are not staying open.
			failures = Date.now() - startedAt < SHORT_STREAM_MS ? failures + 1 : 0;
			await sleep(failures > 0 ? backoffMs(failures) : 1000, signal);
		}
	}

	private chatQuery(context: YouTubeMapContext): string {
		const params = new URLSearchParams({ liveChatId: context.liveChatId });
		for (const part of ['id', 'snippet', 'authorDetails']) {
			params.append('part', part);
		}
		if (this.pageToken) {
			params.set('pageToken', this.pageToken);
		}
		return params.toString();
	}

	/** Reads one streaming connection until it closes. Returns whether the chat ended. */
	private async readStream(context: YouTubeMapContext, signal: AbortSignal): Promise<boolean> {
		const res = await this.options.auth.fetch(`${this.streamUrl}?${this.chatQuery(context)}`, { signal });
		if (!res.ok || !res.body) {
			throw await failure(res);
		}
		this.status({ state: 'connected' }, context.channelName);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		const parser = new JsonObjectStream();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				return false;
			}
			for (const object of parser.push(decoder.decode(value, { stream: true }))) {
				if (this.handleResponse(object as ChatResponse, context)) {
					await reader.cancel().catch(() => undefined);
					return true;
				}
			}
		}
	}

	private async pollOnce(context: YouTubeMapContext, signal: AbortSignal): Promise<boolean> {
		const response = await this.getJson<ChatResponse>(`${this.apiUrl}/liveChat/messages?${this.chatQuery(context)}`, signal);
		this.status({ state: 'connected' }, context.channelName);
		return this.handleResponse(response, context);
	}

	/** Forwards one page of chat. Returns whether it reported the end of the chat. */
	private handleResponse(response: ChatResponse, context: YouTubeMapContext): boolean {
		if (response.error) {
			throw toApiError(response, response.error.code ?? 500);
		}
		if (response.nextPageToken) {
			this.pageToken = response.nextPageToken;
		}
		if (response.pollingIntervalMillis) {
			this.pollMs = response.pollingIntervalMillis;
		}
		let ended = false;
		for (const item of response.items ?? []) {
			const result = mapYouTubeItem(item, context);
			if (result === 'ended') {
				ended = true;
			} else if (result) {
				this.options.sink.event(result);
			}
		}
		return ended;
	}
}

/** A 401 here has already survived a token refresh, so only signing in again can fix it. */
async function failure(res: Response): Promise<Error> {
	const error = toApiError(await res.json().catch(() => undefined), res.status);
	return res.status === 401 ? new NotSignedInError(`YouTube rejected the session: ${error.message}`) : error;
}

function describe(err: unknown): string {
	if (err instanceof YouTubeApiError) {
		return `${err.message} (${err.reason})`;
	}
	return err instanceof Error ? err.message : String(err);
}
