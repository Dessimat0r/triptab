import { z } from 'zod';
import { validCalendarDate } from './dates';
import { receiptMemorySchema } from './receipt-context';
import { receiptLocationSchema, receiptLocationHintSchema } from './receipt-location';
import { expenseIconSchema } from './expense-icons';
import { languageSchema, receiptLanguageSchema, itemTranslationsSchema } from './receipt-languages';
import { fieldSourcesSchema, itemFieldSourcesSchema, scanSourceSchema, receiptScanSchema,
  reconcileReceiptScan, receiptScanSaveError, receiptScanHumanReviewChanged } from './receipt-scan';

/** Deliberate, safe-to-show business-rule failures. Unexpected errors stay private. */
export class LedgerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerValidationError';
  }
}

export const CURRENCIES = [
  { code: 'GBP', name: 'British pound' },
  { code: 'EUR', name: 'Euro' },
  { code: 'CHF', name: 'Swiss franc' },
  { code: 'CZK', name: 'Czech koruna' },
  { code: 'DKK', name: 'Danish krone' },
  { code: 'HUF', name: 'Hungarian forint' },
  { code: 'ISK', name: 'Icelandic króna' },
  { code: 'NOK', name: 'Norwegian krone' },
  { code: 'PLN', name: 'Polish złoty' },
  { code: 'RON', name: 'Romanian leu' },
  { code: 'SEK', name: 'Swedish krona' },
  { code: 'TRY', name: 'Turkish lira' },
  { code: 'ALL', name: 'Albanian lek' },
  { code: 'BAM', name: 'Bosnia and Herzegovina convertible mark' },
  { code: 'MKD', name: 'Macedonian denar' },
  { code: 'MDL', name: 'Moldovan leu' },
  { code: 'RSD', name: 'Serbian dinar' },
  { code: 'UAH', name: 'Ukrainian hryvnia' },
  { code: 'GEL', name: 'Georgian lari' },
  { code: 'AMD', name: 'Armenian dram' },
  { code: 'AZN', name: 'Azerbaijani manat' },
  { code: 'BGN', name: 'Bulgarian lev (legacy receipts)' },
  { code: 'USD', name: 'US dollar' },
  { code: 'AUD', name: 'Australian dollar' },
  { code: 'CAD', name: 'Canadian dollar' },
] as const;

export type Currency = typeof CURRENCIES[number]['code'];
const currencySchema = z.enum(CURRENCIES.map(currency => currency.code) as [Currency, ...Currency[]]);
const id = z.string().min(1).max(100);
const accountId = z.string().min(1).max(512);
// Amounts stored in hundredths of a major currency unit for consistent receipt entry.
export const MAX_AMOUNT = 100000000;
const cents = z.number().int().min(0).max(MAX_AMOUNT);
const bankAmountSchema = cents.positive('The actual bank charge must be greater than zero');
const dateSchema = z.string().refine(validCalendarDate, 'Enter a valid calendar date');
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time as HH:mm');
// Constructing Intl.DateTimeFormat dominates validation of large ledgers, so
// remember accepted zones. Names are case-insensitive, so the cache is capped.
const MAX_CACHED_TIMEZONES = 1000;
const validTimezones = new Set<string>();
const timezoneSchema = z.string().min(1).max(100).refine(value => {
  if (validTimezones.has(value)) return true;
  if (/^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); }
  catch { return false; }
  if (validTimezones.size < MAX_CACHED_TIMEZONES) validTimezones.add(value);
  return true;
}, 'Choose a valid timezone');
export function validExchangeRate(rate: unknown): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0;
}
const fxSchema = z.object({
  rate: z.number().refine(validExchangeRate, 'Enter a positive, finite exchange rate'),
  asOf: dateSchema,
  source: z.enum(['reference', 'manual']),
});

function percentageError(percentages: Record<string, number>, label: string): string | null {
  const keys = Object.keys(percentages);
  if (!keys.length || keys.length > 50) return 'Choose between 1 and 50 people for the percentage split';
  if (keys.some(key => !key || key.length > 100)) return 'Check percentage assignments';
  let basisPoints = 0;
  for (const key of keys) {
    const value = percentages[key];
    if (!Number.isFinite(value) || value < 0 || value > 100) {
      return 'Percentages must be between 0 and 100';
    }
    const scaled = value * 100;
    const rounded = Math.round(scaled);
    if (Math.abs(scaled - rounded) > 1e-6) return 'Use at most two decimal places for percentages';
    basisPoints += rounded;
  }
  return basisPoints === 10000 ? null : `${label} percentages must add up to 100%`;
}

const percentagesSchema = z.record(id, z.number().finite().min(0).max(100)).superRefine((percentages, context) => {
  const message = percentageError(percentages, 'Receipt');
  if (message) context.addIssue({ code: z.ZodIssueCode.custom, message });
});

export const UNIT_SCALE = 1_000_000;
export const MAX_UNITS = 1_000_000;

