export type ReceiptActivityScope = { expenseId?: string; draftId?: string };
export type ActivityScopeSql = { prefix: string; condition: string; bindings: string[] };
export type ReceiptActivityFamily = { expenseIds: string[]; draftIds: string[]; receiptIds: string[]; version: number };
type Link = { entity_id: string; expense_id: string | null; source_draft_id: string | null; receipt_id: string | null; has_expense_link: number };
const MAX_SCOPE_LINKS = 10_000;
const MAX_SCOPE_BYTES = 4 * 1024 * 1024;
// D1 cells/bindings cap at2MB; leave room below that UTF-8 ceiling.
const MAX_SCOPE_BIND_BYTES = 1_900_000;
const sources = ['current_receipt_links', 'receipt_history_links'];
export class ReceiptScopeChangedError extends Error { constructor() { super('RECEIPT_SCOPE_CHANGED'); } }
export class ReceiptScopeSizeError extends Error { constructor() { super('RECEIPT_SCOPE_TOO_LARGE'); } }

export function validateReceiptActivityScope(tripId: string, scope: ReceiptActivityScope) {
  const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100;
  const expense = scope.expenseId !== undefined, draft = scope.draftId !== undefined;
  if (!validId(tripId) || (expense && draft) || (expense && !validId(scope.expenseId)) || (draft && !validId(scope.draftId))) throw new Error('INVALID_RECEIPT_ACTIVITY_SCOPE');
  return expense || draft;
}

