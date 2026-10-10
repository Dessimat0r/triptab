import { owner, bucket, sameOrigin, failure, readBoundedBody, receiptKey, RequestError, ensureProfile, tripAccess, receiptAccess, db } from '@/lib/store';
import { storeReceipt, deleteReceipt, maintainReceipts } from '@/lib/receipt-lifecycle';

export const dynamic = 'force-dynamic';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const RECEIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function matchesImageType(bytes: Uint8Array, type: string) {
  const matches = (signature: number[], offset = 0) => signature.every((value, index) => bytes[offset + index] === value);
  if (type === 'image/jpeg') return bytes.length >= 4 && matches([0xff, 0xd8, 0xff]);
  if (type === 'image/png') return bytes.length >= 24 && matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && matches([0x49, 0x48, 0x44, 0x52], 12);
  if (type === 'image/webp') {
    if (bytes.length < 16 || !matches([0x52, 0x49, 0x46, 0x46]) || !matches([0x57, 0x45, 0x42, 0x50], 8)) return false;
    const declaredLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) + 8;
    return declaredLength === bytes.length && matches([0x56, 0x50, 0x38], 12) && [0x20, 0x4c, 0x58].includes(bytes[15]);
  }
  return false;
}

export async function POST(r: Request) {
  try {
    sameOrigin(r);
    const user = (await ensureProfile(r)).id;
    if (r.headers.get('X-TripTab-Account') && r.headers.get('X-TripTab-Account') !== user) throw new RequestError('Sign in to the account that captured this receipt.',409);
    const tripId = new URL(r.url).searchParams.get('tripId');
    if (!tripId || tripId.length > 100 || !await tripAccess(user, tripId)) throw new RequestError('Choose a trip you have access to.', 403);
    const type = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) throw new RequestError('Use a JPEG, PNG or WebP image.');
    const bytes = await readBoundedBody(r, MAX_IMAGE_BYTES);
    if (!matchesImageType(bytes, type)) throw new RequestError('This file is not a valid JPEG, PNG or WebP image.');
    await maintainReceipts(db(), bucket(), user).catch(() => {
      console.warn('TripTab receipt maintenance will retry.');
    });
    const id = crypto.randomUUID();
    await storeReceipt(db(), bucket(), user, tripId, id, bytes, type);
    return Response.json({ receiptId: id }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    return failure(e);
  }
}

export async function DELETE(r: Request) {
  try {
    sameOrigin(r);
    const user = (await ensureProfile(r)).id;
    if (r.headers.get('X-TripTab-Account') && r.headers.get('X-TripTab-Account') !== user) throw new RequestError('Sign in to the account that captured this receipt.',409);
    const params = new URL(r.url).searchParams;
    const id = params.get('id');
    if (params.getAll('id').length !== 1 || !id || !RECEIPT_ID.test(id)) throw new RequestError('Invalid receipt.');
    const result = await deleteReceipt(db(), bucket(), user, id);
    return Response.json(result, { status: result.pending ? 202 : 200, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (e) {
    return failure(e);
  }
}

export async function GET(r: Request) {
  try {
    const user = await owner(r);
    if (r.headers.get('X-TripTab-Account') && r.headers.get('X-TripTab-Account') !== user) throw new RequestError('Sign in to the account that captured this receipt.',409);
    const id = new URL(r.url).searchParams.get('id');
    if (!id || !RECEIPT_ID.test(id)) throw new RequestError('Invalid receipt.');
    const access = await receiptAccess(user, id);
    if (!access) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    const obj = await bucket().get(receiptKey(access.owner, id));
    if (!obj) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
    const type = obj.httpMetadata?.contentType;
    if (!type || !IMAGE_TYPES.has(type)) throw new RequestError('This receipt image is unavailable.');
    return new Response(obj.body, { headers: { 'Content-Type': type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (e) {
    return failure(e);
  }
}
