/**
 * Incrementally extracts complete JSON objects from a streamed response.
 *
 * YouTube's streaming chat endpoint sends one long JSON array, `[{…}\n,\n{…}`, that only ends when the
 * connection does. This finds each outermost object as soon as its closing brace arrives and ignores
 * whatever sits between objects, so it also copes with newline-delimited JSON.
 */
export class JsonObjectStream {
	private buffer = '';
	private scanned = 0;
	private depth = 0;
	private start = -1;
	private inString = false;
	private escaped = false;

	push(chunk: string): unknown[] {
		this.buffer += chunk;
		const objects: unknown[] = [];
		for (; this.scanned < this.buffer.length; this.scanned++) {
			const char = this.buffer[this.scanned];
			if (this.inString) {
				if (this.escaped) {
					this.escaped = false;
				} else if (char === '\\') {
					this.escaped = true;
				} else if (char === '"') {
					this.inString = false;
				}
			} else if (char === '"' && this.depth > 0) {
				this.inString = true;
			} else if (char === '{') {
				if (this.depth === 0) {
					this.start = this.scanned;
				}
				this.depth++;
			} else if (char === '}' && this.depth > 0) {
				this.depth--;
				if (this.depth === 0) {
					try {
						objects.push(JSON.parse(this.buffer.slice(this.start, this.scanned + 1)));
					} catch {
						// Not valid JSON after all; skip it.
					}
					this.start = -1;
				}
			}
		}
		// Drop everything already consumed, keeping only an object still in progress.
		this.buffer = this.start === -1 ? '' : this.buffer.slice(this.start);
		this.scanned = this.buffer.length;
		this.start = this.start === -1 ? -1 : 0;
		return objects;
	}
}
