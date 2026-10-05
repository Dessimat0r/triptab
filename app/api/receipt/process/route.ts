import { canonicalJson, sha256Hex } from '@/lib/data-utils';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { bucket, db, ensureProfile, failure, readBoundedBody, readLedger, receiptAccess, receiptKey, RequestError, sameOrigin, writeLedger } from '@/lib/store';
import { getReceiptAIAccess, ReceiptAIAccessError, type ReceiptAIEnvironment } from '@/lib/receipt-ai-access';
import { applyReceiptTranscription, consumeReceiptProcessBudget, processReceiptImage, ReceiptAIError } from '@/lib/receipt-ai';

export const dynamic = 'force-dynamic';
const id = z.string().min(1).max(100);
const requestSchema = z.object({ tripId: id, draftId: id, receiptId: id.regex(/^[-a-z0-9]+$/i),
  // Cached clients may still send this global counter. Only the required draft
  // fingerprint fences inference; this compatibility value never decides it.
  revision: z.number().int().min(0).optional(), draftHash: z.string().regex(/^[a-f0-9]{64}$/),
  questionId: id.optional(), readPurchaseDetails: z.boolean().optional() }).strict();

export async function POST(request: Request) {
  try {
    sameOrigin(request);
    if (request.headers.get('sec-fetch-site') === 'cross-site') throw new RequestError('Open TripTab to process this receipt.', 403);
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new RequestError('Send a JSON receipt-processing request.', 415);
    const profile = await ensureProfile(request);
    const bytes = await readBoundedBody(request, 2048);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new RequestError('Invalid receipt-processing request.'); }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) throw new RequestError('Reload TripTab and open the saved receipt again before processing it. A current receipt fingerprint is required.');
    const values = parsed.data;
    if (values.questionId) throw new RequestError('Use your connected ChatGPT tools to answer receipt questions or change item shares. This action only transcribes the receipt image.');
    const ledger = await readLedger(profile.id);
    const trip = ledger.data.trips.find(value => value.id === values.tripId);
    const draft = trip?.drafts.find(value => value.id === values.draftId);
    if (!trip || !draft) throw new RequestError('Receipt draft not found in your holidays.', 404);
    if (await sha256Hex(canonicalJson(draft)) !== values.draftHash) throw new RequestError('This receipt changed. Refresh before processing it.', 409);
    if (draft.receiptId !== values.receiptId) throw new RequestError('This receipt changed. Refresh before processing it.', 409);
    if ((draft.conversation?.length ?? 0) >= 100) throw new RequestError('This receipt conversation has reached its limit of 100 messages.');
    const access = await receiptAccess(profile.id, values.receiptId);
    if (!access || access.tripId !== trip.id) throw new RequestError('This receipt image is unavailable.', 404);
    const object = await bucket().get(receiptKey(access.owner, values.receiptId));
    const mimeType = object?.httpMetadata?.contentType;
    if (!object || !mimeType || !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new RequestError('This receipt image is unavailable.', 404);
    if (object.size > 5 * 1024 * 1024) throw new RequestError('Use a receipt image no larger than 5 MB.', 413);
    const image = new Uint8Array(await object.arrayBuffer());
    if (!image.length || image.byteLength > 5 * 1024 * 1024) throw new RequestError('Use a receipt image no larger than 5 MB.', 413);
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]);
    const database = db();
    const connection = await getReceiptAIAccess(request, profile, database, env as unknown as ReceiptAIEnvironment);
    await consumeReceiptProcessBudget(database, profile.id, { provider: connection.provider });
    const transcription = await processReceiptImage({
      ...connection, trip, draft, callerMemberId: trip.members.find(member => member.userId === profile.id)?.id ?? null,
      questionId: values.questionId, image: { bytes: image, mimeType },
    }, { signal });
    // An unrelated ledger edit does not invalidate a paid transcription. Rebase
    // only onto an unchanged source draft and member context, always retaining
    // the latest other entries. Every CAS retry repeats the access checks;
    // inference itself runs once.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted) throw new RequestError('Receipt processing was cancelled or timed out. Your saved receipt is unchanged.', 408);
      if ((await ensureProfile(request)).id !== profile.id) throw new RequestError('Your signed-in account changed. Open this receipt again.', 409);
      const latest = await readLedger(profile.id);
      const currentTrip = latest.data.trips.find(value => value.id === trip.id);
      const currentDraft = currentTrip?.drafts.find(value => value.id === draft.id);
      const currentAccess = await receiptAccess(profile.id, values.receiptId);
      if (!currentTrip || !currentDraft || JSON.stringify(currentDraft) !== JSON.stringify(draft)
        || currentTrip.ownerId !== trip.ownerId || JSON.stringify(currentTrip.members) !== JSON.stringify(trip.members)
        || !currentAccess || currentAccess.tripId !== trip.id || currentAccess.owner !== access.owner) {
        throw new RequestError('This receipt changed during processing. Refresh before trying again.', 409);
      }
      const currentImage = await bucket().head(receiptKey(access.owner, values.receiptId));
      if (!currentImage || currentImage.version !== object.version || currentImage.size !== object.size
        || currentImage.httpMetadata?.contentType !== mimeType) {
        throw new RequestError('This receipt image changed during processing. Refresh before trying again.', 409);
      }
      const tripSnapshot = structuredClone(currentTrip);
      const proposal = applyReceiptTranscription(currentTrip, currentDraft, transcription, undefined, { readPurchaseDetails: values.readPurchaseDetails });
      currentTrip.drafts[currentTrip.drafts.findIndex(value => value.id === proposal.id)] = proposal;
      try {
        const saved = await writeLedger(profile.id, { trips: [currentTrip] }, latest.revision, { source: 'web', tripSnapshot });
        const savedDraft = saved.data.trips.find(value => value.id === trip.id)?.drafts.find(value => value.id === draft.id);
        return Response.json({ ...saved, draft: savedDraft }, { headers: { 'Cache-Control': 'private, no-store' } });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'CONFLICT') throw error;
      }
    }
    throw new RequestError('Your ledger kept changing during processing. Refresh before trying again.', 409);
  } catch (error) {
    if (error instanceof ReceiptAIError || error instanceof ReceiptAIAccessError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
    }
    return failure(error);
  }
}
