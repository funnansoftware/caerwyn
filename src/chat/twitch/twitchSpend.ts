import { ChatMessage, Fragment } from '../types';
import { Cost, EMOTE_ID, PaidMessageType, TwitchChatEvent, emoteUrl, mapChatMessage, isPaidMessageType } from './twitchMapper';

// Channel points and Bits spending, from two EventSub subscriptions only the broadcaster can make:
// `channel.channel_points_automatic_reward_redemption.add` (version 2) and `channel.bits.use`.
// https://dev.twitch.tv/docs/eventsub/reference/channel-points
// https://dev.twitch.tv/docs/eventsub/reference/channel
// Neither event carries the ID of the chat message it paid for, so `SpendMatcher` pairs them by viewer.

interface SpendEventBase {
	broadcaster_user_id: string;
	broadcaster_user_login?: string;
	broadcaster_user_name?: string;
	user_id?: string;
	user_login?: string;
	user_name?: string;
	message?: { text?: string } | null;
}

interface TwitchEmote {
	id?: string;
	name?: string;
}

export interface AutomaticRedemptionEvent extends SpendEventBase {
	/** The redemption's ID. */
	id?: string;
	reward?: { type?: string; channel_points?: number; emote?: TwitchEmote | null } | null;
}

export interface BitsUseEvent extends SpendEventBase {
	bits?: number;
	/** `cheer`, `power_up` or `custom_power_up`. */
	type?: string;
	power_up?: { type?: string; emote?: TwitchEmote | null } | null;
	custom_power_up?: { title?: string } | null;
}

/** The cost of a chat message, which reaches us apart from the message itself. */
export interface MessageCost {
	broadcasterId: string;
	userId: string;
	messageType: PaidMessageType;
	/** The message's text as the spending event gives it, to tell apart two paid messages from one viewer. */
	text: string;
	spent: Cost;
}

/** What one spending event means for chat. */
export type SpendResult =
	| { kind: 'cost'; cost: MessageCost }
	/** Spending with no chat message of its own, shown as a row of its own. */
	| { kind: 'message'; message: ChatMessage };

const REDEMPTION_COSTS: Record<string, PaidMessageType> = {
	send_highlighted_message: 'channel_points_highlighted',
	single_message_bypass_sub_mode: 'channel_points_sub_only',
};

const REDEMPTION_HEADLINES: Record<string, string> = {
	random_sub_emote_unlock: 'Unlocked a random sub emote',
	chosen_sub_emote_unlock: 'Unlocked a sub emote',
	chosen_modified_sub_emote_unlock: 'Unlocked a modified sub emote',
};

const POWER_UP_COSTS: Record<string, PaidMessageType> = {
	message_effect: 'power_ups_message_effect',
	gigantify_an_emote: 'power_ups_gigantified_emote',
};

/** Maps a channel points redemption of one of Twitch's built-in rewards. `fallbackId` is the notification's ID. */
export function mapAutomaticRedemption(
	event: AutomaticRedemptionEvent,
	sourceId: string,
	timestamp: number,
	fallbackId: string,
): SpendResult | undefined {
	const amount = event.reward?.channel_points;
	const type = event.reward?.type ?? '';
	if (!isAmount(amount)) {
		return undefined;
	}
	const spent: Cost = { amount, currency: 'points' };
	if (Object.hasOwn(REDEMPTION_COSTS, type)) {
		return cost(event, REDEMPTION_COSTS[type], spent);
	}
	if (Object.hasOwn(REDEMPTION_HEADLINES, type)) {
		const id = `redemption-${event.id || fallbackId}`;
		return spendRow(event, id, sourceId, timestamp, REDEMPTION_HEADLINES[type], spent, event.reward?.emote);
	}
	return undefined;
}

/** Maps a `channel.bits.use` event. `id` is the notification's ID, since the event has none of its own. */
export function mapBitsUse(event: BitsUseEvent, sourceId: string, timestamp: number, id: string): SpendResult | undefined {
	const amount = event.bits;
	if (!isAmount(amount)) {
		return undefined;
	}
	const spent: Cost = { amount, currency: 'bits' };
	const rowId = `bits-${id}`;
	if (event.type === 'power_up') {
		const powerUp = event.power_up?.type ?? '';
		if (Object.hasOwn(POWER_UP_COSTS, powerUp)) {
			return cost(event, POWER_UP_COSTS[powerUp], spent);
		}
		const what = powerUp === 'celebration' ? 'Sent an on-screen celebration' : 'Used a Power-up';
		return spendRow(event, rowId, sourceId, timestamp, what, spent, event.power_up?.emote);
	}
	if (event.type === 'custom_power_up') {
		const title = event.custom_power_up?.title?.trim();
		return spendRow(event, rowId, sourceId, timestamp, `Used ${title || 'a custom Power-up'}`, spent);
	}
	// Cheers are left out: their chat message already says how many Bits it carried.
	return undefined;
}

