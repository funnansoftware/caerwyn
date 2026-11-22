import { formatDuration, type ModerationAction } from '../chat/moderation';
import type { ChatAuthor, ChatEvent, ChatMessage, Fragment, Platform, Role, SourceInfo } from '../chat/types';
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
/** Timeout lengths offered on the user card, in seconds. */
const TIMEOUTS: [seconds: number, label: string][] = [
	[60, '1m'],
	[600, '10m'],
	[3600, '1h'],
	[86400, '24h'],
];
/** How long the ban button waits for its confirming second click. */
const CONFIRM_MS = 4000;
/** Clicks closer together than this are one double-click. */
const DOUBLE_CLICK_MS = 400;
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
const card = el('aside', 'card');
log.setAttribute('role', 'log');
jump.hidden = true;
card.hidden = true;
card.setAttribute('role', 'dialog');
root.append(sourcesBar, log, empty, jump, card);

let settings: ViewSettings = { maxMessages: 500, showTimestamps: false };
let sources: SourceInfo[] = [];
let stick = true;
let unseen = 0;
const rows = new Map<string, HTMLElement>();
/** The messages behind `rows`, for the user card's history. */
const shown = new Map<string, ChatMessage>();

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

function appendBadges(target: HTMLElement, roles: Role[]): void {
	for (const role of roles) {
		const [label, title] = ROLE_LABELS[role];
		const badge = el('span', `badge ${role}`, label);
		badge.title = title;
		target.append(badge);
	}
}

function platformTag(platform: Platform, channelName: string): HTMLElement {
	const tag = el('span', 'platform', platform === 'twitch' ? 'T' : 'Y');
	tag.title = `${platformName(platform)} · ${channelName}`;
	return tag;
}

function platformName(platform: Platform): string {
	return platform === 'twitch' ? 'Twitch' : 'YouTube';
}

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
	line.append(el('span', 'time', formatTime(message.timestamp)), platformTag(message.platform, message.channelName));
	appendBadges(line, message.author.roles);

	const author = el('button', 'author', message.author.name);
	author.type = 'button';
	author.style.setProperty('--name', nameColor(message));
	if (message.author.id) {
		author.title = `Show ${message.author.name}`;
		author.addEventListener('click', (event) => {
			event.stopPropagation();
			openCard(message, author);
		});
	} else {
		// Anonymous gifts and the like have no user to show.
		author.disabled = true;
	}
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
	// The user card sits where the button would.
	jump.hidden = stick || unseen === 0 || cardTarget !== undefined;
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
			el('p', 'empty-text', 'Or try it without an account:'),
			actionButton('Start simulated chat', 'toggleSimulation'),
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
		shown.set(message.key, message);
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
		shown.delete(oldest.dataset.key ?? '');
		oldest.remove();
	}
	if (stick) {
		log.scrollTop = log.scrollHeight;
	} else {
		unseen += added;
	}
	updateJump();
	updateEmpty();
	refreshCard();
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
		if (event.type === 'clear' && cardTarget && `${cardTarget.platform}:${cardTarget.channelId}` === channel) {
			closeCard();
		}
		for (const [key, row] of rows) {
			if (row.dataset.channel !== channel) {
				continue;
			}
			if (event.type === 'clear') {
				row.remove();
				rows.delete(key);
				shown.delete(key);
			} else if (row.dataset.user === event.userId) {
				markDeleted(row);
			}
		}
	}
	appendMessages(messages);
	updateEmpty();
	refreshCard();
}

function renderSources(): void {
	sourcesBar.replaceChildren();
	sourcesBar.hidden = sources.length === 0;
	for (const info of sources) {
		const { state, detail } = info.status;
		const chip = el('span', `chip ${info.source.platform} state-${state}`);
		chip.classList.toggle('simulated', info.source.kind === 'simulated');
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
	refreshCard();
}

function applySettings(next: ViewSettings): void {
	settings = next;
	root.classList.toggle('timestamps', settings.showTimestamps);
}

function reset(): void {
	closeCard();
	rows.clear();
	shown.clear();
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
		case 'moderationResult':
			onModerationResult(message.requestId, message.error);
			break;
	}
});

