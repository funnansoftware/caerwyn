import * as vscode from 'vscode';
import { AuthSession } from './auth/authSession';
import { GoogleOAuth } from './auth/googleOAuth';
import { SignInPlatform, signIn, signOut } from './auth/signIn';
import { TwitchOAuth, validateTwitchToken } from './auth/twitchOAuth';
import { ChatService } from './chat/chatService';
import { ChatHistory } from './chat/history';
import {
	SIMULATED_ACTIONS,
	SIMULATED_EVENTS,
	SIMULATED_SOURCES,
	SIMULATED_SPEAKERS,
	SimulatedEventKind,
	SimulatedSpeaker,
	isSimulatedEventKind,
} from './chat/simulation/simulatedChat';
import { Account, Platform, RealSource, TWITCH_SELF, YOUTUBE_SELF, twitchChannelSource, youtubeVideoSource } from './chat/types';
import { parseVideoId } from './chat/youtube/videoId';
import { YouTubeTransport } from './chat/youtube/youtubeChat';
import { ChatCommand, ChatControls, CommandSettings, describeReport, parseCommandText } from './controls/chatControls';
import { ChatReplies } from './controls/chatReplies';
import { ControlsStatusBar } from './controls/controlsStatusBar';
import { registerHelp } from './controls/helpCommand';
import { DEFAULT_THEME_SECONDS, ThemeControl } from './controls/themeControl';
import { vscodeThemeHost } from './controls/vscodeThemeHost';
import { CHAT_VIEW_TYPE, ChatPanel } from './panel/chatPanel';
import { CHAT_SIDEBAR_VIEW_ID, ChatSidebar } from './panel/chatSidebar';
import { ChatWebview } from './panel/chatWebview';
import { asArray, asRecord, asString, readJsonObject } from './util/json';

// Reading chat, plus what the user's own channel needs: `channel:read:redemptions` and `bits:read` show what
// viewers spend, and `moderator:manage:automod` shows the messages AutoMod holds and lets the user allow or deny
// them, the only thing Caerwyn changes on Twitch. Other moderation will need broader scopes, and signing in again.
const TWITCH_SCOPES = ['user:read:chat', 'channel:read:redemptions', 'bits:read', 'moderator:manage:automod'];
/** Sending chat messages, for chat command replies. Asked for only while replies are switched on. */
const TWITCH_REPLY_SCOPE = 'user:write:chat';
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
	const body = await readJsonObject(res);
	if (!res.ok) {
		// Typically the YouTube Data API is not enabled for the Google Cloud project; Google's message says so.
		throw new Error(asString(asRecord(body.error)?.message) ?? `YouTube API returned HTTP ${res.status}`);
	}
	const channel = asRecord(asArray(body.items)[0]);
	return { id: asString(channel?.id) ?? '', label: asString(asRecord(channel?.snippet)?.title) ?? 'YouTube account' };
}

