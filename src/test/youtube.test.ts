import * as assert from 'assert';
import { NotSignedInError, YOUTUBE_SELF, youtubeVideoSource } from '../chat/types';
import { JsonObjectStream } from '../chat/youtube/jsonStream';
import { parseVideoId } from '../chat/youtube/videoId';
import { YouTubeChat } from '../chat/youtube/youtubeChat';
import { mapYouTubeItem } from '../chat/youtube/youtubeMapper';
import { FakeAuth, RecordingSink, delay, json, streamed, waitFor } from './helpers';

const context = { sourceId: 'youtube:me', liveChatId: 'chat1', channelName: 'My Stream' };

function textItem(id: string, text: string) {
	return {
		id,
		snippet: { type: 'textMessageEvent', publishedAt: '2026-11-21T17:00:00Z', displayMessage: text },
		authorDetails: { channelId: 'UC1', displayName: 'Viewer', isChatModerator: true },
	};
}

suite('JsonObjectStream', () => {
	test('extracts objects from a streamed JSON array split at arbitrary points', () => {
		const stream = new JsonObjectStream();
		const payload = '[{"a":1,"s":"br}ace \\" {quote"}\n,\n{"b":{"c":[1,2]}}\n,\n{"d":';
		const found: unknown[] = [];
		for (const char of payload) {
			found.push(...stream.push(char));
		}
		assert.deepStrictEqual(found, [{ a: 1, s: 'br}ace " {quote' }, { b: { c: [1, 2] } }]);
		assert.deepStrictEqual(stream.push('2}]'), [{ d: 2 }]);
	});

	test('reads the error form the streaming endpoint returns', () => {
		const objects = new JsonObjectStream().push('[{\n  "error": {\n    "code": 403\n  }\n}\n]');
		assert.deepStrictEqual(objects, [{ error: { code: 403 } }]);
	});
});

suite('parseVideoId', () => {
	test('accepts IDs and the common URL forms', () => {
		const id = 'jfKfPfyJRdk';
		for (const input of [
			id,
			`https://www.youtube.com/watch?v=${id}&t=10s`,
			`https://youtu.be/${id}`,
			`youtube.com/live/${id}?feature=share`,
			`https://studio.youtube.com/video/${id}/livestreaming`,
		]) {
			assert.strictEqual(parseVideoId(input), id, input);
		}
	});

	test('rejects other input', () => {
		for (const input of ['', 'not a video', 'https://example.com/watch?v=jfKfPfyJRdk', 'https://www.youtube.com/@channel']) {
			assert.strictEqual(parseVideoId(input), undefined, input);
		}
	});
});

suite('mapYouTubeItem', () => {
	test('maps a text message with author roles', () => {
		const result = mapYouTubeItem(textItem('m1', 'hello'), context);
		assert.ok(result && result !== 'ended' && result.type === 'message');
		assert.strictEqual(result.message.key, 'youtube:m1');
		assert.strictEqual(result.message.channelId, 'chat1');
		assert.deepStrictEqual(result.message.fragments, [{ type: 'text', text: 'hello' }]);
		assert.deepStrictEqual(result.message.author, { id: 'UC1', name: 'Viewer', avatarUrl: undefined, roles: ['moderator'] });
		assert.strictEqual(result.message.timestamp, Date.parse('2026-11-21T17:00:00Z'));
	});

	test('maps a Super Chat to a headline and comment', () => {
		const result = mapYouTubeItem(
			{ id: 'm2', snippet: { type: 'superChatEvent', superChatDetails: { amountDisplayString: '$5.00', userComment: 'gg' } } },
			context,
		);
		assert.ok(result && result !== 'ended' && result.type === 'message');
		assert.strictEqual(result.message.headline, 'Super Chat $5.00');
		assert.deepStrictEqual(result.message.fragments, [{ type: 'text', text: 'gg' }]);
	});

	test('maps removals, bans and the end of chat', () => {
		assert.deepStrictEqual(
			mapYouTubeItem({ id: 'e1', snippet: { type: 'messageDeletedEvent', messageDeletedDetails: { deletedMessageId: 'm1' } } }, context),
			{ type: 'delete', key: 'youtube:m1' },
		);
		assert.deepStrictEqual(
			mapYouTubeItem(
				{ id: 'e2', snippet: { type: 'userBannedEvent', userBannedDetails: { bannedUserDetails: { channelId: 'UC1' } } } },
				context,
			),
			{ type: 'purge', platform: 'youtube', channelId: 'chat1', userId: 'UC1' },
		);
		assert.strictEqual(mapYouTubeItem({ id: 'e3', snippet: { type: 'chatEndedEvent' } }, context), 'ended');
		assert.strictEqual(mapYouTubeItem({ id: 'e4', snippet: { type: 'tombstone' } }, context), undefined);
	});
});

