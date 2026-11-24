import { z } from 'zod';

const money = z.number().int().min(0).max(100000000);
const count = z.number().int().min(1).max(200);
const percent = z.number().positive().max(100).refine(value => Math.abs(value * 100 - Math.round(value * 100)) < 1e-8);

/** A versioned snapshot. These values have the same meaning in AI, review and settlement. */
export const offerRuleSchema = z.object({
  version: z.literal(1),
  buy: count.optional(),
  cheapest: count.optional(),
  benefit: z.enum(['price', 'percent', 'amount']),
  value: money.or(percent),
  limit: count.optional(),
  cap: money.positive().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
}).strict().superRefine((rule, context) => {
  const bad = (path: string, message: string) => context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  if (rule.cheapest !== undefined && (rule.buy === undefined || rule.cheapest > rule.buy)) bad('cheapest', 'Choose at most as many discounted portions as the offer requires');
  if (!rule.buy && rule.limit) bad('limit', 'A use limit needs a qualifying quantity');
  if (rule.benefit === 'percent' && !percent.safeParse(rule.value).success) bad('value', 'Enter a percentage from 0 to 100 with up to two decimal places');
  if (rule.benefit !== 'percent' && !money.safeParse(rule.value).success) bad('value', 'Enter a whole number of minor currency units');
  if (rule.benefit === 'amount' && !rule.value) bad('value', 'Enter a positive saving');
});

export type OfferRule = z.infer<typeof offerRuleSchema>;
export const savedOfferSchema = z.object({ name: z.string().trim().min(1).max(80), rule: offerRuleSchema }).strict();
export type SavedOffer = z.infer<typeof savedOfferSchema>;

export const builtInOffers = {
  bogof: { name: 'Buy one, get one free', rule: { version: 1, buy: 2, cheapest: 1, benefit: 'price', value: 0 } },
  secondPrice: { name: 'Buy one, get one for a set price', rule: { version: 1, buy: 2, cheapest: 1, benefit: 'price', value: 100 } },
  bundle: { name: 'Bundle for a set price', rule: { version: 1, benefit: 'price', value: 0 } },
  percentage: { name: 'Percentage off', rule: { version: 1, benefit: 'percent', value: 10 } },
  fixed: { name: 'Fixed amount off', rule: { version: 1, benefit: 'amount', value: 100 } },
} satisfies Record<string, SavedOffer>;

type Portion = { line: number; price: number };

/** Each complete set is an offer use. For multiple sets the selected receipt
 *  portions are grouped highest price first so results do not depend on UI order. */
export function offerSaving(rule: OfferRule, portions: Portion[], roundPercent: (base: number, percent: number) => number) {
  const eligible = [...portions].sort((a, b) => b.price - a.price || a.line - b.line);
  const size = rule.buy ?? eligible.length;
  const uses = size ? Math.min(rule.limit ?? Infinity, Math.floor(eligible.length / size)) : 0;
  const rewards = new Map<number, number>();
  let amount = 0;
  for (let i = 0; i < uses; i++) {
    const set = eligible.slice(i * size, (i + 1) * size);
    const reward = rule.cheapest ? set.slice(-rule.cheapest) : set;
    const rewardTotal = reward.reduce((sum, portion) => sum + portion.price, 0);
    const saving = rule.benefit === 'percent' ? roundPercent(rewardTotal, rule.value)
      : rule.benefit === 'amount' ? Math.min(rule.value, rewardTotal) : Math.max(0, rewardTotal - rule.value);
    amount += saving;
    for (const { line, price } of reward) rewards.set(line, (rewards.get(line) ?? 0) + price);
  }
  return { amount: Math.min(amount, rule.cap ?? Infinity), uses, rewards };
}
