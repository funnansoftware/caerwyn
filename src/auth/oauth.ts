import { sleep } from '../util/emitter';

// OAuth 2.0 device authorization flow, shared by Twitch and Google.
// Each platform implements `OAuthClient`; a different flow (for example a loopback redirect)
// can replace one later by implementing the same interface.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The OAuth app the user registered with the platform. */
export interface AppCredentials {
	clientId: string;
	clientSecret?: string;
}

export interface TokenSet {
	accessToken: string;
	refreshToken?: string;
	/** Milliseconds since the Unix epoch. */
	expiresAt: number;
	scopes: string[];
}

export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	/** Seconds until the codes stop working. */
	expiresIn: number;
	/** Seconds to wait between polls. */
	interval: number;
}

export type PollResult = { status: 'pending' } | { status: 'slow_down' } | { status: 'ok'; tokens: TokenSet };

export type OAuthErrorKind = 'invalid_grant' | 'invalid_client' | 'denied' | 'expired' | 'other';

export class OAuthError extends Error {
	constructor(
		message: string,
		readonly kind: OAuthErrorKind,
	) {
		super(message);
		this.name = 'OAuthError';
	}
}

export interface OAuthClient {
	requestDeviceCode(creds: AppCredentials, scopes: string[]): Promise<DeviceCode>;
	pollToken(creds: AppCredentials, device: DeviceCode, scopes: string[]): Promise<PollResult>;
	/** Throws `OAuthError` of kind `invalid_grant` when the refresh token no longer works. */
	refresh(creds: AppCredentials, refreshToken: string): Promise<TokenSet>;
	revoke(creds: AppCredentials, accessToken: string): Promise<void>;
}

export function postForm(fetchFn: FetchLike, url: string, params: Record<string, string>, signal?: AbortSignal) {
	return fetchFn(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(params).toString(),
		signal,
	});
}

export async function readJson(res: Response): Promise<Record<string, unknown>> {
	try {
		const value: unknown = await res.json();
		return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Polls until the user approves the device code, it expires, or `signal` aborts. */
export async function awaitDeviceAuthorization(
	client: OAuthClient,
	creds: AppCredentials,
	device: DeviceCode,
	scopes: string[],
	signal?: AbortSignal,
): Promise<TokenSet> {
	const deadline = Date.now() + device.expiresIn * 1000;
	let intervalMs = Math.max(1, device.interval) * 1000;
	while (Date.now() < deadline) {
		await sleep(intervalMs, signal);
		const result = await client.pollToken(creds, device, scopes);
		if (result.status === 'ok') {
			return result.tokens;
		}
		if (result.status === 'slow_down') {
			intervalMs += 5000;
		}
	}
	throw new OAuthError('The sign-in code expired before it was approved.', 'expired');
}