// User card: who someone is, what they said in this chat, and moderation.
// It holds identifiers, not rows, because rows are trimmed and removed while it is open.

interface CardTarget {
	platform: Platform;
	channelId: string;
	channelName: string;
	sourceId: string;
	author: ChatAuthor;
	/** The message whose author was clicked. */
	messageKey: string;
}

let cardTarget: CardTarget | undefined;
let cardOpener: HTMLElement | undefined;
let cardStatus: { text: string; error: boolean } | undefined;
let confirmingBan = false;
/** When the ban button was armed. The second click of a double-click must not confirm it. */
let confirmArmedAt = 0;
let confirmTimer: ReturnType<typeof setTimeout> | undefined;
/** What the action buttons were last built from, so chat traffic does not rebuild them under the pointer. */
let actionsShape = '';
/** Likewise for the history list, so selecting text in it survives unrelated chat. */
let historyShape = '';
/** Set when a card opens, so its history first shows the clicked message rather than the newest one. */
let scrollToCurrent = false;
let nextRequestId = 1;
const pendingRequests = new Map<number, { target: CardTarget; done: string }>();

const cardHeader = el('div', 'card-header');
const cardActions = el('div', 'card-actions');
const cardStatusLine = el('div', 'card-status');
const historyTitle = el('div', 'card-section');
const historyList = el('div', 'history');
cardStatusLine.setAttribute('aria-live', 'polite');
card.append(cardHeader, cardActions, cardStatusLine, historyTitle, historyList);

function sameUser(a: CardTarget, b: CardTarget): boolean {
	return a.platform === b.platform && a.channelId === b.channelId && a.author.id === b.author.id;
}

function isTargetMessage(message: ChatMessage, target: CardTarget): boolean {
	return message.platform === target.platform && message.channelId === target.channelId && message.author.id === target.author.id;
}

function openCard(message: ChatMessage, opener: HTMLElement): void {
	const next: CardTarget = {
		platform: message.platform,
		channelId: message.channelId,
		channelName: message.channelName,
		sourceId: message.sourceId,
		author: message.author,
		messageKey: message.key,
	};
	if (!cardTarget || !sameUser(cardTarget, next) || cardTarget.messageKey !== next.messageKey) {
		cardStatus = undefined;
		setConfirmingBan(false);
	}
	cardTarget = next;
	cardOpener = opener;
	actionsShape = '';
	historyShape = '';
	scrollToCurrent = true;
	card.className = `card ${message.platform}`;
	card.setAttribute('aria-label', `${message.author.name} on ${platformName(message.platform)}`);
	renderCardHeader(message);
	card.hidden = false;
	refreshCard();
	updateJump();
	(cardHeader.querySelector('.card-close') as HTMLButtonElement).focus();
}

/** `restoreFocus` returns the keyboard to the name that opened the card, for closing by Esc or the close button. */
function closeCard(restoreFocus = false): void {
	if (!cardTarget) {
		return;
	}
	cardTarget = undefined;
	cardStatus = undefined;
	setConfirmingBan(false);
	card.hidden = true;
	updateJump();
	if (restoreFocus && cardOpener?.isConnected) {
		// Scrolling to the name would stop the chat following new messages.
		cardOpener.focus({ preventScroll: true });
	}
	cardOpener = undefined;
}

function renderCardHeader(message: ChatMessage): void {
	const { author } = message;
	const name = el('span', 'card-name', author.name);
	name.style.setProperty('--name', nameColor(message));
	const who = el('div', 'card-who');
	who.append(platformTag(message.platform, message.channelName));
	appendBadges(who, author.roles);
	who.append(name);
	if (author.login && author.login.toLowerCase() !== author.name.toLowerCase()) {
		who.append(el('span', 'card-login', author.login));
	}
	const close = el('button', 'card-close', '×');
	close.type = 'button';
	close.title = 'Close (Esc)';
	close.setAttribute('aria-label', 'Close');
	close.addEventListener('click', () => closeCard(true));
	const where = el('div', 'card-where', `${platformName(message.platform)} · ${message.channelName}`);
	cardHeader.replaceChildren(who, close, where);
}

