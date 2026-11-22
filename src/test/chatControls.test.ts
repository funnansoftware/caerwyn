import * as assert from 'assert';
import type { StateStore } from '../chat/chatService';
import { ChatEvent, ChatMessage, Role } from '../chat/types';
import {
	ChatCommand,
	ChatCommandInvocation,
	ChatControls,
	ChatControlsConfig,
	CommandRejected,
	ControlReport,
	parseCommand,
} from '../controls/chatControls';
import { Emitter } from '../util/emitter';
import { delay, waitFor } from './helpers';

class MemoryState implements StateStore {
	readonly values = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}
	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

let counter = 0;

function chat(text: string, options: { userId?: string; roles?: Role[]; sourceId?: string; timestamp?: number; reply?: boolean } = {}): ChatMessage {
	const id = `m${++counter}`;
	const userId = options.userId ?? 'u1';
	const message: ChatMessage = {
		key: `twitch:${id}`,
		platform: 'twitch',
		id,
		sourceId: options.sourceId ?? 'twitch:me',
		channelId: 'c1',
		channelName: 'me',
		author: { id: userId, name: userId, roles: options.roles ?? [] },
		fragments: [{ type: 'text', text }],
		timestamp: options.timestamp ?? now,
	};
	if (options.reply) {
		message.replyTo = { name: 'someone', text: 'earlier' };
	}
	return message;
}

let now = 1_000_000;

