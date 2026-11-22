import { ChatAuthor, ChatEvent, ChatMessage, Fragment, Role } from '../types';
import { youtubeEmojiUrl } from './youtubeEmoji';

// Pure mapping from YouTube `liveChatMessage` resources to the platform-neutral model.
// Field names follow the YouTube Data API v3 discovery document.

export interface YouTubeChatItem {
	id?: string;
	snippet?: {
		type?: string;
		liveChatId?: string;
		publishedAt?: string;
		displayMessage?: string;
		textMessageDetails?: { messageText?: string };
		superChatDetails?: { amountDisplayString?: string; userComment?: string };
		superStickerDetails?: { amountDisplayString?: string; superStickerMetadata?: { altText?: string } };
		memberMilestoneChatDetails?: { memberMonth?: number; memberLevelName?: string; userComment?: string };
		messageDeletedDetails?: { deletedMessageId?: string };
		messageRetractedDetails?: { retractedMessageId?: string };
		userBannedDetails?: { bannedUserDetails?: { channelId?: string } };
	};
	authorDetails?: {
		channelId?: string;
		displayName?: string;
		profileImageUrl?: string;
		isVerified?: boolean;
		isChatOwner?: boolean;
		isChatSponsor?: boolean;
		isChatModerator?: boolean;
	};
}

export interface YouTubeMapContext {
	sourceId: string;
	liveChatId: string;
	channelName: string;
}

/** What one chat item means: an event to show, the end of the chat, or nothing worth showing. */
export type YouTubeMapResult = ChatEvent | 'ended' | undefined;

/**
 * Splits chat text into text and emotes. YouTube sends its custom emoji as shortcodes such as
 * `:hand-pink-waving:`; only exact known shortcodes become emotes, so `10:30:` or `:unknown:` stay as text.
 */
function text(value: string | undefined): Fragment[] {
	if (!value) {
		return [];
	}
	const fragments: Fragment[] = [];
	let plainStart = 0;
	let open = value.indexOf(':');
	while (open !== -1) {
		const close = value.indexOf(':', open + 1);
		if (close === -1) {
			break;
		}
		const shortcode = value.slice(open, close + 1);
		const url = youtubeEmojiUrl(shortcode);
		if (url) {
			if (open > plainStart) {
				fragments.push({ type: 'text', text: value.slice(plainStart, open) });
			}
			fragments.push({ type: 'emote', text: shortcode, url });
			plainStart = close + 1;
			open = value.indexOf(':', plainStart);
		} else {
			// The closing colon may open the next shortcode, as in `10:30:hand-pink-waving:`.
			open = close;
		}
	}
	if (plainStart < value.length) {
		fragments.push({ type: 'text', text: value.slice(plainStart) });
	}
	return fragments;
}

function mapAuthor(item: YouTubeChatItem): ChatAuthor {
	const details = item.authorDetails ?? {};
	const roles: Role[] = [];
	if (details.isChatOwner) {
		roles.push('broadcaster');
	}
	if (details.isChatModerator) {
		roles.push('moderator');
	}
	if (details.isChatSponsor) {
		roles.push('subscriber');
	}
	if (details.isVerified) {
		roles.push('verified');
	}
	return {
		id: details.channelId ?? '',
		name: details.displayName || 'Unknown',
		avatarUrl: details.profileImageUrl,
		roles,
	};
}

export function mapYouTubeItem(item: YouTubeChatItem, context: YouTubeMapContext): YouTubeMapResult {
	const snippet = item.snippet;
	if (!snippet || !item.id) {
		return undefined;
	}
	const message = (fragments: Fragment[], headline?: string): ChatEvent => {
		const mapped: ChatMessage = {
			key: `youtube:${item.id}`,
			platform: 'youtube',
			id: item.id as string,
			sourceId: context.sourceId,
			channelId: context.liveChatId,
			channelName: context.channelName,
			author: mapAuthor(item),
			fragments,
			timestamp: Date.parse(snippet.publishedAt ?? '') || Date.now(),
		};
		if (headline) {
			mapped.headline = headline;
		}
		return { type: 'message', message: mapped };
	};

	switch (snippet.type) {
		case 'textMessageEvent':
			return message(text(snippet.displayMessage ?? snippet.textMessageDetails?.messageText));
		case 'superChatEvent': {
			const details = snippet.superChatDetails ?? {};
			return message(text(details.userComment), `Super Chat ${details.amountDisplayString ?? ''}`.trim());
		}
		case 'superStickerEvent': {
			const details = snippet.superStickerDetails ?? {};
			return message(text(details.superStickerMetadata?.altText), `Super Sticker ${details.amountDisplayString ?? ''}`.trim());
		}
		case 'memberMilestoneChatEvent': {
			const details = snippet.memberMilestoneChatDetails ?? {};
			const months = details.memberMonth;
			const headline = months ? `Member for ${months} ${months === 1 ? 'month' : 'months'}` : 'Member milestone';
			return message(text(details.userComment), headline);
		}
		case 'messageDeletedEvent':
			return deletion(snippet.messageDeletedDetails?.deletedMessageId);
		case 'messageRetractedEvent':
			return deletion(snippet.messageRetractedDetails?.retractedMessageId);
		case 'userBannedEvent': {
			const userId = snippet.userBannedDetails?.bannedUserDetails?.channelId;
			return userId ? { type: 'purge', platform: 'youtube', channelId: context.liveChatId, userId } : undefined;
		}
		case 'chatEndedEvent':
			return 'ended';
		case 'tombstone':
		case 'sponsorOnlyModeStartedEvent':
		case 'sponsorOnlyModeEndedEvent':
		case 'invalidType':
			return undefined;
		default:
			// New members, gifted memberships, polls and any type added later: show YouTube's own wording.
			return snippet.displayMessage ? message([], snippet.displayMessage) : undefined;
	}
}

function deletion(id: string | undefined): ChatEvent | undefined {
	return id ? { type: 'delete', key: `youtube:${id}` } : undefined;
}
