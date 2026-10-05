import { bucket, db } from '@/lib/store';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Compilation of this read-only query also detects missing migrations.
    await db().prepare(`SELECT r.state, r.created_at, r.legacy_cleanup_after, r.content_type, r.size_bytes, r.sha256,
      i.audit_id, p.generation, a.sequence, a.id, a.user_id, a.actor_name, a.created_at, a.entity_type,
      a.entity_id, a.action, a.before_data, a.after_data, a.source,
      e.sequence, m.message_data, t.receipt_link_version
      FROM receipts r CROSS JOIN activity_events e CROSS JOIN trips t
      CROSS JOIN invites i CROSS JOIN push_subscriptions p
      CROSS JOIN account_activity_events a INDEXED BY account_activity_events_user_sequence_idx
      CROSS JOIN receipt_messages m INDEXED BY receipt_messages_trip_message_idx
      CROSS JOIN current_receipt_links l INDEXED BY current_receipt_links_entity_idx
      CROSS JOIN receipt_history_links h INDEXED BY receipt_history_links_snapshot_idx LIMIT 0`).all();
    const receiptHistoryIndexes = ['account_activity_events_id_idx', 'account_activity_events_user_sequence_idx',
      'activity_events_trip_entity_idx', 'activity_events_draft_before_expense_idx',
      'activity_events_draft_after_expense_idx', 'activity_events_expense_before_source_draft_idx',
      'activity_events_expense_after_source_draft_idx', 'current_receipt_links_expense_idx',
      'current_receipt_links_source_idx', 'current_receipt_links_receipt_idx',
      'receipt_history_links_entity_idx', 'receipt_history_links_expense_idx',
      'receipt_history_links_source_idx', 'receipt_history_links_receipt_idx'];
    const indexes = await db().prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${receiptHistoryIndexes.map(() => '?').join(',')})`)
      .bind(...receiptHistoryIndexes).all<{ name: string }>();
    if (indexes.results.length !== receiptHistoryIndexes.length) throw Error('Missing receipt history migration');
    const receiptLinkTriggers = ['current_receipt_links_insert', 'current_receipt_links_update', 'current_receipt_links_delete',
      'receipt_history_links_insert', 'receipt_history_links_no_update', 'receipt_history_links_no_delete', 'receipt_history_links_no_replace'];
    const triggers = await db().prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${receiptLinkTriggers.map(() => '?').join(',')})`)
      .bind(...receiptLinkTriggers).all<{ name: string }>();
    if (triggers.results.length !== receiptLinkTriggers.length) throw Error('Missing receipt link maintenance');
    const receiptMessageTriggers = ['activity_events_no_replace', 'account_activity_events_no_update',
      'account_activity_events_no_delete', 'account_activity_events_no_replace',
      'receipt_messages_from_activity', 'receipt_messages_no_update', 'receipt_messages_no_delete', 'receipt_messages_no_replace'];
    const messageTriggers = await db().prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${receiptMessageTriggers.map(() => '?').join(',')})`)
      .bind(...receiptMessageTriggers).all<{ name: string }>();
    if (messageTriggers.results.length !== receiptMessageTriggers.length) throw Error('Missing receipt message maintenance');
    const storage = bucket();
    if (typeof storage.get !== 'function' || typeof storage.put !== 'function' || typeof storage.delete !== 'function') throw Error('Missing receipt binding');
    return Response.json({ status: 'ready' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
