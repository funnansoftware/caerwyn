import { Disposable } from '../util/emitter';
import { ChatCommand, ChatControls, CommandRejected, CommandResult } from './chatControls';

// `!help` lists the chat commands the viewer asking may use; `!help <command>` explains one.
// What it says is built from the commands' own fixed text, never from what the viewer typed.

export function registerHelp(controls: ChatControls): Disposable {
	const help: ChatCommand = {
		name: 'help',
		aliases: ['commands'],
		description: 'lists the chat commands a viewer may use, or explains one: `!help theme`.',
		usage: '!help <command>',
		help: () => '!help lists the commands you can use. !help <command> explains one, such as !help theme.',
		defaults: { allowed: 'everyone', cooldownSeconds: 5, userCooldownSeconds: 15 },
		run: ({ args, message }): CommandResult => {
			const roles = message.author.roles;
			const asked = args.trim().replace(/^!/, '').split(/\s+/)[0] ?? '';
			if (!asked) {
				const usable = controls.registered.filter((command) => command !== help && controls.canUse(command, roles));
				const list = [...usable, help].map((command) => command.usage ?? `!${command.name}`).join(', ');
				const text = usable.length > 0 ? `Chat commands: ${list}.` : 'There are no chat commands you can use right now.';
				return { summary: 'listed the commands', answer: text };
			}
			const command = controls.find(asked);
			if (!command || !controls.canUse(command, roles)) {
				// The same answer either way, so asking does not reveal commands the viewer cannot use.
				throw new CommandRejected(`No command "${asked}" that this viewer can use.`, 'There is no command by that name. Try !help.');
			}
			const text = command.help?.() ?? `${command.usage ?? `!${command.name}`}: ${plain(command.description)}`;
			return { summary: `explained !${command.name}`, answer: text };
		},
	};
	return controls.register(help);
}

/** A description without the Markdown the status bar tooltip uses. */
function plain(text: string): string {
	return text.replace(/`/g, '');
}
