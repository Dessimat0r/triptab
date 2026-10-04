import { bucket, db } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Compilation of this read-only query also detects missing migrations.
    await db().prepare(`SELECT r.state, r.created_at, r.legacy_cleanup_after, e.sequence, m.message_data
      FROM receipts r CROSS JOIN activity_events e
      CROSS JOIN receipt_messages m INDEXED BY receipt_messages_trip_message_idx LIMIT 0`).all();
    const storage = bucket();
    if (typeof storage.get !== 'function' || typeof storage.put !== 'function' || typeof storage.delete !== 'function') throw Error('Missing receipt binding');
    return Response.json({ status: 'ready' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
