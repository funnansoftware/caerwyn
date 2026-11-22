import * as vscode from 'vscode';
import type { ChatService } from '../chat/chatService';
import { ChatControls, ControlReport } from './chatControls';

/** How long the status bar shows the last command a viewer ran. */
const FLASH_MS = 4000;
const MAX_NAME = 24;

/** A viewer's name, safe for status bar text: names are free text on YouTube, and `$(…)` would draw an icon. */
function plainName(name: string): string {
	const plain = name.replace(/\$\(/g, '(').replace(/\s+/g, ' ');
	return plain.length > MAX_NAME ? `${plain.slice(0, MAX_NAME - 1)}…` : plain;
}

/**
 * Shows whether chat can control the editor, and pauses or resumes it when clicked.
 * Hidden while chat controls are switched off in settings.
 */
export class ControlsStatusBar implements vscode.Disposable {
	private readonly item = vscode.window.createStatusBarItem('caerwyn.controls', vscode.StatusBarAlignment.Left, 100);
	private readonly subscriptions: { dispose(): void }[];
	private flash: { text: string; timer: NodeJS.Timeout } | undefined;

	constructor(
		private readonly controls: ChatControls,
		private readonly service: ChatService,
	) {
		this.item.name = 'Caerwyn Chat Controls';
		this.item.command = 'caerwyn.toggleChatControls';
		this.subscriptions = [
			controls.onDidChangeState(() => this.update()),
			controls.onReport((report) => this.onReport(report)),
			// Chat is only read while a chat view is open, so whether commands can arrive follows the sources.
			service.onSources(() => this.update()),
		];
		this.update();
	}

	dispose(): void {
		clearTimeout(this.flash?.timer);
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.item.dispose();
	}

	private onReport(report: ControlReport): void {
		if (report.outcome !== 'ran' && report.outcome !== 'accepted') {
			return;
		}
		clearTimeout(this.flash?.timer);
		const verb = report.outcome === 'ran' ? '' : ' (waiting)';
		this.flash = {
			text: `$(broadcast) !${report.command} · ${plainName(report.message.author.name)}${verb}`,
			timer: setTimeout(() => {
				this.flash = undefined;
				this.update();
			}, FLASH_MS),
		};
		this.update();
	}

	private update(): void {
		const { controls } = this;
		if (!controls.enabled) {
			this.item.hide();
			return;
		}
		const listening = this.service.sources.some((info) => this.service.isOwnSource(info.source.id) && info.status.state === 'connected');
		const tooltip = new vscode.MarkdownString(undefined, true);
		if (controls.paused) {
			this.item.text = '$(debug-pause) Chat controls paused';
			this.item.backgroundColor = undefined;
			tooltip.appendMarkdown('Chat commands are ignored until you resume. Click to resume.');
		} else {
			this.item.text = this.flash?.text ?? (listening ? '$(broadcast) Chat controls' : '$(broadcast) Chat controls (idle)');
			// Chat can change the editor: make that hard to miss.
			this.item.backgroundColor = listening ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
			tooltip.appendMarkdown(
				listening
					? 'Viewers in your own chat can run the commands below. Click to pause.'
					: 'No chat of your own is connected, so no commands can arrive. Open the chat to start listening. Click to pause.',
			);
		}
		const commands = controls.registered;
		tooltip.appendMarkdown('\n\n');
		if (commands.length === 0) {
			tooltip.appendMarkdown('_No chat commands are available yet._');
		} else {
			for (const command of commands) {
				tooltip.appendMarkdown(`- \`!${command.name}\` ${command.description}\n`);
			}
		}
		this.item.tooltip = tooltip;
		this.item.show();
	}
}
