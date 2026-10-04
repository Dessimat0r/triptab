import { env } from 'cloudflare:workers';
import { ZodError } from 'zod';
import { LedgerValidationError, parseLedgerStructure, parseStoredTrip, validateLedger, type Ledger, type ReceiptMessage, type Trip } from './model';
import { activityNotification, notifyMembers } from './notifications';
import { AuthError, resolveIdentity, readAuthState } from './auth';
import { markRemovedReceipts, purgeDeletingReceipts, ReceiptLifecycleError } from './receipt-lifecycle';
import { activityStatements, accountAuditStatement, type ActivityEntity, type ActivitySource, type ActivityChange, type ActivityEvent } from './audit';
export { activityStatements, type ActivityEntity, type ActivitySource, type ActivityChange, type ActivityEvent } from './audit';
import { receiptMemorySchema, type ReceiptMemory } from './receipt-context';
import { receiptAliasIdentity, ReceiptMemoryOwnershipError, validateReceiptMemoryOwnership } from './receipt-memory-ownership';

export class RequestError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

export async function owner(request: Request) {
  return (await resolveIdentity(request, { allowSession: true }, db())).id;
}

export function receiptKey(user: string, id: string) {
  return `${encodeURIComponent(user)}/${id}`;
}

// Enforce the limit during reading, including requests without Content-Length.
export async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    throw new RequestError('This upload is too large.', 413);
  }
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestError('This upload is too large.', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function db() {
  const e = env as unknown as { DB: D1Database };
  if (!e.DB) throw new Error('Storage unavailable');
  return e.DB;
}

export function bucket() {
  const e = env as unknown as { RECEIPTS: R2Bucket };
  if (!e.RECEIPTS) throw new Error('Receipt storage unavailable');
  return e.RECEIPTS;
}

type ProfileRow = { id: string; email: string; display_name: string; created_at: string };
export type Profile = { id: string; email: string; displayName: string; createdAt: string; authMethod: 'password' | 'chatgpt'; hasPassword: boolean; chatgptConnected: boolean; chatgptAvailable: boolean; emailVerified: boolean };
type StoredTrip = { id: string; owner: string; data: string };
type MembershipRow = { trip_id: string; user_id: string; member_id: string; email: string | null };

type ActivityRow = {
  sequence: number; id: string; trip_id: string; actor_id: string; actor_name: string;
  created_at: string; entity_type: ActivityEntity; entity_id: string;
  action: ActivityChange['action']; before_data: string | null; after_data: string | null;
  revision: number; source: ActivitySource;
};

/** Compare values, rather than object-key insertion order, before logging edits. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function tripMetadata(trip: Trip): Record<string, unknown> {
  const metadata: Record<string, unknown> = { ...trip };
  for (const key of ['members', 'expenses', 'payments', 'drafts']) delete metadata[key];
  // Record every collection's placement, including order-only edits. Member
  // order also affects deterministic remainder pennies.
  return { ...metadata,
    memberOrder: trip.members.map(member => member.id),
    expenseOrder: trip.expenses.map(expense => expense.id),
    paymentOrder: trip.payments.map(payment => payment.id),
    draftOrder: trip.drafts.map(draft => draft.id),
  };
}

/** Legacy assistant attribution is a display repair, not a participant edit. */
function meaningfulEntry(entry: Record<string, unknown> | undefined) {
  if (!entry || !Array.isArray(entry.conversation)) return entry;
  return clearAssistantAuthors({ ...entry, conversation: entry.conversation.map(message => ({ ...message })) });
}

function tripChanges(previous: Trip | undefined, next: Trip): ActivityChange[] {
  const changes: ActivityChange[] = [];
  const before = previous ? tripMetadata(previous) : null;
  const after = tripMetadata(next);
  const comparedBefore = before && { ...before }, comparedAfter = { ...after };
  if (comparedBefore) for (const key of ['expenseOrder', 'paymentOrder', 'draftOrder']) {
    const oldOrder = comparedBefore[key] as string[], newOrder = comparedAfter[key] as string[];
    const oldIds = new Set(oldOrder), newIds = new Set(newOrder);
    if (canonical(oldOrder.filter(id => newIds.has(id))) === canonical(newOrder.filter(id => oldIds.has(id)))) {
      // Entry create/delete events explain insertion/removal. Keep true relative
      // reorders, and all member placement changes that can affect remainder pennies.
      delete comparedBefore[key]; delete comparedAfter[key];
    }
  }
  if (canonical(comparedBefore) !== canonical(comparedAfter)) changes.push({ tripId: next.id, entityType: 'trip', entityId: next.id, action: before ? 'update' : 'create', before, after });
  for (const [entityType, oldEntries, entries] of [
    ['member', previous?.members || [], next.members],
    ['expense', previous?.expenses || [], next.expenses],
    ['payment', previous?.payments || [], next.payments],
    ['draft', previous?.drafts || [], next.drafts],
  ] as const) {
    const old = new Map(oldEntries.map(entry => [entry.id, entry]));
    const current = new Map(entries.map(entry => [entry.id, entry]));
    for (const entry of entries) {
      const prior = old.get(entry.id) as Record<string, unknown> | undefined;
      if (canonical(meaningfulEntry(prior) ?? null) !== canonical(meaningfulEntry(entry))) changes.push({ tripId: next.id, entityType, entityId: entry.id, action: prior ? 'update' : 'create', before: prior ?? null, after: entry });
    }
    for (const entry of oldEntries) {
      if (!current.has(entry.id)) changes.push({ tripId: next.id, entityType, entityId: entry.id, action: 'delete', before: entry, after: null });
    }
  }
  return changes;
}

export const MAX_ACTIVITY_BYTES = 4 * 1024 * 1024;

/** Assistant identity comes from its role; historical human stamps were erroneous. */
function clearAssistantAuthors<Entry extends object>(entry: Entry): Entry {
  const conversation = (entry as { conversation?: unknown }).conversation;
  if (Array.isArray(conversation)) for (const message of conversation) {
    if (message && typeof message === 'object' && message.role === 'assistant') {
      delete message.authorMemberId; delete message.authorName;
    }
  }
  return entry;
}

export async function readActivity(user: string, tripId: string, options: { before?: number; limit?: number } = {}): Promise<{ events: ActivityEvent[]; nextCursor: number | null }> {
  if (!tripId || tripId.length > 100) throw new RequestError('Choose a valid trip.');
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RequestError('Choose an activity page size between 1 and 50.');
  if (options.before !== undefined && (!Number.isSafeInteger(options.before) || options.before < 1)) throw new RequestError('Choose a valid activity cursor.');
  if (!await tripAccess(user, tripId)) throw new RequestError('You do not have access to this trip.', 403);
  // Select only identifiers and encoded lengths first. Particularly large
  // immutable snapshots must not materialize as an unbounded activity page.
  const candidates = await db().prepare(`
    SELECT e.id, e.sequence,
      length(CAST(json_object('id', e.id, 'sequence', e.sequence, 'tripId', e.trip_id,
        'actorId', e.actor_id, 'actorName', e.actor_name, 'createdAt', e.created_at,
        'entityType', e.entity_type, 'entityId', e.entity_id, 'action', e.action,
        'before', NULL, 'after', NULL, 'revision', e.revision, 'source', e.source) AS BLOB))
      + length(CAST(COALESCE(e.before_data, '') AS BLOB))
      + length(CAST(COALESCE(e.after_data, '') AS BLOB)) AS bytes
    FROM activity_events e JOIN trips t ON t.id = e.trip_id
    WHERE e.trip_id = ? AND e.sequence < ?
      AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))
    ORDER BY e.sequence DESC LIMIT ?
  `).bind(tripId, options.before ?? Number.MAX_SAFE_INTEGER, user, user, limit + 1).all<{ id: string; sequence: number; bytes: number }>();
  const selected: { id: string; sequence: number }[] = [];
  let bytes = 128; // Envelope, commas and the bounded sequence cursor.
  for (const candidate of candidates.results.slice(0, limit)) {
    if (bytes + candidate.bytes + 1 > MAX_ACTIVITY_BYTES) break;
    selected.push(candidate);
    bytes += candidate.bytes + 1;
  }
  if (!selected.length) {
    if (candidates.results.length) throw new RequestError('This history entry is too large to load as a page.', 413);
    return { events: [], nextCursor: null };
  }
  // Recheck access while fetching only the chosen immutable IDs, so membership
  // loss between metadata and snapshot reads cannot expose history or cursors.
  const rows = await db().prepare(`
    SELECT e.* FROM activity_events e JOIN trips t ON t.id = e.trip_id
    WHERE e.trip_id = ? AND e.id IN (SELECT value FROM json_each(?))
      AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))
    ORDER BY e.sequence DESC
  `).bind(tripId, JSON.stringify(selected.map(event => event.id)), user, user).all<ActivityRow>();
  if (rows.results.length !== selected.length) throw new RequestError('Your access to this trip changed. Refresh before viewing its history.', 403);
  const result = {
    events: rows.results.map(row => ({ id: row.id, sequence: row.sequence, tripId: row.trip_id, actorId: row.actor_id, actorName: row.actor_name, createdAt: row.created_at, entityType: row.entity_type, entityId: row.entity_id, action: row.action, before: row.before_data ? clearAssistantAuthors(JSON.parse(row.before_data)) : null, after: row.after_data ? clearAssistantAuthors(JSON.parse(row.after_data)) : null, revision: row.revision, source: row.source })),
    nextCursor: candidates.results.length > selected.length ? selected[selected.length - 1].sequence : null,
  };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_ACTIVITY_BYTES) {
    throw new RequestError('This history entry is too large to load as a page.', 413);
  }
  return result;
}

