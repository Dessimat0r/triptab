import { z } from 'zod';

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
const cents = z.number().int().min(0).max(100000000);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Enter a valid calendar date');
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Enter a time as HH:mm');
const timezoneSchema = z.string().min(1).max(100).refine(value => {
  if (/^[+-]/.test(value)) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; }
  catch { return false; }
}, 'Choose a valid timezone');
const fxSchema = z.object({
  rate: z.number().finite().positive(),
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

const receiptMessageSchema = z.object({
  id,
  role: z.enum(['user', 'assistant']),
  text: z.string().trim().min(1).max(4000),
  createdAt: z.string().datetime({ offset: true }),
  replyTo: id.optional(),
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
  percentages: z.record(id, z.number().finite().min(0).max(100)).optional(),
});
export type Item = z.infer<typeof rawItemSchema>;

/** A receipt item's split describes who owes its cost, independently of the payer. */
export function itemSplitError(item: Item): string | null {
  if (!item.members.length) return 'Choose at least one person for each item';
  if (new Set(item.members).size !== item.members.length || item.members.some(member => !member)) {
    return 'Check item assignments';
  }
  if (item.percentages === undefined) return null;
  const keys = Object.keys(item.percentages);
  if (keys.length !== item.members.length || keys.some(key => !item.members.includes(key))) {
    return 'Set a percentage for each selected person only';
  }
  return percentageError(item.percentages, 'Item');
}

export const itemSchema = rawItemSchema.superRefine((item, context) => {
  const message = itemSplitError(item);
  if (message) context.addIssue({ code: z.ZodIssueCode.custom, path: ['percentages'], message });
});
export const expenseSchema = z.object({
  id, title: z.string().min(1).max(200), date: dateSchema,
  time: timeSchema.default('12:00'), timezone: timezoneSchema.default('Europe/London'),
  currency: currencySchema.default('EUR'), fx: fxSchema.optional(), bankAmount: cents.optional(),
  payer: id, items: z.array(itemSchema).min(1).max(200),
  percentages: percentagesSchema.optional(),
  conversation: conversationSchema.optional(),
  tax: cents, tip: cents, discount: cents, receiptId: id.optional(),
});
export const draftSchema = z.object({
  id, title: z.string().max(200), receiptId: id.optional(), expenseId: id.optional(),
  currency: currencySchema.default('EUR'),
  date: dateSchema.optional(), time: timeSchema.optional(), timezone: timezoneSchema.optional(),
  fx: fxSchema.optional(), bankAmount: cents.optional(),
  percentages: percentagesSchema.optional(),
  conversation: conversationSchema.optional(),
  items: z.array(itemSchema).max(200), tax: cents, tip: cents, discount: cents,
  payer: id, status: z.enum(['waiting', 'review']),
});
export const tripSchema = z.object({
  id, ownerId: accountId.optional(), name: z.string().min(1).max(100), currency: currencySchema,
  startDate: dateSchema.optional(), endDate: dateSchema.optional(),
  members: z.array(z.object({ id, name: z.string().min(1).max(50), userId: accountId.optional(), email: z.string().email().optional() })).min(1).max(50),
  expenses: z.array(expenseSchema).max(1000), drafts: z.array(draftSchema).max(100),
  payments: z.array(z.object({ id, from: id, to: id, amount: cents, date: dateSchema })).max(1000),
});
export const ledgerSchema = z.object({ trips: z.array(tripSchema).max(50) });
export type Expense = z.infer<typeof expenseSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type Trip = z.infer<typeof tripSchema>;
export type Ledger = z.infer<typeof ledgerSchema>;

export function receiptSplitError(expense: Pick<Expense, 'percentages'>): string | null {
  return expense.percentages === undefined ? null : percentageError(expense.percentages, 'Receipt');
}

export function validateLedger(data: unknown): Ledger {
  const ledger = ledgerSchema.parse(data);
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(ledger.trips.map(trip => trip.id))) throw new Error('Duplicate trips');
  for (const trip of ledger.trips) {
    if (trip.startDate && trip.endDate && trip.endDate < trip.startDate) {
      throw new Error('Holiday end date must be on or after its start date');
    }
    const memberIds = new Set(trip.members.map(member => member.id));
    if (memberIds.size !== trip.members.length
      || !unique([...trip.expenses, ...trip.drafts].map(expense => expense.id))
      || !unique(trip.payments.map(payment => payment.id))) throw new Error('Duplicate IDs');
    const expenseIds = new Set(trip.expenses.map(expense => expense.id));
    const draftTargets = trip.drafts.flatMap(draft => draft.expenseId === undefined ? [] : [draft.expenseId]);
    if (draftTargets.some(expenseId => !expenseIds.has(expenseId))) {
      throw new Error('Receipt draft targets an expense that is not in this trip');
    }
    if (!unique(draftTargets)) throw new Error('An expense can only have one pending receipt draft');
    for (const expense of [...trip.expenses, ...trip.drafts]) {
      if (!memberIds.has(expense.payer)) throw new Error('Choose a trip member as payer');
      if (expense.percentages && Object.keys(expense.percentages).some(member => !memberIds.has(member))) {
        throw new Error('Check receipt percentage assignments');
      }
      if (!unique(expense.items.map(item => item.id))) throw new Error('Duplicate item IDs');
      for (const item of expense.items) {
        if (!unique(item.members) || item.members.some(member => !memberIds.has(member))) {
          throw new Error('Check item assignments');
        }
      }
      if (expense.discount > expense.items.reduce((sum, item) => sum + item.amount, 0) + expense.tax + expense.tip) {
        throw new Error('Discount exceeds total');
      }
    }
    for (const expense of trip.expenses) {
      if (expense.currency !== trip.currency && expense.bankAmount === undefined && !expense.fx) {
        throw new Error('Add an exchange rate or the actual bank charge for this currency');
      }
      expenseTotal(expense, trip.currency);
    }
    for (const payment of trip.payments) {
      if (!memberIds.has(payment.from) || !memberIds.has(payment.to)
        || payment.from === payment.to || !payment.amount) throw new Error('Invalid payment');
    }
  }
  return ledger;
}

/** Largest-remainder allocation keeps every penny and resolves ties by input order. */
export function allocate(amount: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(amount) || amount < 0 || weights.some(weight => !Number.isFinite(weight) || weight < 0)) {
    throw new Error('Allocation needs a non-negative whole amount and finite weights');
  }
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum)) throw new Error('Allocation weights are out of range');
  if (!sum) return weights.map(() => 0);
  // Receipt shares are integer weights. Exact remainders avoid floating-point ties
  // and preserve cents even for unusually large currency conversions.
  if (weights.every(Number.isSafeInteger)) {
    const denominator = weights.reduce((value, weight) => value + BigInt(weight), BigInt(0));
    const numerators = weights.map(weight => BigInt(amount) * BigInt(weight));
    const output = numerators.map(value => Number(value / denominator));
    const remaining = amount - output.reduce((a, b) => a + b, 0);
    const order = numerators.map((value, index) => ({ index, remainder: value % denominator }))
      .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
    for (let index = 0; index < remaining; index++) output[order[index].index]++;
    return output;
  }
  const raw = weights.map(weight => amount * (weight / sum));
  const output = raw.map(Math.floor);
  const remaining = amount - output.reduce((a, b) => a + b, 0);
  const order = raw.map((value, index) => ({ index, remainder: value - output[index] }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let index = 0; index < remaining; index++) output[order[index % order.length].index]++;
  return output;
}

