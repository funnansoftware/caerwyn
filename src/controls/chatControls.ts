import type { StateStore } from '../chat/chatService';
import type { ChatEvent, ChatMessage, CommandFeedback, Role } from '../chat/types';
import { Disposable, Emitter } from '../util/emitter';

// Lets viewers in the user's own chat run commands such as `!theme dracula` that change the editor.
// Everything a command must pass before it runs lives here: who may use it, how often, a delay that gives
// moderators time to remove the message, and a pause switch. The commands themselves register with `register()`.
// Free of `vscode` imports, so it can be tested like the chat service.

/** Who may use a command. Each level includes the ones above it in this list's reverse order. */
export const AUDIENCES = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'] as const;
export type Audience = (typeof AUDIENCES)[number];

/** Each role's place in `AUDIENCES`. Roles not listed, such as `verified`, count as everyone. */
/** Who may use a command, as said to the user. */
const AUDIENCE_TEXT: Record<Audience, string> = {
	everyone: 'for everyone',
	subscriber: 'for subscribers and up',
	vip: 'for VIPs and up',
	moderator: 'for moderators and the streamer',
	broadcaster: 'only for the streamer',
};

const ROLE_RANK: Partial<Record<Role, number>> = { subscriber: 1, vip: 2, moderator: 3, broadcaster: 4 };
const MODERATOR_RANK = 3;

/** Defaults a command comes with. The user can change each in `caerwyn.controls.commands`. */
export interface CommandDefaults {
	allowed: Audience;
	/** Seconds after anyone uses the command before anyone can use it again. */
	cooldownSeconds: number;
	/** Seconds after a viewer uses the command before that viewer can use it again. */
	userCooldownSeconds: number;
}

export interface ChatCommandInvocation {
	/** The command's name, even when a viewer typed an alias. */
	command: string;
	/** What followed the command word, trimmed. Untrusted viewer text. */
	args: string;
	message: ChatMessage;
}

export interface ChatCommand {
	/** Typed after `!`. Lower case letters, digits, `-` and `_`. */
	name: string;
	aliases?: string[];
	/** One line for the user, shown in the status bar tooltip. */
	description: string;
	defaults: CommandDefaults;
	/** Carries out the command. It may return a few words on what it did, shown under the message, such as "Monokai for 5 min". */
	run(invocation: ChatCommandInvocation): void | string | Promise<void | string>;
}

/** The user's overrides for one command, from settings. */
export interface CommandSettings {
	enabled?: boolean;
	allowed?: Audience;
	cooldownSeconds?: number;
	userCooldownSeconds?: number;
}

export interface ChatControlsConfig {
	enabled: boolean;
	/** Seconds to hold a viewer's command before running it, so a moderator can remove it first. */
	delaySeconds: number;
	commands: Record<string, CommandSettings>;
}

export type ControlOutcome =
	/** Waiting out the delay. */
	| 'accepted'
	| 'ran'
	/** The command turned the request down, such as an unknown theme name. Its cooldowns are not charged. */
	| 'rejected'
	/** The command threw. Its cooldowns are not charged. */
	| 'failed'
	/** Chat controls are switched off, so nothing runs. */
	| 'off'
	/** The command is switched off in settings. */
	| 'disabled'
	| 'paused'
	/** The viewer's roles do not allow it. */
	| 'denied'
	| 'cooldown'
	/** Removed by a moderator during the delay, or dropped because controls were paused or switched off. */
	| 'cancelled'
	/** Too many commands already waiting. */
	| 'busy'
	/** Too old to act on: chat history replayed on reconnect, or a clock far out. */
	| 'stale';

export interface ControlReport {
	command: string;
	message: ChatMessage;
	outcome: ControlOutcome;
	detail?: string;
}

export interface ChatControlsOptions {
	/** The chat service's `onEvents`. */
	onEvents(listener: (events: ChatEvent[]) => void): Disposable;
	/** Whether a source is the user's own chat. Commands from chats the user only reads are ignored. */
	isOwnSource(sourceId: string): boolean;
	getConfig(): ChatControlsConfig;
	/** Where the pause switch is kept, so it survives a reload. */
	state: StateStore;
	log(message: string): void;
	now?: () => number;
}

/**
 * What a command throws to turn down a request it cannot carry out, such as a theme that is not installed.
 * Unlike any other error, it is not a fault: the viewer's cooldowns are given back, so a typo does not cost them.
 */
export class CommandRejected extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'CommandRejected';
	}
}

