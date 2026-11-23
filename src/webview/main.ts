import { formatDuration, type ModerationAction } from '../chat/moderation';
import type { ChatAuthor, ChatEvent, ChatMessage, CommandFeedback, Fragment, HistoryEntry, HistoryPage, Platform, Role, SourceInfo, ViewerCounts } from '../chat/types';
import type { HostMessage, ViewAction, ViewSettings, WebviewMessage } from '../panel/protocol';
import { currencyIcon, platformLogo } from './logos';

// The chat tab's renderer. It holds no state of its own beyond the DOM: the extension host sends the
// recent history on `ready` and then a stream of events.
// All chat content is untrusted and only ever reaches the page through `textContent`.

declare function acquireVsCodeApi(): {
	postMessage(message: WebviewMessage): void;
	getState(): unknown;
	setState(state: unknown): void;
};
const vscode = acquireVsCodeApi();

type PlatformFilter = 'all' | Platform;

/** What this view remembers while it is hidden and rebuilt. Each view (tab, sidebar) keeps its own. */
interface ViewState {
	platformFilter?: PlatformFilter;
}

function savedState(): ViewState {
	const state = vscode.getState();
	return typeof state === 'object' && state !== null ? (state as ViewState) : {};
}

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

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A line icon drawn in the current text colour, so it follows the theme. Built as DOM: the CSP allows no icon font. */
function lineIcon(d: string): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('aria-hidden', 'true');
	svg.classList.add('icon');
	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', d);
	svg.append(path);
	return svg;
}

/** An eye: the outline, then the pupil. */
const EYE_ICON = 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8ZM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z';

const root = document.getElementById('root') as HTMLElement;
const header = el('header', 'header');
const viewersBar = el('div', 'viewers');
viewersBar.hidden = true;
viewersBar.setAttribute('role', 'group');
viewersBar.setAttribute('aria-label', 'Viewers');
const sourcesBar = el('div', 'sources');
const filterBar = el('div', 'filters');
filterBar.setAttribute('role', 'toolbar');
filterBar.setAttribute('aria-label', 'Show messages from');
header.append(viewersBar, sourcesBar, filterBar);
const log = el('main', 'log');
const empty = el('div', 'empty');
const jump = el('button', 'jump');
const card = el('aside', 'card');
log.setAttribute('role', 'log');
jump.hidden = true;
card.hidden = true;
card.setAttribute('role', 'dialog');
root.append(header, log, empty, jump, card);

let settings: ViewSettings = { maxMessages: 500, showTimestamps: false };
let sources: SourceInfo[] = [];
let viewerCounts: ViewerCounts = {};
let stick = true;
let unseen = 0;
let platformFilter: PlatformFilter = (() => {
	const saved = savedState().platformFilter;
	return saved === 'twitch' || saved === 'youtube' ? saved : 'all';
})();
const rows = new Map<string, HTMLElement>();
/** The messages behind `rows`, for the user card's history. */
const shown = new Map<string, ChatMessage>();
/**
 * What became of each chat command, by message key. Kept apart from the rows because it can arrive just before its
 * message, and must survive the row being rendered again.
 */
const feedback = new Map<string, CommandFeedback>();

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

/** Badge pictures, then a label for each role no picture stands for (YouTube roles, or a badge Twitch did not describe). */
function appendBadges(target: HTMLElement, author: ChatAuthor): void {
	const pictured = new Set<Role>();
	for (const badge of author.badges ?? []) {
		const image = el('img', 'badge-image');
		image.src = badge.url;
		image.alt = badge.title;
		image.title = badge.title;
		// A picture that cannot load gives way to its role's label, or to nothing if it has no role.
		const role = badge.role;
		image.addEventListener('error', () => (role ? image.replaceWith(roleLabel(role)) : image.remove()), { once: true });
		target.append(image);
		if (role) {
			pictured.add(role);
		}
	}
	for (const role of author.roles) {
		if (!pictured.has(role)) {
			target.append(roleLabel(role));
		}
	}
}

