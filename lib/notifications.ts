import { sha256Hex } from './data-utils';
import { env, waitUntil } from 'cloudflare:workers';
import { db, RequestError } from './store';
import { accountAuditStatement, type ActivityEntity } from './audit';

type PushEnvironment = {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};
type Subscription = { endpoint: string; user_id: string; generation: string };
type ScheduledSubscription = Subscription & { created_at: string; latest_recency: string };
type NotificationRow = { id: string; title: string; body: string; url: string; created_at: string };

const subscriptionsPerUser = 5;
const sendTimeoutMs = 3000;
const pushAttemptsPerUpdate = 40;
const pushConcurrency = 6;
const deliveryBudgetMs = 24000;
const PUSH_COOKIE = 'tt_push';
let importedKey: { secret: string; key: Promise<CryptoKey> } | undefined;

function settings() { return env as unknown as PushEnvironment; }

export function pushConfiguration() {
  const config = settings();
  const publicKey = config.VAPID_PUBLIC_KEY ?? '';
  const enabled = Boolean(config.VAPID_PRIVATE_KEY && /^[A-Za-z0-9_-]{87}$/.test(publicKey));
  return { enabled, publicKey: enabled ? publicKey : null };
}

/** Only established browser push services may receive outbound requests. */
export function validatePushEndpoint(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new RequestError('Invalid push subscription.');
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new RequestError('Invalid push subscription.'); }
  const host = endpoint.hostname.toLowerCase();
  const allowed = host === 'fcm.googleapis.com' || host === 'android.googleapis.com'
    || host === 'push.services.mozilla.com' || host.endsWith('.push.services.mozilla.com')
    || host === 'notify.windows.com' || host.endsWith('.notify.windows.com')
    || host === 'web.push.apple.com' || host.endsWith('.web.push.apple.com');
  if (endpoint.protocol !== 'https:' || !allowed || endpoint.username || endpoint.password
    || endpoint.port && endpoint.port !== '443' || endpoint.hash || endpoint.pathname === '/') {
    throw new RequestError('Unsupported browser push service.');
  }
  return endpoint.href;
}

export async function subscriptionCount(user: string) {
  const row = await db().prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id = ?').bind(user).first<{ count: number }>();
  return row?.count ?? 0;
}

async function endpointHash(endpoint: string) {
  return await sha256Hex(endpoint);
}

export async function browserPushCookie(request: Request, endpoint?: string) {
  const value = endpoint ? await endpointHash(validatePushEndpoint(endpoint)) : '';
  return `${PUSH_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${endpoint ? 30 * 24 * 60 * 60 : 0}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

/** Return ownership only, never another account's identity or notification text. */
export async function ownsSubscription(user: string, rawEndpoint: unknown) {
  const endpoint = validatePushEndpoint(rawEndpoint);
  return Boolean(await db().prepare('SELECT 1 AS owned FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(endpoint, user).first());
}

/** Revoke this browser's binding before logout clears its authenticated actor. */
export async function revokeBrowserPush(request: Request, user: string) {
  const matches = (request.headers.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${PUSH_COOKIE}=`));
  if (matches.length !== 1) return;
  const hash = matches[0].slice(PUSH_COOKIE.length + 1);
  if (!/^[a-f0-9]{64}$/.test(hash)) return;
  const rows = await db().prepare('SELECT endpoint FROM push_subscriptions WHERE user_id = ? LIMIT 5').bind(user).all<{ endpoint: string }>();
  const hashes = await Promise.all(rows.results.map(row => endpointHash(row.endpoint)));
  const index = hashes.indexOf(hash);
  if (index >= 0) await removeSubscription(user, rows.results[index].endpoint, 'logout_or_account_switch');
}

async function actorName(database: D1Database, user: string) {
  const profile = await database.prepare('SELECT display_name FROM profiles WHERE id = ?').bind(user).first<{ display_name: string }>();
  return profile?.display_name || 'Account holder';
}

