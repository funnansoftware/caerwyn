import type { ChatEvent, ChatMessage, SourceInfo } from '../chat/types';

// Messages exchanged between the extension host and the chat webview. The webview imports only types from here.

export interface ViewSettings {
	maxMessages: number;
	showTimestamps: boolean;
}

export type HostMessage =
	| { type: 'init'; messages: readonly ChatMessage[]; sources: SourceInfo[]; settings: ViewSettings }
	| { type: 'events'; events: ChatEvent[] }
	| { type: 'sources'; sources: SourceInfo[] }
	| { type: 'settings'; settings: ViewSettings }
	| { type: 'reset' };

export const VIEW_ACTIONS = ['signInTwitch', 'signInYouTube', 'addTwitchChannel', 'addYouTubeStream', 'reconnect'] as const;
export type ViewAction = (typeof VIEW_ACTIONS)[number];

export type WebviewMessage = { type: 'ready' } | { type: 'action'; action: ViewAction };
