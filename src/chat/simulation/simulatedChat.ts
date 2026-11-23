import { ModerationAction, ModerationError } from '../moderation';
import { TwitchChatEvent, mapChatMessage, mapNotification } from '../twitch/twitchMapper';
import { mapBitsUse } from '../twitch/twitchSpend';
import { AutomodEvent, mapAutomodHold, mapAutomodUpdate } from '../twitch/twitchAutomod';
import { ChatEvent, ChatMessage, ChatSink, Platform, SimulatedSource } from '../types';
import { YouTubeChatItem, mapYouTubeItem } from '../youtube/youtubeMapper';
import {
	CHAT_LINES,
	LONG_LINES,
	SPAM_LINE,
	SUPER_CHAT_AMOUNTS,
	TWITCH_BROADCASTER,
	TWITCH_CHATTERS,
	TWITCH_EMOTES,
	TWITCH_TROUBLEMAKER,
	TwitchChatter,
	YOUTUBE_CHATTERS,
	YOUTUBE_LINES,
	YOUTUBE_OWNER,
	YOUTUBE_TROUBLEMAKER,
	YouTubeChatter,
} from './sampleData';

// A stand-in for live chat, for building and refining features without signing in.
// It produces platform-shaped payloads and passes them through the real mappers, so whatever the
// mappers learn to do is exercised here too. The payload shapes follow the platform documentation;
// they are not recordings of real traffic.

export const SIMULATED_TWITCH: SimulatedSource = { id: 'twitch:simulated', platform: 'twitch', kind: 'simulated' };
export const SIMULATED_YOUTUBE: SimulatedSource = { id: 'youtube:simulated', platform: 'youtube', kind: 'simulated' };
export const SIMULATED_SOURCES = [SIMULATED_TWITCH, SIMULATED_YOUTUBE];

const TWITCH_CHANNEL_ID = 'simulated-twitch';
const YOUTUBE_CHAT_ID = 'simulated-youtube';
const YOUTUBE_CONTEXT = { sourceId: SIMULATED_YOUTUBE.id, liveChatId: YOUTUBE_CHAT_ID, channelName: YOUTUBE_OWNER.name };

/** Events that empty both simulated chat rooms, for when the simulation is switched off. */
export function simulatedClearEvents(): ChatEvent[] {
	return [
		{ type: 'clear', platform: 'twitch', channelId: TWITCH_CHANNEL_ID },
		{ type: 'clear', platform: 'youtube', channelId: YOUTUBE_CHAT_ID },
	];
}

/** Every event the simulator can produce on request, in the order the showcase plays them. */
export const SIMULATED_EVENTS = [
	{ kind: 'twitchMessage', label: 'Twitch: chat message' },
	{ kind: 'youtubeMessage', label: 'YouTube: chat message' },
	{ kind: 'twitchEmotes', label: 'Twitch: message full of emotes' },
	{ kind: 'twitchReply', label: 'Twitch: reply to a message' },
	{ kind: 'twitchAction', label: 'Twitch: /me action' },
	{ kind: 'twitchBroadcaster', label: 'Twitch: message from the broadcaster' },
	{ kind: 'youtubeOwner', label: 'YouTube: message from the channel owner' },
	{ kind: 'longMessage', label: 'Long message' },
	{ kind: 'twitchCheer', label: 'Twitch: cheer' },
	{ kind: 'twitchHighlight', label: 'Twitch: message highlighted with channel points' },
	{ kind: 'twitchFirstTime', label: 'Twitch: first-time chatter' },
	{ kind: 'twitchCelebration', label: 'Twitch: on-screen celebration with Bits' },
	{ kind: 'twitchAutomodHold', label: 'Twitch: message held by AutoMod' },
	{ kind: 'twitchSub', label: 'Twitch: new subscription' },
	{ kind: 'twitchResub', label: 'Twitch: resubscription with a message' },
	{ kind: 'twitchGiftSub', label: 'Twitch: gifted subscription' },
	{ kind: 'twitchCommunityGift', label: 'Twitch: anonymous community gift' },
	{ kind: 'twitchRaid', label: 'Twitch: raid' },
	{ kind: 'twitchAnnouncement', label: 'Twitch: announcement' },
	{ kind: 'youtubeSuperChat', label: 'YouTube: Super Chat' },
	{ kind: 'youtubeSuperSticker', label: 'YouTube: Super Sticker' },
	{ kind: 'youtubeNewMember', label: 'YouTube: new member' },
	{ kind: 'youtubeMilestone', label: 'YouTube: member milestone' },
	{ kind: 'youtubeGift', label: 'YouTube: gifted memberships' },
	{ kind: 'twitchDelete', label: 'Twitch: delete a recent message' },
	{ kind: 'youtubeDelete', label: 'YouTube: delete a recent message' },
	{ kind: 'twitchTimeout', label: 'Twitch: time out a recent chatter' },
	{ kind: 'youtubeBan', label: 'YouTube: ban a recent chatter' },
] as const;

