import { Disposable, Emitter } from '../util/emitter';
import { ChatHistory, HistoryPage, HistoryQuery } from './history';
import { ModerationError, ModerationRequest } from './moderation';
import { SIMULATED_SOURCES, SimulatedChat, SimulatedEventKind, SimulatedSpeaker, simulatedClearEvents } from './simulation/simulatedChat';
import { TwitchChat } from './twitch/twitchChat';
import {
	ChatAuth,
	ChatEvent,
	ChatMessage,
	ChatSink,
	ChatSource,
	CommandFeedback,
	Platform,
	RealSource,
	SourceInfo,
	SourceStatus,
	TwitchSource,
	ViewerCounts,
	YouTubeSource,
} from './types';
import { YouTubeChat, YouTubeTransport } from './youtube/youtubeChat';

/** The subset of `vscode.Memento` this needs. */
export interface StateStore {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): Thenable<void>;
}

export interface ChatServiceConfig {
	maxMessages: number;
	youtubeTransport: YouTubeTransport;
	simulation: {
		enabled: boolean;
		/** Automatic messages per second; zero leaves only events requested by hand. */
		messagesPerSecond: number;
	};
}

export interface PlatformAuth extends ChatAuth {
	onDidChange(listener: () => void): Disposable;
}

export interface ChatServiceOptions {
	state: StateStore;
	twitchAuth: PlatformAuth;
	youtubeAuth: PlatformAuth;
	getConfig(): ChatServiceConfig;
	log(message: string): void;
	/** Where each viewer's messages are saved for their user card. Without it, nothing is saved. */
	history?: ChatHistory;
}

const SOURCES_KEY = 'caerwyn.sources';
/** Events are handed to listeners in batches, so a busy chat does not post one message at a time. */
const FLUSH_MS = 50;

/**
 * Owns the list of chat sources, the connections that read them, and a capped buffer of recent
 * messages. Connections only run between `start()` and `stop()`, that is while a chat view (see `acquire()`) is open.
 */
export class ChatService {
	private readonly eventsEmitter = new Emitter<ChatEvent[]>();
	private readonly sourcesEmitter = new Emitter<SourceInfo[]>();
	private readonly resetEmitter = new Emitter<void>();
	private readonly viewerCountsEmitter = new Emitter<ViewerCounts>();
	private readonly feedbackEmitter = new Emitter<{ key: string; feedback: CommandFeedback }>();
	readonly onEvents = this.eventsEmitter.event;
	readonly onSources = this.sourcesEmitter.event;
	readonly onReset = this.resetEmitter.event;
	/** Fires with every source's current viewer count whenever one changes. */
	readonly onViewerCounts = this.viewerCountsEmitter.event;
	/** Fires when a chat command's outcome is known or changes. */
	readonly onFeedback = this.feedbackEmitter.event;

	private sourceList: RealSource[];
	private readonly statuses = new Map<string, SourceStatus>();
	private readonly labels = new Map<string, string>();
	/** Each live source's viewer count. (`viewers` is something else: how many chat views are open.) */
	private readonly audience = new Map<string, number>();
	private audienceTimer: NodeJS.Timeout | undefined;
	private buffer: ChatMessage[] = [];
	private readonly keys = new Set<string>();
	/** What became of each chat command still in the buffer, by message key. */
	private readonly feedback = new Map<string, CommandFeedback>();
	private pending: ChatEvent[] = [];
	private flushTimer: NodeJS.Timeout | undefined;
	private readonly rebuildTimers = new Map<Platform, NodeJS.Timeout>();
	private running = false;
	private viewers = 0;
	private twitch: TwitchChat | undefined;
	private readonly youtube = new Map<string, YouTubeChat>();
	private simulating: boolean;
	private simulation: SimulatedChat | undefined;
	private readonly subscriptions: Disposable[];
	private readonly sink: ChatSink;

	constructor(private readonly options: ChatServiceOptions) {
		this.sourceList = options.state.get<RealSource[]>(SOURCES_KEY) ?? [];
		this.simulating = options.getConfig().simulation.enabled;
		this.sink = {
			event: (event) => this.onEvent(event),
			status: (sourceId, status, label) => this.onStatus(sourceId, status, label),
			viewers: (sourceId, count) => this.onViewers(sourceId, count),
			log: options.log,
		};
		this.subscriptions = [
			options.twitchAuth.onDidChange(() => this.scheduleRebuild('twitch')),
			options.youtubeAuth.onDidChange(() => this.scheduleRebuild('youtube')),
		];
	}

	get messages(): readonly ChatMessage[] {
		return this.buffer;
	}

