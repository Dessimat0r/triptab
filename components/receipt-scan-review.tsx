"use client";
import { t as uiText } from "@/lib/ui-language";


import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { focusExpenseTarget } from "@/components/expense-quick-review";
import { CURRENCIES } from "@/lib/model";
import type { ReceiptEditor } from "@/lib/receipt-processing";
import { receiptEditorTotal } from "@/lib/receipt-processing";
import { canConfirmReceiptWarning, reconcileReceiptScan, receiptWarningLabel, RESOLVABLE_SCAN_WARNINGS as resolvable } from "@/lib/receipt-scan";
import { formatMoney } from "@/lib/money-format";

export function receiptMoney(amount: number, currency: string | null | undefined) {
  return currency ? formatMoney(amount, currency) : `${(amount / 100).toFixed(2)} · currency needed`;
}
const warningNames: Record<string, string> = {
  "unreadable-amount": "Item price is unreadable. Enter the full line price after checking the image.",
  "uncertain-description": "Item description needs checking against the image.",
  "currency-mismatch": "The selected currency differs from the printed currency. Check both before saving.",
  "ambiguous-currency": "The receipt currency needs your confirmation.",
  "subtotal-mismatch": "The item prices differ from the printed subtotal.",
  "total-mismatch": "The item prices and adjustments differ from the printed total.",
  "possible-duplicate": "These lines may be duplicates. Check the image before removing anything.",
  "unmapped-adjustment": "A discount, refund or charge needs checking. Correct the affected item's full line price and shares, or the receipt adjustment, before confirming it is handled.",
  "included-tax-ambiguous": "Check whether this tax is already included. Only extra tax should be added.",
  "image-may-be-incomplete": "The image may not contain the whole receipt. Check every line and the printed total.",
  "low-confidence": "This receipt detail is uncertain. Check it against the image.",
  "missing-printed-total": "The printed total is unavailable. Enter it only if you can read it, or explicitly review the itemised prices below.",
  "unassigned-item": "Choose who owes this item's cost.",
};

function PrintedAmount({ label, value, onChange }: { label: string; value?: number | null; onChange: (value: number | null) => void }) {
  const [text, setText] = useState(value === null || value === undefined ? "" : (value / 100).toFixed(2));
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (active) setText(previous => (!previous && (value === null || value === undefined)) || (previous && Math.round(Number(previous.replace(",", ".")) * 100) === value) ? previous : value === null || value === undefined ? "" : (value / 100).toFixed(2));
    });
    return () => { active = false; };
  }, [value]);
  return <label>{label}<input aria-label={label} inputMode="decimal" placeholder={uiText("Not readable yet")} value={text} onChange={event => {
    const next = event.target.value.replace(",", ".");
    if (!/^\d*(?:\.\d{0,2})?$/.test(next)) return;
    setText(next);
    const amount = Math.round(Number(next) * 100);
    const parsed = !next || next === "." || !Number.isSafeInteger(amount) || amount > 100000000 ? null : amount;
    if (parsed !== (value ?? null)) onChange(parsed);
  }} /></label>;
}

/**
 * What the receipt says, at the top of Purchase: the photo, the printed and
 * itemised totals, and anything only a correction can resolve. Points that
 * Save confirms are listed once, under Check & save; who shares each line is
 * shown by the lines themselves.
 */
