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

type Lookup = { liveChatId: string; title: string } | { wait: string } | { ended: string };

export class YouTubeChat {
	private readonly abort = new AbortController();
	private readonly apiUrl: string;
	private readonly streamUrl: string;
	private readonly lookupIntervalMs: number;
	private pageToken: string | undefined;
	private pollMs = 5000;

	constructor(private readonly options: YouTubeChatOptions) {
		this.apiUrl = options.apiUrl ?? DEFAULT_API_URL;
		this.streamUrl = options.streamUrl ?? DEFAULT_STREAM_URL;
		this.lookupIntervalMs = options.lookupIntervalMs ?? 60_000;
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
			this.options.sink.status(this.options.source.id, status, label);
		}
	}

	private async run(): Promise<void> {
		let attempt = 0;
		this.status({ state: 'connecting' });
		while (!this.signal.aborted) {
			try {
				const found = await this.findChat();
				if ('liveChatId' in found) {
					attempt = 0;
					await this.readChat(found.liveChatId, found.title);
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

	private async getJson<T>(url: string): Promise<T> {
		const res = await this.options.auth.fetch(url, { signal: this.signal });
		if (!res.ok) {
			throw await failure(res);
		}
		return (await res.json()) as T;
	}

	private async findChat(): Promise<Lookup> {
		const source = this.options.source;
		if (source.kind === 'video') {
			const data = await this.getJson<{
				items?: {
					snippet?: { channelTitle?: string; title?: string; liveBroadcastContent?: string };
					liveStreamingDetails?: { activeLiveChatId?: string };
				}[];
			}>(`${this.apiUrl}/videos?part=snippet&part=liveStreamingDetails&id=${encodeURIComponent(source.videoId)}`);
			const video = data.items?.[0];
			if (!video) {
				return { ended: 'YouTube has no video with this ID.' };
			}
			const title = video.snippet?.channelTitle || video.snippet?.title || source.videoId;
			const liveChatId = video.liveStreamingDetails?.activeLiveChatId;
			if (liveChatId) {
				return { liveChatId, title };
			}
			return video.snippet?.liveBroadcastContent === 'upcoming'
				? { wait: 'This stream has no live chat yet. Checking again every minute.' }
				: { ended: 'This video has no active live chat.' };
		}
		// `broadcastType` defaults to `event`, which leaves out "stream now" broadcasts.
		for (const status of ['active', 'upcoming']) {
			const data = await this.getJson<{
				items?: { snippet?: { liveChatId?: string; title?: string; scheduledStartTime?: string } }[];
			}>(`${this.apiUrl}/liveBroadcasts?part=snippet&part=status&broadcastStatus=${status}&broadcastType=all&maxResults=50`);
			const broadcasts = (data.items ?? [])
				.filter((item) => item.snippet?.liveChatId)
				.sort((a, b) => (a.snippet?.scheduledStartTime ?? '').localeCompare(b.snippet?.scheduledStartTime ?? ''));
			const snippet = broadcasts[0]?.snippet;
			if (snippet?.liveChatId) {
				return { liveChatId: snippet.liveChatId, title: snippet.title || 'YouTube' };
			}
		}
		return { wait: 'No live or upcoming broadcast on your channel. Checking again every minute.' };
	}

	/** Reads until the chat ends. Throws when the platform refuses for good. */
	private async readChat(liveChatId: string, title: string): Promise<void> {
		const context: YouTubeMapContext = { sourceId: this.options.source.id, liveChatId, channelName: title };
		this.pageToken = undefined;
		let failures = 0;
		for (;;) {
			this.signal.throwIfAborted();
			const startedAt = Date.now();
			let ended: boolean;
			try {
				ended = this.options.transport === 'poll' ? await this.pollOnce(context) : await this.readStream(context);
			} catch (err) {
				if (this.signal.aborted) {
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
				await sleep(backoffMs(failures++), this.signal);
				continue;
			}
			if (ended) {
				return;
			}
			if (this.options.transport === 'poll') {
				await sleep(Math.max(this.pollMs, 1000), this.signal);
				continue;
			}
			// The server closed the stream; resume from the last page token. Each connection costs quota,
			// so back off when connections are not staying open.
			failures = Date.now() - startedAt < SHORT_STREAM_MS ? failures + 1 : 0;
			await sleep(failures > 0 ? backoffMs(failures) : 1000, this.signal);
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
	private async readStream(context: YouTubeMapContext): Promise<boolean> {
		const res = await this.options.auth.fetch(`${this.streamUrl}?${this.chatQuery(context)}`, { signal: this.signal });
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

	private async pollOnce(context: YouTubeMapContext): Promise<boolean> {
		const response = await this.getJson<ChatResponse>(`${this.apiUrl}/liveChat/messages?${this.chatQuery(context)}`);
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