/** Parse decimal quantities as integer millionths without floating tolerances. */
export function unitsScale(value: unknown): number | null {
  let whole: string;
  let fraction: string;
  let exponent = 0;
  if (typeof value === 'string') {
    const decimal = value.trim();
    if (decimal.length > 64 || !/^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(decimal)) return null;
    [whole, fraction = ''] = decimal.split('.');
    whole ||= '0';
  } else if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_UNITS) {
    const [mantissa, exponentText = '0'] = value.toString().toLowerCase().split('e');
    [whole, fraction = ''] = mantissa.split('.');
    exponent = Number(exponentText);
  } else return null;
  const precision = fraction.length - exponent;
  if (precision > 6) return null;
  const scaled = BigInt(whole + fraction) * (BigInt(10) ** BigInt(6 - precision));
  if (scaled > BigInt(MAX_UNITS) * BigInt(UNIT_SCALE)) return null;
  return Number(scaled);
}

const quantitySchema = z.number().refine(value => unitsScale(value) !== null,
  'Use a quantity between 0 and 1,000,000 with at most six decimal places');
// Purchased quantity is receipt evidence, independent of who owes its cost.
export const receiptQuantitySchema = z.object({
  total: quantitySchema.refine(value => value > 0, 'Receipt quantity must be greater than zero'),
  label: z.string().trim().min(1).max(40).optional(),
  sourceText: z.string().trim().min(1).max(200).optional(),
}).strict();
export type ItemQuantity = z.infer<typeof receiptQuantitySchema>;
const rawUnitsSchema = z.object({
  total: quantitySchema.refine(value => value > 0, 'Total units must be greater than zero'),
  allocations: z.record(id, quantitySchema),
  label: z.string().trim().min(1).max(40).optional(),
}).strict();
export type ItemUnits = z.infer<typeof rawUnitsSchema>;
// A scan can know the purchased quantity before any traveller has claimed it.
// Draft allocations may therefore be pending; the posted item schema stays strict.
export const draftUnitsSchema = rawUnitsSchema;

function unitAllocationError(units: ItemUnits): string | null {
  if (!units || typeof units !== 'object' || Array.isArray(units)
    || !units.allocations || typeof units.allocations !== 'object' || Array.isArray(units.allocations)) {
    return 'Set the total units and each person’s allocated units';
  }
  const total = typeof units.total === 'number' ? unitsScale(units.total) : null;
  if (total === null || total <= 0) return 'Total units must be greater than zero, no more than 1,000,000, and use at most six decimal places';
  if (units.label !== undefined && (typeof units.label !== 'string' || !units.label.trim() || units.label.trim().length > 40)) {
    return 'Use a unit name between 1 and 40 characters';
  }
  const quantities = Object.values(units.allocations);
  if (!quantities.length || quantities.length > 50) return 'Choose between 1 and 50 people for the unit split';
  let assigned = BigInt(0);
  for (const quantity of quantities) {
    const scaled = typeof quantity === 'number' ? unitsScale(quantity) : null;
    if (scaled === null) return 'Allocated units must be between 0 and 1,000,000 with at most six decimal places';
    assigned += BigInt(scaled);
  }
  if (!assigned) return 'Assign some units to at least one selected person';
  return assigned === BigInt(total) ? null : `Assigned units must add up to the item’s total (${units.total})`;
}

export const unitsSchema = rawUnitsSchema.superRefine((units, context) => {
  const message = unitAllocationError(units);
  if (message) context.addIssue({ code: z.ZodIssueCode.custom, path: ['allocations'], message });
});

const receiptMessageSchema = z.object({
  id,
  role: z.enum(['user', 'assistant']),
  text: z.string().trim().min(1).max(4000),
  createdAt: z.string().datetime({ offset: true }),
  replyTo: id.optional(),
  itemId: id.optional(),
  authorMemberId: id.optional(),
  authorName: z.string().trim().max(80).optional(),
});
export type ReceiptMessage = z.infer<typeof receiptMessageSchema>;
const conversationSchema = z.array(receiptMessageSchema).max(100).superRefine((messages, context) => {
  const seen = new Set<string>();
  const questions = new Set(messages.filter(message => message.role === 'user').map(message => message.id));
  messages.forEach((message, index) => {
    if (seen.has(message.id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'id'], message: 'Duplicate receipt message IDs' });
    }
    seen.add(message.id);
    if (message.role === 'assistant' && message.replyTo !== undefined && !questions.has(message.replyTo)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'replyTo'], message: 'Receipt replies must refer to a question in this conversation' });
    }
  });
});