/** Indexed facts, not financial or message snapshots, determine the family. */
export async function resolveReceiptActivityFamily(database: D1Database, tripId: string, scope: ReceiptActivityScope): Promise<ReceiptActivityFamily | undefined> {
  if (!validateReceiptActivityScope(tripId, scope)) return;
  const baseline = await database.prepare('SELECT receipt_link_version AS version FROM trips WHERE id = ?').bind(tripId).first<{ version: number }>();
  if (!baseline) throw new ReceiptScopeChangedError();
  const facts = new Set<string>(); let bytes = 0;
  const bounded = <T>(rows: T[]) => {
    if (rows.length > MAX_SCOPE_LINKS) throw new ReceiptScopeSizeError();
    for (const row of rows) {
      const value = JSON.stringify(row);
      if (!facts.has(value)) { facts.add(value); bytes += new TextEncoder().encode(value).byteLength; }
    }
    if (facts.size > MAX_SCOPE_LINKS || bytes > MAX_SCOPE_BYTES) throw new ReceiptScopeSizeError();
    return rows;
  };
  const query = async (kind: 'expense' | 'draft', field: 'entity_id' | 'expense_id' | 'source_draft_id' | 'receipt_id', ids: Iterable<string>) => {
    const values = [...new Set(ids)];
    if (!values.length) return [] as Link[];
    const encoded = JSON.stringify(values);
    if (values.length > MAX_SCOPE_LINKS || new TextEncoder().encode(encoded).byteLength > MAX_SCOPE_BIND_BYTES) throw new ReceiptScopeSizeError();
    const index = { entity_id: 'entity', expense_id: 'expense', source_draft_id: 'source', receipt_id: 'receipt' }[field];
    const sql = sources.map(table => `SELECT entity_id,expense_id,source_draft_id,receipt_id,has_expense_link
      FROM ${table} INDEXED BY ${table}_${index}_idx
      WHERE trip_id = ? AND entity_type = '${kind}' AND ${field} IN (SELECT value FROM json_each(?))`).join('\nUNION\n');
    const result = await database.prepare(`${sql} LIMIT ${MAX_SCOPE_LINKS + 1}`).bind(tripId, encoded, tripId, encoded).all<Link>();
    return bounded(result.results);
  };
  const ids = (rows: Link[], field: 'entity_id' | 'expense_id' | 'source_draft_id' | 'receipt_id') => [...new Set(rows.flatMap(row => typeof row[field] === 'string' ? [row[field] as string] : []))];
  const entryId = scope.draftId ?? scope.expenseId!;
  const explicitRoots = new Set<string>(scope.expenseId === undefined ? [] : [scope.expenseId]);
  if (scope.draftId !== undefined) {
    for (const id of ids(await query('draft', 'entity_id', [entryId]), 'expense_id')) explicitRoots.add(id);
    for (const id of ids(await query('expense', 'source_draft_id', [entryId]), 'entity_id')) explicitRoots.add(id);
  }
  const analyzeLegacy = async (expenseRoots: Set<string>, selectedDraft?: string) => {
    const rootFacts = await query('expense', 'entity_id', expenseRoots);
    const candidates = new Set(expenseRoots); // Also disambiguate original same-ID posting.
    if (selectedDraft) candidates.add(selectedDraft);
    for (const id of ids(await query('draft', 'receipt_id', ids(rootFacts, 'receipt_id')), 'entity_id')) candidates.add(id);
    const candidateFacts = await query('draft', 'entity_id', candidates);
    const candidatePhotos = ids(candidateFacts, 'receipt_id');
    const photoOwners = await query('expense', 'receipt_id', candidatePhotos);
    const photoDrafts = await query('draft', 'receipt_id', candidatePhotos);
    const allDraftIds = new Set([...candidates, ...ids(photoDrafts, 'entity_id')]);
    const allDraftFacts = await query('draft', 'entity_id', allDraftIds);
    const explicitSources = new Set(ids(await query('expense', 'source_draft_id', allDraftIds), 'source_draft_id'));
    const collisions = new Set(ids(await query('expense', 'entity_id', candidates), 'entity_id'));
    // Never infer from a latest missing target when any earlier target existed.
    // Non-null malformed targets remain blocked by the projection's separate flag.
    const linkedDrafts = new Set(allDraftFacts.filter(row => row.has_expense_link !== 0).map(row => row.entity_id));
    const unlinked = (id: string) => !explicitSources.has(id) && !linkedDrafts.has(id);
    const photosByDraft = new Map<string, Set<string>>();
    const ownersByPhoto = new Map<string, Set<string>>();
    const draftsByPhoto = new Map<string, Set<string>>();
    const add = (map: Map<string, Set<string>>, key: string, id: string) => {
      const set = map.get(key) ?? new Set<string>(); set.add(id); map.set(key, set);
    };
    for (const row of candidateFacts) if (row.receipt_id !== null) add(photosByDraft, row.entity_id, row.receipt_id);
    for (const row of photoOwners) if (row.receipt_id !== null) add(ownersByPhoto, row.receipt_id, row.entity_id);
    for (const row of photoDrafts) if (row.receipt_id !== null) add(draftsByPhoto, row.receipt_id, row.entity_id);
    const owners = new Map<string, Set<string>>();
    const legacyParents = new Map<string, string>();
    for (const id of candidates) {
      const expenseOwners = new Set<string>(); let competing = false;
      for (const photo of photosByDraft.get(id) ?? []) {
        for (const owner of ownersByPhoto.get(photo) ?? []) expenseOwners.add(owner);
        for (const other of draftsByPhoto.get(photo) ?? []) if (other !== id && unlinked(other)) competing = true;
      }
      owners.set(id, expenseOwners);
      if (!unlinked(id) || expenseOwners.size !== 1 || competing || (collisions.has(id) && !expenseRoots.has(id))) continue;
      // Deleted copies still create ambiguity. Known explicitly linked drafts do
      // not compete with an otherwise unambiguous legacy draft.
      legacyParents.set(id, [...expenseOwners][0]);
    }
    return { legacyParents, owners, unlinked };
  };
  let legacy = await analyzeLegacy(explicitRoots, scope.draftId !== undefined && !explicitRoots.size ? entryId : undefined);
  const roots = new Set(explicitRoots);
  if (scope.draftId !== undefined && !roots.size) {
    const parent = legacy.legacyParents.get(entryId);
    if (parent) {
      roots.add(parent);
      // The inferred expense may have other photos and same-ID drafts. Inspect
      // those facts before including sibling history, just as expense scope does.
      legacy = await analyzeLegacy(roots, entryId);
    } else if (legacy.unlinked(entryId) && ![...(legacy.owners.get(entryId) ?? [])].some(id => id !== entryId)) roots.add(entryId);
  }
  const expenseFacts = await query('expense', 'entity_id', roots);
  const drafts = new Set<string>(scope.draftId === undefined ? [] : [entryId]);
  for (const id of ids(expenseFacts, 'source_draft_id')) drafts.add(id);
  for (const id of ids(await query('draft', 'expense_id', roots), 'entity_id')) drafts.add(id);
  for (const root of roots) if (legacy.unlinked(root) && ![...(legacy.owners.get(root) ?? [])].some(id => !roots.has(id))) drafts.add(root);
  for (const [id, parent] of legacy.legacyParents) if (roots.has(parent)) drafts.add(id);
  const family = { expenseIds: [...roots], draftIds: [...drafts], receiptIds: [] as string[], version: baseline.version };
  const context = JSON.stringify([{ ...family, tripId, draftId: scope.draftId ?? null }]);
  if (new TextEncoder().encode(context).byteLength > MAX_SCOPE_BIND_BYTES) throw new ReceiptScopeSizeError();
  const imageSql = sources.flatMap(table => [
    `SELECT l.receipt_id AS id FROM context c CROSS JOIN ${table} l INDEXED BY ${table}_entity_idx
      ON l.trip_id = c.trip_id AND l.entity_type = 'expense' AND l.entity_id IN (SELECT value FROM json_each(c.expense_ids)) WHERE l.receipt_id IS NOT NULL`,
    `SELECT l.receipt_id AS id FROM context c CROSS JOIN ${table} l INDEXED BY ${table}_entity_idx
      ON l.trip_id = c.trip_id AND l.entity_type = 'draft' AND l.entity_id IN (SELECT value FROM json_each(c.draft_ids))
      WHERE l.receipt_id IS NOT NULL AND (l.entity_id = c.draft_id OR ${table === 'current_receipt_links' ? `(l.has_expense_link = 0 OR l.expense_id IN (SELECT value FROM json_each(c.expense_ids)))` : `EXISTS (SELECT 1 FROM receipt_history_links pair INDEXED BY receipt_history_links_snapshot_idx WHERE pair.sequence = l.sequence AND pair.expense_id IN (SELECT value FROM json_each(c.expense_ids))) OR NOT EXISTS (SELECT 1 FROM receipt_history_links pair INDEXED BY receipt_history_links_snapshot_idx WHERE pair.sequence = l.sequence AND pair.has_expense_link <> 0)`})`,
  ]).join('\nUNION\n');
  const imageRows = await database.prepare(`WITH context AS MATERIALIZED (
    SELECT json_extract(value,'$[0].tripId') AS trip_id, json_extract(value,'$[0].draftId') AS draft_id,
      json_extract(value,'$[0].expenseIds') AS expense_ids, json_extract(value,'$[0].draftIds') AS draft_ids FROM (SELECT ? AS value)
  ) ${imageSql} LIMIT ${MAX_SCOPE_LINKS + 1}`).bind(context).all<{ id: string }>();
  family.receiptIds = bounded(imageRows.results).map(row => row.id);
  if (new TextEncoder().encode(JSON.stringify(family)).byteLength > MAX_SCOPE_BYTES) throw new ReceiptScopeSizeError();
  await assertReceiptActivityVersion(database, tripId, family.version);
  return family;
}