export async function ensureProfile(request: Request, options: { allowSession?: boolean } = { allowSession: true }): Promise<Profile> {
  const identity = await resolveIdentity(request, options, db());
  const id = identity.id;
  const email = identity.email?.trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('UNAUTHORIZED');
  const name = identity.displayName || email.split('@')[0];
  const createdAt = new Date().toISOString();
  const displayName = name.slice(0, 80);
  const providerId = identity.kind === 'chatgpt' ? identity.chatgptId || id : null;
  await db().batch([
    db().prepare(`INSERT INTO profiles (id, email, display_name, created_at)
      SELECT ?, ?, ?, ? WHERE ? IS NULL OR NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?)
      ON CONFLICT(id) DO NOTHING`).bind(id, email, displayName, createdAt, providerId, providerId, id),
    accountAuditStatement(db(), { userId: id, actorName: displayName, entityType: 'profile', entityId: id,
      action: 'create', before: null, after: { displayName }, source: 'chatgpt' }, { sql: 'changes() > 0', bindings: [] }),
  ]);
  const profile = await db().prepare('SELECT id, email, display_name, created_at FROM profiles WHERE id = ?').bind(id).first<ProfileRow>();
  if (!profile) throw new Error('UNAUTHORIZED');
  const state = await readAuthState(request, db(), options);
  if (!state.authenticated || state.profile?.id !== id) throw new Error('UNAUTHORIZED');
  return { id: profile.id, email: profile.email, displayName: profile.display_name, createdAt: profile.created_at, authMethod: identity.kind === 'session' ? 'password' : 'chatgpt', hasPassword: state.hasPassword, chatgptConnected: state.chatgptLinked, chatgptAvailable: state.chatgptAvailable, emailVerified: state.emailVerified };
}

