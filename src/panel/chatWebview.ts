import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { ChatService } from '../chat/chatService';
import { parseModerationRequest } from '../chat/moderation';
import { SourceInfo } from '../chat/types';
import { HostMessage, VIEW_ACTIONS, ViewAction, ViewSettings, WebviewMessage } from './protocol';

function viewSettings(): ViewSettings {
	const config = vscode.workspace.getConfiguration('caerwyn');
	return {
		maxMessages: config.get<number>('maxMessages', 500),
		showTimestamps: config.get<boolean>('showTimestamps', false),
	};
}

export function chatWebviewOptions(context: vscode.ExtensionContext): vscode.WebviewOptions {
	return { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')] };
}

/**
 * Connects one chat webview, whether in an editor tab or the sidebar, to the `ChatService`. The webview only
 * renders; connections and message history live in the service, which keeps reading chat for as long as any
 * webview is attached.
 */
export class ChatWebview implements vscode.Disposable {
	/** How many times a chat webview has loaded its script and asked for state. Lets tests see the webview run. */
	static readyCount = 0;

	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly webview: vscode.Webview,
		context: vscode.ExtensionContext,
		private readonly service: ChatService,
		/** Where the webview is shown. Views in a sidebar or panel sit on that surface's background, not the editor's. */
		private readonly location: 'editor' | 'view',
		/** Called when the chat shows or stops showing simulated sources, so the host can retitle itself. */
		private readonly onSimulatedChanged: (simulated: boolean) => void,
	) {
		webview.html = this.html(context);
		this.disposables.push(
			webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(message)),
			service.onEvents((events) => this.post({ type: 'events', events })),
			service.onSources((sources) => {
				this.updateTitle(sources);
				this.post({ type: 'sources', sources });
			}),
			service.onReset(() => this.post({ type: 'reset' })),
			service.onViewerCounts((viewers) => this.post({ type: 'viewers', viewers })),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('caerwyn')) {
					this.post({ type: 'settings', settings: viewSettings() });
				}
			}),
			service.acquire(),
		);
		this.updateTitle(service.sources);
	}

	dispose(): void {
		// Stop listening before releasing the service: stopping it reports status changes, and the webview is already gone.
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
	}

	/** This view may be on stream, so simulated chat is labelled where it cannot be missed. */
	private updateTitle(sources: SourceInfo[]): void {
		this.onSimulatedChanged(sources.some((info) => info.source.kind === 'simulated'));
	}

	private onMessage(message: WebviewMessage): void {
		// The webview is hidden and rebuilt as it is switched away from; it asks for the current state each time.
		if (message?.type === 'ready') {
			ChatWebview.readyCount++;
			this.post({
				type: 'init',
				messages: this.service.messages,
				sources: this.service.sources,
				viewers: this.service.viewerCounts,
				settings: viewSettings(),
			});
		} else if (message?.type === 'action' && VIEW_ACTIONS.includes(message.action as ViewAction)) {
			void vscode.commands.executeCommand(`caerwyn.${message.action}`);
		} else if (message?.type === 'moderate' && Number.isSafeInteger(message.requestId)) {
			void this.moderate(message.requestId, message.request);
		}
	}

	private async moderate(requestId: number, raw: unknown): Promise<void> {
		const request = parseModerationRequest(raw);
		if (!request) {
			this.post({ type: 'moderationResult', requestId, error: 'Caerwyn did not understand that request.' });
			return;
		}
		try {
			await this.service.moderate(request);
			this.post({ type: 'moderationResult', requestId });
		} catch (error) {
			this.post({ type: 'moderationResult', requestId, error: error instanceof Error ? error.message : String(error) });
		}
	}

	private post(message: HostMessage): void {
		void this.webview.postMessage(message);
	}

	private html(context: vscode.ExtensionContext): string {
		const webview = this.webview;
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
<body class="${this.location}">
	<div id="root"></div>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
	}
}
