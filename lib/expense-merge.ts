import { equalSavedValue } from './client-ledger';

/**
 * Three-way merge of one expense edited by two people (F-08).
 *
 * `base` is the version the editor opened, `mine` the editor's values and
 * `theirs` the latest saved version. A change made by only one side is kept;
 * a field both sides changed to different values is a conflict that a person
 * must resolve. Values that must stay consistent with each other are merged
 * as one group (date/time/zone, currency/rate/bank charge, an item's price
 * and allocation, the split mode) so a merge never combines half of one
 * person's financial change with half of another's.
 */

type Value = Record<string, unknown>;
type Item = Value & { id: string };

export type MergeFieldKey = string;
export type MergeConflict = {
  /** Stable key used to record a resolution choice. */
  key: MergeFieldKey;
  /** Human label such as "Amount of Pizza" or "Payer". */
  label: string;
  mine: unknown;
  theirs: unknown;
};
export type MergeChange = { key: MergeFieldKey; label: string };
export type ExpenseMerge<T> = {
  merged: T;
  /** Fields only the other person changed, applied to `merged`. */
  applied: MergeChange[];
  conflicts: MergeConflict[];
};
export type MergeChoice = 'mine' | 'theirs';

/** Fields that belong to this editor session rather than to the saved expense. */
const EDITOR_KEYS = new Set(['expenseId', 'draftId', 'sourceDraftId', 'adjustmentAllocation']);
/** Bookkeeping merged separately: provenance follows whichever value was taken. */
const SPECIAL_KEYS = new Set(['items', 'conversation', 'fieldSources', 'receiptScan']);

const GROUPS: { key: string; label: string; fields: string[] }[] = [
  { key: 'when', label: 'Date and time', fields: ['date', 'time', 'timezone'] },
  { key: 'currency', label: 'Currency and conversion', fields: ['currency', 'fx', 'bankAmount'] },
  { key: 'split-mode', label: 'Whole-receipt percentages', fields: ['percentages'] },
];
const LABELS: Record<string, string> = {
  title: 'Name', payer: 'Paid by', tax: 'Added tax', tip: 'Tip / service', discount: 'Discount',
  receiptId: 'Receipt photo', notes: 'Notes', icon: 'Icon', place: 'Place', receiptLanguage: 'Receipt language',
  // Discount records (F-02) merge as one list: they reference item IDs and must stay consistent.
  adjustments: 'Discounts and charges',
};
/** Item fields that only describe a line; everything else about an item is financial. */
const ITEM_DESCRIPTIVE = new Set(['name', 'nameLanguage', 'translations', 'scanSource']);
/** Item bookkeeping merged separately: discussions append, provenance follows the value taken. */
const ITEM_BOOKKEEPING = new Set(['conversation', 'fieldSources']);

const same = (a: unknown, b: unknown) => equalSavedValue(a, b);
const pick = (value: Value | undefined, fields: string[]) =>
  Object.fromEntries(fields.map(field => [field, value?.[field]]));
const assign = (target: Value, source: Value) => {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) delete target[key]; else target[key] = structuredClone(value);
  }
};

function itemFinancial(item: Item | undefined) {
  if (!item) return undefined;
  return Object.fromEntries(Object.entries(item).filter(([key]) => !ITEM_DESCRIPTIVE.has(key) && !ITEM_BOOKKEEPING.has(key) && key !== 'id'));
}
function itemDescriptive(item: Item | undefined) {
  if (!item) return undefined;
  return Object.fromEntries(Object.entries(item).filter(([key]) => ITEM_DESCRIPTIVE.has(key)));
}
const itemName = (...items: (Item | undefined)[]) => String(items.find(item => item && typeof item.name === 'string' && item.name.trim())?.name || 'item');

type Outcome<V> = { value: V; changedBy: 'none' | 'mine' | 'theirs' | 'both-same' } | { conflict: true };
function threeWay<V>(base: V, mine: V, theirs: V): Outcome<V> {
  const mineChanged = !same(base, mine), theirsChanged = !same(base, theirs);
  if (!mineChanged && !theirsChanged) return { value: mine, changedBy: 'none' };
  if (mineChanged && !theirsChanged) return { value: mine, changedBy: 'mine' };
  if (!mineChanged && theirsChanged) return { value: theirs, changedBy: 'theirs' };
  if (same(mine, theirs)) return { value: mine, changedBy: 'both-same' };
  return { conflict: true };
}

/**
 * Line order is financial: receipt-total rounding gives tied pennies in the
 * order people first appear on the lines. Merge the relative order of lines
 * both sides kept as one three-way value (R10): a reorder by one side is kept,
 * the same reorder by both is fine, and two different reorders are a conflict
 * a person resolves. Lines only I added follow the saved order; when my
 * reorder is kept, lines only the other person added keep their place after
 * the line that preceded them.
 */
