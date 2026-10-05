import { db, ensureProfile, failure, owner, RequestError, tripAccess } from '@/lib/store';

export const dynamic = 'force-dynamic';

const CHUNK_CHARACTERS = 128 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const ACCESS = '(t.owner = ? OR EXISTS (SELECT 1 FROM memberships m WHERE m.trip_id = t.id AND m.user_id = ?))';
type Metadata = {
  id: string; sequence: number; tripId: string; actorId: string; actorName: string;
  createdAt: string; entityType: string; entityId: string; action: string; revision: number; source: string;
  beforeCharacters: number; afterCharacters: number; snapshotBytes: number;
};

/** Download the original shared audit entry without loading large snapshots into memory. */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    if ((origin !== null && origin !== url.origin) || request.headers.get('sec-fetch-site')?.toLowerCase() === 'cross-site') throw new RequestError('Open history downloads from within TripTab.', 403);
    const params = url.searchParams;
    if (params.getAll('tripId').length !== 1 || params.getAll('eventId').length !== 1
      || [...params.keys()].some(key => !['tripId', 'eventId'].includes(key))) throw new RequestError('Choose a history entry.');
    const tripId = params.get('tripId')!, eventId = params.get('eventId')!;
    if (!tripId || tripId.length > 100 || !eventId || eventId.length > 100) throw new RequestError('Choose a history entry.');
    const actor = (await ensureProfile(request)).id;
    const database = db();
    // Access is part of the entry lookup: foreign IDs do not reveal whether an
    // event or holiday exists. Account events cannot enter this trip-only route.
    const row = await database.prepare(`
      SELECT e.id, e.sequence, e.trip_id AS tripId, e.actor_id AS actorId, e.actor_name AS actorName,
        e.created_at AS createdAt, e.entity_type AS entityType, e.entity_id AS entityId, e.action, e.revision, e.source,
        length(COALESCE(e.before_data, '')) AS beforeCharacters, length(COALESCE(e.after_data, '')) AS afterCharacters,
        length(CAST(COALESCE(e.before_data, '') AS BLOB)) + length(CAST(COALESCE(e.after_data, '') AS BLOB)) AS snapshotBytes
      FROM activity_events e JOIN trips t ON t.id = e.trip_id
      WHERE e.trip_id = ? AND e.id = ? AND ${ACCESS}
    `).bind(tripId, eventId, actor, actor).first<Metadata>();
    if (!row) throw new RequestError('This shared history entry is unavailable to your account.', 404);
    if (row.snapshotBytes > MAX_ENTRY_BYTES) throw new RequestError('This legacy history entry exceeds the safe download limit. Its saved history has been retained.', 413);
    const { beforeCharacters, afterCharacters, snapshotBytes: _, ...metadata } = row;
    void _;
    const encoder = new TextEncoder();
    let stage = 0, offset = 1, cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (cancelled || request.signal.aborted) throw Error('History download cancelled.');
          // Resolve the current session and membership at every chunk. Revoked
          // access stops the stream rather than emitting the remaining evidence.
          if (await owner(request) !== actor) throw Error('History access changed.');
          if (stage === 0) {
            if (!await tripAccess(actor, tripId)) throw Error('History access changed.');
            controller.enqueue(encoder.encode(JSON.stringify(metadata).slice(0, -1) + ',"before":'));
            stage = 1; return;
          }
          const before = stage === 1;
          const characters = before ? beforeCharacters : afterCharacters;
          const column = before ? 'before_data' : 'after_data';
          const part = await database.prepare(`
            SELECT substr(COALESCE(NULLIF(e.${column}, ''), 'null'), ?, ?) AS chunk
            FROM activity_events e JOIN trips t ON t.id = e.trip_id
            WHERE e.trip_id = ? AND e.id = ? AND ${ACCESS}
          `).bind(offset, CHUNK_CHARACTERS, tripId, eventId, actor, actor).first<{ chunk: string }>();
          if (!part) throw Error('History access changed.');
          controller.enqueue(encoder.encode(part.chunk));
          offset += CHUNK_CHARACTERS;
          if (offset > characters) {
            if (before) { controller.enqueue(encoder.encode(',"after":')); stage = 2; offset = 1; }
            else { controller.enqueue(encoder.encode('}')); controller.close(); }
          }
        } catch {
          // Never forward database exceptions, tokens or private resource keys.
          controller.error(Error('This history download could not complete. Refresh your access and try again.'));
        }
      },
      cancel() { cancelled = true; },
    });
    const safeId = eventId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'entry';
    return new Response(stream, { headers: {
      'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="triptab-shared-history-${safeId}.json"`,
      'Cache-Control': 'private, no-store', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) { return failure(error); }
}
