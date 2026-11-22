import { ChatAuthor, ChatMessage, Fragment, Role, Spent } from '../types';

// Pure mapping from EventSub chat event payloads to the platform-neutral model.
// Field names follow https://dev.twitch.tv/docs/eventsub/reference/chat

interface TwitchFragment {
	type?: string;
	text?: string;
	emote?: { id?: string; format?: string[] } | null;
}

interface TwitchBadge {
	set_id?: string;
}

interface TwitchMessageBody {
	text?: string;
	fragments?: TwitchFragment[];
}

export interface TwitchChatEvent {
	broadcaster_user_id: string;
	broadcaster_user_login?: string;
	broadcaster_user_name?: string;
	chatter_user_id?: string;
	chatter_user_login?: string;
	chatter_user_name?: string;
	chatter_is_anonymous?: boolean;
	message_id: string;
	message?: TwitchMessageBody;
	/** How the message was sent: plain `text`, or with channel points, Bits Power-ups and the like. */
	message_type?: string;
	color?: string;
	badges?: TwitchBadge[];
	cheer?: { bits?: number } | null;
	reply?: { parent_user_name?: string; parent_message_body?: string } | null;
	system_message?: string;
	notice_type?: string;
}

const BADGE_ROLES: Record<string, Role> = {
	broadcaster: 'broadcaster',
	moderator: 'moderator',
	lead_moderator: 'moderator',
	vip: 'vip',
	subscriber: 'subscriber',
	founder: 'subscriber',
	partner: 'verified',
};

/** What a viewer paid for something, from a channel points redemption or a Bits event. */
export interface Cost {
	amount: number;
	currency: Spent['currency'];
}

/** `message_type`s that cost channel points or Bits, and so may have a matching redemption or Bits event. */
export type PaidMessageType =
	| 'channel_points_highlighted'
	| 'channel_points_sub_only'
	| 'power_ups_message_effect'
	| 'power_ups_gigantified_emote';

// What to say about a message sent in a special way, by `message_type`, and what it is paid with, if anything.
// The view shows what was paid as an icon and amount after the label.
// A Map, so a `message_type` such as `constructor` cannot reach `Object.prototype`.
const MESSAGE_TYPES = new Map<string, { label: string; paidWith?: Spent['currency'] }>([
	['channel_points_highlighted', { label: 'Highlighted', paidWith: 'points' }],
	['channel_points_sub_only', { label: 'Sent in sub-only mode', paidWith: 'points' }],
	['user_intro', { label: 'First time in chat' }],
	['power_ups_message_effect', { label: 'Sent with a message effect', paidWith: 'bits' }],
	['power_ups_gigantified_emote', { label: 'Gigantified an emote', paidWith: 'bits' }],
]);

export function isPaidMessageType(type: string | undefined): type is PaidMessageType {
	return type !== undefined && MESSAGE_TYPES.get(type)?.paidWith !== undefined;
}

export const EMOTE_ID = /^[A-Za-z0-9_-]+$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const ACTION_PREFIX = '\u0001ACTION ';

export function emoteUrl(id: string, animated: boolean): string {
	return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/${animated ? 'animated' : 'static'}/dark/2.0`;
}

export function mapFragments(body: TwitchMessageBody | undefined): Fragment[] {
	const fragments: Fragment[] = [];
	for (const fragment of body?.fragments ?? []) {
		const text = fragment.text ?? '';
		const emoteId = fragment.emote?.id;
		if (fragment.type === 'emote' && emoteId && EMOTE_ID.test(emoteId)) {
			fragments.push({ type: 'emote', text, url: emoteUrl(emoteId, fragment.emote?.format?.includes('animated') ?? false) });
		} else if (fragment.type === 'mention') {
			fragments.push({ type: 'mention', text });
		} else if (text) {
			// Cheermotes and anything unrecognised are shown as their text.
			fragments.push({ type: 'text', text });
		}
	}
	if (fragments.length === 0 && body?.text) {
		fragments.push({ type: 'text', text: body.text });
	}
	return fragments;
}

/** `/me` messages are wrapped in `\u0001ACTION …\u0001`. Strips the wrapper and reports whether it was there. */
export function stripAction(fragments: Fragment[]): boolean {
	const first = fragments[0];
	if (first?.type !== 'text' || !first.text.startsWith(ACTION_PREFIX)) {
		return false;
	}
	first.text = first.text.slice(ACTION_PREFIX.length);
	const last = fragments[fragments.length - 1];
	if (last.type === 'text' && last.text.endsWith('\u0001')) {
		last.text = last.text.slice(0, -1);
	}
	return true;
}

export function mapAuthor(event: TwitchChatEvent): ChatAuthor {
	const roles = new Set<Role>();
	for (const badge of event.badges ?? []) {
		const role = badge.set_id ? BADGE_ROLES[badge.set_id] : undefined;
		if (role) {
			roles.add(role);
		}
	}
	const anonymous = event.chatter_is_anonymous === true;
	return {
		id: anonymous ? '' : (event.chatter_user_id ?? ''),
		login: anonymous ? undefined : event.chatter_user_login,
		name: anonymous ? 'Anonymous' : event.chatter_user_name || event.chatter_user_login || 'Unknown',
		color: event.color && COLOR.test(event.color) ? event.color : undefined,
		roles: [...roles],
	};
}

function base(event: TwitchChatEvent, sourceId: string, timestamp: number): ChatMessage {
	const fragments = mapFragments(event.message);
	const action = stripAction(fragments);
	return {
		key: `twitch:${event.message_id}`,
		platform: 'twitch',
		id: event.message_id,
		sourceId,
		channelId: event.broadcaster_user_id,
		channelName: event.broadcaster_user_name || event.broadcaster_user_login || event.broadcaster_user_id,
		author: mapAuthor(event),
		fragments,
		timestamp,
		...(action ? { action } : {}),
	};
}

/** Maps a `channel.chat.message` event. `cost` is what the viewer paid, when a matching redemption or Bits event says. */
export function mapChatMessage(event: TwitchChatEvent, sourceId: string, timestamp: number, cost?: Cost): ChatMessage {
	const message = base(event, sourceId, timestamp);
	const headlines: string[] = [];
	const spent: Spent[] = [];
	const bits = event.cheer?.bits;
	if (bits) {
		headlines.push('Cheered');
		spent.push({ currency: 'bits', amount: bits });
	}
	const type = MESSAGE_TYPES.get(event.message_type ?? '');
	if (type) {
		headlines.push(type.label);
	}
	if (type?.paidWith) {
		// The icon shows even before the amount is known, and in channels where it never will be.
		spent.push(cost?.currency === type.paidWith ? { currency: cost.currency, amount: cost.amount } : { currency: type.paidWith });
	}
	if (headlines.length > 0) {
		message.headline = headlines.join(' · ');
	}
	if (spent.length > 0) {
		message.spent = spent;
	}
	if (event.message_type === 'channel_points_highlighted') {
		message.highlighted = true;
	}
	if (event.reply?.parent_user_name) {
		message.replyTo = { name: event.reply.parent_user_name, text: event.reply.parent_message_body ?? '' };
	}
	return message;
}

/** Maps a `channel.chat.notification` event (subscriptions, raids, announcements and so on). */
export function mapNotification(event: TwitchChatEvent, sourceId: string, timestamp: number): ChatMessage {
	const message = base(event, sourceId, timestamp);
	// Some notices, such as announcements, have no system message; name the notice type instead.
	const fallback = (event.notice_type ?? 'notice').replace(/_/g, ' ');
	message.headline = event.system_message || fallback.charAt(0).toUpperCase() + fallback.slice(1);
	return message;
}