function mergeOrder(base: string[], mine: string[], theirs: string[], kept: Set<string>, choices: Record<string, MergeChoice>,
  applied: MergeChange[], conflicts: MergeConflict[]): string[] {
  const common = new Set(base.filter(id => kept.has(id) && mine.includes(id) && theirs.includes(id)));
  const relative = (list: string[]) => list.filter(id => common.has(id));
  const outcome = threeWay(relative(base), relative(mine), relative(theirs));
  let primary: MergeChoice;
  if ('conflict' in outcome) {
    if (choices['item-order']) primary = choices['item-order'];
    else { conflicts.push({ key: 'item-order', label: 'Order of lines', mine: relative(mine), theirs: relative(theirs) }); primary = 'theirs'; }
  } else {
    primary = outcome.changedBy === 'mine' || outcome.changedBy === 'both-same' ? 'mine' : 'theirs';
    if (outcome.changedBy === 'theirs') applied.push({ key: 'item-order', label: 'Order of lines' });
  }
  const order = (primary === 'mine' ? mine : theirs).filter(id => kept.has(id));
  const other = primary === 'mine' ? theirs : mine;
  other.forEach((id, index) => {
    if (!kept.has(id) || order.includes(id)) return;
    // The saved order stays first and my new lines follow it (as before);
    // when my reorder wins, the other person's new lines keep their place.
    if (primary === 'theirs') { order.push(id); return; }
    const before = other.slice(0, index).reverse().find(value => order.includes(value));
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id);
  });
  for (const id of kept) if (!order.includes(id)) order.push(id);
  return order;
}

function mergeItems(base: Item[], mine: Item[], theirs: Item[], choices: Record<string, MergeChoice>,
  applied: MergeChange[], conflicts: MergeConflict[]) {
  const byId = (list: Item[]) => new Map(list.map(item => [item.id, item]));
  const b = byId(base), m = byId(mine), t = byId(theirs);
  // Theirs' order is the saved order; lines only I added follow in my order.
  const order = [...theirs.map(item => item.id), ...mine.map(item => item.id).filter(id => !t.has(id) && !b.has(id))];
  const result: Item[] = [];
  for (const id of new Set([...order, ...base.map(item => item.id)])) {
    const old = b.get(id), mineItem = m.get(id), theirsItem = t.get(id);
    const name = itemName(mineItem, theirsItem, old);
    // Presence: a line added, kept or removed.
    if (!old) {
      if (mineItem && theirsItem && !same(mineItem, theirsItem)) {
        const key = `item:${id}`;
        if (choices[key]) { result.push(structuredClone(choices[key] === 'mine' ? mineItem : theirsItem)); continue; }
        conflicts.push({ key, label: `Line ${name}`, mine: mineItem, theirs: theirsItem });
        result.push(structuredClone(theirsItem));
        continue;
      }
      const added = mineItem ?? theirsItem;
      if (added) {
        result.push(structuredClone(added));
        if (!mineItem) applied.push({ key: `item:${id}`, label: `Added line ${name}` });
      }
      continue;
    }
    if (!mineItem || !theirsItem) {
      const remaining = mineItem ?? theirsItem;
      // Both removed it, or one removed an unchanged line: it stays removed.
      if (!remaining || same(remaining, old)) {
        if (!theirsItem && mineItem) applied.push({ key: `item:${id}`, label: `Removed line ${name}` });
        continue;
      }
      // One person removed a line the other changed.
      const key = `item:${id}`;
      if (choices[key]) {
        const keep = choices[key] === 'mine' ? mineItem : theirsItem;
        if (keep) result.push(structuredClone(keep));
        continue;
      }
      conflicts.push({ key, label: `Line ${name}`, mine: mineItem ?? null, theirs: theirsItem ?? null });
      if (theirsItem) result.push(structuredClone(theirsItem));
      continue;
    }
    const next: Item = structuredClone(theirsItem);
    const takenFrom: Record<'financial' | 'name', 'mine' | 'theirs'> = { financial: 'theirs', name: 'theirs' };
    for (const [part, read, label] of [
      ['financial', itemFinancial, `Price and sharing of ${name}`],
      ['name', itemDescriptive, `Description of ${name}`],
    ] as const) {
      const key = `item:${id}:${part}`;
      const outcome = threeWay(read(old), read(mineItem), read(theirsItem));
      let value: Value | undefined;
      if ('conflict' in outcome) {
        if (choices[key]) { value = read(choices[key] === 'mine' ? mineItem : theirsItem); takenFrom[part] = choices[key]; }
        else { conflicts.push({ key, label, mine: read(mineItem), theirs: read(theirsItem) }); value = read(theirsItem); }
      } else {
        value = outcome.value;
        if (outcome.changedBy === 'theirs') applied.push({ key, label });
        else if (outcome.changedBy !== 'none') takenFrom[part] = 'mine';
      }
      for (const field of Object.keys({ ...read(old), ...read(mineItem), ...read(theirsItem) })) delete next[field];
      assign(next, value ?? {});
    }
    const sources = { ...(theirsItem.fieldSources as Value | undefined) };
    for (const [field, source] of Object.entries((mineItem.fieldSources as Value | undefined) ?? {})) {
      if (takenFrom[ITEM_DESCRIPTIVE.has(field) ? 'name' : 'financial'] === 'mine') sources[field] = source;
    }
    if (Object.keys(sources).length) next.fieldSources = sources; else delete next.fieldSources;
    // Item discussions are append-only.
    const messages = [...(theirsItem.conversation as { id: string }[] | undefined) ?? []];
    for (const message of (mineItem.conversation as { id: string }[] | undefined) ?? []) {
      if (!messages.some(value => value.id === message.id)) messages.push(message);
    }
    if (messages.length) next.conversation = messages;
    result.push(next);
  }
  const ids = (list: Item[]) => list.map(item => item.id);
  const finalOrder = mergeOrder(ids(base), ids(mine), ids(theirs), new Set(ids(result)), choices, applied, conflicts);
  const merged = new Map(result.map(item => [item.id, item]));
  return finalOrder.map(id => merged.get(id)!);
}