/** Requests that are not single events, or that would wreck a showcase if played in the middle of one. */
export const SIMULATED_ACTIONS = [
	{ kind: 'showcase', label: 'Showcase: one of every event' },
	{ kind: 'burst', label: 'Burst of 50 messages' },
	{ kind: 'twitchClear', label: 'Twitch: clear the whole chat' },
	{ kind: 'connectionDrop', label: 'Connection drop and recovery' },
] as const;

export type SimulatedEventKind = (typeof SIMULATED_EVENTS)[number]['kind'] | (typeof SIMULATED_ACTIONS)[number]['kind'];

/** Who a typed simulated message comes from. YouTube has no VIPs, so a YouTube `vip` is an ordinary viewer. */
export const SIMULATED_SPEAKERS = ['viewer', 'subscriber', 'vip', 'moderator', 'broadcaster'] as const;
export type SimulatedSpeaker = (typeof SIMULATED_SPEAKERS)[number];

/** Twitch badges that carry a role. A chatter with none of them is an ordinary viewer. */
const TWITCH_ROLE_BADGES = ['broadcaster', 'moderator', 'vip', 'subscriber', 'founder'];

export function isSimulatedEventKind(value: unknown): value is SimulatedEventKind {
	return [...SIMULATED_EVENTS, ...SIMULATED_ACTIONS].some((entry) => entry.kind === value);
}

/** What the automatic stream is made of, as relative weights. Mostly plain chat, like a real one. */
const AUTOMATIC_MIX: [SimulatedEventKind, number][] = [
	['twitchMessage', 48],
	['youtubeMessage', 30],
	['twitchEmotes', 3],
	['twitchReply', 4],
	['twitchAction', 1.5],
	['twitchBroadcaster', 1.5],
	['youtubeOwner', 1],
	['longMessage', 1.5],
	['twitchCheer', 1],
	['twitchHighlight', 0.5],
	['twitchFirstTime', 0.6],
	['twitchCelebration', 0.2],
	['twitchAutomodHold', 0.2],
	['twitchSub', 0.8],
	['twitchResub', 1],
	['twitchGiftSub', 0.6],
	['twitchCommunityGift', 0.2],
	['twitchRaid', 0.2],
	['twitchAnnouncement', 0.2],
	['youtubeSuperChat', 1.2],
	['youtubeSuperSticker', 0.3],
	['youtubeNewMember', 0.8],
	['youtubeMilestone', 0.5],
	['youtubeGift', 0.2],
	['twitchDelete', 0.7],
	['youtubeDelete', 0.4],
	['twitchTimeout', 0.3],
	['youtubeBan', 0.1],
];

const RECENT_LIMIT = 40;
const BURST_SIZE = 50;
/** How often to look at the rate again while it is zero. */
const IDLE_CHECK_MS = 500;
const RECONNECT_MS = 2500;
/** How often the simulated audience changes. Faster than the real platforms, so the display can be seen moving. */
const VIEWER_UPDATE_MS = 5000;

let idCounter = 0;

/** A small seeded generator (mulberry32), so a run can be repeated exactly in tests. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface SimulatedChatOptions {
	sink: ChatSink;
	/** Automatic messages per second. Zero or less means only requested events are produced. */
	getRate(): number;
	seed?: number;
	now?: () => number;
}

interface Recent {
	id: string;
	userId: string;
	name: string;
	text: string;
}

