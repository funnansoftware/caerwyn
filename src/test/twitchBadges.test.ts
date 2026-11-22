import * as assert from 'assert';
import { TwitchBadges, parseBadgeSets } from '../chat/twitch/twitchBadges';
import { mapChatMessage, mapNotification } from '../chat/twitch/twitchMapper';
import { SpendMatcher, mapAutomaticRedemption } from '../chat/twitch/twitchSpend';
import { FakeAuth, json } from './helpers';

const CDN = 'https://static-cdn.jtvnw.net/badges/v1';

/** Shaped like Get Global Chat Badges. */
const globalBadges = {
	data: [
		{
			set_id: 'moderator',
			versions: [{ id: '1', image_url_1x: `${CDN}/mod/1`, image_url_2x: `${CDN}/mod/2`, image_url_4x: `${CDN}/mod/3`, title: 'Moderator' }],
		},
		{
			set_id: 'blossom-badge',
			versions: [
				{ id: '1', image_url_1x: `${CDN}/blossom1/1`, image_url_2x: `${CDN}/blossom1/2`, title: 'Blossom Badge Level 1' },
				{ id: '4', image_url_1x: `${CDN}/blossom4/1`, image_url_2x: `${CDN}/blossom4/2`, title: 'Blossom Badge Level 4' },
			],
		},
		{ set_id: 'subscriber', versions: [{ id: '0', image_url_2x: `${CDN}/sub-global/2`, title: 'Subscriber' }] },
	],
};

/** Shaped like Get Channel Chat Badges: the channel's own subscriber badges. */
const channelBadges = {
	data: [
		{
			set_id: 'subscriber',
			versions: [
				{ id: '0', image_url_2x: `${CDN}/sub-own-0/2`, title: 'Subscriber' },
				{ id: '12', image_url_2x: `${CDN}/sub-own-12/2`, title: '1-Year Subscriber' },
			],
		},
	],
};

function helix(url: string): Response {
	if (url.endsWith('/chat/badges/global')) {
		return json(globalBadges);
	}
	if (url.includes('/chat/badges?broadcaster_id=100')) {
		return json(channelBadges);
	}
	return json({ data: [] });
}

async function loaded(respond = helix): Promise<{ badges: TwitchBadges; auth: FakeAuth; logs: string[] }> {
	const auth = new FakeAuth(respond);
	const logs: string[] = [];
	const badges = new TwitchBadges(auth, 'https://helix.test', (message) => logs.push(message));
	await badges.load(['100', '200']);
	return { badges, auth, logs };
}

const event = {
	broadcaster_user_id: '100',
	broadcaster_user_name: 'Me',
	chatter_user_id: '7',
	chatter_user_login: 'viewer',
	chatter_user_name: 'Viewer',
	message_id: 'abc',
	message: { text: 'hi', fragments: [{ type: 'text', text: 'hi' }] },
	badges: [
		{ set_id: 'moderator', id: '1', info: '' },
		{ set_id: 'subscriber', id: '12', info: '16' },
		{ set_id: 'blossom-badge', id: '4', info: '' },
		{ set_id: 'vip', id: '1', info: '' },
	],
};

suite('Twitch badges', () => {
	test('keeps only well-formed badges served from the Twitch CDN', () => {
		const catalog = parseBadgeSets([
			{},
			{ set_id: 'no-versions' },
			{ set_id: 'mixed', versions: [{}, { id: '1' }, { id: '2', image_url_2x: 'https://evil.test/x.png', title: 'Elsewhere' }, { id: '3', image_url_1x: `${CDN}/a/1` }] },
		]);
		assert.deepStrictEqual([...catalog], [['mixed/3', { title: 'mixed', url: `${CDN}/a/1` }]]);
		assert.strictEqual(parseBadgeSets({ not: 'a list' }).size, 0);
	});

	test('maps each badge to its picture, the channel\'s own version first, with its role', async () => {
		const { badges } = await loaded();
		const author = mapChatMessage(event, 'twitch:me', 0, undefined, badges).author;
		assert.deepStrictEqual(author.roles, ['moderator', 'subscriber', 'vip']);
		assert.deepStrictEqual(author.badges, [
			{ title: 'Moderator', url: `${CDN}/mod/2`, role: 'moderator' },
			{ title: '1-Year Subscriber', url: `${CDN}/sub-own-12/2`, role: 'subscriber' },
			{ title: 'Blossom Badge Level 4', url: `${CDN}/blossom4/2` },
		], 'the unknown VIP version has no picture, so it is left to its role label');

		const elsewhere = mapNotification({ ...event, broadcaster_user_id: '200', badges: [{ set_id: 'subscriber', id: '0' }] }, 'twitch:other', 0, badges);
		assert.deepStrictEqual(elsewhere.author.badges, [{ title: 'Subscriber', url: `${CDN}/sub-global/2`, role: 'subscriber' }], 'a channel without its own badges uses the global ones');
	});

	test('leaves badges out when there are no pictures for them', async () => {
		const { badges } = await loaded();
		assert.strictEqual('badges' in mapChatMessage(event, 'twitch:me', 0).author, false, 'no lookup');
		assert.strictEqual('badges' in mapChatMessage({ ...event, badges: [{ set_id: 'constructor', id: '1' }] }, 'twitch:me', 0, undefined, badges).author, false);
	});

	test('keeps a paid message\'s badges when its cost arrives and it is mapped again', async () => {
		const { badges } = await loaded();
		const matcher = new SpendMatcher(undefined, badges);
		const paid = { ...event, message_type: 'channel_points_highlighted', message: { text: 'hi Kappa @me' } };
		assert.strictEqual(matcher.message(paid, 'twitch:me', 5).author.badges?.length, 3);
		const cost = mapAutomaticRedemption(
			{
				id: 'r1',
				broadcaster_user_id: '100',
				user_id: '7',
				user_name: 'Viewer',
				reward: { type: 'send_highlighted_message', channel_points: 1500 },
				message: { text: 'hi Kappa @me' },
			},
			'twitch:me',
			9,
			'n1',
		);
		assert.ok(cost?.kind === 'cost');
		const updated = matcher.cost(cost.cost);
		assert.deepStrictEqual(updated?.spent, [{ currency: 'points', amount: 1500 }]);
		assert.strictEqual(updated?.author.badges?.length, 3);
	});

	test('logs a failed load without throwing, and tries again next time', async () => {
		let fail = true;
		const { badges, auth, logs } = await loaded((url) => (fail ? json({ message: 'Invalid OAuth token' }, 401) : helix(url)));
		assert.strictEqual(badges.find('100', 'moderator', '1'), undefined);
		assert.ok(logs.some((line) => line.includes('Invalid OAuth token')));

		fail = false;
		await badges.load(['100', '200']);
		assert.strictEqual(badges.find('100', 'moderator', '1')?.title, 'Moderator');
		const requests = auth.requests.length;
		await badges.load(['100', '200']);
		assert.strictEqual(auth.requests.length, requests, 'what loaded is not fetched again');
	});

	test('survives a request that throws', async () => {
		const { badges, logs } = await loaded(() => {
			throw new Error('offline');
		});
		assert.strictEqual(badges.find('100', 'moderator', '1'), undefined);
		assert.ok(logs.some((line) => line.includes('offline')));
	});
});
