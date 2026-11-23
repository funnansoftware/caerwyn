import * as vscode from 'vscode';
import { AuthSession } from './authSession';
import { AppCredentials, OAuthError, awaitDeviceAuthorization } from './oauth';

export interface SignInPlatform {
	name: string;
	auth: AuthSession;
	/** Whether the registered app has a client secret that sign-in needs. */
	needsSecret: boolean;
	/** Where the user finds the app's credentials, shown when asking for them. */
	credentialsHint: string;
	/** Whether the user must type the code on the verification page (otherwise the link carries it). */
	codeEntry: boolean;
}

async function promptCredentials(platform: SignInPlatform): Promise<AppCredentials | undefined> {
	// Inputs are masked: this window may be on stream.
	const clientId = await vscode.window.showInputBox({
		title: `${platform.name} sign-in: Client ID`,
		prompt: platform.credentialsHint,
		password: true,
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim() ? undefined : 'Enter the Client ID.'),
	});
	if (!clientId) {
		return undefined;
	}
	if (!platform.needsSecret) {
		return { clientId: clientId.trim() };
	}
	const clientSecret = await vscode.window.showInputBox({
		title: `${platform.name} sign-in: Client secret`,
		prompt: platform.credentialsHint,
		password: true,
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim() ? undefined : 'Enter the client secret.'),
	});
	return clientSecret ? { clientId: clientId.trim(), clientSecret: clientSecret.trim() } : undefined;
}

/** Runs the device sign-in flow. Returns whether the user ended up signed in. */
export async function signIn(platform: SignInPlatform): Promise<boolean> {
	const { auth, name } = platform;
	try {
		let creds = await auth.getCredentials();
		if (!creds) {
			creds = await promptCredentials(platform);
			if (!creds) {
				return false;
			}
			await auth.setCredentials(creds);
		}

		// Read once: the permissions can depend on settings, which must not change between the two requests.
		const scopes = auth.scopes;
		const device = await auth.oauth.requestDeviceCode(creds, scopes);

		// The code is never shown unless asked for, so it cannot leak onto a stream by accident.
		if (platform.codeEntry) {
			await vscode.env.clipboard.writeText(device.userCode);
		}
		const detail = platform.codeEntry
			? `A one-time code has been copied to your clipboard. Paste it on the ${name} page that opens, then approve access.`
			: `Approve access on the ${name} page that opens.`;
		const buttons = platform.codeEntry ? ['Open Browser', 'Show Code'] : ['Open Browser'];
		let choice = await vscode.window.showInformationMessage(`Sign in to ${name}`, { modal: true, detail }, ...buttons);
		if (choice === 'Show Code') {
			choice = await vscode.window.showInformationMessage(
				`${name} code: ${device.userCode}`,
				{ modal: true, detail: `Enter this code at ${device.verificationUri}` },
				'Open Browser',
			);
		}
		if (choice !== 'Open Browser') {
			return false;
		}
		await vscode.env.openExternal(vscode.Uri.parse(device.verificationUri, true));

		const tokens = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: `Waiting for ${name} approval in your browser…`, cancellable: true },
			(_progress, cancellation) => {
				const abort = new AbortController();
				cancellation.onCancellationRequested(() => abort.abort(new vscode.CancellationError()));
				return awaitDeviceAuthorization(auth.oauth, creds, device, scopes, abort.signal);
			},
		);
		const account = await auth.completeSignIn(tokens);
		void vscode.window.showInformationMessage(`Signed in to ${name} as ${account.label}.`);
		return true;
	} catch (err) {
		if (err instanceof vscode.CancellationError) {
			return false;
		}
		if (err instanceof OAuthError && err.kind === 'invalid_client') {
			const retry = await vscode.window.showErrorMessage(`${name} sign-in failed: ${err.message}`, 'Enter Credentials Again');
			if (retry) {
				await auth.signOut(true);
				return signIn(platform);
			}
			return false;
		}
		void vscode.window.showErrorMessage(`${name} sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

export async function signOut(platform: SignInPlatform): Promise<void> {
	const account = await platform.auth.getAccount();
	const hasApp = (await platform.auth.getCredentials()) !== undefined;
	if (!account && !hasApp) {
		void vscode.window.showInformationMessage(`You are not signed in to ${platform.name}.`);
		return;
	}
	const forget = 'Sign Out and Forget App Credentials';
	const choice = await vscode.window.showWarningMessage(
		account ? `Sign out of ${platform.name} (${account.label})?` : `Forget the stored ${platform.name} app credentials?`,
		{ modal: true },
		...(account ? ['Sign Out', forget] : [forget]),
	);
	if (choice) {
		await platform.auth.signOut(choice === forget);
	}
}
