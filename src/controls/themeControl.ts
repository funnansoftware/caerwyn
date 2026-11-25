import type { StateStore } from '../chat/chatService';
import { Disposable } from '../util/emitter';
import type { Untrusted } from '../util/json';
import { ChatCommandInvocation, ChatControls, CommandRejected, CommandResult } from './chatControls';

// `!theme <name>`: a viewer switches the editor's color theme for a while, after which it goes back.
// What the user had is kept in the state store, not in memory, so that a crash or a second window still puts
// it back. Free of `vscode` imports; `vscodeThemeHost.ts` connects it to the editor.

export type ThemeKind = 'light' | 'dark' | 'highContrast' | 'highContrastLight';

export interface ThemeInfo {
	/** What the theme settings, such as `workbench.colorTheme`, are set to for this theme. */
	id: string;
	/** The name shown in VS Code's theme picker. */
	label: string;
	kind: ThemeKind;
}

/**
 * The `workbench` setting that picks the theme on screen. Normally `colorTheme`; while VS Code follows the system's
 * light or dark mode (`window.autoDetectColorScheme`), the preferred theme for the mode the system is in.
 */
export const THEME_SETTINGS = ['colorTheme', 'preferredDarkColorTheme', 'preferredLightColorTheme'] as const;
export type ThemeSetting = (typeof THEME_SETTINGS)[number];

/** What the controller needs from the editor. */
export interface ThemeHost {
	/** Every installed color theme. */
	themes(): ThemeInfo[];
	/** Whether VS Code follows the system's light or dark mode, showing a preferred theme for each. */
	followsSystem(): boolean;
	/** The kind of theme on screen. */
	showingKind(): ThemeKind;
	/** The setting's value in the user's own settings, if they set one. */
	userTheme(setting: ThemeSetting): string | undefined;
	/** The setting's value in effect, whichever settings it comes from, or its default. */
	currentTheme(setting: ThemeSetting): string | undefined;
	/** Sets, or with `undefined` removes, the setting in the user's own settings. */
	setUserTheme(setting: ThemeSetting, theme: string | undefined): Promise<void>;
	/** Why changing the setting would have no effect right now, if it would not. */
	blocked(setting: ThemeSetting): string | undefined;
}

export interface ThemeControlConfig {
	/** How long a viewer's theme stays before the user's comes back. */
	durationSeconds: number;
	/**
	 * Themes chat may pick: a list of names or IDs, or short names mapped to them, such as `{ "kai": "Monokai" }`.
	 * Empty allows every installed theme.
	 */
	choices: string[] | Record<string, string>;
}

/** One theme chat may pick, from `choices`, with the short name the user gave it, if any. */
interface ThemeChoice {
	name: string;
	code?: string;
}

/** What chat may pick from: the themes, and short names for some of them. */
interface Catalog {
	themes: ThemeInfo[];
	/** By short name, in the order the user listed them. */
	codes: Map<string, ThemeInfo>;
}

export interface Timers {
	set(callback: () => void, ms: number): unknown;
	clear(handle: unknown): void;
}

export interface ThemeControlOptions {
	controls: ChatControls;
	host: ThemeHost;
	/** Shared by every window, so whichever window is open can put the user's theme back. */
	state: StateStore;
	/** Read as untrusted: see `config`. */
	getConfig(): Untrusted<ThemeControlConfig>;
	log(message: string): void;
	now?: () => number;
	random?: () => number;
	timers?: Timers;
}

/** A theme chat put in place: what to put back, and when. */
interface ChatThemeRecord {
	/** The user's own `workbench.colorTheme`, or `undefined` if they had none. */
	original: string | undefined;
	/** What chat set it to. If the user's setting is anything else, they changed it themselves and it is theirs. */
	chatTheme: string;
	/** Milliseconds since the Unix epoch. */
	until: number;
	/** The window that set it. Only that window puts the theme back as it closes; others leave it to run its course. */
	owner?: string;
	/** Which setting chat changed. Absent in records from before following the system was supported: `colorTheme`. */
	setting?: ThemeSetting;
}