const PAUSED_KEY = 'caerwyn.controls.paused';
const DEFAULT_DELAY_SECONDS = 5;
const COMMAND = /^!([a-z0-9][a-z0-9_-]{0,31})(?:\s+([\s\S]*))?$/i;
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_AGE_MS = 60_000;
const MAX_DELAY_SECONDS = 60;
const MAX_PENDING = 20;
/** When the cooldown table grows past this, entries older than any sensible cooldown are dropped. */
const COOLDOWN_PRUNE_SIZE = 1000;
const COOLDOWN_PRUNE_AGE_MS = 60 * 60_000;

/** A cooldown charged for an invocation, with what it was before, so it can be given back. */
type Charge = [key: string, previous: number | undefined, charged: number];

interface Pending {
	timer: NodeJS.Timeout;
	command: ChatCommand;
	invocation: ChatCommandInvocation;
}

export class ChatControls {
	private readonly commands = new Map<string, ChatCommand>();
	private readonly lastUsed = new Map<string, number>();
	private readonly pending = new Map<string, Pending>();
	private readonly reportEmitter = new Emitter<ControlReport>();
	private readonly stateEmitter = new Emitter<void>();
	/** Every recognised command and what became of it. */
	readonly onReport = this.reportEmitter.event;
	/**
	 * Fires when controls are paused, resumed, switched on or off, or a command is added or removed.
	 * Commands that leave something behind, such as a changed theme, listen to undo it when controls stop.
	 */
	readonly onDidChangeState = this.stateEmitter.event;
	private readonly now: () => number;
	private readonly subscription: Disposable;
	private wasEnabled: boolean;

	constructor(private readonly options: ChatControlsOptions) {
		this.now = options.now ?? Date.now;
		this.wasEnabled = this.config().enabled;
		this.subscription = options.onEvents((events) => this.onEvents(events));
	}

	get enabled(): boolean {
		return this.config().enabled;
	}

	/** Read from the store each time, so pausing in one window also stops another that shares it. */
	get paused(): boolean {
		return this.options.state.get<boolean>(PAUSED_KEY) === true;
	}

	/** Whether commands are being taken: switched on and not paused. */
	get active(): boolean {
		return this.enabled && !this.paused;
	}

	/** The registered commands, in the order they were added. */
	get registered(): readonly ChatCommand[] {
		return [...new Set(this.commands.values())];
	}

	/** Whether a name or alias, without the `!`, is a registered command. */
	isRegistered(name: string): boolean {
		return this.commands.has(name.toLowerCase());
	}

	register(command: ChatCommand): Disposable {
		const names = [command.name, ...(command.aliases ?? [])].map((name) => name.toLowerCase());
		for (const name of names) {
			if (!NAME.test(name)) {
				throw new Error(`"${name}" cannot be a chat command name.`);
			}
			if (this.commands.has(name)) {
				throw new Error(`The chat command "${name}" is already registered.`);
			}
		}
		for (const name of names) {
			this.commands.set(name, command);
		}
		this.stateEmitter.fire();
		return {
			dispose: () => {
				for (const name of names) {
					if (this.commands.get(name) === command) {
						this.commands.delete(name);
					}
				}
				this.cancelWhere((entry) => entry.command === command);
				this.stateEmitter.fire();
			},
		};
	}

	async setPaused(paused: boolean): Promise<void> {
		if (paused === this.paused) {
			return;
		}
		// The store takes the value at once; the promise is for writing it to disk.
		const saved = this.options.state.update(PAUSED_KEY, paused);
		if (paused) {
			this.cancelWhere(() => true);
		}
		this.options.log(paused ? 'Chat controls paused.' : 'Chat controls resumed.');
		this.stateEmitter.fire();
		await saved;
	}

	/** Picks up a change to the settings. Switching controls off drops the commands still waiting. */
	refreshConfig(): void {
		const enabled = this.enabled;
		if (enabled === this.wasEnabled) {
			return;
		}
		this.wasEnabled = enabled;
		if (!enabled) {
			this.cancelWhere(() => true);
		}
		this.stateEmitter.fire();
	}