const rawItemSchema = z.object({
  id, name: z.string().min(1).max(200), amount: cents, members: z.array(id).min(1).max(50),
  nameLanguage:languageSchema.optional(), translations:itemTranslationsSchema.optional(),
  quantity: receiptQuantitySchema.optional(),
  percentages: z.record(id, z.number().finite().min(0).max(100)).optional(),
  units: unitsSchema.optional(),
  scanSource: scanSourceSchema.optional(),
  fieldSources: itemFieldSourcesSchema.optional(),
});
export type Item = z.infer<typeof rawItemSchema>;
export const draftItemSchema = rawItemSchema.extend({
  name: z.string().max(200), amount: cents.nullable(), members: z.array(id).max(50),
  units: draftUnitsSchema.optional(),
}).superRefine((item, context) => {
  const message = item.members.length ? itemSplitError(item)
    : item.units && Object.keys(item.units.allocations).length ? 'Choose people before assigning units'
      : item.percentages && Object.keys(item.percentages).length ? 'Choose people before assigning percentages' : null;
  if (message) context.addIssue({ code: z.ZodIssueCode.custom, path: ['members'], message });
});
export type DraftItem = z.infer<typeof draftItemSchema>;

export function itemUnitsError(item: Pick<Item, 'members' | 'units' | 'percentages'>): string | null {
  if (item.units === undefined) return null;
  if (item.percentages !== undefined) return 'Choose either percentages or units for this item';
  const message = unitAllocationError(item.units);
  if (message) return message;
  const keys = Object.keys(item.units.allocations);
  if (keys.length !== item.members.length || keys.some(key => !item.members.includes(key))) {
    return 'Set a unit allocation for each selected person only';
  }
  return null;
}

/** A receipt item's split describes who owes its cost, independently of the payer. */
export function itemSplitError<T extends Pick<Item, 'members' | 'units' | 'percentages'>>(item: T): string | null {
  if (!item.members.length) return 'Choose at least one person for each item';
  if (new Set(item.members).size !== item.members.length || item.members.some(member => !member)) {
    return 'Check item assignments';
  }
  if (item.units !== undefined) return itemUnitsError(item);
  if (item.percentages === undefined) return null;
  const keys = Object.keys(item.percentages);
  if (keys.length !== item.members.length || keys.some(key => !item.members.includes(key))) {
    return 'Set a percentage for each selected person only';
  }
  return percentageError(item.percentages, 'Item');
}

export const itemSchema = rawItemSchema.superRefine((item, context) => {
  const message = itemSplitError(item);
  if (message) context.addIssue({ code: z.ZodIssueCode.custom, path: [item.units === undefined ? 'percentages' : 'units'], message });
});
const expenseItemSchema = rawItemSchema.extend({
  members: z.array(id).max(50), units: draftUnitsSchema.optional(),
});
// The calculation rule a saved receipt follows. Absent: adjustments on zero-priced
// items include every traveller. 'selected-participants': only people selected on
// items, with each item rounded to whole cents separately. 'receipt-total': as
// before, but the receipt total is rounded once against everyone's exact share.
const calculationRuleSchema = z.enum(['selected-participants', 'receipt-total']);
const expenseBaseSchema = z.object({
  location: receiptLocationSchema.optional(), locationHint: receiptLocationHintSchema.optional(),
  id, title: z.string().min(1).max(200), date: dateSchema,
  icon: expenseIconSchema.optional(),
  receiptLanguage:receiptLanguageSchema.optional(), detectedLanguage:languageSchema.optional(),
  languageViewId:id.optional(),
  // Provenance may reference a consumed or deleted draft retained in history.
  sourceDraftId: id.optional(),
  time: timeSchema.default('12:00'), timezone: timezoneSchema.default('Europe/London'),
  currency: currencySchema.default('EUR'), fx: fxSchema.optional(), bankAmount: bankAmountSchema.optional(),
  payer: id, items: z.array(expenseItemSchema).min(1).max(200),
  percentages: percentagesSchema.optional(),
  adjustmentAllocation: calculationRuleSchema.optional(),
  source: z.enum(['manual', 'ai']).optional(),
  receiptScan: receiptScanSchema.optional(), fieldSources: fieldSourcesSchema.optional(),
  conversation: conversationSchema.optional(),
  memory: receiptMemorySchema.optional(),
  tax: cents, tip: cents, discount: cents, receiptId: id.optional(),
});
function expenseItemAllocationValidation(expense: { items: Item[]; percentages?: Record<string, number> }, context: z.RefinementCtx) {
  // A valid receipt-wide percentage split is itself the cost allocation. Keep
  // any unclaimed item quantities as evidence instead of inventing eaters.
  expense.items.forEach((item, index) => {
    if (expense.percentages !== undefined && !item.members.length
      && !Object.keys(item.percentages || {}).length && !Object.keys(item.units?.allocations || {}).length) return;
    const parsed = itemSchema.safeParse(item);
    if (!parsed.success) for (const issue of parsed.error.issues) {
      context.addIssue({ ...issue, path: ['items', index, ...issue.path] });
    }
  });
}
export const expenseSchema = expenseBaseSchema.superRefine(expenseItemAllocationValidation);
export const draftSchema = z.object({
  location: receiptLocationSchema.optional(), locationHint: receiptLocationHintSchema.optional(),
  id, title: z.string().max(200), receiptId: id.optional(), expenseId: id.optional(),
  icon: expenseIconSchema.optional(),
  receiptLanguage:receiptLanguageSchema.optional(), detectedLanguage:languageSchema.optional(),
  languageViewId:id.optional(),
  currency: currencySchema.nullable().default('EUR'),
  date: dateSchema.optional(), time: timeSchema.optional(), timezone: timezoneSchema.optional(),
  fx: fxSchema.optional(), bankAmount: bankAmountSchema.optional(),
  percentages: percentagesSchema.optional(),
  adjustmentAllocation: calculationRuleSchema.optional(),
  source: z.enum(['manual', 'ai']).optional(),
  receiptScan: receiptScanSchema.optional(), fieldSources: fieldSourcesSchema.optional(),
  conversation: conversationSchema.optional(),
  memory: receiptMemorySchema.optional(),
  items: z.array(draftItemSchema).max(200), tax: cents, tip: cents, discount: cents,
  payer: id, status: z.enum(['waiting', 'review']),
});
export const paymentSchema = z.object({
  id, from: id, to: id, amount: cents, date: dateSchema,
  time: timeSchema.optional(), timezone: timezoneSchema.optional(),
  method: z.string().trim().max(80).optional(),
  note: z.string().trim().max(500).optional(),
});
const memberSchema = z.object({ id, name: z.string().trim().min(1).max(50), userId: accountId.optional(), email: z.string().email().optional() });
export const tripSchema = z.object({
  id, ownerId: accountId.optional(), name: z.string().min(1).max(100), currency: currencySchema,
  receiptLanguage:receiptLanguageSchema.optional(),
  startDate: dateSchema.optional(), endDate: dateSchema.optional(),
  members: z.array(memberSchema).min(1).max(50),
  expenses: z.array(expenseSchema).max(1000), drafts: z.array(draftSchema).max(100),
  payments: z.array(paymentSchema).max(1000),
});
export const ledgerSchema = z.object({ trips: z.array(tripSchema).max(50) });
export type Expense = z.infer<typeof expenseSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type Payment = z.infer<typeof paymentSchema>;
export type Trip = z.infer<typeof tripSchema>;
export type Ledger = z.infer<typeof ledgerSchema>;