function canModerate(target: CardTarget): boolean {
	return sources.some((info) => info.source.id === target.sourceId && info.canModerate);
}

/** Brings the open card up to date with the chat: history, and which actions still apply. */
function refreshCard(): void {
	const target = cardTarget;
	if (!target) {
		return;
	}
	const allowed = canModerate(target);
	const busy = [...pendingRequests.values()].some((request) => sameUser(request.target, target));
	const shape = `${allowed}|${busy}|${confirmingBan}`;
	if (shape !== actionsShape) {
		actionsShape = shape;
		renderCardActions(target, allowed, busy);
	}
	cardStatusLine.hidden = !cardStatus;
	cardStatusLine.textContent = cardStatus?.text ?? '';
	cardStatusLine.classList.toggle('error', cardStatus?.error === true);
	renderHistory(target, allowed, busy);
}

function cardButton(label: string, className: string, onClick: () => void): HTMLButtonElement {
	const button = el('button', `card-button ${className}`, label);
	button.type = 'button';
	button.addEventListener('click', onClick);
	return button;
}

/** Actions on the user as a whole. Deleting acts on one message, so it sits on each message in the history. */
function renderCardActions(target: CardTarget, allowed: boolean, busy: boolean): void {
	cardActions.replaceChildren();
	const isBroadcaster = target.author.roles.includes('broadcaster');
	const disabled = !allowed || busy;

	if (!isBroadcaster) {
		const group = el('div', 'card-group');
		group.append(el('span', 'card-label', 'Timeout'));
		for (const [seconds, label] of TIMEOUTS) {
			const button = cardButton(label, 'secondary', () =>
				moderate(target, { type: 'timeout', userId: target.author.id, durationSeconds: seconds }, `Timed out for ${formatDuration(seconds)}.`),
			);
			button.title = `Time out for ${formatDuration(seconds)}`;
			button.disabled = disabled;
			group.append(button);
		}
		const ban = cardButton(confirmingBan ? 'Confirm ban' : 'Ban', confirmingBan ? 'danger confirm' : 'danger', () => {
			if (!confirmingBan) {
				setConfirmingBan(true);
				refreshCard();
				return;
			}
			if (Date.now() - confirmArmedAt < DOUBLE_CLICK_MS) {
				return;
			}
			setConfirmingBan(false);
			moderate(target, { type: 'ban', userId: target.author.id }, 'Banned.');
		});
		ban.title = confirmingBan ? `Click again to ban ${target.author.name}` : `Ban ${target.author.name}`;
		ban.disabled = disabled;
		group.append(ban);
		cardActions.append(group);
	}
	if (!allowed) {
		cardActions.append(el('p', 'card-note', `Moderating ${platformName(target.platform)} chat is not available yet.`));
	} else if (isBroadcaster) {
		cardActions.append(el('p', 'card-note', 'This is the channel’s broadcaster.'));
	}
}

function setConfirmingBan(value: boolean): void {
	confirmingBan = value;
	clearTimeout(confirmTimer);
	if (value) {
		confirmArmedAt = Date.now();
		confirmTimer = setTimeout(() => {
			confirmingBan = false;
			refreshCard();
		}, CONFIRM_MS);
	}
}

function moderate(target: CardTarget, action: ModerationAction, done: string): void {
	const requestId = nextRequestId++;
	pendingRequests.set(requestId, { target, done });
	cardStatus = undefined;
	vscode.postMessage({ type: 'moderate', requestId, request: { sourceId: target.sourceId, action } });
	refreshCard();
}