suite('ChatControls', () => {
	let events: Emitter<ChatEvent[]>;
	let config: ChatControlsConfig;
	let state: MemoryState;
	let controls: ChatControls;
	let reports: ControlReport[];
	let runs: ChatCommandInvocation[];

	const command = (overrides: Partial<ChatCommand> = {}): ChatCommand => ({
		name: 'theme',
		description: 'changes the theme',
		defaults: { allowed: 'everyone', cooldownSeconds: 0, userCooldownSeconds: 0 },
		run: (invocation) => {
			runs.push(invocation);
		},
		...overrides,
	});
	const send = (...messages: ChatMessage[]) => events.fire(messages.map((message) => ({ type: 'message', message })));
	const outcomes = () => reports.map((report) => report.outcome);

	setup(() => {
		now = 1_000_000;
		events = new Emitter<ChatEvent[]>();
		config = { enabled: true, delaySeconds: 0, commands: {} };
		state = new MemoryState();
		reports = [];
		runs = [];
		controls = new ChatControls({
			onEvents: events.event,
			isOwnSource: (sourceId) => sourceId === 'twitch:me',
			getConfig: () => config,
			state,
			log: () => undefined,
			now: () => now,
		});
		controls.onReport((report) => reports.push(report));
	});

	teardown(() => controls.dispose());

	test('parses a command and its arguments, skipping a reply mention', () => {
		assert.deepStrictEqual(parseCommand(chat('!Theme  Solarized Dark ')), { name: 'theme', args: 'Solarized Dark' });
		assert.deepStrictEqual(parseCommand(chat('!pet')), { name: 'pet', args: '' });
		assert.deepStrictEqual(parseCommand(chat('@someone !pet', { reply: true })), { name: 'pet', args: '' });
		assert.strictEqual(parseCommand(chat('@someone !pet')), undefined, 'only a reply skips the mention');
		assert.strictEqual(parseCommand(chat('nice !theme')), undefined);
		assert.strictEqual(parseCommand(chat('!')), undefined);
	});

	test('runs a registered command and ignores everything else', async () => {
		controls.register(command());
		send(chat('!theme dracula'), chat('!discord'), chat('hello'));
		await waitFor(() => outcomes().includes('ran'), 'the command to run');
		assert.strictEqual(runs.length, 1);
		assert.strictEqual(runs[0].command, 'theme');
		assert.strictEqual(runs[0].args, 'dracula');
		assert.deepStrictEqual(outcomes(), ['ran'], 'unknown commands are not reported');
	});

	test('answers to aliases under the command name, and rejects a name taken twice', async () => {
		controls.register(command({ aliases: ['colors'] }));
		assert.throws(() => controls.register(command({ name: 'colors', aliases: [] })));
		assert.throws(() => controls.register(command({ name: 'bad name' })));
		send(chat('!COLORS'));
		await waitFor(() => runs.length === 1, 'the alias to run');
		assert.strictEqual(runs[0].command, 'theme');
	});

	test('does nothing while switched off, and ignores chats that are not the user’s own', async () => {
		controls.register(command());
		config.enabled = false;
		send(chat('!theme'));
		config.enabled = true;
		send(chat('!theme', { sourceId: 'twitch:somebody_else' }));
		send({ ...chat('!theme'), held: { messageId: 'x', state: 'held', fragments: [] } });
		send(chat('!theme', { userId: '' }));
		await delay(20);
		assert.deepStrictEqual(reports, []);
	});

	test('ignores old messages replayed after a reconnect', async () => {
		controls.register(command());
		send(chat('!theme', { timestamp: now - 120_000 }));
		await delay(10);
		assert.deepStrictEqual(outcomes(), ['stale']);
		assert.strictEqual(runs.length, 0);
	});

	test('lets only the allowed roles use a command, and the user can change who', async () => {
		controls.register(command({ defaults: { allowed: 'vip', cooldownSeconds: 0, userCooldownSeconds: 0 } }));
		send(chat('!theme', { roles: ['subscriber'] }), chat('!theme', { roles: ['vip'] }), chat('!theme', { roles: ['moderator'] }));
		await waitFor(() => runs.length === 2, 'the VIP and moderator commands');
		assert.strictEqual(reports.find((report) => report.outcome === 'denied')?.message.author.roles[0], 'subscriber');

		config.commands = { theme: { allowed: 'subscriber' } };
		send(chat('!theme', { roles: ['subscriber'] }));
		await waitFor(() => runs.length === 3, 'the subscriber command');

		config.commands = { theme: { allowed: 'nonsense' as never } };
		send(chat('!theme', { roles: ['subscriber'] }));
		await delay(10);
		assert.strictEqual(runs.length, 3, 'an unknown level falls back to the default');

		config.commands = { theme: { enabled: false } };
		send(chat('!theme', { roles: ['broadcaster'] }));
		await delay(10);
		assert.strictEqual(outcomes().at(-1), 'disabled');
	});

	test('holds commands back for their cooldowns, except the broadcaster', async () => {
		controls.register(command({ defaults: { allowed: 'everyone', cooldownSeconds: 10, userCooldownSeconds: 60 } }));
		/** Sends one command and waits for what became of it. */
		const attempt = async (userId: string, roles: Role[] = []) => {
			const message = chat('!theme', { userId, roles });
			send(message);
			await waitFor(() => reports.some((report) => report.message === message), `the outcome for ${userId}`);
			return reports.find((report) => report.message === message)?.outcome;
		};
		assert.strictEqual(await attempt('a'), 'ran');
		assert.strictEqual(await attempt('b'), 'cooldown', 'the global cooldown holds back another viewer');

		now += 11_000;
		assert.strictEqual(await attempt('a'), 'cooldown', 'the per-viewer cooldown holds back the first viewer');
		assert.strictEqual(await attempt('b'), 'ran');
		assert.strictEqual(await attempt('me', ['broadcaster']), 'ran', 'the broadcaster is never held back');

		config.commands = { theme: { cooldownSeconds: 0, userCooldownSeconds: 0 } };
		assert.strictEqual(await attempt('a'), 'ran');
	});

	test('waits out the delay for viewers, and a removed message is cancelled', async () => {
		config.delaySeconds = 0.05;
		controls.register(command());
		const kept = chat('!theme kept', { userId: 'a' });
		const deleted = chat('!theme deleted', { userId: 'b' });
		const purged = chat('!theme purged', { userId: 'c' });
		send(kept, deleted, purged);
		assert.deepStrictEqual(outcomes(), ['accepted', 'accepted', 'accepted']);
		events.fire([
			{ type: 'delete', key: deleted.key },
			{ type: 'purge', platform: 'twitch', channelId: 'c1', userId: 'c' },
		]);
		await waitFor(() => runs.length === 1, 'the kept command to run');
		await delay(60);
		assert.deepStrictEqual(
			runs.map((run) => run.args),
			['kept'],
		);
		assert.strictEqual(reports.filter((report) => report.outcome === 'cancelled').length, 2);
	});

	test('moderators and the broadcaster skip the delay', () => {
		config.delaySeconds = 30;
		controls.register(command());
		send(chat('!theme', { roles: ['moderator'] }));
		assert.strictEqual(runs.length, 1);
	});

	test('pausing drops waiting commands, refuses new ones, and is remembered', async () => {
		config.delaySeconds = 0.05;
		controls.register(command());
		let changes = 0;
		controls.onDidChangeState(() => changes++);
		send(chat('!theme'));
		await controls.setPaused(true);
		assert.strictEqual(changes, 1);
		assert.strictEqual(controls.active, false);
		send(chat('!theme'));
		await delay(80);
		assert.deepStrictEqual(outcomes(), ['accepted', 'cancelled', 'paused']);
		assert.strictEqual(runs.length, 0);
		assert.strictEqual(state.get('caerwyn.controls.paused'), true);

		const reloaded = new ChatControls({
			onEvents: events.event,
			isOwnSource: () => true,
			getConfig: () => config,
			state,
			log: () => undefined,
		});
		assert.strictEqual(reloaded.paused, true, 'a reload does not quietly resume');
		reloaded.dispose();
	});

	test('switching controls off cancels waiting commands', async () => {
		config.delaySeconds = 0.05;
		controls.register(command());
		send(chat('!theme'));
		config.enabled = false;
		controls.refreshConfig();
		await delay(80);
		assert.deepStrictEqual(outcomes(), ['accepted', 'cancelled']);
	});

	test('reports a failing command and keeps going', async () => {
		controls.register(
			command({
				run: async () => {
					throw new Error('no such theme');
				},
			}),
		);
		controls.register(command({ name: 'boom', run: () => { throw new Error('sync'); } }));
		send(chat('!theme', { userId: 'a' }), chat('!boom', { userId: 'b' }));
		await waitFor(() => outcomes().length === 2, 'both failures');
		assert.deepStrictEqual(outcomes(), ['failed', 'failed']);
		assert.deepStrictEqual(reports.map((report) => report.detail).sort(), ['no such theme', 'sync']);
	});

	test('a broken listener never stops other listeners getting the events', () => {
		let seen = 0;
		controls.register(command());
		const throwing = new ChatControls({
			onEvents: events.event,
			isOwnSource: () => {
				throw new Error('broken');
			},
			getConfig: () => config,
			state,
			log: () => undefined,
		});
		events.event(() => seen++);
		send(chat('!theme'));
		assert.strictEqual(seen, 1);
		throwing.dispose();
	});

	test('settings of the wrong type fall back to the safe choice', async () => {
		controls.register(command());
		const setConfig = (raw: Record<string, unknown>) => {
			config = raw as unknown as ChatControlsConfig;
		};

		setConfig({ enabled: 'false', delaySeconds: 0, commands: {} });
		assert.strictEqual(controls.enabled, false, 'only `true` switches controls on');
		send(chat('!theme'));
		assert.deepStrictEqual(reports, []);

		setConfig({ enabled: true, delaySeconds: '0', commands: null });
		send(chat('!theme'));
		assert.deepStrictEqual(outcomes(), ['accepted'], 'a delay that is not a number keeps the default, not none');
		await controls.setPaused(true);
		await controls.setPaused(false);

		setConfig({ enabled: true, delaySeconds: 0, commands: { theme: 'off' } });
		send(chat('!theme', { userId: 'b' }));
		await waitFor(() => runs.length === 1, 'the command, with its unreadable settings ignored');
	});

	test('a rejected or failed command gives its cooldowns back; the broadcaster charges none', async () => {
		let reject = true;
		controls.register(
			command({
				defaults: { allowed: 'everyone', cooldownSeconds: 30, userCooldownSeconds: 60 },
				run: (invocation) => {
					if (reject) {
						throw new CommandRejected(`no theme called ${invocation.args}`);
					}
					runs.push(invocation);
				},
			}),
		);
		const attempt = async (args: string, userId = 'a', roles: Role[] = []) => {
			const message = chat(`!theme ${args}`, { userId, roles });
			send(message);
			await waitFor(() => reports.some((report) => report.message === message), `the outcome for ${args}`);
			return reports.find((report) => report.message === message);
		};

		const typo = await attempt('drakula');
		assert.strictEqual(typo?.outcome, 'rejected');
		assert.strictEqual(typo?.detail, 'no theme called drakula');
		reject = false;
		assert.strictEqual((await attempt('dracula'))?.outcome, 'ran', 'the typo did not use up the turn');
		assert.strictEqual((await attempt('again', 'b'))?.outcome, 'cooldown', 'a command that ran is charged');

		now += 31_000;
		assert.strictEqual((await attempt('mine', 'me', ['broadcaster']))?.outcome, 'ran');
		assert.strictEqual((await attempt('after', 'b'))?.outcome, 'ran', 'the broadcaster did not start the cooldown');
	});

	test('unregistering a command cancels its waiting invocations', async () => {
		config.delaySeconds = 0.05;
		const registration = controls.register(command());
		send(chat('!theme'));
		registration.dispose();
		await delay(80);
		assert.deepStrictEqual(outcomes(), ['accepted', 'cancelled']);
		assert.deepStrictEqual(controls.registered, []);
	});
});
