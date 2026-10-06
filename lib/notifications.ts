import { canonicalJson, encodeBase64url as base64url, sha256Hex } from './data-utils';
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

export async function browserPushCookie(request: Request, endpoint?: string) {
  const value = endpoint ? await sha256Hex(validatePushEndpoint(endpoint)) : '';
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
  const hashes = await Promise.all(rows.results.map(row => sha256Hex(row.endpoint)));
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
  const entityId = await sha256Hex(endpoint);
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
  const entityId = await sha256Hex(endpoint);
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
export type NotificationContext = { tripName?: string; receiptName?: string; itemName?: string; receiptCount?: number; itemCount?: number };

function compactText(value: string, limit: number) {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  const characters = Array.from(clean);
  return characters.length <= limit ? clean : `${characters.slice(0, limit - 1).join('').trimEnd()}…`;
}
function shortActor(name: string) { return compactText(name, 48) || 'A traveller'; }
function list(parts: readonly string[]) {
  return parts.length < 2 ? parts[0] || '' : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}
function changed(before: Record<string, unknown>, after: Record<string, unknown>, fields: readonly string[]) {
  return fields.some(field => canonicalJson(before[field], 'undefined') !== canonicalJson(after[field], 'undefined'));
}
function records(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && typeof entry.id === 'string') : [];
}
function unitShares(value: unknown) {
  if (!value || typeof value !== 'object') return;
  const units = value as Record<string, unknown>;
  return { total: units.total, allocations: units.allocations };
}
function conversation(value: unknown) {
  return records(value).map(message => {
    const next = { ...message };
    if (next.role === 'assistant') { delete next.authorMemberId; delete next.authorName; }
    return next;
  });
}

function contextualNotification(actorName: string, description: { title: string; summary: string }, context: NotificationContext) {
  const receiptBudget = context.tripName ? 25 : 50;
  const countedName = (name: string | undefined, count: number | undefined, noun: string, budget: number) => {
    if (!name) return '';
    const clean = compactText(name, Math.max(budget, Array.from(name).length));
    if (!clean) return '';
    const suffix = count && count > 1 ? ` +${count - 1} ${count === 2 ? noun : `${noun}s`}` : '';
    return `${compactText(clean, Math.max(1, budget - Array.from(suffix).length))}${suffix}`;
  };
  const trip = compactText(context.tripName || '', context.receiptName ? 22 : 50);
  const receipt = countedName(context.receiptName, context.receiptCount, 'receipt', receiptBudget);
  const item = countedName(context.itemName, context.itemCount, 'item', 48);
  const title = trip && receipt ? `${trip} · ${receipt}` : trip || receipt || description.title;
  if (!trip && !receipt && !item) return { title: compactText(title, 50), body: compactText(`${shortActor(actorName)} ${description.summary}.`, 160) };
  // Reserve space for every supplied label. Long names cannot hide the action.
  const action = compactText(description.summary.replace(/ on (?:an expense|a receipt)$/, ''), 80);
  const editor = compactText(actorName, 26) || 'A traveller';
  return { title: compactText(title, 50), body: `${editor} ${action}${item ? ` · ${item}` : ''}.` };
}

function changedItems(event: NotificationChange) {
  const previous = records(event.before?.items), current = records(event.after?.items);
  const before = new Map(previous.map(item => [item.id, item])), after = new Map(current.map(item => [item.id, item]));
  const affected = new Set<unknown>();
  for (const id of new Set([...after.keys(), ...before.keys()])) {
    const old = before.get(id), next = after.get(id);
    if (!old || !next || changed(old, next, ['name', 'nameLanguage', 'translations', 'amount', 'quantity', 'members', 'percentages', 'units'])) affected.add(id);
  }
  const oldMessages = new Map(conversation(event.before?.conversation).map(message => [message.id, message]));
  const newMessages = new Map(conversation(event.after?.conversation).map(message => [message.id, message]));
  for (const id of new Set([...newMessages.keys(), ...oldMessages.keys()])) {
    const old = oldMessages.get(id), next = newMessages.get(id);
    if (canonicalJson(old) === canonicalJson(next)) continue;
    for (const message of [next, old]) if (typeof message?.itemId === 'string') affected.add(message.itemId);
  }
  return [...affected].map(id => after.get(id) || before.get(id)).filter((item): item is Record<string, unknown> => typeof item?.name === 'string' && !!item.name.trim());
}