export async function readLedger(id: string): Promise<{ data: Ledger; revision: number }> {
  const results = await db().batch([
    db().prepare('SELECT t.id, t.owner, t.data FROM trips t WHERE t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?) ORDER BY t.id').bind(id, id),
    db().prepare('SELECT COALESCE((SELECT revision FROM sync_state WHERE id = 1), 0) AS revision'),
    db().prepare('SELECT m.trip_id, m.user_id, m.member_id, p.email FROM memberships m LEFT JOIN profiles p ON p.id = m.user_id JOIN trips t ON t.id = m.trip_id WHERE t.owner = ? OR EXISTS (SELECT 1 FROM memberships access WHERE access.trip_id = t.id AND access.user_id = ?)').bind(id, id),
  ]);
  const links = results[2].results as MembershipRow[];
  const trips = (results[0].results as StoredTrip[]).map(row => {
    const trip = { ...JSON.parse(row.data), ownerId: row.owner } as Trip;
    for (const member of trip.members) {
      const link = links.find(value => value.trip_id === trip.id && value.member_id === member.id);
      if (link) { member.userId = link.user_id; member.email = link.email || member.email; }
    }
    for (const entry of [...trip.expenses, ...trip.drafts]) clearAssistantAuthors(entry);
    return trip;
  });
  const revision = (results[1].results as { revision: number }[])[0]?.revision || 0;
  return { data: { trips }, revision };
}

export async function tripAccess(user: string, tripId: string): Promise<boolean> {
  const row = await db().prepare('SELECT 1 AS allowed FROM trips t WHERE t.id = ? AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))').bind(tripId, user, user).first();
  return !!row;
}

export async function receiptAccess(user: string, id: string): Promise<{ owner: string; tripId: string } | null> {
  const row = await db().prepare("SELECT r.owner, r.trip_id FROM receipts r JOIN trips t ON t.id = r.trip_id WHERE r.id = ? AND r.state = 'active' AND (t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))").bind(id, user, user).first<{ owner: string; trip_id: string }>();
  return row ? { owner: row.owner, tripId: row.trip_id } : null;
}

function receiptMessageBody(message: ReceiptMessage) {
  return { role: message.role, text: message.text, createdAt: message.createdAt, replyTo: message.replyTo, itemId: message.itemId };
}

