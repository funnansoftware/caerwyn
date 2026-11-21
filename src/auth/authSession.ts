import { Account, ChatAuth, NotSignedInError } from '../chat/types';
import { Emitter } from '../util/emitter';
import { AppCredentials, FetchLike, OAuthClient, OAuthError, TokenSet } from './oauth';

/** The subset of `vscode.SecretStorage` this needs. */
export interface SecretStore {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
	delete(key: string): Thenable<void>;
}

interface StoredSession {
	tokens: TokenSet;
	account: Account;
}

export interface AuthSessionOptions {
	/** Prefix for secret storage keys, for example `caerwyn.twitch`. */
	storageKey: string;
	secrets: SecretStore;
	oauth: OAuthClient;
	scopes: string[];
	/** Looks up who a new access token belongs to. */
	identify(accessToken: string, creds: AppCredentials): Promise<Account>;
	/** Asks the platform whether a token is still good. Omit when the platform has no such requirement. */
	validate?(accessToken: string): Promise<boolean>;
	/** Extra headers the platform's API needs on every request. */
	apiHeaders?(creds: AppCredentials): Record<string, string>;
	fetchFn?: FetchLike;
	log(message: string): void;
}

/** Refresh this long before the recorded expiry, to allow for clock skew and slow requests. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * One platform's signed-in session: the registered app's credentials and the user's tokens,
 * both kept in secret storage and never written to settings or logs.
 */
export class AuthSession implements ChatAuth {
	private readonly changed = new Emitter<void>();
	/** Fires on sign-in and sign-out, not on token refresh. */
	readonly onDidChange = this.changed.event;
	private refreshing: Promise<string> | undefined;
	private readonly fetchFn: FetchLike;

	constructor(private readonly options: AuthSessionOptions) {
		this.fetchFn = options.fetchFn ?? fetch;
	}

	get scopes(): string[] {
		return this.options.scopes;
	}

	get oauth(): OAuthClient {
		return this.options.oauth;
	}

	async getCredentials(): Promise<AppCredentials | undefined> {
		return this.read<AppCredentials>('app');
	}

	async setCredentials(creds: AppCredentials): Promise<void> {
		await this.options.secrets.store(this.key('app'), JSON.stringify(creds));
	}

	async getAccount(): Promise<Account | undefined> {
		return (await this.read<StoredSession>('session'))?.account;
	}

	/** Stores freshly issued tokens after working out whose they are. */
	async completeSignIn(tokens: TokenSet): Promise<Account> {
		const creds = await this.requireCredentials();
		const account = await this.options.identify(tokens.accessToken, creds);
		await this.write({ tokens, account });
		this.changed.fire();
		return account;
	}

	async signOut(forgetApp = false): Promise<void> {
		const stored = await this.read<StoredSession>('session');
		const creds = await this.getCredentials();
		if (stored && creds) {
			try {
				await this.options.oauth.revoke(creds, stored.tokens.accessToken);
			} catch (err) {
				this.options.log(`Could not revoke the token: ${String(err)}`);
			}
		}
		await this.options.secrets.delete(this.key('session'));
		if (forgetApp) {
			await this.options.secrets.delete(this.key('app'));
		}
		this.changed.fire();
	}

	async getAccessToken(): Promise<string> {
		const stored = await this.read<StoredSession>('session');
		if (!stored) {
			throw new NotSignedInError();
		}
		if (stored.tokens.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
			return stored.tokens.accessToken;
		}
		return this.refresh(stored.tokens.accessToken);
	}

	async ensureValid(): Promise<void> {
		const token = await this.getAccessToken();
		if (this.options.validate && !(await this.options.validate(token))) {
			await this.refresh(token);
		}
	}

	async fetch(url: string, init: RequestInit = {}): Promise<Response> {
		const creds = await this.requireCredentials();
		const send = (token: string) =>
			this.fetchFn(url, {
				...init,
				headers: {
					...(init.headers as Record<string, string> | undefined),
					...this.options.apiHeaders?.(creds),
					Authorization: `Bearer ${token}`,
				},
			});
		const token = await this.getAccessToken();
		const res = await send(token);
		if (res.status !== 401) {
			return res;
		}
		return send(await this.refresh(token));
	}

	/** Replaces `staleToken`. Concurrent callers share one refresh, because refresh tokens can be single-use. */
	private refresh(staleToken: string): Promise<string> {
		this.refreshing ??= this.doRefresh(staleToken).finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	private async doRefresh(staleToken: string): Promise<string> {
		// Read storage again: another VS Code window may already have refreshed and rotated the tokens.
		const stored = await this.read<StoredSession>('session');
		if (!stored) {
			throw new NotSignedInError();
		}
		if (stored.tokens.accessToken !== staleToken && stored.tokens.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
			return stored.tokens.accessToken;
		}
		const creds = await this.requireCredentials();
		if (!stored.tokens.refreshToken) {
			return this.expire('The session has no refresh token.');
		}
		let tokens: TokenSet;
		try {
			tokens = await this.options.oauth.refresh(creds, stored.tokens.refreshToken);
		} catch (err) {
			if (!(err instanceof OAuthError) || err.kind !== 'invalid_grant') {
				throw err;
			}
			const latest = await this.read<StoredSession>('session');
			if (latest && latest.tokens.refreshToken !== stored.tokens.refreshToken) {
				return latest.tokens.accessToken;
			}
			return this.expire(err.message);
		}
		// Persist before use: a rotated refresh token that is lost cannot be recovered.
		await this.write({
			account: stored.account,
			tokens: { ...tokens, refreshToken: tokens.refreshToken ?? stored.tokens.refreshToken },
		});
		return tokens.accessToken;
	}

	private async expire(reason: string): Promise<never> {
		this.options.log(`Session ended: ${reason}`);
		await this.options.secrets.delete(this.key('session'));
		this.changed.fire();
		throw new NotSignedInError('The session expired. Sign in again.');
	}

	private async requireCredentials(): Promise<AppCredentials> {
		const creds = await this.getCredentials();
		if (!creds) {
			throw new NotSignedInError();
		}
		return creds;
	}

	private key(name: string): string {
		return `${this.options.storageKey}.${name}`;
	}

	private async read<T>(name: string): Promise<T | undefined> {
		const raw = await this.options.secrets.get(this.key(name));
		if (!raw) {
			return undefined;
		}
		try {
			return JSON.parse(raw) as T;
		} catch {
			return undefined;
		}
	}

	private async write(session: StoredSession): Promise<void> {
		await this.options.secrets.store(this.key('session'), JSON.stringify(session));
	}
}
