import * as assert from 'assert';
import { AuthSession, SecretStore } from '../auth/authSession';
import { GoogleOAuth } from '../auth/googleOAuth';
import { DeviceCode, FetchLike, OAuthClient, OAuthError, TokenSet, awaitDeviceAuthorization } from '../auth/oauth';
import { TwitchOAuth, validateTwitchToken } from '../auth/twitchOAuth';
import { NotSignedInError } from '../chat/types';
import { isRecord } from '../util/json';
import { json } from './helpers';

const device: DeviceCode = { deviceCode: 'dev', userCode: 'ABCD', verificationUri: 'https://example.test', expiresIn: 60, interval: 0 };

interface Call {
	url: string;
	params: URLSearchParams;
}

function nextResponse(responses: Response[]): Response {
	const response = responses.shift();
	if (!response) {
		throw new Error('The test queued too few responses.');
	}
	return response;
}

/** The headers of a request that sets them as a plain object, as the code under test does. */
function stringHeaders(headers: unknown): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(isRecord(headers) ? headers : {})) {
		if (typeof value === 'string') {
			result[name] = value;
		}
	}
	return result;
}

function recordingFetch(respond: (call: Call) => Response): { fetchFn: FetchLike; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		fetchFn: async (url, init) => {
			const call = { url, params: new URLSearchParams(String(init?.body ?? '')) };
			calls.push(call);
			return respond(call);
		},
	};
}

suite('TwitchOAuth', () => {
	test('requests a device code with space-separated scopes and no secret', async () => {
		const { fetchFn, calls } = recordingFetch(() =>
			json({ device_code: 'dev', user_code: 'ABCD', verification_uri: 'https://www.twitch.tv/activate?device-code=ABCD', expires_in: 1800, interval: 5 }),
		);
		const code = await new TwitchOAuth(fetchFn).requestDeviceCode({ clientId: 'cid' }, ['user:read:chat', 'user:write:chat']);
		assert.strictEqual(calls[0].url, 'https://id.twitch.tv/oauth2/device');
		assert.deepStrictEqual(Object.fromEntries(calls[0].params), { client_id: 'cid', scopes: 'user:read:chat user:write:chat' });
		assert.deepStrictEqual(code, {
			deviceCode: 'dev',
			userCode: 'ABCD',
			verificationUri: 'https://www.twitch.tv/activate?device-code=ABCD',
			expiresIn: 1800,
			interval: 5,
		});
	});

	test('polling reports pending, then tokens, and fails on anything else', async () => {
		const responses = [
			json({ status: 400, message: 'authorization_pending' }, 400),
			json({ access_token: 'at', refresh_token: 'rt', expires_in: 14000, scope: ['user:read:chat'], token_type: 'bearer' }),
			json({ status: 400, message: 'invalid device code' }, 400),
		];
		const { fetchFn, calls } = recordingFetch(() => nextResponse(responses));
		const oauth = new TwitchOAuth(fetchFn);
		assert.deepStrictEqual(await oauth.pollToken({ clientId: 'cid' }, device, ['user:read:chat']), { status: 'pending' });
		const result = await oauth.pollToken({ clientId: 'cid' }, device, ['user:read:chat']);
		assert.ok(result.status === 'ok');
		assert.strictEqual(result.tokens.accessToken, 'at');
		assert.strictEqual(result.tokens.refreshToken, 'rt');
		assert.deepStrictEqual(result.tokens.scopes, ['user:read:chat']);
		assert.ok(result.tokens.expiresAt > Date.now() + 13_000_000);
		assert.strictEqual(calls[0].params.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
		await assert.rejects(oauth.pollToken({ clientId: 'cid' }, device, ['user:read:chat']), /invalid device code/);
	});

	test('treats an invalid refresh token as an expired session, whichever status Twitch uses', async () => {
		for (const status of [400, 401]) {
			const { fetchFn } = recordingFetch(() => json({ status, message: 'Invalid refresh token' }, status));
			await assert.rejects(
				new TwitchOAuth(fetchFn).refresh({ clientId: 'cid' }, 'old'),
				(err: unknown) => err instanceof OAuthError && err.kind === 'invalid_grant',
			);
		}
	});

	test('explains a refresh that fails for want of a client secret', async () => {
		const { fetchFn } = recordingFetch(() => json({ status: 400, message: 'missing client secret' }, 400));
		await assert.rejects(new TwitchOAuth(fetchFn).refresh({ clientId: 'cid' }, 'old'), /Public client type/);
	});

	test('validates tokens', async () => {
		const valid: FetchLike = async (_url, init) => {
			assert.deepStrictEqual(init?.headers, { Authorization: 'OAuth at' });
			return json({ client_id: 'cid', login: 'me', user_id: '100', scopes: ['user:read:chat'], expires_in: 5000 });
		};
		assert.deepStrictEqual(await validateTwitchToken('at', valid), { userId: '100', login: 'me', scopes: ['user:read:chat'] });
		assert.strictEqual(await validateTwitchToken('at', async () => json({ status: 401, message: 'invalid access token' }, 401)), undefined);
	});
});

suite('GoogleOAuth', () => {
	test('polls with the client secret and maps the documented errors', async () => {
		const responses = [
			json({ error: 'authorization_pending' }, 428),
			json({ error: 'slow_down' }, 403),
			json({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'a b', token_type: 'Bearer' }),
			json({ error: 'access_denied' }, 403),
		];
		const { fetchFn, calls } = recordingFetch(() => nextResponse(responses));
		const oauth = new GoogleOAuth(fetchFn);
		const creds = { clientId: 'cid', clientSecret: 'secret' };
		assert.deepStrictEqual(await oauth.pollToken(creds, device), { status: 'pending' });
		assert.deepStrictEqual(await oauth.pollToken(creds, device), { status: 'slow_down' });
		const result = await oauth.pollToken(creds, device);
		assert.ok(result.status === 'ok');
		assert.deepStrictEqual(result.tokens.scopes, ['a', 'b']);
		assert.strictEqual(calls[0].url, 'https://oauth2.googleapis.com/token');
		assert.strictEqual(calls[0].params.get('client_secret'), 'secret');
		await assert.rejects(oauth.pollToken(creds, device), (err: unknown) => err instanceof OAuthError && err.kind === 'denied');
	});

	test('maps invalid_grant on refresh', async () => {
		const { fetchFn } = recordingFetch(() => json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400));
		await assert.rejects(
			new GoogleOAuth(fetchFn).refresh({ clientId: 'cid', clientSecret: 's' }, 'old'),
			(err: unknown) => err instanceof OAuthError && err.kind === 'invalid_grant',
		);
	});
});