/**
 * Merge `mine` onto `theirs`. With `choices`, conflicts named by key are
 * resolved and no longer reported. The result keeps the editor-only keys
 * from `mine`.
 */
export function mergeExpenseEdits<T extends object>(base: object, mine: T, theirs: object,
  choices: Record<string, MergeChoice> = {}): ExpenseMerge<T> {
  const b = base as Value, m = mine as Value, t = theirs as Value;
  const merged: Value = structuredClone(t);
  const applied: MergeChange[] = [], conflicts: MergeConflict[] = [];
  const taken: Record<string, 'mine' | 'theirs'> = {};
  const resolve = (key: string, label: string, fields: string[]) => {
    const outcome = threeWay(pick(b, fields), pick(m, fields), pick(t, fields));
    let source: 'mine' | 'theirs';
    if ('conflict' in outcome) {
      if (choices[key]) source = choices[key];
      else { conflicts.push({ key, label, mine: fields.length === 1 ? m[fields[0]] : pick(m, fields), theirs: fields.length === 1 ? t[fields[0]] : pick(t, fields) }); source = 'theirs'; }
    } else {
      source = outcome.changedBy === 'mine' || outcome.changedBy === 'both-same' ? 'mine' : 'theirs';
      if (outcome.changedBy === 'theirs') applied.push({ key, label });
    }
    assign(merged, pick(source === 'mine' ? m : t, fields));
    for (const field of fields) taken[field] = source;
  };
  for (const group of GROUPS) resolve(group.key, group.label, group.fields);
  const grouped = new Set(GROUPS.flatMap(group => group.fields));
  for (const key of new Set([...Object.keys(b), ...Object.keys(m), ...Object.keys(t)])) {
    if (grouped.has(key) || SPECIAL_KEYS.has(key) || EDITOR_KEYS.has(key)) continue;
    resolve(key, LABELS[key] ?? key, [key]);
  }

  merged.items = mergeItems((b.items as Item[]) ?? [], (m.items as Item[]) ?? [], (t.items as Item[]) ?? [], choices, applied, conflicts);

  // A whole-receipt percentage split replaces item allocations. Switching
  // split mode while the other person re-allocated lines cannot be combined.
  const modeChangedBy = !same(b.percentages, m.percentages) ? 'mine' : !same(b.percentages, t.percentages) ? 'theirs' : null;
  if (modeChangedBy && !conflicts.some(conflict => conflict.key === 'split-mode') && !choices['split-mode']) {
    const otherItems = modeChangedBy === 'mine' ? t.items : m.items;
    const reallocated = ((otherItems as Item[]) ?? []).some(item => {
      const old = ((b.items as Item[]) ?? []).find(value => value.id === item.id);
      return old && !same(itemFinancial(old), itemFinancial(item));
    });
    if (reallocated && !same(m.percentages, t.percentages)) {
      conflicts.push({ key: 'split-mode', label: 'Whole-receipt percentages', mine: m.percentages ?? null, theirs: t.percentages ?? null });
    }
  }

  // Receipt evidence: if both changed it, the newer saved evidence wins.
  const scan = threeWay(b.receiptScan, m.receiptScan, t.receiptScan);
  if ('conflict' in scan) merged.receiptScan = structuredClone(t.receiptScan);
  else if (scan.value === undefined) delete merged.receiptScan; else merged.receiptScan = structuredClone(scan.value);
  // A review acknowledgement is bound to a fingerprint of the lines, so a
  // merge that changes them makes Save ask for that review again.

  // Provenance follows the value taken for each field.
  const sources = { ...(t.fieldSources as Value | undefined) };
  for (const [field, source] of Object.entries((m.fieldSources as Value | undefined) ?? {})) {
    if (taken[field] !== 'theirs') sources[field] = source;
  }
  if (Object.keys(sources).length) merged.fieldSources = sources; else delete merged.fieldSources;

  const messages = [...(t.conversation as { id: string }[] | undefined) ?? []];
  for (const message of (m.conversation as { id: string }[] | undefined) ?? []) {
    if (!messages.some(value => value.id === message.id)) messages.push(message);
  }
  if (messages.length) merged.conversation = messages; else delete merged.conversation;

  for (const key of EDITOR_KEYS) { if (key in m) merged[key] = structuredClone(m[key]); else delete merged[key]; }
  return { merged: merged as T, applied, conflicts };
}
