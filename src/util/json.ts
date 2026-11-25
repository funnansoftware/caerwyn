// Helpers for data that arrives from outside the extension: HTTP bodies, WebSocket frames and saved files.
// Such data is `unknown` until it has been checked, so callers narrow it with these instead of asserting a type.

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The elements of `value` when it is an array, otherwise none. */
export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** The object `value` is, or `undefined` for anything else, `null` included. */
export function asRecord(value: unknown): JsonObject | undefined {
	return isRecord(value) ? value : undefined;
}

/** True for a field that is absent or `null`, or else an object: the shape of an optional nested object. */
export function isOptionalRecord(value: unknown): boolean {
	return value === undefined || value === null || isRecord(value);
}

/** Parses JSON text, or returns `undefined` when it is not valid JSON. */
export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Reads a response body as JSON, or returns `undefined` when it is empty or not JSON. */
export async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return undefined;
	}
}

/** Reads a response body as a JSON object. Anything else, such as an empty body or an array, gives `{}`. */
export async function readJsonObject(res: Response): Promise<JsonObject> {
	return asRecord(await readJson(res)) ?? {};
}
