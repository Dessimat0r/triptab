import { applyAdjustments, type Adjustment, type AdjustmentResult } from './adjustments';
import { shares, stampCalculationRules } from './model';
import type { ReceiptEditor } from './receipt-processing';

/**
 * The one ordered list a discount form previews, validates and saves (R03).
 *
 * Adjustments apply in list order, so a fixed amount and a percentage give
 * different totals depending on which comes first. An edited adjustment keeps
 * its original position; only a new one is appended. Building this list once
 * and reusing it everywhere is what keeps the preview equal to the saved entry.
 */
export function adjustmentCandidates(adjustments: readonly Adjustment[], candidate: Adjustment, editing?: string): Adjustment[] {
  const index = editing === undefined ? -1 : adjustments.findIndex(value => value.id === editing);
  return index < 0 ? [...adjustments, candidate] : adjustments.map((value, position) => position === index ? candidate : value);
}

export type AdjustmentPreview = {
  /** The list Save stores, or null while the form has no valid candidate. */
  list: Adjustment[] | null;
  before: AdjustmentResult;
  after: AdjustmentResult;
  /** The receipt total and each person's change, or null when the shares cannot be calculated. */
  outcome: { total: number; changes: { id: string; change: number }[] } | null;
};

type Member = { id: string; weight?: number };

/** Entry shares under the calculation rule a save would stamp now, not the rule it was opened with. */
function stampedShares(entry: ReceiptEditor, adjustments: Adjustment[], members: readonly Member[]): number[] {
  const stamped = stampCalculationRules({ ...entry, adjustments }, members);
  return shares(stamped, [...members]);
}

export function previewAdjustment(entry: ReceiptEditor, members: readonly Member[], candidate: Adjustment | null, editing?: string): AdjustmentPreview {
  const current = entry.adjustments ?? [];
  const others = current.filter(value => value.id !== editing);
  const before = applyAdjustments(entry.items, others);
  if (!candidate) return { list: null, before, after: before, outcome: null };
  const list = adjustmentCandidates(current, candidate, editing);
  const after = applyAdjustments(entry.items, list);
  let outcome: AdjustmentPreview['outcome'] = null;
  if (!after.errors.length && !entry.items.some(item => item.amount === null)) {
    try {
      // The comparison is the entry as it stands without this adjustment.
      const old = stampedShares(entry, others, members);
      const next = stampedShares(entry, list, members);
      const total = after.net.reduce<number>((sum, net) => sum + (net ?? 0), 0) + after.receiptDelta + entry.tax + entry.tip - entry.discount;
      outcome = { total, changes: members.map((member, index) => ({ id: member.id, change: next[index] - old[index] })).filter(value => value.change) };
    } catch { outcome = null; }
  }
  return { list, before, after, outcome };
}