function roleLabel(role: Role): HTMLElement {
	const [label, title] = ROLE_LABELS[role];
	const badge = el('span', `badge ${role}`, label);
	badge.title = title;
	return badge;
}

function platformTag(platform: Platform, channelName: string): HTMLElement {
	const tag = el('span', 'platform');
	tag.append(platformLogo(platform));
	tag.setAttribute('role', 'img');
	tag.setAttribute('aria-label', platformName(platform));
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
		const headline = el('div', 'headline', message.headline);
		appendSpent(headline, message);
		row.append(headline);
	}
	if (message.highlighted) {
		row.classList.add('highlighted');
	}
	if (message.firstTime) {
		row.classList.add('first-time');
	}
	if (message.action) {
		row.classList.add('action-message');
	}
	if (message.replyTo) {
		row.append(el('div', 'reply', `Replying to @${message.replyTo.name}: ${message.replyTo.text}`));
	}
	const line = el('div', 'line');
	line.append(el('span', 'time', formatTime(message.timestamp)), platformTag(message.platform, message.channelName));
	appendBadges(line, message.author);

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
	if (message.held) {
		renderHeldBody(body, message.held);
	}
	if (body.childNodes.length > 0) {
		line.append(el('span', 'separator', message.action ? ' ' : ': '), body);
	}
	row.append(line);
	if (message.held) {
		row.classList.add('held', `held-${message.held.state}`);
		if (message.held.state === 'held') {
			row.append(renderHeldActions(message));
		}
	}
	const outcome = feedback.get(message.key);
	if (outcome) {
		row.append(renderFeedback(outcome));
	}
	return row;
}

function renderFeedback(outcome: CommandFeedback): HTMLElement {
	const line = el('div', `command-feedback ${outcome.state}`, outcome.text);
	line.title = { waiting: 'Chat command waiting', done: 'Chat command ran', refused: 'Chat command did not run' }[outcome.state];
	return line;
}

function onFeedback(key: string, outcome: CommandFeedback): void {
	feedback.set(key, outcome);
	const row = rows.get(key);
	if (!row || row.classList.contains('deleted')) {
		return; // Its message arrives next, and picks this up as it is rendered.
	}
	row.querySelector(':scope > .command-feedback')?.remove();
	row.append(renderFeedback(outcome));
	followIfStuck();
}

/**
 * What AutoMod caught stays hidden behind a button until the reader asks, in case the chat is on stream.
 * Once allowed, it is in chat for everyone, so it is shown.
 */
function renderHeldBody(body: HTMLElement, held: NonNullable<ChatMessage['held']>): void {
	if (held.state === 'allowed') {
		renderFragments(body, held.fragments);
		return;
	}
	const reveal = el('button', 'held-reveal', 'Show message');
	reveal.type = 'button';
	reveal.addEventListener('click', (event) => {
		event.stopPropagation();
		const text = el('span', 'held-text');
		renderFragments(text, held.fragments);
		reveal.replaceWith(text);
	});
	body.append(reveal);
}

/** Held messages waiting on Allow or Deny, by request ID, so the result reaches the right row. */
const heldRequests = new Map<number, { key: string; allow: boolean }>();

function renderHeldActions(message: ChatMessage): HTMLElement {
	const actions = el('div', 'held-actions');
	const status = el('span', 'held-status');
	status.setAttribute('aria-live', 'polite');
	const decide = (allow: boolean) => {
		const requestId = nextRequestId++;
		heldRequests.set(requestId, { key: message.key, allow });
		allowButton.disabled = true;
		denyButton.disabled = true;
		status.classList.remove('error');
		status.textContent = allow ? 'Allowing…' : 'Denying…';
		vscode.postMessage({ type: 'moderate', requestId, request: { sourceId: message.sourceId, action: { type: 'automod', messageKey: message.key, allow } } });
	};
	const allowButton = el('button', 'held-allow', 'Allow');
	allowButton.type = 'button';
	allowButton.addEventListener('click', () => decide(true));
	const denyButton = el('button', 'held-deny', 'Deny');
	denyButton.type = 'button';
	denyButton.addEventListener('click', () => decide(false));
	actions.append(allowButton, denyButton, status);
	return actions;
}

