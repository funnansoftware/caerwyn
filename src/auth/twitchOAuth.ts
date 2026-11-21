import {
	AppCredentials,
	DeviceCode,
	FetchLike,
	OAuthClient,
	OAuthError,
	PollResult,
	TokenSet,
	postForm,
	readJson,
} from './oauth';

const DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const REVOKE_URL = 'https://id.twitch.tv/oauth2/revoke';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** Twitch reports OAuth failures as `{ status, message }`. */
function toError(body: Record<string, unknown>, res: Response): OAuthError {
	const message = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
	if (/invalid refresh token/i.test(message)) {
		return new OAuthError(message, 'invalid_grant');
	}
	if (/client secret/i.test(message)) {
		return new OAuthError(
			`Twitch asked for a client secret (${message}). Caerwyn signs in without one, which needs a Twitch application with the Public client type.`,
			'invalid_client',
		);
	}
	if (/invalid client/i.test(message)) {
		return new OAuthError('Twitch did not recognise the Client ID.', 'invalid_client');
	}
	return new OAuthError(`Twitch: ${message}`, 'other');
}

function toTokens(body: Record<string, unknown>): TokenSet {
	if (typeof body.access_token !== 'string') {
		throw new OAuthError('Twitch returned no access token.', 'other');
	}
	const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0;
	return {
		accessToken: body.access_token,
		refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
		expiresAt: Date.now() + expiresIn * 1000,
		scopes: Array.isArray(body.scope) ? body.scope.filter((s): s is string => typeof s === 'string') : [],
	};
}

export class TwitchOAuth implements OAuthClient {
	constructor(private readonly fetchFn: FetchLike = fetch) {}

	async requestDeviceCode(creds: AppCredentials, scopes: string[]): Promise<DeviceCode> {
		const res = await postForm(this.fetchFn, DEVICE_URL, { client_id: creds.clientId, scopes: scopes.join(' ') });
		const body = await readJson(res);
		if (!res.ok) {
			throw toError(body, res);
		}
		return {
			deviceCode: String(body.device_code),
			userCode: String(body.user_code),
			verificationUri: String(body.verification_uri),
			expiresIn: Number(body.expires_in) || 1800,
			interval: Number(body.interval) || 5,
		};
	}

	async pollToken(creds: AppCredentials, device: DeviceCode, scopes: string[]): Promise<PollResult> {
		const res = await postForm(this.fetchFn, TOKEN_URL, {
			client_id: creds.clientId,
			scopes: scopes.join(' '),
			device_code: device.deviceCode,
			grant_type: DEVICE_GRANT,
		});
		const body = await readJson(res);
		if (res.ok) {
			return { status: 'ok', tokens: toTokens(body) };
		}
		// Only `authorization_pending` is documented; anything else ends the sign-in with Twitch's own text.
		if (body.message === 'authorization_pending') {
			return { status: 'pending' };
		}
		if (body.message === 'slow_down') {
			return { status: 'slow_down' };
		}
		throw toError(body, res);
	}

	async refresh(creds: AppCredentials, refreshToken: string): Promise<TokenSet> {
		const params: Record<string, string> = {
			client_id: creds.clientId,
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
		};
		if (creds.clientSecret) {
			params.client_secret = creds.clientSecret;
		}
		const res = await postForm(this.fetchFn, TOKEN_URL, params);
		const body = await readJson(res);
		if (!res.ok) {
			throw toError(body, res);
		}
		return toTokens(body);
	}

	async revoke(creds: AppCredentials, accessToken: string): Promise<void> {
		await postForm(this.fetchFn, REVOKE_URL, { client_id: creds.clientId, token: accessToken });
	}
}

export interface TwitchTokenInfo {
	userId: string;
	login: string;
	scopes: string[];
}

/** Twitch requires apps to validate tokens at startup and hourly. Returns `undefined` for an invalid token. */
export async function validateTwitchToken(
	accessToken: string,
	fetchFn: FetchLike = fetch,
): Promise<TwitchTokenInfo | undefined> {
	const res = await fetchFn(VALIDATE_URL, { headers: { Authorization: `OAuth ${accessToken}` } });
	if (res.status === 401) {
		return undefined;
	}
	const body = await readJson(res);
	if (!res.ok || typeof body.user_id !== 'string' || typeof body.login !== 'string') {
		throw new Error(`Twitch token validation failed (HTTP ${res.status})`);
	}
	return {
		userId: body.user_id,
		login: body.login,
		scopes: Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === 'string') : [],
	};
}