	/** Whether simulated chat is switched on. */
	get isSimulating(): boolean {
		return this.simulating;
	}

	private get allSources(): ChatSource[] {
		return this.simulating ? [...this.sourceList, ...SIMULATED_SOURCES] : this.sourceList;
	}

	get sources(): SourceInfo[] {
		return this.allSources.map((source) => ({
			source,
			label: this.labels.get(source.id) ?? defaultLabel(source),
			status: this.statuses.get(source.id) ?? { state: 'idle' },
			canModerate: source.kind === 'simulated',
		}));
	}

	/** The outcome of every chat command still in the buffer, by message key, for a view that has just opened. */
	get commandFeedback(): Record<string, CommandFeedback> {
		return Object.fromEntries(this.feedback);
	}

	/** Records what became of the chat command in a message, for every view to show under it. */
	setFeedback(key: string, feedback: CommandFeedback): void {
		if (!this.keys.has(key)) {
			return; // Already removed or trimmed: there is nothing to show it under.
		}
		this.feedback.set(key, feedback);
		this.feedbackEmitter.fire({ key, feedback });
	}

	/** How many people watch each source that is live and shares its count. */
	get viewerCounts(): ViewerCounts {
		return Object.fromEntries(this.audience);
	}

	/**
	 * Registers a viewer (the chat tab, the sidebar view). Chat is read while at least one viewer is held,
	 * and the returned handle releases it; the last release disconnects.
	 */
	acquire(): Disposable {
		this.viewers++;
		this.start();
		let released = false;
		return {
			dispose: () => {
				if (released) {
					return;
				}
				released = true;
				if (--this.viewers === 0) {
					this.stop();
				}
			},
		};
	}

	start(): void {
		if (this.running) {
			return;
		}
		this.running = true;
		this.rebuild('twitch');
		this.rebuild('youtube');
		this.rebuildSimulation();
	}

	stop(): void {
		this.running = false;
		this.simulation?.dispose();
		this.simulation = undefined;
		for (const timer of this.rebuildTimers.values()) {
			clearTimeout(timer);
		}
		this.rebuildTimers.clear();
		this.disposeConnections('twitch');
		this.disposeConnections('youtube');
		this.statuses.clear();
		this.forgetViewers([...this.audience.keys()]);
		this.sourcesEmitter.fire(this.sources);
	}

	/** Adds a source unless it is already there. Returns whether it was added. */
	async addSource(source: RealSource): Promise<boolean> {
		if (this.sourceList.some((existing) => existing.id === source.id)) {
			return false;
		}
		this.sourceList = [...this.sourceList, source];
		await this.options.state.update(SOURCES_KEY, this.sourceList);
		this.sourcesEmitter.fire(this.sources);
		this.scheduleRebuild(source.platform);
		return true;
	}

	async removeSource(sourceId: string): Promise<void> {
		const source = this.sourceList.find((existing) => existing.id === sourceId);
		if (!source) {
			return;
		}
		this.sourceList = this.sourceList.filter((existing) => existing.id !== sourceId);
		this.statuses.delete(sourceId);
		this.labels.delete(sourceId);
		this.forgetViewers([sourceId]);
		await this.options.state.update(SOURCES_KEY, this.sourceList);
		this.sourcesEmitter.fire(this.sources);
		this.scheduleRebuild(source.platform);
	}

	reconnect(): void {
		if (this.running) {
			this.rebuild('twitch');
			this.rebuild('youtube');
		}
	}

	/** Picks up a change to the simulation setting. Turning it off also removes the simulated messages. */
	refreshConfig(): void {
		const enabled = this.options.getConfig().simulation.enabled;
		if (enabled === this.simulating) {
			return;
		}
		this.simulating = enabled;
		if (!enabled) {
			for (const source of SIMULATED_SOURCES) {
				this.statuses.delete(source.id);
			}
			this.forgetViewers(SIMULATED_SOURCES.map((source) => source.id));
			// Simulated chat must never linger next to real chat.
			simulatedClearEvents().forEach((event) => this.onEvent(event));
		}
		this.rebuildSimulation();
		this.sourcesEmitter.fire(this.sources);
	}

	/** Produces one simulated event now. Returns false when the simulation is not running. */
	simulate(kind: SimulatedEventKind): boolean {
		if (!this.simulation) {
			return false;
		}
		this.simulation.emit(kind);
		return true;
	}

	/** Sends a typed message as a simulated chatter. Returns false when the simulation is not running. */
	simulateMessage(platform: Platform, speaker: SimulatedSpeaker, text: string): boolean {
		if (!this.simulation) {
			return false;
		}
		this.simulation.say(platform, speaker, text);
		return true;
	}