export async function subscribe(user: string, rawEndpoint: unknown) {
  const endpoint = validatePushEndpoint(rawEndpoint);
  if (!pushConfiguration().enabled) throw new RequestError('Push notifications are not configured yet.', 503);
  const database = db();
  const existing = await database.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first<{ user_id: string }>();
  if (existing && existing.user_id !== user) throw new RequestError('This browser subscription belongs to another account. Reset browser notifications before enabling them here.', 409);
  if (!existing && await subscriptionCount(user) >= subscriptionsPerUser) throw new RequestError('Notifications are already enabled on five browsers. Disable one before adding another.');
  const entityId = await endpointHash(endpoint);
  const name = await actorName(database, user);
  const guard = 'NOT EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ?) AND (SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?) < 5';
  const results = await database.batch([
    accountAuditStatement(database, { userId: user, actorName: name, entityType: 'notifications', entityId, action: 'create', before: null,
      after: { enabled: true, service: new URL(endpoint).hostname, reason: 'enabled_on_device' } }, { sql: guard, bindings: [endpoint, user] }),
    database.prepare(`INSERT INTO push_subscriptions (endpoint, user_id, created_at, generation) SELECT ?, ?, ?, ? WHERE ${guard} ON CONFLICT(endpoint) DO NOTHING`)
      .bind(endpoint, user, new Date().toISOString(), crypto.randomUUID(), endpoint, user),
  ]);
  if (!results[1].meta.changes) {
    // A concurrent identical enable may already have committed its own event.
    const current = await database.prepare('SELECT user_id, generation, created_at FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first<{ user_id: string; generation: string; created_at: string }>();
    if (current?.user_id === user) {
      // This is delivery housekeeping, not another opt-in or a new binding.
      // Keep this binding's generation; the guard protects any replacement.
      const refreshed = await database.prepare('UPDATE push_subscriptions SET created_at = MAX(created_at, ?) WHERE endpoint = ? AND user_id = ? AND generation = ?')
        .bind(dispatchRecency([current.created_at]), endpoint, user, current.generation).run();
      if (refreshed.meta.changes || await ownsSubscription(user, endpoint)) return;
      throw new RequestError('Notification settings changed. Refresh and try again.', 409);
    }
    if (current) throw new RequestError('This browser subscription belongs to another account. Reset browser notifications before enabling them here.', 409);
    if (await subscriptionCount(user) >= subscriptionsPerUser) throw new RequestError('Notifications are already enabled on five browsers. Disable one before adding another.');
    throw new RequestError('Unable to register this browser subscription.', 409);
  }
}

/** created_at tracks registration/dispatch recency; it is not an audit timestamp. */
function dispatchRecency(previous: readonly string[]) {
  const times = previous.map(value => Date.parse(value)).filter(Number.isFinite);
  return new Date(Math.max(Date.now(), ...times.map(value => value + 1))).toISOString();
}

export async function unsubscribe(user: string, rawEndpoint: unknown) {
  await removeSubscription(user, validatePushEndpoint(rawEndpoint), 'disabled_on_device');
}

async function removeSubscription(user: string, endpoint: string, reason: 'disabled_on_device' | 'logout_or_account_switch' | 'provider_expired', expectedGeneration?: string) {
  const database = db();
  const previous = await database.prepare('SELECT generation FROM push_subscriptions WHERE endpoint = ? AND user_id = ?')
    .bind(endpoint, user).first<{ generation: string }>();
  if (!previous || (expectedGeneration !== undefined && previous.generation !== expectedGeneration)) return;
  const source = reason === 'provider_expired' ? 'system' : 'web';
  const name = source === 'system' ? 'TripTab system' : await actorName(database, user);
  const entityId = await endpointHash(endpoint);
  const service = new URL(endpoint).hostname;
  const guard = 'EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ? AND generation = ?)';
  const results = await database.batch([
    accountAuditStatement(database, { userId: user, actorName: name, entityType: 'notifications', entityId, action: 'delete',
      before: { enabled: true, service }, after: { enabled: false, service, reason }, source }, { sql: guard, bindings: [endpoint, user, previous.generation] }),
    database.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ? AND generation = ?').bind(endpoint, user, previous.generation),
  ]);
  if (!results[1].meta.changes && source !== 'system' && await ownsSubscription(user, endpoint)) {
    throw new RequestError('Notification settings changed. Refresh and try again.', 409);
  }
}

export async function latestNotifications(user: string) {
  const result = await db().prepare('SELECT id, title, body, url, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20').bind(user).all<NotificationRow>();
  return (result.results ?? []).map(row => ({ id: row.id, title: row.title, body: row.body, url: row.url, createdAt: row.created_at }));
}

type NotificationChange = {
  entityType: ActivityEntity;
  entityId?: string;
  action: 'create' | 'update' | 'delete';
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
};

/** Lock-screen summaries describe the action without exposing holiday contents. */
export function activityNotification(actorName: string, changes: readonly NotificationChange[]) {
  const events = changes.filter(change => change.entityType !== 'draft');
  if (!events.length) return null;
  const actor = actorName.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'A traveller';
  const types = new Set(events.map(event => event.entityType));
  let summary = 'updated this holiday';
  if (types.size === 1) {
    const entity = events[0].entityType;
    const actions = new Set(events.map(event => event.action));
    const action = actions.size === 1 ? events[0].action : undefined;
    const verb = action === 'create' ? 'added' : action === 'delete' ? 'removed' : action === 'update' ? 'updated' : 'changed';
    if (entity === 'trip') {
      summary = action === 'create' ? 'created this holiday' : action === 'delete' ? 'removed this holiday' : 'updated the holiday details';
    } else {
      const noun = entity === 'member' ? 'traveller' : entity === 'invite' ? 'invitation' : entity === 'receipt' ? 'receipt image' : entity;
      summary = events.length === 1 ? `${verb} ${entity === 'expense' || entity === 'invite' ? 'an' : 'a'} ${noun}` : `${verb} ${events.length} ${noun}s`;
    }
  }
  return { title: 'TripTab activity', body: `${actor} ${summary}. Open TripTab to review the activity.` };
}

function base64url(value: Uint8Array) {
  let binary = '';
  for (let i = 0; i < value.length; i += 8192) binary += String.fromCharCode(...value.slice(i, i + 8192));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function signingKey() {
  const secret = settings().VAPID_PRIVATE_KEY;
  if (!secret) throw new Error('VAPID is not configured');
  if (!importedKey || importedKey.secret !== secret) {
    importedKey = {
      secret,
      key: Promise.resolve().then(() => {
        const jwk = JSON.parse(secret) as JsonWebKey;
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) throw new Error('Invalid VAPID key');
        return crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      }),
    };
  }
  return importedKey.key;
}

async function vapidAuthorization(endpoint: string) {
  const config = settings();
  const encoder = new TextEncoder();
  const header = base64url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const subject = config.VAPID_SUBJECT;
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    ...(subject && /^(https:\/\/|mailto:)/.test(subject) ? { sub: subject } : {}),
  };
  const payload = base64url(encoder.encode(JSON.stringify(claims)));
  const unsigned = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await signingKey(), encoder.encode(unsigned)));
  if (signature.length !== 64) throw new Error('Unsupported ECDSA signature format');
  return `vapid t=${unsigned}.${base64url(signature)},k=${config.VAPID_PUBLIC_KEY}`;
}