/** Saved IDs identify immutable words and authors, including draft/expense copies. */
async function stampReceiptAuthors(trip: Trip, previous: Trip | undefined, actorMemberId: string | undefined, actorName: string) {
  const known = new Map<string, ReceiptMessage[]>();
  for (const entry of [...(previous?.expenses || []), ...(previous?.drafts || [])]) {
    for (const message of entry.conversation || []) known.set(message.id, [...(known.get(message.id) || []), message]);
  }
  const unfamiliar = [...new Set([...trip.expenses, ...trip.drafts].flatMap(entry => (entry.conversation || [])
    .filter(message => !known.has(message.id))
    .map(message => message.id)))];
  if (previous && unfamiliar.length) {
    if (unfamiliar.length > 100) throw new RequestError('Add or restore no more than 100 receipt messages at a time. Save one receipt at a time.');
    // Indexed same-trip IDs distinguish genuinely new messages from restoration.
    // Timestamps and caller-supplied author claims never bypass this lookup.
    const history = await db().prepare(`
      SELECT message_data AS message FROM receipt_messages
      WHERE trip_id = ? AND message_id IN (SELECT value FROM json_each(?)) LIMIT 100
    `).bind(trip.id, JSON.stringify(unfamiliar)).all<{ message: string }>();
    for (const row of history.results) {
      const message = JSON.parse(row.message) as ReceiptMessage;
      known.set(message.id, [message]);
    }
  }
  let added = false;
  for (const entry of [...trip.expenses, ...trip.drafts]) for (const message of entry.conversation || []) {
    const saved = known.get(message.id);
    if (saved) {
      const original = saved.find(candidate => canonical(receiptMessageBody(candidate)) === canonical(receiptMessageBody(message)));
      if (!original) throw new RequestError('Saved receipt messages cannot be edited. Add a new message instead.');
      if (message.role === 'assistant' || original.authorMemberId === undefined) delete message.authorMemberId;
      else message.authorMemberId = original.authorMemberId;
      if (message.role === 'assistant' || original.authorName === undefined) delete message.authorName;
      else message.authorName = original.authorName;
    } else {
      added = true;
      if (message.role === 'assistant' || actorMemberId === undefined) delete message.authorMemberId;
      else message.authorMemberId = actorMemberId;
      if (message.role === 'assistant') delete message.authorName;
      else message.authorName = actorName;
      known.set(message.id, [{ ...message }]);
    }
  }
  return added;
}

export const MAX_LEDGER_CONTENT_BYTES = 1_500_000;
export const MAX_STORED_LEDGER_BYTES = 1_900_000;
export const MAX_STORED_TRIP_BYTES = 1_900_000;
const jsonBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Count editable content; trusted ownership, speakers and rule versions have reserved space. */
export function ledgerContentBytes(ledger: Ledger): number {
  const receiptContent = <Entry extends Trip['expenses'][number] | Trip['drafts'][number]>(entry: Entry): Entry => {
    const content = { ...entry };
    delete content.adjustmentAllocation;
    if (content.conversation) content.conversation = content.conversation.map(message => {
      const contentMessage = { ...message };
      delete contentMessage.authorMemberId; delete contentMessage.authorName;
      return contentMessage;
    });
    return content;
  };
  return jsonBytes({ trips: ledger.trips.map(trip => {
    const content = { ...trip };
    delete content.ownerId;
    content.members = content.members.map(member => {
      const contentMember = { ...member };
      delete contentMember.userId; delete contentMember.email;
      return contentMember;
    });
    content.expenses = content.expenses.map(receiptContent);
    content.drafts = content.drafts.map(receiptContent);
    return content;
  }) });
}

function checkLedgerSize(ledger: Ledger) {
  if (ledgerContentBytes(ledger) > MAX_LEDGER_CONTENT_BYTES) {
    throw new RequestError('Your ledger has too much receipt or payment content. Remove some entries before saving.', 413);
  }
  // Bound the entire normalized ledger and every stored JSON value below D1's
  // 2 MB cell/binding limit. Server metadata never bypasses this hard ceiling.
  if (ledger.trips.some(trip => jsonBytes(trip) > MAX_STORED_TRIP_BYTES) || jsonBytes(ledger) > MAX_STORED_LEDGER_BYTES) {
    throw new RequestError('Your ledger has exhausted its storage space for receipt metadata. Remove some entries before saving.', 413);
  }
}

