import { ChatAuthor, ChatMessage, Fragment, Role } from '../types';

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

const EMOTE_ID = /^[A-Za-z0-9_-]+$/;
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

function mapAuthor(event: TwitchChatEvent): ChatAuthor {
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

/** Maps a `channel.chat.message` event. */
export function mapChatMessage(event: TwitchChatEvent, sourceId: string, timestamp: number): ChatMessage {
	const message = base(event, sourceId, timestamp);
	const bits = event.cheer?.bits;
	if (bits) {
		message.headline = `Cheered ${bits} ${bits === 1 ? 'bit' : 'bits'}`;
	}
	if (event.reply?.parent_user_name) {
		message.replyTo = { name: event.reply.parent_user_name, text: event.reply.parent_message_body ?? '' };
	}
	return message;
}

/** Maps a `channel.chat.notification` event (subscriptions, raids, announcements and so on). */
export function mapNotification(event: TwitchChatEvent, sourceId: string, timestamp: number): ChatMessage {
	const message = base(event, sourceId, timestamp);
	message.headline = event.system_message || (event.notice_type ?? 'notice').replace(/_/g, ' ');
	return message;
}