// Stored ledgers may contain fields that were valid before stronger economic
// rules were added. Parsing must keep their values so users can review and fix
// them; only a trusted prior database snapshot may exempt an unchanged record
// during a write. This schema must never be used as final mutation validation.
const storedTripSchema = tripSchema.extend({
  members: z.array(memberSchema.extend({ name: z.string().min(1).max(50) })).min(1).max(50),
  expenses: z.array(expenseBaseSchema.extend({ bankAmount: cents.optional() }).superRefine(expenseItemAllocationValidation)).max(1000),
  drafts: z.array(draftSchema.extend({ bankAmount: cents.optional() })).max(100),
});
const storedLedgerSchema = z.object({ trips: z.array(storedTripSchema).max(50) });

export function parseStoredTrip(data: unknown): Trip {
  return storedTripSchema.parse(data);
}

export function parseLedgerStructure(data: unknown): Ledger {
  return storedLedgerSchema.parse(data);
}

function sameStoredValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameStoredValue(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord).filter(key => leftRecord[key] !== undefined);
  const otherKeys = Object.keys(rightRecord).filter(key => rightRecord[key] !== undefined);
  return keys.length === otherKeys.length && keys.every(key => otherKeys.includes(key) && sameStoredValue(leftRecord[key], rightRecord[key]));
}

export function receiptSplitError(expense: Pick<Expense, 'percentages'>): string | null {
  return expense.percentages === undefined ? null : percentageError(expense.percentages, 'Receipt');
}

