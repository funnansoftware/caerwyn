// Moderation requests made from the chat view. Shared by the extension host and the webview, so this file must
// stay free of `vscode` and Node imports, like `types.ts`.

/** Twitch's longest timeout, two weeks. YouTube's temporary bans accept at least as much. */
export const MAX_TIMEOUT_SECONDS = 14 * 24 * 60 * 60;

export type ModerationAction =
	/** Removes one message. */
	| { type: 'delete'; messageKey: string }
	/** Stops a user chatting for a while and removes their messages. */
	| { type: 'timeout'; userId: string; durationSeconds: number }
	/** Stops a user chatting until unbanned and removes their messages. */
	| { type: 'ban'; userId: string }
	/** Lets a message AutoMod held into chat, or keeps it out. */
	| { type: 'automod'; messageKey: string; allow: boolean };

export interface ModerationRequest {
	/** The chat source the target message came from. */
	sourceId: string;
	action: ModerationAction;
}

/** Thrown for a moderation request that the source cannot carry out. Its message is shown to the user. */
export class ModerationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ModerationError';
	}
}

function isId(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

/** Checks a request that arrived from the webview. Returns `undefined` for anything malformed. */
export function parseModerationRequest(value: unknown): ModerationRequest | undefined {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}
	const { sourceId, action } = value as { sourceId?: unknown; action?: unknown };
	if (!isId(sourceId) || typeof action !== 'object' || action === null) {
		return undefined;
	}
	const a = action as { type?: unknown; messageKey?: unknown; userId?: unknown; durationSeconds?: unknown; allow?: unknown };
	switch (a.type) {
		case 'delete':
			return isId(a.messageKey) ? { sourceId, action: { type: 'delete', messageKey: a.messageKey } } : undefined;
		case 'ban':
			return isId(a.userId) ? { sourceId, action: { type: 'ban', userId: a.userId } } : undefined;
		case 'automod':
			return isId(a.messageKey) && typeof a.allow === 'boolean'
				? { sourceId, action: { type: 'automod', messageKey: a.messageKey, allow: a.allow } }
				: undefined;
		case 'timeout': {
			const seconds = a.durationSeconds;
			if (!isId(a.userId) || typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
				return undefined;
			}
			return { sourceId, action: { type: 'timeout', userId: a.userId, durationSeconds: seconds } };
		}
		default:
			return undefined;
	}
}

/** "10 minutes", "1 hour", "2 days". */
export function formatDuration(seconds: number): string {
	const units: [number, string][] = [
		[86400, 'day'],
		[3600, 'hour'],
		[60, 'minute'],
		[1, 'second'],
	];
	for (const [size, name] of units) {
		if (seconds >= size && seconds % size === 0) {
			const count = seconds / size;
			return `${count} ${name}${count === 1 ? '' : 's'}`;
		}
	}
	return `${seconds} seconds`;
}