type OriginalAmounts = Pick<Expense, 'items' | 'tax' | 'tip' | 'discount' | 'percentages'>;
export function total(expense: OriginalAmounts): number {
  return expense.items.reduce((sum, item) => sum + item.amount, 0) + expense.tax + expense.tip - expense.discount;
}

/** Allocate an item's whole cents, with remainder ties following its selected-person order. */
export function itemShares(item: Item, members: { id: string }[]): number[] {
  const error = itemSplitError(item);
  if (error) throw new Error(error);
  const memberIndexes = item.members.map(id => {
    const index = members.findIndex(member => member.id === id);
    if (index < 0) throw new Error('Unknown member');
    return index;
  });
  const weights = item.members.map(id => item.percentages === undefined ? 1 : Math.round(item.percentages[id] * 100));
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

/** Item assignments and proportional adjustments are always calculated in receipt currency first. */
export function shares(expense: OriginalAmounts, members: { id: string }[]): number[] {
  if (expense.percentages !== undefined) return percentageShares(total(expense), expense.percentages, members);
  const sums = members.map(() => 0);
  for (const item of expense.items) {
    itemShares(item, members).forEach((amount, index) => { sums[index] += amount; });
  }
  const adjustment = expense.tax + expense.tip - expense.discount;
  const amounts = allocate(Math.abs(adjustment), sums.some(Boolean) ? sums : members.map(() => 1));
  return sums.map((sum, index) => sum + (adjustment < 0 ? -amounts[index] : amounts[index]));
}

/** Rates are units of settlement currency per one unit of receipt currency. */
export function convertAmount(original: number, rate: number): number {
  if (!Number.isSafeInteger(original) || original < 0 || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('Conversion needs a non-negative whole amount and a positive finite rate');
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
  if (!Number.isSafeInteger(converted)) throw new Error('Converted amount is out of range');
  return converted;
}

export function expenseTotal(expense: Expense, baseCurrency: Currency): number {
  const original = total(expense);
  const converted = expense.bankAmount !== undefined ? expense.bankAmount
    : expense.currency === baseCurrency ? original
      : expense.fx ? convertAmount(original, expense.fx.rate) : undefined;
  if (converted === undefined) throw new Error('Add an exchange rate or the actual bank charge for this currency');
  if (!Number.isSafeInteger(converted) || converted < 0) throw new Error('Converted amount is out of range');
  return converted;
}

export function expenseShares(expense: Expense, members: { id: string }[], baseCurrency: Currency): number[] {
  if (expense.percentages !== undefined) return percentageShares(expenseTotal(expense, baseCurrency), expense.percentages, members);
  const originalShares = shares(expense, members);
  const convertedTotal = expenseTotal(expense, baseCurrency);
  return allocate(convertedTotal, originalShares.some(Boolean) ? originalShares : members.map(() => 1));
}

export function balances(trip: Trip): number[] {
  const result = trip.members.map(() => 0);
  for (const expense of trip.expenses) {
    const split = expenseShares(expense, trip.members, trip.currency);
    split.forEach((value, index) => result[index] -= value);
    const payerIndex = trip.members.findIndex(member => member.id === expense.payer);
    if (payerIndex < 0) throw new Error('Unknown payer');
    result[payerIndex] += expenseTotal(expense, trip.currency);
  }
  for (const payment of trip.payments) {
    const fromIndex = trip.members.findIndex(member => member.id === payment.from);
    const toIndex = trip.members.findIndex(member => member.id === payment.to);
    if (fromIndex < 0 || toIndex < 0) throw new Error('Unknown payment member');
    result[fromIndex] += payment.amount;
    result[toIndex] -= payment.amount;
  }
  return result;
}

export function settlements(trip: Trip): { from: string; to: string; amount: number }[] {
  const balance = balances(trip);
  const debt = trip.members.map((member, index) => ({ id: member.id, amount: -balance[index] })).filter(value => value.amount > 0);
  const credit = trip.members.map((member, index) => ({ id: member.id, amount: balance[index] })).filter(value => value.amount > 0);
  const output: { from: string; to: string; amount: number }[] = [];
  for (const debtor of debt) for (const creditor of credit) {
    const amount = Math.min(debtor.amount, creditor.amount);
    if (amount) {
      output.push({ from: debtor.id, to: creditor.id, amount });
      debtor.amount -= amount;
      creditor.amount -= amount;
    }
  }
  return output;
}