/** A held message's Allow or Deny came back. On success the row changes when the platform reports the outcome. */
function onHeldResult({ key, allow }: { key: string; allow: boolean }, error: string | undefined): void {
	const row = rows.get(key);
	const status = row?.querySelector<HTMLElement>('.held-status');
	if (!row || !status) {
		return;
	}
	if (error) {
		status.textContent = error;
		status.classList.add('error');
		row.querySelectorAll<HTMLButtonElement>('.held-actions button').forEach((button) => (button.disabled = false));
	} else {
		// Twitch has done it. Its own report of the outcome then redraws the row.
		status.textContent = allow ? 'Allowed.' : 'Denied.';
	}
}

/** Twitch colours a Bits gem by how many Bits it stands for: from 1, 100, 1,000, 5,000 and 10,000 up. */
const BITS_TIERS = [10_000, 5_000, 1_000, 100, 1];

function bitsTier(amount: number): number {
	return BITS_TIERS.find((tier) => amount >= tier) ?? 1;
}

/** Each currency's icon and how much was spent, after a headline. */
function appendSpent(target: HTMLElement, message: ChatMessage): void {
	for (const { currency, amount } of message.spent ?? []) {
		const spent = el('span', `spent spent-${currency}`);
		spent.setAttribute('role', 'img');
		const unit = currency === 'bits' ? (amount === 1 ? 'Bit' : 'Bits') : amount === 1 ? 'channel point' : 'channel points';
		const label = amount === undefined ? unit : `${exactCount.format(amount)} ${unit}`;
		spent.setAttribute('aria-label', label);
		spent.title = label;
		const icon = currencyIcon(currency);
		if (currency === 'bits' && amount !== undefined) {
			icon.classList.add(`bits-tier-${bitsTier(amount)}`);
		}
		spent.append(icon);
		if (amount !== undefined) {
			spent.append(el('span', 'spent-amount', exactCount.format(amount)));
		}
		target.append(' ', spent);
	}
}

