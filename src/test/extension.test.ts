import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ChatCommand } from '../controls/chatControls';
import { delay, waitFor } from './helpers';

suite('Extension', () => {
	const isChatTab = (tab: vscode.Tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('caerwyn.chat');
	const chatTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(isChatTab);
	// The simulation setting is a user setting and outlives a test run, so make sure it starts and ends off.
	const resetSimulation = () =>
		vscode.workspace.getConfiguration('caerwyn').update('simulation.enabled', undefined, vscode.ConfigurationTarget.Global);

	suiteSetup(resetSimulation);
	suiteTeardown(resetSimulation);

	test('activates and registers its commands', async () => {
		const ext = vscode.extensions.getExtension('funnansoftware.caerwyn');
		assert.ok(ext, 'extension should be installed in the test host');
		await ext.activate();

		const commands = await vscode.commands.getCommands(true);
		const contributed = (ext.packageJSON.contributes.commands as { command: string }[]).map((entry) => entry.command);
		assert.ok(contributed.length > 0);
		for (const command of contributed) {
			assert.ok(commands.includes(command), `${command} should be registered`);
		}
	});

	test('opens the chat as an editor tab', async () => {
		await vscode.commands.executeCommand('caerwyn.openChat');
		const isChatTab = (tab: vscode.Tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('caerwyn.chat');
		const allTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs);
		const tabs = () => allTabs().filter(isChatTab);
		const describeTabs = () => allTabs().map((tab) => `${tab.label} (${(tab.input as { viewType?: string })?.viewType ?? typeof tab.input})`);
		// The tab model is updated asynchronously after the panel is created.
		await waitFor(() => tabs().length === 1, `the chat tab; open tabs: ${describeTabs().join(', ') || 'none'}`);
		assert.strictEqual(tabs()[0].label, 'Caerwyn Chat');

		// The webview posts `ready` as the last step of its script, so this shows the page loaded under its
		// content security policy and the script ran to the end.
		const api = vscode.extensions.getExtension('funnansoftware.caerwyn')?.exports as { chatViewReadyCount(): number };
		await waitFor(() => api.chatViewReadyCount() >= 1, 'the chat webview to report ready', 15000);

		// Opening again reveals the existing tab rather than creating a second one.
		await vscode.commands.executeCommand('caerwyn.openChat');
		await delay(200);
		assert.strictEqual(tabs().length, 1);

		await vscode.window.tabGroups.close(tabs());
		await waitFor(() => tabs().length === 0, 'the chat tab to close');
	});

	test('opens the chat in the sidebar and shares it with the tab', async () => {
		const api = vscode.extensions.getExtension('funnansoftware.caerwyn')?.exports as { chatViewReadyCount(): number };
		const before = api.chatViewReadyCount();
		await vscode.commands.executeCommand('caerwyn.openChatSidebar');
		await waitFor(() => api.chatViewReadyCount() > before, 'the sidebar webview to report ready', 15000);
		assert.strictEqual(chatTabs().length, 0, 'the sidebar does not open a tab');

		// The tab opens alongside it, and closing it leaves the sidebar view in place.
		const withSidebar = api.chatViewReadyCount();
		await vscode.commands.executeCommand('caerwyn.openChat');
		await waitFor(() => chatTabs().length === 1, 'the chat tab');
		await waitFor(() => api.chatViewReadyCount() > withSidebar, 'the tab webview to report ready', 15000);
		await vscode.window.tabGroups.close(chatTabs());
		await waitFor(() => chatTabs().length === 0, 'the chat tab to close');
		await vscode.commands.executeCommand('workbench.action.closeSidebar');
	});

	test('a simulated chat command runs through chat controls, and pausing stops the next one', async () => {
		const api = vscode.extensions.getExtension('funnansoftware.caerwyn')?.exports as {
			registerChatCommand(command: ChatCommand): vscode.Disposable;
			chatControlsPaused(): boolean;
		};
		const config = () => vscode.workspace.getConfiguration('caerwyn');
		const runs: string[] = [];
		const registration = api.registerChatCommand({
			name: 'e2e-test',
			description: 'records its arguments',
			defaults: { allowed: 'broadcaster', cooldownSeconds: 0, userCooldownSeconds: 0 },
			run: (invocation) => {
				runs.push(invocation.args);
			},
		});
		try {
			assert.strictEqual(api.chatControlsPaused(), false);
			await config().update('controls.enabled', true, vscode.ConfigurationTarget.Global);
			await config().update('simulation.messagesPerSecond', 0, vscode.ConfigurationTarget.Global);

			await vscode.commands.executeCommand('caerwyn.simulateChatCommand', '!e2e-test one', 'twitch', 'broadcaster');
			await waitFor(() => runs.length === 1, 'the simulated command to run');
			assert.deepStrictEqual(runs, ['one']);

			await vscode.commands.executeCommand('caerwyn.toggleChatControls');
			assert.strictEqual(api.chatControlsPaused(), true);
			await vscode.commands.executeCommand('caerwyn.simulateChatCommand', '!e2e-test two', 'twitch', 'broadcaster');
			await delay(300);
			assert.deepStrictEqual(runs, ['one'], 'nothing runs while paused');

			await vscode.commands.executeCommand('caerwyn.toggleChatControls');
			assert.strictEqual(api.chatControlsPaused(), false);
		} finally {
			registration.dispose();
			if (api.chatControlsPaused()) {
				await vscode.commands.executeCommand('caerwyn.toggleChatControls');
			}
			await config().update('controls.enabled', undefined, vscode.ConfigurationTarget.Global);
			await config().update('simulation.messagesPerSecond', undefined, vscode.ConfigurationTarget.Global);
			await resetSimulation();
			await vscode.window.tabGroups.close(chatTabs());
			await waitFor(() => chatTabs().length === 0, 'the chat tab to close');
		}
	});

	test('!theme changes the theme the editor shows, and pausing chat controls puts it back', async () => {
		const caerwyn = () => vscode.workspace.getConfiguration('caerwyn');
		const workbench = () => vscode.workspace.getConfiguration('workbench');
		const userTheme = () => workbench().inspect<string>('colorTheme')?.globalValue;
		assert.strictEqual(userTheme(), undefined, 'the test host starts on the default theme');
		const kindBefore = vscode.window.activeColorTheme.kind;
		assert.notStrictEqual(kindBefore, vscode.ColorThemeKind.Light, 'the default theme is not a light one');
		try {
			await caerwyn().update('controls.enabled', true, vscode.ConfigurationTarget.Global);
			await caerwyn().update('simulation.messagesPerSecond', 0, vscode.ConfigurationTarget.Global);

			await vscode.commands.executeCommand('caerwyn.simulateChatCommand', '!theme solarized light', 'twitch', 'broadcaster');
			await waitFor(() => vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light, 'the editor to show Solarized Light', 10000);
			assert.strictEqual(userTheme(), 'Solarized Light');

			await vscode.commands.executeCommand('caerwyn.toggleChatControls');
			await waitFor(() => userTheme() === undefined, 'the user’s theme setting to be put back');
			await waitFor(() => vscode.window.activeColorTheme.kind === kindBefore, 'the editor to show the default theme again', 10000);
			await vscode.commands.executeCommand('caerwyn.toggleChatControls');

			// Following the system's light or dark mode, VS Code shows the preferred theme for that mode instead.
			await vscode.workspace.getConfiguration('window').update('autoDetectColorScheme', true, vscode.ConfigurationTarget.Global);
			await delay(500);
			const systemDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
			const preference = systemDark ? 'preferredDarkColorTheme' : 'preferredLightColorTheme';
			// A theme of the other kind, so the change can be seen.
			const [pick, expectedKind] = systemDark ? ['Solarized Light', vscode.ColorThemeKind.Light] : ['Solarized Dark', vscode.ColorThemeKind.Dark];
			const kindFollowing = vscode.window.activeColorTheme.kind;
			await vscode.commands.executeCommand('caerwyn.simulateChatCommand', `!theme ${pick}`, 'twitch', 'broadcaster');
			await waitFor(() => vscode.window.activeColorTheme.kind === expectedKind, `the editor to show ${pick} while following the system`, 10000);
			assert.strictEqual(workbench().inspect<string>(preference)?.globalValue, pick);
			assert.strictEqual(userTheme(), undefined, 'workbench.colorTheme is left alone');

			await vscode.commands.executeCommand('caerwyn.toggleChatControls');
			await waitFor(() => workbench().inspect<string>(preference)?.globalValue === undefined, 'the preference to be put back');
			await waitFor(() => vscode.window.activeColorTheme.kind === kindFollowing, 'the system’s theme to show again', 10000);
		} finally {
			await vscode.workspace.getConfiguration('window').update('autoDetectColorScheme', undefined, vscode.ConfigurationTarget.Global);
			const api = vscode.extensions.getExtension('funnansoftware.caerwyn')?.exports as { chatControlsPaused(): boolean };
			if (api.chatControlsPaused()) {
				await vscode.commands.executeCommand('caerwyn.toggleChatControls');
			}
			await caerwyn().update('controls.enabled', undefined, vscode.ConfigurationTarget.Global);
			await caerwyn().update('simulation.messagesPerSecond', undefined, vscode.ConfigurationTarget.Global);
			await workbench().update('colorTheme', undefined, vscode.ConfigurationTarget.Global);
			await workbench().update('preferredDarkColorTheme', undefined, vscode.ConfigurationTarget.Global);
			await workbench().update('preferredLightColorTheme', undefined, vscode.ConfigurationTarget.Global);
			await resetSimulation();
			await vscode.window.tabGroups.close(chatTabs());
			await waitFor(() => chatTabs().length === 0, 'the chat tab to close');
		}
	});

	test('simulating an event switches simulation on, opens the tab and marks it as simulated', async () => {
		const enabled = () => vscode.workspace.getConfiguration('caerwyn').get<boolean>('simulation.enabled');
		assert.strictEqual(enabled(), false);

		await vscode.commands.executeCommand('caerwyn.simulateEvent', 'showcase');
		assert.strictEqual(enabled(), true, 'the setting is saved so the simulation survives a reload');
		await waitFor(() => chatTabs()[0]?.label === 'Caerwyn Chat (Simulated)', 'the tab to be marked as simulated');

		await vscode.commands.executeCommand('caerwyn.toggleSimulation');
		assert.strictEqual(enabled(), false);
		await waitFor(() => chatTabs()[0]?.label === 'Caerwyn Chat', 'the tab title to go back to normal');

		await vscode.window.tabGroups.close(chatTabs());
		await waitFor(() => chatTabs().length === 0, 'the chat tab to close');
	});
});
