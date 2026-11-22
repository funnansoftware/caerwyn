import type { Platform } from '../chat/types';

// Platform logos, drawn as inline SVG so the webview needs no image source beyond Twitch's emote CDN.
// Shapes from Simple Icons 16.30.0 (CC0), https://simpleicons.org. Twitch and YouTube are trademarks of their
// owners and are shown only to mark where a message came from, in each brand's own colours and unaltered.

const SVG_NS = 'http://www.w3.org/2000/svg';

interface Layer {
	d: string;
	fill: string;
}

const LOGOS: Record<Platform, Layer[]> = {
	twitch: [
		// The Glitch's white face, which the outline below leaves open.
		{ d: 'M6.857 1.714h13.714v9.429l-3.428 3.428h-3.429l-3 3v-3H6.857Z', fill: '#FFFFFF' },
		{
			d: 'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z',
			fill: '#9146FF',
		},
	],
	youtube: [
		// The white play triangle, which the button below leaves open.
		{ d: 'M9.545 15.568V8.432L15.818 12z', fill: '#FFFFFF' },
		{
			d: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
			fill: '#FF0000',
		},
	],
};

/** The platform's logo in its brand colours. Decorative: callers label the element it sits in. */
export function platformLogo(platform: Platform): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 24 24');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	svg.classList.add('logo');
	for (const layer of LOGOS[platform]) {
		const path = document.createElementNS(SVG_NS, 'path');
		path.setAttribute('d', layer.d);
		path.setAttribute('fill', layer.fill);
		svg.append(path);
	}
	return svg;
}