function onModerationResult(requestId: number, error: string | undefined): void {
	const request = pendingRequests.get(requestId);
	if (!request) {
		return;
	}
	pendingRequests.delete(requestId);
	if (cardTarget && sameUser(cardTarget, request.target)) {
		cardStatus = error ? { text: error, error: true } : { text: request.done, error: false };
	}
	refreshCard();
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A trash can drawn in the current text colour, so it follows the theme. Built as DOM: the CSP allows no icon font. */
function trashIcon(): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('icon');
	const path = document.createElementNS(SVG_NS, 'path');
	// Lid, handle, can, and two ribs.
	path.setAttribute('d', 'M2.5 4h11M6 4V2.5h4V4M3.75 4l.75 9.5h7l.75-9.5M6.5 6.5v4.5M9.5 6.5v4.5');
	svg.append(path);
	return svg;
}

function renderHistory(target: CardTarget, allowed: boolean, busy: boolean): void {
	const theirs = [...shown.values()].filter((message) => isTargetMessage(message, target));
	const isDeleted = (message: ChatMessage) => rows.get(message.key)?.classList.contains('deleted') === true;
	const shape = `${allowed}|${busy}|${theirs.map((message) => `${message.key}${isDeleted(message) ? '-' : ''}`).join(' ')}`;
	if (shape === historyShape) {
		return;
	}
	historyShape = shape;
	historyTitle.textContent = theirs.length === 1 ? '1 recent message' : `${theirs.length} recent messages`;
	const atBottom = historyList.scrollHeight - historyList.scrollTop - historyList.clientHeight < STICK_THRESHOLD;
	historyList.replaceChildren();
	let current: HTMLElement | undefined;
	for (const message of theirs) {
		const item = el('div', 'history-item');
		if (message.key === target.messageKey) {
			item.classList.add('current');
			current = item;
		}
		const text = el('div', 'history-text');
		text.append(el('span', 'history-time', formatTime(message.timestamp)));
		const body = el('span', 'body');
		const deleted = isDeleted(message);
		if (deleted) {
			item.classList.add('deleted');
			body.textContent = 'message deleted';
		} else {
			if (message.headline) {
				body.append(el('span', 'history-headline', message.headline), ' ');
			}
			renderFragments(body, message.fragments);
		}
		text.append(body);
		item.append(text);
		// Only something the user wrote can be deleted; a bare sub or raid notice has nothing to remove.
		if (!deleted && message.fragments.length > 0) {
			const remove = cardButton('', 'history-delete', () =>
				moderate(target, { type: 'delete', messageKey: message.key }, 'Message deleted.'),
			);
			remove.append(trashIcon());
			remove.setAttribute('aria-label', 'Delete this message');
			remove.title = allowed ? 'Delete this message' : `Moderating ${platformName(target.platform)} chat is not available yet.`;
			remove.disabled = !allowed || busy;
			item.append(remove);
		}
		historyList.append(item);
	}
	if (theirs.length === 0) {
		historyList.append(el('p', 'card-note', 'None of their messages are in the chat now.'));
	}
	if (scrollToCurrent && current) {
		// Centre the clicked message in the list without scrolling anything outside it.
		// The list is the items' offset parent, so `offsetTop` is already relative to it.
		historyList.scrollTop = current.offsetTop - (historyList.clientHeight - current.offsetHeight) / 2;
	} else if (atBottom || scrollToCurrent) {
		historyList.scrollTop = historyList.scrollHeight;
	}
	scrollToCurrent = false;
}

document.addEventListener('keydown', (event) => {
	if (event.key === 'Escape' && cardTarget) {
		event.preventDefault();
		closeCard(true);
	}
});

// A click elsewhere closes the card. Author buttons stop their click, so they switch the card instead.
document.addEventListener('click', (event) => {
	if (cardTarget && event.target instanceof Node && event.target.isConnected && !card.contains(event.target)) {
		closeCard();
	}
});

updateEmpty();
vscode.postMessage({ type: 'ready' });
