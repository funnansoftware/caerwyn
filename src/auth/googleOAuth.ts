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

const DEVICE_URL = 'https://oauth2.googleapis.com/device/code';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/** Google reports OAuth failures as `{ error, error_description }`. */
function toError(body: Record<string, unknown>, res: Response): OAuthError {
	const code = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`;
	const description = typeof body.error_description === 'string' ? body.error_description : code;
	switch (code) {
		case 'invalid_grant':
			return new OAuthError(description, 'invalid_grant');
		case 'invalid_client':
			return new OAuthError(
				`Google did not accept the OAuth client (${description}). It must be a "TVs and Limited Input devices" client.`,
				'invalid_client',
			);
		case 'access_denied':
			return new OAuthError('Access was denied.', 'denied');
		case 'expired_token':
			return new OAuthError('The sign-in code expired before it was approved.', 'expired');
		default:
			return new OAuthError(`Google: ${description}`, 'other');
	}
}

function toTokens(body: Record<string, unknown>): TokenSet {
	if (typeof body.access_token !== 'string') {
		throw new OAuthError('Google returned no access token.', 'other');
	}
	const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0;
	return {
		accessToken: body.access_token,
		refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
		expiresAt: Date.now() + expiresIn * 1000,
		scopes: typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : [],
	};
}

export class GoogleOAuth implements OAuthClient {
	constructor(private readonly fetchFn: FetchLike = fetch) {}

	async requestDeviceCode(creds: AppCredentials, scopes: string[]): Promise<DeviceCode> {
		const res = await postForm(this.fetchFn, DEVICE_URL, { client_id: creds.clientId, scope: scopes.join(' ') });
		const body = await readJson(res);
		if (!res.ok) {
			throw toError(body, res);
		}
		return {
			deviceCode: String(body.device_code),
			userCode: String(body.user_code),
			verificationUri: String(body.verification_url),
			expiresIn: Number(body.expires_in) || 1800,
			interval: Number(body.interval) || 5,
		};
	}

	async pollToken(creds: AppCredentials, device: DeviceCode): Promise<PollResult> {
		const res = await postForm(this.fetchFn, TOKEN_URL, {
			client_id: creds.clientId,
			client_secret: creds.clientSecret ?? '',
			device_code: device.deviceCode,
			grant_type: DEVICE_GRANT,
		});
		const body = await readJson(res);
		if (res.ok) {
			return { status: 'ok', tokens: toTokens(body) };
		}
		if (body.error === 'authorization_pending') {
			return { status: 'pending' };
		}
		if (body.error === 'slow_down') {
			return { status: 'slow_down' };
		}
		throw toError(body, res);
	}

	async refresh(creds: AppCredentials, refreshToken: string): Promise<TokenSet> {
		const res = await postForm(this.fetchFn, TOKEN_URL, {
			client_id: creds.clientId,
			client_secret: creds.clientSecret ?? '',
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
		});
		const body = await readJson(res);
		if (!res.ok) {
			throw toError(body, res);
		}
		return toTokens(body);
	}

	async revoke(_creds: AppCredentials, accessToken: string): Promise<void> {
		await postForm(this.fetchFn, REVOKE_URL, { token: accessToken });
	}
}