export class SimulatedChat {
	private readonly random: () => number;
	/** Kept apart from `random`, so the audience drifting on its timer cannot change which chat a seed produces. */
	private readonly viewerRandom: () => number;
	private readonly now: () => number;
	private readonly session: string;
	private readonly recent: Record<Platform, Recent[]> = { twitch: [], youtube: [] };
	/** Each simulated stream's viewer count, once started. */
	private readonly audience: Partial<Record<Platform, number>> = {};
	private timer: NodeJS.Timeout | undefined;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private viewerTimer: NodeJS.Timeout | undefined;
	private disposed = false;
	/** Set while the showcase plays. */
	private staged = false;
	/** Users the view timed out or banned, by `<platform>:<user id>`, until when. They stop chatting until then. */
	private readonly blocked = new Map<string, number>();
	/** Messages AutoMod is holding, by key, waiting to be allowed or denied. */
	private readonly held = new Map<string, { event: AutomodEvent; chatter: TwitchChatter; text: string }>();

	constructor(private readonly options: SimulatedChatOptions) {
		const seed = options.seed ?? Date.now();
		this.random = seededRandom(seed);
		this.viewerRandom = seededRandom(seed ^ 0x9e3779b9);
		this.now = options.now ?? Date.now;
		// Message IDs must stay unique across simulator instances: history is de-duplicated by ID.
		this.session = Date.now().toString(36);
	}

	start(): void {
		this.options.sink.status(SIMULATED_TWITCH.id, { state: 'connected' }, `Simulated Twitch`);
		this.options.sink.status(SIMULATED_YOUTUBE.id, { state: 'connected' }, `Simulated YouTube`);
		this.audience.twitch = 800 + Math.floor(this.viewerRandom() * 700);
		this.audience.youtube = 250 + Math.floor(this.viewerRandom() * 400);
		this.reportViewers('twitch');
		this.reportViewers('youtube');
		this.scheduleViewers();
		this.schedule();
	}

	dispose(): void {
		this.disposed = true;
		clearTimeout(this.timer);
		clearTimeout(this.reconnectTimer);
		clearTimeout(this.viewerTimer);
	}

	/** Forgets the messages sent so far, so later removals and replies only target what is still on screen. */
	forget(): void {
		this.recent.twitch = [];
		this.recent.youtube = [];
		this.held.clear();
	}

	/**
	 * Carries out a moderation request from the view the way the platform would: the platform reports the removal
	 * as a chat event, and a timed-out or banned user stops chatting.
	 */
	moderate(platform: Platform, action: ModerationAction): void {
		if (action.type === 'automod') {
			const held = platform === 'twitch' ? this.held.get(action.messageKey) : undefined;
			if (!held) {
				throw new ModerationError('That message is no longer held.');
			}
			this.held.delete(action.messageKey);
			const status = action.allow ? 'Approved' : 'Denied';
			const update = mapAutomodUpdate({ ...held.event, status, moderator_user_name: TWITCH_BROADCASTER.name }, SIMULATED_TWITCH.id, this.now());
			if (update) {
				this.send({ type: 'update', message: update });
			}
			if (action.allow) {
				this.twitchChat(held.chatter, held.text);
			}
			return;
		}
		if (action.type === 'delete') {
			const prefix = `${platform}:`;
			if (!action.messageKey.startsWith(prefix)) {
				throw new ModerationError('That message is not in this chat.');
			}
			const id = action.messageKey.slice(prefix.length);
			// A later simulated removal must not pick this message again.
			this.recent[platform] = this.recent[platform].filter((entry) => entry.id !== id);
			if (platform === 'twitch') {
				this.send({ type: 'delete', key: action.messageKey });
			} else {
				this.youtubeItem(YOUTUBE_OWNER, { type: 'messageDeletedEvent', messageDeletedDetails: { deletedMessageId: id } });
			}
			return;
		}
		const { userId } = action;
		if (userId === (platform === 'twitch' ? TWITCH_BROADCASTER.id : YOUTUBE_OWNER.channelId)) {
			throw new ModerationError(`You cannot ${action.type === 'ban' ? 'ban' : 'time out'} the broadcaster.`);
		}
		const until = action.type === 'ban' ? Infinity : this.now() + action.durationSeconds * 1000;
		this.blocked.set(`${platform}:${userId}`, until);
		this.recent[platform] = this.recent[platform].filter((entry) => entry.userId !== userId);
		if (platform === 'twitch') {
			this.send({ type: 'purge', platform: 'twitch', channelId: TWITCH_CHANNEL_ID, userId });
		} else {
			this.youtubeItem(YOUTUBE_OWNER, { type: 'userBannedEvent', userBannedDetails: { bannedUserDetails: { channelId: userId } } });
		}
	}