/** Describe saved field categories separately from the named receipt context. */
function updateDescription(event: NotificationChange): { title: string; summary: string } | null {
  const { before, after, entityType } = event;
  if (!before || !after) return null;
  const details: { label: string; title: string }[] = [];
  const add = (label: string, title: string, fields: readonly string[]) => {
    if (changed(before, after, fields)) details.push({ label, title });
  };
  if (entityType === 'expense') {
    const oldItems = records(before.items), newItems = records(after.items);
    const oldById = new Map(oldItems.map(item => [item.id, item])), newById = new Map(newItems.map(item => [item.id, item]));
    const existing = newItems.flatMap(item => oldById.has(item.id) ? [[oldById.get(item.id)!, item] as const] : []);
    if (existing.some(([old, next]) => changed(old, next, ['members', 'percentages']) || canonicalJson(unitShares(old.units)) !== canonicalJson(unitShares(next.units)))) details.push({ label: 'item splits', title: 'Expense split changed' });
    add('the receipt split', 'Expense split changed', ['percentages', 'adjustmentAllocation']);
    if (existing.some(([old, next]) => changed(old, next, ['amount']))) details.push({ label: 'item prices', title: 'Receipt prices updated' });
    if (existing.some(([old, next]) => changed(old, next, ['quantity']) || canonicalJson((old.units as Record<string, unknown> | undefined)?.label) !== canonicalJson((next.units as Record<string, unknown> | undefined)?.label))) details.push({ label: 'item quantity details', title: 'Receipt quantities updated' });
    if (existing.some(([old, next]) => changed(old, next, ['name', 'nameLanguage']))) details.push({ label: 'item descriptions', title: 'Receipt items updated' });
    if (existing.some(([old, next]) => changed(old, next, ['translations']))) details.push({ label: 'item translations', title: 'Item translations updated' });
    const added = newItems.filter(item => !oldById.has(item.id)).length, removed = oldItems.filter(item => !newById.has(item.id)).length;
    if (added || removed) details.push({ label: 'receipt items', title: 'Receipt items updated' });
    else if (changed(before, after, ['items']) && !details.length) details.push({ label: 'receipt items', title: 'Receipt items updated' });
    add('who paid upfront', 'Expense payer changed', ['payer']);
    add('the expense currency', 'Expense currency changed', ['currency']);
    add('conversion details', 'Conversion details updated', ['fx', 'bankAmount']);
    add('tax', 'Receipt tax updated', ['tax']);
    add('the tip', 'Receipt tip updated', ['tip']);
    add('the discount', 'Receipt discount updated', ['discount']);
    add('the transaction date', 'Expense date changed', ['date']);
    add('the transaction time', 'Expense time changed', ['time', 'timezone']);
    add('the receipt image', 'Receipt image changed', ['receiptId']);
    add('the receipt language', 'Receipt language changed', ['receiptLanguage', 'detectedLanguage']);
    add('the purchase place', 'Receipt place changed', ['location']);
    add('the device location hint', 'Receipt location hint changed', ['locationHint']);
    add('receipt notes or aliases', 'Receipt notes updated', ['memory']);
    add('the expense name or icon', 'Expense details changed', ['title', 'icon']);
    if (canonicalJson(conversation(before.conversation)) !== canonicalJson(conversation(after.conversation))) {
      const previous = new Set(conversation(before.conversation).map(message => message.id));
      const messages = conversation(after.conversation).filter(message => !previous.has(message.id));
      const oldMessages = new Map(conversation(before.conversation).map(message => [message.id, message]));
      const newMessages = new Map(conversation(after.conversation).map(message => [message.id, message]));
      const edited = [...new Set([...newMessages.keys(), ...oldMessages.keys()])].filter(id => canonicalJson(oldMessages.get(id)) !== canonicalJson(newMessages.get(id)))
        .flatMap(id => [newMessages.get(id), oldMessages.get(id)].filter((message): message is Record<string, unknown> => !!message));
      const scopedMessages = messages.length ? messages : edited;
      const itemChat = scopedMessages.length > 0 && scopedMessages.every(message => typeof message.itemId === 'string');
      const itemChats = new Set(scopedMessages.map(message => message.itemId)).size;
      if (!details.length) return { title: itemChat ? 'Item chat updated' : 'Receipt chat updated', summary: messages.length
        ? `added ${messages.length === 1 ? 'a message' : `${messages.length} messages`} to ${itemChat ? itemChats > 1 ? `${itemChats} item chats` : 'an item chat' : 'a receipt chat'}`
        : itemChat ? itemChats > 1 ? `updated ${itemChats} item chats` : 'updated an item chat' : 'updated a receipt chat' };
      details.push({ label: 'receipt chat', title: 'Receipt chat updated' });
    }
    if (details.length === 1 && (added || removed)) return { title: 'Receipt items updated', summary: `${list([
      ...(added ? [`added ${added} ${added === 1 ? 'item' : 'items'}`] : []), ...(removed ? [`removed ${removed} ${removed === 1 ? 'item' : 'items'}`] : []),
    ])} on a receipt` };
  } else if (entityType === 'payment') {
    add('the amount', 'Payment amount changed', ['amount']);
    add('the sender or recipient', 'Payment people changed', ['from', 'to']);
    add('the date', 'Payment date changed', ['date']);
    add('the time', 'Payment time changed', ['time', 'timezone']);
    add('the payment method', 'Payment method changed', ['method']);
    add('the payment note', 'Payment note changed', ['note']);
  } else if (entityType === 'trip') {
    add('the holiday dates', 'Holiday dates changed', ['startDate', 'endDate']);
    add('the holiday currency', 'Holiday currency changed', ['currency']);
    add('the receipt language', 'Holiday language changed', ['receiptLanguage']);
    add('the holiday name', 'Holiday renamed', ['name']);
    add('the display order', 'Holiday order changed', ['expenseOrder', 'paymentOrder', 'memberOrder', 'draftOrder']);
  }
  if (!details.length) return null;
  const subject = entityType === 'expense' ? ' on an expense' : entityType === 'payment' ? ' on a payment' : '';
  return { title: new Set(details.map(detail => detail.title)).size === 1 ? details[0].title : entityType === 'trip' ? 'Holiday details changed' : `${entityType === 'expense' ? 'Expense' : 'Payment'} updated`,
    summary: `changed ${list(details.slice(0, 2).map(detail => detail.label))}${details.length > 2 ? ' and other details' : ''}${subject}` };
}

