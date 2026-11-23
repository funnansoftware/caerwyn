import * as assert from 'assert';
import type { StateStore } from '../chat/chatService';
import { ChatEvent, ChatMessage } from '../chat/types';
import { ChatControls, ChatControlsConfig, CommandRejected } from '../controls/chatControls';
import { ThemeControl, ThemeControlConfig, ThemeHost, ThemeInfo, ThemeSetting, Timers, findTheme, formatDuration } from '../controls/themeControl';
import { Emitter } from '../util/emitter';

class MemoryState implements StateStore {
	readonly values = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}
	async update(key: string, value: unknown): Promise<void> {
		if (value === undefined) {
			this.values.delete(key);
		} else {
			this.values.set(key, value);
		}
	}
}

const THEMES: ThemeInfo[] = [
	{ id: 'Dark 2026', label: 'Dark 2026', kind: 'dark' },
	{ id: 'Light 2026', label: 'Light 2026', kind: 'light' },
	{ id: 'Monokai', label: 'Monokai', kind: 'dark' },
	{ id: 'Monokai Dimmed', label: 'Monokai Dimmed', kind: 'dark' },
	{ id: 'Solarized Dark', label: 'Solarized Dark', kind: 'dark' },
	{ id: 'Solarized Light', label: 'Solarized Light', kind: 'light' },
	{ id: 'Default High Contrast', label: 'Dark High Contrast', kind: 'highContrast' },
	{ id: 'Visual Studio Dark', label: 'Dark (Visual Studio)', kind: 'dark' },
];

/** VS Code's defaults for each theme setting. */
const DEFAULTS: Record<ThemeSetting, string> = { colorTheme: 'Dark 2026', preferredDarkColorTheme: 'Dark 2026', preferredLightColorTheme: 'Light 2026' };

/**
 * An editor with the user's theme settings in `settings`. It shows `colorTheme`, or while `following` the system,
 * the preferred theme for the system's mode.
 */
class FakeHost implements ThemeHost {
	readonly settings: Partial<Record<ThemeSetting, string>> = {};
	following = false;
	system: 'dark' | 'light' = 'dark';
	blockedBy: string | undefined;
	failWrites = 0;
	readonly writes: (string | undefined)[] = [];
	/** Which setting each write went to. */
	readonly written: ThemeSetting[] = [];

	/** The user's own `workbench.colorTheme`. */
	get user(): string | undefined {
		return this.settings.colorTheme;
	}
	set user(theme: string | undefined) {
		this.set('colorTheme', theme);
	}

	/** The theme on screen. */
	get showing(): string {
		const setting = this.following ? (this.system === 'dark' ? 'preferredDarkColorTheme' : 'preferredLightColorTheme') : 'colorTheme';
		return this.currentTheme(setting);
	}

	themes = () => THEMES;
	followsSystem = () => this.following;
	showingKind = () => THEMES.find((theme) => theme.id === this.showing)?.kind ?? 'dark';
	userTheme = (setting: ThemeSetting) => this.settings[setting];
	currentTheme = (setting: ThemeSetting) => this.settings[setting] ?? DEFAULTS[setting];
	blocked = () => this.blockedBy;
	async setUserTheme(setting: ThemeSetting, theme: string | undefined): Promise<void> {
		if (this.failWrites > 0) {
			this.failWrites--;
			throw new Error('settings.json has unsaved changes');
		}
		this.writes.push(theme);
		this.written.push(setting);
		this.set(setting, theme);
	}

	private set(setting: ThemeSetting, theme: string | undefined): void {
		if (theme === undefined) {
			delete this.settings[setting];
		} else {
			this.settings[setting] = theme;
		}
	}
}

/** Timers run by hand, so a test decides when time passes. */
class ManualTimers implements Timers {
	private next = 0;
	readonly pending = new Map<number, { callback: () => void; ms: number }>();
	set(callback: () => void, ms: number): unknown {
		const id = ++this.next;
		this.pending.set(id, { callback, ms });
		return id;
	}
	clear(handle: unknown): void {
		this.pending.delete(handle as number);
	}
	/** The delay of the one timer waiting. */
	get delay(): number | undefined {
		return [...this.pending.values()].at(-1)?.ms;
	}
	fire(): void {
		const entries = [...this.pending.entries()];
		this.pending.clear();
		for (const [, entry] of entries) {
			entry.callback();
		}
	}
}