	/** Sends `text` as a chat message from a simulated chatter of the given standing, such as a chat command to try. */
	say(platform: Platform, speaker: SimulatedSpeaker, text: string): void {
		if (platform === 'twitch') {
			const matches = (chatter: TwitchChatter): boolean => {
				const roles = chatter.badges.filter((badge) => TWITCH_ROLE_BADGES.includes(badge));
				switch (speaker) {
					case 'moderator':
						return roles.includes('moderator');
					case 'vip':
						return roles.includes('vip') && !roles.includes('moderator');
					case 'subscriber':
						return (roles.includes('subscriber') || roles.includes('founder')) && !roles.includes('moderator') && !roles.includes('vip');
					default:
						return roles.length === 0;
				}
			};
			const chatter = speaker === 'broadcaster' ? TWITCH_BROADCASTER : this.pickMatching(this.allowed('twitch', TWITCH_CHATTERS, (c) => c.id), TWITCH_CHATTERS, matches);
			this.twitchChat(chatter, text);
			return;
		}
		const matches = (chatter: YouTubeChatter): boolean => {
			switch (speaker) {
				case 'moderator':
					return chatter.moderator === true;
				case 'subscriber':
					return chatter.member === true && !chatter.moderator;
				default:
					return !chatter.member && !chatter.moderator;
			}
		};
		const chatter = speaker === 'broadcaster' ? YOUTUBE_OWNER : this.pickMatching(this.allowed('youtube', YOUTUBE_CHATTERS, (c) => c.channelId), YOUTUBE_CHATTERS, matches);
		this.youtubeItem(chatter, { type: 'textMessageEvent', displayMessage: text });
	}

	/**
	 * Sends a reply from the broadcaster, as Caerwyn's chat replies would arrive from Twitch. Like the real thing, only
	 * Twitch chat takes replies.
	 */
	reply(parent: ChatMessage, text: string): void {
		if (parent.platform !== 'twitch') {
			throw new Error('Replies are only sent in Twitch chat.');
		}
		this.twitchChat(TWITCH_BROADCASTER, text, {
			reply: { parent_user_name: parent.author.name, parent_message_body: parent.fragments.map((fragment) => fragment.text).join('') },
		});
	}

	/** A chatter from `free` that matches, else any that matches, else anyone free. */
	private pickMatching<T>(free: readonly T[], all: readonly T[], matches: (chatter: T) => boolean): T {
		const candidates = free.filter(matches);
		return this.pick(candidates.length > 0 ? candidates : all.some(matches) ? all.filter(matches) : free);
	}