	dispose(): void {
		this.subscription.dispose();
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
		}
		this.pending.clear();
		this.reportEmitter.dispose();
		this.stateEmitter.dispose();
	}

	private onEvents(events: ChatEvent[]): void {
		// The chat view listens to the same events: nothing here may stop them reaching it.
		for (const event of events) {
			try {
				this.onEvent(event);
			} catch (error) {
				this.options.log(`Chat controls: ${describe(error)}`);
			}
		}
	}

	private onEvent(event: ChatEvent): void {
		switch (event.type) {
			case 'message':
				this.onMessage(event.message);
				return;
			case 'delete':
				this.cancelWhere((entry) => entry.invocation.message.key === event.key);
				return;
			case 'purge':
				this.cancelWhere(({ invocation: { message } }) =>
					message.platform === event.platform && message.channelId === event.channelId && message.author.id === event.userId,
				);
				return;
			case 'clear':
				this.cancelWhere(({ invocation: { message } }) => message.platform === event.platform && message.channelId === event.channelId);
				return;
		}
	}

	private onMessage(message: ChatMessage): void {
		if (message.held || !message.author.id || !this.options.isOwnSource(message.sourceId)) {
			return;
		}
		const parsed = parseCommand(message);
		const command = parsed && this.commands.get(parsed.name);
		if (!parsed || !command) {
			return; // Not for us: chats are full of commands for other bots.
		}
		const invocation: ChatCommandInvocation = { command: command.name, args: parsed.args, message };
		const report = (outcome: ControlOutcome, detail?: string) => this.report(invocation, outcome, detail);
		if (!this.enabled) {
			// Said rather than ignored, so the user can tell why a viewer's command did nothing.
			report('off');
			return;
		}

		const now = this.now();
		if (now - message.timestamp > MAX_AGE_MS) {
			report('stale', `sent ${Math.round((now - message.timestamp) / 1000)}s ago`);
			return;
		}
		const settings = this.settingsFor(command);
		if (!settings.enabled) {
			report('disabled');
			return;
		}
		if (this.paused) {
			report('paused');
			return;
		}
		const rank = rankOf(message.author.roles);
		if (rank < AUDIENCES.indexOf(settings.allowed)) {
			report('denied', AUDIENCE_TEXT[settings.allowed]);
			return;
		}
		const isBroadcaster = message.author.roles.includes('broadcaster');
		const userKey = `${command.name}\u0000${message.platform}:${message.author.id}`;
		if (!isBroadcaster) {
			const wait = Math.max(
				this.remaining(command.name, settings.cooldownSeconds, now),
				this.remaining(userKey, settings.userCooldownSeconds, now),
			);
			if (wait > 0) {
				report('cooldown', `${Math.ceil(wait / 1000)}s left`);
				return;
			}
		}
		if (this.pending.has(message.key)) {
			return;
		}
		if (this.pending.size >= MAX_PENDING) {
			report('busy');
			return;
		}
		// Charged as soon as accepted, so repeating the command during the delay does not queue it again.
		// The broadcaster's own use is not charged: it should not hold the viewers back.
		const charges: Charge[] = isBroadcaster ? [] : [this.charge(command.name, now), this.charge(userKey, now)];
		this.pruneCooldowns(now);

		// Moderators and the broadcaster could remove the message themselves, so there is nothing to wait for.
		const delaySeconds = rank >= MODERATOR_RANK ? 0 : this.config().delaySeconds;
		if (delaySeconds === 0) {
			void this.run(command, invocation, charges);
			return;
		}
		report('accepted', `runs in ${delaySeconds}s`);
		const timer = setTimeout(() => {
			this.pending.delete(message.key);
			void this.run(command, invocation, charges);
		}, delaySeconds * 1000);
		this.pending.set(message.key, { timer, command, invocation });
	}

	private async run(command: ChatCommand, invocation: ChatCommandInvocation, charges: Charge[]): Promise<void> {
		try {
			// Settings or the command itself may have changed during the delay.
			if (!this.active || this.commands.get(command.name) !== command || !this.settingsFor(command).enabled) {
				this.report(invocation, 'cancelled');
				return;
			}
			const summary = await command.run(invocation);
			this.report(invocation, 'ran', typeof summary === 'string' && summary ? summary : undefined);
		} catch (error) {
			// Nothing happened, so the viewer has not had their turn.
			this.refund(charges);
			this.report(invocation, error instanceof CommandRejected ? 'rejected' : 'failed', describe(error));
		}
	}

	private charge(key: string, now: number): Charge {
		const previous = this.lastUsed.get(key);
		this.lastUsed.set(key, now);
		return [key, previous, now];
	}

	private refund(charges: Charge[]): void {
		for (const [key, previous, charged] of charges) {
			// Unless someone else has used it since.
			if (this.lastUsed.get(key) !== charged) {
				continue;
			}
			if (previous === undefined) {
				this.lastUsed.delete(key);
			} else {
				this.lastUsed.set(key, previous);
			}
		}
	}

	/**
	 * The settings, checked. They come from a JSON file the user edits by hand, so a value of the wrong type falls
	 * back to the safe choice: switched off, and the default delay.
	 */
	private config(): ChatControlsConfig {
		const raw = this.options.getConfig() as Partial<Record<keyof ChatControlsConfig, unknown>>;
		return {
			enabled: raw.enabled === true,
			delaySeconds:
				typeof raw.delaySeconds === 'number' && Number.isFinite(raw.delaySeconds)
					? Math.min(MAX_DELAY_SECONDS, Math.max(0, raw.delaySeconds))
					: DEFAULT_DELAY_SECONDS,
			commands: isRecord(raw.commands) ? (raw.commands as Record<string, CommandSettings>) : {},
		};
	}

	private settingsFor(command: ChatCommand): Required<CommandSettings> {
		const entry = this.config().commands[command.name];
		const own: CommandSettings = isRecord(entry) ? entry : {};
		return {
			enabled: own.enabled !== false,
			allowed: own.allowed && AUDIENCES.includes(own.allowed) ? own.allowed : command.defaults.allowed,
			cooldownSeconds: seconds(own.cooldownSeconds) ?? command.defaults.cooldownSeconds,
			userCooldownSeconds: seconds(own.userCooldownSeconds) ?? command.defaults.userCooldownSeconds,
		};
	}

	/** Milliseconds until `key` is off cooldown. */
	private remaining(key: string, cooldownSeconds: number, now: number): number {
		const last = this.lastUsed.get(key);
		return last === undefined ? 0 : last + cooldownSeconds * 1000 - now;
	}

	private pruneCooldowns(now: number): void {
		if (this.lastUsed.size <= COOLDOWN_PRUNE_SIZE) {
			return;
		}
		for (const [key, last] of this.lastUsed) {
			if (now - last > COOLDOWN_PRUNE_AGE_MS) {
				this.lastUsed.delete(key);
			}
		}
	}

	private cancelWhere(predicate: (entry: Pending) => boolean): void {
		for (const [key, entry] of this.pending) {
			if (predicate(entry)) {
				clearTimeout(entry.timer);
				this.pending.delete(key);
				this.report(entry.invocation, 'cancelled');
			}
		}
	}

	private report(invocation: ChatCommandInvocation, outcome: ControlOutcome, detail?: string): void {
		const { command, message } = invocation;
		this.options.log(`Chat control !${command} from ${message.author.name} (${message.platform}): ${outcome}${detail ? `, ${detail}` : ''}`);
		this.reportEmitter.fire({ command, message, outcome, detail });
	}
}

