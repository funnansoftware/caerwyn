import * as assert from 'assert';
import type { StateStore } from '../chat/chatService';
import { ChatEvent, ChatMessage, Role } from '../chat/types';
import { AUDIENCES, ChatControls, ChatControlsConfig, ControlOutcome, ControlReport, parseCommand } from '../controls/chatControls';
import { ChatReplies, MAX_REPLY, REPLY_BUDGET, ReplyReadiness, compose } from '../controls/chatReplies';
import { registerHelp } from '../controls/helpCommand';
import { Emitter } from '../util/emitter';
import { waitFor } from './helpers';

class MemoryState implements StateStore {
	readonly values = new Map<string, unknown>();
	get<T>(key: string): T | undefined {
		return this.values.get(key) as T | undefined;
	}
	async update(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}
}

const MARKER = 'zz-marker-zz';
let counter = 0;

function chat(text: string, userId = 'u1', roles: Role[] = []): ChatMessage {
	const id = `m${++counter}`;
	return {
		key: `twitch:${id}`,
		platform: 'twitch',
		id,
		sourceId: 'twitch:me',
		channelId: 'c1',
		channelName: 'me',
		author: { id: userId, name: `${userId}${MARKER}`, roles },
		fragments: [{ type: 'text', text }],
		timestamp: Date.now(),
	};
}

const OUTCOMES: ControlOutcome[] = ['accepted', 'ran', 'rejected', 'failed', 'off', 'disabled', 'paused', 'denied', 'cooldown', 'cancelled', 'busy', 'stale'];

suite('Chat reply wording', () => {
	test('never repeats anything the viewer typed, whatever the outcome', () => {
		for (const outcome of OUTCOMES) {
			for (const mode of ['problems', 'all'] as const) {
				const report: ControlReport = {
					command: 'theme',
					message: chat(`!theme ${MARKER}`),
					outcome,
					detail: `No theme is called "${MARKER}".`,
					retryInSeconds: 40,
					audience: 'subscriber',
				};
				const text = compose(report, mode)?.text ?? '';
				assert.ok(!text.includes(MARKER), `${outcome} in ${mode}: ${text}`);
			}
		}
	});

	test('a reply can never be read back as a command, since it would come from the broadcaster', () => {
		const all: string[] = [];
		for (const outcome of OUTCOMES) {
			for (const text of ['!theme monokai', '!help']) {
				const report: ControlReport = { command: 'theme', message: chat('!x'), outcome, chat: { text, kind: outcome === 'ran' ? 'answer' : 'problem' }, retryInSeconds: 3, audience: 'vip' };
				const reply = compose(report, 'all')?.text;
				if (reply) {
					all.push(reply);
				}
			}
		}
		assert.ok(all.length > 0);
		for (const reply of all) {
			for (const message of [chat(reply), { ...chat(`@viewer ${reply}`), replyTo: { name: 'viewer', text: '!x' } }, { ...chat(reply), replyTo: { name: 'viewer', text: '!x' } }]) {
				assert.strictEqual(parseCommand(message), undefined, reply);
			}
		}
	});

	test('says why a command did not run, in fixed words or the command’s own chat text', () => {
		const say = (outcome: ControlOutcome, extra: Partial<ControlReport> = {}) =>
			compose({ command: 'theme', message: chat('!theme'), outcome, ...extra }, 'problems')?.text;
		assert.strictEqual(say('rejected', { chat: { text: 'There is no theme by that name. Try !help theme.', kind: 'problem' } }), '🤖 (caerwyn) There is no theme by that name. Try !help theme.');
		assert.strictEqual(say('rejected'), '🤖 (caerwyn) !theme could not do that.', 'a rejection without chat text gets a generic line');
		assert.strictEqual(say('failed'), '🤖 (caerwyn) !theme did not work this time.');
		assert.strictEqual(say('denied', { audience: 'vip' }), '🤖 (caerwyn) !theme is for VIPs and up.');
		assert.strictEqual(say('cooldown', { retryInSeconds: 40 }), '🤖 (caerwyn) !theme is cooling down. Try again in 40s.');
		assert.strictEqual(say('paused'), '🤖 (caerwyn) Chat commands are paused right now.');
		for (const quiet of ['off', 'disabled', 'accepted', 'cancelled', 'busy', 'stale'] as const) {
			assert.strictEqual(say(quiet), undefined, `${quiet} says nothing`);
		}
	});

	test('answers always; confirms what it did only when replying to everything', () => {
		const ran = (kind: 'answer' | 'confirmation', mode: 'problems' | 'all') =>
			compose({ command: 'x', message: chat('!x'), outcome: 'ran', chat: { text: 'hello', kind } }, mode)?.text;
		assert.strictEqual(ran('answer', 'problems'), '🤖 (caerwyn) hello');
		assert.strictEqual(ran('confirmation', 'problems'), undefined);
		assert.strictEqual(ran('confirmation', 'all'), '🤖 (caerwyn) hello');
		assert.strictEqual(compose({ command: 'x', message: chat('!x'), outcome: 'ran', detail: 'did it' }, 'all'), undefined, 'a summary alone is never said');
	});

	test('keeps a reply to one chat message', () => {
		const long = compose({ command: 'x', message: chat('!x'), outcome: 'ran', chat: { text: 'word '.repeat(200), kind: 'answer' } }, 'problems')?.text ?? '';
		assert.ok(long.length <= MAX_REPLY);
		assert.ok(long.endsWith('…'));
		assert.ok(!/\n/.test(compose({ command: 'x', message: chat('!x'), outcome: 'ran', chat: { text: 'a\nb', kind: 'answer' } }, 'problems')?.text ?? ''));
	});
});

