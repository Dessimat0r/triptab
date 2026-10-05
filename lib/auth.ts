import { encodeBase64url as base64url, decodeBase64url, sha256Hex, encodeHex as hex } from './data-utils';
// Authentication is independent of ChatGPT. Provider headers are supplied by the
// Sites gateway; browser sessions are opaque tokens and are stored only hashed.
import { accountAuditStatement } from './audit';
const SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const RATE_WINDOW = 15 * 60 * 1000;
const EMAIL_RATE_LIMIT = 8;
// Actions have independent budgets so a group signing up on hotel Wi-Fi does
// not exhaust sign-in or password-change attempts for that same network.
const IP_RATE_LIMITS = { login: 40, register: 24, set_password: 24 };
const AUTH_CLEANUP_BATCH = 100;
const PASSWORD_ITERATIONS = 100_000;
const SESSION_COOKIE = 'tt_session';
const SIGNED_OUT_COOKIE = 'tt_signed_out';
const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store' };

export class AuthError extends Error {
  constructor(message: string, public readonly status = 400, public readonly retryAfter?: number) {
    super(message);
  }
}

export type AuthProfile = {
  id: string; email: string; displayName: string; createdAt: string;
  authMethod?: 'password' | 'chatgpt'; hasPassword?: boolean; chatgptConnected?: boolean; emailVerified?: boolean;
};
export type AuthIdentity = { id: string; email?: string; displayName?: string; kind: 'session' | 'chatgpt'; chatgptId?: string; emailVerified?: boolean };
export type AuthState = {
  authenticated: boolean; profile?: AuthProfile; hasPassword: boolean;
  chatgptLinked: boolean; chatgptAvailable: boolean; emailVerified: boolean;
};
type ProfileRow = { id: string; email: string; display_name: string; created_at: string };
type Credential = { user_id: string; email: string; password_hash: string; password_salt: string; iterations: number };
type PasswordDigest = { hash: string; salt: string; iterations: number };

function randomToken() { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
export const hashToken = sha256Hex;
export function normalizeEmail(value: unknown) {
  if (typeof value !== 'string') throw new AuthError('Enter a valid email address.');
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\u0000-\u001f\u007f]/.test(email)) {
    throw new AuthError('Enter a valid email address.');
  }
  return email;
}
function passwordValue(value: unknown) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) {
    throw new AuthError('Use a password between 12 and 128 characters.');
  }
  return value;
}
function displayNameValue(value: unknown, email: string) {
  const name = typeof value === 'string' ? value.trim() : email.split('@')[0];
  if (!name || name.length > 50 || /[\u0000-\u001f\u007f]/.test(name)) throw new AuthError('Your display name must be between 1 and 50 characters.');
  return name;
}
async function derivePassword(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)));
}
export async function hashPassword(value: unknown): Promise<PasswordDigest> {
  const password = passwordValue(value);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  return { hash: await derivePassword(password, salt, PASSWORD_ITERATIONS), salt: base64url(salt), iterations: PASSWORD_ITERATIONS };
}
export async function verifyPassword(password: unknown, digest: PasswordDigest) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128
    || !/^[a-f0-9]{64}$/.test(digest.hash) || !/^[A-Za-z0-9_-]{43}$/.test(digest.salt) || digest.iterations !== PASSWORD_ITERATIONS) return false;
  const calculated = await derivePassword(password, decodeBase64url(digest.salt), digest.iterations);
  let mismatch = 0;
  for (let index = 0; index < calculated.length; index++) mismatch |= calculated.charCodeAt(index) ^ digest.hash.charCodeAt(index);
  return mismatch === 0;
}

export function trustedChatGPTIdentity(request: Request): AuthIdentity | null {
  const id = request.headers.get('oai-authenticated-user-id');
  if (!id || id.length > 512 || /[\u0000-\u001f\u007f]/.test(id)) return null;
  let email: string | undefined;
  try { email = normalizeEmail(request.headers.get('oai-authenticated-user-email')); } catch { /* Some provider requests omit email. */ }
  let displayName: string | undefined;
  const encodedName = request.headers.get('oai-authenticated-user-full-name');
  if (encodedName) {
    try { displayName = decodeURIComponent(encodedName).trim().slice(0, 50) || undefined; } catch { /* Ignore malformed optional name. */ }
  }
  return { id, email, displayName, kind: 'chatgpt', chatgptId: id, emailVerified: !!email };
}

