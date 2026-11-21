import * as vscode from 'vscode';

// Called the first time the extension is activated (e.g. when one of its commands is run).
export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand('caerwyn.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from Caerwyn!');
	});

	context.subscriptions.push(disposable);
}

// Called when the extension is deactivated.
export function deactivate() {}
