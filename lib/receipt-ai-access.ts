import { hashToken, resolveIdentity, trustedChatGPTIdentity, type AuthIdentity } from './auth';
import { accountAuditStatement } from './audit';
import { chatGPTPlanAccessToken, chatGPTPlanStatus, ChatGPTPlanError, type ChatGPTPlanEnvironment } from './chatgpt-plan';

export type ReceiptAIEnvironment = ChatGPTPlanEnvironment & {
  RECEIPT_AI_TOKEN_KEY?: string;
  OPENAI_RECEIPT_MODEL?: string;
  CHATGPT_PLAN_ENABLED?: string;
};
type Account = { id: string; email: string; displayName: string };
type SettingsRow = { user_id: string; api_key_encrypted: string | null; provider: 'api' | 'siwc'; version: number };
export class ReceiptAIAccessError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'receipt_ai_error') { super(message); }
}
const OWNER_EMAIL = 'dessimat0r@gmail.com';
const DEFAULT_MODEL = 'gpt-4.1-mini';
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw Error();
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
}
function encode(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function tokenKey(environment: ReceiptAIEnvironment): string | null {
  try { return environment.RECEIPT_AI_TOKEN_KEY && decode(environment.RECEIPT_AI_TOKEN_KEY).length === 32 ? environment.RECEIPT_AI_TOKEN_KEY : null; }
  catch { return null; }
}
async function encryptedKey(apiKey: string, userId: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', decode(secret), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const result = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`triptab-receipt-api-v1:${userId}`) }, key, new TextEncoder().encode(apiKey));
  return `v1.${encode(iv)}.${encode(new Uint8Array(result))}`;
}
async function decryptedKey(encrypted: string, userId: string, secret: string) {
  try {
    const [version, iv, value, extra] = encrypted.split('.');
    if (version !== 'v1' || extra !== undefined || decode(iv).length !== 12) throw Error();
    const key = await crypto.subtle.importKey('raw', decode(secret), 'AES-GCM', false, ['decrypt']);
    const result = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv), additionalData: new TextEncoder().encode(`triptab-receipt-api-v1:${userId}`) }, key, decode(value));
    return new TextDecoder().decode(result);
  } catch { throw new ReceiptAIAccessError('The site owner needs to save the shared OpenAI API key again to restore receipt processing.', 503, 'key_unavailable'); }
}
async function settings(database: D1Database) {
  return database.prepare("SELECT user_id,api_key_encrypted,provider,version FROM receipt_ai_settings WHERE id='shared'").first<SettingsRow>();
}
async function verifiedOwner(request: Request, profile: Account, database: D1Database): Promise<boolean> {
  if (profile.email.toLowerCase() !== OWNER_EMAIL) return false;
  const provider = trustedChatGPTIdentity(request);
  if (provider?.email !== OWNER_EMAIL) return false;
  try {
    // A session claiming the same email cannot configure the shared API key.
    // The trusted provider must resolve to this exact canonical TripTab account.
    const identity = await resolveIdentity(request, { allowSession: false }, database);
    return identity.kind === 'chatgpt' && identity.id === profile.id && identity.email === OWNER_EMAIL;
  } catch { return false; }
}
async function accessState(request: Request, profile: Account, database: D1Database, environment: ReceiptAIEnvironment) {
  const secret = tokenKey(environment);
  const ownerEmail = profile.email.toLowerCase() === OWNER_EMAIL;
  const row = secret ? await settings(database) : null;
  // First setup pins the verified canonical owner. Later password login can
  // manage that same binding; another account with the same email cannot claim it.
  const manageable = ownerEmail && (row ? row.user_id === profile.id : await verifiedOwner(request, profile, database));
  const managementReason = manageable ? undefined : ownerEmail && !row ? 'verification_required' as const : 'account_restricted' as const;
  return { secret, row, manageable, managementReason };
}
async function assertCurrentAccount(request: Request, profile: Account, database: D1Database) {
  const current = await resolveIdentity(request, { allowSession: true }, database);
  if (current.id !== profile.id || current.email !== profile.email.toLowerCase()) throw new ReceiptAIAccessError('Your account changed. Sign in again before changing receipt processing.', 401, 'account_changed');
  return current;
}
async function settingsAuthorization(request: Request, profile: Account, principal: AuthIdentity, bootstrap: boolean) {
  const parts: string[] = [], bindings: (string | null)[] = [];
  const cookie = (request.headers.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith('tt_session='));
  const rawToken = cookie.length === 1 ? cookie[0].slice('tt_session='.length) : '';
  const sessionHash = /^[A-Za-z0-9_-]{43}$/.test(rawToken) ? await hashToken(rawToken) : null;
  const liveSession = "s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  if (principal.kind === 'session') {
    parts.push(`EXISTS (SELECT 1 FROM auth_sessions s JOIN profiles p ON p.id=s.user_id
      WHERE s.token_hash=? AND s.user_id=? AND lower(p.email)=? AND ${liveSession})`);
    bindings.push(sessionHash, profile.id, profile.email.toLowerCase());
  } else if (sessionHash) {
    // A newly active foreign cookie would win resolveIdentity's precedence.
    parts.push(`NOT EXISTS (SELECT 1 FROM auth_sessions s JOIN profiles p ON p.id=s.user_id
      WHERE s.token_hash=? AND ${liveSession} AND (p.id<>? OR lower(p.email)<>?))`);
    bindings.push(sessionHash, profile.id, profile.email.toLowerCase());
  }
  if (principal.kind === 'chatgpt' || bootstrap) {
    const provider = trustedChatGPTIdentity(request);
    if (!provider || (bootstrap && provider.email !== OWNER_EMAIL)) throw new ReceiptAIAccessError('The verified owner connection changed. Reconnect before saving receipt settings.', 401, 'account_changed');
    parts.push(`EXISTS (SELECT 1 FROM profiles p WHERE p.id=? AND lower(p.email)=? AND (
      EXISTS (SELECT 1 FROM auth_links l WHERE l.oai_user_id=? AND l.user_id=?)
      OR (?=? AND NOT EXISTS (SELECT 1 FROM auth_links l WHERE l.oai_user_id=?)
        AND NOT EXISTS (SELECT 1 FROM auth_credentials c WHERE c.user_id=?))))`);
    bindings.push(profile.id, profile.email.toLowerCase(), provider.id, profile.id, provider.id, profile.id, provider.id, provider.id);
  }
  return { sql: parts.map(part => `(${part})`).join(' AND '), bindings };
}
export async function receiptAIStatus(request: Request, profile: Account, database: D1Database, environment: ReceiptAIEnvironment) {
  await assertCurrentAccount(request, profile, database);
  const state = await accessState(request, profile, database, environment);
  const base = { configured: !!state.secret, connected: false, eligible: true, manageable: state.manageable,
    ...(state.managementReason ? { managementReason: state.managementReason } : {}),
    apiConnected: false, provider: state.row?.provider || 'api', siwcAvailable: false, model: environment.OPENAI_RECEIPT_MODEL || DEFAULT_MODEL };
  if (!state.secret) return { ...base, reason: 'not_configured' };
  let apiConnected = false;
  if (state.row?.api_key_encrypted) {
    try { apiConnected = !!await decryptedKey(state.row.api_key_encrypted, state.row.user_id, state.secret); } catch { /* The owner can explicitly replace an unavailable key. */ }
  }
  const plan = environment.CHATGPT_PLAN_ENABLED === 'true' ? await chatGPTPlanStatus(database, profile.id, environment) : null;
  const provider = state.row?.provider || 'api';
  const siwcAvailable = !!plan?.configured;
  const connected = provider === 'api' ? apiConnected : siwcAvailable && !!plan?.connected;
  return { ...base, provider, apiConnected, siwcAvailable, connected, ...(provider === 'siwc' ? { model: plan && 'model' in plan ? plan.model : undefined } : {}),
    ...(!connected ? { reason: provider === 'siwc' ? (siwcAvailable ? plan?.reason || 'not_connected' : 'siwc_disabled') : 'not_connected' } : {}) };
}
export async function getReceiptAIAccess(request: Request, profile: Account, database: D1Database, environment: ReceiptAIEnvironment) {
  await assertCurrentAccount(request, profile, database);
  const state = await accessState(request, profile, database, environment);
  if (!state.secret) throw new ReceiptAIAccessError('Receipt processing has not been configured by the site owner yet.', 503, 'not_configured');
  if (state.row?.provider === 'siwc') {
    if (environment.CHATGPT_PLAN_ENABLED !== 'true') throw new ReceiptAIAccessError('SIWC plan processing is disabled. Ask the site owner to select API key in receipt AI settings.', 503, 'siwc_disabled');
    try {
      const access = await chatGPTPlanAccessToken(database, profile.id, environment, { signal: request.signal });
      return { ...access, provider: 'siwc' as const };
    } catch (error) {
      if (error instanceof ChatGPTPlanError) throw new ReceiptAIAccessError(error.message, error.status, error.code);
      throw error;
    }
  }
  if (!state.row?.api_key_encrypted) throw new ReceiptAIAccessError('The site owner needs to add the shared OpenAI API key before receipts can be read automatically.', 503, 'not_connected');
  return { accessToken: await decryptedKey(state.row.api_key_encrypted, state.row.user_id, state.secret), model: environment.OPENAI_RECEIPT_MODEL || DEFAULT_MODEL, provider: 'api' as const };
}
async function setupBudget(database: D1Database, userId: string) {
  const now = Date.now(), window = 60_000;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`receipt-api-setup:${userId}`)));
  const key = encode(digest);
  const row = await database.prepare(`INSERT INTO auth_rate_limits (key_hash,window_start,attempts) VALUES (?,?,1)
    ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN auth_rate_limits.window_start<=? THEN 1 ELSE auth_rate_limits.attempts+1 END,
      window_start=CASE WHEN auth_rate_limits.window_start<=? THEN excluded.window_start ELSE auth_rate_limits.window_start END
    RETURNING attempts`).bind(key, now, now - window, now - window).first<{ attempts: number }>();
  if (!row || row.attempts > 6) throw new ReceiptAIAccessError('Wait a minute before trying another API key.', 429, 'rate_limited');
}
export async function saveReceiptAISettings(request: Request, profile: Account, database: D1Database, environment: ReceiptAIEnvironment, body: unknown, fetcher: typeof fetch = fetch) {
  const principal = await assertCurrentAccount(request, profile, database);
  const state = await accessState(request, profile, database, environment);
  if (!state.manageable) throw new ReceiptAIAccessError('Only the verified site owner can configure the shared receipt-processing key.', 403, state.managementReason);
  if (!state.secret) throw new ReceiptAIAccessError('The site owner must enable encrypted API-key storage first.', 503, 'not_configured');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ReceiptAIAccessError('Enter an API key or choose a processing mode.');
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !['apiKey', 'provider'].includes(key))) throw new ReceiptAIAccessError('Unknown receipt-processing setting.');
  if (input.provider !== undefined && input.provider !== 'api' && input.provider !== 'siwc') throw new ReceiptAIAccessError('Choose API key or SIWC.');
  if (input.apiKey === undefined && input.provider === undefined) throw new ReceiptAIAccessError('Enter an API key or choose a processing mode.');
  let encrypted = state.row?.api_key_encrypted || null;
  if (input.apiKey !== undefined) {
    const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (!/^sk-[A-Za-z0-9_-]{16,512}$/.test(key)) throw new ReceiptAIAccessError('Enter a valid OpenAI API key.');
    await setupBudget(database, profile.id);
    let response: Response;
    try {
      response = await fetcher('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` }, redirect: 'error',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]) });
    } catch { throw new ReceiptAIAccessError('OpenAI could not verify the key. Try again shortly.', 503, 'key_check_unavailable'); }
    await response.body?.cancel().catch(() => {});
    if (!response.ok) throw new ReceiptAIAccessError(response.status === 401 || response.status === 403 ? 'OpenAI did not accept that API key. Check its permissions and try again.' : 'OpenAI could not verify the key. Try again shortly.', response.status === 401 || response.status === 403 ? 400 : 503, 'key_check_failed');
    encrypted = await encryptedKey(key, profile.id, state.secret);
  }
  const provider = input.provider === 'siwc' ? 'siwc' : input.provider === 'api' || input.apiKey !== undefined ? 'api' : state.row?.provider || 'api';
  if (provider === 'siwc' && (environment.CHATGPT_PLAN_ENABLED !== 'true' || !(await chatGPTPlanStatus(database, profile.id, environment)).configured)) throw new ReceiptAIAccessError('SIWC is disabled until an approved hosted plan-usage client is configured.', 503, 'siwc_disabled');
  const before = state.row ? { keyConfigured: !!state.row.api_key_encrypted, provider: state.row.provider } : null;
  await assertCurrentAccount(request, profile, database);
  if (!state.row && !await verifiedOwner(request, profile, database)) throw new ReceiptAIAccessError('The verified account link changed. Reconnect before saving a key.', 401, 'account_changed');
  const authorization = await settingsAuthorization(request, profile, principal, !state.row);
  const previousVersion = state.row?.version || 0;
  const results = await database.batch([
    database.prepare(`INSERT INTO receipt_ai_settings (id,user_id,api_key_encrypted,provider,version)
      SELECT 'shared',?,?,?,1 WHERE (${authorization.sql}) AND (?=0 OR EXISTS (SELECT 1 FROM receipt_ai_settings WHERE id='shared' AND user_id=? AND version=?))
      ON CONFLICT(id) DO UPDATE SET api_key_encrypted=excluded.api_key_encrypted,provider=excluded.provider,version=receipt_ai_settings.version+1
        WHERE receipt_ai_settings.user_id=? AND receipt_ai_settings.version=? AND (${authorization.sql})`).bind(profile.id, encrypted, provider,
      ...authorization.bindings, previousVersion, profile.id, previousVersion, profile.id, previousVersion, ...authorization.bindings),
    accountAuditStatement(database, { userId: profile.id, actorName: profile.displayName, entityType: 'chatgpt', entityId: 'receipt-processing', action: state.row ? 'update' : 'create',
      before, after: { keyConfigured: !!encrypted, provider } }),
  ]);
  if (!results[0].meta.changes) throw new ReceiptAIAccessError('Receipt-processing settings changed while saving. Refresh before trying again.', 409, 'settings_changed');
  return receiptAIStatus(request, profile, database, environment);
}
export async function removeReceiptAIKey(request: Request, profile: Account, database: D1Database, environment: ReceiptAIEnvironment) {
  const principal = await assertCurrentAccount(request, profile, database);
  const state = await accessState(request, profile, database, environment);
  if (!state.manageable) throw new ReceiptAIAccessError('Only the verified site owner can configure the shared receipt-processing key.', 403, state.managementReason);
  if (!state.secret) throw new ReceiptAIAccessError('Encrypted receipt-key storage is not configured.', 503, 'not_configured');
  await assertCurrentAccount(request, profile, database);
  const authorization = await settingsAuthorization(request, profile, principal, !state.row);
  // Even a no-key removal fences setup requests currently validating a key.
  const previousVersion = state.row?.version || 0, provider = state.row?.provider || 'api';
  const results = await database.batch([
    database.prepare(`INSERT INTO receipt_ai_settings (id,user_id,api_key_encrypted,provider,version)
      SELECT 'shared',?,NULL,?,1 WHERE (${authorization.sql}) AND (?=0 OR EXISTS (SELECT 1 FROM receipt_ai_settings WHERE id='shared' AND user_id=? AND version=?))
      ON CONFLICT(id) DO UPDATE SET api_key_encrypted=NULL,version=receipt_ai_settings.version+1
        WHERE receipt_ai_settings.user_id=? AND receipt_ai_settings.version=? AND (${authorization.sql})`)
      .bind(profile.id, provider, ...authorization.bindings, previousVersion, profile.id, previousVersion, profile.id, previousVersion, ...authorization.bindings),
    accountAuditStatement(database, { userId: profile.id, actorName: profile.displayName, entityType: 'chatgpt', entityId: 'receipt-processing', action: 'update',
      before: state.row ? { keyConfigured: !!state.row.api_key_encrypted, provider } : null, after: { keyConfigured: false, provider } }),
  ]);
  if (!results[0].meta.changes) throw new ReceiptAIAccessError('The API key changed while removing it. Refresh before trying again.', 409, 'settings_changed');
  return receiptAIStatus(request, profile, database, environment);
}
