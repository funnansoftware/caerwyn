const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Extracts a video ID from a bare ID or a YouTube / YouTube Studio URL. */
export function parseVideoId(input: string): string | undefined {
	const text = input.trim();
	if (VIDEO_ID.test(text)) {
		return text;
	}
	let url: URL;
	try {
		url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
	} catch {
		return undefined;
	}
	const host = url.hostname.replace(/^(www|m|music|studio)\./, '');
	const segments = url.pathname.split('/').filter(Boolean);
	let candidate: string | undefined;
	if (host === 'youtu.be') {
		candidate = segments[0];
	} else if (host === 'youtube.com') {
		// /watch?v=ID, /live/ID, /embed/ID, /shorts/ID, and Studio's /video/ID/livestreaming
		candidate = url.searchParams.get('v') ?? (['live', 'embed', 'shorts', 'video'].includes(segments[0]) ? segments[1] : undefined);
	}
	return candidate && VIDEO_ID.test(candidate) ? candidate : undefined;
}
