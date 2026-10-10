import { getUiLocale } from './ui-language';
const currencyFormatters = new Map<string, Intl.NumberFormat>();

/** Format stored minor units consistently without retaining unbounded currencies. */
export function formatMoney(amount: number, currency: string): string {
  const digits=['ISK','JPY','KRW','VND','CLP'].includes(currency) && amount%100===0 ? 0 : 2;
  const locale = getUiLocale();
  const key=`${locale}:${currency}:${digits}`;
  let formatter = currencyFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits,
    });
    if (currencyFormatters.size >= 64) currencyFormatters.clear();
    currencyFormatters.set(key, formatter);
  }
  return formatter.format(amount / 100);
}
