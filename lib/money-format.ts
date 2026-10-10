const currencyFormatters = new Map<string, Intl.NumberFormat>();

/** Format stored minor units consistently without retaining unbounded currencies. */
export function formatMoney(amount: number, currency: string): string {
  let formatter = currencyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-GB", {
      style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
    if (currencyFormatters.size >= 64) currencyFormatters.clear();
    currencyFormatters.set(currency, formatter);
  }
  return formatter.format(amount / 100);
}
