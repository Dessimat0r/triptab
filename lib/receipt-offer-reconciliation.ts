import type { z } from 'zod';
import { applyAdjustments, personControlled } from './adjustments';
import { canonicalJson } from './data-utils';
import type { Draft, Trip } from './model';
import type { SavedOffer } from './offer-rules';
import { applyReceiptChanges, type ReceiptChanges } from './receipt-proposals';
import { receiptOfferComparisonSchema } from './receipt-offer-proposals';
import { reconcileReceiptScan } from './receipt-scan';

type Comparison = z.infer<typeof receiptOfferComparisonSchema>;
const hasUnresolvedEvidence = (scan: NonNullable<Draft['receiptScan']>) => scan.warnings.some(
  warning => !warning.resolved && !['missing-printed-total', 'unassigned-item'].includes(warning.code),
);
const noChanges: ReceiptChanges = { metadata: null, items: [], removeItemIds: [], clear: [], remember: null, aliases: [] };

/** Compare typed hypotheses, never fit a discount by adjusting the input bill. */
export function compareReceiptOffers(trip: Trip, draft: Draft, input: Comparison, questionId: string, savedOffers?: SavedOffer[]) {
  const { target, alternatives } = receiptOfferComparisonSchema.parse(input);
  const unchanged = (text: string) => ({ draft, text, selected: false as const });
  const author = draft.conversation?.find(message => message.id === questionId && message.role === 'user')?.authorMemberId;
  if (!trip.members.some(member => member.id === author)) {
    return unchanged('Who is asking about this offer? Choose a current traveller before changing the receipt.');
  }
  const scan = draft.receiptScan;
  const explicitLine = scan?.sourceLines?.filter(line => target.sourceLineIndex !== null && line.lineIndex === target.sourceLineIndex);
  const printedSaving = explicitLine?.length === 1 && explicitLine[0].kind === 'adjustment' && (explicitLine[0].amount ?? 0) < 0
    && !['tax', 'tip', 'included'].includes(explicitLine[0].mappedTo ?? '');
  const printedTotal = scan?.printedTotal;
  if (!scan || !draft.currency || printedTotal == null && !printedSaving) {
    return unchanged('I can compare the offers once I have the receipt currency and a printed total or discount. Can you confirm those amounts on the bill?');
  }
  if (!target.items?.length && !target.group && !target.adjustmentId) {
    return unchanged('Which receipt items were eligible for the offer? I haven’t changed the draft.');
  }
  const linked = target.sourceLineIndex === null ? undefined : draft.adjustments?.find(value => value.sourceLineIndex === target.sourceLineIndex);
  if (target.sourceLineIndex !== null && !printedSaving || linked && (target.adjustmentId ? linked.id !== target.adjustmentId : personControlled(linked))) {
    return unchanged('Which printed discount or existing offer should I compare? I haven’t changed the draft.');
  }
  const knownAdjustments = new Set(draft.adjustments?.map(adjustment => adjustment.id));
  const baseline = reconcileReceiptScan(draft);
  if (!printedSaving && printedTotal != null && baseline?.calculatedTotal === printedTotal && !hasUnresolvedEvidence(baseline)) {
    return unchanged('The draft already matches the printed total without changing any offers. Is there a printed discount that should replace an existing one?');
  }

  const format = new Intl.NumberFormat('en-GB', { style: 'currency', currency: draft.currency, maximumFractionDigits: 2 });
  const matches = new Map<string, { draft: Draft; label: string; amount: number; pairs?: number; total: number }>();
  for (const alternative of alternatives) {
    // A hypothesis is a rule, not an untyped way to reuse the printed amount.
    if ([alternative.preset, alternative.savedRule, alternative.custom].filter(Boolean).length !== 1) continue;
    const limits = [target.maxUses, alternative.maxUses].filter(limit => limit != null);
    try {
      const candidate = applyReceiptChanges(trip, draft, { ...noChanges, offers: [{
        ...target, ...alternative, label: null, maxUses: limits.length ? Math.min(...limits) : null,
      }] }, { questionId, savedOffers }).draft;
      const result = candidate.receiptScan;
      if (result?.calculatedTotal == null || hasUnresolvedEvidence(result) || printedTotal != null && result.calculatedTotal !== printedTotal) continue;
      const adjustment = candidate.adjustments?.find(value => target.adjustmentId ? value.id === target.adjustmentId
        : target.sourceLineIndex === null ? !knownAdjustments.has(value.id) : value.sourceLineIndex === target.sourceLineIndex);
      if (!adjustment?.rule || adjustment.scope.type !== 'items') continue;
      const { applied, errors } = applyAdjustments(candidate.items, candidate.adjustments, candidate.currency);
      const offer = applied.find(value => value.id === adjustment.id);
      // The printed saving may override the calculated saving in the ordinary
      // editor. It must NOT mask a wrong rule when disambiguating offers.
      if (errors.length || !offer?.amount || offer.expected !== offer.amount) continue;
      const label = adjustment.rule.pairing && adjustment.rule.benefit === 'price'
        ? adjustment.rule.value ? `Buy one, get the cheaper one for ${format.format(adjustment.rule.value / 100)}` : 'Buy one, get the cheaper one free'
        : adjustment.label || 'The offer';
      matches.set(canonicalJson(adjustment.rule), { draft: candidate, label, amount: offer.amount, pairs: offer.pairCount, total: result.calculatedTotal });
    } catch {
      // An inapplicable rule (for example an incomplete set) is not a match.
    }
  }
  if (matches.size > 1) return unchanged('More than one offer matches the printed amounts. Can you confirm the exact wording of the offer? I haven’t changed the draft.');
  if (matches.size === 0) return unchanged('None of the plausible offers reconciles with the receipt as recorded. Can you check the printed discount and any service charge? I haven’t changed the draft.');
  const match = [...matches.values()][0];
  const pairs = match.pairs == null ? '' : ` on ${match.pairs} ${match.pairs === 1 ? 'pair' : 'pairs'}`;
  const evidence = printedTotal == null ? 'matches the printed discount'
    : `matches the printed total of ${format.format(match.total / 100)}`;
  return { draft: match.draft, selected: true as const,
    text: `${match.label} is the only option tested that ${evidence}. It saves ${format.format(match.amount / 100)}${pairs}. Review the offer before saving the expense.` };
}