export default function ReceiptScanReview({ entry, onChange, photo, children }: { entry: ReceiptEditor; onChange: (entry: ReceiptEditor) => void; photo?: ReactNode; children?: ReactNode }) {
  const titleId = useId();
  const scan = useMemo(() => entry.receiptScan && reconcileReceiptScan(entry), [entry]);
  if (!entry.receiptId && !entry.receiptScan) return null;
  const calculated = receiptEditorTotal(entry);
  const unknown = entry.items.filter(item => item.amount === null).length;
  const warnings = scan?.warnings.filter(warning => !warning.resolved && warning.code !== "unassigned-item" && !canConfirmReceiptWarning(entry, warning)) || [];
  const name = (itemId?: string) => entry.items.find(item => item.id === itemId)?.name || "Item needing review";
  return <section className="receipt-scan-review" aria-labelledby={titleId}>
    {photo}
    <div className="receipt-scan-review-body">
      <h4 id={titleId}>{!scan ? "Receipt not processed yet" : scan.status === "matched" ? "Receipt totals match exactly" : "Receipt needs review"}</h4>
      {!scan && <p>{uiText("Your photo is stored. Uploading a photo or copying a prompt does not mean its items have been read.")}</p>}
      <dl className="receipt-scan-totals">
        <div><dt>{uiText("Printed receipt total")}</dt><dd>{scan?.printedTotal === null || scan?.printedTotal === undefined ? "Not verified" : receiptMoney(scan.printedTotal, scan.printedCurrency || entry.currency)}</dd></div>
        <div><dt>{uiText("Itemised total")}</dt><dd>{!entry.items.length ? "Not processed" : calculated === null ? "Incomplete prices" : receiptMoney(calculated, entry.currency)}</dd></div>
        {scan?.printedSubtotal !== undefined && scan.printedSubtotal !== null && <div><dt>{uiText("Printed subtotal")}</dt><dd>{receiptMoney(scan.printedSubtotal, scan.printedCurrency || entry.currency)}</dd></div>}
      </dl>
      {(!entry.items.length || unknown > 0 || !entry.currency) && <p className="receipt-review-counts">{entry.items.length} {entry.items.length === 1 ? "line" : "lines"}{unknown ? ` · ${unknown} missing ${unknown === 1 ? "price" : "prices"}` : ""}{!entry.currency ? " · currency needs review" : ""}</p>}
      {!!warnings.length && <ul className="receipt-scan-warnings">{warnings.map((warning, index) => <li key={`${warning.code}:${warning.itemId || index}`}>
        <strong>{warning.itemId ? `${name(warning.itemId)}: ` : ""}{warningNames[warning.code] || "Check this receipt detail."}</strong>
        {"difference" in warning && typeof warning.difference === "number" && <span>{uiText("Difference: ")}{receiptMoney(warning.difference, entry.currency)}</span>}
        {warning.observedText && <span>{uiText("Printed: ")}{warning.observedText}</span>}
      </li>)}</ul>}
      {children}
      {scan && <details className="receipt-printed-evidence"><summary>{uiText("Check or correct printed totals")}</summary>
        <p>{uiText("Enter only amounts you can read on the receipt. These are evidence from the image, separate from the itemised calculation.")}</p>
        <label>{uiText("Printed currency")}<select aria-label={uiText("Printed currency")} value={scan.printedCurrency || ""} onChange={event => onChange({ ...entry, receiptScan: { ...scan, printedCurrency: event.target.value || null, fieldSources: { ...scan.fieldSources, printedCurrency: "user" }, acknowledgement: undefined } })}><option value="">{uiText("Not readable")}</option>{CURRENCIES.map(currency => <option key={currency.code} value={currency.code}>{currency.code} · {currency.name}</option>)}</select></label>
        <div className="fieldpair">{(["printedSubtotal", "printedTotal"] as const).map(field => <PrintedAmount key={field} label={field === "printedTotal" ? "Printed grand total" : "Printed subtotal (optional)"} value={scan[field]} onChange={value => {
          onChange({ ...entry, receiptScan: { ...scan, [field]: value, fieldSources: { ...scan.fieldSources, [field]: "user" }, acknowledgement: undefined } });
        }} />)}</div>
      </details>}
    </div>
  </section>;
}

/** Nothing is acknowledged in the editor. The footer confirms this current evidence on submit. */
export function ReceiptReviewSummary({ entry, fxWarning }: { entry: ReceiptEditor; fxWarning?: string }) {
  const scan = entry.receiptScan && reconcileReceiptScan(entry);
  const warnings = scan?.warnings.filter(warning => canConfirmReceiptWarning(entry, warning)) || [];
  const amount = receiptEditorTotal(entry);
  const points = warnings.flatMap((warning, index) => {
    const ids = warning.itemId ? [warning.itemId] : warning.itemIds || [];
    // Missing financial values and empty names require correction, never acceptance.
    if (warning.code === 'uncertain-description' && ids.some(id => !entry.items.find(item => item.id === id)?.name.trim())) return [];
    let message: string;
    if (warning.code === 'ambiguous-currency' && entry.currency) message = `Currency read as ${entry.currency}`;
    else if (warning.code === 'missing-printed-total') message = `Printed total not readable — saving the itemised ${amount === null ? 'amount once prices are complete' : receiptMoney(amount, entry.currency)}`;
    else if (warning.code === 'total-mismatch' || warning.code === 'subtotal-mismatch') message = `${warning.code === 'total-mismatch' ? 'Itemised total differs from printed total' : 'Item prices differ from printed subtotal'} by ${receiptMoney(Math.abs(warning.difference || 0), entry.currency)}`;
    else if (resolvable.has(warning.code)) message = warning.code === "unmapped-adjustment" ? warningNames[warning.code] : receiptWarningLabel(warning.code);
    else return [];
    const names = ids.map(id => entry.items.find(item => item.id === id)?.name).filter(Boolean).join(', ');
    return [{ key: `${warning.code}:${index}`, message: `${message}${names ? `: ${names}` : ''}`, ids, observedText: warning.observedText, lineIndex: warning.lineIndex }];
  });
  if (!points.length && !fxWarning) return null;
  return <section className="receipt-review-summary" aria-label={uiText("Confirm when saving")}>
    <h4>{uiText("Confirm when saving")}</h4>
    <p>{uiText("Check these details against the receipt. Confirm & save expense accepts the itemised amount and these points.")}</p>
    <ul>{points.map(point => <li key={point.key}>
      <span>{point.message}</span>
      {point.observedText && <small>{uiText("Printed: ")}{point.observedText}</small>}
      {point.ids.map(id => <button key={id} type="button" className="quiet" onClick={() => focusExpenseTarget(`expense-item-${id}`, "input[required]")}>{uiText("Check ")}{entry.items.find(item => item.id === id)?.name || 'item'}</button>)}
      {point.lineIndex !== undefined && <small>{uiText("Receipt line ")}{point.lineIndex + 1}</small>}
    </li>)}{fxWarning && <li><span>{fxWarning}</span><button type="button" className="quiet" onClick={() => focusExpenseTarget("expense-fx-panel", "input[type=number]")}>{uiText("Check rate")}</button></li>}</ul>
  </section>;
}
