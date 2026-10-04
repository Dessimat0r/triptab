import { ensureProfile, failure, readActivity, RequestError } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const profile = await ensureProfile(request);
    const params = new URL(request.url).searchParams;
    if (params.getAll('tripId').length !== 1 || ['before', 'limit'].some(key => params.getAll(key).length > 1)) {
      throw new RequestError('Choose a valid activity page.');
    }
    const number = (key: string) => {
      const value = params.get(key);
      if (value === null) return undefined;
      if (!/^[1-9]\d*$/.test(value)) throw new RequestError('Choose a valid activity page.');
      return Number(value);
    };
    const result = await readActivity(profile.id, params.get('tripId') || '', { before: number('before'), limit: number('limit') });
    return Response.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return failure(error);
  }
}
