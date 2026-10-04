import type { Ledger, Trip } from './model';

export type LedgerConflict = { tripId: string; entityType: string; entityId: string };
function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
}
export function equalSavedValue(a: unknown, b: unknown) { return stable(a) === stable(b); }
export function equalFinancialValue(a: unknown, b: unknown) {
  const omitConversation = (value: unknown) => {
    if (!value || typeof value !== 'object') return value;
    const result = { ...value as Record<string, unknown> };
    delete result.conversation;
    return result;
  };
  return equalSavedValue(omitConversation(a), omitConversation(b));
}

// Apply only the user's changes to fresh data. A changed entity is never silently
// overwritten. Receipt messages are append-only and can merge independently.
export function rebaseLedger(base: Ledger, local: Ledger, remote: Ledger): { data: Ledger; conflicts: LedgerConflict[] } {
  const conflicts: LedgerConflict[] = [];
  const data = structuredClone(remote);
  const conflict = (tripId: string, entityType: string, entityId: string) => conflicts.push({ tripId, entityType, entityId });
  for (const id of new Set([...base.trips.map(t => t.id), ...local.trips.map(t => t.id)])) {
    const before = base.trips.find(t => t.id === id), proposed = local.trips.find(t => t.id === id), current = data.trips.find(t => t.id === id);
    if (equalSavedValue(before, proposed)) continue;
    if (!before) {
      if (!current) data.trips.push(structuredClone(proposed!));
      else if (!equalSavedValue(current, proposed)) conflict(id, 'trip', id);
      continue;
    }
    if (!proposed || !current) {
      if (equalSavedValue(current, before)) data.trips = data.trips.filter(t => t.id !== id);
      else if (!equalSavedValue(current, proposed)) conflict(id, 'trip', id);
      continue;
    }
    const arrays = ['members', 'expenses', 'payments', 'drafts'] as const;
    const next = structuredClone(current);
    for (const key of new Set([...Object.keys(before), ...Object.keys(proposed)])) {
      if ((arrays as readonly string[]).includes(key)) continue;
      const b = (before as unknown as Record<string, unknown>)[key], l = (proposed as unknown as Record<string, unknown>)[key], r = (current as unknown as Record<string, unknown>)[key];
      if (equalSavedValue(b, l)) continue;
      if (!equalSavedValue(b, r) && !equalSavedValue(l, r)) conflict(id, 'trip', id);
      else (next as unknown as Record<string, unknown>)[key] = l;
    }
    for (const kind of arrays) {
      const b = before[kind] as { id: string; conversation?: { id: string }[] }[], l = proposed[kind] as typeof b, r = current[kind] as typeof b;
      let result = structuredClone(r);
      for (const entityId of new Set([...b.map(v => v.id), ...l.map(v => v.id)])) {
        const old = b.find(v => v.id === entityId), edit = l.find(v => v.id === entityId), saved = r.find(v => v.id === entityId);
        if (equalSavedValue(old, edit)) continue;
        if (!edit) {
          if (!equalSavedValue(old, saved) && saved) conflict(id, kind, entityId);
          else result = result.filter(v => v.id !== entityId);
          continue;
        }
        if (!saved) {
          if (old) conflict(id, kind, entityId);
          else result = kind === 'expenses' ? [structuredClone(edit), ...result] : [...result, structuredClone(edit)];
          continue;
        }
        if (!equalFinancialValue(old, saved) && !equalFinancialValue(old, edit) && !equalFinancialValue(edit, saved)) {
          conflict(id, kind, entityId);
          continue;
        }
        const merged = structuredClone(equalFinancialValue(old, edit) ? saved : edit);
        const messages = [...saved.conversation || []];
        for (const message of edit.conversation || []) {
          const existing = messages.find(value => value.id === message.id);
          if (existing && !equalSavedValue(existing, message)) conflict(id, kind, entityId);
          else if (!existing) messages.push(message);
        }
        if (messages.length) merged.conversation = messages;
        result = result.map(v => v.id === entityId ? merged : v);
      }
      (next as unknown as Record<string, unknown>)[kind] = result;
    }
    data.trips = data.trips.map(t => t.id === id ? next as Trip : t);
  }
  return { data, conflicts };
}