suite('ChatReplies', () => {
	let reports: Emitter<ControlReport>;
	let mode: unknown;
	let readiness: ReplyReadiness;
	let sent: { to: string; text: string }[];
	let signInAsks: number;
	let logs: string[];
	let now: number;
	let failSend: boolean;
	let replies: ChatReplies;

	setup(() => {
		reports = new Emitter<ControlReport>();
		mode = 'problems';
		readiness = 'ready';
		sent = [];
		signInAsks = 0;
		logs = [];
		now = 1_000_000;
		failSend = false;
		replies = new ChatReplies({
			onReport: reports.event,
			getMode: () => mode,
			readiness: () => readiness,
			send: async (message, text) => {
				if (failSend) {
					throw new Error('Twitch did not send the message: slow mode');
				}
				sent.push({ to: message.author.id, text });
			},
			onNeedsSignIn: () => signInAsks++,
			log: (message) => logs.push(message),
			now: () => now,
		});
	});

	teardown(() => replies.dispose());

	const report = (outcome: ControlOutcome, userId = 'a', extra: Partial<ControlReport> = {}) =>
		reports.fire({ command: 'theme', message: chat('!theme', userId), outcome, ...extra });
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	test('stays quiet unless switched on with an exact value', async () => {
		for (const value of ['off', undefined, 'yes', true, 'PROBLEMS']) {
			mode = value;
			report('failed', `user-${String(value)}`);
		}
		await settle();
		assert.deepStrictEqual(sent, []);
		mode = 'problems';
		report('failed');
		await settle();
		assert.strictEqual(sent.length, 1);
	});

	test('tells each viewer about a problem at most once in a while, however often they retry', async () => {
		for (let i = 0; i < 5; i++) {
			report('rejected', 'spammer');
		}
		report('rejected', 'other');
		await settle();
		assert.deepStrictEqual(
			sent.map((entry) => entry.to),
			['spammer', 'other'],
			'one viewer cannot use up the budget for everyone',
		);
		now += 31_000;
		report('rejected', 'spammer');
		await settle();
		assert.strictEqual(sent.length, 3);
	});

	test('says "paused" once a minute to everyone together', async () => {
		report('paused', 'a');
		report('paused', 'b');
		now += 61_000;
		report('paused', 'c');
		await settle();
		assert.deepStrictEqual(
			sent.map((entry) => entry.to),
			['a', 'c'],
		);
	});

	test('drops replies beyond the budget instead of queueing them', async () => {
		for (let i = 0; i < REPLY_BUDGET + 3; i++) {
			report('ran', `v${i}`, { chat: { text: 'answer', kind: 'answer' } });
		}
		await settle();
		assert.strictEqual(sent.length, REPLY_BUDGET);
		assert.ok(logs.some((line) => line.includes('not sent')));
		now += 31_000;
		report('ran', 'later', { chat: { text: 'answer', kind: 'answer' } });
		await settle();
		assert.strictEqual(sent.length, REPLY_BUDGET + 1, 'the budget refills');
	});

	test('asks for sign-in instead of sending without permission, and skips chats that take no replies', async () => {
		readiness = 'needsSignIn';
		report('failed', 'a');
		readiness = 'unsupported';
		for (let i = 0; i < REPLY_BUDGET; i++) {
			report('ran', `youtube-${i}`, { chat: { text: 'answer', kind: 'answer' } });
		}
		await settle();
		assert.deepStrictEqual(sent, []);
		assert.strictEqual(signInAsks, 1);

		readiness = 'ready';
		report('ran', 'twitch', { chat: { text: 'answer', kind: 'answer' } });
		await settle();
		assert.strictEqual(sent.length, 1, 'replies that were never sent did not use up the budget');
	});

	test('logs a reply the platform would not send', async () => {
		failSend = true;
		report('failed');
		await settle();
		assert.ok(logs.some((line) => line.includes('slow mode')));
	});
});

