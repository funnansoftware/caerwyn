import type { ChatEvent, ChatMessage, Fragment, Role, SourceInfo } from '../chat/types';
import type { HostMessage, ViewAction, ViewSettings, WebviewMessage } from '../panel/protocol';

// The chat tab's renderer. It holds no state of its own beyond the DOM: the extension host sends the
// recent history on `ready` and then a stream of events.
// All chat content is untrusted and only ever reaches the page through `textContent`.

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };
const vscode = acquireVsCodeApi();

/** How close to the bottom, in pixels, still counts as following the chat. */
const STICK_THRESHOLD = 48;
const ROLE_LABELS: Record<Role, [label: string, title: string]> = {
	broadcaster: ['HOST', 'Broadcaster'],
	moderator: ['MOD', 'Moderator'],
	vip: ['VIP', 'VIP'],
	subscriber: ['SUB', 'Subscriber or member'],
	verified: ['✓', 'Verified'],
};
/** Twitch's default name colours, used for anyone without a colour of their own. */
const NAME_COLORS = [
	'#FF0000', '#0000FF', '#008000', '#B22222', '#FF7F50', '#9ACD32', '#FF4500', '#2E8B57',
	'#DAA520', '#D2691E', '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00FF7F',
];
const STATE_TEXT: Partial<Record<SourceInfo['status']['state'], string>> = {
	idle: 'Not connected',
	connecting: 'Connecting…',
	waiting: 'Waiting',
	ended: 'Ended',
	needsSignIn: 'Sign in',
	error: 'Error',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	node.className = className;
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

const root = document.getElementById('root') as HTMLElement;
const sourcesBar = el('header', 'sources');
const log = el('main', 'log');
const empty = el('div', 'empty');
const jump = el('button', 'jump');
log.setAttribute('role', 'log');
jump.hidden = true;
root.append(sourcesBar, log, empty, jump);

let settings: ViewSettings = { maxMessages: 500, showTimestamps: false };
let sources: SourceInfo[] = [];
let stick = true;
let unseen = 0;
const rows = new Map<string, HTMLElement>();

function act(action: ViewAction): void {
	vscode.postMessage({ type: 'action', action });
}

function actionButton(label: string, action: ViewAction): HTMLButtonElement {
	const button = el('button', 'action', label);
	button.addEventListener('click', () => act(action));
	return button;
}

function nameColor(message: ChatMessage): string {
	if (message.author.color) {
		return message.author.color;
	}
	let hash = 0;
	for (const char of message.author.id || message.author.name) {
		hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	}
	return NAME_COLORS[hash % NAME_COLORS.length];
}

function renderFragments(target: HTMLElement, fragments: Fragment[]): void {
	for (const fragment of fragments) {
		if (fragment.type === 'emote') {
			const image = el('img', 'emote');
			image.src = fragment.url;
			image.alt = fragment.text;
			image.title = fragment.text;
			image.addEventListener('load', followIfStuck);
			// If the image cannot load, the alt text stands in for it.
			target.append(image);
		} else if (fragment.type === 'mention') {
			target.append(el('span', 'mention', fragment.text));
		} else {
			target.append(fragment.text);
		}
	}
}

function renderMessage(message: ChatMessage): HTMLElement {
	const row = el('div', `msg ${message.platform}`);
	row.dataset.key = message.key;
	row.dataset.channel = `${message.platform}:${message.channelId}`;
	row.dataset.user = message.author.id;
	if (message.headline) {
		row.classList.add('notice');
		row.append(el('div', 'headline', message.headline));
	}
	if (message.action) {
		row.classList.add('action-message');
	}
	if (message.replyTo) {
		row.append(el('div', 'reply', `Replying to @${message.replyTo.name}: ${message.replyTo.text}`));
	}
	const line = el('div', 'line');
	const time = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
	line.append(el('span', 'time', time));

	const platform = el('span', 'platform', message.platform === 'twitch' ? 'T' : 'Y');
	platform.title = `${message.platform === 'twitch' ? 'Twitch' : 'YouTube'} · ${message.channelName}`;
	line.append(platform);

	for (const role of message.author.roles) {
		const [label, title] = ROLE_LABELS[role];
		const badge = el('span', `badge ${role}`, label);
		badge.title = title;
		line.append(badge);
	}

	const author = el('span', 'author', message.author.name);
	author.style.setProperty('--name', nameColor(message));
	line.append(author);

	const body = el('span', 'body');
	renderFragments(body, message.fragments);
	if (body.childNodes.length > 0) {
		line.append(el('span', 'separator', message.action ? ' ' : ': '), body);
	}
	row.append(line);
	return row;
}

function markDeleted(row: HTMLElement): void {
	row.classList.add('deleted');
	row.querySelector('.reply')?.remove();
	const body = row.querySelector('.body');
	if (body) {
		body.textContent = 'message deleted';
	}
}

function followIfStuck(): void {
	if (stick) {
		log.scrollTop = log.scrollHeight;
	}
}

function updateJump(): void {
	jump.hidden = stick || unseen === 0;
	jump.textContent = `${unseen} new ${unseen === 1 ? 'message' : 'messages'} ↓`;
}

function updateEmpty(): void {
	empty.replaceChildren();
	empty.hidden = rows.size > 0;
	if (rows.size > 0) {
		return;
	}
	if (sources.length === 0) {
		empty.append(
			el('h2', 'empty-title', 'No chat connected'),
			el('p', 'empty-text', 'Sign in to read your Twitch and YouTube live chat here.'),
			actionButton('Sign in to Twitch', 'signInTwitch'),
			actionButton('Sign in to YouTube', 'signInYouTube'),
		);
	} else {
		empty.append(el('p', 'empty-text', 'No messages yet.'));
	}
}

function appendMessages(messages: readonly ChatMessage[]): void {
	const batch = document.createDocumentFragment();
	let added = 0;
	for (const message of messages) {
		if (rows.has(message.key)) {
			continue;
		}
		const row = renderMessage(message);
		rows.set(message.key, row);
		batch.append(row);
		added++;
	}
	if (added === 0) {
		return;
	}
	log.append(batch);
	// While the reader has scrolled up, keep extra history so the view does not jump under them.
	const limit = stick ? settings.maxMessages : settings.maxMessages * 2;
	while (rows.size > limit && log.firstElementChild) {
		const oldest = log.firstElementChild as HTMLElement;
		rows.delete(oldest.dataset.key ?? '');
		oldest.remove();
	}
	if (stick) {
		log.scrollTop = log.scrollHeight;
	} else {
		unseen += added;
	}
	updateJump();
	updateEmpty();
}

function applyEvents(events: ChatEvent[]): void {
	const messages: ChatMessage[] = [];
	for (const event of events) {
		if (event.type === 'message') {
			messages.push(event.message);
			continue;
		}
		// Keep ordering: show what arrived before a removal, then apply the removal.
		appendMessages(messages.splice(0));
		if (event.type === 'delete') {
			const row = rows.get(event.key);
			if (row) {
				markDeleted(row);
			}
			continue;
		}
		const channel = `${event.platform}:${event.channelId}`;
		for (const [key, row] of rows) {
			if (row.dataset.channel !== channel) {
				continue;
			}
			if (event.type === 'clear') {
				row.remove();
				rows.delete(key);
			} else if (row.dataset.user === event.userId) {
				markDeleted(row);
			}
		}
	}
	appendMessages(messages);
	updateEmpty();
}

function renderSources(): void {
	sourcesBar.replaceChildren();
	sourcesBar.hidden = sources.length === 0;
	for (const info of sources) {
		const { state, detail } = info.status;
		const chip = el('span', `chip ${info.source.platform} state-${state}`);
		chip.title = detail ?? STATE_TEXT[state] ?? 'Connected';
		chip.append(el('span', 'dot'), el('span', 'chip-label', info.label));
		if (state === 'needsSignIn') {
			chip.append(actionButton('Sign in', info.source.platform === 'twitch' ? 'signInTwitch' : 'signInYouTube'));
		} else if (state !== 'connected') {
			chip.append(el('span', 'chip-detail', detail ?? STATE_TEXT[state] ?? ''));
		}
		if (state === 'error') {
			chip.append(actionButton('Retry', 'reconnect'));
		}
		sourcesBar.append(chip);
	}
	updateEmpty();
}

function applySettings(next: ViewSettings): void {
	settings = next;
	root.classList.toggle('timestamps', settings.showTimestamps);
}

function reset(): void {
	rows.clear();
	log.replaceChildren();
	unseen = 0;
	stick = true;
	updateJump();
	updateEmpty();
}

log.addEventListener('scroll', () => {
	stick = log.scrollHeight - log.scrollTop - log.clientHeight < STICK_THRESHOLD;
	if (stick) {
		unseen = 0;
	}
	updateJump();
});

jump.addEventListener('click', () => {
	stick = true;
	unseen = 0;
	log.scrollTop = log.scrollHeight;
	updateJump();
});

window.addEventListener('resize', followIfStuck);

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
	const message = event.data;
	switch (message.type) {
		case 'init':
			applySettings(message.settings);
			reset();
			sources = message.sources;
			renderSources();
			appendMessages(message.messages);
			break;
		case 'events':
			applyEvents(message.events);
			break;
		case 'sources':
			sources = message.sources;
			renderSources();
			break;
		case 'settings':
			applySettings(message.settings);
			break;
		case 'reset':
			reset();
			break;
	}
});

updateEmpty();
vscode.postMessage({ type: 'ready' });
