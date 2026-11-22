import type { ModerationRequest } from '../chat/moderation';
import type { ChatEvent, ChatMessage, HistoryPage, HistoryQuery, SourceInfo, ViewerCounts } from '../chat/types';

// Messages exchanged between the extension host and the chat webview. The webview imports only types from here.

export interface ViewSettings {
	maxMessages: number;
	showTimestamps: boolean;
}

export type HostMessage =
	| { type: 'init'; messages: readonly ChatMessage[]; sources: SourceInfo[]; viewers: ViewerCounts; settings: ViewSettings }
	| { type: 'events'; events: ChatEvent[] }
	| { type: 'sources'; sources: SourceInfo[] }
	/** Kept apart from `sources` because it changes far more often, and must not rebuild the source chips. */
	| { type: 'viewers'; viewers: ViewerCounts }
	| { type: 'settings'; settings: ViewSettings }
	| { type: 'reset' }
	/** The outcome of a `moderate` request: no `error` means it was carried out. */
	| { type: 'moderationResult'; requestId: number; error?: string }
	/** The answer to a `history` request. No `page` means it could not be read. */
	| { type: 'historyResult'; requestId: number; page?: HistoryPage };

export const VIEW_ACTIONS = [
	'signInTwitch',
	'signInYouTube',
	'addTwitchChannel',
	'addYouTubeStream',
	'reconnect',
	'toggleSimulation',
] as const;
export type ViewAction = (typeof VIEW_ACTIONS)[number];

export type WebviewMessage =
	| { type: 'ready' }
	| { type: 'action'; action: ViewAction }
	| { type: 'moderate'; requestId: number; request: ModerationRequest }
	/** Asks for a page of one viewer's saved messages, for their user card. */
	| { type: 'history'; requestId: number; query: HistoryQuery };