export function validateLedger(data: unknown, options: { previous?: Ledger; source?: 'web' | 'mcp' } = {}): Ledger {
  // `previous` is a server-side compatibility boundary, never request input.
  // New records and every changed record still use the strict schemas/rules.
  const previous = options.previous && parseLedgerStructure(options.previous);
  const ledger = previous ? parseLedgerStructure(data) : ledgerSchema.parse(data);
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(ledger.trips.map(trip => trip.id))) throw new LedgerValidationError('Duplicate trips');
  for (const trip of ledger.trips) {
    const prior = previous?.trips.find(value => value.id === trip.id);
    if (trip.startDate && trip.endDate && trip.endDate < trip.startDate) {
      throw new LedgerValidationError('Holiday end date must be on or after its start date');
    }
    const memberIds = new Set(trip.members.map(member => member.id));
    const namesUnchanged = !!prior && prior.members.length === trip.members.length
      && trip.members.every(member => prior.members.some(old => old.id === member.id && old.name === member.name));
    const memberNames = new Set<string>();
    for (const member of trip.members) {
      const old = prior?.members.find(value => value.id === member.id);
      if (!old || old.name !== member.name) member.name = memberSchema.shape.name.parse(member.name);
      const name = member.name.trim().toLowerCase();
      if (!namesUnchanged && memberNames.has(name)) throw new LedgerValidationError(`Traveller names must be unique. “${member.name}” is repeated; add a surname or nickname.`);
      memberNames.add(name);
    }
    if (memberIds.size !== trip.members.length
      || !unique([...trip.expenses, ...trip.drafts].map(expense => expense.id))
      || !unique(trip.payments.map(payment => payment.id))) throw new LedgerValidationError('Duplicate IDs');
    const expenseIds = new Set(trip.expenses.map(expense => expense.id));
    const draftTargets = trip.drafts.flatMap(draft => draft.expenseId === undefined ? [] : [draft.expenseId]);
    if (draftTargets.some(expenseId => !expenseIds.has(expenseId))) {
      throw new LedgerValidationError('Receipt draft targets an expense that is not in this trip');
    }
    if (!unique(draftTargets)) throw new LedgerValidationError('An expense can only have one pending receipt draft');
    const unchanged = new Set<Expense | Draft>();
    if (prior?.currency === trip.currency) {
      for (const entry of trip.expenses) if (sameStoredValue(entry, prior.expenses.find(old => old.id === entry.id))) unchanged.add(entry);
      for (const entry of trip.drafts) if (sameStoredValue(entry, prior.drafts.find(old => old.id === entry.id))) unchanged.add(entry);
    }
    for (const expense of [...trip.expenses, ...trip.drafts]) {
      if (!unchanged.has(expense)) {
        if ('status' in expense) draftSchema.parse(expense);
        else expenseSchema.parse(expense);
        // Keep the old absence on untouched historical records. An explicitly
        // saved new/modified record adopts the current calculation rule.
        expense.adjustmentAllocation = 'receipt-total';
        const old = [...(prior?.expenses || []), ...(prior?.drafts || [])].find(value => value.id === expense.id);
        if (options.source === 'mcp' && receiptScanHumanReviewChanged(expense, old)) {
          throw new LedgerValidationError('Receipt scan warnings and differences must be reviewed in TripTab by a person.');
        }
        if (expense.receiptScan) expense.receiptScan = reconcileReceiptScan(expense);
        if (!('status' in expense)) {
          const scanError = receiptScanSaveError(expense, { allowAcknowledgement: options.source !== 'mcp', previous: old });
          if (scanError) throw new LedgerValidationError(scanError);
        }
      }
      if (!unchanged.has(expense) && expense.currency === trip.currency && expense.bankAmount !== undefined) {
        throw new LedgerValidationError('Remove the bank charge when the receipt and settlement currencies are the same');
      }
      if (!memberIds.has(expense.payer)) throw new LedgerValidationError('Choose a trip member as payer');
      if (expense.percentages && Object.keys(expense.percentages).some(member => !memberIds.has(member))) {
        throw new LedgerValidationError('Check receipt percentage assignments');
      }
      if (!unique(expense.items.map(item => item.id))) throw new LedgerValidationError('Duplicate item IDs');
      for (const item of expense.items) {
        if (!unique(item.members) || item.members.some(member => !memberIds.has(member))) {
          throw new LedgerValidationError('Check item assignments');
        }
      }
      if (total(expense) < 0) {
        throw new LedgerValidationError('Discount exceeds total');
      }
    }
    for (const expense of trip.expenses) {
      if (unchanged.has(expense)) continue;
      if (expense.currency !== trip.currency && expense.bankAmount === undefined && !expense.fx) {
        throw new LedgerValidationError('Add an exchange rate or the actual bank charge for this currency');
      }
      expenseTotal(expense, trip.currency);
    }
    for (const payment of trip.payments) {
      if (!memberIds.has(payment.from) || !memberIds.has(payment.to)
        || payment.from === payment.to || !payment.amount) throw new LedgerValidationError('Invalid payment');
    }
  }
  return ledger;
}

/**
 * Largest-remainder allocation keeps every penny and resolves exact ties by
 * input order. Items use their selected-person order; receipt percentages use
 * their stored key order; adjustments/conversion use trip-member order. The
 * receipt-total rule rounds once per receipt, with ties following the order
 * people were first selected on its items.
 * Changing the tie policy needs a versioned calculation rule, because applying
 * a rotation to old receipts would change historical balances on the next read.
 */