/** What became of a command, in a few words, for showing under the viewer's message. */
export function describeReport(report: ControlReport): CommandFeedback {
	const { outcome, detail, command } = report;
	switch (outcome) {
		case 'accepted':
			return { state: 'waiting', text: detail ?? 'waiting' };
		case 'ran':
			return { state: 'done', text: detail ?? 'done' };
		case 'rejected':
			return { state: 'refused', text: detail ?? 'turned down' };
		case 'failed':
			return { state: 'refused', text: detail ? `did not work: ${detail}` : 'did not work' };
		case 'off':
			return { state: 'refused', text: 'chat controls are off' };
		case 'paused':
			return { state: 'refused', text: 'chat controls are paused' };
		case 'disabled':
			return { state: 'refused', text: `!${command} is switched off` };
		case 'denied':
			return { state: 'refused', text: detail ? `!${command} is ${detail}` : 'not allowed' };
		case 'cooldown':
			return { state: 'refused', text: detail ? `on cooldown, ${detail}` : 'on cooldown' };
		case 'cancelled':
			return { state: 'refused', text: 'cancelled' };
		case 'busy':
			return { state: 'refused', text: 'too many commands waiting' };
		case 'stale':
			return { state: 'refused', text: 'too old to run' };
	}
}

/** The command a message asks for, if it starts with `!word`. A reply's leading @mention is skipped. */
export function parseCommand(message: ChatMessage): { name: string; args: string } | undefined {
	let text = message.fragments.map((fragment) => fragment.text).join('');
	if (message.replyTo) {
		text = text.trim().replace(/^@\S+\s*/, '');
	}
	return parseCommandText(text);
}

/** The command in typed text, if it starts with `!word`. */
export function parseCommandText(text: string): { name: string; args: string } | undefined {
	const match = COMMAND.exec(text.trim());
	return match ? { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() } : undefined;
}

function rankOf(roles: readonly Role[]): number {
	return Math.max(0, ...roles.map((role) => ROLE_RANK[role] ?? 0));
}

function seconds(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