const RECORD_KEY = 'caerwyn.controls.theme.record';
export const DEFAULT_THEME_SECONDS = 300;
const MIN_THEME_SECONDS = 10;
const MAX_THEME_SECONDS = 3600;
/** How soon to try again when putting the user's theme back fails, such as while settings.json has unsaved edits. */
const RETRY_MS = 30_000;
const MAX_QUERY = 60;
/** Past this, `!help theme` gives examples rather than every choice. Twitch allows 500 characters. */
const HELP_LENGTH = 300;
const HELP_EXAMPLES = 4;

const defaultTimers: Timers = {
	set: (callback, ms) => setTimeout(callback, ms),
	clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export class ThemeControl implements Disposable {
	private readonly now: () => number;
	private readonly random: () => number;
	private readonly timers: Timers;
	private readonly subscriptions: Disposable[];
	private timer: unknown;
	/** Changes to the theme happen one at a time, in order. */
	private queue: Promise<void> = Promise.resolve();
	private disposed = false;
	/** Settings problems already logged. */
	private readonly warned = new Set<string>();
	private readonly instance = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

	constructor(private readonly options: ThemeControlOptions) {
		this.now = options.now ?? Date.now;
		this.random = options.random ?? Math.random;
		this.timers = options.timers ?? defaultTimers;
		this.subscriptions = [
			options.controls.register({
				name: 'theme',
				description: 'switches the color theme for a few minutes: `!theme monokai`, or `!theme random`.',
				usage: '!theme <name>',
				help: () => this.help(),
				defaults: { allowed: 'everyone', cooldownSeconds: 60, userCooldownSeconds: 300 },
				run: (invocation) => this.apply(invocation),
			}),
			options.controls.onDidChangeState(() => {
				// A pause is the user taking the editor back: the theme goes with it.
				if (!options.controls.active) {
					this.background(this.revert());
				}
			}),
		];
		this.background(this.resume());
	}

	/**
	 * Puts the user's theme back as the extension stops, if this window set it: closing a second window must not end
	 * the streaming window's chat theme. The promise ends once the setting is written.
	 */
	shutdown(): Promise<void> {
		return this.enqueue(async () => {
			if (this.record()?.owner === this.instance) {
				await this.restore();
			}
		});
	}

	dispose(): void {
		this.disposed = true;
		this.timers.clear(this.timer);
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
	}

	/**
	 * What `!help theme` says. Chat is plain text, so it stays short: every theme in `choices` when they fit, or
	 * else a few examples picked at random and how many there are.
	 */
	private help(): string {
		const config = this.config();
		const intro = `!theme <name> switches the color theme for ${formatDuration(config.durationSeconds)}.`;
		let catalog: Catalog;
		try {
			catalog = this.catalog(config.choices);
		} catch {
			return `${intro} Try !theme random.`;
		}
		// Short names when the user gave them: they are what chat is meant to type, and they keep this short.
		const labels =
			catalog.codes.size > 0
				? [...catalog.codes.keys()]
				: [...new Set(catalog.themes.filter((theme) => theme.kind === 'light' || theme.kind === 'dark').map((theme) => theme.label))];
		if (labels.length === 0) {
			return `${intro} Try !theme random.`;
		}
		if (hasChoices(config.choices)) {
			const all = `${intro} Pick from: ${labels.join(', ')}, or !theme random.`;
			if (all.length <= HELP_LENGTH) {
				return all;
			}
		}
		const pool = [...labels];
		const examples: string[] = [];
		while (examples.length < HELP_EXAMPLES && pool.length > 0) {
			examples.push(pool.splice(Math.floor(this.random() * pool.length), 1)[0]);
		}
		const list = examples.length > 1 ? `${examples.slice(0, -1).join(', ')} or ${examples.at(-1)}` : examples[0];
		return `${intro} Try ${list}, or !theme random. ${labels.length} themes to pick from.`;
	}

	/** Picks up a theme chat set before this window started: one from another window, or from before a crash. */
	private resume(): Promise<void> {
		return this.enqueue(async () => {
			const record = this.record();
			if (!record) {
				return;
			}
			if (!this.options.controls.active || record.until <= this.now()) {
				await this.restore();
				return;
			}
			this.schedule(record.until - this.now());
		});
	}

	/** Returns what it did, such as "Monokai for 5 min", to show under the viewer's message. */
	private apply(invocation: ChatCommandInvocation): Promise<CommandResult> {
		return this.enqueue(async () => {
			const { host, state } = this.options;
			const setting = this.activeSetting();
			const blocked = host.blocked(setting);
			if (blocked) {
				throw new CommandRejected(blocked, 'The theme cannot be changed right now.');
			}
			const config = this.config();
			const current = host.currentTheme(setting);
			const catalog = this.catalog(config.choices);
			const theme = findTheme(catalog.themes, invocation.args, current, this.random, catalog.codes);
			if ('problem' in theme) {
				throw new CommandRejected(theme.problem, theme.chat);
			}
			if (theme.id === current) {
				throw new CommandRejected(`${theme.label} is already showing.`, `${theme.label} is already showing.`);
			}
			let previous = this.record();
			if (previous && settingOf(previous) !== setting) {
				// The chat theme in place is in another setting, such as after the system switched to light mode.
				// Put that one back first, so each record only ever covers one setting.
				await this.restore();
				previous = this.record();
				if (previous) {
					throw new Error('the earlier chat theme could not be put back');
				}
			}
			const userTheme = host.userTheme(setting);
			// During a run of chat themes, what to put back is still what the user had before the first.
			const original = previous && userTheme === previous.chatTheme ? previous.original : userTheme;
			const until = this.now() + config.durationSeconds * 1000;
			// Saved first, so that if the window dies straight after the change, the next one can still undo it.
			await state.update(RECORD_KEY, { original, chatTheme: theme.id, until, owner: this.instance, setting } satisfies ChatThemeRecord);
			try {
				await host.setUserTheme(setting, theme.id);
			} catch (error) {
				// Nothing changed: what was there before is still what must eventually be put back.
				await state.update(RECORD_KEY, previous);
				throw error;
			}
			this.options.log(`Chat theme: ${theme.label} for ${config.durationSeconds}s, from ${invocation.message.author.name}.`);
			this.schedule(until - this.now());
			const summary = `${theme.label} for ${formatDuration(config.durationSeconds)}`;
			return { summary, confirmation: `${summary}.` };
		});
	}

	private revert(): Promise<void> {
		return this.enqueue(() => this.restore());
	}

	/** Puts the user's theme back, if chat's is still showing. Only then is the record dropped. */
	private async restore(): Promise<void> {
		this.timers.clear(this.timer);
		this.timer = undefined;
		const record = this.record();
		if (!record) {
			return;
		}
		const { host, state } = this.options;
		const setting = settingOf(record);
		if (host.userTheme(setting) === record.chatTheme) {
			try {
				await host.setUserTheme(setting, record.original);
				this.options.log(`Chat theme ended: back to ${record.original ?? 'the default theme'}.`);
			} catch (error) {
				this.options.log(`Could not put the color theme back, trying again shortly: ${error instanceof Error ? error.message : String(error)}`);
				this.schedule(RETRY_MS);
				return;
			}
		}
		await state.update(RECORD_KEY, undefined);
	}

	private schedule(ms: number): void {
		this.timers.clear(this.timer);
		if (this.disposed) {
			return;
		}
		this.timer = this.timers.set(() => {
			this.timer = undefined;
			this.background(this.revert());
		}, Math.max(0, ms));
	}

	/** For work nobody waits on: a failure is logged rather than lost. */
	private background(work: Promise<void>): void {
		work.catch((error: unknown) => this.options.log(`Chat theme: ${error instanceof Error ? error.message : String(error)}`));
	}

	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.queue.then(task);
		// A failed task must not stop the ones after it.
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	/**
	 * The setting that decides the theme on screen. While following the system, VS Code does not say which mode the
	 * system is in, so it is worked out from the kind of theme showing. A chat theme already in place answers it
	 * instead: chat may have put a light theme in the dark setting.
	 */
	private activeSetting(): ThemeSetting {
		const { host } = this.options;
		if (!host.followsSystem()) {
			return 'colorTheme';
		}
		const showing = host.showingKind();
		const kinds = new Map(host.themes().map((theme) => [theme.id, theme.kind]));
		const record = this.record();
		// Unless the system has since switched mode, and the chat theme is no longer the one showing.
		if (
			record &&
			settingOf(record) !== 'colorTheme' &&
			host.userTheme(settingOf(record)) === record.chatTheme &&
			kinds.get(record.chatTheme) === showing
		) {
			return settingOf(record);
		}
		const darkMatches = kinds.get(host.currentTheme('preferredDarkColorTheme') ?? '') === showing;
		const lightMatches = kinds.get(host.currentTheme('preferredLightColorTheme') ?? '') === showing;
		if (darkMatches !== lightMatches) {
			return darkMatches ? 'preferredDarkColorTheme' : 'preferredLightColorTheme';
		}
		return showing === 'light' || showing === 'highContrastLight' ? 'preferredLightColorTheme' : 'preferredDarkColorTheme';
	}

	private record(): ChatThemeRecord | undefined {
		const value = this.options.state.get<ChatThemeRecord>(RECORD_KEY);
		return value && typeof value.chatTheme === 'string' && typeof value.until === 'number' ? value : undefined;
	}

	/** The installed themes chat may pick, and short names for them. */
	private catalog(raw: ThemeControlConfig['choices']): Catalog {
		const installed = this.options.host.themes();
		if (!hasChoices(raw)) {
			return { themes: installed, codes: new Map() };
		}
		// From here on, a list that came out empty must not fall back to every installed theme.
		const choices = toChoices(raw, (problem) => this.warn(problem));
		const themes: ThemeInfo[] = [];
		const codes = new Map<string, ThemeInfo>();
		for (const choice of choices) {
			const wanted = normalize(choice.name);
			const theme = installed.find((candidate) => normalize(candidate.id) === wanted || normalize(candidate.label) === wanted);
			if (!theme) {
				this.warn(`caerwyn.controls.theme.choices: no installed theme is called "${choice.name}".`);
				continue;
			}
			if (!themes.includes(theme)) {
				themes.push(theme);
			}
			if (choice.code) {
				codes.set(choice.code, theme);
			}
		}
		if (themes.length === 0) {
			throw new CommandRejected('None of the themes in caerwyn.controls.theme.choices are installed.', 'The theme cannot be changed right now.');
		}
		return { themes, codes };
	}

	/** Logs a problem with the settings once, rather than at every command and `!help`. */
	private warn(problem: string): void {
		if (!this.warned.has(problem)) {
			this.warned.add(problem);
			this.options.log(problem);
		}
	}

	/** The settings, checked: a value of the wrong type falls back to the default, never to forever. */
	private config(): ThemeControlConfig {
		const raw = this.options.getConfig();
		const duration = raw.durationSeconds;
		const choices = raw.choices;
		const isList = Array.isArray(choices) && choices.every((choice) => typeof choice === 'string');
		const isMap = typeof choices === 'object' && choices !== null && !Array.isArray(choices);
		if (choices !== undefined && !isList && !isMap) {
			throw new CommandRejected(
				'caerwyn.controls.theme.choices must be a list of theme names, or short names mapped to theme names.',
				'The theme cannot be changed right now.',
			);
		}
		return {
			durationSeconds:
				typeof duration === 'number' && Number.isFinite(duration)
					? Math.min(MAX_THEME_SECONDS, Math.max(MIN_THEME_SECONDS, duration))
					: DEFAULT_THEME_SECONDS,
			choices: (choices as ThemeControlConfig['choices'] | undefined) ?? [],
		};
	}
}

/**
 * The theme a viewer asked for, or why there is none. Names are compared ignoring case, spaces and punctuation:
 * an exact name first, then the only name that starts with what they typed, then the only one that contains it.
 * `random` picks any theme except high contrast ones and the one showing.
 */
export function findTheme(
	themes: readonly ThemeInfo[],
	query: string,
	current: string | undefined,
	random: () => number,
	/** Short names the user gave, which win over any name. */
	codes: ReadonlyMap<string, ThemeInfo> = new Map(),
): ThemeInfo | ThemeMiss {
	const typed = query.trim();
	if (!typed) {
		return miss('Say which theme, such as !theme monokai.');
	}
	const unique = [...new Map(themes.map((theme) => [theme.id, theme])).values()];
	const wanted = normalize(typed);
	if (wanted === 'random') {
		const candidates = unique.filter((theme) => theme.id !== current && (theme.kind === 'light' || theme.kind === 'dark'));
		return candidates.length > 0 ? candidates[Math.floor(random() * candidates.length)] : miss('There is no other theme to pick.');
	}
	const shown = typed.length > MAX_QUERY ? `${typed.slice(0, MAX_QUERY)}…` : typed;
	// The chat view may quote the viewer; chat itself never does.
	const unknown = { problem: `No theme is called "${shown}".`, chat: 'There is no theme by that name. Try !help theme.' };
	if (!wanted) {
		return unknown;
	}
	const coded = codes.get(wanted);
	if (coded) {
		return coded;
	}
	const names = (theme: ThemeInfo) => [normalize(theme.label), normalize(theme.id)];
	for (const test of [
		(name: string) => name === wanted,
		(name: string) => name.startsWith(wanted),
		(name: string) => name.includes(wanted),
	]) {
		const matches = unique.filter((theme) => names(theme).some(test));
		if (matches.length === 1) {
			return matches[0];
		}
		if (matches.length > 1) {
			const some = `${matches
				.slice(0, 5)
				.map((theme) => theme.label)
				.join(', ')}${matches.length > 5 ? '…' : ''}`;
			return {
				problem: `"${shown}" could be ${matches.length} themes: ${some}.`,
				chat: `That could be ${matches.length} themes: ${some}. Try the full name.`,
			};
		}
	}
	return unknown;
}

/** Why no theme was picked: `problem` for the user, who may see the viewer's words, and `chat` for saying in chat. */
export interface ThemeMiss {
	problem: string;
	chat: string;
}

/** A miss whose explanation quotes nothing the viewer typed, so it is safe for both. */
function miss(text: string): ThemeMiss {
	return { problem: text, chat: text };
}

/** `90` → "1 min 30 s", `300` → "5 min". */
export function formatDuration(seconds: number): string {
	const whole = Math.round(seconds);
	const minutes = Math.floor(whole / 60);
	const rest = whole % 60;
	if (minutes === 0) {
		return `${rest} s`;
	}
	return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
}

/** Whether the user limited chat to some themes. */
function hasChoices(raw: ThemeControlConfig['choices']): boolean {
	return Array.isArray(raw) ? raw.length > 0 : Object.keys(raw).length > 0;
}

/** A short name: what a viewer types after `!theme`. */
const CODE = /^[a-z0-9]{1,12}$/;

/** The user's `choices`, as a list. Short names that cannot work are reported and left out. */
function toChoices(raw: ThemeControlConfig['choices'], warn: (problem: string) => void): ThemeChoice[] {
	if (Array.isArray(raw)) {
		return raw.map((name) => ({ name }));
	}
	const choices: ThemeChoice[] = [];
	for (const [key, name] of Object.entries(raw)) {
		const code = key.toLowerCase();
		if (typeof name !== 'string') {
			warn(`caerwyn.controls.theme.choices: "${key}" must name a theme.`);
		} else if (!CODE.test(code) || code === 'random') {
			warn(`caerwyn.controls.theme.choices: "${key}" cannot be a short name. Use 1 to 12 letters or digits, and not "random".`);
		} else {
			choices.push({ name, code });
		}
	}
	return choices;
}

function settingOf(record: ChatThemeRecord): ThemeSetting {
	return record.setting && THEME_SETTINGS.includes(record.setting) ? record.setting : 'colorTheme';
}

function normalize(name: string): string {
	return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
