import type { ReceiptEditor } from './receipt-processing';

export type FxReference = { rate: number; currency: string; date: string; time: string; timezone: string };

/** A reference belongs to this exact purchase; an old lookup cannot question a new rate. */
export function manualFxReview(entry: ReceiptEditor, settlementCurrency: string, reference?: FxReference | null): string | undefined {
  if (entry.fx?.source !== 'manual' || entry.bankAmount !== undefined || entry.currency === settlementCurrency) return;
  const matching = reference && reference.currency === entry.currency && reference.date === entry.date
    && reference.time === entry.time && reference.timezone === entry.timezone ? reference.rate : undefined;
  if (matching && Math.abs(entry.fx.rate / matching - 1) > 0.1) {
    return `Manual rate differs from reference by ${Math.round(Math.abs(entry.fx.rate / matching - 1) * 100)}%`;
  }
  if (!matching && ['GBP', 'EUR', 'CHF', 'USD'].includes(settlementCurrency) && (entry.fx.rate > 100 || entry.fx.rate < 0.0001)) {
    return 'Manual conversion rate is unusually large or small';
  }
}
