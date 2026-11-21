import * as vscode from 'vscode';
import { AuthSession } from './auth/authSession';
import { GoogleOAuth } from './auth/googleOAuth';
import { SignInPlatform, signIn, signOut } from './auth/signIn';
import { TwitchOAuth, validateTwitchToken } from './auth/twitchOAuth';
import { ChatService } from './chat/chatService';
import { Account, ChatSource, TWITCH_SELF, YOUTUBE_SELF, twitchChannelSource, youtubeVideoSource } from './chat/types';
import { parseVideoId } from './chat/youtube/videoId';
import { YouTubeTransport } from './chat/youtube/youtubeChat';
import { CHAT_VIEW_TYPE, ChatPanel } from './panel/chatPanel';

// Read-only scopes. Sending and moderating will need broader ones, and signing in again.
const TWITCH_SCOPES = ['user:read:chat'];
const YOUTUBE_SCOPES = ['https://www.googleapis.com/auth/youtube.readonly'];
const TWITCH_LOGIN = /^[A-Za-z0-9_]{1,25}$/;

async function identifyTwitch(accessToken: string): Promise<Account> {
	const info = await validateTwitchToken(accessToken);
	if (!info) {
		throw new Error('Twitch rejected the new token.');
	}
	return { id: info.userId, label: info.login };
}

async function identifyYouTube(accessToken: string): Promise<Account> {
	const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	const body = (await res.json().catch(() => ({}))) as {
		error?: { message?: string };
		items?: { id?: string; snippet?: { title?: string } }[];
	};
	if (!res.ok) {
		// Typically the YouTube Data API is not enabled for the Google Cloud project; Google's message says so.
		throw new Error(body.error?.message ?? `YouTube API returned HTTP ${res.status}`);
	}
	const channel = body.items?.[0];
	return { id: channel?.id ?? '', label: channel?.snippet?.title ?? 'YouTube account' };
}

/** Accepts a channel name, `@name`, `#name` or a twitch.tv URL. */
function parseTwitchLogin(input: string): string | undefined {
	const text = input.trim().replace(/^(https?:\/\/)?(www\.)?twitch\.tv\//i, '').replace(/^[@#]/, '').split(/[/?]/)[0];
	return TWITCH_LOGIN.test(text) ? text.toLowerCase() : undefined;
}

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Caerwyn', { log: true });
	const log = (message: string) => output.info(message);

	const twitchAuth = new AuthSession({
		storageKey: 'caerwyn.twitch',
		secrets: context.secrets,
		oauth: new TwitchOAuth(),
		scopes: TWITCH_SCOPES,
		identify: identifyTwitch,
		validate: async (token) => (await validateTwitchToken(token)) !== undefined,
		apiHeaders: (creds) => ({ 'Client-Id': creds.clientId }),
		log,
	});
	const youtubeAuth = new AuthSession({
		storageKey: 'caerwyn.youtube',
		secrets: context.secrets,
		oauth: new GoogleOAuth(),
		scopes: YOUTUBE_SCOPES,
		identify: identifyYouTube,
		log,
	});

	const twitch: SignInPlatform = {
		name: 'Twitch',
		auth: twitchAuth,
		needsSecret: false,
		credentialsHint: 'From your application at dev.twitch.tv/console. See the Caerwyn README for setup.',
		codeEntry: false,
	};
	const youtube: SignInPlatform = {
		name: 'YouTube',
		auth: youtubeAuth,
		needsSecret: true,
		credentialsHint: 'From your "TVs and Limited Input devices" OAuth client in Google Cloud Console. See the Caerwyn README for setup.',
		codeEntry: true,
	};

	const service = new ChatService({
		state: context.globalState,
		twitchAuth,
		youtubeAuth,
		getConfig: () => {
			const config = vscode.workspace.getConfiguration('caerwyn');
			return {
				maxMessages: config.get<number>('maxMessages', 500),
				youtubeTransport: config.get<YouTubeTransport>('youtube.transport', 'stream'),
			};
		},
		log,
	});

	const openChat = () => ChatPanel.show(context, service);

	const addSource = async (source: ChatSource) => {
		await service.addSource(source);
		openChat();
	};

	const signInAndShow = async (platform: SignInPlatform, own: ChatSource) => {
		if (await signIn(platform)) {
			await addSource(own);
		}
	};

	const addTwitchChannel = async (channel?: string) => {
		const input =
			channel ??
			(await vscode.window.showInputBox({
				title: 'Add Twitch Channel',
				prompt: 'Channel name or twitch.tv URL',
				validateInput: (value) => (parseTwitchLogin(value) ? undefined : 'Enter a Twitch channel name.'),
			}));
		const login = input && parseTwitchLogin(input);
		if (login) {
			await addSource(twitchChannelSource(login));
		}
	};

	const addYouTubeStream = async (video?: string) => {
		const input =
			video ??
			(await vscode.window.showInputBox({
				title: 'Add YouTube Stream',
				prompt: 'Live stream URL or video ID',
				validateInput: (value) => (parseVideoId(value) ? undefined : 'Enter a YouTube live stream URL or video ID.'),
			}));
		const videoId = input && parseVideoId(input);
		if (videoId) {
			await addSource(youtubeVideoSource(videoId));
		}
	};

	const removeSource = async () => {
		const sources = service.sources;
		if (sources.length === 0) {
			void vscode.window.showInformationMessage('There are no chat sources to remove.');
			return;
		}
		const picked = await vscode.window.showQuickPick(
			sources.map((info) => ({
				label: info.label,
				description: info.source.platform === 'twitch' ? 'Twitch' : 'YouTube',
				id: info.source.id,
			})),
			{ title: 'Remove Chat Source' },
		);
		if (picked) {
			await service.removeSource(picked.id);
		}
	};

	context.subscriptions.push(
		output,
		{ dispose: () => service.dispose() },
		vscode.commands.registerCommand('caerwyn.openChat', openChat),
		vscode.commands.registerCommand('caerwyn.signInTwitch', () => signInAndShow(twitch, TWITCH_SELF)),
		vscode.commands.registerCommand('caerwyn.signOutTwitch', () => signOut(twitch)),
		vscode.commands.registerCommand('caerwyn.signInYouTube', () => signInAndShow(youtube, YOUTUBE_SELF)),
		vscode.commands.registerCommand('caerwyn.signOutYouTube', () => signOut(youtube)),
		vscode.commands.registerCommand('caerwyn.addTwitchChannel', addTwitchChannel),
		vscode.commands.registerCommand('caerwyn.addYouTubeStream', addYouTubeStream),
		vscode.commands.registerCommand('caerwyn.removeSource', removeSource),
		vscode.commands.registerCommand('caerwyn.reconnect', () => service.reconnect()),
		vscode.commands.registerCommand('caerwyn.clearChat', () => service.clearMessages()),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('caerwyn.youtube.transport')) {
				service.reconnect();
			}
		}),
		// Lets VS Code restore the chat tab, and the layout it was part of, after a restart.
		vscode.window.registerWebviewPanelSerializer(CHAT_VIEW_TYPE, {
			deserializeWebviewPanel: async (panel) => ChatPanel.revive(panel, context, service),
		}),
	);

	// Exposed for the extension tests, which cannot otherwise see inside the webview.
	return { chatViewReadyCount: () => ChatPanel.readyCount };
}

export function deactivate() {}
