import type { ReceiptEditor } from './receipt-processing';

/** A hand-entered expense with a single line: no photo, scan or receipt draft behind it. */
export function isManualSingleLine(entry: ReceiptEditor) {
  return !entry.receiptId && !entry.receiptScan && !entry.draftId && entry.items.length === 1;
}

/**
 * A manual expense with one line priced and shared equally (or by one
 * person) needs no item editor: its name is the line's name. Anything richer
 * (a photo, a scan, several lines, a separately named line, percentages or
 * quantities) opens the full itemised editor so nothing is flattened.
 */
export function quickEligible(entry: ReceiptEditor) {
  const [item] = entry.items;
  return isManualSingleLine(entry) && entry.percentages === undefined
    && !!item.members.length && item.amount !== null && item.name === entry.title && !item.units && !item.percentages && !item.quantity
    && !item.scanSource && !Object.keys(item.translations ?? {}).length;
}

/** In the quick form the expense name is also its single line's name. */
export function withQuickName(entry: ReceiptEditor, name: string): ReceiptEditor {
  return { ...entry, items: entry.items.map((item, index) => index === 0 ? { ...item, name, fieldSources: { ...item.fieldSources, name: "user" as const } } : item) };
}

/** Whether returning to one amount would discard custom shares, units, quantities or translations. */
export function hasItemSplitDetail(entry: ReceiptEditor) {
  const [item] = entry.items;
  return entry.percentages !== undefined || !!item.percentages || !!item.units || !!item.quantity || !!Object.keys(item.translations ?? {}).length;
}

/**
 * Return a single manual line to the equal/one-person quick form. The line
 * keeps its id, amount (a missing one stays blank in the form and blocks
 * saving) and chosen people, which must not be empty: choosing nobody is a
 * save blocker the caller must not clear on the person's behalf. The expense
 * title names the line; a line named while the title was blank names the
 * expense instead.
 */
export function collapseToQuick(entry: ReceiptEditor): ReceiptEditor {
  const [item] = entry.items;
  const title = entry.title || item.name;
  return withQuickName({
    ...entry,
    title,
    percentages: undefined,
    items: [{
      ...item,
      amount: item.amount ?? 0,
      percentages: undefined,
      units: undefined,
      quantity: undefined,
      translations: undefined,
      scanSource: undefined,
    }],
  }, title);
}
