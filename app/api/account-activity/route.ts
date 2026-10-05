import { ensureProfile, db, failure, RequestError } from '@/lib/store';
import { readAccountActivity } from '@/lib/audit';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const profile = await ensureProfile(request);
    const params = new URL(request.url).searchParams;
    for (const key of params.keys()) {
      if (!['before', 'limit'].includes(key) || params.getAll(key).length !== 1) throw new RequestError('Choose a valid account history page.');
    }
    const number = (key: string) => {
      const value = params.get(key);
      if (value === null) return undefined;
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new RequestError('Choose a valid account history page.');
      return Number(value);
    };
    const before = number('before'), limit = number('limit');
    if (limit !== undefined && limit > 50) throw new RequestError('Choose an account history page size between 1 and 50.');
    return Response.json(await readAccountActivity(db(), profile.id, { before, limit }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) { return failure(error); }
}