function groupDescription(events: readonly NotificationChange[]) {
  const entity = events[0].entityType;
  const actions = new Set(events.map(event => event.action));
  const action = actions.size === 1 ? events[0].action : undefined;
  const verb = action === 'create' ? entity === 'payment' ? 'recorded' : 'added' : action === 'delete' ? 'removed' : action === 'update' ? 'updated' : 'changed';
  if (entity === 'trip') return { title: 'Holiday details changed', summary: action === 'create' ? 'created a holiday' : action === 'delete' ? 'removed a holiday' : 'updated the holiday details' };
  const noun = entity === 'member' ? 'traveller' : entity === 'invite' ? 'invitation' : entity === 'receipt' ? 'receipt image' : entity;
  const heading = noun[0].toUpperCase() + noun.slice(1);
  return { title: `${heading}${events.length > 1 ? 's' : ''} ${action === 'create' ? entity === 'payment' ? 'recorded' : 'added' : action === 'delete' ? 'removed' : 'updated'}`,
    summary: events.length === 1 ? `${verb} ${entity === 'expense' || entity === 'invite' ? 'an' : 'a'} ${noun}` : `${verb} ${events.length} ${noun}s` };
}

/** Include requested saved labels, with no financial values or conversation text. */
export function activityNotification(actorName: string, changes: readonly NotificationChange[], context: NotificationContext = {}) {
  const events = changes.filter(change => change.entityType !== 'draft');
  if (!events.length) return null;
  let description = events.length === 1 && events[0].action === 'update' ? updateDescription(events[0]) : null;
  if (!description) {
    const priority: ActivityEntity[] = ['expense', 'payment', 'member', 'receipt', 'invite', 'trip'];
    const types = [...new Set(events.map(event => event.entityType))].sort((a, b) => priority.indexOf(a) - priority.indexOf(b));
    const groups = types.map(type => groupDescription(events.filter(event => event.entityType === type)));
    const remaining = events.filter(event => !types.slice(0, 2).includes(event.entityType)).length;
    description = groups.length === 1 ? groups[0] : { title: 'Holiday activity', summary: `${list(groups.slice(0, 2).map(group => group.summary))}${remaining ? `, plus ${remaining} other ${remaining === 1 ? 'update' : 'updates'}` : ''}` };
  }
  const receipts = events.filter(event => event.entityType === 'expense');
  let receipt = receipts[0];
  let items = receipt ? changedItems(receipt) : [];
  for (const candidate of receipts.slice(1)) {
    if (items.length) break;
    const affected = changedItems(candidate);
    if (affected.length) { receipt = candidate; items = affected; }
  }
  const tripEvent = events.find(event => event.entityType === 'trip');
  const receiptName = receipt?.after?.title || receipt?.before?.title;
  const tripName = tripEvent?.after?.name || tripEvent?.before?.name;
  return contextualNotification(actorName, description, { ...context,
    tripName: context.tripName || (typeof tripName === 'string' ? tripName : undefined),
    receiptName: typeof receiptName === 'string' ? receiptName : context.receiptName,
    receiptCount: receipts.length || context.receiptCount,
    itemName: typeof items[0]?.name === 'string' ? items[0].name : context.itemName,
    itemCount: items.length || context.itemCount,
  });
}