/** Lets queued promise work finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

suite('findTheme', () => {
	const pick = (query: string, current?: string, random = () => 0) => {
		const result = findTheme(THEMES, query, current, random);
		return typeof result === 'string' ? result : result.id;
	};

	test('matches names ignoring case, spaces and punctuation, exact first', () => {
		assert.strictEqual(pick('monokai'), 'Monokai', 'an exact name wins over a longer one starting the same');
		assert.strictEqual(pick('SOLARIZED-light'), 'Solarized Light');
		assert.strictEqual(pick('dimmed'), 'Monokai Dimmed', 'the only name containing it');
		assert.strictEqual(pick('visual studio dark'), 'Visual Studio Dark', 'by ID as well as label');
		assert.strictEqual(pick('dark (visual studio)'), 'Visual Studio Dark');
	});

	test('explains an ambiguous, unknown or missing name', () => {
		assert.match(pick('solarized'), /could be 2 themes: Solarized Dark, Solarized Light/);
		assert.match(pick('nope'), /No theme is called "nope"/);
		assert.match(pick('!!!'), /No theme is called/);
		assert.match(pick('   '), /Say which theme/);
		assert.ok(pick('x'.repeat(200)).length < 120, 'a long name is cut short');
	});

	test('durations read naturally', () => {
		assert.strictEqual(formatDuration(300), '5 min');
		assert.strictEqual(formatDuration(90), '1 min 30 s');
		assert.strictEqual(formatDuration(45), '45 s');
	});

	test('random never picks high contrast or the theme already showing', () => {
		const seen = new Set<string>();
		for (let i = 0; i < THEMES.length; i++) {
			seen.add(pick('random', 'Monokai', () => i / THEMES.length));
		}
		assert.ok(!seen.has('Default High Contrast'));
		assert.ok(!seen.has('Monokai'));
		assert.ok(seen.size > 1);
	});
});

suite('ThemeControl', () => {
	let events: Emitter<ChatEvent[]>;
	let controlsConfig: ChatControlsConfig;
	let themeConfig: ThemeControlConfig;
	let state: MemoryState;
	let controls: ChatControls;
	let host: FakeHost;
	let timers: ManualTimers;
	let now: number;
	let theme: ThemeControl;
	let logs: string[];

	const create = (inWindow: ChatControls = controls) =>
		new ThemeControl({
			controls: inWindow,
			host,
			state,
			getConfig: () => themeConfig,
			log: (message) => logs.push(message),
			now: () => now,
			random: () => 0,
			timers,
		});

	const message = (): ChatMessage => ({
		key: 'twitch:1',
		platform: 'twitch',
		id: '1',
		sourceId: 'twitch:me',
		channelId: 'c1',
		channelName: 'me',
		author: { id: 'u1', name: 'viewer', roles: [] },
		fragments: [],
		timestamp: now,
	});
	/** Runs `!theme <args>` as chat controls would, straight to the command. */
	const run = (args: string) => {
		const command = controls.registered.find((entry) => entry.name === 'theme');
		assert.ok(command, 'the theme command is registered');
		return Promise.resolve(command.run({ command: 'theme', args, message: message() }));
	};
	const record = () => state.get<{ original?: string; chatTheme: string; until: number }>('caerwyn.controls.theme.record');

	setup(() => {
		now = 1_000_000;
		events = new Emitter<ChatEvent[]>();
		controlsConfig = { enabled: true, delaySeconds: 0, commands: {} };
		themeConfig = { durationSeconds: 300, choices: [] };
		state = new MemoryState();
		host = new FakeHost();
		timers = new ManualTimers();
		logs = [];
		controls = new ChatControls({
			onEvents: events.event,
			isOwnSource: () => true,
			getConfig: () => controlsConfig,
			state,
			log: () => undefined,
		});
		theme = create();
	});

	teardown(() => {
		theme.dispose();
		controls.dispose();
	});

	test('sets the theme in user settings, then puts the user’s back when time is up', async () => {
		host.user = 'Solarized Dark';
		assert.strictEqual(await run('monokai'), 'Monokai for 5 min', 'says what it did, for the chat view');
		assert.strictEqual(host.user, 'Monokai');
		assert.deepStrictEqual({ ...record(), owner: undefined }, {
			original: 'Solarized Dark',
			chatTheme: 'Monokai',
			until: now + 300_000,
			owner: undefined,
			setting: 'colorTheme',
		});
		assert.strictEqual(timers.delay, 300_000);

		timers.fire();
		await settle();
		assert.strictEqual(host.user, 'Solarized Dark');
		assert.strictEqual(record(), undefined);
	});

	test('a user with no theme setting gets none back, not the default written in', async () => {
		await run('monokai');
		timers.fire();
		await settle();
		assert.deepStrictEqual(host.writes, ['Monokai', undefined]);
	});

	test('a run of chat themes puts back what the user had before the first', async () => {
		host.user = 'Solarized Dark';
		await run('monokai');
		now += 60_000;
		await run('solarized light');
		assert.strictEqual(record()?.original, 'Solarized Dark');
		assert.strictEqual(timers.delay, 300_000, 'the time starts again');
		await theme.shutdown();
		assert.strictEqual(host.user, 'Solarized Dark');
	});

	test('a theme the user changed by hand is theirs: left alone, and kept as what to put back', async () => {
		await run('monokai');
		host.user = 'Solarized Light'; // The user picks a theme themselves.
		await run('dimmed');
		assert.strictEqual(record()?.original, 'Solarized Light');

		host.user = 'Dark 2026';
		timers.fire();
		await settle();
		assert.strictEqual(host.user, 'Dark 2026', 'their own change is not undone');
		assert.strictEqual(record(), undefined);
	});

	test('turns down names it cannot use, and themes that would not show', async () => {
		await assert.rejects(run('solarized'), CommandRejected);
		await assert.rejects(run('dark 2026'), /already showing/);

		host.blockedBy = 'This workspace sets its own color theme.';
		await assert.rejects(run('monokai'), /workspace/);
		host.blockedBy = undefined;

		themeConfig.choices = ['Monokai', 'solarized light'];
		await assert.rejects(run('dimmed'), /No theme is called/);
		await run('Solarized Light');
		assert.strictEqual(host.user, 'Solarized Light');

		themeConfig.choices = ['Not Installed'];
		await assert.rejects(run('monokai'), /None of the themes/);
		themeConfig.choices = 'Monokai' as never;
		await assert.rejects(run('monokai'), /must be a list/);
		assert.deepStrictEqual(host.writes, ['Solarized Light']);
	});

	test('a duration of the wrong type uses the default, and one out of range is held to it', async () => {
		themeConfig.durationSeconds = 'forever' as never;
		await run('monokai');
		assert.strictEqual(timers.delay, 300_000);
		themeConfig.durationSeconds = 0;
		await run('dimmed');
		assert.strictEqual(timers.delay, 10_000);
		themeConfig.durationSeconds = 1e9;
		await run('solarized light');
		assert.strictEqual(timers.delay, 3_600_000);
	});

	test('a failed change keeps the earlier record, so the earlier theme still goes back', async () => {
		host.user = 'Solarized Dark';
		await run('monokai');
		const before = record();
		host.failWrites = 1;
		await assert.rejects(run('dimmed'), /unsaved changes/);
		assert.deepStrictEqual(record(), before);
		assert.strictEqual(host.user, 'Monokai');

		await theme.shutdown();
		assert.strictEqual(host.user, 'Solarized Dark');
	});

	test('a failed change back is tried again, and the record kept until it works', async () => {
		host.user = 'Solarized Dark';
		await run('monokai');
		host.failWrites = 1;
		timers.fire();
		await settle();
		assert.strictEqual(host.user, 'Monokai');
		assert.ok(record(), 'kept for the next try');
		assert.strictEqual(timers.delay, 30_000);

		timers.fire();
		await settle();
		assert.strictEqual(host.user, 'Solarized Dark');
		assert.strictEqual(record(), undefined);
	});

	test('pausing chat controls puts the theme back at once', async () => {
		host.user = 'Solarized Dark';
		await run('monokai');
		await controls.setPaused(true);
		await settle();
		assert.strictEqual(host.user, 'Solarized Dark');
	});

	test('a new window carries on with a chat theme that has time left, and ends one that has none', async () => {
		host.user = 'Solarized Dark';
		await run('monokai');
		theme.dispose();

		now += 100_000;
		theme = create();
		await settle();
		assert.strictEqual(host.user, 'Monokai', 'not cut short by a second window, or a restart after a crash');
		assert.strictEqual(timers.delay, 200_000);
		theme.dispose();

		now += 250_000;
		theme = create();
		await settle();
		assert.strictEqual(host.user, 'Solarized Dark', 'put back after a crash once its time is up');
	});

	test('only the window that set a chat theme puts it back as it closes', async () => {
		host.user = 'Solarized Dark';
		await run('monokai');
		// Each window has its own chat controls, sharing the state store.
		const otherControls = new ChatControls({ onEvents: events.event, isOwnSource: () => true, getConfig: () => controlsConfig, state, log: () => undefined });
		const second = create(otherControls);
		await settle();
		await second.shutdown();
		assert.strictEqual(host.user, 'Monokai', 'closing another window leaves it running');
		second.dispose();
		otherControls.dispose();
		await theme.shutdown();
		assert.strictEqual(host.user, 'Solarized Dark');
	});

	test('a failure in work nobody waits on is logged, not lost', async () => {
		await run('monokai');
		host.userTheme = () => {
			throw new Error('settings unreadable');
		};
		timers.fire();
		await settle();
		assert.ok(logs.some((line) => line.includes('settings unreadable')));
	});

	test('while VS Code follows the system, changes the preferred theme for the mode it is in, and only that', async () => {
		host.following = true;
		host.settings.preferredDarkColorTheme = 'Solarized Dark';
		await run('solarized light');
		assert.strictEqual(host.showing, 'Solarized Light');
		assert.deepStrictEqual(host.written, ['preferredDarkColorTheme']);
		assert.strictEqual(host.user, undefined, 'workbench.colorTheme is left alone');

		timers.fire();
		await settle();
		assert.strictEqual(host.settings.preferredDarkColorTheme, 'Solarized Dark');
		assert.strictEqual(host.showing, 'Solarized Dark');

		host.system = 'light';
		await run('monokai');
		assert.deepStrictEqual(host.written.slice(2), ['preferredLightColorTheme'], 'in light mode, the light preference');
		await theme.shutdown();
		assert.strictEqual(host.settings.preferredLightColorTheme, undefined, 'removed again, as the user had not set it');
	});

	test('a light chat theme in the dark preference does not make the next !theme go to the light one', async () => {
		host.following = true;
		await run('solarized light');
		assert.strictEqual(host.showingKind(), 'light', 'a light theme shows, though the system is still dark');
		await run('monokai');
		assert.deepStrictEqual(host.written, ['preferredDarkColorTheme', 'preferredDarkColorTheme']);
		assert.strictEqual(host.showing, 'Monokai');
		await assert.rejects(run('monokai'), /already showing/, 'what is showing is read from the same preference');

		await theme.shutdown();
		assert.strictEqual(host.settings.preferredDarkColorTheme, undefined, 'the user’s preference before the first chat theme');
	});

	test('if the system switches mode during a chat theme, the next one puts the first back before starting', async () => {
		host.following = true;
		host.settings.preferredDarkColorTheme = 'Solarized Dark';
		await run('monokai');
		// The system turns light. The chat theme is still in the dark preference, which no longer shows.
		host.system = 'light';
		host.settings.preferredDarkColorTheme = 'Solarized Dark'; // As if the user had changed it back themselves.
		await run('solarized light');
		assert.strictEqual(host.showing, 'Solarized Light');
		assert.strictEqual(host.settings.preferredDarkColorTheme, 'Solarized Dark', 'the user’s own change stays');
		await theme.shutdown();
		assert.strictEqual(host.settings.preferredLightColorTheme, undefined);
	});

	test('if the system switches mode during a chat theme left in place, the next one goes where it will show', async () => {
		host.following = true;
		host.settings.preferredDarkColorTheme = 'Solarized Dark';
		await run('monokai');
		host.system = 'light'; // Monokai is still in the dark preference, but the light one shows now.
		await run('solarized light');
		assert.strictEqual(host.showing, 'Solarized Light', 'it shows, rather than going to the hidden dark preference');
		assert.strictEqual(host.settings.preferredDarkColorTheme, 'Solarized Dark', 'and the dark preference is put back');
	});

	test('a record written before following the system was supported still puts back workbench.colorTheme', async () => {
		theme.dispose();
		host.user = 'Monokai';
		state.values.set('caerwyn.controls.theme.record', { original: 'Solarized Dark', chatTheme: 'Monokai', until: now - 1 });
		theme = create();
		await settle();
		assert.strictEqual(host.user, 'Solarized Dark');
	});

	test('a new window with chat controls paused puts the theme back', async () => {
		host.user = 'Solarized Dark';
		await run('monokai');
		theme.dispose();
		state.values.set('caerwyn.controls.paused', true);
		theme = create();
		await settle();
		assert.strictEqual(host.user, 'Solarized Dark');
	});
});
