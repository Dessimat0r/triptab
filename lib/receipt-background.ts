import { db } from './store';
import { receiptAICredential, ReceiptAIAccessError, type ReceiptAIEnvironment } from './receipt-ai-access';
import { BACKGROUND_TIMEOUT_MS, claimResume, finishOperation, interruptedOperations, operationFence } from './receipt-operations';
import { errorCategory, executeOperation, loadOperationSource, logOperation, type OperationLog } from './receipt-operation-work';

/**
 * R07: finish receipt readings that the platform cut off after the browser
 * went away, without any browser request.
 *
 * A browser request's reading may outlive its request only for the platform's
 * post-disconnect grace period (Workers waitUntil: 30 s). If it is cut off,
 * no outcome is recorded and its lease runs out. This runner, invoked by the
 * scheduled handler (a Cron Trigger invocation may run for up to 15 minutes),
 * then takes the operation over once and runs the same work as the request
 * would have, under the person's stored execution grant:
 *
 * - the source is read afresh and must still be the person's unchanged draft
 *   and the same stored photo version; membership, bill deletion, account
 *   deletion, sign-out and session expiry all stop it (before spending when
 *   they happen first, and inside the commit otherwise);
 * - credentials come from server storage (the shared key, or the person's own
 *   stored ChatGPT plan connection); a removed key, disabled plan or a switch
 *   to a different credential kind fails it before the provider call;
 * - it commits through the same fenced, atomic save (R12), so a late, duplicate
 *   or superseded attempt never adds a second result.
 *
 * It never retries a failed operation, a persistence conflict or a lost
 * commit, and resumes an interrupted one at most MAX_AUTO_RESUMES times.
 * Overlapping invocations claim each operation atomically: one runs it.
 */
export async function runReceiptOperationTick(environment: ReceiptAIEnvironment, options: { now?: number; limit?: number } = {}) {
  const database = db();
  const now = options.now ?? Date.now();
  const candidates = await interruptedOperations(database, now, options.limit ?? 3);
  const result = { resumed: 0, skipped: 0, stored: 0, failed: 0 };
  await Promise.all(candidates.map(async candidate => {
    const claim = await claimResume(database, candidate.key, { now });
    if (!claim.owned) { result.skipped++; return; }
    result.resumed++;
    const log: OperationLog = { attemptId: claim.attemptId, tripId: candidate.request.tripId, draftId: candidate.request.draftId,
      receiptId: candidate.request.receiptId, runner: 'background' };
    logOperation('native-processing-resumed', log, { attempts: claim.attempts });
    const signal = AbortSignal.timeout(BACKGROUND_TIMEOUT_MS);
    try {
      const source = await loadOperationSource(candidate.userId, candidate.request, { imageVersion: candidate.request.imageVersion });
      if (source.answered) throw new ReceiptAIAccessError('This question was already answered.', 409, 'already-answered');
      await executeOperation({ userId: candidate.userId, request: candidate.request, source, fence: operationFence(claim), log, signal,
        credential: async () => {
          const connection = await receiptAICredential(database, environment, candidate.userId, { signal });
          // The person asked for a reading paid by one credential kind; never
          // switch who pays without them asking again.
          if (candidate.provider && connection.provider !== candidate.provider) {
            throw new ReceiptAIAccessError('Receipt processing settings changed before this reading finished. Read the receipt again.', 409, 'credentials_changed');
          }
          return connection;
        } });
      result.stored++;
    } catch (error) {
      result.failed++;
      await finishOperation(database, claim.key, claim.attemptId, 'failed', { errorCode: errorCategory(error) }).catch(() => {});
      logOperation('native-processing-failed', log, { category: errorCategory(error) });
    }
  }));
  return result;
}
