import { Account, ChatAuth, ChatEvent, ChatSink, SourceStatus } from '../chat/types';

/** Records everything a chat connection reports. */
export class RecordingSink implements ChatSink {
	readonly events: ChatEvent[] = [];
	readonly statuses = new Map<string, SourceStatus>();
	readonly labels = new Map<string, string>();
	/** Every viewer count reported, in order, by source ID. */
	readonly viewerReports = new Map<string, (number | undefined)[]>();
	readonly logs: string[] = [];

	event(event: ChatEvent): void {
		this.events.push(event);
	}

	status(sourceId: string, status: SourceStatus, label?: string): void {
		this.statuses.set(sourceId, status);
		if (label) {
			this.labels.set(sourceId, label);
		}
	}

	viewers(sourceId: string, count: number | undefined): void {
		const reports = this.viewerReports.get(sourceId) ?? [];
		reports.push(count);
		this.viewerReports.set(sourceId, reports);
	}

	log(message: string): void {
		this.logs.push(message);
	}

	state(sourceId: string): string | undefined {
		return this.statuses.get(sourceId)?.state;
	}

	/** The most recent viewer count reported for a source. */
	viewerCount(sourceId: string): number | undefined {
		return this.viewerReports.get(sourceId)?.at(-1);
	}
}

export interface RecordedRequest {
	url: string;
	init?: RequestInit;
}

/** A signed-in session whose API responses come from `respond`. */
export class FakeAuth implements ChatAuth {
	readonly requests: RecordedRequest[] = [];
	account: Account | undefined = { id: '100', label: 'me' };
	ensureValidError: Error | undefined;

	constructor(private readonly respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {}

	async getAccount(): Promise<Account | undefined> {
		return this.account;
	}

	async ensureValid(): Promise<void> {
		if (this.ensureValidError) {
			throw this.ensureValidError;
		}
	}

	async fetch(url: string, init?: RequestInit): Promise<Response> {
		this.requests.push({ url, init });
		return this.respond(url, init);
	}
}

export function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A response whose body arrives in the given chunks, like a streamed HTTP response. */
export function streamed(chunks: (string | Uint8Array)[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200 });
}

export async function waitFor(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
