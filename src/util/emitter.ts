export interface Disposable {
	dispose(): void;
}

/** A minimal event emitter, so chat and auth code can run and be tested without the `vscode` module. */
export class Emitter<T> {
	private readonly listeners = new Set<(value: T) => void>();

	readonly event = (listener: (value: T) => void): Disposable => {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	};

	fire(value: T): void {
		for (const listener of [...this.listeners]) {
			listener(value);
		}
	}

	dispose(): void {
		this.listeners.clear();
	}
}

/** Resolves after `ms`, or rejects with the signal's reason if it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/** Exponential backoff: 1s, 2s, 4s … capped at 30s. */
export function backoffMs(attempt: number): number {
	return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
}