async function sendPush(subscription: Subscription, timeoutMs = sendTimeoutMs) {
  try {
    const endpoint = validatePushEndpoint(subscription.endpoint);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: await vapidAuthorization(endpoint), TTL: '3600', Urgency: 'normal' },
      body: '',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Push service returned a redirect.');
    }
    if (response.status === 404 || response.status === 410) {
      await removeSubscription(subscription.user_id, endpoint, 'provider_expired', subscription.generation);
    }
    // Do not consume untrusted provider response text or expose endpoint tokens.
    await response.body?.cancel();
  } catch {
    console.warn('A TripTab push notification could not be delivered.');
  }
}

async function deliverNotifications(tripId: string, actor: string, title: string, body: string) {
  const deadline = Date.now() + deliveryBudgetMs;
  try {
    const memberResult = await db().prepare('SELECT user_id FROM memberships WHERE trip_id = ? AND user_id <> ? LIMIT 50').bind(tripId, actor).all<{ user_id: string }>();
    const users = [...new Set((memberResult.results ?? []).map(member => member.user_id))];
    if (!users.length) return;
    const now = new Date().toISOString();
    const recent = new Date(Date.now() - 30000).toISOString();
    const shortTitle = title.trim().slice(0, 100) || 'Holiday updated';
    const shortBody = body.trim().slice(0, 240) || 'Open TripTab to review your holiday.';
    const placeholders = users.map(() => '?').join(',');
    const previous = await db().prepare(`SELECT user_id, MAX(created_at) AS latest FROM notifications WHERE user_id IN (${placeholders}) GROUP BY user_id`).bind(...users).all<{ user_id: string; latest: string }>();
    const throttled = new Set((previous.results ?? []).filter(row => row.latest > recent).map(row => row.user_id));
    const writes = users.flatMap(user => [
      db().prepare('INSERT INTO notifications (id, user_id, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), user, shortTitle, shortBody, '/', now),
      db().prepare('DELETE FROM notifications WHERE user_id = ? AND id NOT IN (SELECT id FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100)').bind(user, user),
    ]);
    await db().batch(writes);
    if (!pushConfiguration().enabled) return;
    const recipients = users.filter(user => !throttled.has(user));
    if (!recipients.length) return;
    const result = await db().prepare(`SELECT endpoint, user_id, generation, created_at, latest_recency FROM (
      SELECT endpoint, user_id, generation, created_at,
        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at, endpoint) AS device_rank,
        MAX(created_at) OVER (PARTITION BY user_id) AS user_recency,
        MAX(created_at) OVER () AS latest_recency
      FROM push_subscriptions WHERE user_id IN (${recipients.map(() => '?').join(',')})
    ) ORDER BY device_rank, user_recency, user_id, created_at, endpoint LIMIT ?`).bind(...recipients, pushAttemptsPerUpdate).all<ScheduledSubscription>();
    const subscriptions = result.results ?? [];
    if (!subscriptions.length || Date.now() >= deadline) return;
    // Persist reservations so large groups rotate across updates, rather than
    // repeatedly selecting the newest forty devices. Prefer one per traveller
    // before extra devices. Re-registration/replacement defeats stale reservations.
    const recency = Date.parse(dispatchRecency(subscriptions.map(subscription => subscription.latest_recency)));
    const reservations = await db().batch(subscriptions.map((subscription, index) =>
      db().prepare('UPDATE push_subscriptions SET created_at = ? WHERE endpoint = ? AND user_id = ? AND generation = ? AND created_at = ?')
        // Distinct ordered timestamps prevent user-ID ties from repeatedly
        // favouring the same travellers when more than forty are eligible.
        .bind(new Date(recency + index).toISOString(), subscription.endpoint, subscription.user_id, subscription.generation, subscription.created_at)));
    const scheduled = subscriptions.filter((_, index) => reservations[index].meta.changes);
    // Push is best effort: at most forty requests, six at once, within the
    // Workers background lifetime. Every traveller still receives an inbox entry;
    // remaining devices are prioritised on subsequent unthrottled updates.
    for (let index = 0; index < scheduled.length; index += pushConcurrency) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await Promise.all(scheduled.slice(index, index + pushConcurrency).map(subscription => sendPush(subscription, Math.min(sendTimeoutMs, remaining))));
    }
  } catch {
    console.warn('TripTab could not send a holiday update notification.');
  }
}

/** Notification failures never invalidate an already-saved holiday change. */
export async function notifyMembers(tripId: string, actor: string, title: string, body: string) {
  const delivery = deliverNotifications(tripId, actor, title, body);
  try { waitUntil(delivery); } catch { await delivery; }
}
