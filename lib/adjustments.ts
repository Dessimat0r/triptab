import { z } from 'zod';

/**
 * Discounts and charges as separate records (F-02, D01). Item prices stay as
 * printed; an item-scoped discount reduces only its qualifying lines, so its
 * saving only reaches the people sharing those lines. All amounts are integer
 * minor units.
 *
 * Order of application:
 * 1. Item-scoped adjustments, in list order. A fixed amount is spread over its
 *    lines in proportion to their printed prices (equal prices get equal
 *    parts; remainder pennies follow line order), unless a manual allocation
 *    names each line's part. A percentage applies to each line's current net
 *    price.
 * 2. Receipt-wide adjustments, in list order. A percentage applies to the net
 *    item subtotal. Their effect is shared like tax and tip: in proportion to
 *    each person's net items.
 */

const MAX_AMOUNT = 100000000;
const id = z.string().min(1).max(100);

export const adjustmentSchema = z.object({
  id,
  kind: z.enum(['discount', 'charge']),
  label: z.string().trim().max(80).optional(),
  /** Fixed amount in minor units. Exactly one of amount or percent. */
  amount: z.number().int().positive().max(MAX_AMOUNT).optional(),
  /** Percentage with at most two decimal places. */
  percent: z.number().positive().max(100).refine(value => Math.abs(Math.round(value * 100) - value * 100) < 1e-9, 'Use at most two decimal places').optional(),
  scope: z.discriminatedUnion('type', [
    z.object({ type: z.literal('receipt') }).strict(),
    z.object({ type: z.literal('items'), itemIds: z.array(id).min(1).max(200) }).strict(),
  ]),
  /** Manual split of an item-scoped fixed amount: line ID → minor units. */
  allocation: z.record(id, z.number().int().min(0).max(MAX_AMOUNT)).optional(),
  /** Zero-based receipt line this adjustment came from. One line maps to one adjustment. */
  sourceLineIndex: z.number().int().min(0).max(999).optional(),
  source: z.enum(['user', 'receipt']).optional(),
}).strict().superRefine((value, context) => {
  if ((value.amount === undefined) === (value.percent === undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'], message: 'Enter either an amount or a percentage' });
  }
  if (value.scope.type === 'items' && new Set(value.scope.itemIds).size !== value.scope.itemIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scope', 'itemIds'], message: 'Choose each item once' });
  }
  if (value.allocation && (value.scope.type !== 'items' || value.percent !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['allocation'], message: 'Only a fixed amount on chosen items can be split manually' });
  }
});
export type Adjustment = z.infer<typeof adjustmentSchema>;
export const adjustmentsSchema = z.array(adjustmentSchema).max(20);

type Line = { id?: string; amount: number | null };
export type AppliedAdjustment = { id: string; amount: number; allocation?: Record<string, number> };
export type AdjustmentResult = {
  /** Net price of each line, in input order. Unreadable lines stay null. */
  net: (number | null)[];
  /** Combined signed effect of receipt-wide adjustments. */
  receiptDelta: number;
  /** Resolved amount (and line parts) of every adjustment. */
  applied: AppliedAdjustment[];
  /** Problems that make the adjustments unusable for a saved expense. */
  errors: string[];
};

/** Largest remainder in integers; ties follow input order. */
function split(amount: number, weights: number[]): number[] {
  const sum = weights.reduce((total, weight) => total + weight, 0);
  if (!sum) return weights.map(() => 0);
  const exact = weights.map(weight => BigInt(amount) * BigInt(weight));
  const output = exact.map(value => Number(value / BigInt(sum)));
  let remaining = amount - output.reduce((total, value) => total + value, 0);
  const order = exact.map((value, index) => ({ index, remainder: value % BigInt(sum) }))
    .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  for (const { index } of order) { if (!remaining) break; output[index]++; remaining--; }
  return output;
}

/** Percent of a base, rounded half up, in integers. */
export function percentOf(base: number, percent: number): number {
  const basisPoints = BigInt(Math.round(percent * 100));
  return Number((BigInt(base) * basisPoints + BigInt(5000)) / BigInt(10000));
}

export function applyAdjustments(items: readonly Line[], adjustments: readonly Adjustment[] | undefined): AdjustmentResult {
  const net = items.map(item => item.amount);
  const applied: AppliedAdjustment[] = [];
  const errors: string[] = [];
  let receiptDelta = 0;
  if (!adjustments?.length) return { net, receiptDelta, applied, errors };
  const seenLines = new Set<number>();
  for (const adjustment of adjustments) {
    if (adjustment.sourceLineIndex !== undefined) {
      if (seenLines.has(adjustment.sourceLineIndex)) errors.push('A receipt line can only be applied once');
      seenLines.add(adjustment.sourceLineIndex);
    }
  }
  const sign = (adjustment: Adjustment) => adjustment.kind === 'discount' ? -1 : 1;
  const label = (adjustment: Adjustment) => adjustment.label || (adjustment.kind === 'discount' ? 'Discount' : 'Charge');
  for (const adjustment of adjustments.filter(value => value.scope.type === 'items')) {
    const scope = adjustment.scope as { type: 'items'; itemIds: string[] };
    const indexes = scope.itemIds.map(itemId => items.findIndex(item => item.id === itemId));
    if (indexes.some(index => index < 0)) { errors.push(`${label(adjustment)} applies to an item that is not on this receipt`); continue; }
    if (indexes.some(index => net[index] === null)) { applied.push({ id: adjustment.id, amount: 0 }); continue; }
    let parts: number[];
    if (adjustment.percent !== undefined) {
      parts = indexes.map(index => percentOf(net[index]!, adjustment.percent!));
    } else if (adjustment.allocation) {
      const keys = Object.keys(adjustment.allocation);
      if (keys.length !== scope.itemIds.length || keys.some(key => !scope.itemIds.includes(key))) {
        errors.push(`Give each chosen item a part of ${label(adjustment)}`); continue;
      }
      parts = scope.itemIds.map(itemId => adjustment.allocation![itemId]);
      if (parts.reduce((sum, part) => sum + part, 0) !== adjustment.amount) {
        errors.push(`The parts of ${label(adjustment)} must add up to its amount`); continue;
      }
    } else {
      // D01: in proportion to printed prices; equal prices share equally.
      const weights = indexes.map(index => items[index].amount!);
      if (!weights.some(Boolean)) { errors.push(`${label(adjustment)} applies only to free items`); continue; }
      parts = split(adjustment.amount!, weights);
    }
    if (sign(adjustment) < 0 && indexes.some((index, position) => parts[position] > net[index]!)) {
      errors.push(`${label(adjustment)} is more than the items it applies to`); continue;
    }
    indexes.forEach((index, position) => { net[index] = net[index]! + sign(adjustment) * parts[position]; });
    applied.push({ id: adjustment.id, amount: parts.reduce((sum, part) => sum + part, 0),
      allocation: Object.fromEntries(scope.itemIds.map((itemId, position) => [itemId, parts[position]])) });
  }
  const subtotal = () => net.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  for (const adjustment of adjustments.filter(value => value.scope.type === 'receipt')) {
    const base = subtotal() + receiptDelta;
    const amount = adjustment.percent !== undefined ? percentOf(Math.max(base, 0), adjustment.percent) : adjustment.amount!;
    if (sign(adjustment) < 0 && amount > base) { errors.push(`${label(adjustment)} is more than the receipt total`); continue; }
    receiptDelta += sign(adjustment) * amount;
    applied.push({ id: adjustment.id, amount });
  }
  return { net, receiptDelta, applied, errors };
}
