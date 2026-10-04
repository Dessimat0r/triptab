import { db, failure, owner, RequestError, tripAccess } from '@/lib/store';
import { expenseShares, expenseTotal, parseStoredTrip, total, type Trip } from '@/lib/model';

export const dynamic = 'force-dynamic';

const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const PRIVATE_HEADERS = { 'Cache-Control': 'private, no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };
const ACCESS = '(t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))';
type ProfileRow = { id: string; email: string; display_name: string; created_at: string };
type TripRow = { id: string; owner: string; data: string };
type EventRow = { id: string; sequence: number; trip_id: string; actor_id: string; actor_name: string; created_at: string; entity_type: string; entity_id: string; action: string; before_data: string | null; after_data: string | null; revision: number; source: string };

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  // Quoting handles CSV structure; a leading apostrophe separately prevents
  // spreadsheet formula execution, including formulas hidden behind whitespace.
  if (typeof value !== 'number' && (/^[=+\-@]/.test(text.trimStart()) || /^[\t\r\n]/.test(text))) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}
function csv(rows: unknown[][]): string { return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
function decimal(amount: number | undefined): string | undefined { return amount === undefined ? undefined : (amount / 100).toFixed(2); }
function utc(value: string): string { return new Date(value).toISOString(); }

function financialCsv(trip: Trip): string {
  const name = (id: string) => trip.members.find(member => member.id === id)?.name || id;
  const rows: unknown[][] = [[
    'record_type', 'record_id', 'title', 'transaction_date_local', 'transaction_time_local', 'transaction_timezone',
    'receipt_currency', 'receipt_amount_hundredths', 'receipt_amount', 'settlement_currency', 'settlement_amount_hundredths', 'settlement_amount',
    'paid_by', 'from', 'to', 'payment_method', 'note', 'tax_hundredths', 'tip_hundredths', 'discount_hundredths',
    'bank_charge_hundredths', 'fx_rate', 'fx_as_of', 'fx_source', 'receipt_id', 'entry_source', 'calculation_error',
    ...trip.members.map(member => `${member.name}_cost_share_hundredths`),
  ]];
  for (const expense of trip.expenses) {
    let original: number | undefined;
    let converted: number | undefined;
    let shares: number[] = [];
    let calculationError = '';
    // Export legacy records even when their financial validation now fails.
    // Never invent a converted amount or silently repair someone's saved data.
    try { original = total(expense); converted = expenseTotal(expense, trip.currency); shares = expenseShares(expense, trip.members, trip.currency); }
    catch (cause) { calculationError = cause instanceof Error ? cause.message : 'This receipt needs review'; }
    rows.push([
      'expense', expense.id, expense.title, expense.date, expense.time, expense.timezone,
      expense.currency, original, decimal(original), trip.currency, converted, decimal(converted),
      name(expense.payer), '', '', '', '', expense.tax, expense.tip, expense.discount,
      expense.bankAmount, expense.fx?.rate, expense.fx?.asOf, expense.fx?.source, expense.receiptId, expense.source || 'manual', calculationError,
      ...trip.members.map((_, index) => shares[index]),
    ]);
  }
  for (const payment of trip.payments) {
    rows.push([
      'payment', payment.id, '', payment.date, payment.time, payment.timezone,
      '', '', '', trip.currency, payment.amount, decimal(payment.amount), '', name(payment.from), name(payment.to), payment.method, payment.note,
      '', '', '', '', '', '', '', '', '', '', ...trip.members.map(() => ''),
    ]);
  }
  return csv(rows);
}

async function snapshots(actor: string, tripId?: string): Promise<Trip[]> {
  const database = db();
  const filter = tripId === undefined ? '' : ' AND t.id = ?';
  const values = [actor, actor, ...(tripId === undefined ? [] : [tripId])];
  const aggregate = `SELECT COALESCE(SUM(length(CAST(t.data AS BLOB))), 0) FROM trips t WHERE ${ACCESS}${filter}`;
  const [sizes, rows] = await database.batch([
    database.prepare(`SELECT COUNT(*) AS count, (${aggregate}) AS bytes FROM trips t WHERE ${ACCESS}${filter}`).bind(...values, ...values),
    // Enforce the byte budget inside the data query as well: a concurrent save
    // cannot enlarge the result between the size check and the authorized read.
    database.prepare(`SELECT t.id, t.owner, t.data FROM trips t WHERE ${ACCESS}${filter} AND (${aggregate}) <= ? ORDER BY t.id`).bind(...values, ...values, MAX_SNAPSHOT_BYTES),
  ]);
  const size = sizes.results[0] as { count: number; bytes: number } | undefined;
  if (!size || size.bytes > MAX_SNAPSHOT_BYTES) throw new RequestError('This account export is too large. Download one holiday at a time.', 413);
  if (tripId !== undefined && !size.count) throw new RequestError('You do not have access to this holiday.', 403);
  return (rows.results as TripRow[]).map(row => ({ ...parseStoredTrip(JSON.parse(row.data)), ownerId: row.owner }));
}

async function activity(actor: string, tripId: string, before = Number.MAX_SAFE_INTEGER) {
  if (!await tripAccess(actor, tripId)) throw new RequestError('You do not have access to this holiday.', 403);
  // Bound both the row count and cumulative snapshot bytes before materializing
  // JSON. A page may contain fewer than 50 particularly large changes.
  const result = await db().prepare(`
    WITH candidates AS (
      SELECT e.* FROM activity_events e JOIN trips t ON t.id = e.trip_id
      WHERE e.trip_id = ? AND e.sequence < ? AND ${ACCESS}
      ORDER BY e.sequence DESC LIMIT 50
    ), sized AS (
      SELECT *, SUM(length(CAST(COALESCE(before_data, '') AS BLOB)) + length(CAST(COALESCE(after_data, '') AS BLOB)) + 2048)
        OVER (ORDER BY sequence DESC ROWS UNBOUNDED PRECEDING) AS export_bytes FROM candidates
    )
    SELECT * FROM sized WHERE export_bytes <= ? ORDER BY sequence DESC
  `).bind(tripId, before, actor, actor, MAX_SNAPSHOT_BYTES).all<EventRow>();
  const rows = result.results;
  const last = rows.at(-1)?.sequence ?? before;
  const remaining = await db().prepare(`SELECT e.sequence FROM activity_events e JOIN trips t ON t.id = e.trip_id WHERE e.trip_id = ? AND e.sequence < ? AND ${ACCESS} LIMIT 1`).bind(tripId, last, actor, actor).first<{ sequence: number }>();
  if (!rows.length && remaining) throw new RequestError('This history entry is too large to download as a page.', 413);
  return {
    events: rows.map(row => ({ id: row.id, sequence: row.sequence, tripId: row.trip_id, actorId: row.actor_id, actorName: row.actor_name, createdAt: utc(row.created_at), entityType: row.entity_type, entityId: row.entity_id, action: row.action, before: row.before_data ? JSON.parse(row.before_data) : null, after: row.after_data ? JSON.parse(row.after_data) : null, revision: row.revision, source: row.source })),
    nextCursor: remaining ? last : null,
  };
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    if ((origin !== null && origin !== url.origin) || request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') {
      throw new RequestError('Download your data from within TripTab.', 403);
    }
    const actor = await owner(request);
    const profile = await db().prepare('SELECT id, email, display_name, created_at FROM profiles WHERE id = ?').bind(actor).first<ProfileRow>();
    if (!profile) throw new RequestError('Open your TripTab profile before exporting.', 404);
    const params = url.searchParams;
    const allowed = new Set(['scope', 'format', 'tripId', 'before', 'receipts']);
    for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) throw new RequestError('Choose one value for each export option.');
    for (const key of ['scope', 'format', 'tripId']) if (params.has(key) && !params.get(key)) throw new RequestError('Choose a value for each export option.');
    const scope = params.get('scope') || 'account';
    const format = params.get('format') || 'json';
    const tripId = params.get('tripId') || undefined;
    const cursor = params.get('before');
    const includeReceipts = params.get('receipts');
    if (!['account', 'trip', 'activity'].includes(scope) || !['json', 'csv'].includes(format)) throw new RequestError('Choose an account, holiday or history export in JSON or CSV.');
    if (scope === 'account' && (tripId !== undefined || format !== 'json')) throw new RequestError('Account exports use JSON. Choose a holiday for CSV.');
    if (scope !== 'account' && (!tripId || tripId.length > 100)) throw new RequestError('Choose a holiday to export.');
    if (cursor !== null && (scope !== 'activity' || !/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) throw new RequestError('Choose a valid history cursor.');
    if (includeReceipts !== null && (!['0', '1'].includes(includeReceipts) || scope !== 'trip' || format !== 'json')) throw new RequestError('Receipt metadata is an option for holiday JSON exports.');
    const exportedAt = new Date().toISOString();
    const ownProfile = { id: profile.id, email: profile.email, displayName: profile.display_name, createdAt: utc(profile.created_at) };
    let body: string;
    let nextCursor: number | null = null;
    if (scope === 'activity') {
      const page = await activity(actor, tripId!, cursor === null ? undefined : Number(cursor));
      nextCursor = page.nextCursor;
      body = format === 'json' ? JSON.stringify({ schemaVersion: 1, exportedAt, tripId, ...page }) : csv([
        ['event_id', 'sequence', 'trip_id', 'actor_id', 'actor_name', 'created_at_utc', 'entity_type', 'entity_id', 'action', 'revision', 'source', 'before_json', 'after_json'],
        ...page.events.map(event => [event.id, event.sequence, event.tripId, event.actorId, event.actorName, event.createdAt, event.entityType, event.entityId, event.action, event.revision, event.source, event.before ? JSON.stringify(event.before) : '', event.after ? JSON.stringify(event.after) : '']),
      ]);
    } else {
      const trips = await snapshots(actor, tripId);
      if (scope === 'trip' && !trips.length) throw new RequestError('You do not have access to this holiday.', 403);
      const receiptMetadata = includeReceipts === '1' ? (await db().prepare(`
        SELECT r.id, r.trip_id FROM receipts r JOIN trips t ON t.id = r.trip_id
        WHERE r.trip_id = ? AND r.state = 'active' AND ${ACCESS} AND r.id IN (
          SELECT json_extract(j.value, '$.receiptId') FROM json_each(t.data, '$.expenses') j
          UNION SELECT json_extract(j.value, '$.receiptId') FROM json_each(t.data, '$.drafts') j
        ) ORDER BY r.id LIMIT 1100
      `).bind(tripId!, actor, actor).all<{ id: string; trip_id: string }>()).results.map(row => ({ id: row.id, tripId: row.trip_id })) : undefined;
      body = format === 'json' ? JSON.stringify({ schemaVersion: 1, exportedAt, amountScale: 100, profile: ownProfile, data: { trips }, ...(receiptMetadata ? { receiptMetadata } : {}) }) : financialCsv(trips[0]);
    }
    if (new TextEncoder().encode(body).byteLength > MAX_DOWNLOAD_BYTES) throw new RequestError('This export is too large. Choose a smaller holiday or history page.', 413);
    const safeId = tripId?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60);
    const filename = `triptab-${scope}${safeId ? `-${safeId}` : ''}-${exportedAt.slice(0, 10)}.${format}`;
    return new Response(body, { headers: {
      ...PRIVATE_HEADERS, 'Content-Type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`, 'X-Exported-At': exportedAt,
      ...(nextCursor === null ? {} : { 'X-Export-Next-Cursor': String(nextCursor) }),
    } });
  } catch (cause) {
    const response = failure(cause);
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(PRIVATE_HEADERS)) headers.set(key, value);
    return new Response(response.body, { status: response.status, headers });
  }
}
