import type { ChatMessage } from '../chat/types';
import { Disposable } from '../util/emitter';
import { AUDIENCE_TEXT, ControlReport } from './chatControls';

// Answers viewers in chat: what `!help` says, and why a command did not run. Replies are sent from the user's own
// account, so what they say is built only from fixed wording and text a command marked as safe for chat, never
// from anything a viewer typed: otherwise `!theme <a slur>` would have the user's account repeat it.
// Free of `vscode` imports.

/** `off`: nothing is said. `problems`: answers and why a command did not run. `all`: also what a command did. */
export const REPLY_MODES = ['off', 'problems', 'all'] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

/** Whether a reply can be sent in the chat a message came from. */
export type ReplyReadiness = 'ready' | 'needsSignIn' | 'unsupported';

export interface ChatRepliesOptions {
	/** The chat controls' `onReport`. */
	onReport(listener: (report: ControlReport) => void): Disposable;
	getMode(): unknown;
	/** Checked before every send, without contacting the platform. */
	readiness(message: ChatMessage): ReplyReadiness | Promise<ReplyReadiness>;
	/** Sends `text` as a reply to `message`. */
	send(message: ChatMessage, text: string): Promise<void>;
	/** Replies need a permission the user has not granted. Called for each reply that could not be sent. */
	onNeedsSignIn(): void;
	log(message: string): void;
	now?: () => number;
}

/** Marks Caerwyn's replies, so viewers can tell them from the user typing. */
export const REPLY_PREFIX = '🤖 (caerwyn) ';
/** Twitch's limit is 500 characters; this leaves room for the prefix and stays readable. */
export const MAX_REPLY = 450;
/** At most this many replies in `BUDGET_WINDOW_MS`, well under Twitch's limits. More are dropped, not queued. */
export const REPLY_BUDGET = 6;
const BUDGET_WINDOW_MS = 30_000;
/** At most one reply about a problem to each viewer this often, however often they retry. */
const PROBLEM_WINDOW_MS = 30_000;
/** "Chat commands are paused" is said at most this often, to everyone together. */
const PAUSED_WINDOW_MS = 60_000;

export class ChatReplies implements Disposable {
	private readonly now: () => number;
	private readonly subscription: Disposable;
	private readonly sent: number[] = [];
	private readonly lastProblem = new Map<string, number>();
	private lastPaused = -Infinity;
	private budgetLogged = false;

	constructor(private readonly options: ChatRepliesOptions) {
		this.now = options.now ?? Date.now;
		this.subscription = options.onReport((report) => this.onReport(report));
	}

	get mode(): ReplyMode {
		const mode = this.options.getMode();
		// Anything but the two exact values that switch replies on keeps them off: they speak for the user.
		return mode === 'problems' || mode === 'all' ? mode : 'off';
	}

	dispose(): void {
		this.subscription.dispose();
	}

	private onReport(report: ControlReport): void {
		const mode = this.mode;
		if (mode === 'off') {
			return;
		}
		const reply = compose(report, mode);
		if (!reply) {
			return;
		}
		const now = this.now();
		const viewer = `${report.message.platform}:${report.message.author.id}`;
		if (reply.kind === 'problem') {
			// Checked before the shared budget, so one viewer retrying cannot use it all up.
			if (now - (this.lastProblem.get(viewer) ?? -Infinity) < PROBLEM_WINDOW_MS) {
				return;
			}
			if (report.outcome === 'paused') {
				if (now - this.lastPaused < PAUSED_WINDOW_MS) {
					return;
				}
				this.lastPaused = now;
			}
			this.lastProblem.set(viewer, now);
			this.prune(now);
		}
		while (this.sent.length > 0 && now - this.sent[0] >= BUDGET_WINDOW_MS) {
			this.sent.shift();
		}
		if (this.sent.length >= REPLY_BUDGET) {
			if (!this.budgetLogged) {
				this.budgetLogged = true;
				this.options.log(`Chat replies: more than ${REPLY_BUDGET} in ${BUDGET_WINDOW_MS / 1000}s, so some are not sent.`);
			}
			return;
		}
		this.budgetLogged = false;
		this.sent.push(now);
		void this.send(report.message, reply.text, now);
	}

	private async send(message: ChatMessage, text: string, slot: number): Promise<void> {
		try {
			const readiness = await this.options.readiness(message);
			if (readiness !== 'ready') {
				// Nothing goes out, so the slot is free for a reply that can.
				const index = this.sent.lastIndexOf(slot);
				if (index >= 0) {
					this.sent.splice(index, 1);
				}
				if (readiness === 'needsSignIn') {
					this.options.onNeedsSignIn();
				}
				return; // `unsupported`: such as YouTube, for now. The chat view still shows the outcome.
			}
			await this.options.send(message, text);
		} catch (error) {
			this.options.log(`Chat reply not sent: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private prune(now: number): void {
		if (this.lastProblem.size < 500) {
			return;
		}
		for (const [viewer, at] of this.lastProblem) {
			if (now - at >= PROBLEM_WINDOW_MS) {
				this.lastProblem.delete(viewer);
			}
		}
	}
}

/**
 * What to say in chat about a report, if anything. Built only from the command's name, structured fields and text
 * the command marked as safe for chat; `detail` and the viewer's message are never used.
 */
export function compose(report: ControlReport, mode: Exclude<ReplyMode, 'off'>): { text: string; kind: 'answer' | 'confirmation' | 'problem' } | undefined {
	const name = `!${report.command}`;
	let text: string | undefined;
	let kind: 'answer' | 'confirmation' | 'problem' = 'problem';
	switch (report.outcome) {
		case 'ran':
			if (report.chat?.kind === 'answer' || (report.chat?.kind === 'confirmation' && mode === 'all')) {
				text = report.chat.text;
				kind = report.chat.kind;
			}
			break;
		case 'rejected':
			text = report.chat?.kind === 'problem' ? report.chat.text : `${name} could not do that.`;
			break;
		case 'failed':
			text = `${name} did not work this time.`;
			break;
		case 'denied':
			text = report.audience ? `${name} is ${AUDIENCE_TEXT[report.audience]}.` : `${name} is not available to you.`;
			break;
		case 'cooldown':
			text =
				report.retryInSeconds !== undefined && Number.isFinite(report.retryInSeconds)
					? `${name} is cooling down. Try again in ${Math.max(1, Math.round(report.retryInSeconds))}s.`
					: `${name} is cooling down. Try again soon.`;
			break;
		case 'paused':
			text = 'Chat commands are paused right now.';
			break;
		// Nothing to say: `off` and `disabled` mean the user does not want Caerwyn answering, the rest are quiet.
		default:
			return undefined;
	}
	if (!text) {
		return undefined;
	}
	return { text: limit(`${REPLY_PREFIX}${text}`), kind };
}

function limit(text: string): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > MAX_REPLY ? `${flat.slice(0, MAX_REPLY - 1)}…` : flat;
}
