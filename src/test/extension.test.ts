import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', () => {
	test('activates and registers commands', async () => {
		const ext = vscode.extensions.getExtension('funnansoftware.caerwyn');
		assert.ok(ext, 'extension should be installed in the test host');
		await ext.activate();

		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('caerwyn.helloWorld'));
	});
});
