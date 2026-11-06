/**
 * Money typed as text, in exact hundredths. One "." or "," is the decimal
 * separator, so "12,50" and "12.50" are both 1250. Anything else (grouping
 * separators, signs, a third decimal) is rejected rather than reinterpreted:
 * "1,234.56" must never silently become another amount. `null` means
 * rejected; "" and a bare separator are unfinished input.
 */
export function parseAmountText(text: string): { text: string; hundredths: number | undefined } | null {
  const s = text.trim().replace(",", ".");
  if (!/^\d*(\.\d{0,2})?$/.test(s)) return null;
  if (!s || s === ".") return { text: s, hundredths: undefined };
  const n = Math.round(Number(s) * 100);
  return Number.isSafeInteger(n) && n <= 100000000 ? { text: s, hundredths: n } : null;
}
