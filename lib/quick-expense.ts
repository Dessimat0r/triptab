import type { ReceiptEditor } from './receipt-processing';

/** A hand-entered expense with a single line: no photo, scan or receipt draft behind it. */
export function isManualSingleLine(entry: ReceiptEditor) {
  return !entry.receiptId && !entry.receiptScan && !entry.draftId && entry.items.length === 1;
}

/**
 * A manual expense with one priced line shared by at least one person needs
 * no item editor: its name is the line's name, and the single-amount split
 * covers equal, percentage and quantity shares. Anything richer (a photo, a
 * scan, several lines, a separately named line, translations or printed
 * quantities) opens the item list so nothing is flattened.
 */
export function quickEligible(entry: ReceiptEditor) {
  const [item] = entry.items;
  return isManualSingleLine(entry) && entry.percentages === undefined
    && !!item.members.length && item.amount !== null && item.name === entry.title && !item.quantity
    && !item.scanSource && !Object.keys(item.translations ?? {}).length;
}

/**
 * A receipt (photo, scan or draft) with one line uses the same single-amount
 * layout. Its line keeps its own name, printed evidence and translations,
 * shown beside the amount, so the expense name never renames what was read.
 */
export function singleReceiptLineEligible(entry: ReceiptEditor) {
  return !isManualSingleLine(entry) && entry.items.length === 1 && entry.percentages === undefined;
}

/** In the quick form the expense name is also its single line's name. */
export function withQuickName(entry: ReceiptEditor, name: string): ReceiptEditor {
  return { ...entry, items: entry.items.map((item, index) => index === 0 ? { ...item, name, fieldSources: { ...item.fieldSources, name: "user" as const } } : item) };
}

/** Whether returning to one amount would discard whole-bill percentages, quantities or translations. */
export function hasItemSplitDetail(entry: ReceiptEditor) {
  const [item] = entry.items;
  return entry.percentages !== undefined || !!item.quantity || !!Object.keys(item.translations ?? {}).length;
}

/**
 * Return a single manual line to the single-amount form. The line keeps its
 * id, amount (a missing one stays blank in the form and blocks saving), chosen
 * people and any percentage or quantity shares, which the single-amount split
 * shows as they are. Choosing nobody is a save blocker the caller must not
 * clear on the person's behalf. The expense title names the line; a line
 * named while the title was blank names the expense instead.
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
      quantity: undefined,
      translations: undefined,
      scanSource: undefined,
    }],
  }, title);
}