export async function assertReceiptActivityVersion(database: D1Database, tripId: string, version: number) {
  const current = await database.prepare('SELECT receipt_link_version AS version FROM trips WHERE id = ?').bind(tripId).first<{ version: number }>();
  if (!current || current.version !== version) throw new ReceiptScopeChangedError();
}

/** The final candidate query uses only bounded, server-resolved typed IDs. */
export function receiptActivityScope(tripId: string, scope: ReceiptActivityScope = {}, family?: ReceiptActivityFamily): ActivityScopeSql {
  if (!validateReceiptActivityScope(tripId, scope)) return { prefix: '', condition: '1', bindings: [] };
  if (!family) throw new Error('INVALID_RECEIPT_ACTIVITY_FAMILY');
  const resolved = family;
  const context = JSON.stringify([{ tripId, kind: scope.draftId === undefined ? 'expense' : 'draft', entryId: scope.draftId ?? scope.expenseId, ...resolved }]);
  if (new TextEncoder().encode(context).byteLength > MAX_SCOPE_BIND_BYTES) throw new ReceiptScopeSizeError();
  return {
    bindings: [context],
    prefix: `WITH receipt_scope_context AS MATERIALIZED (
      SELECT json_extract(value,'$[0].tripId') AS trip_id, json_extract(value,'$[0].kind') AS kind,
        json_extract(value,'$[0].entryId') AS entry_id, json_extract(value,'$[0].version') AS version,
        json_extract(value,'$[0].expenseIds') AS expense_ids, json_extract(value,'$[0].draftIds') AS draft_ids,
        json_extract(value,'$[0].receiptIds') AS receipt_ids FROM (SELECT ? AS value)
    ), receipt_scope_events(sequence) AS MATERIALIZED (
      SELECT h.sequence FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_trip_entity_idx
        ON h.trip_id = c.trip_id AND h.entity_type = 'expense' AND h.entity_id IN (SELECT value FROM json_each(c.expense_ids))
      UNION SELECT h.sequence FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_trip_entity_idx
        ON h.trip_id = c.trip_id AND h.entity_type = 'draft' AND h.entity_id IN (SELECT value FROM json_each(c.draft_ids))
      WHERE (c.kind = 'draft' AND h.entity_id = c.entry_id)
        OR EXISTS (SELECT 1 FROM receipt_history_links l INDEXED BY receipt_history_links_snapshot_idx
          WHERE l.sequence = h.sequence AND l.expense_id IN (SELECT value FROM json_each(c.expense_ids)))
        OR NOT EXISTS (SELECT 1 FROM receipt_history_links l INDEXED BY receipt_history_links_snapshot_idx
          WHERE l.sequence = h.sequence AND l.has_expense_link <> 0)
      UNION SELECT h.sequence FROM receipt_scope_context c CROSS JOIN activity_events h INDEXED BY activity_events_trip_entity_idx
        ON h.trip_id = c.trip_id AND h.entity_type = 'receipt' AND h.entity_id IN (SELECT value FROM json_each(c.receipt_ids))
    )`,
    condition: 't.receipt_link_version = (SELECT version FROM receipt_scope_context) AND e.sequence IN (SELECT sequence FROM receipt_scope_events)',
  };
}
