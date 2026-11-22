import { ChatMessage, HeldState } from '../types';
import { mapFragments } from './twitchMapper';

// Messages AutoMod holds for review in the user's own channel, from `automod.message.hold` and
// `automod.message.update` (both version 2). https://dev.twitch.tv/docs/eventsub/reference/automod
// A held row has a key of its own: if a moderator allows the message, it then arrives as ordinary chat.

export interface AutomodEvent {
	broadcaster_user_id: string;
	broadcaster_user_login?: string;
	broadcaster_user_name?: string;
	user_id?: string;
	user_login?: string;
	user_name?: string;
	message_id?: string;
	message?: { text?: string; fragments?: { type?: string; text?: string; emote?: { id?: string } | null }[] } | null;
	/** `automod`, `blocked_term` or `blocked_link`. */
	reason?: string;
	automod?: { category?: string; level?: number } | null;
	held_at?: string;
	/** Update only: `Approved`, `Denied` or `Expired`. Twitch's own examples use lower case, so compare without case. */
	status?: string;
	moderator_user_login?: string;
	moderator_user_name?: string;
}

const STATES: Record<string, HeldState> = { approved: 'allowed', denied: 'denied', expired: 'expired' };

export function automodKey(messageId: string): string {
	return `twitch:automod-${messageId}`;
}

/** Maps `automod.message.hold`. `timestamp` is used when the event has no `held_at`. */
export function mapAutomodHold(event: AutomodEvent, sourceId: string, timestamp: number): ChatMessage | undefined {
	return mapHeld(event, sourceId, timestamp, 'held');
}

/** Maps `automod.message.update` to the held row as it now stands. */
export function mapAutomodUpdate(event: AutomodEvent, sourceId: string, timestamp: number): ChatMessage | undefined {
	const status = (event.status ?? '').toLowerCase();
	return Object.hasOwn(STATES, status) ? mapHeld(event, sourceId, timestamp, STATES[status]) : undefined;
}

function mapHeld(event: AutomodEvent, sourceId: string, timestamp: number, state: HeldState): ChatMessage | undefined {
	const messageId = event.message_id;
	if (!messageId) {
		return undefined;
	}
	const moderator = event.moderator_user_name || event.moderator_user_login || 'a moderator';
	const outcomes: Record<HeldState, string> = {
		held: '',
		allowed: ` · Allowed by ${moderator}`,
		denied: ` · Denied by ${moderator}`,
		expired: ' · Hold expired',
	};
	const outcome = outcomes[state];
	return {
		key: automodKey(messageId),
		platform: 'twitch',
		id: messageId,
		sourceId,
		channelId: event.broadcaster_user_id,
		channelName: event.broadcaster_user_name || event.broadcaster_user_login || event.broadcaster_user_id,
		author: { id: event.user_id ?? '', login: event.user_login, name: event.user_name || event.user_login || 'Unknown', roles: [] },
		// The text lives in `held`, never here, so nothing shows it until the reader asks to see it.
		fragments: [],
		timestamp: Date.parse(event.held_at ?? '') || timestamp,
		headline: `${holdReason(event)}${outcome}`,
		held: { messageId, state, fragments: mapFragments(event.message ?? undefined) },
	};
}

function holdReason(event: AutomodEvent): string {
	switch (event.reason) {
		case 'blocked_term':
			return 'Held by AutoMod: blocked term';
		case 'blocked_link':
			return 'Held by AutoMod: link';
		case 'automod': {
			const category = event.automod?.category?.replace(/_/g, ' ');
			const level = event.automod?.level;
			if (!category) {
				return 'Held by AutoMod';
			}
			return `Held by AutoMod: ${category}${typeof level === 'number' ? `, level ${level}` : ''}`;
		}
		default:
			return 'Held by AutoMod';
	}
}
