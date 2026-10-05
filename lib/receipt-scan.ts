/** The empty placeholder row a new draft starts with; nothing a person could have typed. */
export function blankReceiptItem(item: { name: string; amount: number | null; quantity?: unknown; scanSource?: unknown }) {
  return !item.name.trim() && item.amount === 0 && item.quantity === undefined && item.scanSource === undefined;
}
/**
 * Whether recognition may fill a saved item field whose provenance is unknown.
 * Legacy values may have been typed by a person, so only a missing name, a null
 * price or an untouched placeholder row is safe to infer. Native and connected-
 * assistant rescans share this one rule so they cannot diverge.
 */
export function mayRecognizeUnknownProvenance(field: 'name' | 'amount', item: { name: string; amount: number | null; quantity?: unknown; scanSource?: unknown }) {
  return field === 'name' ? !item.name.trim() : item.amount === null || blankReceiptItem(item);
}
