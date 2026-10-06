import { z } from 'zod';
import { CURRENCIES, draftSchema, draftItemSchema, itemSplitError, receiptSplitError, total, MAX_AMOUNT, MAX_UNITS, type Draft, type DraftItem, type Trip } from './model';
import { reconcileReceiptScan } from './receipt-scan';
import { receiptAliasSchema } from './receipt-context';
import { receiptLanguageSchema } from './receipt-languages';

const id = z.string().min(1).max(100), text = z.string().trim().min(1).max(200);
const money = z.number().int().min(0).max(MAX_AMOUNT);
const shares = z.array(z.object({ memberId: id, value: z.number().finite().min(0).max(100) }).strict()).max(50);
const counts = z.array(z.object({ memberId: id, value: z.number().finite().min(0).max(MAX_UNITS) }).strict()).max(50);
export const receiptChangesSchema = z.object({
  metadata: z.object({
    title: text.nullable(), currency: draftSchema.shape.currency.removeDefault().nullable(),
    date: draftSchema.shape.date.unwrap().nullable(), time: draftSchema.shape.time.unwrap().nullable(),
    timezone: draftSchema.shape.timezone.unwrap().nullable(), payer: id.nullable(),
    receiptLanguage: receiptLanguageSchema.nullable(), location: z.string().trim().min(1).max(300).nullable(),
    tax: money.nullable(), tip: money.nullable(), discount: money.nullable(),
    bankAmount: draftSchema.shape.bankAmount.unwrap().nullable(), fx: draftSchema.shape.fx.unwrap().nullable(),
    percentages: shares.nullable(),
  }).strict().nullable(),
  items: z.array(z.object({
    id: id.nullable(), itemIndex: z.number().int().min(0).max(199).nullable(),
    name: text.nullable(), amount: money.nullable(), members: z.array(id).max(50).nullable(),
    units: z.object({ total: z.number().positive().max(MAX_UNITS), label: z.string().trim().max(40).nullable(), allocations: counts }).strict().nullable(),
    percentages: shares.nullable(),
  }).strict()).max(200),
  removeItemIds: z.array(id).max(200),
  clear: z.array(z.enum(['location', 'locationHint', 'percentages', 'fx', 'bankAmount', 'receiptLanguage'])).max(6),
  remember: z.string().trim().max(2000).nullable(),
  aliases: z.array(z.object({ name: z.string().trim().min(1).max(60), itemId: id.nullable(), memberId: id.nullable(), scopeMemberId: id.nullable() }).strict()).max(50),
}).strict();
export type ReceiptChanges = z.infer<typeof receiptChangesSchema>;

const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const string = { type: 'string' }, number = { type: 'number' };
const array = (items: unknown, maxItems: number) => ({ type: 'array', items, maxItems });
const shareJson = array(object({ memberId: string, value: number }), 50);
export const receiptChangesJsonSchema = object({
  metadata: nullable(object({
    title: nullable(string), currency: nullable({ type: 'string', enum: CURRENCIES.map(c => c.code) }),
    date: nullable(string), time: nullable(string), timezone: nullable(string), payer: nullable(string),
    receiptLanguage: nullable(string), location: nullable(string), tax: nullable(number), tip: nullable(number), discount: nullable(number),
    bankAmount: nullable(number), fx: nullable(object({ rate: number, asOf: string, source: { type: 'string', enum: ['manual', 'reference'] } })),
    percentages: nullable(shareJson),
  })),
  items: array(object({ id: nullable(string), itemIndex: nullable({ type: 'integer' }), name: nullable(string), amount: nullable({ type: 'integer' }),
    members: nullable(array(string, 50)), units: nullable(object({ total: number, label: nullable(string), allocations: shareJson })), percentages: nullable(shareJson),
  }), 200),
  removeItemIds: array(string, 200), clear: array({ type: 'string', enum: ['location', 'locationHint', 'percentages', 'fx', 'bankAmount', 'receiptLanguage'] }, 6),
  remember: nullable(string), aliases: array(object({ name: string, itemId: nullable(string), memberId: nullable(string), scopeMemberId: nullable(string) }), 50),
});

