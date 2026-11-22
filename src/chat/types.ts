// Platform-neutral chat model shared by the extension host and the webview.
// This file must stay free of `vscode` and Node imports: the webview bundle imports its types.

export type Platform = 'twitch' | 'youtube';

export type TwitchSource =
	| { id: string; platform: 'twitch'; kind: 'self' }
	| { id: string; platform: 'twitch'; kind: 'channel'; login: string };

export type YouTubeSource =
	| { id: string; platform: 'youtube'; kind: 'self' }
	| { id: string; platform: 'youtube'; kind: 'video'; videoId: string };

/** A chat room the user wants to read. `self` means the signed-in account's own channel or broadcast. */
export type RealSource = TwitchSource | YouTubeSource;

/** A made-up chat room fed by the simulator, for developing features without signing in. */
export interface SimulatedSource {
	id: string;
	platform: Platform;
	kind: 'simulated';
}

export type ChatSource = RealSource | SimulatedSource;

export const TWITCH_SELF: TwitchSource = { id: 'twitch:me', platform: 'twitch', kind: 'self' };
export const YOUTUBE_SELF: YouTubeSource = { id: 'youtube:me', platform: 'youtube', kind: 'self' };

export function twitchChannelSource(login: string): TwitchSource {
	return { id: `twitch:${login}`, platform: 'twitch', kind: 'channel', login };
}

export function youtubeVideoSource(videoId: string): YouTubeSource {
	return { id: `youtube:${videoId}`, platform: 'youtube', kind: 'video', videoId };
}

export type Fragment =
	| { type: 'text'; text: string }
	| { type: 'mention'; text: string }
	| { type: 'emote'; text: string; url: string };

export type Role = 'broadcaster' | 'moderator' | 'vip' | 'subscriber' | 'verified';

/** Where a message AutoMod held for review stands. */
export type HeldState = 'held' | 'allowed' | 'denied' | 'expired';

export interface HeldMessage {
	/** The platform's ID for the held message, which allowing or denying it needs. */
	messageId: string;
	state: HeldState;
	/**
	 * What the viewer wrote. Kept apart from `ChatMessage.fragments` so that nothing shows it unless the reader
	 * asks to: it is what AutoMod caught, and the chat may be on stream.
	 */
	fragments: Fragment[];
}

/** A badge picture shown before the author's name, such as a Twitch subscriber or event badge. */
export interface Badge {
	/** The platform's name for it, shown on hover. */
	title: string;
	url: string;
	/** The role this badge stands for, if any, so the view does not also show that role as a label. */
	role?: Role;
}

export interface ChatAuthor {
	/** Platform user ID (Twitch user ID, YouTube channel ID). Needed later for moderation actions. */
	id: string;
	login?: string;
	name: string;
	/** `#RRGGBB`, when the platform provides one. */
	color?: string;
	avatarUrl?: string;
	roles: Role[];
	/** Badge pictures, in the platform's order. Absent when the platform sent none the extension could show. */
	badges?: Badge[];
}

/** What a viewer spent: Twitch channel points or Bits. `amount` is absent when the platform has not said how much. */
export interface Spent {
	currency: 'points' | 'bits';
	amount?: number;
}

export interface ChatMessage {
	/** Unique across platforms: `<platform>:<platform message id>`. */
	key: string;
	platform: Platform;
	/** The platform's own message ID. */
	id: string;
	sourceId: string;
	/** Twitch broadcaster user ID, or YouTube live chat ID. */
	channelId: string;
	channelName: string;
	author: ChatAuthor;
	fragments: Fragment[];
	/** Milliseconds since the Unix epoch. */
	timestamp: number;
	/** System text for non-plain messages: subscriptions, raids, Super Chats and so on. */
	headline?: string;
	/** What was spent on this message or reward, in order, each shown as its icon and amount after the headline. */
	spent?: Spent[];
	/** The viewer paid to make this message stand out, such as Twitch's "Highlight My Message". */
	highlighted?: boolean;
	/** Set on a message AutoMod held for review, rather than one in chat. */
	held?: HeldMessage;
	/** A `/me` style message. */
	action?: boolean;
	replyTo?: { name: string; text: string };
}

export type ChatEvent =
	| { type: 'message'; message: ChatMessage }
	/** A message already sent has changed, such as when what it cost arrives after it. Replaces it by `key`. */
	| { type: 'update'; message: ChatMessage }
	/** One message was removed by a moderator or its author. */
	| { type: 'delete'; key: string }
	/** All of one user's messages were removed (ban or timeout). */
	| { type: 'purge'; platform: Platform; channelId: string; userId: string }
	/** The whole chat room was cleared. */
	| { type: 'clear'; platform: Platform; channelId: string };

export type SourceState = 'idle' | 'connecting' | 'connected' | 'waiting' | 'ended' | 'needsSignIn' | 'error';

export interface SourceStatus {
	state: SourceState;
	detail?: string;
}

export interface SourceInfo {
	source: ChatSource;
	label: string;
	status: SourceStatus;
	/** Whether the view can delete messages and time out or ban users in this source. */
	canModerate: boolean;
}

/** How many people are watching each source's stream, by source ID. A source that is not live, or hides its count, is absent. */
export type ViewerCounts = Record<string, number>;

/** Where chat connections report what happens. */
export interface ChatSink {
	event(event: ChatEvent): void;
	status(sourceId: string, status: SourceStatus, label?: string): void;
	/** The stream's current audience; `undefined` when it is not live or the platform does not say. */
	viewers(sourceId: string, count: number | undefined): void;
	log(message: string): void;
}

/** The signed-in account for one platform. */
export interface Account {
	id: string;
	label: string;
}

/** What a chat connection needs from a signed-in session. Calls throw `NotSignedInError` when there is none. */
export interface ChatAuth {
	getAccount(): Promise<Account | undefined>;
	/** Checks the access token with the platform and refreshes it if it is no longer valid. */
	ensureValid(): Promise<void>;
	/** `fetch` with the session's credentials; refreshes the token and retries once on HTTP 401. */
	fetch(url: string, init?: RequestInit): Promise<Response>;
}

export class NotSignedInError extends Error {
	constructor(message = 'Not signed in') {
		super(message);
		this.name = 'NotSignedInError';
	}
}