/** A proposal may carry saved aliases from its posted target and vice versa. */
function mergedReceiptMemory(entries: { memory?: ReceiptMemory }[], corrections: { memory?: ReceiptMemory }[]): ReceiptMemory | undefined {
  if (!entries.some(entry => entry.memory)) return undefined;
  const corrected = new Map<string, Set<string>>();
  for (const entry of corrections) for (const alias of entry.memory?.aliases || []) {
    const identity = receiptAliasIdentity(alias);
    const variants = corrected.get(identity) || new Set<string>();
    variants.add(canonical(alias)); corrected.set(identity, variants);
  }
  const aliases = new Map<string, { alias: ReceiptMemory['aliases'][number]; count: number }>();
  for (const entry of entries) {
    const frequencies = new Map<string, { alias: ReceiptMemory['aliases'][number]; count: number }>();
    for (const alias of entry.memory?.aliases || []) {
      const key = canonical(alias);
      // Only an already linked, trusted proposal can supersede a target alias.
      // Missing identities still survive; copied photos/chat cannot authorize it.
      const variants = corrected.get(receiptAliasIdentity(alias));
      if (variants && !variants.has(key)) continue;
      const saved = frequencies.get(key);
      frequencies.set(key, { alias, count: (saved?.count || 0) + 1 });
    }
    for (const [key, value] of frequencies) if (value.count > (aliases.get(key)?.count || 0)) aliases.set(key, value);
  }
  return { notes: '', aliases: [...aliases.values()].flatMap(({ alias, count }) => Array.from({ length: count }, () => alias)) };
}

/** Enforce ownership for every writer, using only stored receipt/history provenance. */
async function validateTripReceiptMemory(trip: Trip, previous: Trip | undefined, actorMemberId: string | undefined) {
  const savedEntries = [...(previous?.expenses || []), ...(previous?.drafts || [])];
  const incomingEntries = [...trip.expenses, ...trip.drafts];
  const sources = new Map<string, { memory?: ReceiptMemory }[]>();
  const corrections = new Map<string, { memory?: ReceiptMemory }[]>();
  for (const entry of incomingEntries) {
    const saved = savedEntries.find(candidate => candidate.id === entry.id);
    const matching = saved ? [saved] : [];
    // An untouched copy does not consume another receipt's newer proposal.
    if (!saved || canonical(saved.memory) !== canonical(entry.memory)) {
      if ('expenseId' in entry && entry.expenseId) {
        const target = previous?.expenses.find(candidate => candidate.id === entry.expenseId);
        if (target && !matching.includes(target)) matching.push(target);
      }
      for (const draft of previous?.drafts || []) {
        const retained = trip.drafts.find(candidate => candidate.id === draft.id);
        const transfer = draft.expenseId === entry.id && (!retained || canonical(retained.memory) === canonical(entry.memory));
        const newTarget = retained?.expenseId === entry.id && canonical(retained.memory) === canonical(entry.memory);
        if ((transfer || newTarget) && !matching.includes(draft)) matching.push(draft);
        if (transfer && !('status' in entry)) corrections.set(entry.id, [...(corrections.get(entry.id) || []), draft]);
      }
      if (!saved) for (const candidate of savedEntries) {
        const sameImage = !!entry.receiptId && entry.receiptId === candidate.receiptId;
        const sameConversation = entry.conversation?.some(message => candidate.conversation?.some(original => original.id === message.id
          && canonical(receiptMessageBody(original)) === canonical(receiptMessageBody(message))));
        if ((sameImage || sameConversation) && !matching.includes(candidate)) matching.push(candidate);
      }
    }
    sources.set(entry.id, matching);
  }

  // Deleted receipts retain their original alias ownership when restored under
  // their stable ID. Filter metadata first and extract only the latest matching
  // aliases, never materializing unrelated financial snapshots or chat history.
  const restored = previous ? incomingEntries.filter(entry => !savedEntries.some(saved => saved.id === entry.id)).map(entry => entry.id) : [];
  for (let offset = 0; offset < restored.length; offset += 100) {
    const history = await db().prepare(`WITH latest AS (
      SELECT entity_id, MAX(sequence) AS sequence
      FROM activity_events WHERE trip_id = ? AND entity_type IN ('expense', 'draft')
        AND entity_id IN (SELECT value FROM json_each(?))
      GROUP BY entity_id
    ) SELECT latest.entity_id, json_extract(COALESCE(e.after_data, e.before_data), '$.memory.aliases') AS aliases
      FROM latest JOIN activity_events e ON e.sequence = latest.sequence`)
      .bind(trip.id, JSON.stringify(restored.slice(offset, offset + 100))).all<{ entity_id: string; aliases: string | null }>();
    for (const row of history.results) if (row.aliases !== null) {
      sources.set(row.entity_id, [...(sources.get(row.entity_id) || []), { memory: receiptMemorySchema.parse({ aliases: JSON.parse(row.aliases) }) }]);
    }
  }

  const activeMemberIds = new Set(trip.members.map(member => member.id));
  let changed = false;
  for (const entry of incomingEntries) {
    const saved = savedEntries.find(candidate => candidate.id === entry.id);
    if (canonical(saved?.memory) !== canonical(entry.memory)) changed = true;
    try {
      validateReceiptMemoryOwnership(mergedReceiptMemory(sources.get(entry.id) || [], corrections.get(entry.id) || []), entry.memory, actorMemberId, activeMemberIds);
    } catch (error) {
      if (error instanceof ReceiptMemoryOwnershipError) throw new RequestError(error.message);
      throw error;
    }
  }
  return changed;
}