function mapShares(rows: { memberId: string; value: number }[], trip: Trip) {
  if (new Set(rows.map(row => row.memberId)).size !== rows.length || rows.some(row => !trip.members.some(member => member.id === row.memberId))) {
    throw Error('The assistant proposed an unknown or duplicate traveller. Your receipt is unchanged.');
  }
  return Object.fromEntries(rows.map(row => [row.memberId, row.value]));
}

/** Apply explicit cost decisions separately from recognition; never post an expense. */
export function applyReceiptChanges(trip: Trip, draft: Draft, input: ReceiptChanges, options: { recognition?: boolean; scannedItemIds?: string[]; questionId?: string } = {}) {
  const changes = receiptChangesSchema.parse(input), next = structuredClone(draft), issues: string[] = [];
  const question = options.questionId ? draft.conversation?.find(message => message.id === options.questionId && message.role === 'user') : undefined;
  const knownAuthor = question ? trip.members.some(member => member.id === question.authorMemberId)
    : draft.conversation?.some(message => message.role === 'user' && trip.members.some(member => member.id === message.authorMemberId));
  if (!knownAuthor && (changes.items.length || changes.removeItemIds.length || changes.clear.some(field => ['percentages','fx','bankAmount'].includes(field)) || changes.metadata && Object.entries(changes.metadata).some(([key, value]) => key !== 'location' && value !== null))) {
    if (!options.recognition) throw Error('The assistant needs a known traveller before proposing these changes. Clarify who is speaking.');
    issues.push('Clarify who is speaking before assigning personal cost shares.'); changes.items = [];
  }
  if (!options.recognition) {
    for (const field of changes.clear) { Object.assign(next, { [field]: undefined }); if (field === 'location') next.fieldSources = { ...next.fieldSources, location: 'ai' }; }
    if (changes.metadata) {
      const { location, percentages, ...metadata } = changes.metadata;
      for (const [field, value] of Object.entries(metadata)) if (value !== null) {
        Object.assign(next, { [field]: value });
        if (['title','currency','date','time','timezone','payer','tax','tip','discount'].includes(field)) next.fieldSources = { ...next.fieldSources, [field]: 'ai' };
      }
      if (location !== null) { next.location = { label: location, source: 'chat' }; next.fieldSources = { ...next.fieldSources, location: 'ai' }; }
      if (percentages !== null) next.percentages = mapShares(percentages, trip);
      if (next.currency !== draft.currency) { if (changes.metadata.fx === null) next.fx = undefined; if (changes.metadata.bankAmount === null) next.bankAmount = undefined; }
    }
    if (next.payer && !trip.members.some(member => member.id === next.payer)) throw Error('Choose a current traveller as the payer.');
  }
  const seen = new Set<string>();
  for (const patch of changes.items) {
    const indexedId = patch.itemIndex === null ? undefined : (options.scannedItemIds ?? draft.items.map(item => item.id))[patch.itemIndex];
    if (patch.itemIndex !== null && !indexedId) throw Error('The assistant referenced a missing receipt line.');
    if (patch.id && indexedId && patch.id !== indexedId) throw Error('The assistant returned conflicting receipt line references.');
    const targetId = patch.id ?? indexedId;
    const previous = targetId ? next.items.find(item => item.id === targetId) : undefined;
    if (targetId && !previous) throw Error('The assistant referenced an unknown receipt item.');
    if (targetId && seen.has(targetId)) throw Error('The assistant proposed duplicate receipt item changes.');
    if (targetId) seen.add(targetId);
    if (options.recognition && (!previous || previous.members.length || previous.percentages || Object.keys(previous.units?.allocations ?? {}).length || draft.percentages)) continue;
    if (!previous && !options.recognition && (patch.name === null || patch.amount === null)) throw Error('A new requested item needs a description and amount.');
    const item: DraftItem = previous ? { ...previous } : { id: crypto.randomUUID(), name: '', amount: null, members: [] as string[] };
    if (!options.recognition) {
      if (patch.name !== null) { item.name = patch.name; item.fieldSources = { ...item.fieldSources, name: 'ai' }; }
      if (patch.amount !== null) { item.amount = patch.amount; item.fieldSources = { ...item.fieldSources, amount: 'ai' }; }
    }
    if (patch.members !== null) {
      if (new Set(patch.members).size !== patch.members.length || patch.members.some(id => !trip.members.some(member => member.id === id))) throw Error('The assistant selected an unknown or duplicate traveller.');
      const changed = patch.members.length !== item.members.length || patch.members.some(id => !item.members.includes(id));
      item.members = patch.members;
      if (changed) { item.units = undefined; item.percentages = undefined; }
    }
    if (patch.units && patch.percentages) throw Error('Choose quantities or percentages for an item, not both.');
    if (patch.units) {
      if (options.recognition && item.quantity && patch.units.total !== item.quantity.total) {
        issues.push(`Check ${item.name || 'this item'}: the stated quantities differ from the receipt. Its shares were left unchanged.`); continue;
      }
      const allocations = mapShares(patch.units.allocations, trip);
      item.units = { total: patch.units.total, allocations, ...(patch.units.label ? { label: patch.units.label } : {}) };
      item.members = Object.keys(allocations); item.percentages = undefined;
    } else if (patch.percentages) {
      item.percentages = mapShares(patch.percentages, trip); item.members = Object.keys(item.percentages); item.units = undefined;
    }
    const invalid = item.members.length || patch.units || patch.percentages ? itemSplitError(item) : null;
    if (invalid) throw Error(invalid);
    const parsed = draftItemSchema.parse(item);
    if (previous) next.items[next.items.findIndex(value => value.id === previous.id)] = parsed;
    else next.items.push(parsed);
  }
  if (!options.recognition) {
    if (new Set(changes.removeItemIds).size !== changes.removeItemIds.length || changes.removeItemIds.some(id => !draft.items.some(item => item.id === id) || seen.has(id))) throw Error('Only distinct existing items can be removed, without also changing them.');
    next.items = next.items.filter(item => !changes.removeItemIds.includes(item.id));
  }
  if (total(next) < 0 || total(next) > MAX_AMOUNT) throw Error('The proposed receipt total is outside the supported range.');
  if (!options.recognition && changes.metadata?.fx && changes.metadata.fx.source !== 'manual') throw Error('Only an explicitly supplied manual exchange rate can be changed in chat.');
  const percentageIssue = receiptSplitError(next);
  if (percentageIssue) throw Error(percentageIssue);
  const memory = next.memory ?? { notes: '', aliases: [] };
  if (changes.remember) memory.notes = [memory.notes, changes.remember].filter(Boolean).join('\n');
  for (const alias of changes.aliases) {
    const parsed = receiptAliasSchema.parse(Object.fromEntries(Object.entries(alias).filter(([, value]) => value !== null)));
    if (parsed.memberId && !trip.members.some(member => member.id === parsed.memberId) || parsed.itemId && !next.items.some(item => item.id === parsed.itemId) || parsed.scopeMemberId && !trip.members.some(member => member.id === parsed.scopeMemberId)) throw Error('The assistant proposed an unknown alias target.');
    const personalAuthor = question?.authorMemberId ?? (options.recognition ? draft.conversation?.find(message => message.role === 'user' && message.authorMemberId === parsed.scopeMemberId)?.authorMemberId : undefined);
    if (/^(i|me|my|myself)$/i.test(parsed.name) && (!personalAuthor || parsed.memberId !== personalAuthor || parsed.scopeMemberId !== personalAuthor)) throw Error('Personal aliases must belong to the saved question author.');
    if (!memory.aliases.some(value => JSON.stringify(value) === JSON.stringify(parsed))) memory.aliases.push(parsed);
  }
  if (changes.remember || changes.aliases.length) next.memory = memory;
  next.source = 'ai'; next.status = 'review';
  if (next.receiptScan) next.receiptScan = reconcileReceiptScan(next);
  return { draft: draftSchema.parse(next), issues };
}
