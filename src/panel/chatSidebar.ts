import * as vscode from 'vscode';
import { ChatService } from '../chat/chatService';
import { ChatWebview, chatWebviewOptions } from './chatWebview';

export const CHAT_SIDEBAR_VIEW_ID = 'caerwyn.chatView';
const TITLE = 'Chat';

/**
 * The chat in the sidebar (or the secondary sidebar or bottom panel, wherever the user drags the view).
 * It shows the same chat as the editor tab, and either one keeps the connections open.
 */
export class ChatSidebar implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly service: ChatService,
	) {}

	/** Whether the view is on screen. A hidden view still exists and keeps chat flowing. */
	get isVisible(): boolean {
		return this.view?.visible === true;
	}

	/** Brings the sidebar view to the front, opening its container if needed. */
	async reveal(): Promise<void> {
		if (this.view) {
			this.view.show(false);
		} else {
			await vscode.commands.executeCommand(`${CHAT_SIDEBAR_VIEW_ID}.focus`);
		}
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
		view.webview.options = chatWebviewOptions(this.context);
		view.title = TITLE;
		const chat = new ChatWebview(view.webview, this.context, this.service, (simulated) => {
			view.description = simulated ? 'Simulated' : undefined;
		});
		// The view is disposed when the user removes it; merely hiding it keeps chat flowing, like a background tab.
		view.onDidDispose(() => {
			chat.dispose();
			if (this.view === view) {
				this.view = undefined;
			}
		});
	}
}