function isAmount(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function cost(event: SpendEventBase, messageType: PaidMessageType, spent: Cost): SpendResult | undefined {
	if (!event.user_id) {
		return undefined;
	}
	return {
		kind: 'cost',
		cost: { broadcasterId: event.broadcaster_user_id, userId: event.user_id, messageType, text: event.message?.text ?? '', spent },
	};
}

/**
 * A row for spending that has no chat message. It shows the headline and any emote the reward named, never
 * the event's message text: that text may be a message AutoMod is still holding.
 */
function spendRow(
	event: SpendEventBase,
	id: string,
	sourceId: string,
	timestamp: number,
	headline: string,
	spent: Cost,
	emote?: TwitchEmote | null,
): SpendResult {
	const fragments: Fragment[] = [];
	if (emote?.id && EMOTE_ID.test(emote.id)) {
		fragments.push({ type: 'emote', text: emote.name || 'emote', url: emoteUrl(emote.id, false) });
	}
	return {
		kind: 'message',
		message: {
			key: `twitch:${id}`,
			platform: 'twitch',
			id,
			sourceId,
			channelId: event.broadcaster_user_id,
			channelName: event.broadcaster_user_name || event.broadcaster_user_login || event.broadcaster_user_id,
			author: {
				id: event.user_id ?? '',
				login: event.user_login,
				name: event.user_name || event.user_login || 'Unknown',
				roles: [],
			},
			fragments,
			timestamp,
			headline,
			spent: [{ currency: spent.currency, amount: spent.amount }],
		},
	};
}

/** How long a paid message waits for its cost. The cost normally follows within seconds. */
const MESSAGE_WAIT_MS = 60_000;
/** How long a cost waits for its message, which AutoMod may hold until a moderator allows it. */
const COST_WAIT_MS = 10 * 60_000;
/** The most of each kind kept waiting at once, so a flood cannot grow them without bound. */
const WAITING_LIMIT = 200;

interface WaitingMessage {
	event: TwitchChatEvent;
	sourceId: string;
	timestamp: number;
	at: number;
}

interface WaitingCost {
	cost: MessageCost;
	at: number;
}

/**
 * Pairs paid chat messages with what they cost. Either can arrive first: a message that arrives first is shown
 * at once and updated when its cost arrives; a cost that arrives first waits for its message.
 */
export class SpendMatcher {
	private messages: WaitingMessage[] = [];
	private costs: WaitingCost[] = [];

	constructor(private readonly now: () => number = Date.now) {}

	/** Maps a `channel.chat.message` event, with its cost if that is already known. */
	message(event: TwitchChatEvent, sourceId: string, timestamp: number): ChatMessage {
		if (!isPaidMessageType(event.message_type) || !event.chatter_user_id) {
			return mapChatMessage(event, sourceId, timestamp);
		}
		this.expire();
		const index = bestMatch(this.costs, (waiting) => [waiting.cost, event]);
		if (index >= 0) {
			const [waiting] = this.costs.splice(index, 1);
			return mapChatMessage(event, sourceId, timestamp, waiting.cost.spent);
		}
		this.messages.push({ event, sourceId, timestamp, at: this.now() });
		if (this.messages.length > WAITING_LIMIT) {
			this.messages.shift();
		}
		return mapChatMessage(event, sourceId, timestamp);
	}

	/** Records a cost. Returns the message it belongs to, mapped again with the cost, if that was already shown. */
	cost(cost: MessageCost): ChatMessage | undefined {
		this.expire();
		const index = bestMatch(this.messages, (waiting) => [cost, waiting.event]);
		if (index >= 0) {
			const [waiting] = this.messages.splice(index, 1);
			return mapChatMessage(waiting.event, waiting.sourceId, waiting.timestamp, cost.spent);
		}
		this.costs.push({ cost, at: this.now() });
		if (this.costs.length > WAITING_LIMIT) {
			this.costs.shift();
		}
		return undefined;
	}

	private expire(): void {
		const now = this.now();
		this.messages = this.messages.filter((waiting) => now - waiting.at < MESSAGE_WAIT_MS);
		this.costs = this.costs.filter((waiting) => now - waiting.at < COST_WAIT_MS);
	}
}

/**
 * The index of the oldest waiting entry from the same viewer, in the same channel, of the same kind,
 * preferring one whose text matches too. -1 if there is none.
 */
function bestMatch<T>(entries: readonly T[], pair: (entry: T) => [MessageCost, TwitchChatEvent]): number {
	let fallback = -1;
	for (let i = 0; i < entries.length; i++) {
		const [cost, event] = pair(entries[i]);
		if (
			cost.broadcasterId !== event.broadcaster_user_id ||
			cost.userId !== event.chatter_user_id ||
			cost.messageType !== event.message_type
		) {
			continue;
		}
		if (sameText(cost.text, event.message?.text)) {
			return i;
		}
		if (fallback < 0) {
			fallback = i;
		}
	}
	return fallback;
}

function sameText(a: string, b: string | undefined): boolean {
	return a.trim() !== '' && a.trim() === (b ?? '').trim();
}