export async function writeLedger(id: string, data: unknown, revision: unknown, options: { source?: ActivitySource } = {}) {
  // Parse bounded structure first. New financial rules are applied after access
  // checks, with trusted stored snapshots allowing unchanged legacy entries to
  // remain available until their owner explicitly repairs them.
  let ledger = parseLedgerStructure(data);
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid revision');
  checkLedgerSize(ledger);
  const tripIds = ledger.trips.map(trip => trip.id);
  const tripIdsJson = JSON.stringify(tripIds);
  // D1 batches read one transactional snapshot. Reject future as well as stale
  // tokens before diffing, so every before-image belongs to that exact revision.
  const baseline = await db().batch([
    db().prepare('SELECT id, owner, data FROM trips WHERE id IN (SELECT value FROM json_each(?))').bind(tripIdsJson),
    db().prepare('SELECT m.trip_id, m.user_id, m.member_id, p.email FROM memberships m LEFT JOIN profiles p ON p.id = m.user_id WHERE m.trip_id IN (SELECT value FROM json_each(?))').bind(tripIdsJson),
    db().prepare("SELECT id, trip_id FROM receipts WHERE state = 'active' AND trip_id IN (SELECT value FROM json_each(?))").bind(tripIdsJson),
    db().prepare('SELECT id, email, display_name, created_at FROM profiles WHERE id = ?').bind(id),
    db().prepare('SELECT COALESCE((SELECT revision FROM sync_state WHERE id = 1), 0) AS revision'),
  ]);
  const baselineRevision = (baseline[4].results as { revision: number }[])[0].revision;
  if (baselineRevision !== revision) throw new Error('CONFLICT');
  const existingRows = { results: baseline[0].results as StoredTrip[] };
  const linkedRows = { results: baseline[1].results as MembershipRow[] };
  const receiptRows = { results: baseline[2].results as { id: string; trip_id: string }[] };
  const profile = (baseline[3].results as ProfileRow[])[0];
  const existing = new Map(existingRows.results.map(row => [row.id, row]));
  const newTrips: Trip[] = [];
  const changedTrips: Trip[] = [];
  const changes: ActivityChange[] = [];
  const previousTrips = new Map<string, Trip>();
  const conversationAuthors: { tripId: string; memberId?: string }[] = [];

  for (const trip of ledger.trips) {
    const stored = existing.get(trip.id);
    const links = linkedRows.results.filter(row => row.trip_id === trip.id);
    if (stored) {
      if (stored.owner !== id && !links.some(link => link.user_id === id)) throw new RequestError('You do not have access to this trip.', 403);
      const previous = parseStoredTrip(JSON.parse(stored.data));
      if (trip.currency !== previous.currency) throw new RequestError('A saved trip’s settlement currency cannot be changed.');
      if (links.some(link => !trip.members.some(member => member.id === link.member_id))) throw new RequestError('An account-linked traveller cannot be removed.');
      trip.ownerId = stored.owner;
      for (const member of trip.members) {
        const old = previous.members.find(value => value.id === member.id);
        const link = links.find(value => value.member_id === member.id);
        if (link) {
          member.userId = link.user_id;
          member.email = link.email || old?.email;
        } else {
          delete member.userId;
          member.email = old?.email;
        }
      }
      const prior = { ...previous, ownerId: stored.owner };
      // Membership metadata is authoritative; overlay it on both snapshots so
      // a routine save cannot log a fake account change from stale trip JSON.
      for (const member of prior.members) {
        const link = links.find(value => value.member_id === member.id);
        if (link) { member.userId = link.user_id; member.email = link.email || member.email; }
        else delete member.userId;
      }
      previousTrips.set(trip.id, prior);
    } else {
      trip.ownerId = id;
      for (const member of trip.members) { delete member.userId; delete member.email; }
      const firstMember = trip.members[0];
      firstMember.userId = id;
      if (profile) {
        firstMember.email = profile.email;
        firstMember.name = profile.display_name.slice(0, 50);
      }
    }
    for (const entry of [...trip.expenses, ...trip.drafts]) {
      if (entry.receiptId && !receiptRows.results.some(receipt => receipt.id === entry.receiptId && receipt.trip_id === trip.id)) {
        throw new RequestError('This receipt was removed or does not belong to the trip. Upload it again before saving.');
      }
    }
    const actorMemberId = stored ? links.find(link => link.user_id === id)?.member_id : trip.members[0].id;
    const memoryChanged = await validateTripReceiptMemory(trip, previousTrips.get(trip.id), actorMemberId);
    if ((await stampReceiptAuthors(trip, previousTrips.get(trip.id), actorMemberId, profile?.display_name.trim().slice(0, 80) || 'Traveller') || memoryChanged) && stored) {
      conversationAuthors.push({ tripId: trip.id, memberId: actorMemberId });
    }
  }

  // Repair only the old assistant attribution, preserving compatibility for
  // unchanged historical money. Audit before-images still retain the raw stamps.
  const validationPrevious = [...previousTrips.values()].map(trip => ({ ...trip,
    expenses: trip.expenses.map(entry => clearAssistantAuthors({ ...entry, conversation: entry.conversation?.map(message => ({ ...message })) })),
    drafts: trip.drafts.map(entry => clearAssistantAuthors({ ...entry, conversation: entry.conversation?.map(message => ({ ...message })) })),
  }));
  ledger = validateLedger(ledger, { previous: { trips: validationPrevious } });
  checkLedgerSize(ledger);
  // Diff the final validated representation, so accepted normalization of new
  // fields and every explicit legacy repair have accurate history snapshots.
  for (const trip of ledger.trips) {
    const previous = previousTrips.get(trip.id);
    changes.push(...tripChanges(previous, trip));
    if (!previous) newTrips.push(trip);
    else if (changes.some(change => change.tripId === trip.id)) changedTrips.push(trip);
  }
  const receiptReferences = ledger.trips.flatMap(trip => [...trip.expenses, ...trip.drafts].flatMap(entry => entry.receiptId ? [{ id: entry.receiptId, tripId: trip.id }] : []));
  const retainedReceiptIds = new Set(receiptReferences.map(reference => reference.id));
  const removedReceiptIds = [...new Set([...previousTrips.values()].flatMap(trip => [...trip.expenses, ...trip.drafts].flatMap(entry => entry.receiptId && !retainedReceiptIds.has(entry.receiptId) ? [entry.receiptId] : [])))];
  const preimages = tripIds.map(tripId => ({ id: tripId, owner: existing.get(tripId)?.owner ?? null }));
  // Every production trip writer (ledger save and invitation acceptance) advances
  // the same transactional revision. CAS pins their data without rebinding JSON;
  // compact owner/existence, access, receipt and actor checks cover other state.
  const marker = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db().prepare("INSERT OR IGNORE INTO sync_state (id, revision, last_write) VALUES (1, 0, '')"),
    db().prepare(`UPDATE sync_state SET revision = revision + 1, last_write = ?
      WHERE id = 1 AND revision = ?
        AND NOT EXISTS (SELECT 1 FROM auth_links WHERE oai_user_id = ? AND user_id <> ?)
        AND NOT EXISTS (SELECT 1 FROM json_each(?) ids JOIN trips t ON t.id = ids.value
          WHERE t.owner <> ? AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))
        AND NOT EXISTS (SELECT 1 FROM json_each(?) ref LEFT JOIN receipts r ON r.id = json_extract(ref.value, '$.id')
          WHERE r.id IS NULL OR r.state <> 'active' OR r.trip_id <> json_extract(ref.value, '$.tripId'))
        AND NOT EXISTS (SELECT 1 FROM json_each(?) author LEFT JOIN memberships m
          ON m.trip_id = json_extract(author.value, '$.tripId') AND m.user_id = ?
          WHERE m.member_id IS NOT json_extract(author.value, '$.memberId'))
        AND NOT EXISTS (SELECT 1 FROM json_each(?) prior LEFT JOIN trips t ON t.id = json_extract(prior.value, '$.id')
          WHERE (json_extract(prior.value, '$.owner') IS NULL AND t.id IS NOT NULL)
            OR (json_extract(prior.value, '$.owner') IS NOT NULL
              AND (t.id IS NULL OR t.owner IS NOT json_extract(prior.value, '$.owner'))))
    `).bind(marker, revision, id, id, tripIdsJson, id, id, JSON.stringify(receiptReferences), JSON.stringify(conversationAuthors), id,
      JSON.stringify(preimages)),
  ];
  for (const trip of ledger.trips) {
    statements.push(db().prepare('INSERT INTO trips (id, owner, data) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data WHERE EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?) AND (trips.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = trips.id AND m.user_id = ?))').bind(trip.id, trip.ownerId!, JSON.stringify(trip), marker, marker, id, id));
  }
  for (const trip of newTrips) {
    statements.push(db().prepare('INSERT INTO memberships (trip_id, user_id, member_id) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM sync_state WHERE id = 1 AND last_write = ?)').bind(trip.id, id, trip.members[0].id, marker));
  }
  statements.push(...activityStatements(db(), changes, { id, displayName: profile?.display_name || 'Traveller' }, marker, revision + 1, options.source));
  const results = await db().batch(statements);
  if (!results[1].meta.changes) throw new Error('CONFLICT');
  if (removedReceiptIds.length) {
    // Cleanup follows the successful financial commit. The atomic reference
    // check and deleting state prevent a concurrent save from reattaching an
    // image while R2 deletion is in progress. Failures never undo saved money.
    await markRemovedReceipts(db(), id, removedReceiptIds, { source: options.source }).then(() => purgeDeletingReceipts(db(), bucket(), id)).catch(() => {
      console.warn('TripTab saved the entry; receipt cleanup will retry.');
    });
  }
  for (const trip of changedTrips) {
    const notification = activityNotification(profile?.display_name || 'A traveller', changes.filter(change => change.tripId === trip.id));
    if (!notification) continue;
    await notifyMembers(trip.id, id, notification.title, notification.body).catch(() => {
      console.warn('TripTab could not queue a holiday update notification.');
    });
  }
  // Omitted trips remain available: ledger saves never delete shared records.
  return readLedger(id);
}