/** An OAuth client that fails on any call a test did not expect, so a test names only what it uses. */
function fakeOAuth(overrides: Partial<OAuthClient>): OAuthClient {
	const unexpected = (name: string) => async (): Promise<never> => {
		throw new Error(`unexpected OAuthClient.${name}`);
	};
	return {
		requestDeviceCode: unexpected('requestDeviceCode'),
		pollToken: unexpected('pollToken'),
		refresh: unexpected('refresh'),
		revoke: async () => undefined,
		...overrides,
	};
}

suite('awaitDeviceAuthorization', () => {
	const tokens: TokenSet = { accessToken: 'at', expiresAt: Date.now() + 1000, scopes: [] };

	test('polls until approved', async () => {
		let polls = 0;
		const client = fakeOAuth({ pollToken: async () => (++polls < 3 ? { status: 'pending' } : { status: 'ok', tokens }) });
		assert.strictEqual(await awaitDeviceAuthorization(client, { clientId: 'cid' }, device, []), tokens);
		assert.strictEqual(polls, 3);
	});

	test('stops when cancelled', async () => {
		const client = fakeOAuth({ pollToken: async () => ({ status: 'pending' }) });
		const abort = new AbortController();
		const waiting = awaitDeviceAuthorization(client, { clientId: 'cid' }, { ...device, interval: 1 }, [], abort.signal);
		abort.abort(new Error('cancelled'));
		await assert.rejects(waiting, /cancelled/);
	});
});

class MemorySecrets implements SecretStore {
	readonly values = new Map<string, string>();
	async get(key: string) {
		return this.values.get(key);
	}
	async store(key: string, value: string) {
		this.values.set(key, value);
	}
	async delete(key: string) {
		this.values.delete(key);
	}
}

