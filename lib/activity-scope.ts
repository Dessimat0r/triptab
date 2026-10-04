export type ReceiptActivityScope = { expenseId?: string; draftId?: string };
export type ActivityScopeSql = { prefix: string; condition: string; bindings: string[] };

/** Resolve a receipt family from immutable IDs, including deleted draft links. */
export function receiptActivityScope(tripId: string, scope: ReceiptActivityScope = {}): ActivityScopeSql {
  const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100;
  const expense = scope.expenseId !== undefined, draft = scope.draftId !== undefined;
  if (!validId(tripId) || (expense && draft) || (expense && !validId(scope.expenseId)) || (draft && !validId(scope.draftId))) {
    throw new Error('INVALID_RECEIPT_ACTIVITY_SCOPE');
  }
  if (!expense && !draft) return { prefix: '', condition: '1', bindings: [] };
  return {
    bindings: [JSON.stringify([{ tripId, kind: draft ? 'draft' : 'expense', entryId: draft ? scope.draftId : scope.expenseId }])],
    prefix: `
      WITH receipt_scope_context AS (
        SELECT json_extract(value, '$.tripId') AS trip_id,
          json_extract(value, '$.kind') AS kind, json_extract(value, '$.entryId') AS entry_id
        FROM json_each(?)
      ), receipt_scope_links(id) AS (
        SELECT json_extract(d.value, '$.expenseId')
        FROM trips t JOIN receipt_scope_context c ON t.id = c.trip_id, json_each(t.data, '$.drafts') d
        WHERE c.kind = 'draft' AND json_extract(d.value, '$.id') = c.entry_id
          AND json_type(d.value, '$.expenseId') = 'text'
        UNION
        SELECT json_extract(h.before_data, '$.expenseId')
        FROM activity_events h JOIN receipt_scope_context c ON h.trip_id = c.trip_id
        WHERE c.kind = 'draft' AND h.entity_type = 'draft' AND h.entity_id = c.entry_id
          AND json_type(h.before_data, '$.expenseId') = 'text'
        UNION
        SELECT json_extract(h.after_data, '$.expenseId')
        FROM activity_events h JOIN receipt_scope_context c ON h.trip_id = c.trip_id
        WHERE c.kind = 'draft' AND h.entity_type = 'draft' AND h.entity_id = c.entry_id
          AND json_type(h.after_data, '$.expenseId') = 'text'
      ), receipt_scope_roots(id) AS (
        SELECT entry_id FROM receipt_scope_context
        WHERE kind = 'expense' OR NOT EXISTS (SELECT 1 FROM receipt_scope_links)
        UNION SELECT id FROM receipt_scope_links
      ), receipt_scope_changes AS (
        SELECT h.id, json_extract(h.before_data, '$.receiptId') AS before_receipt_id,
          json_extract(h.after_data, '$.receiptId') AS after_receipt_id
        FROM activity_events h JOIN receipt_scope_context c ON h.trip_id = c.trip_id
        WHERE (h.entity_type = 'expense' AND h.entity_id IN (SELECT id FROM receipt_scope_roots))
          OR (h.entity_type = 'draft' AND ((c.kind = 'draft' AND h.entity_id = c.entry_id)
            OR json_extract(h.before_data, '$.expenseId') IN (SELECT id FROM receipt_scope_roots)
            OR json_extract(h.after_data, '$.expenseId') IN (SELECT id FROM receipt_scope_roots)
            OR (h.entity_id IN (SELECT id FROM receipt_scope_roots)
              AND json_extract(h.before_data, '$.expenseId') IS NULL
              AND json_extract(h.after_data, '$.expenseId') IS NULL)))
      ), receipt_scope_images(id) AS (
        SELECT before_receipt_id FROM receipt_scope_changes WHERE typeof(before_receipt_id) = 'text'
        UNION SELECT after_receipt_id FROM receipt_scope_changes WHERE typeof(after_receipt_id) = 'text'
        UNION
        SELECT json_extract(x.value, '$.receiptId')
        FROM trips t JOIN receipt_scope_context c ON t.id = c.trip_id, json_each(t.data, '$.expenses') x
        WHERE json_extract(x.value, '$.id') IN (SELECT id FROM receipt_scope_roots)
          AND json_type(x.value, '$.receiptId') = 'text'
        UNION
        SELECT json_extract(d.value, '$.receiptId')
        FROM trips t JOIN receipt_scope_context c ON t.id = c.trip_id, json_each(t.data, '$.drafts') d
        WHERE ((c.kind = 'draft' AND json_extract(d.value, '$.id') = c.entry_id)
          OR json_extract(d.value, '$.expenseId') IN (SELECT id FROM receipt_scope_roots)
          OR (json_extract(d.value, '$.id') IN (SELECT id FROM receipt_scope_roots)
            AND json_extract(d.value, '$.expenseId') IS NULL))
          AND json_type(d.value, '$.receiptId') = 'text'
      )
    `,
    condition: `(e.id IN (SELECT id FROM receipt_scope_changes)
      OR (e.entity_type = 'receipt' AND e.entity_id IN (SELECT id FROM receipt_scope_images)))`,
  };
}
