import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { ChatService } from '../chat/chatService';
import { HostMessage, VIEW_ACTIONS, ViewAction, ViewSettings, WebviewMessage } from './protocol';

export const CHAT_VIEW_TYPE = 'caerwyn.chat';

function viewSettings(): ViewSettings {
	const config = vscode.workspace.getConfiguration('caerwyn');
	return {
		maxMessages: config.get<number>('maxMessages', 500),
		showTimestamps: config.get<boolean>('showTimestamps', false),
	};
}

/**
 * The chat tab: a webview panel in the editor area, so it can be split, moved and saved in layouts
 * like any other editor. The webview only renders; connections and message history live in `ChatService`.
 */
export class ChatPanel {
	private static current: ChatPanel | undefined;
	/** How many times a chat webview has loaded its script and asked for state. Lets tests see the webview run. */
	static readyCount = 0;

	static get isOpen(): boolean {
		return ChatPanel.current !== undefined;
	}

	static show(context: vscode.ExtensionContext, service: ChatService): void {
		if (ChatPanel.current) {
			ChatPanel.current.panel.reveal();
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			CHAT_VIEW_TYPE,
			'Caerwyn Chat',
			vscode.ViewColumn.Active,
			ChatPanel.webviewOptions(context),
		);
		ChatPanel.current = new ChatPanel(panel, context, service);
	}

	/** Reattaches to a chat tab that VS Code restored from a previous session. */
	static revive(panel: vscode.WebviewPanel, context: vscode.ExtensionContext, service: ChatService): void {
		if (ChatPanel.current) {
			panel.dispose();
			return;
		}
		panel.webview.options = ChatPanel.webviewOptions(context);
		ChatPanel.current = new ChatPanel(panel, context, service);
	}

	private static webviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
		return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] };
	}

	private readonly disposables: vscode.Disposable[] = [];

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		context: vscode.ExtensionContext,
		private readonly service: ChatService,
	) {
		panel.webview.html = this.html(context);
		this.disposables.push(
			panel.webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(message)),
			service.onEvents((events) => this.post({ type: 'events', events })),
			service.onSources((sources) => this.post({ type: 'sources', sources })),
			service.onReset(() => this.post({ type: 'reset' })),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('caerwyn')) {
					this.post({ type: 'settings', settings: viewSettings() });
				}
			}),
			panel.onDidDispose(() => this.dispose()),
		);
		service.start();
	}

	private onMessage(message: WebviewMessage): void {
		// The webview is hidden and rebuilt as its tab is switched; it asks for the current state each time.
		if (message?.type === 'ready') {
			ChatPanel.readyCount++;
			this.post({ type: 'init', messages: this.service.messages, sources: this.service.sources, settings: viewSettings() });
		} else if (message?.type === 'action' && VIEW_ACTIONS.includes(message.action as ViewAction)) {
			void vscode.commands.executeCommand(`caerwyn.${message.action}`);
		}
	}

	private post(message: HostMessage): void {
		void this.panel.webview.postMessage(message);
	}

	private dispose(): void {
		ChatPanel.current = undefined;
		// Stop listening first: stopping the service reports status changes, and the webview is already gone.
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
		this.service.stop();
	}

	private html(context: vscode.ExtensionContext): string {
		const webview = this.panel.webview;
		const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
		const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
		const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
		const nonce = randomBytes(16).toString('base64');
		// Chat text is untrusted: no inline scripts, and images only from Twitch's emote CDN.
		const csp = [
			`default-src 'none'`,
			`img-src https://static-cdn.jtvnw.net`,
			`style-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${style}">
	<title>Caerwyn Chat</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}