export function allocate(amount: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(amount) || amount < 0 || weights.some(weight => !Number.isFinite(weight) || weight < 0)) {
    throw new Error('Allocation needs a non-negative whole amount and finite weights');
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum)) throw new Error('Allocation weights are out of range');
  if (!sum) return weights.map(() => 0);
  // Receipt shares are integer weights. Exact remainders avoid floating-point ties
  // and preserve cents even for unusually large currency conversions.
  if (weights.every(Number.isSafeInteger)) return allocateExact(amount, weights.map(weight => BigInt(weight)));
  const raw = weights.map(weight => amount * (weight / sum));
  const output = raw.map(Math.floor);
  const remaining = amount - output.reduce((a, b) => a + b, 0);
  const order = raw.map((value, index) => ({ index, remainder: value - output[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remaining; index++) output[order[index % order.length].index]++;
  return output;
}

function allocateExact(amount: number, weights: bigint[], tieOrder: number[] = weights.map((_, index) => index)): number[] {
  const denominator = weights.reduce((value, weight) => value + weight, BigInt(0));
  if (!denominator) return weights.map(() => 0);
  const numerators = weights.map(weight => BigInt(amount) * weight);
  const output = numerators.map(value => Number(value / denominator));
  const remaining = amount - output.reduce((a, b) => a + b, 0);
  const order = numerators.map((value, index) => ({ index, remainder: value % denominator }))
    .sort((a, b) => a.remainder === b.remainder ? tieOrder[a.index] - tieOrder[b.index] : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; index < remaining; index++) output[order[index].index]++;
  return output;
}

type OriginalAmounts = Pick<Expense, 'tax' | 'tip' | 'discount' | 'percentages' | 'adjustmentAllocation'> & {
  items: { amount: number | null; members: string[] }[];
};
type AllocatedAmounts = Pick<Expense, 'tax' | 'tip' | 'discount' | 'percentages' | 'adjustmentAllocation'> & { items: DraftItem[] };
function addAmount(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || !Number.isSafeInteger(result)) {
    throw new LedgerValidationError('Amount is out of range');
  }
  return result;
}

export function total(expense: OriginalAmounts): number {
  const subtotal = expense.items.reduce((sum, item) => item.amount === null ? sum : addAmount(sum, item.amount), 0);
  return addAmount(addAmount(addAmount(subtotal, expense.tax), expense.tip), -expense.discount);
}

function itemWeights(item: DraftItem, members: { id: string }[]): { memberIndexes: number[]; weights: number[] } {
  const error = itemSplitError(item);
  if (error) throw new Error(error);
  const memberIndexes = item.members.map(id => {
    const index = members.findIndex(member => member.id === id);
    if (index < 0) throw new Error('Unknown member');
    return index;
  });
  const weights = item.members.map(id => item.units !== undefined ? unitsScale(item.units.allocations[id])!
    : item.percentages === undefined ? 1 : Math.round(item.percentages[id] * 100));
  return { memberIndexes, weights };
}

/** Allocate an item's whole cents, with remainder ties following its selected-person order. */
export function itemShares(item: DraftItem, members: { id: string }[]): number[] {
  if (item.amount === null) throw new LedgerValidationError('Enter a readable item amount before calculating shares');
  const { memberIndexes, weights } = itemWeights(item, members);
  const amounts = allocate(item.amount, weights);
  const output = members.map(() => 0);
  memberIndexes.forEach((memberIndex, index) => { output[memberIndex] = amounts[index]; });
  return output;
}

function percentageShares(amount: number, percentages: Record<string, number>, members: { id: string }[]): number[] {
  const error = receiptSplitError({ percentages });
  if (error) throw new Error(error);
  const selected = Object.keys(percentages);
  const indexes = selected.map(id => {
    const index = members.findIndex(member => member.id === id);
    if (index < 0) throw new Error('Unknown member');
    return index;
  });
  const amounts = allocate(amount, selected.map(id => Math.round(percentages[id] * 100)));
  const output = members.map(() => 0);
  indexes.forEach((memberIndex, index) => { output[memberIndex] = amounts[index]; });
  return output;
}

function gcd(left: bigint, right: bigint): bigint {
  while (right) [left, right] = [right, left % right];
  return left;
}

/**
 * Each person's exact, unrounded item subtotal, as numerators over a shared
 * denominator. Rounding the receipt total once against these weights means
 * per-item remainders can't pile onto the same person: €0.35 + €1.29 split
 * equally is €0.82 each, not €0.83 and €0.81.
 */
function exactItemWeights(expense: AllocatedAmounts, members: { id: string }[]): bigint[] {
  let denominator = BigInt(1);
  let numerators = members.map(() => BigInt(0));
  for (const item of expense.items) {
    const { memberIndexes, weights } = itemWeights(item, members);
    const sum = weights.reduce((value, weight) => value + BigInt(weight), BigInt(0));
    if (!sum || !item.amount) continue;
    const common = denominator / gcd(denominator, sum) * sum;
    numerators = numerators.map(value => value * (common / denominator));
    memberIndexes.forEach((memberIndex, index) => {
      numerators[memberIndex] += BigInt(item.amount!) * BigInt(weights[index]) * (common / sum);
    });
    const divisor = numerators.reduce(gcd, common);
    numerators = numerators.map(value => value / divisor);
    denominator = common / divisor;
  }
  return numerators;
}

/** Receipt-total ties follow the order people were first selected on items, then trip-member order. */
function receiptTieOrder(expense: AllocatedAmounts, members: { id: string }[]): number[] {
  const ids = [...new Set([...expense.items.flatMap(item => item.members), ...members.map(member => member.id)])];
  return members.map(member => ids.indexOf(member.id));
}

/** Weights for rounding the whole receipt once, including tax, tip and discount. */
function receiptWeights(expense: AllocatedAmounts, members: { id: string }[]): bigint[] {
  const weights = exactItemWeights(expense, members);
  if (weights.some(Boolean)) return weights;
  const selected = new Set(expense.items.flatMap(item => item.members));
  const fallback = members.map(member => BigInt(selected.has(member.id) ? 1 : 0));
  if (total(expense) && !fallback.some(Boolean)) throw new Error('Choose at least one person for receipt adjustments');
  return fallback;
}

/** Item assignments and proportional adjustments are always calculated in receipt currency first. */
export function shares(expense: AllocatedAmounts, members: { id: string }[]): number[] {
  if (expense.items.some(item => item.amount === null)) throw new LedgerValidationError('Enter every item amount before calculating shares');
  if (expense.percentages !== undefined) return percentageShares(total(expense), expense.percentages, members);
  if (expense.adjustmentAllocation === 'receipt-total') {
    const amount = total(expense);
    if (amount < 0) throw new LedgerValidationError('Discount exceeds total');
    return allocateExact(amount, receiptWeights(expense, members), receiptTieOrder(expense, members));
  }
  const sums = members.map(() => 0);
  for (const item of expense.items) {
    itemShares(item, members).forEach((amount, index) => { sums[index] = addAmount(sums[index], amount); });
  }
  const adjustment = addAmount(addAmount(expense.tax, expense.tip), -expense.discount);
  // The corrected rule counts the selected-person union once each. Historical
  // receipts without a version retain their old shares until explicitly saved.
  const selected = new Set(expense.items.flatMap(item => item.members));
  const weights = sums.some(Boolean) ? sums : expense.adjustmentAllocation === 'selected-participants'
    ? members.map(member => selected.has(member.id) ? 1 : 0) : members.map(() => 1);
  if (adjustment && !weights.some(Boolean)) throw new Error('Choose at least one person for receipt adjustments');
  const amounts = allocate(Math.abs(adjustment), weights);
  return sums.map((sum, index) => addAmount(sum, adjustment < 0 ? -amounts[index] : amounts[index]));
}

/** Rates are units of settlement currency per one unit of receipt currency. */
export function convertAmount(original: number, rate: number): number {
  if (!Number.isSafeInteger(original) || original < 0 || !validExchangeRate(rate)) {
    throw new LedgerValidationError('Conversion needs a non-negative whole amount and a positive finite rate');
  }
  // Parse the persisted decimal rate as a rational number, including scientific
  // notation. Rounding the rational avoids half-cent errors such as 50 * 0.29.
  const [mantissa, exponentText = '0'] = rate.toString().toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponentText);
  const power = BigInt(10) ** BigInt(Math.abs(scale));
  const numerator = BigInt(original) * BigInt(whole + fraction) * (scale < 0 ? power : BigInt(1));
  const denominator = scale > 0 ? power : BigInt(1);
  const rounded = numerator / denominator + (numerator % denominator * BigInt(2) >= denominator ? BigInt(1) : BigInt(0));
  const converted = Number(rounded);
  if (!Number.isSafeInteger(converted)) throw new LedgerValidationError('Converted amount is out of range. Check the exchange rate and receipt amounts.');
  return converted;
}

