import { env, waitUntil } from 'cloudflare:workers';
import { db, RequestError } from './store';

type PushEnvironment = {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};
type Subscription = { endpoint: string; user_id: string };
type NotificationRow = { id: string; title: string; body: string; url: string; created_at: string };

const subscriptionsPerUser = 5;
const sendTimeoutMs = 5000;
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

export async function subscribe(user: string, rawEndpoint: unknown) {
  const endpoint = validatePushEndpoint(rawEndpoint);
  if (!pushConfiguration().enabled) throw new RequestError('Push notifications are not configured yet.', 503);
  const existing = await db().prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).first<{ user_id: string }>();
  if (existing && existing.user_id !== user) throw new RequestError('This browser subscription belongs to another account. Reset browser notifications before enabling them here.', 409);
  if (!existing && await subscriptionCount(user) >= subscriptionsPerUser) throw new RequestError('Notifications are already enabled on five browsers. Disable one before adding another.');
  const result = await db().prepare('INSERT INTO push_subscriptions (endpoint, user_id, created_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?) < 5 OR EXISTS (SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND user_id = ?) ON CONFLICT(endpoint) DO UPDATE SET created_at = excluded.created_at WHERE push_subscriptions.user_id = excluded.user_id').bind(endpoint, user, new Date().toISOString(), user, endpoint, user).run();
  if (!result.meta.changes) throw new RequestError('Unable to register this browser subscription.', 409);
}

export async function unsubscribe(user: string, rawEndpoint: unknown) {
  const endpoint = validatePushEndpoint(rawEndpoint);
  await db().prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(endpoint, user).run();
}

export async function latestNotifications(user: string) {
  const result = await db().prepare('SELECT id, title, body, url, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 20').bind(user).all<NotificationRow>();
  return (result.results ?? []).map(row => ({ id: row.id, title: row.title, body: row.body, url: row.url, createdAt: row.created_at }));
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

async function sendPush(subscription: Subscription) {
  try {
    const endpoint = validatePushEndpoint(subscription.endpoint);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: await vapidAuthorization(endpoint), TTL: '3600', Urgency: 'normal' },
      body: '',
      redirect: 'error',
      signal: AbortSignal.timeout(sendTimeoutMs),
    });
    if (response.status === 404 || response.status === 410) {
      await db().prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').bind(endpoint, subscription.user_id).run();
    }
    // Do not consume untrusted provider response text or expose endpoint tokens.
    await response.body?.cancel();
  } catch {
    console.warn('A TripTab push notification could not be delivered.');
  }
}

async function deliverNotifications(tripId: string, actor: string, title: string, body: string) {
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
    const result = await db().prepare(`SELECT endpoint, user_id FROM push_subscriptions WHERE user_id IN (${recipients.map(() => '?').join(',')}) ORDER BY created_at DESC LIMIT 40`).bind(...recipients).all<Subscription>();
    const subscriptions = result.results ?? [];
    // Eight concurrent requests and five-second deadlines fit within the
    // Workers background lifetime. Every member still receives an inbox entry.
    for (let index = 0; index < subscriptions.length; index += 8) {
      await Promise.all(subscriptions.slice(index, index + 8).map(sendPush));
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