	/** Whether a source is the user's own chat (their channel or broadcast, or simulated chat), not one they only read. */
	isOwnSource(sourceId: string): boolean {
		return this.allSources.some((source) => source.id === sourceId && (source.kind === 'self' || source.kind === 'simulated'));
	}

	/**
	 * Carries out a moderation request from the view. The removal reaches the view as ordinary chat events once
	 * the platform reports it, so every open view updates, not only the one that asked.
	 * Throws `ModerationError` when the source cannot moderate.
	 */
	async moderate(request: ModerationRequest): Promise<void> {
		try {
			await this.moderateSource(request);
			this.options.log(`Moderation: ${request.action.type} in ${request.sourceId}`);
		} catch (error) {
			this.options.log(`Moderation refused: ${request.action.type} in ${request.sourceId}: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}

	private async moderateSource(request: ModerationRequest): Promise<void> {
		const source = this.allSources.find((candidate) => candidate.id === request.sourceId);
		if (!source) {
			throw new ModerationError('That chat is no longer connected.');
		}
		const { action } = request;
		if (action.type === 'automod') {
			// The platform's message ID comes from our own copy, never from the view.
			const held = this.buffer.find((message) => message.key === action.messageKey && message.sourceId === source.id)?.held;
			if (held?.state !== 'held') {
				throw new ModerationError('That message is no longer held.');
			}
			if (source.kind === 'simulated') {
				this.requireSimulation().moderate(source.platform, action);
				return;
			}
			if (source.platform !== 'twitch' || !this.twitch) {
				throw new ModerationError('That chat is no longer connected.');
			}
			await this.twitch.resolveHeld(held.messageId, action.allow);
			return;
		}
		if (action.type === 'delete' && this.buffer.some((message) => message.key === action.messageKey && message.sourceId !== source.id)) {
			throw new ModerationError('That message is not in this chat.');
		}
		if (source.kind === 'simulated') {
			this.requireSimulation().moderate(source.platform, action);
			return;
		}
		// Real moderation needs the platforms' moderation APIs and broader sign-in scopes; see `TWITCH_SCOPES`.
		throw new ModerationError(`Moderating ${source.platform === 'twitch' ? 'Twitch' : 'YouTube'} chat is not available yet.`);
	}

	private requireSimulation(): SimulatedChat {
		if (!this.simulation) {
			throw new ModerationError('Simulated chat is not running.');
		}
		return this.simulation;
	}

	/** A page of one viewer's saved messages. Simulated chat is never saved, so its pages are empty. */
	async history(query: HistoryQuery): Promise<HistoryPage> {
		if (!this.options.history || this.isSimulated(query.sourceId)) {
			return { entries: [], more: false, total: 0 };
		}
		return this.options.history.page(query);
	}

	private isSimulated(sourceId: string): boolean {
		return SIMULATED_SOURCES.some((source) => source.id === sourceId);
	}

	clearMessages(): void {
		this.buffer = [];
		this.keys.clear();
		this.feedback.clear();
		this.pending = [];
		this.simulation?.forget();
		this.resetEmitter.fire();
	}

	dispose(): void {
		this.stop();
		clearTimeout(this.flushTimer);
		clearTimeout(this.audienceTimer);
		for (const subscription of this.subscriptions) {
			subscription.dispose();
		}
		this.eventsEmitter.dispose();
		this.sourcesEmitter.dispose();
		this.resetEmitter.dispose();
		this.viewerCountsEmitter.dispose();
		this.feedbackEmitter.dispose();
	}

	/** Coalesces rebuilds, so signing in and adding the account's own source reconnects only once. */
	private scheduleRebuild(platform: Platform): void {
		if (!this.running) {
			return;
		}
		clearTimeout(this.rebuildTimers.get(platform));
		this.rebuildTimers.set(
			platform,
			setTimeout(() => {
				this.rebuildTimers.delete(platform);
				this.rebuild(platform);
			}, FLUSH_MS),
		);
	}

	private rebuild(platform: Platform): void {
		this.disposeConnections(platform);
		if (!this.running) {
			return;
		}
		if (platform === 'twitch') {
			const sources = this.sourceList.filter((source): source is TwitchSource => source.platform === 'twitch');
			if (sources.length > 0) {
				this.twitch = new TwitchChat({ auth: this.options.twitchAuth, sources, sink: this.sink });
				this.twitch.start();
			}
			return;
		}
		const transport = this.options.getConfig().youtubeTransport;
		for (const source of this.sourceList) {
			if (source.platform === 'youtube') {
				const chat = new YouTubeChat({ auth: this.options.youtubeAuth, source: source as YouTubeSource, sink: this.sink, transport });
				this.youtube.set(source.id, chat);
				chat.start();
			}
		}
	}

	private rebuildSimulation(): void {
		this.simulation?.dispose();
		this.simulation = undefined;
		if (this.running && this.simulating) {
			this.simulation = new SimulatedChat({
				sink: this.sink,
				getRate: () => this.options.getConfig().simulation.messagesPerSecond,
			});
			this.simulation.start();
		}
	}

	private disposeConnections(platform: Platform): void {
		// Disposed connections stay quiet, so they cannot clear the counts they reported.
		this.forgetViewers(this.sourceList.filter((source) => source.platform === platform).map((source) => source.id));
		if (platform === 'twitch') {
			this.twitch?.dispose();
			this.twitch = undefined;
			return;
		}
		for (const chat of this.youtube.values()) {
			chat.dispose();
		}
		this.youtube.clear();
	}

	private onStatus(sourceId: string, status: SourceStatus, label?: string): void {
		if (!this.allSources.some((source) => source.id === sourceId)) {
			return;
		}
		this.statuses.set(sourceId, status);
		if (label) {
			this.labels.set(sourceId, label);
		}
		this.sourcesEmitter.fire(this.sources);
	}

	private onViewers(sourceId: string, count: number | undefined): void {
		if (count === undefined) {
			this.forgetViewers([sourceId]);
			return;
		}
		if (!this.allSources.some((source) => source.id === sourceId) || this.audience.get(sourceId) === count) {
			return;
		}
		this.audience.set(sourceId, count);
		this.scheduleViewerCounts();
	}

	private forgetViewers(sourceIds: string[]): void {
		let changed = false;
		for (const id of sourceIds) {
			changed = this.audience.delete(id) || changed;
		}
		if (changed) {
			this.scheduleViewerCounts();
		}
	}

	/** Coalesces counts that arrive together, such as every Twitch channel from one request. */
	private scheduleViewerCounts(): void {
		this.audienceTimer ??= setTimeout(() => {
			this.audienceTimer = undefined;
			this.viewerCountsEmitter.fire(this.viewerCounts);
		}, FLUSH_MS);
	}

	private onEvent(event: ChatEvent): void {
		switch (event.type) {
			case 'message': {
				if (this.keys.has(event.message.key)) {
					return; // Platforms can deliver a message more than once.
				}
				this.keys.add(event.message.key);
				this.buffer.push(event.message);
				const max = Math.max(1, this.options.getConfig().maxMessages);
				while (this.buffer.length > max) {
					this.forget((this.buffer.shift() as ChatMessage).key);
				}
				break;
			}
			case 'update': {
				const index = this.buffer.findIndex((message) => message.key === event.message.key);
				if (index < 0) {
					return; // Removed, or never seen: there is nothing to update.
				}
				this.buffer[index] = event.message;
				break;
			}
			case 'delete':
				this.drop((message) => message.key === event.key);
				break;
			case 'purge':
				this.drop(
					(message) =>
						message.platform === event.platform && message.channelId === event.channelId && message.author.id === event.userId,
				);
				break;
			case 'clear':
				this.drop((message) => message.platform === event.platform && message.channelId === event.channelId);
				break;
		}
		this.recordHistory(event);
		this.pending.push(event);
		this.flushTimer ??= setTimeout(() => {
			this.flushTimer = undefined;
			const events = this.pending;
			this.pending = [];
			if (events.length > 0) {
				this.eventsEmitter.fire(events);
			}
		}, FLUSH_MS);
	}

	/** Saves real chat for the user card. Simulated chat must never be mistaken for real, so it is not saved. */
	private recordHistory(event: ChatEvent): void {
		if ((event.type === 'message' || event.type === 'update') && this.isSimulated(event.message.sourceId)) {
			return;
		}
		this.options.history?.record(event);
	}

	private forget(key: string): void {
		this.keys.delete(key);
		this.feedback.delete(key);
	}

	/** Removed messages leave the buffer, so reopening the tab never shows them again. */
	private drop(predicate: (message: ChatMessage) => boolean): void {
		this.buffer = this.buffer.filter((message) => {
			if (!predicate(message)) {
				return true;
			}
			this.forget(message.key);
			return false;
		});
	}
}

export function defaultLabel(source: ChatSource): string {
	if (source.kind === 'simulated') {
		return source.platform === 'twitch' ? 'Simulated Twitch' : 'Simulated YouTube';
	}
	if (source.kind === 'self') {
		return source.platform === 'twitch' ? 'Your Twitch channel' : 'Your YouTube broadcast';
	}
	return source.kind === 'channel' ? source.login : source.videoId;
}