function markDeleted(row: HTMLElement): void {
	row.classList.add('deleted');
	row.querySelector('.reply')?.remove();
	row.querySelector('.held-actions')?.remove();
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

/** The filter in force. With only one platform connected there is nothing to filter, whatever was chosen. */
function activeFilter(): PlatformFilter {
	return filterBar.hidden ? 'all' : platformFilter;
}

function isShown(message: ChatMessage): boolean {
	const filter = activeFilter();
	return filter === 'all' || filter === message.platform;
}

function updateEmpty(): void {
	empty.replaceChildren();
	const filter = activeFilter();
	const visible = filter === 'all' ? rows.size > 0 : log.querySelector(`.msg.${filter}`) !== null;
	empty.hidden = visible;
	if (visible) {
		return;
	}
	if (rows.size > 0) {
		// Everything on screen is filtered out.
		empty.append(el('p', 'empty-text', `No ${platformName(filter as Platform)} messages yet.`));
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
	/** Only messages that pass the filter count towards "new messages". */
	let visible = 0;
	for (const message of messages) {
		if (rows.has(message.key)) {
			continue;
		}
		const row = renderMessage(message);
		rows.set(message.key, row);
		shown.set(message.key, message);
		batch.append(row);
		added++;
		if (isShown(message)) {
			visible++;
		}
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
	// Every message that had feedback waiting for it has now arrived.
	for (const key of feedback.keys()) {
		if (!rows.has(key)) {
			feedback.delete(key);
		}
	}
	if (stick) {
		log.scrollTop = log.scrollHeight;
	} else {
		unseen += visible;
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
			const saved = savedHistory.get(event.key);
			if (saved) {
				savedHistory.set(event.key, { message: { ...saved.message, fragments: [] }, deleted: true });
			}
			continue;
		}
		if (event.type === 'update') {
			const { key } = event.message;
			const row = rows.get(key);
			// A removed message stays removed.
			if (row && !row.classList.contains('deleted')) {
				const updated = renderMessage(event.message);
				row.replaceWith(updated);
				if (cardOpener && row.contains(cardOpener)) {
					// Closing the card returns focus to the name, so point it at the new row's.
					cardOpener = updated.querySelector<HTMLElement>('.author') ?? undefined;
				}
				rows.set(key, updated);
				shown.set(key, event.message);
			}
			continue;
		}
		const channel = `${event.platform}:${event.channelId}`;
		if (event.type === 'clear' && cardTarget && `${cardTarget.platform}:${cardTarget.channelId}` === channel) {
			closeCard();
		}
		if (
			event.type === 'purge' &&
			cardTarget &&
			`${cardTarget.platform}:${cardTarget.channelId}` === channel &&
			cardTarget.author.id === event.userId
		) {
			// Saved messages the chat no longer shows were removed too; read them again rather than guess which.
			requestHistory(cardTarget);
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
	renderViewers();
	renderFilters();
	updateEmpty();
	refreshCard();
}

const exactCount = new Intl.NumberFormat();
const compactCount = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** Large audiences are shortened to fit the header (12.3K); the tooltip has the exact figure. */
function shortCount(count: number): string {
	return count >= 10_000 ? compactCount.format(count) : exactCount.format(count);
}

/**
 * Each platform's audience, summed over its sources that are live. A platform with no live source is left out
 * rather than shown as 0, which would read as a live stream nobody is watching. The platform filter does not
 * apply: it narrows the chat, not the audience.
 */
function renderViewers(): void {
	const items: HTMLElement[] = [];
	for (const platform of ['twitch', 'youtube'] as const) {
		const counted = sources
			.filter((info) => info.source.platform === platform)
			.map((info) => ({ label: info.label, count: viewerCounts[info.source.id] }))
			.filter((entry): entry is { label: string; count: number } => typeof entry.count === 'number');
		if (counted.length === 0) {
			continue;
		}
		const total = counted.reduce((sum, entry) => sum + entry.count, 0);
		const name = platformName(platform);
		const item = el('span', `viewer-count ${platform}`);
		item.append(platformLogo(platform), el('span', 'viewer-number', shortCount(total)));
		item.setAttribute('role', 'img');
		item.setAttribute('aria-label', `${exactCount.format(total)} watching on ${name}`);
		const lines = [`${name}: ${exactCount.format(total)} watching`];
		if (counted.length > 1) {
			lines.push(...counted.map((entry) => `${entry.label}: ${exactCount.format(entry.count)}`));
		}
		item.title = lines.join('\n');
		items.push(item);
	}
	viewersBar.hidden = items.length === 0;
	if (items.length === 0) {
		viewersBar.replaceChildren();
		return;
	}
	viewersBar.replaceChildren(lineIcon(EYE_ICON), ...items);
}

const FILTER_OPTIONS: [PlatformFilter, string][] = [
	['all', 'All'],
	['twitch', 'Twitch'],
	['youtube', 'YouTube'],
];

/** The platform filter, shown only when chat comes from more than one platform. */
function renderFilters(): void {
	const platforms = new Set(sources.map((info) => info.source.platform));
	filterBar.hidden = platforms.size < 2;
	if (filterBar.childElementCount === 0) {
		buildFilterButtons();
	}
	applyFilter();
}

function buildFilterButtons(): void {
	for (const [value, label] of FILTER_OPTIONS) {
		const button = el('button', value === 'all' ? 'filter' : `filter ${value}`);
		button.type = 'button';
		button.dataset.filter = value;
		if (value === 'all') {
			button.append(label);
			button.title = 'Show all chat';
		} else {
			// The logo is the label on screen; the name still reaches screen readers and the tooltip.
			button.classList.add('icon-only');
			button.append(platformLogo(value));
			button.setAttribute('aria-label', label);
			button.title = `Show only ${label} chat`;
		}
		button.setAttribute('aria-pressed', String(value === platformFilter));
		button.addEventListener('click', () => setPlatformFilter(value));
		filterBar.append(button);
	}
}

function setPlatformFilter(value: PlatformFilter): void {
	if (value === platformFilter) {
		return;
	}
	platformFilter = value;
	vscode.setState({ ...savedState(), platformFilter: value } satisfies ViewState);
	// Update in place rather than rebuild, so the clicked button keeps keyboard focus.
	for (const button of filterBar.querySelectorAll('button')) {
		button.setAttribute('aria-pressed', String(button.dataset.filter === value));
	}
	applyFilter();
	// What was unseen under the old filter means nothing under the new one; show the newest of what is now visible.
	stick = true;
	unseen = 0;
	log.scrollTop = log.scrollHeight;
	updateJump();
}

/** Hides filtered-out messages with CSS, so switching is instant and messages keep arriving underneath. */
function applyFilter(): void {
	const filter = activeFilter();
	root.classList.toggle('only-twitch', filter === 'twitch');
	root.classList.toggle('only-youtube', filter === 'youtube');
	updateEmpty();
}

function applySettings(next: ViewSettings): void {
	settings = next;
	root.classList.toggle('timestamps', settings.showTimestamps);
}

function reset(): void {
	closeCard();
	rows.clear();
	shown.clear();
	feedback.clear();
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
			viewerCounts = message.viewers;
			renderSources();
			for (const [key, outcome] of Object.entries(message.feedback ?? {})) {
				feedback.set(key, outcome);
			}
			appendMessages(message.messages);
			break;
		case 'feedback':
			onFeedback(message.key, message.feedback);
			break;
		case 'events':
			applyEvents(message.events);
			break;
		case 'sources':
			sources = message.sources;
			renderSources();
			break;
		case 'viewers':
			viewerCounts = message.viewers;
			renderViewers();
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
		case 'historyResult':
			onHistoryResult(message.requestId, message.page);
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
/** The open card's saved messages fetched so far, by key. Live chat is merged in when shown. */
const savedHistory = new Map<string, HistoryEntry>();
/** The oldest saved message fetched, which the next page is fetched before. */
let oldestSaved: string | undefined;
let savedMore = false;
let savedTotal = 0;
let savedFailed = false;
/** The page being fetched for the open card, if any. Answers to any other request are ignored. */
let historyRequest: number | undefined;
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
	const newUser = !cardTarget || !sameUser(cardTarget, next);
	cardTarget = next;
	if (newUser) {
		forgetSavedHistory();
		requestHistory(next);
	}
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
	forgetSavedHistory();
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
	appendBadges(who, author);
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
	const held = heldRequests.get(requestId);
	if (held) {
		heldRequests.delete(requestId);
		onHeldResult(held, error);
		return;
	}
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

function trashIcon(): SVGSVGElement {
	// Lid, handle, can, and two ribs.
	return lineIcon('M2.5 4h11M6 4V2.5h4V4M3.75 4l.75 9.5h7l.75-9.5M6.5 6.5v4.5M9.5 6.5v4.5');
}

/** How many saved messages to fetch at a time, on top of what the chat already shows. */
const HISTORY_PAGE = 100;
/** How close to the top of the history, in pixels, fetches the next older page. */
const HISTORY_PREFETCH = 120;

function forgetSavedHistory(): void {
	savedHistory.clear();
	oldestSaved = undefined;
	savedMore = false;
	savedTotal = 0;
	savedFailed = false;
	historyRequest = undefined;
}

/** Fetches the newest saved page, or with `before`, the page before that message. */
function requestHistory(target: CardTarget, before?: string): void {
	const requestId = nextRequestId++;
	historyRequest = requestId;
	// The first page also covers what the chat shows, so scrolling up reaches older messages straight away.
	// Asked again after a purge, it also re-reads everything loaded so far.
	const loaded = before ? 0 : [...shown.values()].filter((message) => isTargetMessage(message, target)).length + savedHistory.size;
	vscode.postMessage({
		type: 'history',
		requestId,
		query: {
			platform: target.platform,
			sourceId: target.sourceId,
			channelId: target.channelId,
			userId: target.author.id,
			before,
			limit: HISTORY_PAGE + loaded,
		},
	});
}

function onHistoryResult(requestId: number, page: HistoryPage | undefined): void {
	if (requestId !== historyRequest || !cardTarget) {
		return;
	}
	historyRequest = undefined;
	if (!page) {
		savedFailed = true;
		savedMore = false;
	} else {
		for (const entry of page.entries) {
			savedHistory.set(entry.message.key, entry);
		}
		oldestSaved = page.entries[0]?.message.key ?? oldestSaved;
		savedMore = page.more && page.entries.length > 0;
		savedTotal = page.total;
	}
	refreshCard();
}

/** Fetches the next older page once the reader nears the top of what is loaded. */
function fetchOlderIfNeeded(): void {
	const target = cardTarget;
	if (target && savedMore && historyRequest === undefined && oldestSaved && historyList.scrollTop < HISTORY_PREFETCH) {
		requestHistory(target, oldestSaved);
		refreshCard();
	}
}

historyList.addEventListener('scroll', fetchOlderIfNeeded);

interface HistoryItem {
	message: ChatMessage;
	deleted: boolean;
	/** Still in the chat, so it can be moderated. */
	live: boolean;
}

/** Saved messages and those in the chat now, oldest first. The chat's copy wins: it has the latest changes. */
function historyItems(target: CardTarget): HistoryItem[] {
	const items = new Map<string, HistoryItem>();
	for (const [key, entry] of savedHistory) {
		items.set(key, { message: entry.message, deleted: entry.deleted, live: false });
	}
	for (const message of shown.values()) {
		if (isTargetMessage(message, target)) {
			const deleted = rows.get(message.key)?.classList.contains('deleted') === true || items.get(message.key)?.deleted === true;
			items.set(message.key, { message, deleted, live: true });
		}
	}
	return [...items.values()].sort((a, b) => a.message.timestamp - b.message.timestamp);
}

/** The local calendar day a time falls on. */
function dayKey(timestamp: number): string {
	const date = new Date(timestamp);
	return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

const dayInYear = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const dayWithYear = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

function dayLabel(timestamp: number): string {
	const now = new Date();
	const key = dayKey(timestamp);
	if (key === dayKey(now.getTime())) {
		return 'Today';
	}
	if (key === dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime())) {
		return 'Yesterday';
	}
	const date = new Date(timestamp);
	return (date.getFullYear() === now.getFullYear() ? dayInYear : dayWithYear).format(date);
}

/** The first message at least partly in view, and how far below the top of the list it sits. */
function historyAnchor(): { key: string; offset: number } | undefined {
	for (const item of historyList.querySelectorAll<HTMLElement>('.history-item')) {
		if (item.offsetTop + item.offsetHeight > historyList.scrollTop) {
			return { key: item.dataset.key ?? '', offset: item.offsetTop - historyList.scrollTop };
		}
	}
	return undefined;
}

function renderHistoryItem(target: CardTarget, item: HistoryItem, allowed: boolean, busy: boolean): HTMLElement {
	const { message, deleted } = item;
	const row = el('div', 'history-item');
	row.dataset.key = message.key;
	if (message.key === target.messageKey) {
		row.classList.add('current');
	}
	const text = el('div', 'history-text');
	text.append(el('span', 'history-time', formatTime(message.timestamp)));
	const body = el('span', 'body');
	if (deleted) {
		row.classList.add('deleted');
		body.textContent = 'message deleted';
	} else {
		if (message.headline) {
			const headline = el('span', 'history-headline', message.headline);
			appendSpent(headline, message);
			body.append(headline, ' ');
		}
		renderFragments(body, message.fragments);
	}
	text.append(body);
	row.append(text);
	// Only something the user wrote can be deleted; a bare sub or raid notice has nothing to remove.
	// Platforms delete only recent messages, so saved ones no longer in the chat have no button.
	if (item.live && !deleted && message.fragments.length > 0) {
		const remove = cardButton('', 'history-delete', () =>
			moderate(target, { type: 'delete', messageKey: message.key }, 'Message deleted.'),
		);
		remove.append(trashIcon());
		remove.setAttribute('aria-label', 'Delete this message');
		remove.title = allowed ? 'Delete this message' : `Moderating ${platformName(target.platform)} chat is not available yet.`;
		remove.disabled = !allowed || busy;
		row.append(remove);
	}
	return row;
}

/**
 * The card's history, grouped by day under headers that stay in view while their day scrolls past. Saved pages
 * load as the reader scrolls up, and the list keeps its place as they arrive and as the chat changes it.
 */
function renderHistory(target: CardTarget, allowed: boolean, busy: boolean): void {
	const items = historyItems(target);
	const loading = historyRequest !== undefined;
	const shape = [
		allowed,
		busy,
		loading,
		savedFailed,
		// Labels change at midnight: today's messages become yesterday's.
		dayKey(Date.now()),
		items.map((item) => `${item.message.key}${item.deleted ? '-' : ''}${item.live ? '' : '~'}`).join(' '),
	].join('|');
	if (shape === historyShape) {
		return;
	}
	historyShape = shape;
	const count = Math.max(savedTotal, items.length);
	historyTitle.textContent = count === 1 ? '1 message' : `${exactCount.format(count)} messages`;
	const atBottom = historyList.scrollHeight - historyList.scrollTop - historyList.clientHeight < STICK_THRESHOLD;
	const anchor = historyAnchor();
	historyList.replaceChildren();

	if (savedFailed) {
		historyList.append(el('p', 'card-note history-note', 'Their earlier messages could not be loaded.'));
	} else if (loading && items.length > 0) {
		historyList.append(el('p', 'card-note history-note', 'Loading earlier messages…'));
	}
	let current: HTMLElement | undefined;
	let anchorRow: HTMLElement | undefined;
	let day = '';
	let group: HTMLElement | undefined;
	for (const item of items) {
		const key = dayKey(item.message.timestamp);
		if (!group || key !== day) {
			day = key;
			// Each day is its own block, so its header sticks only while that day is in view, and the next day's
			// header pushes it out. The block stays unpositioned: rows' `offsetTop` is measured from the list.
			group = el('section', 'history-day');
			group.append(el('h3', 'history-date', dayLabel(item.message.timestamp)));
			historyList.append(group);
		}
		const row = renderHistoryItem(target, item, allowed, busy);
		if (item.message.key === target.messageKey) {
			current = row;
		}
		if (item.message.key === anchor?.key) {
			anchorRow = row;
		}
		group.append(row);
	}
	if (items.length === 0) {
		historyList.append(el('p', 'card-note', loading ? 'Loading their messages…' : 'Caerwyn has no messages from them.'));
	}

	if (scrollToCurrent && current) {
		// Centre the clicked message in the list without scrolling anything outside it.
		// The list is the items' offset parent, so `offsetTop` is already relative to it.
		historyList.scrollTop = current.offsetTop - (historyList.clientHeight - current.offsetHeight) / 2;
	} else if (atBottom || scrollToCurrent) {
		historyList.scrollTop = historyList.scrollHeight;
	} else if (anchorRow && anchor) {
		historyList.scrollTop = anchorRow.offsetTop - anchor.offset;
	}
	scrollToCurrent = false;
	// A short history may not fill the list, which leaves nothing to scroll up with.
	fetchOlderIfNeeded();
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