	/** Produces one requested event immediately. */
	emit(kind: SimulatedEventKind): void {
		switch (kind) {
			case 'showcase':
				this.staged = true;
				try {
					for (const entry of SIMULATED_EVENTS) {
						this.emit(entry.kind);
					}
				} finally {
					this.staged = false;
				}
				break;
			case 'burst':
				for (let i = 0; i < BURST_SIZE; i++) {
					this.emit(this.random() < 0.6 ? 'twitchMessage' : 'youtubeMessage');
				}
				break;
			case 'connectionDrop':
				this.dropConnection();
				break;
			case 'twitchClear':
				this.recent.twitch = [];
				// YouTube's list is untouched: only the Twitch room was cleared.
				this.send({ type: 'clear', platform: 'twitch', channelId: TWITCH_CHANNEL_ID });
				break;
			case 'twitchMessage':
				this.twitchChat(this.twitchChatter(), this.line());
				break;
			case 'twitchEmotes': {
				const emotes = Object.keys(TWITCH_EMOTES);
				const words = Array.from({ length: this.int(4, 10) }, () => this.pick(emotes));
				this.twitchChat(this.twitchChatter(), words.join(' '));
				break;
			}
			case 'twitchReply': {
				const parent = this.recentOrNew('twitch');
				this.twitchChat(this.twitchChatter(), `@${parent.name} ${this.line()}`, {
					reply: { parent_user_name: parent.name, parent_message_body: parent.text },
				});
				break;
			}
			case 'twitchAction':
				this.twitchChat(this.twitchChatter(), `\u0001ACTION ${this.pick(['waves at chat', 'grabs a coffee', 'takes notes'])}\u0001`);
				break;
			case 'twitchBroadcaster':
				this.twitchChat(TWITCH_BROADCASTER, `@${this.twitchChatter().name} good question, I will get to it in a minute`);
				break;
			case 'longMessage':
				this.twitchChat(this.twitchChatter(), this.pick(LONG_LINES));
				break;
			case 'twitchCheer': {
				const bits = this.pick([1, 100, 500, 1000, 5000, 10000]);
				this.twitchChat(this.twitchChatter(), `Cheer${bits} ${this.line()}`, { cheer: { bits } });
				break;
			}
			case 'twitchHighlight': {
				// Twitch reports the cost separately, usually just after the message, so it arrives as an update.
				const { event, message } = this.twitchChat(this.twitchChatter(), this.line(), { message_type: 'channel_points_highlighted' });
				const spent = { amount: this.pick([300, 500, 1000]), currency: 'points' as const };
				this.send({ type: 'update', message: mapChatMessage(event, SIMULATED_TWITCH.id, message.timestamp, spent) });
				break;
			}
			case 'twitchFirstTime':
				this.twitchChat(this.twitchChatter(), this.pick(['first time here, loving the stream', 'hi everyone, just found this channel', 'hello! been lurking, finally saying hi']), {
					message_type: 'user_intro',
				});
				break;
			case 'twitchAutomodHold': {
				const chatter = this.twitchChatter();
				const text = this.pick(['nobody asked, go touch grass', 'this stream is so bad lol', 'ur code looks like spaghetti']);
				const event: AutomodEvent = {
					broadcaster_user_id: TWITCH_CHANNEL_ID,
					broadcaster_user_login: TWITCH_BROADCASTER.login,
					broadcaster_user_name: TWITCH_BROADCASTER.name,
					user_id: chatter.id,
					user_login: chatter.login,
					user_name: chatter.name,
					message_id: this.nextId(),
					message: { text, fragments: [{ type: 'text', text }] },
					reason: 'automod',
					automod: { category: 'bullying', level: this.int(1, 4) },
					held_at: new Date(this.now()).toISOString(),
				};
				const message = mapAutomodHold(event, SIMULATED_TWITCH.id, this.now());
				if (message) {
					this.held.set(message.key, { event, chatter, text });
					this.send({ type: 'message', message });
				}
				break;
			}
			case 'twitchCelebration': {
				const chatter = this.twitchChatter();
				const celebration = mapBitsUse(
					{
						broadcaster_user_id: TWITCH_CHANNEL_ID,
						broadcaster_user_login: TWITCH_BROADCASTER.login,
						broadcaster_user_name: TWITCH_BROADCASTER.name,
						user_id: chatter.id,
						user_login: chatter.login,
						user_name: chatter.name,
						bits: this.pick([100, 250, 500]),
						type: 'power_up',
						power_up: { type: 'celebration', emote: { id: '25', name: 'Kappa' } },
					},
					SIMULATED_TWITCH.id,
					this.now(),
					this.nextId(),
				);
				if (celebration?.kind === 'message') {
					this.send({ type: 'message', message: celebration.message });
				}
				break;
			}
			case 'twitchSub': {
				const chatter = this.twitchChatter();
				this.twitchNotice(chatter, 'sub', `${chatter.name} subscribed at Tier 1.`);
				break;
			}
			case 'twitchResub': {
				const chatter = this.twitchChatter();
				const months = this.int(2, 48);
				this.twitchNotice(chatter, 'resub', `${chatter.name} subscribed at Tier 1. They've subscribed for ${months} months!`, this.line());
				break;
			}
			case 'twitchGiftSub': {
				const chatter = this.twitchChatter();
				this.twitchNotice(chatter, 'sub_gift', `${chatter.name} gifted a Tier 1 sub to ${this.twitchChatter().name}!`);
				break;
			}
			case 'twitchCommunityGift':
				this.twitchNotice(
					this.twitchChatter(),
					'community_sub_gift',
					`An anonymous user is gifting ${this.pick([5, 10, 20])} Tier 1 Subs to ${TWITCH_BROADCASTER.name}'s community!`,
					undefined,
					{ chatter_is_anonymous: true },
				);
				break;
			case 'twitchRaid': {
				const chatter = this.twitchChatter();
				const raiders = this.int(3, 250);
				this.twitchNotice(chatter, 'raid', `${raiders} raiders from ${chatter.name} have joined!`);
				// Raiders arrive as viewers too.
				if (this.audience.twitch !== undefined) {
					this.audience.twitch += raiders;
					this.reportViewers('twitch');
				}
				break;
			}
			case 'twitchAnnouncement':
				// Announcements carry no system message; the moderator's text is the message itself.
				this.twitchNotice(this.pick(TWITCH_CHATTERS.filter((c) => c.badges.includes('moderator'))), 'announcement', '', 'Schedule change: next stream is Thursday');
				break;
			case 'twitchDelete':
				this.send({ type: 'delete', key: `twitch:${this.takeRecent('twitch').id}` });
				break;
			case 'twitchTimeout': {
				const target = this.takeRecent('twitch');
				this.recent.twitch = this.recent.twitch.filter((entry) => entry.userId !== target.userId);
				this.send({ type: 'purge', platform: 'twitch', channelId: TWITCH_CHANNEL_ID, userId: target.userId });
				break;
			}
			case 'youtubeMessage':
				this.youtubeItem(this.youtubeChatter(), { type: 'textMessageEvent', displayMessage: this.line(false) });
				break;
			case 'youtubeOwner':
				this.youtubeItem(YOUTUBE_OWNER, { type: 'textMessageEvent', displayMessage: 'Welcome in, everyone. Links are in the description.' });
				break;
			case 'youtubeSuperChat':
				this.youtubeItem(this.youtubeChatter(), {
					type: 'superChatEvent',
					superChatDetails: { amountDisplayString: this.pick(SUPER_CHAT_AMOUNTS), userComment: this.line(false) },
				});
				break;
			case 'youtubeSuperSticker':
				this.youtubeItem(this.youtubeChatter(), {
					type: 'superStickerEvent',
					superStickerDetails: { amountDisplayString: this.pick(SUPER_CHAT_AMOUNTS), superStickerMetadata: { altText: 'A cat waving hello' } },
				});
				break;
			case 'youtubeNewMember':
				this.youtubeItem(this.youtubeChatter(), { type: 'newSponsorEvent', displayMessage: 'Welcome to Early Birds!' });
				break;
			case 'youtubeMilestone':
				this.youtubeItem(this.youtubeChatter(), {
					type: 'memberMilestoneChatEvent',
					memberMilestoneChatDetails: { memberMonth: this.int(2, 36), memberLevelName: 'Early Birds', userComment: this.line(false) },
				});
				break;
			case 'youtubeGift': {
				const chatter = this.youtubeChatter();
				this.youtubeItem(chatter, {
					type: 'membershipGiftingEvent',
					displayMessage: `${chatter.name} gifted ${this.pick([1, 5, 10])} ${YOUTUBE_OWNER.name} memberships`,
				});
				break;
			}
			case 'youtubeDelete':
				this.youtubeItem(YOUTUBE_OWNER, {
					type: 'messageDeletedEvent',
					messageDeletedDetails: { deletedMessageId: this.takeRecent('youtube').id },
				});
				break;
			case 'youtubeBan': {
				const target = this.takeRecent('youtube');
				this.recent.youtube = this.recent.youtube.filter((entry) => entry.userId !== target.userId);
				this.youtubeItem(YOUTUBE_OWNER, {
					type: 'userBannedEvent',
					userBannedDetails: { bannedUserDetails: { channelId: target.userId } },
				});
				break;
			}
		}
	}

