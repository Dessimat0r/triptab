import { bucket, db } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Compilation of this read-only query also detects missing migrations.
    await db().prepare(`SELECT r.state, r.created_at, r.legacy_cleanup_after, r.content_type, r.size_bytes, r.sha256,
      i.audit_id, p.generation, a.sequence, a.id, a.user_id, a.actor_name, a.created_at, a.entity_type,
      a.entity_id, a.action, a.before_data, a.after_data, a.source, e.sequence, m.message_data
      FROM receipts r CROSS JOIN activity_events e CROSS JOIN invites i CROSS JOIN push_subscriptions p
      CROSS JOIN account_activity_events a INDEXED BY account_activity_events_user_sequence_idx
      CROSS JOIN receipt_messages m INDEXED BY receipt_messages_trip_message_idx LIMIT 0`).all();
    const accountHistoryIndexes = ['account_activity_events_id_idx', 'account_activity_events_user_sequence_idx'];
    const indexes = await db().prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${accountHistoryIndexes.map(() => '?').join(',')})`)
      .bind(...accountHistoryIndexes).all<{ name: string }>();
    if (indexes.results.length !== accountHistoryIndexes.length) throw Error('Missing account history migration');
    const receiptMessageTriggers = ['activity_events_no_replace', 'account_activity_events_no_update',
      'account_activity_events_no_delete', 'account_activity_events_no_replace', 'receipt_messages_from_activity', 'receipt_messages_no_update', 'receipt_messages_no_delete', 'receipt_messages_no_replace'];
    const triggers = await db().prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${receiptMessageTriggers.map(() => '?').join(',')})`)
      .bind(...receiptMessageTriggers).all<{ name: string }>();
    if (triggers.results.length !== receiptMessageTriggers.length) throw Error('Missing receipt message maintenance');
    const storage = bucket();
    if (typeof storage.get !== 'function' || typeof storage.put !== 'function' || typeof storage.delete !== 'function') throw Error('Missing receipt binding');
    return Response.json({ status: 'ready' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