suite('YouTubeChat', () => {
	const broadcasts = (status: string) =>
		json({ items: status === 'active' ? [{ snippet: { liveChatId: 'chat1', title: 'My Stream' } }] : [] });

	test('finds the active broadcast and reads its streamed chat until it ends', async () => {
		const sink = new RecordingSink();
		// "é" is split across two chunks to check multi-byte characters survive chunk boundaries.
		const encoded = new TextEncoder().encode(JSON.stringify({ items: [textItem('m2', 'café')] }));
		const split = encoded.indexOf(0xc3) + 1;
		const auth = new FakeAuth((url) => {
			if (url.includes('/liveBroadcasts')) {
				return broadcasts(new URL(url).searchParams.get('broadcastStatus') ?? '');
			}
			return streamed([
				`[${JSON.stringify({ items: [textItem('m1', 'first')], nextPageToken: 't1' })}\n,\n`,
				encoded.slice(0, split),
				encoded.slice(split),
				`\n,\n${JSON.stringify({ items: [{ id: 'end', snippet: { type: 'chatEndedEvent' } }] })}`,
			]);
		});
		const chat = new YouTubeChat({ auth, source: YOUTUBE_SELF, sink, transport: 'stream', streamUrl: 'https://stream.test/chat' });
		chat.start();
		try {
			await waitFor(() => sink.state('youtube:me') === 'ended', 'the chat to end');
		} finally {
			chat.dispose();
		}
		const texts = sink.events.map((event) => (event.type === 'message' ? event.message.fragments[0] : undefined));
		assert.deepStrictEqual(texts, [
			{ type: 'text', text: 'first' },
			{ type: 'text', text: 'café' },
		]);
		assert.strictEqual(sink.labels.get('youtube:me'), 'My Stream');
		const streamRequest = new URL(auth.requests.find((request) => request.url.startsWith('https://stream.test'))?.url ?? '');
		assert.strictEqual(streamRequest.searchParams.get('liveChatId'), 'chat1');
		assert.deepStrictEqual(streamRequest.searchParams.getAll('part'), ['id', 'snippet', 'authorDetails']);
		const lookup = new URL(auth.requests[0].url);
		assert.strictEqual(lookup.searchParams.get('broadcastType'), 'all');
	});

	test('polling resumes from the page token', async () => {
		const sink = new RecordingSink();
		let polls = 0;
		const auth = new FakeAuth((url) => {
			if (url.includes('/videos')) {
				return json({ items: [{ snippet: { channelTitle: 'Some Channel' }, liveStreamingDetails: { activeLiveChatId: 'chat9' } }] });
			}
			polls++;
			return polls === 1
				? json({ items: [textItem('m1', 'one')], nextPageToken: 't1', pollingIntervalMillis: 1 })
				: json({ items: [{ id: 'end', snippet: { type: 'chatEndedEvent' } }] });
		});
		const source = youtubeVideoSource('jfKfPfyJRdk');
		const chat = new YouTubeChat({ auth, source, sink, transport: 'poll' });
		chat.start();
		try {
			await waitFor(() => sink.state(source.id) === 'ended', 'the chat to end');
		} finally {
			chat.dispose();
		}
		const pollUrls = auth.requests.filter((request) => request.url.includes('/liveChat/messages')).map((request) => new URL(request.url));
		assert.strictEqual(pollUrls.length, 2);
		assert.strictEqual(pollUrls[0].searchParams.get('pageToken'), null);
		assert.strictEqual(pollUrls[1].searchParams.get('pageToken'), 't1');
		assert.strictEqual(sink.labels.get(source.id), 'Some Channel');
	});

	test('reports the broadcast’s viewers while its chat is read, and clears them when it ends', async () => {
		const sink = new RecordingSink();
		let viewers = '1234';
		let ended = false;
		const auth = new FakeAuth((url) => {
			if (url.includes('/liveBroadcasts')) {
				const active = new URL(url).searchParams.get('broadcastStatus') === 'active';
				return json({ items: active ? [{ id: 'vid1', snippet: { liveChatId: 'chat1', title: 'My Stream' } }] : [] });
			}
			if (url.includes('/videos')) {
				return json({ items: [{ liveStreamingDetails: { concurrentViewers: viewers } }] });
			}
			return json({ items: ended ? [{ id: 'end', snippet: { type: 'chatEndedEvent' } }] : [], pollingIntervalMillis: 1 });
		});
		const chat = new YouTubeChat({ auth, source: YOUTUBE_SELF, sink, transport: 'poll', viewerIntervalMs: 20, lookupIntervalMs: 60_000 });
		chat.start();
		try {
			await waitFor(() => sink.viewerCount('youtube:me') === 1234, 'the first count');
			const lookup = new URL(auth.requests.find((request) => request.url.includes('/videos'))?.url ?? '');
			assert.strictEqual(lookup.searchParams.get('id'), 'vid1', 'the broadcast ID is its video ID');
			assert.deepStrictEqual(lookup.searchParams.getAll('part'), ['liveStreamingDetails']);

			viewers = '1300';
			await waitFor(() => sink.viewerCount('youtube:me') === 1300, 'the next count');
			ended = true;
			await waitFor(() => sink.state('youtube:me') === 'ended', 'the chat to end');
			assert.strictEqual(sink.viewerCount('youtube:me'), undefined, 'no count once the chat has ended');
			const polls = auth.requests.filter((request) => request.url.includes('/videos')).length;
			await delay(100);
			assert.strictEqual(auth.requests.filter((request) => request.url.includes('/videos')).length, polls, 'polling stops with the chat');
		} finally {
			chat.dispose();
		}
	});

	test('reports a quota error once and does not retry', async () => {
		const sink = new RecordingSink();
		const auth = new FakeAuth((url) => {
			if (url.includes('/liveBroadcasts')) {
				return broadcasts(new URL(url).searchParams.get('broadcastStatus') ?? '');
			}
			return json([{ error: { code: 403, message: 'Quota exceeded.', errors: [{ reason: 'quotaExceeded' }] } }], 403);
		});
		const chat = new YouTubeChat({ auth, source: YOUTUBE_SELF, sink, transport: 'stream', streamUrl: 'https://stream.test/chat' });
		chat.start();
		try {
			await waitFor(() => sink.state('youtube:me') === 'error', 'the error status');
		} finally {
			chat.dispose();
		}
		assert.strictEqual(sink.statuses.get('youtube:me')?.detail, 'Quota exceeded. (quotaExceeded)');
		assert.strictEqual(auth.requests.filter((request) => request.url.startsWith('https://stream.test')).length, 1);
	});

	test('waits when there is no broadcast, and asks for sign-in when there is no session', async () => {
		const waiting = new RecordingSink();
		const idle = new YouTubeChat({ auth: new FakeAuth(() => json({ items: [] })), source: YOUTUBE_SELF, sink: waiting, transport: 'stream' });
		idle.start();
		try {
			await waitFor(() => waiting.state('youtube:me') === 'waiting', 'the waiting status');
		} finally {
			idle.dispose();
		}

		const signedOut = new RecordingSink();
		const auth = new FakeAuth(() => {
			throw new NotSignedInError();
		});
		const chat = new YouTubeChat({ auth, source: YOUTUBE_SELF, sink: signedOut, transport: 'stream' });
		chat.start();
		try {
			await waitFor(() => signedOut.state('youtube:me') === 'needsSignIn', 'the sign-in status');
		} finally {
			chat.dispose();
		}
	});
});
