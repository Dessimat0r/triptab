import { db, readLedgerSnapshot, writeLedger, sameOrigin, failure, readBoundedBody, ensureProfile } from '@/lib/store';
import { ledgerEtagForSnapshot, ledgerTagMatches, readLedgerFreshness } from '@/lib/ledger-freshness';

export const dynamic = 'force-dynamic';

export async function GET(r: Request) {
  try {
    const profile = await ensureProfile(r);
    const condition = r.headers.get('if-none-match');
    if (condition) {
      const current = await readLedgerFreshness(db(), profile.id);
      if (ledgerTagMatches(condition, current.etag)) return new Response(null, { status: 304,
        headers: { 'Cache-Control': 'private, no-store', ETag: current.etag, 'X-Ledger-Revision': String(current.revision) } });
    }
    // A changed conditional request takes a new complete snapshot: never attach
    // an earlier metadata tag to data that another writer changed in between.
    const { data, revision, freshness } = await readLedgerSnapshot(profile.id);
    const tag = await ledgerEtagForSnapshot(freshness);
    return Response.json({ data, revision }, { headers: { 'Cache-Control': 'private, no-store', ETag: tag, 'X-Ledger-Revision': String(revision) } });
  } catch (e) {
    return failure(e);
  }
}

export async function HEAD(request: Request) {
  try {
    const profile = await ensureProfile(request);
    const current = await readLedgerFreshness(db(), profile.id);
    return new Response(null, { status: ledgerTagMatches(request.headers.get('if-none-match'), current.etag) ? 304 : 200,
      headers: { 'Cache-Control': 'private, no-store', ETag: current.etag, 'X-Ledger-Revision': String(current.revision) } });
  } catch (error) {
    const result = failure(error);
    return new Response(null, { status: result.status, headers: result.headers });
  }
}

export async function POST(r: Request) {
  try {
    sameOrigin(r);
    const profile = await ensureProfile(r);
    const bytes = await readBoundedBody(r, 2_000_000);
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid ledger request');
    const fields = body as Record<string, unknown>;
    const { data, revision, freshness } = await writeLedger(profile.id, fields.data, fields.revision, { includeFreshness: true });
    const tag = await ledgerEtagForSnapshot(freshness!);
    return Response.json({ data, revision }, { headers: { 'Cache-Control': 'private, no-store', ETag: tag, 'X-Ledger-Revision': String(revision) } });
  } catch (e) {
    return failure(e);
  }
}
