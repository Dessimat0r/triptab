import { ensureProfile, failure, readActivity, RequestError } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const profile = await ensureProfile(request);
    const params = new URL(request.url).searchParams;
    const allowed = new Set(['tripId', 'before', 'limit', 'expenseId', 'draftId']);
    if (params.getAll('tripId').length !== 1 || [...params.keys()].some(key => !allowed.has(key) || params.getAll(key).length !== 1)
      || (params.has('expenseId') && params.has('draftId'))) {
      throw new RequestError('Choose a valid activity page.');
    }
    const number = (key: string) => {
      const value = params.get(key);
      if (value === null) return undefined;
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new RequestError('Choose a valid activity page.');
      return Number(value);
    };
    const entryId = (key: string) => {
      const value = params.get(key);
      if (value === null) return undefined;
      if (!value || value.length > 100) throw new RequestError('Choose a valid receipt history.');
      return value;
    };
    const result = await readActivity(profile.id, params.get('tripId') || '', { before: number('before'), limit: number('limit'), expenseId: entryId('expenseId'), draftId: entryId('draftId') });
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return failure(error);
  }
}
