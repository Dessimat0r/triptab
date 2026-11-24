import { z } from 'zod';
import { adjustmentSchema, adjustmentsSchema, applyAdjustments, nextOfferLetter, personControlled, type Adjustment } from './adjustments';
import { builtInOffers, offerRuleSchema, type SavedOffer } from './offer-rules';
import { canonicalJson } from './data-utils';
import type { Draft, Trip } from './model';

const text = z.string().trim().min(1).max(100);
const minor = z.number().int().min(0).max(100000000);
const count = z.number().int().min(1).max(200);
const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] });
const object = (properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const array = (items: Record<string, unknown>, maxItems: number) => ({ type: 'array', items, maxItems });
const string = { type: 'string' }, number = { type: 'number' }, integer = { type: 'integer' };

export const receiptOfferProposalSchema = z.object({
  adjustmentId: text.nullable(), label: text.max(80).nullable(),
  group: z.string().regex(/^[A-T]$/).nullable(),
  items: z.array(z.object({ itemId: text.nullable(), itemIndex: z.number().int().min(0).max(199).nullable(), portions: count.nullable() }).strict()).max(200).nullable(),
  sourceLineIndex: z.number().int().min(0).max(999).nullable(),
  preset: z.enum(['bogof', 'secondPrice', 'bundle', 'percentage', 'fixed']).nullable(),
  presetValue: minor.or(z.number().positive().max(100)).nullable(),
  savedRule: text.max(80).nullable(),
  custom: z.object({ buy: count.nullable(), cheapest: count.nullable(), benefit: z.enum(['price', 'percent', 'amount']), value: minor.or(z.number().positive().max(100)), cap: minor.nullable(), limit: count.nullable() }).strict().nullable(),
  split: z.object({ mode: z.enum(['items', 'cheapest', 'equal', 'exact']), people: z.array(z.object({ id: text, amount: minor.nullable() }).strict()).max(50) }).strict().nullable(),
  stacking: z.boolean().nullable(),
}).strict();

export const receiptOfferProposalJsonSchema = object({
  adjustmentId: nullable(string), label: nullable(string), group: nullable(string),
  items: nullable(array(object({ itemId: nullable(string), itemIndex: nullable(integer), portions: nullable(integer) }), 200)),
  sourceLineIndex: nullable(integer), preset: nullable({ type: 'string', enum: Object.keys(builtInOffers) }), presetValue: nullable(number),
  savedRule: nullable(string), custom: nullable(object({ buy: nullable(integer), cheapest: nullable(integer), benefit: { type: 'string', enum: ['price', 'percent', 'amount'] }, value: number, cap: nullable(integer), limit: nullable(integer) })),
  split: nullable(object({ mode: { type: 'string', enum: ['items', 'cheapest', 'equal', 'exact'] }, people: array(object({ id: string, amount: nullable(integer) }), 50) })),
  stacking: nullable({ type: 'boolean' }),
});

export const receiptOfferInstructions = `Use changes.offers for offers. Match the stated or printed TERMS first against builtInOfferRules and savedOfferRules; the same cash saving does not prove a match. Use savedRule by name, preset with presetValue for priced, percentage and fixed presets, or custom when the clear terms need a new rule. The custom buy is the quantity per use, cheapest is how many cheapest portions receive the benefit, value and cap are integer hundredths except percent value, and limit caps uses per bill. For a clear printed amount with unknown terms, use only sourceLineIndex and qualifying items. Keep printed coupon text in sourceLines, mappedTo unmapped until the offer is applied. Do not also return the same offer in adjustments or metadata.discount. Only use itemIndex from this scan/current context or stable itemId; specify portions only when fewer than the purchased quantity qualify. Null items means the whole bill, unless using an existing group or changing an existing offer. Group is null for a new group and a letter only to reuse an existing group. Ask which items qualify when unclear, especially if more items could qualify than the redemption count. On scan omit personal splits unless explicitly requested by a named human in the context. For chat, leave split null unless requested; set items to follow shares, cheapest to give the saving to the discounted portions, equal for selected people, or exact with minor-unit amounts. Only set stacking when the evidence or the user explicitly confirms two offers use the same portions. For an existing offer supply its adjustmentId. Propose changes in the draft; never claim the balance has been posted. A new custom rule is local to this draft until a person saves it for reuse.`;

export function applyOfferProposals(trip: Trip, draft: Draft, proposals: z.infer<typeof receiptOfferProposalSchema>[], options: { scan?: boolean; scannedItemIds?: string[]; savedOffers?: SavedOffer[] }) {
  let adjustments = [...(draft.adjustments ?? [])];
  for (const proposal of proposals) {
    const line = draft.receiptScan?.sourceLines?.find(line => line.lineIndex === proposal.sourceLineIndex && line.kind === 'adjustment');
    if (proposal.sourceLineIndex !== null && (!line || !line.amount)) throw Error('Choose the printed adjustment line for this offer.');
    const previous = adjustments.find(value => value.id === proposal.adjustmentId || line && value.sourceLineIndex === line.lineIndex);
    if (proposal.adjustmentId && !previous) throw Error('That offer is no longer on the receipt.');
    if (options.scan && previous && personControlled(previous)) continue;
    const grouped = proposal.group ? adjustments.find(value => value.group === proposal.group) : undefined;
    if (proposal.group && !grouped) throw Error(`Group ${proposal.group} is no longer on the receipt.`);
    let scope = grouped?.scope ?? previous?.scope ?? { type: 'receipt' as const };
    if (proposal.items) {
      const choices = proposal.items.map(choice => {
        const indexed = choice.itemIndex === null ? undefined : (options.scannedItemIds ?? draft.items.map(item => item.id))[choice.itemIndex];
        if (choice.itemId && indexed && choice.itemId !== indexed) throw Error('Check which items qualify for the offer.');
        const itemId = choice.itemId ?? indexed;
        if (!itemId || !draft.items.some(item => item.id === itemId)) throw Error('Choose the qualifying receipt items.');
        return { itemId, quantity: choice.portions };
      });
      const portions = Object.fromEntries(choices.flatMap(choice => choice.quantity === null ? [] : [[choice.itemId, choice.quantity]]));
      scope = { type: 'items', itemIds: choices.map(choice => choice.itemId), ...(Object.keys(portions).length ? { portions } : {}) };
    }
    if ([proposal.preset, proposal.savedRule, proposal.custom].filter(Boolean).length > 1) throw Error('Choose one offer rule.');
    const preset = proposal.preset ? builtInOffers[proposal.preset] : undefined;
    const saved = proposal.savedRule ? options.savedOffers?.find(rule => rule.name.trim().normalize('NFKC').toLowerCase() === proposal.savedRule?.trim().normalize('NFKC').toLowerCase()) : undefined;
    if (proposal.savedRule && !saved) throw Error('That saved offer is unavailable.');
    if (proposal.preset && proposal.preset !== 'bogof' && proposal.presetValue === null) throw Error('Choose the value used by this offer.');
    const custom = proposal.custom ? { version: 1, ...Object.fromEntries(Object.entries(proposal.custom).filter(([, value]) => value !== null)) } : undefined;
    const ruleValue = saved?.rule ?? (preset ? { ...preset.rule, ...(proposal.presetValue !== null ? { value: proposal.presetValue } : {}) } : custom) ?? previous?.rule;
    const rule = ruleValue ? offerRuleSchema.parse(ruleValue) : undefined;
    const kind = previous?.kind ?? (line && line.amount! > 0 ? 'charge' : 'discount');
    if (rule && kind === 'charge') throw Error('A charge needs its printed amount.');
    const matchingRule = rule && options.savedOffers?.find(value => (!value.rule.currency || value.rule.currency === draft.currency)
      && canonicalJson({ ...rule, currency: undefined }) === canonicalJson({ ...value.rule, currency: undefined }));
    const printedAmount = line ? Math.abs(line.amount!) : previous?.printedAmount ?? (rule && previous?.sourceLineIndex !== undefined ? previous.amount : undefined);
    const people = proposal.split?.people ?? [];
    if (new Set(people.map(person => person.id)).size !== people.length || people.some(person => !trip.members.some(member => member.id === person.id))) throw Error('Choose the people sharing the offer.');
    const memberSplit = proposal.split?.mode === 'equal' ? { mode: 'equal' as const, memberIds: people.length ? people.map(person => person.id)
      : [...new Set(draft.items.filter(item => scope.type === 'receipt' || scope.itemIds.includes(item.id)).flatMap(item => item.members))] }
      : proposal.split?.mode === 'exact' ? { mode: 'exact' as const, amounts: Object.fromEntries(people.map(person => [person.id, person.amount])) }
      : !proposal.split ? previous?.memberSplit : undefined;
    const group = scope.type === 'items' && kind === 'discount' ? proposal.group ?? previous?.group
      ?? adjustments.find(value => value.group && canonicalJson(value.scope) === canonicalJson(scope))?.group ?? nextOfferLetter(adjustments) : undefined;
    const candidate = adjustmentSchema.parse({
      ...previous, id: previous?.id ?? crypto.randomUUID(), kind, label: proposal.label ?? saved?.name ?? matchingRule?.name ?? preset?.name ?? previous?.label,
      rule, amount: rule ? undefined : printedAmount ?? previous?.amount, percent: rule || printedAmount ? undefined : previous?.percent,
      printedAmount: rule ? printedAmount : undefined, scope, group,
      sourceLineIndex: line?.lineIndex ?? previous?.sourceLineIndex, source: options.scan ? 'receipt' : 'user',
      stacking: proposal.stacking ?? previous?.stacking, memberSplit,
      rewardOnly: proposal.split ? proposal.split.mode === 'cheapest' : previous?.rewardOnly,
    });
    adjustments = previous ? adjustments.map(value => {
      if (value.id === previous.id) return candidate;
      if (candidate.group && candidate.group === previous.group && candidate.group === value.group && canonicalJson(candidate.scope) !== canonicalJson(previous.scope)) {
        if (options.scan && personControlled(value)) throw Error('A confirmed offer already uses this group.');
        return { ...value, scope: candidate.scope, allocation: undefined };
      }
      return value;
    }) : [...adjustments, candidate];
    const calculated = applyAdjustments(draft.items, adjustments, draft.currency);
    if (calculated.errors.length) throw Error(calculated.errors[0]);
    if (draft.receiptScan && line) {
      const legacyLines = draft.receiptScan.sourceLines?.filter(value => value.mappedTo === 'discount');
      if (kind === 'discount' && draft.discount === Math.abs(line.amount!) && line.mappedTo === 'discount' && legacyLines?.length === 1
        && (!options.scan || draft.fieldSources?.discount !== 'user')) {
        draft.discount = 0;
        draft.fieldSources = { ...draft.fieldSources, discount: options.scan ? 'receipt' : 'ai' };
      }
      draft.receiptScan.sourceLines = draft.receiptScan.sourceLines?.map(value => value === line ? { ...value, mappedTo: 'adjustment' } : value);
    }
  }
  draft.adjustments = adjustmentsSchema.parse(adjustments);
}
