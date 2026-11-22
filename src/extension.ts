import * as vscode from 'vscode';
import { AuthSession } from './auth/authSession';
import { GoogleOAuth } from './auth/googleOAuth';
import { SignInPlatform, signIn, signOut } from './auth/signIn';
import { TwitchOAuth, validateTwitchToken } from './auth/twitchOAuth';
import { ChatService } from './chat/chatService';
import { ChatHistory } from './chat/history';
import { SIMULATED_ACTIONS, SIMULATED_EVENTS, SimulatedEventKind, isSimulatedEventKind } from './chat/simulation/simulatedChat';
import { Account, RealSource, TWITCH_SELF, YOUTUBE_SELF, twitchChannelSource, youtubeVideoSource } from './chat/types';
import { parseVideoId } from './chat/youtube/videoId';
import { YouTubeTransport } from './chat/youtube/youtubeChat';
import { CHAT_VIEW_TYPE, ChatPanel } from './panel/chatPanel';
import { CHAT_SIDEBAR_VIEW_ID, ChatSidebar } from './panel/chatSidebar';
import { ChatWebview } from './panel/chatWebview';

// Reading chat, plus what the user's own channel needs: `channel:read:redemptions` and `bits:read` show what
// viewers spend, and `moderator:manage:automod` shows the messages AutoMod holds and lets the user allow or deny
// them, the only thing Caerwyn changes on Twitch. Other moderation will need broader scopes, and signing in again.
const TWITCH_SCOPES = ['user:read:chat', 'channel:read:redemptions', 'bits:read', 'moderator:manage:automod'];
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

	const history = new ChatHistory({
		directory: vscode.Uri.joinPath(context.globalStorageUri, 'history').fsPath,
		isEnabled: () => vscode.workspace.getConfiguration('caerwyn').get<boolean>('history.enabled', true),
		log,
	});
	const service = new ChatService({
		state: context.globalState,
		history,
		twitchAuth,
		youtubeAuth,
		getConfig: () => {
			const config = vscode.workspace.getConfiguration('caerwyn');
			return {
				maxMessages: config.get<number>('maxMessages', 500),
				youtubeTransport: config.get<YouTubeTransport>('youtube.transport', 'stream'),
				simulation: {
					enabled: config.get<boolean>('simulation.enabled', false),
					messagesPerSecond: config.get<number>('simulation.messagesPerSecond', 2),
				},
			};
		},
		log,
	});

	const sidebar = new ChatSidebar(context, service);

	const openChat = () => ChatPanel.show(context, service);
	const openSidebar = () => sidebar.reveal();
	/** Shows the chat wherever the user already has it: the tab, else the visible sidebar, else a new tab. */
	const showChat = () => {
		if (!ChatPanel.isOpen && sidebar.isVisible) {
			void sidebar.reveal();
		} else {
			openChat();
		}
	};

	const addSource = async (source: RealSource) => {
		await service.addSource(source);
		showChat();
	};

	const signInAndShow = async (platform: SignInPlatform, own: RealSource) => {
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
		const sources = service.sources.filter((info) => info.source.kind !== 'simulated');
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

	const setSimulation = async (enabled: boolean) => {
		// A user setting, so the simulation is still on after the window reloads or the tab is restored.
		await vscode.workspace.getConfiguration('caerwyn').update('simulation.enabled', enabled, vscode.ConfigurationTarget.Global);
		service.refreshConfig();
		if (enabled) {
			showChat();
		}
	};

	const simulateEvent = async (requested?: unknown) => {
		let kind: SimulatedEventKind | undefined = isSimulatedEventKind(requested) ? requested : undefined;
		if (!kind) {
			const picked = await vscode.window.showQuickPick(
				[...SIMULATED_ACTIONS, ...SIMULATED_EVENTS].map((entry) => ({ label: entry.label, event: entry.kind })),
				{ title: 'Simulate Chat Event' },
			);
			kind = picked?.event;
		}
		if (!kind) {
			return;
		}
		if (!service.isSimulating) {
			await setSimulation(true);
		}
		showChat();
		service.simulate(kind);
	};

	const clearHistory = async () => {
		const answer = await vscode.window.showWarningMessage(
			'Delete every chat message Caerwyn has saved for user cards? Chat already on screen stays.',
			{ modal: true },
			'Delete',
		);
		if (answer === 'Delete') {
			await history.clear();
			void vscode.window.showInformationMessage('Saved chat history deleted.');
		}
	};

	context.subscriptions.push(
		output,
		{ dispose: () => service.dispose() },
		// After the service, so the last messages it handled are saved.
		history,
		vscode.commands.registerCommand('caerwyn.openChat', openChat),
		vscode.commands.registerCommand('caerwyn.openChatSidebar', openSidebar),
		vscode.window.registerWebviewViewProvider(CHAT_SIDEBAR_VIEW_ID, sidebar),
		vscode.commands.registerCommand('caerwyn.signInTwitch', () => signInAndShow(twitch, TWITCH_SELF)),
		vscode.commands.registerCommand('caerwyn.signOutTwitch', () => signOut(twitch)),
		vscode.commands.registerCommand('caerwyn.signInYouTube', () => signInAndShow(youtube, YOUTUBE_SELF)),
		vscode.commands.registerCommand('caerwyn.signOutYouTube', () => signOut(youtube)),
		vscode.commands.registerCommand('caerwyn.addTwitchChannel', addTwitchChannel),
		vscode.commands.registerCommand('caerwyn.addYouTubeStream', addYouTubeStream),
		vscode.commands.registerCommand('caerwyn.removeSource', removeSource),
		vscode.commands.registerCommand('caerwyn.reconnect', () => service.reconnect()),
		vscode.commands.registerCommand('caerwyn.clearChat', () => service.clearMessages()),
		vscode.commands.registerCommand('caerwyn.clearHistory', clearHistory),
		vscode.commands.registerCommand('caerwyn.toggleSimulation', () => setSimulation(!service.isSimulating)),
		vscode.commands.registerCommand('caerwyn.simulateEvent', simulateEvent),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('caerwyn.youtube.transport')) {
				service.reconnect();
			}
			if (event.affectsConfiguration('caerwyn.simulation')) {
				service.refreshConfig();
			}
		}),
		// Lets VS Code restore the chat tab, and the layout it was part of, after a restart.
		vscode.window.registerWebviewPanelSerializer(CHAT_VIEW_TYPE, {
			deserializeWebviewPanel: async (panel) => ChatPanel.revive(panel, context, service),
		}),
	);

	// Exposed for the extension tests, which cannot otherwise see inside the webview.
	return { chatViewReadyCount: () => ChatWebview.readyCount };
}

export function deactivate() {}
