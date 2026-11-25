import { asString, readJsonObject } from '../../util/json';
import { ChatAuth } from '../types';

// Twitch chat badge pictures: the global set every channel shares, and each channel's own (subscriber, Bits).
// https://dev.twitch.tv/docs/api/reference/#get-global-chat-badges
// https://dev.twitch.tv/docs/api/reference/#get-channel-chat-badges

/** One badge version's picture and name. */
export interface BadgeImage {
	/** Twitch's name for the version, such as "Blossom Badge Level 4". */
	title: string;
	url: string;
}

/** Finds the picture for a badge a chatter wears. */
export interface BadgeLookup {
	find(broadcasterId: string, setId: string, versionId: string): BadgeImage | undefined;
}

interface HelixBadgeSet {
	set_id?: string;
	versions?: { id?: string; image_url_2x?: string; image_url_1x?: string; title?: string }[];
}

/** The only host the view's content security policy lets images load from that Twitch badges use. */
const BADGE_HOST = 'https://static-cdn.jtvnw.net/';

type Catalog = Map<string, BadgeImage>;

function key(setId: string, versionId: string): string {
	return `${setId}/${versionId}`;
}

export function parseBadgeSets(data: unknown): Catalog {
	const catalog: Catalog = new Map();
	if (!Array.isArray(data)) {
		return catalog;
	}
	for (const set of data as HelixBadgeSet[]) {
		if (typeof set?.set_id !== 'string' || !Array.isArray(set.versions)) {
			continue;
		}
		for (const version of set.versions) {
			// The 36px picture, drawn at 18px, stays sharp on high-density screens.
			const url = version?.image_url_2x || version?.image_url_1x;
			if (typeof version?.id !== 'string' || typeof url !== 'string' || !url.startsWith(BADGE_HOST)) {
				continue;
			}
			catalog.set(key(set.set_id, version.id), { title: version.title || set.set_id, url });
		}
	}
	return catalog;
}

/**
 * Every badge picture for the channels being read. Pictures are extra: a failure to load them is logged and
 * the chat shows role labels instead, so nothing here throws.
 */
export class TwitchBadges implements BadgeLookup {
	private global: Catalog | undefined;
	private readonly channels = new Map<string, Catalog>();

	constructor(
		private readonly auth: ChatAuth,
		private readonly helixUrl: string,
		private readonly log: (message: string) => void,
	) {}

	/** Loads the global badges and each channel's own, skipping any already loaded. */
	async load(broadcasterIds: string[]): Promise<void> {
		await Promise.all([
			this.global ? undefined : this.fetch('/chat/badges/global').then((catalog) => (this.global = catalog)),
			...broadcasterIds
				.filter((id) => !this.channels.has(id))
				.map((id) =>
					this.fetch(`/chat/badges?broadcaster_id=${encodeURIComponent(id)}`).then((catalog) => {
						if (catalog) {
							this.channels.set(id, catalog);
						}
					}),
				),
		]);
	}

	find(broadcasterId: string, setId: string, versionId: string): BadgeImage | undefined {
		// A channel's own version of a set, such as its subscriber badges, replaces the global one.
		const id = key(setId, versionId);
		return this.channels.get(broadcasterId)?.get(id) ?? this.global?.get(id);
	}

	/** Returns `undefined` on failure, so the next connection tries again. */
	private async fetch(path: string): Promise<Catalog | undefined> {
		try {
			const res = await this.auth.fetch(`${this.helixUrl}${path}`);
			const body = await readJsonObject(res);
			if (!res.ok) {
				this.log(`Twitch: could not load chat badges (${asString(body.message) ?? `HTTP ${res.status}`}).`);
				return undefined;
			}
			return parseBadgeSets(body.data);
		} catch (err) {
			this.log(`Twitch: could not load chat badges (${err instanceof Error ? err.message : String(err)}).`);
			return undefined;
		}
	}
}