export function failure(e: unknown) {
  // Expected validation/auth failures do not need stack traces or submitted
  // values in logs. Storage faults retain a short, value-free diagnostic.
  if (!(e instanceof RequestError) && !(e instanceof AuthError) && !(e instanceof ReceiptLifecycleError) && !(e instanceof LedgerValidationError) && !(e instanceof ZodError) && !(e instanceof Error && ['UNAUTHORIZED', 'CONFLICT'].includes(e.message))) console.error('TripTab request failed', { kind: e instanceof Error ? e.name : 'UnknownError' });
  const m = e instanceof Error ? e.message : '';
  const issue = e instanceof ZodError ? e.issues[0] : undefined;
  const knownFields = new Set(['trips', 'id', 'ownerId', 'name', 'currency', 'startDate', 'endDate', 'members', 'userId', 'email', 'expenses', 'drafts', 'payments', 'title', 'date', 'time', 'timezone', 'fx', 'rate', 'asOf', 'source', 'bankAmount', 'payer', 'items', 'amount', 'percentages', 'units', 'total', 'allocations', 'label', 'conversation', 'role', 'text', 'createdAt', 'replyTo', 'itemId', 'authorMemberId', 'authorName', 'memory', 'notes', 'aliases', 'memberId', 'scopeMemberId', 'tax', 'tip', 'discount', 'receiptId', 'expenseId', 'status', 'from', 'to', 'note', 'method']);
  const issuePath = issue?.path.map(part => typeof part === 'number' ? String(part + 1) : knownFields.has(part) ? part : 'entry').join(' → ');
  // Zod's enum/literal messages can echo the supplied value; use a fixed message.
  const issueMessage = issue?.code === 'unrecognized_keys' ? 'Remove unsupported fields.'
    : issue && ['invalid_enum_value', 'invalid_literal'].includes(issue.code) ? 'Choose a supported value.' : issue?.message;
  const error = issue ? `${issuePath || 'Entry'}: ${issueMessage?.slice(0, 300) || 'Check this value.'}`
    : e instanceof LedgerValidationError ? e.message
    : e instanceof RequestError || e instanceof AuthError || e instanceof ReceiptLifecycleError ? (m === 'UNAUTHORIZED' ? 'Sign in to TripTab to open your ledger.' : e.message)
    : m === 'UNAUTHORIZED' ? 'Sign in to TripTab to open your ledger.'
    : m === 'CONFLICT' ? 'Your ledger changed in another tab or in ChatGPT. Refresh before saving again.'
    : 'Unable to complete this request. Check your entries and try again.';
  const status = e instanceof LedgerValidationError ? 400 : e instanceof RequestError || e instanceof AuthError || e instanceof ReceiptLifecycleError ? e.status : m === 'UNAUTHORIZED' ? 401 : m === 'CONFLICT' ? 409 : 400;
  return Response.json({ error }, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export function sameOrigin(r: Request) {
  if (r.headers.get('origin') !== new URL(r.url).origin) throw new Error('Invalid origin');
}
