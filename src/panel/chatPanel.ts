import * as vscode from 'vscode';
import { ChatService } from '../chat/chatService';
import { ChatWebview, chatWebviewOptions } from './chatWebview';

export const CHAT_VIEW_TYPE = 'caerwyn.chat';

/**
 * The chat tab: a webview panel in the editor area, so it can be split, moved and saved in layouts
 * like any other editor.
 */
export class ChatPanel {
	private static current: ChatPanel | undefined;

	static get isOpen(): boolean {
		return ChatPanel.current !== undefined;
	}

	static show(context: vscode.ExtensionContext, service: ChatService): void {
		if (ChatPanel.current) {
			ChatPanel.current.panel.reveal();
			return;
		}
		const panel = vscode.window.createWebviewPanel(CHAT_VIEW_TYPE, 'Caerwyn Chat', vscode.ViewColumn.Active, chatWebviewOptions(context));
		ChatPanel.current = new ChatPanel(panel, context, service);
	}

	/** Reattaches to a chat tab that VS Code restored from a previous session. */
	static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, service: ChatService): void {
		if (ChatPanel.current) {
			panel.dispose();
			return;
		}
		panel.webview.options = chatWebviewOptions(context);
		ChatPanel.current = new ChatPanel(panel, context, service);
	}

	private readonly chat: ChatWebview;
	private readonly disposable: vscode.Disposable;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		context: vscode.ExtensionContext,
		service: ChatService,
	) {
		this.chat = new ChatWebview(panel.webview, context, service, (simulated) => {
			panel.title = simulated ? 'Caerwyn Chat (Simulated)' : 'Caerwyn Chat';
		});
		this.disposable = panel.onDidDispose(() => this.dispose());
	}

	private dispose(): void {
		ChatPanel.current = undefined;
		this.chat.dispose();
		this.disposable.dispose();
	}
}