export function joinedNotification(actorName: string, tripName?: string) {
  return contextualNotification(actorName, { title: 'Traveller joined', summary: 'joined the holiday' }, { tripName });
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

async function deliverNotifications(tripId: string, actor: string, title: string, body: string, replyAuthor?: string | null) {
  const deadline = Date.now() + deliveryBudgetMs;
  try {
    // Replies go to the saved question's author, including when their connected
    // assistant saved the answer through that same account. Do not guess from a
    // name or redirect an unlinked author's reply to the caller. Legacy messages
    // without an author can notify only the authenticated caller while they
    // still have access to the holiday.
    const memberResult = replyAuthor === undefined
      ? await db().prepare('SELECT user_id FROM memberships WHERE trip_id = ? AND user_id <> ? LIMIT 50').bind(tripId, actor).all<{ user_id: string }>()
      : replyAuthor !== null
        ? await db().prepare('SELECT user_id FROM memberships WHERE trip_id = ? AND member_id = ? LIMIT 1').bind(tripId, replyAuthor).all<{ user_id: string }>()
        : await db().prepare(`SELECT ? AS user_id FROM trips t WHERE t.id = ? AND
          (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))`)
          .bind(actor, tripId, actor, actor).all<{ user_id: string }>();
    const users = [...new Set((memberResult.results ?? []).map(member => member.user_id))];
    if (!users.length) return;
    const now = new Date().toISOString();
    const recent = new Date(Date.now() - 30000).toISOString();
    const shortTitle = compactText(title, 50) || 'Holiday updated';
    const shortBody = compactText(body, 160) || 'Your holiday has a saved update.';
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

/** Names identify the saved question; the actual reply text stays in the app. */
export async function notifyReceiptReply(tripId: string, caller: string, authorMemberId?: string, scope: 'receipt' | 'item' = 'receipt', context: NotificationContext = {}) {
  const hasContext = context.tripName || context.receiptName || context.itemName;
  const notification = hasContext ? contextualNotification('ChatGPT or Codex', {
    title: scope === 'item' ? 'Item chat reply ready' : 'Receipt chat reply ready',
    summary: scope === 'item' ? 'replied in item chat' : 'replied in receipt chat',
  }, context) : { title: scope === 'item' ? 'Item chat reply ready' : 'Receipt chat reply ready',
    body: scope === 'item' ? 'ChatGPT or Codex answered your question about a receipt item.' : 'ChatGPT or Codex answered your receipt question.' };
  const delivery = deliverNotifications(tripId, caller, notification.title, notification.body, authorMemberId ?? null);
  try { waitUntil(delivery); } catch { await delivery; }
}
