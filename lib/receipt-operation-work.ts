import { canonicalJson, sha256Hex } from './data-utils';
import { bucket, db, OperationSupersededError, OperationUnauthorizedError, readLedger, receiptAccess, receiptKey, RequestError, writeLedger } from './store';
import { ReceiptAIAccessError } from './receipt-ai-access';
import { applyReceiptTranscription, consumeReceiptProcessBudget, processReceiptImage, ReceiptAIError, type ProviderRequestGuard } from './receipt-ai';
import { readTripLanguagePreferences } from './trip-language-preferences';
import { applyReceiptQuestion, processReceiptQuestion } from './receipt-assistant';
import { holdsOperation, operationAuthorized, startProviderCall, type OperationCredential, type OperationFence, type OperationProvider, type OperationSource } from './receipt-operations';
import type { Draft, Ledger, Trip } from './model';
import { notifyReceiptReady } from './notifications';

/**
 * One paid receipt operation's work (R06/R07/R12), shared by the browser
 * request (app/api/receipt/process) and the background runner
 * (lib/receipt-background.ts), so both run the same authorization, source,
 * spend and commit rules. Inference runs once per attempt; persistence
 * conflicts rebase onto the latest ledger without calling the provider again.
 */
export type ReceiptImage = { bytes: Uint8Array; mimeType: string; owner: string; version: string; size: number };
export type LoadedSource = { ledger: { data: Ledger; revision: number }; trip: Trip; draft: Draft; image?: ReceiptImage; answered: boolean };
export type ReceiptConnection = { accessToken: string; model?: string; provider: OperationProvider; settingsOwnerId?: string; settingsVersion?: number; connectionVersion?: number };
const credentialFence = (connection: ReceiptConnection): OperationCredential | undefined => connection.settingsOwnerId && connection.settingsVersion !== undefined
  ? { settingsOwnerId: connection.settingsOwnerId, settingsVersion: connection.settingsVersion, connectionVersion: connection.connectionVersion } : undefined;
export type OperationLog = { attemptId: string; tripId: string; draftId: string; receiptId?: string; runner: 'request' | 'background' };

export const errorCategory = (error: unknown) => error instanceof ReceiptAIError || error instanceof ReceiptAIAccessError ? error.code
  : error instanceof OperationSupersededError ? 'superseded' : error instanceof OperationUnauthorizedError ? 'authorization-ended'
  : error instanceof RequestError && error.status === 409 ? 'ledger-changed' : error instanceof RequestError && error.status === 408 ? 'timed-out'
  : error instanceof RequestError && (error.status === 403 || error.status === 404) ? 'source-unavailable' : 'processing-failed';

export function logOperation(event: string, operation: OperationLog, details: Record<string, string | number | undefined> = {}) {
  // Legacy/imported IDs can contain user text. Keep operational tokens only;
  // receipt contents, account emails and provider secrets never enter logs.
  const ids = Object.fromEntries(Object.entries(operation).filter(([, value]) => typeof value === 'string' && /^[-a-zA-Z0-9_]{1,100}$/.test(value)));
  console.info('TripTab receipt operation', { event, ...ids, ...details });
}

/**
 * The person's current, authorized source for an operation, read afresh. The
 * background runner passes the stored photo version: a replaced photo is a
 * different operation and is never read in its place.
 */
