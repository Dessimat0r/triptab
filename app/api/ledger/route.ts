import { db, readLedger, writeLedger, sameOrigin, failure, readBoundedBody, ensureProfile } from '@/lib/store';
import { ledgerEtag } from '@/lib/ledger-freshness';

export const dynamic = 'force-dynamic';

export async function GET(r: Request) {
  try {
    const profile = await ensureProfile(r);
    const tag = await ledgerEtag(db(), profile.id);
    return Response.json(await readLedger(profile.id), { headers: { 'Cache-Control': 'private, no-store', ETag: tag } });
  } catch (e) {
    return failure(e);
  }
}

export async function HEAD(request: Request) {
  try {
    const profile = await ensureProfile(request);
    const tag = await ledgerEtag(db(), profile.id);
    return new Response(null, { status: request.headers.get('if-none-match') === tag ? 304 : 200, headers: { 'Cache-Control': 'private, no-store', ETag: tag } });
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
    return Response.json(await writeLedger(profile.id, fields.data, fields.revision), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    return failure(e);
  }
}