	private schedule(): void {
		const rate = this.options.getRate();
		// Exponentially distributed gaps give the uneven rhythm of real chat.
		const delay = rate > 0 ? Math.min(5000, Math.max(20, (-Math.log(1 - this.random()) / rate) * 1000)) : IDLE_CHECK_MS;
		this.timer = setTimeout(() => {
			if (this.disposed) {
				return;
			}
			if (this.options.getRate() > 0) {
				this.emit(this.weighted());
			}
			this.schedule();
		}, delay);
	}

	/** Lets each audience wander a few percent either way, drifting slightly upward like a stream finding its crowd. */
	private scheduleViewers(): void {
		this.viewerTimer = setTimeout(() => {
			if (this.disposed) {
				return;
			}
			for (const platform of ['twitch', 'youtube'] as const) {
				const current = this.audience[platform];
				if (current !== undefined) {
					const change = Math.round(current * (this.viewerRandom() - 0.48) * 0.05);
					this.audience[platform] = Math.max(0, current + change);
					this.reportViewers(platform);
				}
			}
			this.scheduleViewers();
		}, VIEWER_UPDATE_MS);
	}

	private reportViewers(platform: Platform): void {
		if (!this.disposed) {
			this.options.sink.viewers(platform === 'twitch' ? SIMULATED_TWITCH.id : SIMULATED_YOUTUBE.id, this.audience[platform]);
		}
	}

