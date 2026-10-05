import { encodeBase64url as base64url, decodeBase64url, sha256Base64url } from './data-utils';
import { accountAuditStatement } from './audit';

// This is a separately approved plan-usage client, not the Sites identity client.
export type ChatGPTPlanEnvironment = {
  CHATGPT_PLAN_CLIENT_ID?: string;
  CHATGPT_PLAN_CLIENT_SECRET?: string;
  CHATGPT_PLAN_REDIRECT_URI?: string;
  CHATGPT_PLAN_TOKEN_KEY?: string;
  CHATGPT_PLAN_MODEL?: string;
  CHATGPT_PLAN_ENABLED?: string;
};
type Configuration = { clientId: string; clientSecret?: string; redirectUri: string; key: string; model?: string };
type Credentials = {
  accessToken: string; refreshToken?: string; idToken: string;
  subject: string; email?: string; scopes: string[]; expiresAt: number;
};
type ConnectionRow = { user_id: string; credentials: string; version: number; refresh_until: number };
type Transaction = { verifier: string; nonce: string; redirectUri: string; returnTo: string; subject?: string };
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const JWKS = `${ISSUER}/.well-known/jwks.json`;
const REVOKE = `${ISSUER}/api/accounts/oauth/revoke`;
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const COOKIE = '__Host-tt_plan_state';
const MAX_OAUTH_BODY = 100_000;

export class ChatGPTPlanError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'chatgpt_plan_error') { super(message); }
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  try { return decodeBase64url(value); }
  catch { throw new ChatGPTPlanError('ChatGPT connection data is invalid.', 401); }
}
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

