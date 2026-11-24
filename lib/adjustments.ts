import { z } from 'zod';
import { canonicalJson } from './data-utils';
import { offerRuleSchema, offerSaving } from './offer-rules';

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
const amounts = z.record(id, z.number().int().min(0).max(MAX_AMOUNT));
export const offerLetters = 'ABCDEFGHIJKLMNOPQRST'.split('');
export const nextOfferLetter = (adjustments: readonly Adjustment[]) => offerLetters.find(letter => !adjustments.some(value => value.group === letter));

export const adjustmentSchema = z.object({
  id,
  kind: z.enum(['discount', 'charge']),
  label: z.string().trim().max(80).optional(),
  /** Fixed amount in minor units. Exactly one of amount or percent. */
  amount: z.number().int().positive().max(MAX_AMOUNT).optional(),
  rule: offerRuleSchema.optional(),
  printedAmount: z.number().int().positive().max(MAX_AMOUNT).optional(),
  group: z.string().regex(/^[A-T]$/).optional(),
  stacking: z.boolean().optional(),
  rewardOnly: z.boolean().optional(),
  memberSplit: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('equal'), memberIds: z.array(id).min(1).max(50) }).strict(),
    z.object({ mode: z.literal('exact'), amounts }).strict(),
  ]).optional(),
  /** Percentage with at most two decimal places. */
  percent: z.number().positive().max(100).refine(value => Math.abs(Math.round(value * 100) - value * 100) < 1e-9, 'Use at most two decimal places').optional(),
  scope: z.discriminatedUnion('type', [
    z.object({ type: z.literal('receipt') }).strict(),
    z.object({ type: z.literal('items'), itemIds: z.array(id).min(1).max(200), portions: z.record(id, z.number().int().min(1).max(200)).optional() }).strict(),
  ]),
  /** Manual split of an item-scoped fixed amount: line ID → minor units. */
  allocation: z.record(id, z.number().int().min(0).max(MAX_AMOUNT)).optional(),
  /** Zero-based receipt line this adjustment came from. One line maps to one adjustment. */
  sourceLineIndex: z.number().int().min(0).max(999).optional(),
  /**
   * Who controls the record (R05). 'receipt': a reading's proposal that no
   * person has changed or confirmed; a later reading may replace it. Absent or
   * 'user': a person's record, which processing never replaces or rewrites.
   * The printed line it came from stays in sourceLineIndex either way.
   */
  source: z.enum(['user', 'receipt']).optional(),
}).strict().superRefine((value, context) => {
  if ([value.amount, value.percent, value.rule].filter(option => option !== undefined).length !== 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['amount'], message: 'Enter either an amount or a percentage, or choose an offer rule' });
  }
  if (value.scope.type === 'items' && new Set(value.scope.itemIds).size !== value.scope.itemIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scope', 'itemIds'], message: 'Choose each item once' });
  }
  if (value.allocation && (value.scope.type !== 'items' || value.percent !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['allocation'], message: 'Only a fixed amount on chosen items can be split manually' });
  }
  const scope = value.scope;
  if (scope.type === 'items' && Object.keys(scope.portions ?? {}).some(key => !scope.itemIds.includes(key))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scope'], message: 'Portions must belong to the chosen items' });
  }
  if ((value.group || value.rule?.buy || value.rewardOnly) && value.scope.type !== 'items' || value.rule && value.kind !== 'discount' || value.printedAmount !== undefined && !value.rule) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['scope'], message: 'Choose the items for this offer and use its printed amount only with a rule' });
  }
  if (value.memberSplit?.mode === 'equal' && new Set(value.memberSplit.memberIds).size !== value.memberSplit.memberIds.length || value.memberSplit?.mode === 'exact' && !Object.keys(value.memberSplit.amounts).length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['memberSplit'], message: 'Choose who shares this adjustment once each' });
  }
  if (value.rewardOnly && !value.rule?.cheapest) context.addIssue({ code: z.ZodIssueCode.custom, path: ['rewardOnly'], message: 'Choose an offer that discounts the cheapest portions' });
});
export type Adjustment = z.infer<typeof adjustmentSchema>;
export const adjustmentsSchema = z.array(adjustmentSchema).max(20);