export function expenseTotal(expense: Expense | Draft, baseCurrency: Currency): number {
  if (!expense.currency || expense.items.some(item => item.amount === null)) {
    throw new LedgerValidationError('Confirm the receipt currency and every item amount before calculating its cost');
  }
  const original = total(expense);
  if (original <= 0) throw new LedgerValidationError('Receipt total must be greater than zero');
  if (expense.bankAmount !== undefined) {
    if (expense.currency === baseCurrency) {
      throw new LedgerValidationError('Remove the bank charge when the receipt and settlement currencies are the same');
    }
    if (!Number.isSafeInteger(expense.bankAmount) || expense.bankAmount <= 0) {
      throw new LedgerValidationError('The actual bank charge must be greater than zero');
    }
  }
  const converted = expense.bankAmount !== undefined ? expense.bankAmount
    : expense.currency === baseCurrency ? original
      : expense.fx ? convertAmount(original, expense.fx.rate) : undefined;
  if (converted === undefined) throw new LedgerValidationError('Add an exchange rate or the actual bank charge for this currency');
  if (!Number.isSafeInteger(converted) || converted > MAX_AMOUNT) throw new LedgerValidationError('Converted amount is out of range (maximum 1,000,000 settlement currency units)');
  if (converted <= 0) throw new LedgerValidationError('Converted receipt total must be greater than zero');
  return converted;
}

export function expenseShares(expense: Expense | Draft, members: { id: string }[], baseCurrency: Currency): number[] {
  if (expense.percentages !== undefined) return percentageShares(expenseTotal(expense, baseCurrency), expense.percentages, members);
  if (expense.adjustmentAllocation === 'receipt-total') {
    if (expense.items.some(item => item.amount === null)) throw new LedgerValidationError('Enter every item amount before calculating shares');
    const weights = receiptWeights(expense, members);
    return allocateExact(expenseTotal(expense, baseCurrency), weights.some(Boolean) ? weights : members.map(() => BigInt(1)), receiptTieOrder(expense, members));
  }
  const originalShares = shares(expense, members);
  const convertedTotal = expenseTotal(expense, baseCurrency);
  return allocate(convertedTotal, originalShares.some(Boolean) ? originalShares : members.map(() => 1));
}