export async function loadOperationSource(userId: string, request: OperationSource, options: { imageVersion?: string } = {}): Promise<LoadedSource> {
  const ledger = await readLedger(userId);
  const trip = ledger.data.trips.find(value => value.id === request.tripId);
  const draft = trip?.drafts.find(value => value.id === request.draftId);
  if (!trip || !draft) throw new RequestError('Receipt draft not found in your holidays.', 404);
  if (await sha256Hex(canonicalJson(draft)) !== request.draftHash) throw new RequestError('This receipt changed. Refresh before processing it.', 409);
  if (draft.receiptId !== request.receiptId) throw new RequestError('This receipt changed. Refresh before processing it.', 409);
  if (request.questionId && !draft.conversation?.some(message => message.id === request.questionId && message.role === 'user')) throw new RequestError('Choose a saved question from this receipt.');
  if (request.questionId && draft.conversation?.some(message => message.replyTo === request.questionId && message.role === 'assistant')) return { ledger, trip, draft, answered: true };
  if ((draft.conversation?.length ?? 0) >= 100) throw new RequestError('This receipt conversation has reached its limit of 100 messages.');
  let image: ReceiptImage | undefined;
  if (!request.questionId) {
    if (!request.receiptId) throw new RequestError('Save a receipt photo before reading it.');
    const access = await receiptAccess(userId, request.receiptId);
    if (!access || access.tripId !== trip.id) throw new RequestError('This receipt image is unavailable.', 404);
    const object = await bucket().get(receiptKey(access.owner, request.receiptId));
    const mimeType = object?.httpMetadata?.contentType;
    if (!object || !mimeType || !['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) throw new RequestError('This receipt image is unavailable.', 404);
    if (options.imageVersion && object.version !== options.imageVersion) {
      await object.body.cancel().catch(() => {});
      throw new RequestError('This receipt image changed. Refresh before processing it.', 409);
    }
    if (object.size > 5 * 1024 * 1024) throw new RequestError('Use a receipt image no larger than 5 MB.', 413);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (!bytes.length || bytes.byteLength > 5 * 1024 * 1024) throw new RequestError('Use a receipt image no larger than 5 MB.', 413);
    image = { bytes, mimeType, owner: access.owner, version: object.version, size: object.size };
  }
  return { ledger, trip, draft, image, answered: false };
}

/** Why an attempt may no longer act, checked before any spend. */
async function refusal(fence: OperationFence, userId: string) {
  const database = db();
  if (!await holdsOperation(database, fence.key, fence.attemptId)) return new OperationSupersededError();
  if (!await operationAuthorized(database, fence, userId)) return new OperationUnauthorizedError();
  return undefined;
}

export async function executeOperation(input: {
  userId: string; request: OperationSource; source: LoadedSource; fence: OperationFence; log: OperationLog;
  credential: () => Promise<ReceiptConnection>;
  /** The browser request's own account check; the background runner relies on the grant. */
  stillCurrent?: () => Promise<void>;
  signal: AbortSignal;
}) {
  const { userId, request, fence, signal } = input;
  const { trip, draft, image } = input.source;
  const database = db();
  const currentSource = async () => {
    const latest = await readLedger(userId);
    const currentTrip = latest.data.trips.find(value => value.id === trip.id);
    const currentDraft = currentTrip?.drafts.find(value => value.id === draft.id);
    const currentAccess = image && request.receiptId ? await receiptAccess(userId, request.receiptId) : undefined;
    if (!currentTrip || !currentDraft || JSON.stringify(currentDraft) !== JSON.stringify(draft)
      || currentTrip.ownerId !== trip.ownerId || currentTrip.receiptLanguage !== trip.receiptLanguage || JSON.stringify(currentTrip.members) !== JSON.stringify(trip.members)
      || image && (!currentAccess || currentAccess.tripId !== trip.id || currentAccess.owner !== image.owner)) {
      throw new RequestError('This receipt changed during processing. Refresh before trying again.', 409);
    }
    if (image && request.receiptId) {
      const currentImage = await bucket().head(receiptKey(image.owner, request.receiptId));
      if (!currentImage || currentImage.version !== image.version || currentImage.size !== image.size
        || currentImage.httpMetadata?.contentType !== image.mimeType) throw new RequestError('This receipt image changed during processing. Refresh before trying again.', 409);
    }
    return { latest, currentTrip, currentDraft };
  };
  // Nothing is spent for an attempt that was superseded or whose grant ended.
  const refused = await refusal(fence, userId);
  if (refused) throw refused;
  const { preferences: { readingLanguage } } = await readTripLanguagePreferences(database, userId, trip.id);
  const connection = await input.credential();
  if (!await startProviderCall(database, fence, userId, connection.provider, Date.now(), credentialFence(connection))) {
    throw await refusal(fence, userId) ?? new ReceiptAIAccessError('Receipt processing settings changed before this reading started. Read the receipt again.', 409, 'credentials_changed');
  }
  await consumeReceiptProcessBudget(database, userId, { provider: connection.provider });
  const beforeRequest: ProviderRequestGuard = async (_url, requestInit) => {
    if (signal.aborted) throw new RequestError('Receipt processing was cancelled or timed out. Your saved receipt is unchanged.', 408);
    // Quota consumption, credential/model preparation and model discovery can
    // yield. Recheck at the actual outbound boundary, including again after a
    // ChatGPT model-list response, rather than treating admission as a spend.
    const refused = await refusal(fence, userId);
    if (refused) throw refused;
    await input.stillCurrent?.();
    const currentConnection = await input.credential();
    if (currentConnection.provider !== connection.provider || currentConnection.model !== connection.model
      || connection.provider === 'api' && currentConnection.accessToken !== connection.accessToken) {
      throw new ReceiptAIAccessError('Receipt processing settings changed before this reading started. Read the receipt again.', 409, 'credentials_changed');
    }
    // A normal plan-token refresh is supported. Use its current token, then
    // fence that exact stored connection/settings version at final admission.
    const headers = new Headers(requestInit.headers);
    headers.set('Authorization', `Bearer ${currentConnection.accessToken}`);
    requestInit.headers = headers;
    await currentSource();
    if (!await startProviderCall(database, fence, userId, connection.provider, Date.now(), credentialFence(currentConnection))) {
      throw await refusal(fence, userId) ?? new ReceiptAIAccessError('Receipt processing settings changed before this reading started. Read the receipt again.', 409, 'credentials_changed');
    }
  };
  logOperation('native-processing-started', input.log, { provider: connection.provider });
  const context = { ...connection, trip, draft, readingLanguage, callerMemberId: trip.members.find(member => member.userId === userId)?.id ?? null };
  const answer = request.questionId ? await processReceiptQuestion({ ...context, questionId: request.questionId }, { signal, beforeRequest }) : undefined;
  const transcription = image ? await processReceiptImage({ ...context, image }, { signal, beforeRequest }) : undefined;
  // An unrelated ledger edit does not invalidate a paid transcription. Rebase
  // only onto an unchanged source draft and member context, always retaining
  // the latest other entries. Every CAS retry repeats the access checks;
  // inference itself runs once.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw new RequestError('Receipt processing was cancelled or timed out. Your saved receipt is unchanged.', 408);
    await input.stillCurrent?.();
    const { latest, currentTrip, currentDraft } = await currentSource();
    const tripSnapshot = structuredClone(currentTrip);
    const proposal = answer && request.questionId ? applyReceiptQuestion(currentTrip, currentDraft, answer, request.questionId) : applyReceiptTranscription(currentTrip, currentDraft, transcription!, undefined, {
      readingLanguage, readPurchaseDetails: request.readPurchaseDetails, attemptId: fence.attemptId,
      processedAt: new Date().toISOString(), processor: connection.provider === 'api' ? 'native-api' : 'native-siwc',
      imageIds: request.receiptId ? [request.receiptId] : [],
    });
    currentTrip.drafts[currentTrip.drafts.findIndex(value => value.id === proposal.id)] = proposal;
    // R06/R12: a superseded attempt (its claim was taken over after its
    // lease ran out) never commits; the newer attempt owns the result.
    // Ownership and the grant are decided inside the commit's own D1
    // transaction, which also records the operation as stored, so no
    // takeover or sign-out can land between a check and the write.
    try {
      const saved = await writeLedger(userId, { trips: [currentTrip] }, latest.revision, { source: 'web', tripSnapshot, operation: fence });
      const savedDraft = saved.data.trips.find(value => value.id === trip.id)?.drafts.find(value => value.id === draft.id);
      logOperation('native-proposal-stored', input.log, {
        status: savedDraft?.receiptScan?.status, lineCount: savedDraft?.items.length ?? 0, revision: saved.revision });
      // N05: the optional "receipt ready" notice, decided from the operation's
      // persisted `stored` state (written by the commit above), never from the
      // request or a disconnect signal. The same call serves the browser's own
      // request and the background runner, and it inserts at most one notice
      // per operation. It can never fail the save: the result is already committed.
      await notifyReceiptReady({ userId, tripId: trip.id, operationKey: fence.key })
        .catch(() => { console.warn('TripTab could not queue a receipt-ready notification.'); });
      return { saved, savedDraft };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'CONFLICT') throw error;
    }
  }
  throw new RequestError('Your ledger kept changing during processing. Refresh before trying again.', 409);
}