function sessionToken(request: Request) {
  const matches = (request.headers.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(SESSION_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
type ProfileStateRow = ProfileRow & { has_password: number; chatgpt_linked: number };
type ProviderStateRow = { [Key in keyof ProfileStateRow]: ProfileStateRow[Key] | null } & { linked_user_id: string | null; legacy_disconnected: number };
type AuthSnapshot = { identity: AuthIdentity; row: ProfileStateRow | null };

function providerIdentity(provider: AuthIdentity, row: ProviderStateRow): AuthIdentity | null {
  if (row.linked_user_id !== null) {
    if (!row.id || row.email === null || row.display_name === null) return null;
    return { ...provider, id: row.id, email: row.email, displayName: row.display_name, emailVerified: provider.email === row.email };
  }
  return row.legacy_disconnected ? null : provider;
}
export async function sessionIdentity(request: Request, database: D1Database): Promise<AuthIdentity | null> {
  const token = sessionToken(request);
  if (!token) return null;
  // Identity-only consumers, including exports, do not need credential or
  // provider flags. Keep their authorization read confined to the session.
  const row = await database.prepare(`SELECT p.id,p.email,p.display_name
    FROM auth_sessions s JOIN profiles p ON p.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(await hashToken(token), new Date().toISOString()).first<Pick<ProfileRow, 'id' | 'email' | 'display_name'>>();
  return row ? { id: row.id, email: row.email, displayName: row.display_name, kind: 'session' } : null;
}
export async function resolveIdentity(request: Request, options: { allowSession?: boolean } = {}, database: D1Database): Promise<AuthIdentity> {
  // A live session needs only the session-confined read (exports rely on it never
  // touching credential, provider or invite tables). Everything else, including a
  // stale cookie falling back to the provider, is decided by the same single
  // snapshot readAuthContext uses, so the two cannot disagree about precedence.
  if (options.allowSession !== false) {
    const session = await sessionIdentity(request, database);
    if (session) return session;
  }
  const snapshot = await authSnapshot(request, database, trustedChatGPTIdentity(request), options);
  if (!snapshot) throw new Error('UNAUTHORIZED');
  return snapshot.identity;
}
async function authSnapshot(request: Request, database: D1Database, provider: AuthIdentity | null, options: { allowSession?: boolean }): Promise<AuthSnapshot | null> {
  const token = options.allowSession !== false ? sessionToken(request) : null;
  const signedOut = options.allowSession !== false && (request.headers.get('cookie') || '').split(';').some(value => value.trim() === `${SIGNED_OUT_COOKIE}=1`);
  if (!token && (!provider || signedOut)) return null;
  // Session precedence, provider linking, profile and flags share one SQL
  // snapshot, including stale-cookie fallback. No inter-query principal switch.
  const row = await database.prepare(`SELECT p.id,p.email,p.display_name,p.created_at,
    s.user_id AS session_user_id,l.user_id AS linked_user_id,
    EXISTS (SELECT 1 FROM auth_credentials c WHERE c.user_id=p.id) AS has_password,
    EXISTS (SELECT 1 FROM auth_links linked WHERE linked.user_id=p.id) AS chatgpt_linked,
    EXISTS (SELECT 1 FROM auth_credentials c WHERE c.user_id=identity.provider_id) AS legacy_disconnected
    FROM (SELECT ? AS token_hash, ? AS provider_id) identity
    LEFT JOIN auth_sessions s ON s.token_hash=identity.token_hash AND s.expires_at>?
      AND EXISTS (SELECT 1 FROM profiles sp WHERE sp.id=s.user_id)
    LEFT JOIN auth_links l ON l.oai_user_id=identity.provider_id
    LEFT JOIN profiles p ON p.id=COALESCE(s.user_id,l.user_id,identity.provider_id)`)
    .bind(token ? await hashToken(token) : null, provider?.id ?? null, new Date().toISOString())
    .first<ProviderStateRow & { session_user_id: string | null }>();
  if (!row) return null;
  if (row.session_user_id && row.id && row.email !== null && row.display_name !== null) {
    return { identity: { id: row.id, email: row.email, displayName: row.display_name, kind: 'session' }, row: row as ProfileStateRow };
  }
  if (!provider || signedOut) return null;
  const identity = providerIdentity(provider, row);
  return identity ? { identity, row: row.id ? row as ProfileStateRow : null } : null;
}
async function createProviderProfile(identity: AuthIdentity, database: D1Database, request?: Request, options: { allowSession?: boolean; requireIdentityEmail?: boolean } = {}) {
  if (identity.kind !== 'chatgpt' || !identity.email) throw new Error('UNAUTHORIZED');
  const providerId = identity.chatgptId || identity.id;
  // The application profile boundary historically allows an 80-character
  // email-name fallback; auth/account creation retains its 50-character rule.
  const displayName = options.requireIdentityEmail
    ? (identity.displayName || identity.email.split('@')[0]).slice(0, 80)
    : displayNameValue(identity.displayName, identity.email);
  const token = options.allowSession !== false && request ? sessionToken(request) : null;
  const sessionHash = token ? await hashToken(token) : null;
  await database.batch([
    database.prepare(`INSERT INTO profiles (id,email,display_name,created_at)
      SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?)
        AND (? = ? OR EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id = ?))
        AND (NOT EXISTS (SELECT 1 FROM auth_credentials WHERE user_id = ?)
          OR EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id = ?))
        AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM auth_sessions s JOIN profiles p ON p.id = s.user_id
          WHERE s.token_hash = ? AND s.expires_at > ?))
      ON CONFLICT(id) DO NOTHING`)
      .bind(identity.id, identity.email, displayName, new Date().toISOString(), providerId, identity.id,
        identity.id, providerId, providerId, identity.id, providerId, providerId, identity.id,
        sessionHash, sessionHash, new Date().toISOString()),
    accountAuditStatement(database, { userId: identity.id, actorName: displayName, entityType: 'profile', entityId: identity.id,
      action: 'create', before: null, after: { displayName }, source: 'chatgpt' }, { sql: 'changes() > 0', bindings: [] }),
  ]);
}
async function profileRow(identity: AuthIdentity, database: D1Database): Promise<ProfileRow> {
  let row = await database.prepare('SELECT id,email,display_name,created_at FROM profiles WHERE id = ?').bind(identity.id).first<ProfileRow>();
  if (!row) {
    await createProviderProfile(identity, database);
    row = await database.prepare('SELECT id,email,display_name,created_at FROM profiles WHERE id = ?').bind(identity.id).first<ProfileRow>();
  }
  if (!row) throw new Error('UNAUTHORIZED');
  return row;
}
export async function readAuthContext(request: Request, database: D1Database, options: { allowSession?: boolean; requireIdentityEmail?: boolean } = {}): Promise<{ state: AuthState; identity?: AuthIdentity }> {
  const provider = trustedChatGPTIdentity(request);
  let snapshot = await authSnapshot(request, database, provider, options);
  if (!snapshot) return { state: { authenticated: false, hasPassword: false, chatgptLinked: false, chatgptAvailable: !!provider, emailVerified: false } };
  // ensureProfile historically requires an identity email even for an existing
  // unlinked provider profile. Auth status alone retains its existing behavior.
  if (options.requireIdentityEmail) {
    const email = snapshot.identity.email?.trim().toLowerCase();
    if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('UNAUTHORIZED');
  }
  if (!snapshot.row) {
    const id = snapshot.identity.id;
    await createProviderProfile(snapshot.identity, database, request, options);
    snapshot = await authSnapshot(request, database, provider, options);
    // Guarded creation and its audit must never return a different account if
    // linking, credential disconnection or session precedence changed mid-read.
    if (!snapshot?.row || snapshot.identity.id !== id) throw new Error('UNAUTHORIZED');
  }
  const { identity, row } = snapshot;
  const hasPassword = !!row.has_password;
  const chatgptLinked = !!row.chatgpt_linked || identity.kind === 'chatgpt';
  const emailVerified = identity.kind === 'chatgpt' && !!identity.emailVerified && identity.email === row.email;
  return { identity, state: {
    authenticated: true, profile: {
      id: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at,
      authMethod: identity.kind === 'session' ? 'password' : 'chatgpt', hasPassword, chatgptConnected: chatgptLinked, emailVerified,
    },
    hasPassword, chatgptLinked, chatgptAvailable: !!provider, emailVerified,
  } };
}
export async function readAuthState(request: Request, database: D1Database, options: { allowSession?: boolean; requireIdentityEmail?: boolean } = {}): Promise<AuthState> {
  return (await readAuthContext(request, database, options)).state;
}

function cookie(request: Request, token: string, expired = false) {
  const url = new URL(request.url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.protocol === 'http:';
  return `${SESSION_COOKIE}=${expired ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expired ? 0 : SESSION_LIFETIME / 1000}${local ? '' : '; Secure'}`;
}
function signedOutCookie(request: Request, signedOut: boolean) {
  return cookie(request, signedOut ? '1' : '', !signedOut).replace(`${SESSION_COOKIE}=`, `${SIGNED_OUT_COOKIE}=`);
}
/** Clear browser credentials even when an optional logout audit cannot load. */
export function signedOutAuthResult(request: Request): { state: AuthState; cookie: string; additionalCookies: string[] } {
  return {
    state: { authenticated: false, hasPassword: false, chatgptLinked: false, chatgptAvailable: !!trustedChatGPTIdentity(request), emailVerified: false },
    cookie: cookie(request, '', true), additionalCookies: [signedOutCookie(request, true)],
  };
}
type MutationGate = { sql: string; bindings: unknown[] };
async function prepareSession(user: string, actorName: string, request: Request, database: D1Database, gate?: MutationGate) {
  const token = randomToken();
  const now = new Date();
  const statements = [
    database.prepare(`INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at)
      SELECT ?, ?, ?, ?${gate ? ` WHERE ${gate.sql}` : ''}`)
      .bind(await hashToken(token), user, new Date(now.getTime() + SESSION_LIFETIME).toISOString(), now.toISOString(), ...(gate?.bindings || [])),
    accountAuditStatement(database, { userId: user, actorName, entityType: 'session', entityId: 'browser', action: 'create',
      before: null, after: { active: true } }, { sql: 'changes() > 0', bindings: [] }),
  ];
  return { token, cookie: cookie(request, token), statements };
}
function requestWithSession(request: Request, token: string) {
  const headers = new Headers(request.headers);
  headers.set('cookie', `${SESSION_COOKIE}=${token}`);
  return new Request(request.url, { headers });
}
type RateLimitedAction = keyof typeof IP_RATE_LIMITS;
type RateLimitKeys = { ip: string; email: string };

export async function cleanupExpiredAuthData(database: D1Database, now = Date.now()) {
  // Delete a bounded number per request; active sessions and current rate
  // windows are never eligible. No account or ledger data is removed here.
  await database.batch([
    database.prepare('DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT ?)')
      .bind(new Date(now).toISOString(), AUTH_CLEANUP_BATCH),
    database.prepare('DELETE FROM auth_rate_limits WHERE key_hash IN (SELECT key_hash FROM auth_rate_limits WHERE window_start <= ? LIMIT ?)')
      .bind(now - RATE_WINDOW, AUTH_CLEANUP_BATCH),
  ]);
}

export async function consumeAuthRateLimit(request: Request, email: string, database: D1Database, action: RateLimitedAction = 'login'): Promise<RateLimitKeys> {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const [ipKey, emailKey] = await Promise.all([`auth:${action}:ip:${ip}`, `auth:${action}:email:${email}`].map(hashToken));
  const keys = [ipKey, emailKey];
  const now = Date.now();
  const cutoff = now - RATE_WINDOW;
  const results = await database.batch(keys.map((key, index) => database.prepare(`
    INSERT INTO auth_rate_limits (key_hash, window_start, attempts) VALUES (?, ?, 1)
    ON CONFLICT(key_hash) DO UPDATE SET
      window_start = CASE WHEN auth_rate_limits.window_start <= ? THEN ? ELSE auth_rate_limits.window_start END,
      attempts = CASE WHEN auth_rate_limits.window_start <= ? THEN 1 ELSE auth_rate_limits.attempts + 1 END
    WHERE auth_rate_limits.window_start <= ? OR auth_rate_limits.attempts < ?
    RETURNING window_start, attempts
  `).bind(key, now, cutoff, now, cutoff, cutoff, index === 0 ? IP_RATE_LIMITS[action] : EMAIL_RATE_LIMIT)));
  if (results.some(result => !result.results.length)) {
    const blocked = await database.prepare('SELECT MAX(window_start) AS window_start FROM auth_rate_limits WHERE key_hash IN (?, ?)').bind(...keys).first<{ window_start: number }>();
    throw new AuthError('Too many sign-in attempts. Try again in a few minutes.', 429, Math.max(1, Math.ceil(((blocked?.window_start || now) + RATE_WINDOW - now) / 1000)));
  }
  return { ip: ipKey, email: emailKey };
}
async function clearEmailRateLimit(keys: RateLimitKeys, database: D1Database) {
  // A valid password must never reset the network's abuse budget: an attacker
  // can always interleave their own successful logins with other guesses.
  await database.prepare('DELETE FROM auth_rate_limits WHERE key_hash = ?').bind(keys.email).run();
}

async function register(request: Request, body: Record<string, unknown>, database: D1Database) {
  const email = normalizeEmail(body.email);
  const keys = await consumeAuthRateLimit(request, email, database, 'register');
  const digest = await hashPassword(body.password);
  const name = displayNameValue(body.displayName, email);
  const id = `local_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const session = await prepareSession(id, name, request, database);
  try {
    await database.batch([
      database.prepare('INSERT INTO profiles (id, email, display_name, created_at) VALUES (?, ?, ?, ?)').bind(id, email, name, now),
      accountAuditStatement(database, { userId: id, actorName: name, entityType: 'profile', entityId: id,
        action: 'create', before: null, after: { displayName: name } }, { sql: 'changes() > 0', bindings: [] }),
      database.prepare('INSERT INTO auth_credentials (user_id, email, password_hash, password_salt, iterations, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, email, digest.hash, digest.salt, digest.iterations, now),
      accountAuditStatement(database, { userId: id, actorName: name, entityType: 'password', entityId: 'account', action: 'create',
        before: { hasPassword: false }, after: { hasPassword: true } }, { sql: 'changes() > 0', bindings: [] }),
      ...session.statements,
    ]);
  } catch (error) {
    if (await database.prepare('SELECT 1 AS found FROM auth_credentials WHERE email = ?').bind(email).first()) {
      throw new AuthError('An account with this email already exists. Sign in with your password.', 409);
    }
    throw error;
  }
  await clearEmailRateLimit(keys, database);
  return { state: await readAuthState(requestWithSession(request, session.token), database), cookie: session.cookie, additionalCookies: [signedOutCookie(request, false)] };
}
async function login(request: Request, body: Record<string, unknown>, database: D1Database) {
  const email = normalizeEmail(body.email);
  const keys = await consumeAuthRateLimit(request, email, database);
  const credential = await database.prepare('SELECT user_id, email, password_hash, password_salt, iterations FROM auth_credentials WHERE email = ?').bind(email).first<Credential>();
  // Run the same password derivation for an unknown email to reduce enumeration.
  const digest = credential ? { hash: credential.password_hash, salt: credential.password_salt, iterations: credential.iterations }
    : { hash: '0'.repeat(64), salt: base64url(new Uint8Array(32)), iterations: PASSWORD_ITERATIONS };
  const valid = await verifyPassword(body.password, digest);
  if (!credential || !valid) throw new AuthError('The email or password is incorrect.', 401);
  const profile = await database.prepare('SELECT id,email,display_name,created_at FROM profiles WHERE id = ?').bind(credential.user_id).first<ProfileRow>();
  if (!profile) throw new Error('UNAUTHORIZED');
  const gate = { sql: 'EXISTS (SELECT 1 FROM auth_credentials WHERE user_id = ? AND password_hash = ? AND password_salt = ?)',
    bindings: [credential.user_id, credential.password_hash, credential.password_salt] };
  const statements: D1PreparedStatement[] = [];
  const oldToken = sessionToken(request);
  if (oldToken) {
    const tokenHash = await hashToken(oldToken);
    const previous = await database.prepare('SELECT p.id,p.display_name FROM auth_sessions s JOIN profiles p ON p.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
      .bind(tokenHash, new Date().toISOString()).first<{ id: string; display_name: string }>();
    if (previous) statements.push(
      database.prepare(`DELETE FROM auth_sessions WHERE token_hash = ? AND user_id = ? AND ${gate.sql}`).bind(tokenHash, previous.id, ...gate.bindings),
      accountAuditStatement(database, { userId: previous.id, actorName: previous.display_name, entityType: 'session', entityId: 'browser',
        action: 'delete', before: { active: true }, after: { active: false } }, { sql: 'changes() > 0', bindings: [] }),
    );
  }
  const session = await prepareSession(credential.user_id, profile.display_name, request, database, gate);
  const sessionIndex = statements.length;
  const results = await database.batch([...statements, ...session.statements]);
  if (!results[sessionIndex].meta.changes) throw new AuthError('Your password changed. Sign in again with your current password.', 409);
  await clearEmailRateLimit(keys, database);
  return { state: await readAuthState(requestWithSession(request, session.token), database), cookie: session.cookie, additionalCookies: [signedOutCookie(request, false)] };
}

async function setPassword(request: Request, body: Record<string, unknown>, database: D1Database) {
  const identity = await resolveIdentity(request, {}, database);
  const profile = await profileRow(identity, database);
  const email = normalizeEmail(profile.email);
  if (body.email !== undefined && normalizeEmail(body.email) !== email) throw new AuthError('Use the email address shown on your profile.');
  const keys = await consumeAuthRateLimit(request, email, database, 'set_password');
  const existing = await database.prepare('SELECT user_id, email, password_hash, password_salt, iterations FROM auth_credentials WHERE user_id = ?').bind(identity.id).first<Credential>();
  if (existing && !await verifyPassword(body.currentPassword, { hash: existing.password_hash, salt: existing.password_salt, iterations: existing.iterations })) {
    throw new AuthError('Enter your current password to change it.', 401);
  }
  const digest = await hashPassword(body.password);
  const now = new Date().toISOString();
  const providerId = identity.kind === 'chatgpt' ? identity.chatgptId || null : null;
  const statements = [database.prepare(`
    INSERT INTO auth_credentials (user_id, email, password_hash, password_salt, iterations, created_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE ? IS NULL OR NOT EXISTS (
      SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?
    ) ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash,
      password_salt = excluded.password_salt, iterations = excluded.iterations
      WHERE auth_credentials.password_hash = ?
  `).bind(identity.id, email, digest.hash, digest.salt, digest.iterations, now, providerId, providerId, identity.id, existing?.password_hash || null)];
  statements.push(accountAuditStatement(database, { userId: identity.id, actorName: profile.display_name, entityType: 'password', entityId: 'account',
    action: existing ? 'update' : 'create', before: { hasPassword: !!existing }, after: { hasPassword: true } }, { sql: 'changes() > 0', bindings: [] }));
  if (identity.kind === 'chatgpt' && identity.chatgptId) {
    statements.push(database.prepare('INSERT INTO auth_links (oai_user_id, user_id, created_at) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM auth_credentials WHERE user_id = ? AND password_salt = ?) ON CONFLICT(oai_user_id) DO NOTHING').bind(identity.chatgptId, identity.id, now, identity.id, digest.salt));
    statements.push(accountAuditStatement(database, { userId: identity.id, actorName: profile.display_name, entityType: 'chatgpt', entityId: 'account',
      action: 'create', before: { connected: false }, after: { connected: true } }, { sql: 'changes() > 0', bindings: [] }));
  }
  statements.push(database.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM auth_credentials WHERE user_id = ? AND password_salt = ?)').bind(identity.id, identity.id, digest.salt));
  statements.push(accountAuditStatement(database, { userId: identity.id, actorName: profile.display_name, entityType: 'session', entityId: 'account',
    action: 'delete', before: { active: true }, after: { active: false } }, { sql: 'changes() > 0', bindings: [] }));
  const session = await prepareSession(identity.id, profile.display_name, request, database,
    { sql: 'EXISTS (SELECT 1 FROM auth_credentials WHERE user_id = ? AND password_salt = ?)', bindings: [identity.id, digest.salt] });
  statements.push(...session.statements);
  try {
    const results = await database.batch(statements);
    if (!results[0].meta.changes) throw new AuthError('Your account connection or password changed. Sign in again before updating it.', 409);
  }
  catch (error) {
    const collision = await database.prepare('SELECT user_id FROM auth_credentials WHERE email = ?').bind(email).first<{ user_id: string }>();
    if (collision && collision.user_id !== identity.id) throw new AuthError('A password account already uses this email. Your current ChatGPT sign-in still works. Email ownership verification is not available yet, so TripTab cannot combine these accounts.', 409);
    throw error;
  }
  await clearEmailRateLimit(keys, database);
  return { state: await readAuthState(requestWithSession(request, session.token), database), cookie: session.cookie, additionalCookies: [signedOutCookie(request, false)] };
}
async function linkChatGPT(request: Request, database: D1Database) {
  const local = await sessionIdentity(request, database);
  const provider = trustedChatGPTIdentity(request);
  if (!local || !provider) throw new AuthError('Sign in with your password and ChatGPT before linking the accounts.', 401);
  const existing = await database.prepare('SELECT user_id FROM auth_links WHERE oai_user_id = ?').bind(provider.id).first<{ user_id: string }>();
  if (existing && existing.user_id !== local.id) throw new AuthError('This ChatGPT account is already linked to another TripTab account.', 409);
  const profile = await profileRow(local, database);
  const results = await database.batch([database.prepare(`
    INSERT INTO auth_links (oai_user_id, user_id, created_at)
    SELECT ?, ?, ? WHERE ? = ? OR (
      NOT EXISTS (SELECT 1 FROM trips WHERE owner = ?)
      AND NOT EXISTS (SELECT 1 FROM memberships WHERE user_id = ?)
      AND NOT EXISTS (SELECT 1 FROM receipts WHERE owner = ?)
      AND NOT EXISTS (SELECT 1 FROM auth_credentials WHERE user_id = ?)
    ) ON CONFLICT(oai_user_id) DO NOTHING
  `).bind(provider.id, local.id, new Date().toISOString(), provider.id, local.id, provider.id, provider.id, provider.id, provider.id),
  accountAuditStatement(database, { userId: local.id, actorName: profile.display_name, entityType: 'chatgpt', entityId: 'account',
    action: 'create', before: { connected: false }, after: { connected: true } }, { sql: 'changes() > 0', bindings: [] })]);
  if (!results[0].meta.changes && !existing) {
    throw new AuthError('This ChatGPT account already has TripTab data. Sign in with ChatGPT and add a password there to keep that data.', 409);
  }
  const linked = await database.prepare('SELECT user_id FROM auth_links WHERE oai_user_id = ?').bind(provider.id).first<{ user_id: string }>();
  if (!linked || linked.user_id !== local.id) throw new AuthError('This ChatGPT account is already linked to another TripTab account.', 409);
  return { state: await readAuthState(request, database) };
}
async function unlinkChatGPT(request: Request, database: D1Database) {
  const local = await sessionIdentity(request, database);
  if (!local || !await database.prepare('SELECT 1 AS found FROM auth_credentials WHERE user_id = ?').bind(local.id).first()) {
    throw new AuthError('Add a password and sign in with it before disconnecting ChatGPT.', 401);
  }
  const profile = await profileRow(local, database);
  await database.batch([
    database.prepare('DELETE FROM auth_links WHERE user_id = ?').bind(local.id),
    accountAuditStatement(database, { userId: local.id, actorName: profile.display_name, entityType: 'chatgpt', entityId: 'account',
      action: 'delete', before: { connected: true }, after: { connected: false } }, { sql: 'changes() > 0', bindings: [] }),
  ]);
  return { state: await readAuthState(request, database) };
}
export async function performAuthAction(request: Request, body: Record<string, unknown>, database: D1Database): Promise<{ state: AuthState; cookie?: string; additionalCookies?: string[] }> {
  if (['register', 'login', 'set_password'].includes(String(body.action))) await cleanupExpiredAuthData(database);
  switch (body.action) {
    case 'register': return register(request, body, database);
    case 'login': return login(request, body, database);
    case 'set_password': return setPassword(request, body, database);
    case 'link_chatgpt': return linkChatGPT(request, database);
    case 'unlink_chatgpt': return unlinkChatGPT(request, database);
    case 'chatgpt_login': {
      const headers = new Headers(request.headers);
      headers.set('cookie', (headers.get('cookie') || '').split(';').filter(value => !value.trim().startsWith(`${SIGNED_OUT_COOKIE}=`)).join(';'));
      const resumed = new Request(request.url, { headers });
      const state = await readAuthState(resumed, database);
      const wasSignedOut = (request.headers.get('cookie') || '').split(';').some(value => value.trim() === `${SIGNED_OUT_COOKIE}=1`);
      if (state.authenticated && state.profile && wasSignedOut && !await sessionIdentity(resumed, database)) {
        await database.batch([accountAuditStatement(database, { userId: state.profile.id, actorName: state.profile.displayName,
          entityType: 'session', entityId: 'browser', action: 'create', before: { active: false }, after: { active: true }, source: 'chatgpt' },
        { sql: 'NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?)', bindings: [state.profile.id, state.profile.id] })]);
      }
      return { state, cookie: signedOutCookie(request, false) };
    }
    case 'logout': {
      const token = sessionToken(request);
      let actor: AuthIdentity | null = null;
      let actorName: string | undefined;
      try {
        actor = await resolveIdentity(request, {}, database);
        // A session identity already came from its stored profile. A provider
        // signout must never create a missing profile merely to log an event.
        actorName = actor.kind === 'session' ? actor.displayName :
          (await database.prepare('SELECT display_name FROM profiles WHERE id = ?').bind(actor.id).first<{ display_name: string }>())?.display_name;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'UNAUTHORIZED') console.warn('TripTab could not load the logout audit actor.');
      }
      const statements: D1PreparedStatement[] = [];
      let logoutAudit: Parameters<typeof accountAuditStatement>[1] | undefined;
      let providerAuditGate: { sql: string; bindings: unknown[] } | undefined;
      // Possession of this opaque cookie is sufficient to revoke it, including
      // orphaned, expired or signed-out sessions with no resolvable profile.
      if (token) statements.push(database.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await hashToken(token)));
      if (actor && actorName !== undefined) {
        const event = { userId: actor.id, actorName, entityType: 'session' as const, entityId: 'browser',
          action: 'delete' as const, before: { active: true }, after: { active: false }, source: actor.kind === 'chatgpt' ? 'chatgpt' as const : 'web' as const };
        logoutAudit = event;
        if (actor.kind === 'session' && token) statements.push(accountAuditStatement(database, event, { sql: 'changes() > 0', bindings: [] }));
        else {
          providerAuditGate = {
          sql: 'EXISTS (SELECT 1 FROM profiles WHERE id = ?) AND NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?)',
          bindings: [actor.id, actor.chatgptId || actor.id, actor.id],
          };
          statements.push(accountAuditStatement(database, event, providerAuditGate));
        }
      }
      // When an actor is known, revocation and its audit still commit together.
      if (statements.length) {
        try { await database.batch(statements); }
        catch (error) {
          // Signout must revoke a credential even when audit storage prevents
          // the normal atomic batch. Retry its exact deletion independently;
          // an audit outage must never leave a usable copy of this cookie.
          if (token) {
            const tokenHash = await hashToken(token);
            const revoked = await database.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(tokenHash).run();
            if (revoked.meta.changes && logoutAudit) {
              try {
                const result = await database.batch([accountAuditStatement(database, logoutAudit, {
                  sql: `NOT EXISTS (SELECT 1 FROM auth_sessions WHERE token_hash = ?)${providerAuditGate ? ` AND ${providerAuditGate.sql}` : ''}`,
                  bindings: [tokenHash, ...(providerAuditGate?.bindings || [])],
                })]);
                if (result[0].meta.changes) return signedOutAuthResult(request);
              } catch { /* Report the original failure after preserving revocation. */ }
            }
          }
          console.warn('TripTab logout audit did not complete.');
          throw error;
        }
      }
      // The provider's own session belongs to ChatGPT; it cannot be signed out here.
      return signedOutAuthResult(request);
    }
    default: throw new AuthError('Choose a valid account action.');
  }
}
export function authFailure(error: unknown) {
  const unauthorized = error instanceof Error && error.message === 'UNAUTHORIZED';
  const status = error instanceof AuthError ? error.status : unauthorized ? 401 : 503;
  if (!(error instanceof AuthError) && !unauthorized) console.error('TripTab authentication failed', { kind: error instanceof Error ? error.name : 'UnknownError' });
  return Response.json({ error: error instanceof AuthError ? error.message : unauthorized ? 'Sign in to continue.' : 'Unable to sign in right now. Try again shortly.' }, {
    status, headers: { ...PRIVATE_HEADERS, ...(error instanceof AuthError && error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {}) },
  });
}