export function balances(trip: Trip): number[] {
  const result = trip.members.map(() => 0);
  for (const expense of trip.expenses) {
    const split = expenseShares(expense, trip.members, trip.currency);
    split.forEach((value, index) => { result[index] = addAmount(result[index], -value); });
    const payerIndex = trip.members.findIndex(member => member.id === expense.payer);
    if (payerIndex < 0) throw new Error('Unknown payer');
    result[payerIndex] = addAmount(result[payerIndex], expenseTotal(expense, trip.currency));
  }
  for (const payment of trip.payments) {
    const fromIndex = trip.members.findIndex(member => member.id === payment.from);
    const toIndex = trip.members.findIndex(member => member.id === payment.to);
    if (fromIndex < 0 || toIndex < 0) throw new Error('Unknown payment member');
    result[fromIndex] = addAmount(result[fromIndex], payment.amount);
    result[toIndex] = addAmount(result[toIndex], -payment.amount);
  }
  return result;
}

export type TravellerFinancialPreview = {
  available: true;
  currency: Currency;
  expenseCount: number;
  paymentCount: number;
  costShare: number;
  paidUpfront: number;
  paymentsSent: number;
  paymentsReceived: number;
  netBalance: number;
} | {
  available: false;
  currency: Currency;
  expenseCount: number;
  paymentCount: number;
  message: string;
};

/** Aggregates for confirming an invitation's existing traveller identity. */
export function travellerFinancialPreview(trip: Trip, memberId: string): TravellerFinancialPreview {
  const index = trip.members.findIndex(member => member.id === memberId);
  const expenseCount = trip.expenses.filter(expense => expense.payer === memberId || (expense.percentages !== undefined
    ? Object.hasOwn(expense.percentages, memberId)
    : expense.items.some(item => item.members.includes(memberId)))).length;
  const paymentCount = trip.payments.filter(payment => payment.from === memberId || payment.to === memberId).length;
  const metadata = { currency: trip.currency, expenseCount, paymentCount };
  try {
    if (index < 0) throw new Error('This traveller is no longer in the holiday');
    let costShare = 0;
    let paidUpfront = 0;
    let paymentsSent = 0;
    let paymentsReceived = 0;
    for (const expense of trip.expenses) {
      costShare = addAmount(costShare, expenseShares(expense, trip.members, trip.currency)[index]);
      if (expense.payer === memberId) paidUpfront = addAmount(paidUpfront, expenseTotal(expense, trip.currency));
    }
    for (const payment of trip.payments) {
      if (!Number.isSafeInteger(payment.amount) || payment.amount <= 0 || payment.amount > MAX_AMOUNT
        || payment.from === payment.to || !trip.members.some(member => member.id === payment.from)
        || !trip.members.some(member => member.id === payment.to)) throw new Error('Review an invalid recorded payment');
      if (payment.from === memberId) paymentsSent = addAmount(paymentsSent, payment.amount);
      if (payment.to === memberId) paymentsReceived = addAmount(paymentsReceived, payment.amount);
    }
    const netBalance = addAmount(addAmount(addAmount(paidUpfront, -costShare), paymentsSent), -paymentsReceived);
    return { available: true, ...metadata, costShare, paidUpfront, paymentsSent, paymentsReceived, netBalance };
  } catch (error) {
    return { available: false, ...metadata, message: error instanceof Error ? error.message : 'Review the holiday’s recorded amounts before relying on this balance' };
  }
}

export function settlements(trip: Trip): { from: string; to: string; amount: number }[] {
  const balance = balances(trip);
  const debt = trip.members.map((member, index) => ({ id: member.id, amount: -balance[index] })).filter(value => value.amount > 0);
  const credit = trip.members.map((member, index) => ({ id: member.id, amount: balance[index] })).filter(value => value.amount > 0);
  const byId = (left: { id: string }, right: { id: string }) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  debt.sort(byId);
  credit.sort(byId);
  const output: { from: string; to: string; amount: number }[] = [];
  // Matching equal and opposite balances first avoids splitting a couple's
  // existing debt across unrelated people. This is an improvement, not a claim
  // that greedy settlement minimises transfers for every possible ledger.
  for (const debtor of debt) {
    const creditor = credit.find(value => value.amount === debtor.amount);
    if (!creditor) continue;
    output.push({ from: debtor.id, to: creditor.id, amount: debtor.amount });
    debtor.amount = 0;
    creditor.amount = 0;
  }
  const byAmount = (left: { id: string; amount: number }, right: { id: string; amount: number }) => right.amount - left.amount || byId(left, right);
  while (true) {
    debt.sort(byAmount);
    credit.sort(byAmount);
    const debtor = debt[0];
    const creditor = credit[0];
    if (!debtor?.amount || !creditor?.amount) break;
    const amount = Math.min(debtor.amount, creditor.amount);
    output.push({ from: debtor.id, to: creditor.id, amount });
    debtor.amount -= amount;
    creditor.amount -= amount;
  }
  return output;
}
