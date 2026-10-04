export type ReceiptActivityScope = { expenseId?: string; draftId?: string };
export type ActivityScopeSql = { prefix: string; condition: string; bindings: string[] };

/** Resolve typed receipt links with indexed lookups, preserving old snapshots. */
export function receiptActivityScope(tripId: string, scope: ReceiptActivityScope = {}): ActivityScopeSql {
  const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100;
  const expense = scope.expenseId !== undefined, draft = scope.draftId !== undefined;
  if (!validId(tripId) || (expense && draft) || (expense && !validId(scope.expenseId)) || (draft && !validId(scope.draftId))) {
    throw new Error('INVALID_RECEIPT_ACTIVITY_SCOPE');
  }
  if (!expense && !draft) return { prefix: '', condition: '1', bindings: [] };
  // CROSS JOIN keeps the one-row context outside indexed history probes;
  // otherwise SQLite may reverse a join and scan a partial expression index.
  // D1 limits each compound SELECT to five terms. Split discovery into small
  // materialized groups while retaining the same indexed lookup branches.
  return {
    bindings: [JSON.stringify([{ tripId, kind: draft ? 'draft' : 'expense', entryId: draft ? scope.draftId : scope.expenseId }])],
    prefix: `
      WITH receipt_scope_context AS MATERIALIZED (
        SELECT json_extract(value, '$.tripId') AS trip_id,
          json_extract(value, '$.kind') AS kind, json_extract(value, '$.entryId') AS entry_id
        FROM json_each(?)
      ), receipt_scope_current_expenses AS MATERIALIZED (
        SELECT json_extract(x.value, '$.id') AS id, json_extract(x.value, '$.sourceDraftId') AS source_draft_id,
          json_extract(x.value, '$.receiptId') AS receipt_id
        FROM trips t JOIN receipt_scope_context c ON t.id = c.trip_id, json_each(t.data, '$.expenses') x
      ), receipt_scope_current_drafts AS MATERIALIZED (
        SELECT json_extract(d.value, '$.id') AS id, json_extract(d.value, '$.expenseId') AS expense_id,
          json_extract(d.value, '$.receiptId') AS receipt_id
        FROM trips t JOIN receipt_scope_context c ON t.id = c.trip_id, json_each(t.data, '$.drafts') d
      ), receipt_scope_draft_links(id) AS MATERIALIZED (
        SELECT d.expense_id FROM receipt_scope_current_drafts d, receipt_scope_context c
        WHERE c.kind = 'draft' AND d.id = c.entry_id AND typeof(d.expense_id) = 'text'
        UNION
        SELECT json_extract(h.before_data, '$.expenseId')
        FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_trip_entity_idx
          ON h.trip_id = c.trip_id AND h.entity_type = 'draft' AND h.entity_id = c.entry_id
        WHERE c.kind = 'draft' AND json_type(h.before_data, '$.expenseId') = 'text'
        UNION
        SELECT json_extract(h.after_data, '$.expenseId')
        FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_trip_entity_idx
          ON h.trip_id = c.trip_id AND h.entity_type = 'draft' AND h.entity_id = c.entry_id
        WHERE c.kind = 'draft' AND json_type(h.after_data, '$.expenseId') = 'text'
      ), receipt_scope_posted_links(id) AS MATERIALIZED (
        SELECT x.id FROM receipt_scope_current_expenses x, receipt_scope_context c
        WHERE c.kind = 'draft' AND x.source_draft_id = c.entry_id
        UNION
        SELECT h.entity_id
        FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_expense_before_source_draft_idx
          ON h.trip_id = c.trip_id AND json_extract(h.before_data, '$.sourceDraftId') = c.entry_id
        WHERE c.kind = 'draft' AND h.entity_type = 'expense'
        UNION
        SELECT h.entity_id
        FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_expense_after_source_draft_idx
          ON h.trip_id = c.trip_id AND json_extract(h.after_data, '$.sourceDraftId') = c.entry_id
        WHERE c.kind = 'draft' AND h.entity_type = 'expense'
      ), receipt_scope_links(id) AS MATERIALIZED (
        SELECT id FROM receipt_scope_draft_links
        UNION SELECT id FROM receipt_scope_posted_links
      ), receipt_scope_roots(id) AS MATERIALIZED (
        SELECT entry_id FROM receipt_scope_context
        WHERE kind = 'expense' OR NOT EXISTS (SELECT 1 FROM receipt_scope_links)
        UNION SELECT id FROM receipt_scope_links
      ), receipt_scope_source_drafts(id) AS MATERIALIZED (
        SELECT x.source_draft_id FROM receipt_scope_current_expenses x
        WHERE x.id IN (SELECT id FROM receipt_scope_roots) AND typeof(x.source_draft_id) = 'text'
        UNION
        SELECT json_extract(h.before_data, '$.sourceDraftId')
        FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_trip_entity_idx
          ON h.trip_id = c.trip_id AND h.entity_type = 'expense' AND h.entity_id IN (SELECT id FROM receipt_scope_roots)
        WHERE json_type(h.before_data, '$.sourceDraftId') = 'text'
        UNION
        SELECT json_extract(h.after_data, '$.sourceDraftId')
        FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_trip_entity_idx
          ON h.trip_id = c.trip_id AND h.entity_type = 'expense' AND h.entity_id IN (SELECT id FROM receipt_scope_roots)
        WHERE json_type(h.after_data, '$.sourceDraftId') = 'text'
      ), receipt_scope_fallback_drafts(id) AS MATERIALIZED (
        -- Same-ID posting is a legacy fallback, never an override for an
        -- explicitly linked draft or a distinct-ID source draft elsewhere.
        SELECT r.id FROM receipt_scope_roots r, receipt_scope_context c
        WHERE NOT EXISTS (SELECT 1 FROM receipt_scope_current_drafts d WHERE d.id = r.id AND d.expense_id IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM activity_events h INDEXED BY activity_events_trip_entity_idx
            WHERE h.trip_id = c.trip_id AND h.entity_type = 'draft' AND h.entity_id = r.id
              AND (json_extract(h.before_data, '$.expenseId') IS NOT NULL OR json_extract(h.after_data, '$.expenseId') IS NOT NULL)
          )
          AND NOT EXISTS (SELECT 1 FROM receipt_scope_current_expenses x WHERE x.source_draft_id = r.id)
          AND NOT EXISTS (
            SELECT 1 FROM activity_events h INDEXED BY activity_events_expense_before_source_draft_idx
            WHERE h.trip_id = c.trip_id AND h.entity_type = 'expense' AND json_extract(h.before_data, '$.sourceDraftId') = r.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM activity_events h INDEXED BY activity_events_expense_after_source_draft_idx
            WHERE h.trip_id = c.trip_id AND h.entity_type = 'expense' AND json_extract(h.after_data, '$.sourceDraftId') = r.id
          )
      ), receipt_scope_related_drafts(id) AS MATERIALIZED (
        SELECT d.id FROM receipt_scope_current_drafts d WHERE d.expense_id IN (SELECT id FROM receipt_scope_roots)
        UNION
        SELECT h.entity_id
        FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_draft_before_expense_idx
          ON h.trip_id = c.trip_id AND json_extract(h.before_data, '$.expenseId') IN (SELECT id FROM receipt_scope_roots)
        WHERE h.entity_type = 'draft'
        UNION
        SELECT h.entity_id
        FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_draft_after_expense_idx
          ON h.trip_id = c.trip_id AND json_extract(h.after_data, '$.expenseId') IN (SELECT id FROM receipt_scope_roots)
        WHERE h.entity_type = 'draft'
      ), receipt_scope_drafts(id) AS MATERIALIZED (
        SELECT entry_id FROM receipt_scope_context WHERE kind = 'draft'
        UNION SELECT id FROM receipt_scope_source_drafts
        UNION SELECT id FROM receipt_scope_fallback_drafts
        UNION SELECT id FROM receipt_scope_related_drafts
      ), receipt_scope_changes AS MATERIALIZED (
        SELECT h.sequence, json_extract(h.before_data, '$.receiptId') AS before_receipt_id,
          json_extract(h.after_data, '$.receiptId') AS after_receipt_id
        FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_trip_entity_idx
          ON h.trip_id = c.trip_id AND h.entity_type = 'expense' AND h.entity_id IN (SELECT id FROM receipt_scope_roots)
        UNION ALL
        SELECT h.sequence, json_extract(h.before_data, '$.receiptId'), json_extract(h.after_data, '$.receiptId')
        FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_trip_entity_idx
          ON h.trip_id = c.trip_id AND h.entity_type = 'draft' AND h.entity_id IN (SELECT id FROM receipt_scope_drafts)
        WHERE (c.kind = 'draft' AND h.entity_id = c.entry_id)
          OR json_extract(h.before_data, '$.expenseId') IN (SELECT id FROM receipt_scope_roots)
          OR json_extract(h.after_data, '$.expenseId') IN (SELECT id FROM receipt_scope_roots)
          OR (json_extract(h.before_data, '$.expenseId') IS NULL AND json_extract(h.after_data, '$.expenseId') IS NULL)
      ), receipt_scope_images(id) AS MATERIALIZED (
        SELECT before_receipt_id FROM receipt_scope_changes WHERE typeof(before_receipt_id) = 'text'
        UNION SELECT after_receipt_id FROM receipt_scope_changes WHERE typeof(after_receipt_id) = 'text'
        UNION SELECT x.receipt_id FROM receipt_scope_current_expenses x
          WHERE x.id IN (SELECT id FROM receipt_scope_roots) AND typeof(x.receipt_id) = 'text'
        UNION SELECT d.receipt_id FROM receipt_scope_current_drafts d, receipt_scope_context c
          WHERE d.id IN (SELECT id FROM receipt_scope_drafts) AND typeof(d.receipt_id) = 'text'
            AND ((c.kind = 'draft' AND d.id = c.entry_id) OR d.expense_id IS NULL OR d.expense_id IN (SELECT id FROM receipt_scope_roots))
      ), receipt_scope_events(sequence) AS MATERIALIZED (
        SELECT sequence FROM receipt_scope_changes
        UNION
        SELECT h.sequence
        FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_trip_entity_idx
          ON h.trip_id = c.trip_id AND h.entity_type = 'receipt' AND h.entity_id IN (SELECT id FROM receipt_scope_images)
      )
    `,
    // Integer primary-key probes avoid scanning a trip's sequence index before
    // applying the family filter. Final snapshots still use immutable IDs.
    condition: 'e.sequence IN (SELECT sequence FROM receipt_scope_events)',
  };
}