/** Whether a person controls this record, so processing must keep it exactly (R05). */
export const personControlled = (adjustment: Pick<Adjustment, 'source'>) => adjustment.source !== 'receipt';

function sameRecord(left: Adjustment, right: Adjustment) {
  return canonicalJson({ ...left, source: undefined }) === canonicalJson({ ...right, source: undefined });
}

/**
 * A person's write that changes a reading's proposal takes control of it
 * (R05): amount, percentage, scope, allocation or label edited by a person is
 * theirs, with its printed-line evidence kept, and a record already theirs
 * stays theirs. Records with no earlier version
 * are left exactly as sent, so restoring or posting a saved draft is exact.
 */
export function claimEditedProposals(adjustments: readonly Adjustment[], earlier: ReadonlyMap<string, Adjustment>): Adjustment[] {
  return adjustments.map(adjustment => {
    if (adjustment.source !== 'receipt') return adjustment;
    const previous = earlier.get(adjustment.id);
    // A person's record also stays theirs if a stale copy sends it back as a proposal.
    return previous && (personControlled(previous) || !sameRecord(previous, adjustment)) ? { ...adjustment, source: 'user' as const } : adjustment;
  });
}

type Line = { id?: string; amount: number | null; quantity?: { total: number } };
export const enhancedAdjustment = (value: Adjustment) => Boolean(value.rule || value.group || value.memberSplit || value.scope.type === 'items' && value.scope.portions);
export type AppliedAdjustment = { id: string; amount: number; expected?: number; allocation?: Record<string, number>; members?: Record<string, number> };
export type AdjustmentResult = {
  /** Net price of each line, in input order. Unreadable lines stay null. */
  net: (number | null)[];
  /** Combined signed effect of receipt-wide adjustments. */
  receiptDelta: number;
  /** Resolved amount (and line parts) of every adjustment. */
  applied: AppliedAdjustment[];
  /** Problems that make the adjustments unusable for a saved expense. */
  errors: string[];
  /** Undo explicit allocations in the proportional base before debiting named people. */
  explicitItems: number[];
  explicitReceipt: number;
  explicitMembers: Map<string, number>;
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

export function applyAdjustments(items: readonly Line[], adjustments: readonly Adjustment[] | undefined, currency?: string | null): AdjustmentResult {
  const net = items.map(item => item.amount);
  const applied: AppliedAdjustment[] = [];
  const errors: string[] = [];
  let receiptDelta = 0;
  const explicitItems = items.map(() => 0);
  let explicitReceipt = 0;
  const explicitMembers = new Map<string, number>();
  const result = () => ({ net, receiptDelta, applied, errors, explicitItems, explicitReceipt, explicitMembers });
  if (!adjustments?.length) return result();
  const seenLines = new Set<number>();
  const seenIds = new Set<string>();
  const groups = new Map<string, string>();
  for (const adjustment of adjustments) {
    if (seenIds.has(adjustment.id)) errors.push('An adjustment can only be applied once');
    seenIds.add(adjustment.id);
    if (adjustment.sourceLineIndex !== undefined) {
      if (seenLines.has(adjustment.sourceLineIndex)) errors.push('A receipt line can only be applied once');
      seenLines.add(adjustment.sourceLineIndex);
    }
    if (adjustment.rule?.currency && currency && adjustment.rule.currency !== currency) errors.push('This saved offer uses a different currency');
    if (adjustment.group && adjustment.scope.type === 'items') {
      const scope = adjustment.scope;
      const key = canonicalJson(Object.fromEntries(scope.itemIds.map(id => [id, scope.portions?.[id] ?? null])));
      if (groups.has(adjustment.group) && groups.get(adjustment.group) !== key) errors.push(`Group ${adjustment.group} must cover the same portions on each discount`);
      groups.set(adjustment.group, key);
    }
  }
  const sign = (adjustment: Adjustment) => adjustment.kind === 'discount' ? -1 : 1;
  const label = (adjustment: Adjustment) => adjustment.label || (adjustment.kind === 'discount' ? 'Discount' : 'Charge');
  const memberParts = (adjustment: Adjustment, amount: number) => {
    const sharing = adjustment.memberSplit;
    if (!sharing) return undefined;
    const ids = sharing.mode === 'equal' ? sharing.memberIds : Object.keys(sharing.amounts);
    const values = sharing.mode === 'equal' ? split(amount, ids.map(() => 1)) : ids.map(key => sharing.amounts[key]);
    if (values.reduce((total, part) => total + part, 0) !== amount) {
      errors.push(`The people's shares of ${label(adjustment)} must add up to its amount`);
      return undefined;
    }
    return Object.fromEntries(ids.map((id, index) => [id, values[index]]));
  };
  const recordMembers = (adjustment: Adjustment, members: Record<string, number>) => {
    for (const [id, part] of Object.entries(members)) explicitMembers.set(id, (explicitMembers.get(id) ?? 0) + sign(adjustment) * part);
  };
  const usedPortions = new Map<number, number>();
  const enhancedLines = new Set<number>();
  const unitPrices = new Map<number, number[]>();
  for (const adjustment of adjustments.filter(value => value.scope.type === 'items')) {
    if (adjustment.scope.type !== 'items') continue;
    const scope = adjustment.scope;
    const indexes = scope.itemIds.map(itemId => items.findIndex(item => item.id === itemId));
    if (indexes.some(index => index < 0)) { errors.push(`${label(adjustment)} applies to an item that is not on this receipt`); continue; }
    if (indexes.some(index => net[index] === null)) { applied.push({ id: adjustment.id, amount: 0 }); continue; }
    let parts: number[];
    let expected: number | undefined;
    const used = new Map<number, number>();
    const selectedUnits = new Map<number, number[]>();
    if (adjustment.rule || scope.portions) {
      const priorErrors = errors.length;
      const portions: { line: number; price: number }[] = [];
      for (const index of indexes) {
        const line = items[index];
        const explicit = scope.portions?.[line.id!];
        const purchased = line.quantity?.total ?? 1;
        const count = Number.isSafeInteger(purchased) && purchased <= 1000000 ? purchased : 1;
        const selections = explicit ?? (adjustment.rule?.buy ? count : 1);
        const previous = usedPortions.get(index) ?? 0;
        const start = adjustment.stacking ? 0 : previous;
        const realUnits = explicit !== undefined || Boolean(adjustment.rule?.buy);
        if (explicit !== undefined && (!Number.isSafeInteger(purchased) || explicit > purchased) || realUnits && count > 200) {
          errors.push('Choose a valid number of qualifying portions'); continue;
        }
        if (adjustment.kind === 'discount' && !adjustment.stacking && (realUnits ? start + selections > count : previous > 0)) {
          errors.push(`Confirm that ${label(adjustment)} can overlap another offer, or choose different portions`); continue;
        }
        if (adjustment.kind === 'discount') used.set(index, realUnits ? Math.max(previous, start + selections) : count);
        const price = net[index]!;
        if (realUnits && !unitPrices.has(index)) unitPrices.set(index, split(price, Array(count).fill(1)));
        if (realUnits) selectedUnits.set(index, Array.from({ length: selections }, (_, position) => start + position));
        for (let j = 0; j < selections; j++) {
          portions.push({ line: index, price: realUnits ? unitPrices.get(index)![start + j] : price });
        }
      }
      if (!portions.length || errors.length !== priorErrors) continue;
      const prices = new Map<number, number>();
      for (const { line, price } of portions) prices.set(line, (prices.get(line) ?? 0) + price);
      const offer = adjustment.rule ? offerSaving(adjustment.rule, portions, percentOf) : undefined;
      if (offer && !offer.uses) { errors.push(`${label(adjustment)} needs more qualifying portions`); continue; }
      if (offer && adjustment.rule?.buy && (portions.length % adjustment.rule.buy !== 0 || adjustment.rule.limit && portions.length > adjustment.rule.limit * adjustment.rule.buy)) {
        errors.push(`${label(adjustment)} has extra portions. Choose only those used by the offer`); continue;
      }
      expected = offer?.amount;
      const reward = adjustment.rewardOnly && offer ? offer.rewards : prices;
      const weights = indexes.map(index => reward.get(index) ?? 0);
      const amount = adjustment.printedAmount ?? expected ?? adjustment.amount ?? percentOf([...prices.values()].reduce((sum, price) => sum + price, 0), adjustment.percent!);
      if (amount && (amount > weights.reduce((sum, weight) => sum + weight, 0)) && adjustment.kind === 'discount') {
        errors.push(`${label(adjustment)} is more than the qualifying portions`); continue;
      }
      parts = split(amount, weights);
    } else if (adjustment.percent !== undefined) {
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
    if (!adjustment.rule && !scope.portions && adjustment.kind === 'discount') indexes.forEach(index => {
      const count = items[index].quantity?.total ?? 1;
      if (usedPortions.has(index) && (adjustment.group || enhancedLines.has(index)) && !adjustment.stacking) errors.push(`Confirm that ${label(adjustment)} can overlap another offer, or choose different portions`);
      used.set(index, count);
    });
    for (const [index, count] of used) {
      usedPortions.set(index, count);
      if (enhancedAdjustment(adjustment)) enhancedLines.add(index);
    }
    const amount = parts.reduce((sum, part) => sum + part, 0);
    const members = memberParts(adjustment, amount);
    if (members) {
      indexes.forEach((index, position) => { explicitItems[index] += sign(adjustment) * parts[position]; });
      recordMembers(adjustment, members);
    }
    indexes.forEach((index, position) => {
      const delta = sign(adjustment) * parts[position];
      const prices = unitPrices.get(index);
      if (prices && delta) {
        const selected = selectedUnits.get(index) ?? prices.map((_, unit) => unit);
        const weights = selected.map(unit => prices[unit]);
        const units = split(Math.abs(delta), weights.some(Boolean) ? weights : weights.map(() => 1));
        selected.forEach((unit, part) => { prices[unit] += Math.sign(delta) * units[part]; });
      }
      net[index] = net[index]! + delta;
    });
    applied.push({ id: adjustment.id, amount, ...(expected === undefined ? {} : { expected }), ...(members ? { members } : {}),
      allocation: Object.fromEntries(scope.itemIds.map((itemId, position) => [itemId, parts[position]])) });
  }
  const subtotal = () => net.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  for (const adjustment of adjustments.filter(value => value.scope.type === 'receipt')) {
    const base = subtotal() + receiptDelta;
    const expected = adjustment.rule ? offerSaving(adjustment.rule, [{ line: 0, price: Math.max(base, 0) }], percentOf).amount : undefined;
    const amount = adjustment.printedAmount ?? expected ?? (adjustment.percent !== undefined ? percentOf(Math.max(base, 0), adjustment.percent) : adjustment.amount!);
    if (sign(adjustment) < 0 && amount > base) { errors.push(`${label(adjustment)} is more than the receipt total`); continue; }
    receiptDelta += sign(adjustment) * amount;
    const members = memberParts(adjustment, amount);
    if (members) { explicitReceipt += sign(adjustment) * amount; recordMembers(adjustment, members); }
    applied.push({ id: adjustment.id, amount, ...(expected === undefined ? {} : { expected }), ...(members ? { members } : {}) });
  }
  return result();
}