function configuration(environment: ChatGPTPlanEnvironment): Configuration | null {
  if (environment.CHATGPT_PLAN_ENABLED !== 'true') return null;
  const { CHATGPT_PLAN_CLIENT_ID: clientId, CHATGPT_PLAN_CLIENT_SECRET: clientSecret, CHATGPT_PLAN_REDIRECT_URI: redirectUri, CHATGPT_PLAN_TOKEN_KEY: key } = environment;
  if (!clientId || !/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId) || !redirectUri || !key) return null;
  try {
    const callback = new URL(redirectUri);
    // Public Sites use an exact registered HTTPS callback, never OSS loopback registration.
    if (callback.protocol !== 'https:' || callback.username || callback.password || callback.search || callback.hash || callback.pathname !== '/api/chatgpt-plan/callback') return null;
    if (decode(key).length !== 32) return null;
  } catch { return null; }
  return { clientId, clientSecret: clientSecret || undefined, redirectUri, key, model: environment.CHATGPT_PLAN_MODEL || undefined };
}
function requireConfiguration(environment: ChatGPTPlanEnvironment): Configuration {
  const config = configuration(environment);
  if (!config) throw new ChatGPTPlanError('ChatGPT plan processing is not enabled for this site yet. The site owner must configure an approved SIWC plan-usage client.', 503, 'not_configured');
  return config;
}
async function cipher(key: string) { return crypto.subtle.importKey('raw', decode(key), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function seal(value: unknown, userId: string, kind: 'tokens' | 'transaction', key: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`triptab-plan-v1:${kind}:${userId}`) }, await cipher(key), new TextEncoder().encode(JSON.stringify(value)));
  return `v1.${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
async function unseal<T>(value: string, userId: string, kind: 'tokens' | 'transaction', key: string): Promise<T> {
  try {
    const parts = value.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') throw Error();
    const iv = decode(parts[1]);
    if (iv.length !== 12) throw Error();
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`triptab-plan-v1:${kind}:${userId}`) }, await cipher(key), decode(parts[2]));
    return JSON.parse(new TextDecoder().decode(decrypted)) as T;
  } catch { throw new ChatGPTPlanError('Reconnect ChatGPT to restore plan processing.', 401, 'connection_invalid'); }
}
async function connection(database: D1Database, userId: string): Promise<ConnectionRow | null> {
  return database.prepare('SELECT user_id,credentials,version,refresh_until FROM chatgpt_plan_connections WHERE user_id = ?').bind(userId).first<ConnectionRow>();
}
function validCredentials(value: Credentials): boolean {
  return !!value && typeof value.accessToken === 'string' && !!value.accessToken && typeof value.subject === 'string' && !!value.subject
    && Array.isArray(value.scopes) && value.scopes.every(scope => typeof scope === 'string') && Number.isFinite(value.expiresAt);
}
export async function chatGPTPlanStatus(database: D1Database, userId: string, environment: ChatGPTPlanEnvironment) {
  const config = configuration(environment);
  if (!config) return { configured: false, connected: false, reason: 'not_configured' as const };
  const row = await connection(database, userId);
  if (!row) return { configured: true, connected: false, reason: 'not_connected' as const };
  try {
    const saved = await unseal<Credentials>(row.credentials, userId, 'tokens', config.key);
    if (!validCredentials(saved)) throw Error();
    const granted = saved.scopes.includes(PLAN_SCOPE) && saved.scopes.includes('resource.invoke');
    return { configured: true, connected: granted, account: { subject: saved.subject, email: saved.email }, model: config.model,
      ...(granted ? {} : { reason: 'permission_required' as const }) };
  } catch { return { configured: true, connected: false, reason: 'not_connected' as const }; }
}
export function safeReturnTo(value: unknown) {
  if (typeof value !== 'string' || value.length > 1500 || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/receipts';
  const url = new URL(value, 'https://triptab.invalid');
  // Dot segments can turn an apparently local path into //host. Reject the
  // normalized form too, because the callback resolves it a second time.
  return url.origin === 'https://triptab.invalid' && !url.pathname.startsWith('//') && !url.pathname.includes('\\')
    && !url.pathname.startsWith('/api/') && !['/signin-with-chatgpt', '/signout-with-chatgpt', '/callback'].includes(url.pathname)
    ? url.pathname + url.search + url.hash : '/receipts';
}
export async function startChatGPTPlanAuthorization(database: D1Database, userId: string, request: Request, environment: ChatGPTPlanEnvironment, returnTo?: unknown) {
  const config = requireConfiguration(environment);
  if (new URL(config.redirectUri).origin !== new URL(request.url).origin) throw new ChatGPTPlanError('The registered ChatGPT callback does not match this site.', 503, 'not_configured');
  const state = random(), verifier = random(), nonce = random();
  const previous = await connection(database, userId);
  let subject: string | undefined;
  if (previous) {
    try {
      const saved = await unseal<Credentials>(previous.credentials, userId, 'tokens', config.key);
      subject = saved.subject;
    } catch (error) {
      // Explicit reconnect can recover after a key rotation or corrupt record.
      // Retain the old row until a fresh, verified OAuth result replaces it.
      if (!(error instanceof ChatGPTPlanError) || error.code !== 'connection_invalid') throw error;
    }
  }
  const encrypted = await seal({ verifier, nonce, redirectUri: config.redirectUri, returnTo: safeReturnTo(returnTo), subject } satisfies Transaction, userId, 'transaction', config.key);
  const now = Date.now();
  await database.batch([
    database.prepare('DELETE FROM chatgpt_plan_transactions WHERE expires_at <= ? OR user_id = ?').bind(now, userId),
    database.prepare('INSERT INTO chatgpt_plan_transactions (state_hash,user_id,transaction_data,expires_at) VALUES (?,?,?,?)').bind(await sha256Base64url(state), userId, encrypted, now + 10 * 60_000),
  ]);
  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: SCOPE, resource: RESOURCE,
    state, nonce, code_challenge: await sha256Base64url(verifier), code_challenge_method: 'S256' }).toString();
  return { authorizationUrl: url.toString(), cookie: `${COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` };
}
function stateCookie(request: Request): string | null {
  const matches = (request.headers.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
  if (matches.length !== 1) return null;
  const state = matches[0].slice(COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(state) ? state : null;
}
export const clearChatGPTPlanCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new ChatGPTPlanError('ChatGPT returned an empty connection response.', 502);
  let bytes = 0, content = '';
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_OAUTH_BODY) throw new ChatGPTPlanError('ChatGPT returned an invalid connection response.', 502);
      content += decoder.decode(part.value, { stream: true });
    }
    content += decoder.decode();
    const json = JSON.parse(content);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw Error();
    return json;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ChatGPTPlanError) throw error;
    throw new ChatGPTPlanError('ChatGPT returned an invalid connection response.', 502);
  } finally { reader.releaseLock(); }
}
function authorizationHeader(config: Configuration): Headers {
  const headers = new Headers({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
  if (config.clientSecret) {
    const encode = (value: string) => new URLSearchParams({ value }).toString().slice('value='.length);
    headers.set('Authorization', `Basic ${btoa(`${encode(config.clientId)}:${encode(config.clientSecret)}`)}`);
  }
  return headers;
}
function requestSignal(signal?: AbortSignal) { return signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000); }

/** Verify the issuer's RS256 signature before any identity or consent is trusted. */
export async function verifyChatGPTPlanIdentity(idToken: string, clientId: string, nonce: string | undefined, fetcher: typeof fetch = fetch, signal?: AbortSignal) {
  try {
    if (idToken.length > 30_000) throw Error();
    const parts = idToken.split('.');
    if (parts.length !== 3) throw Error();
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0]))) as { alg?: string; kid?: string; crit?: unknown };
    if (header.alg !== 'RS256' || !header.kid || header.crit !== undefined) throw Error();
    const response = await fetcher(JWKS, { signal: requestSignal(signal), redirect: 'manual' });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw Error(); }
    const jwks = await boundedJson(response);
    if (!Array.isArray(jwks.keys)) throw Error();
    const key = jwks.keys.find(value => value && value.kid === header.kid && value.kty === 'RSA' && (!value.alg || value.alg === 'RS256') && (!value.use || value.use === 'sig')) as JsonWebKey | undefined;
    if (!key) throw Error();
    const publicKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, decode(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]))) throw Error();
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[1]))) as { iss?: unknown; aud?: unknown; azp?: unknown; sub?: unknown; exp?: unknown; iat?: unknown; nbf?: unknown; nonce?: unknown; email?: unknown };
    const now = Math.floor(Date.now() / 1000);
    const audience = claims.aud === clientId || (Array.isArray(claims.aud) && claims.aud.includes(clientId));
    if (claims.iss !== ISSUER || !audience || (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== clientId)
      || (claims.azp !== undefined && claims.azp !== clientId) || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 512
      || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now - 5 || typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat > now + 5
      || (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now + 5)) || (nonce !== undefined && claims.nonce !== nonce)) throw Error();
    return { subject: claims.sub, email: typeof claims.email === 'string' && claims.email.length <= 254 ? claims.email : undefined };
  } catch {
    throw new ChatGPTPlanError('The ChatGPT account could not be verified. Please reconnect.', 401, 'identity_invalid');
  }
}
function tokensFromResponse(body: Record<string, unknown>, identity: { subject: string; email?: string }, previous?: Credentials): Credentials {
  if (typeof body.access_token !== 'string' || !body.access_token || typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer'
    || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 86_400
    || body.scope !== undefined && typeof body.scope !== 'string'
    || body.refresh_token !== undefined && (typeof body.refresh_token !== 'string' || !body.refresh_token)
    || typeof body.id_token !== 'string' && !previous) throw new ChatGPTPlanError('ChatGPT returned incomplete connection credentials.', 502);
  return { accessToken: body.access_token, refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : previous?.refreshToken,
    idToken: typeof body.id_token === 'string' ? body.id_token : previous!.idToken, subject: identity.subject, email: identity.email,
    // OAuth omits an unchanged scope, and may omit a replacement refresh token.
    // An explicit scope still replaces the old grant, including lost permission.
    scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? SCOPE.split(/\s+/),
    expiresAt: Date.now() + body.expires_in * 1000 };
}
export async function finishChatGPTPlanAuthorization(database: D1Database, user: { id: string; displayName: string }, request: Request, environment: ChatGPTPlanEnvironment, fetcher: typeof fetch = fetch) {
  const config = requireConfiguration(environment), url = new URL(request.url);
  if (url.origin + url.pathname !== config.redirectUri) throw new ChatGPTPlanError('The ChatGPT callback does not match its registration.', 400);
  const cookie = stateCookie(request), state = url.searchParams.get('state');
  if (!cookie || state !== cookie || url.searchParams.getAll('state').length !== 1) throw new ChatGPTPlanError('This ChatGPT connection attempt could not be verified.', 400, 'state_invalid');
  const row = await database.prepare('DELETE FROM chatgpt_plan_transactions WHERE state_hash = ? AND user_id = ? AND expires_at > ? RETURNING transaction_data')
    .bind(await sha256Base64url(state), user.id, Date.now()).first<{ transaction_data: string }>();
  if (!row) throw new ChatGPTPlanError('This ChatGPT connection attempt expired or was already used.', 400, 'state_invalid');
  const pending = await unseal<Transaction>(row.transaction_data, user.id, 'transaction', config.key);
  // Revalidate saved transactions created before return-path hardening as well.
  const returnTo = safeReturnTo(pending.returnTo);
  if (url.searchParams.has('error')) return { returnTo, result: 'cancelled' as const };
  const code = url.searchParams.get('code');
  if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1) throw new ChatGPTPlanError('ChatGPT did not return a valid authorization code.', 400);
  // workerd supports manual redirects. Never follow a redirect with OAuth credentials.
  const response = await fetcher(TOKEN, { method: 'POST', redirect: 'manual', signal: requestSignal(request.signal), headers: authorizationHeader(config),
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: config.clientId, code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri, resource: RESOURCE }) });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new ChatGPTPlanError('ChatGPT authorization could not be completed. Please reconnect.', 401, 'authorization_failed');
  }
  const body = await boundedJson(response);
  if (!response.ok || typeof body.id_token !== 'string') throw new ChatGPTPlanError('ChatGPT authorization could not be completed. Please reconnect.', 401, 'authorization_failed');
  const identity = await verifyChatGPTPlanIdentity(body.id_token, config.clientId, pending.nonce, fetcher, request.signal);
  if (pending.subject && pending.subject !== identity.subject) throw new ChatGPTPlanError('This is a different ChatGPT account. Disconnect the saved plan connection before choosing another account.', 409, 'account_changed');
  const tokens = tokensFromResponse(body, identity);
  const granted = tokens.scopes.includes(PLAN_SCOPE) && tokens.scopes.includes('resource.invoke');
  const encrypted = await seal(tokens, user.id, 'tokens', config.key);
  await database.batch([
    database.prepare(`INSERT INTO chatgpt_plan_connections (user_id,credentials,version,refresh_until) VALUES (?,?,1,0)
      ON CONFLICT(user_id) DO UPDATE SET credentials=excluded.credentials,version=chatgpt_plan_connections.version+1,refresh_until=0`).bind(user.id, encrypted),
    accountAuditStatement(database, { userId: user.id, actorName: user.displayName, entityType: 'chatgpt', entityId: 'chatgpt-plan', action: 'update', before: null, after: { connected: true, planUsageEnabled: granted } }),
  ]);
  return { returnTo, result: granted ? 'connected' as const : 'permission_required' as const };
}

export async function chatGPTPlanAccessToken(database: D1Database, userId: string, environment: ChatGPTPlanEnvironment, options: { signal?: AbortSignal; fetcher?: typeof fetch } = {}) {
  const config = requireConfiguration(environment), row = await connection(database, userId);
  if (!row) throw new ChatGPTPlanError('Connect ChatGPT plan usage to read this receipt automatically.', 401, 'not_connected');
  let saved = await unseal<Credentials>(row.credentials, userId, 'tokens', config.key);
  if (!validCredentials(saved) || !saved.scopes.includes(PLAN_SCOPE) || !saved.scopes.includes('resource.invoke')) throw new ChatGPTPlanError('Authorize ChatGPT plan usage to process receipts.', 403, 'permission_required');
  if (saved.expiresAt > Date.now() + 60_000) return { accessToken: saved.accessToken, model: config.model };
  if (!saved.refreshToken) throw new ChatGPTPlanError('Reconnect ChatGPT to renew receipt processing.', 401, 'not_connected');
  const lease = Date.now() + 30_000;
  const locked = await database.prepare('UPDATE chatgpt_plan_connections SET refresh_until=? WHERE user_id=? AND version=? AND refresh_until<=? RETURNING version')
    .bind(lease, userId, row.version, Date.now()).first<{ version: number }>();
  if (!locked) throw new ChatGPTPlanError('ChatGPT is renewing this connection. Try again shortly.', 409, 'refresh_in_progress');
  try {
    const fetcher = options.fetcher || fetch;
    const response = await fetcher(TOKEN, { method: 'POST', redirect: 'manual', signal: requestSignal(options.signal), headers: authorizationHeader(config),
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: config.clientId, refresh_token: saved.refreshToken, resource: RESOURCE }) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new ChatGPTPlanError('ChatGPT could not renew the connection. Try again shortly.', 503, 'refresh_unavailable');
    }
    const body = await boundedJson(response);
    if (!response.ok) {
      const terminal = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'].includes(String(body.error));
      if (terminal) await database.prepare('DELETE FROM chatgpt_plan_connections WHERE user_id=? AND version=? AND refresh_until=?').bind(userId, row.version, lease).run();
      throw new ChatGPTPlanError(terminal ? 'Reconnect ChatGPT to renew receipt processing.' : 'ChatGPT could not renew the connection. Try again shortly.', terminal ? 401 : 503, terminal ? 'not_connected' : 'refresh_unavailable');
    }
    let identity = { subject: saved.subject, email: saved.email };
    if (typeof body.id_token === 'string') {
      identity = await verifyChatGPTPlanIdentity(body.id_token, config.clientId, undefined, fetcher, options.signal);
      if (identity.subject !== saved.subject) throw new ChatGPTPlanError('The ChatGPT account changed during renewal. Please reconnect.', 401, 'account_changed');
    }
    saved = tokensFromResponse(body, identity, saved);
    const changed = await database.prepare('UPDATE chatgpt_plan_connections SET credentials=?,version=version+1,refresh_until=0 WHERE user_id=? AND version=? AND refresh_until=? RETURNING version')
      .bind(await seal(saved, userId, 'tokens', config.key), userId, row.version, lease).first<{ version: number }>();
    if (!changed) throw new ChatGPTPlanError('The ChatGPT connection changed while it was renewing. Try again.', 409, 'connection_changed');
    if (!saved.scopes.includes(PLAN_SCOPE) || !saved.scopes.includes('resource.invoke')) throw new ChatGPTPlanError('ChatGPT plan permission is no longer enabled. Please reconnect.', 403, 'permission_required');
    return { accessToken: saved.accessToken, model: config.model };
  } finally {
    await database.prepare('UPDATE chatgpt_plan_connections SET refresh_until=0 WHERE user_id=? AND version=? AND refresh_until=?').bind(userId, row.version, lease).run();
  }
}
export async function disconnectChatGPTPlan(database: D1Database, user: { id: string; displayName: string }, environment: ChatGPTPlanEnvironment, fetcher: typeof fetch = fetch) {
  const config = configuration(environment), row = await connection(database, user.id);
  let revoked = true;
  if (row && config) {
    try {
      const saved = await unseal<Credentials>(row.credentials, user.id, 'tokens', config.key);
      if (saved.refreshToken) {
        const response = await fetcher(REVOKE, { method: 'POST', redirect: 'manual', signal: requestSignal(), headers: authorizationHeader(config),
          body: new URLSearchParams({ token: saved.refreshToken, token_type_hint: 'refresh_token', client_id: config.clientId }) });
        revoked = response.ok;
        await response.body?.cancel().catch(() => {});
      }
    } catch { revoked = false; }
  } else if (row) revoked = false;
  await database.batch([
    database.prepare('DELETE FROM chatgpt_plan_transactions WHERE user_id=?').bind(user.id),
    database.prepare('DELETE FROM chatgpt_plan_connections WHERE user_id=?').bind(user.id),
    accountAuditStatement(database, { userId: user.id, actorName: user.displayName, entityType: 'chatgpt', entityId: 'chatgpt-plan', action: 'delete', before: { connected: true }, after: { connected: false } }),
  ]);
  return { configured: !!config, connected: false, revoked, ...(!revoked ? { error: 'Disconnected here, but remote revocation could not be confirmed. Disconnect TripTab in ChatGPT Settings too.' } : {}) };
}