suite('AuthSession', () => {
	function setup(refresh: OAuthClient['refresh'], respond: (token: string) => Response = () => json({})) {
		const secrets = new MemorySecrets();
		const apiCalls: Record<string, string>[] = [];
		let refreshes = 0;
		const oauth = fakeOAuth({
			refresh: (...args: Parameters<OAuthClient['refresh']>) => {
				refreshes++;
				return refresh(...args);
			},
		});
		const session = new AuthSession({
			storageKey: 'test',
			secrets,
			oauth,
			scopes: ['s'],
			identify: async () => ({ id: '100', label: 'me' }),
			apiHeaders: (creds) => ({ 'Client-Id': creds.clientId }),
			fetchFn: async (_url, init) => {
				const headers = stringHeaders(init?.headers);
				apiCalls.push(headers);
				return respond(headers.Authorization.replace('Bearer ', ''));
			},
			log: () => undefined,
		});
		return { session, secrets, apiCalls, refreshCount: () => refreshes };
	}

	const fresh = (accessToken: string, refreshToken?: string): TokenSet => ({ accessToken, refreshToken, expiresAt: Date.now() + 3_600_000, scopes: ['s'] });
	const expired = (accessToken: string, refreshToken?: string): TokenSet => ({ ...fresh(accessToken, refreshToken), expiresAt: Date.now() - 1000 });

	test('is signed out until sign-in completes', async () => {
		const { session } = setup(async () => fresh('new'));
		await session.setCredentials({ clientId: 'cid' });
		await assert.rejects(session.getAccessToken(), NotSignedInError);
		let changes = 0;
		session.onDidChange(() => changes++);
		assert.deepStrictEqual(await session.completeSignIn(fresh('at', 'rt')), { id: '100', label: 'me' });
		assert.strictEqual(await session.getAccessToken(), 'at');
		assert.deepStrictEqual(await session.getAccount(), { id: '100', label: 'me' });
		assert.strictEqual(changes, 1);
	});

	test('refreshes an expired token once for concurrent callers and stores the rotated refresh token', async () => {
		const { session, secrets, refreshCount } = setup(async (_creds, refreshToken) => {
			assert.strictEqual(refreshToken, 'rt1');
			await new Promise((resolve) => setTimeout(resolve, 20));
			return fresh('at2', 'rt2');
		});
		await session.setCredentials({ clientId: 'cid' });
		await session.completeSignIn(expired('at1', 'rt1'));
		const tokens = await Promise.all([session.getAccessToken(), session.getAccessToken(), session.getAccessToken()]);
		assert.deepStrictEqual(tokens, ['at2', 'at2', 'at2']);
		assert.strictEqual(refreshCount(), 1);
		assert.strictEqual(JSON.parse(secrets.values.get('test.session') ?? '{}').tokens.refreshToken, 'rt2');
	});

	test('keeps the old refresh token when the platform does not send a new one', async () => {
		const { session, secrets } = setup(async () => fresh('at2'));
		await session.setCredentials({ clientId: 'cid' });
		await session.completeSignIn(expired('at1', 'rt1'));
		assert.strictEqual(await session.getAccessToken(), 'at2');
		assert.strictEqual(JSON.parse(secrets.values.get('test.session') ?? '{}').tokens.refreshToken, 'rt1');
	});

	test('knows the permissions granted, and keeps them across a refresh that does not list them', async () => {
		const { session } = setup(async () => ({ ...fresh('at2'), scopes: [] }));
		await session.setCredentials({ clientId: 'cid' });
		assert.strictEqual(await session.grantedScopes(), undefined, 'none while signed out');
		await session.completeSignIn({ ...expired('at1', 'rt1'), scopes: ['user:read:chat', 'user:write:chat'] });
		assert.strictEqual(await session.getAccessToken(), 'at2');
		assert.deepStrictEqual(await session.grantedScopes(), ['user:read:chat', 'user:write:chat']);
	});

	test('reads the permissions to ask for at each sign-in, when they depend on settings', () => {
		let replies = false;
		const session = new AuthSession({
			storageKey: 'test',
			secrets: new MemorySecrets(),
			oauth: fakeOAuth({}),
			scopes: () => (replies ? ['read', 'write'] : ['read']),
			identify: async () => ({ id: '1', label: 'me' }),
			log: () => undefined,
		});
		assert.deepStrictEqual(session.scopes, ['read']);
		replies = true;
		assert.deepStrictEqual(session.scopes, ['read', 'write']);
	});

	test('retries an API call once with a refreshed token after a 401', async () => {
		const { session, apiCalls } = setup(
			async () => fresh('at2', 'rt2'),
			(token) => (token === 'at1' ? json({}, 401) : json({ ok: true })),
		);
		await session.setCredentials({ clientId: 'cid' });
		await session.completeSignIn(fresh('at1', 'rt1'));
		const res = await session.fetch('https://api.test/x', { headers: { 'Content-Type': 'application/json' } });
		assert.strictEqual(res.status, 200);
		assert.deepStrictEqual(apiCalls, [
			{ 'Content-Type': 'application/json', 'Client-Id': 'cid', Authorization: 'Bearer at1' },
			{ 'Content-Type': 'application/json', 'Client-Id': 'cid', Authorization: 'Bearer at2' },
		]);
	});

	test('signs out when the refresh token is rejected', async () => {
		const { session, secrets } = setup(async () => {
			throw new OAuthError('Invalid refresh token', 'invalid_grant');
		});
		await session.setCredentials({ clientId: 'cid' });
		await session.completeSignIn(expired('at1', 'rt1'));
		let changes = 0;
		session.onDidChange(() => changes++);
		await assert.rejects(session.getAccessToken(), NotSignedInError);
		assert.strictEqual(secrets.values.has('test.session'), false);
		assert.strictEqual(secrets.values.has('test.app'), true, 'the app credentials are kept');
		assert.strictEqual(changes, 1);
	});

	test('uses tokens another window already refreshed instead of spending the refresh token again', async () => {
		const { session, secrets, refreshCount } = setup(async () => fresh('unused'), (token) => (token === 'at1' ? json({}, 401) : json({})));
		await session.setCredentials({ clientId: 'cid' });
		await session.completeSignIn(fresh('at1', 'rt1'));
		const original = session.getAccessToken.bind(session);
		// Between this window reading the token and its 401, another window rotates the stored tokens.
		session.getAccessToken = async () => {
			const token = await original();
			secrets.values.set('test.session', JSON.stringify({ tokens: fresh('at-other', 'rt-other'), account: { id: '100', label: 'me' } }));
			return token;
		};
		const res = await session.fetch('https://api.test/x');
		assert.strictEqual(res.status, 200);
		assert.strictEqual(refreshCount(), 0);
	});
});
