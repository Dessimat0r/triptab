import { requestWriteAuthorizationSql, type RequestWriteAuthorization } from './auth';
import { ReceiptAIAccessError, type receiptAICredential } from './receipt-ai-access';
import { providerCredentialSql } from './receipt-operations';
import type { ProviderRequestGuard } from './receipt-ai';

type Connection = Awaited<ReturnType<typeof receiptAICredential>>;

/** The same pre-spend cutoff for receipt language requests, which save no job. */
export function receiptRequestGuard(input: {
  database: D1Database; userId: string; authorization: RequestWriteAuthorization;
  connection: Connection; credential: () => Promise<Connection>; tripId?: string;
}): ProviderRequestGuard {
  return async (_url, request) => {
    const connection = await input.credential();
    if (connection.provider !== input.connection.provider || connection.model !== input.connection.model
      || connection.provider === 'api' && connection.accessToken !== input.connection.accessToken) {
      throw new ReceiptAIAccessError('Receipt processing settings changed. Open the receipt and try again.', 409, 'credentials_changed');
    }
    const authorization = requestWriteAuthorizationSql(input.authorization, input.userId);
    const credential = providerCredentialSql(connection, input.userId, connection.provider);
    const source = input.tripId ? `EXISTS (SELECT 1 FROM trips translation_trip WHERE translation_trip.id=?
      AND translation_trip.owner NOT LIKE 'deleted:%' AND (translation_trip.owner=?
        OR EXISTS(SELECT 1 FROM memberships translation_member WHERE translation_member.trip_id=translation_trip.id AND translation_member.user_id=?)))` : '1';
    // One database-time snapshot after quota, model discovery and token refresh.
    // No asynchronous preparation follows this permission decision.
    const admitted = await input.database.prepare(`SELECT 1 AS ok WHERE ${authorization.condition} AND ${credential.condition} AND ${source}`)
      .bind(...authorization.bindings, ...credential.bindings, ...(input.tripId ? [input.tripId, input.userId, input.userId] : [])).first();
    if (!admitted) throw new ReceiptAIAccessError('Your sign-in, bill access or receipt settings changed. Open the receipt and try again.', 409, 'authorization_changed');
    const headers = new Headers(request.headers);
    headers.set('Authorization', `Bearer ${connection.accessToken}`);
    request.headers = headers;
  };
}