suite('!help', () => {
	let events: Emitter<ChatEvent[]>;
	let config: ChatControlsConfig;
	let controls: ChatControls;
	let reports: ControlReport[];

	setup(() => {
		events = new Emitter<ChatEvent[]>();
		// Without `!help`'s own cooldowns, so one test can ask several times.
		config = { enabled: true, delaySeconds: 0, commands: { help: { cooldownSeconds: 0, userCooldownSeconds: 0 } } };
		reports = [];
		controls = new ChatControls({ onEvents: events.event, isOwnSource: () => true, getConfig: () => config, state: new MemoryState(), log: () => undefined });
		controls.onReport((entry) => reports.push(entry));
		registerHelp(controls);
		controls.register({
			name: 'theme',
			description: 'switches the `theme`',
			usage: '!theme <name>',
			help: () => '!theme <name> switches the theme.',
			defaults: { allowed: 'everyone', cooldownSeconds: 0, userCooldownSeconds: 0 },
			run: () => undefined,
		});
		controls.register({
			name: 'secret',
			description: 'for mods',
			defaults: { allowed: 'moderator', cooldownSeconds: 0, userCooldownSeconds: 0 },
			run: () => undefined,
		});
	});

	teardown(() => controls.dispose());

	const ask = async (text: string, userId: string, roles: Role[] = []) => {
		const message = chat(text, userId, roles);
		events.fire([{ type: 'message', message }]);
		await waitFor(() => reports.some((entry) => entry.message === message), `the answer to ${text}`);
		return reports.find((entry) => entry.message === message);
	};

	test('lists only the commands the viewer asking may use', async () => {
		assert.strictEqual((await ask('!help', 'viewer'))?.chat?.text, 'Chat commands: !theme <name>, !help <command>.');
		assert.strictEqual((await ask('!help', 'mod', ['moderator']))?.chat?.text, 'Chat commands: !theme <name>, !secret, !help <command>.');
		config.commands = { ...config.commands, theme: { enabled: false } };
		assert.strictEqual((await ask('!commands', 'viewer2'))?.chat?.text, 'There are no chat commands you can use right now.');
	});

	test('explains one command, and gives the same answer for unknown and off-limits ones', async () => {
		assert.strictEqual((await ask('!help theme', 'a'))?.chat?.text, '!theme <name> switches the theme.');
		assert.strictEqual((await ask('!help !theme', 'b'))?.chat?.text, '!theme <name> switches the theme.');
		assert.strictEqual((await ask('!help secret', 'mod', ['moderator']))?.chat?.text, '!secret: for mods');
		const offLimits = await ask('!help secret', 'c');
		const unknown = await ask(`!help ${MARKER}`, 'd');
		assert.strictEqual(offLimits?.outcome, 'rejected');
		assert.deepStrictEqual(offLimits?.chat, unknown?.chat, 'asking does not reveal commands the viewer cannot use');
		assert.ok(!unknown?.chat?.text.includes(MARKER));
	});

	test('every audience reads naturally in a denial', () => {
		for (const audience of AUDIENCES) {
			const text = compose({ command: 'theme', message: chat('!theme'), outcome: 'denied', audience }, 'problems')?.text ?? '';
			assert.match(text, /^🤖 \(caerwyn\) !theme is (for|only for) .+\.$/);
		}
	});
});

suite('ChatControls and reply listeners', () => {
	test('a listener that throws neither fails a command that worked nor stops other listeners', async () => {
		const events = new Emitter<ChatEvent[]>();
		const controls = new ChatControls({
			onEvents: events.event,
			isOwnSource: () => true,
			getConfig: () => ({ enabled: true, delaySeconds: 0, commands: {} }),
			state: new MemoryState(),
			log: () => undefined,
		});
		const seen: ControlOutcome[] = [];
		controls.onReport(() => {
			throw new Error('broken listener');
		});
		controls.onReport((entry) => seen.push(entry.outcome));
		controls.register({ name: 'x', description: 'x', defaults: { allowed: 'everyone', cooldownSeconds: 0, userCooldownSeconds: 0 }, run: () => ({ answer: 'hi' }) });
		events.fire([{ type: 'message', message: chat('!x') }]);
		await waitFor(() => seen.length > 0, 'the report');
		assert.deepStrictEqual(seen, ['ran']);
		controls.dispose();
	});
});