	private weighted(): SimulatedEventKind {
		const total = AUTOMATIC_MIX.reduce((sum, [, weight]) => sum + weight, 0);
		let roll = this.random() * total;
		for (const [kind, weight] of AUTOMATIC_MIX) {
			roll -= weight;
			if (roll < 0) {
				return kind;
			}
		}
		return 'twitchMessage';
	}

	private dropConnection(): void {
		for (const source of SIMULATED_SOURCES) {
			this.options.sink.status(source.id, { state: 'connecting', detail: 'Reconnecting…' });
		}
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = setTimeout(() => {
			for (const source of SIMULATED_SOURCES) {
				this.options.sink.status(source.id, { state: 'connected' });
			}
		}, RECONNECT_MS);
	}

	private send(event: ChatEvent): void {
		if (!this.disposed) {
			this.options.sink.event(event);
		}
	}

	private nextId(): string {
		return `sim-${this.session}-${++idCounter}`;
	}

	/** A random Twitch chatter who is allowed to chat. */
	private twitchChatter(): TwitchChatter {
		return this.pick(this.allowed('twitch', TWITCH_CHATTERS, (chatter) => chatter.id));
	}

	/** A random YouTube chatter who is allowed to chat. */
	private youtubeChatter(): YouTubeChatter {
		return this.pick(this.allowed('youtube', YOUTUBE_CHATTERS, (chatter) => chatter.channelId));
	}

	/** The chatters not timed out or banned. If that is nobody, everyone, so the chat keeps going. */
	private allowed<T>(platform: Platform, chatters: readonly T[], id: (chatter: T) => string): readonly T[] {
		const now = this.now();
		const free = chatters.filter((chatter) => {
			const key = `${platform}:${id(chatter)}`;
			const until = this.blocked.get(key);
			if (until !== undefined && until <= now) {
				this.blocked.delete(key);
			}
			return until === undefined || until <= now;
		});
		return free.length > 0 ? free : chatters;
	}