/** Accepts a channel name, `@name`, `#name` or a twitch.tv URL. */
function parseTwitchLogin(input: string): string | undefined {
	const text = input.trim().replace(/^(https?:\/\/)?(www\.)?twitch\.tv\//i, '').replace(/^[@#]/, '').split(/[/?]/)[0];
	return TWITCH_LOGIN.test(text) ? text.toLowerCase() : undefined;
}

/** Kept so `deactivate` can put the user's color theme back before the window goes. */
let themeControl: ThemeControl | undefined;

/** Whether chat command replies are switched on. Only the exact values that switch them on count. */
function repliesOn(): boolean {
	const mode = vscode.workspace.getConfiguration('caerwyn.controls').get<unknown>('replies');
	return mode === 'problems' || mode === 'all';
}

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Caerwyn', { log: true });
	const log = (message: string) => output.info(message);

	const twitchAuth = new AuthSession({
		storageKey: 'caerwyn.twitch',
		secrets: context.secrets,
		oauth: new TwitchOAuth(),
		// Sending messages is asked for only when the user has switched replies on, so a sign-in never grants more.
		scopes: () => (repliesOn() ? [...TWITCH_SCOPES, TWITCH_REPLY_SCOPE] : TWITCH_SCOPES),
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

	const controls = new ChatControls({
		onEvents: service.onEvents,
		isOwnSource: (sourceId) => service.isOwnSource(sourceId),
		state: context.globalState,
		getConfig: () => {
			const config = vscode.workspace.getConfiguration('caerwyn.controls');
			return {
				enabled: config.get<boolean>('enabled', false),
				delaySeconds: config.get<number>('delaySeconds', 5),
				commands: config.get<Record<string, CommandSettings>>('commands', {}),
			};
		},
		log,
	});

	// Every view shows what became of each command under its message, so the user can tell why one did nothing.
	const showFeedback = controls.onReport((report) => service.setFeedback(report.message.key, describeReport(report)));

	// Replies need a permission an older sign-in did not ask for. Asked about once, until the sign-in changes.
	let replySignInAsked = false;
	const askReplySignIn = async (force = false) => {
		if (replySignInAsked && !force) {
			return;
		}
		replySignInAsked = true;
		const answer = await vscode.window.showInformationMessage(
			'To reply to viewers, Caerwyn needs permission to send messages in your Twitch chat. Sign in to Twitch again to grant it.',
			'Sign In Again',
		);
		if (answer === 'Sign In Again') {
			await vscode.commands.executeCommand('caerwyn.signInTwitch');
		}
	};
	const hasReplyPermission = async () => (await twitchAuth.grantedScopes())?.includes(TWITCH_REPLY_SCOPE) === true;
	const replies = new ChatReplies({
		onReport: controls.onReport,
		getMode: () => vscode.workspace.getConfiguration('caerwyn.controls').get<unknown>('replies'),
		readiness: async (message) => {
			if (message.platform !== 'twitch') {
				return 'unsupported';
			}
			if (SIMULATED_SOURCES.some((source) => source.id === message.sourceId)) {
				return 'ready';
			}
			// Checked here rather than learned from a refused request, which would cost a token refresh every time.
			return (await hasReplyPermission()) ? 'ready' : 'needsSignIn';
		},
		send: (message, text) => service.reply(message, text),
		onNeedsSignIn: () => void askReplySignIn(),
		log,
	});

	themeControl = new ThemeControl({
		controls,
		host: vscodeThemeHost(),
		state: context.globalState,
		getConfig: () => {
			const config = vscode.workspace.getConfiguration('caerwyn.controls.theme');
			return {
				durationSeconds: config.get<number>('durationSeconds', DEFAULT_THEME_SECONDS),
				// Checked by the theme control: a list of names, or short names mapped to names.
				choices: config.get<string[] | Record<string, string>>('choices', []),
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

	const offerControlsSettings = async () => {
		const answer = await vscode.window.showInformationMessage(
			'Chat controls are switched off. Switch on caerwyn.controls.enabled to let your chat run commands.',
			'Open Settings',
		);
		if (answer === 'Open Settings') {
			await vscode.commands.executeCommand('workbench.action.openSettings', 'caerwyn.controls');
		}
	};

	/** Shown once a session, the first time a viewer uses a command while chat controls are off. */
	let offNoticeShown = false;
	const OFF_NOTICE_KEY = 'caerwyn.controls.offNoticeDismissed';
	const noticeOff = controls.onReport(async (report) => {
		const simulated = SIMULATED_SOURCES.some((source) => source.id === report.message.sourceId);
		// Simulated commands are the user's own doing, and "Simulate Chat Command" already says so.
		if (report.outcome !== 'off' || simulated || offNoticeShown || context.globalState.get<boolean>(OFF_NOTICE_KEY)) {
			return;
		}
		offNoticeShown = true;
		const answer = await vscode.window.showInformationMessage(
			`${report.message.author.name} used !${report.command}, but chat controls are off, so nothing happened.`,
			'Turn On',
			"Don't Show Again",
		);
		if (answer === 'Turn On') {
			await vscode.workspace.getConfiguration('caerwyn').update('controls.enabled', true, vscode.ConfigurationTarget.Global);
		} else if (answer === "Don't Show Again") {
			await context.globalState.update(OFF_NOTICE_KEY, true);
		}
	});

	const toggleChatControls = async () => {
		if (!controls.enabled) {
			await offerControlsSettings();
			return;
		}
		await controls.setPaused(!controls.paused);
	};

	const SPEAKER_LABELS: Record<SimulatedSpeaker, string> = {
		viewer: 'viewer',
		subscriber: 'subscriber',
		vip: 'VIP',
		moderator: 'moderator',
		broadcaster: 'broadcaster',
	};

	/** Sends a typed message, usually a chat command, as a simulated chatter. Arguments let tests skip the prompts. */
	const simulateChatCommand = async (text?: unknown, platform?: unknown, speaker?: unknown) => {
		let message = typeof text === 'string' ? text : undefined;
		message ??= await vscode.window.showInputBox({
			title: 'Simulate Chat Command',
			prompt: 'What the simulated chatter types',
			value: '!',
			valueSelection: [1, 1],
		});
		if (!message?.trim()) {
			return;
		}
		let from: { platform: Platform; speaker: SimulatedSpeaker } | undefined =
			(platform === 'twitch' || platform === 'youtube') && SIMULATED_SPEAKERS.includes(speaker as SimulatedSpeaker)
				? { platform, speaker: speaker as SimulatedSpeaker }
				: undefined;
		if (!from) {
			const choices = (['twitch', 'youtube'] as const).flatMap((p) =>
				SIMULATED_SPEAKERS.filter((s) => p === 'twitch' || s !== 'vip').map((s) => ({
					label: `${p === 'twitch' ? 'Twitch' : 'YouTube'} ${p === 'youtube' && s === 'subscriber' ? 'member' : SPEAKER_LABELS[s]}`,
					from: { platform: p, speaker: s },
				})),
			);
			from = (await vscode.window.showQuickPick(choices, { title: 'Simulate Chat Command: sent by' }))?.from;
		}
		if (!from) {
			return;
		}
		if (!service.isSimulating) {
			await setSimulation(true);
		}
		showChat();
		service.simulateMessage(from.platform, from.speaker, message);
		// Chat controls are quiet about commands they do not know, as other bots' commands are everywhere. Here the
		// user is trying one on purpose, so say why nothing happens.
		const parsed = parseCommandText(message);
		if (!controls.enabled) {
			void offerControlsSettings();
		} else if (parsed && !controls.isRegistered(parsed.name)) {
			const names = controls.registered.map((command) => `!${command.name}`).join(', ');
			void vscode.window.showInformationMessage(
				`!${parsed.name} is not a chat command. ${names ? `Available: ${names}.` : 'No chat commands are available yet.'}`,
			);
		}
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
		// Before the service, so no command waiting out its delay runs once chat is gone.
		new ControlsStatusBar(controls, service),
		replies,
		registerHelp(controls),
		showFeedback,
		noticeOff,
		themeControl,
		{ dispose: () => controls.dispose() },
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
		vscode.commands.registerCommand('caerwyn.toggleChatControls', toggleChatControls),
		vscode.commands.registerCommand('caerwyn.simulateChatCommand', simulateChatCommand),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('caerwyn.youtube.transport')) {
				service.reconnect();
			}
			if (event.affectsConfiguration('caerwyn.simulation')) {
				service.refreshConfig();
			}
			if (event.affectsConfiguration('caerwyn.controls')) {
				controls.refreshConfig();
			}
			if (event.affectsConfiguration('caerwyn.controls.replies') && repliesOn()) {
				void (async () => {
					// Switching replies on is the moment to ask, rather than when the first viewer is left unanswered.
					if ((await twitchAuth.getAccount()) && !(await hasReplyPermission())) {
						await askReplySignIn(true);
					}
				})();
			}
		}),
		twitchAuth.onDidChange(() => {
			replySignInAsked = false;
		}),
		// Lets VS Code restore the chat tab, and the layout it was part of, after a restart.
		vscode.window.registerWebviewPanelSerializer(CHAT_VIEW_TYPE, {
			deserializeWebviewPanel: async (panel) => ChatPanel.revive(panel, context, service),
		}),
	);

	// Exposed for the extension tests, which cannot otherwise see inside the webview or the chat controls.
	return {
		chatViewReadyCount: () => ChatWebview.readyCount,
		registerChatCommand: (command: ChatCommand) => controls.register(command),
		chatControlsPaused: () => controls.paused,
		chatMessages: () => service.messages,
	};
}

export function deactivate(): Promise<void> | undefined {
	return themeControl?.shutdown();
}
