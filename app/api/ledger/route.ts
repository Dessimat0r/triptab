import { readLedger, writeLedger, sameOrigin, failure, readBoundedBody, ensureProfile } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET(r: Request) {
  try {
    const profile = await ensureProfile(r);
    return Response.json(await readLedger(profile.id), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    return failure(e);
  }
}

export async function POST(r: Request) {
  try {
    sameOrigin(r);
    const profile = await ensureProfile(r);
    const bytes = await readBoundedBody(r, 1_600_000);
    const body: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid ledger request');
    const fields = body as Record<string, unknown>;
    return Response.json(await writeLedger(profile.id, fields.data, fields.revision), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    return failure(e);
  }
}