	private pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.random() * items.length)];
	}

	private int(min: number, max: number): number {
		return min + Math.floor(this.random() * (max - min + 1));
	}

	/** A chat line. Twitch emote names only mean something on Twitch, so YouTube lines swap them for YouTube emoji. */
	private line(withEmotes = true): string {
		const lines = withEmotes
			? CHAT_LINES
			: [...CHAT_LINES.filter((line) => !line.split(' ').some((word) => word in TWITCH_EMOTES)), ...YOUTUBE_LINES];
		return this.pick(lines);
	}

	private remember(platform: Platform, entry: Recent): void {
		const list = this.recent[platform];
		list.push(entry);
		if (list.length > RECENT_LIMIT) {
			list.shift();
		}
	}

	/** A recent message to act on, creating one first if the chat is empty. */
	private recentOrNew(platform: Platform): Recent {
		if (this.recent[platform].length === 0) {
			this.emit(platform === 'twitch' ? 'twitchMessage' : 'youtubeMessage');
		}
		return this.pick(this.recent[platform]);
	}

	/** Like `recentOrNew`, but the message cannot be picked again: it is about to be removed. */
	private takeRecent(platform: Platform): Recent {
		if (this.staged) {
			// In a showcase, remove a throwaway message so the other examples stay on screen.
			if (platform === 'twitch') {
				this.twitchChat(TWITCH_TROUBLEMAKER, SPAM_LINE);
			} else {
				this.youtubeItem(YOUTUBE_TROUBLEMAKER, { type: 'textMessageEvent', displayMessage: SPAM_LINE });
			}
			return this.recent[platform].pop() as Recent;
		}
		const entry = this.recentOrNew(platform);
		this.recent[platform] = this.recent[platform].filter((other) => other !== entry);
		return entry;
	}

	/** Splits text the way Twitch does: emote names and @mentions become their own fragments. */
	private twitchBody(text: string): NonNullable<TwitchChatEvent['message']> {
		const fragments: NonNullable<NonNullable<TwitchChatEvent['message']>['fragments']> = [];
		let plain = '';
		const flush = () => {
			if (plain) {
				fragments.push({ type: 'text', text: plain });
				plain = '';
			}
		};
		for (const token of text.split(/(\s+)/)) {
			if (token in TWITCH_EMOTES) {
				flush();
				fragments.push({ type: 'emote', text: token, emote: { id: TWITCH_EMOTES[token], format: ['static'] } });
			} else if (/^@\S+$/.test(token)) {
				flush();
				fragments.push({ type: 'mention', text: token });
			} else {
				plain += token;
			}
		}
		flush();
		return { text, fragments };
	}

	private twitchEvent(chatter: TwitchChatter, text: string | undefined, extra: Partial<TwitchChatEvent>): TwitchChatEvent {
		return {
			broadcaster_user_id: TWITCH_CHANNEL_ID,
			broadcaster_user_login: TWITCH_BROADCASTER.login,
			broadcaster_user_name: TWITCH_BROADCASTER.name,
			chatter_user_id: chatter.id,
			chatter_user_login: chatter.login,
			chatter_user_name: chatter.name,
			message_id: this.nextId(),
			color: chatter.color,
			badges: chatter.badges.map((set_id) => ({ set_id })),
			message: text === undefined ? { text: '', fragments: [] } : this.twitchBody(text),
			...extra,
		};
	}

	private twitchChat(chatter: TwitchChatter, text: string, extra: Partial<TwitchChatEvent> = {}): { event: TwitchChatEvent; message: ChatMessage } {
		const event = this.twitchEvent(chatter, text, extra);
		const plainText = text.replace(/\u0001(ACTION )?/g, '');
		this.remember('twitch', { id: event.message_id, userId: chatter.id, name: chatter.name, text: plainText });
		const message = mapChatMessage(event, SIMULATED_TWITCH.id, this.now());
		this.send({ type: 'message', message });
		return { event, message };
	}

	private twitchNotice(chatter: TwitchChatter, noticeType: string, systemMessage: string, text?: string, extra: Partial<TwitchChatEvent> = {}): void {
		const event = this.twitchEvent(chatter, text, { notice_type: noticeType, system_message: systemMessage, ...extra });
		this.send({ type: 'message', message: mapNotification(event, SIMULATED_TWITCH.id, this.now()) });
	}

	private youtubeItem(chatter: YouTubeChatter, snippet: NonNullable<YouTubeChatItem['snippet']>): void {
		const id = this.nextId();
		const item: YouTubeChatItem = {
			id,
			snippet: { liveChatId: YOUTUBE_CHAT_ID, publishedAt: new Date(this.now()).toISOString(), ...snippet },
			authorDetails: {
				channelId: chatter.channelId,
				displayName: chatter.name,
				isChatOwner: chatter.owner,
				isChatModerator: chatter.moderator,
				isChatSponsor: chatter.member,
				isVerified: chatter.verified,
			},
		};
		if (snippet.type === 'textMessageEvent') {
			this.remember('youtube', { id, userId: chatter.channelId, name: chatter.name, text: snippet.displayMessage ?? '' });
		}
		const mapped = mapYouTubeItem(item, YOUTUBE_CONTEXT);
		if (mapped && mapped !== 'ended') {
			this.send(mapped);
		}
	}
}
