import { z } from 'zod';

// Handles only: TripTab builds every payment URL itself, so a saved value can
// never redirect a payer to an arbitrary site.
export const PAYMENT_METHODS = [
  { key: 'paypal', label: 'PayPal', host: 'paypal.me/', pattern: /^[A-Za-z0-9]{1,20}$/, example: 'paypal.me/yourname' },
  { key: 'monzo', label: 'Monzo', host: 'monzo.me/', pattern: /^[A-Za-z0-9._-]{1,40}$/, example: 'monzo.me/yourname' },
  { key: 'revolut', label: 'Revolut', host: 'revolut.me/', pattern: /^[A-Za-z0-9._-]{3,40}$/, example: 'revolut.me/yourname' },
  { key: 'wise', label: 'Wise', host: 'wise.com/pay/me/', pattern: /^[A-Za-z0-9._-]{1,40}$/, example: 'wise.com/pay/me/yourname' },
] as const;
export type PaymentMethodKey = typeof PAYMENT_METHODS[number]['key'];
export const MAX_BANK_DETAILS = 200;

const handle = (method: typeof PAYMENT_METHODS[number]) => z.string().regex(method.pattern, `Enter a valid ${method.label} username`).optional();
export const payToSchema = z.object({
  paypal: handle(PAYMENT_METHODS[0]),
  monzo: handle(PAYMENT_METHODS[1]),
  revolut: handle(PAYMENT_METHODS[2]),
  wise: handle(PAYMENT_METHODS[3]),
  bank: z.string().trim().min(1).max(MAX_BANK_DETAILS).optional(),
}).strict();
export type PayTo = z.infer<typeof payToSchema>;

/**
 * Accepts what people paste: a bare username, "@name" or a full payment link.
 * Returns the bare handle, "" for an empty field, or null when it is not valid.
 */
export function normalisePaymentHandle(key: PaymentMethodKey, input: string): string | null {
  const method = PAYMENT_METHODS.find(value => value.key === key)!;
  let value = input.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (value.toLowerCase().startsWith(method.host)) value = value.slice(method.host.length);
  value = value.replace(/^@/, '').replace(/[/?#].*$/, '');
  if (!value) return '';
  return method.pattern.test(value) ? value : null;
}

export function hasPaymentDetails(payTo?: PayTo): payTo is PayTo {
  return !!payTo && (PAYMENT_METHODS.some(method => !!payTo[method.key]) || !!payTo.bank);
}

export type PaymentLink = { key: PaymentMethodKey; label: string; href: string; withAmount: boolean };

/** Links that open the payee's own payment page; TripTab never moves money. */
export function paymentLinks(payTo: PayTo | undefined, amount: number, currency: string, reference: string): PaymentLink[] {
  if (!payTo) return [];
  const value = (amount / 100).toFixed(2);
  const links: PaymentLink[] = [];
  for (const method of PAYMENT_METHODS) {
    const name = payTo[method.key];
    if (!name || !method.pattern.test(name)) continue;
    const path = encodeURIComponent(name);
    if (method.key === 'paypal') links.push({ key: method.key, label: method.label, withAmount: true, href: `https://paypal.me/${path}/${value}${currency}` });
    else if (method.key === 'monzo') links.push(currency === 'GBP'
      ? { key: method.key, label: method.label, withAmount: true, href: `https://monzo.me/${path}/${value}?d=${encodeURIComponent(reference.slice(0, 60))}` }
      : { key: method.key, label: method.label, withAmount: false, href: `https://monzo.me/${path}` });
    else if (method.key === 'revolut') links.push({ key: method.key, label: method.label, withAmount: false, href: `https://revolut.me/${path}` });
    else links.push({ key: method.key, label: method.label, withAmount: false, href: `https://wise.com/pay/me/${path}` });
  }
  return links;
}

export function paymentDetailsSummary(payTo?: PayTo): string {
  if (!hasPaymentDetails(payTo)) return 'No payment details';
  return [...PAYMENT_METHODS.filter(method => payTo[method.key]).map(method => `${method.label}: ${payTo[method.key]}`),
    ...(payTo.bank ? [`Bank: ${payTo.bank}`] : [])].join('\n');
}
