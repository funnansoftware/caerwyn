import { JsonObject, asNumber, asRecord, asString, isOptionalRecord, isRecord, parseJson } from '../../util/json';
import { AutomodEvent } from './twitchAutomod';
import { TwitchChatEvent } from './twitchMapper';
import { AutomaticRedemptionEvent, BitsUseEvent } from './twitchSpend';

// What EventSub sends over the WebSocket is untrusted until checked. `parseEventSubMessage` checks the envelope,
// and leaves each event a plain object that carries a channel. The guards below then narrow an event to the shape
// its mapper reads, once the subscription type says which one to expect.

export interface EventSubMessage {
	metadata?: { message_id?: string; message_type?: string; message_timestamp?: string; subscription_type?: string };
	payload?: {
		session?: { id?: string; keepalive_timeout_seconds?: number; reconnect_url?: string };
		subscription?: { type?: string; status?: string; condition?: { broadcaster_user_id?: string } };
		event?: JsonObject & { broadcaster_user_id: string };
	};
}

function hasChannel(value: unknown): value is JsonObject & { broadcaster_user_id: string } {
	return isRecord(value) && typeof value.broadcaster_user_id === 'string';
}

/** Parses one WebSocket frame, or returns `undefined` when it is not a JSON object. */
export function parseEventSubMessage(raw: string): EventSubMessage | undefined {
	const root = asRecord(parseJson(raw));
	if (!root) {
		return undefined;
	}
	const metadata = asRecord(root.metadata);
	const payload = asRecord(root.payload);
	const session = asRecord(payload?.session);
	const subscription = asRecord(payload?.subscription);
	const event = payload?.event;
	return {
		metadata: metadata && {
			message_id: asString(metadata.message_id),
			message_type: asString(metadata.message_type),
			message_timestamp: asString(metadata.message_timestamp),
			subscription_type: asString(metadata.subscription_type),
		},
		payload: payload && {
			session: session && {
				id: asString(session.id),
				keepalive_timeout_seconds: asNumber(session.keepalive_timeout_seconds),
				reconnect_url: asString(session.reconnect_url),
			},
			subscription: subscription && {
				type: asString(subscription.type),
				status: asString(subscription.status),
				condition: { broadcaster_user_id: asString(asRecord(subscription.condition)?.broadcaster_user_id) },
			},
			event: hasChannel(event) ? event : undefined,
		},
	};
}

/** A chat message or notice. These are the events that carry a message ID. */
export function isTwitchChatEvent(event: unknown): event is TwitchChatEvent {
	return (
		hasChannel(event) &&
		typeof event.message_id === 'string' &&
		(event.message === undefined || isRecord(event.message)) &&
		(event.badges === undefined || Array.isArray(event.badges)) &&
		isOptionalRecord(event.cheer) &&
		isOptionalRecord(event.reply)
	);
}

export function isAutomodEvent(event: unknown): event is AutomodEvent {
	return hasChannel(event) && isOptionalRecord(event.message) && isOptionalRecord(event.automod);
}

export function isAutomaticRedemptionEvent(event: unknown): event is AutomaticRedemptionEvent {
	return hasChannel(event) && isOptionalRecord(event.message) && isOptionalRecord(event.reward);
}

export function isBitsUseEvent(event: unknown): event is BitsUseEvent {
	return (
		hasChannel(event) && isOptionalRecord(event.message) && isOptionalRecord(event.power_up) && isOptionalRecord(event.custom_power_up)
	);
}
