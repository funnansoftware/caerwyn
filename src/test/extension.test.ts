import * as assert from 'assert';
import * as vscode from 'vscode';
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
