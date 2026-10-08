"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { CURRENCIES } from "@/lib/model";
import type { ReceiptEditor } from "@/lib/receipt-processing";
import { receiptEditorTotal } from "@/lib/receipt-processing";
import { reconcileReceiptScan, receiptWarningLabel, RESOLVABLE_SCAN_WARNINGS as resolvable } from "@/lib/receipt-scan";
import { formatMoney } from "@/lib/money-format";

export function receiptMoney(amount: number, currency: string | null | undefined) {
  return currency ? formatMoney(amount, currency) : `${(amount / 100).toFixed(2)} · currency needed`;
}
const warningNames: Record<string, string> = {
  "unreadable-amount": "Item price is unreadable. Enter the full line price after checking the image.",
  "uncertain-description": "Item description needs checking against the image.",
  "currency-mismatch": "Original currency differs from the printed currency. Check both before saving.",
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
  return <label>{label}<input aria-label={label} inputMode="decimal" placeholder="Not readable yet" value={text} onChange={event => {
    const next = event.target.value.replace(",", ".");
    if (!/^\d*(?:\.\d{0,2})?$/.test(next)) return;
    setText(next);
    const amount = Math.round(Number(next) * 100);
    const parsed = !next || next === "." || !Number.isSafeInteger(amount) || amount > 100000000 ? null : amount;
    if (parsed !== (value ?? null)) onChange(parsed);
  }} /></label>;
}

export default function ReceiptScanReview({ entry, onChange }: { entry: ReceiptEditor; onChange: (entry: ReceiptEditor) => void }) {
  const titleId = useId();
  const scan = useMemo(() => entry.receiptScan && reconcileReceiptScan(entry), [entry]);
  if (!entry.receiptId && !entry.receiptScan) return null;
  const calculated = receiptEditorTotal(entry);
  const unassigned = entry.percentages === undefined ? entry.items.filter(item => !item.members.length).length : 0;
  const unknown = entry.items.filter(item => item.amount === null).length;
  const warnings = scan?.warnings.filter(warning => !warning.resolved) || [];
  const name = (itemId?: string) => entry.items.find(item => item.id === itemId)?.name || "Item needing review";
  return <section className="receipt-scan-review" aria-labelledby={titleId}>
    <h3 id={titleId}>{!scan ? "Receipt not processed yet" : scan.status === "matched" ? "Receipt totals match exactly" : "Receipt needs review"}</h3>
    {!scan && <p>Your photo is stored. Uploading a photo or copying a prompt does not mean its items have been read.</p>}
    <dl className="receipt-scan-totals">
      <div><dt>Printed receipt total</dt><dd>{scan?.printedTotal === null || scan?.printedTotal === undefined ? "Not verified" : receiptMoney(scan.printedTotal, scan.printedCurrency || entry.currency)}</dd></div>
      <div><dt>Itemised total</dt><dd>{!entry.items.length ? "Not processed" : calculated === null ? "Incomplete prices" : receiptMoney(calculated, entry.currency)}</dd></div>
      {scan?.printedSubtotal !== undefined && scan.printedSubtotal !== null && <div><dt>Printed subtotal</dt><dd>{receiptMoney(scan.printedSubtotal, scan.printedCurrency || entry.currency)}</dd></div>}
    </dl>
    <p className="receipt-review-counts">{entry.items.length} {entry.items.length === 1 ? "line" : "lines"} · {unassigned} need people assigned{unknown ? ` · ${unknown} missing ${unknown === 1 ? "price" : "prices"}` : ""}{!entry.currency ? " · currency needs review" : ""}</p>
    {!!warnings.length && <ul className="receipt-scan-warnings">{warnings.map((warning, index) => <li key={`${warning.code}:${warning.itemId || index}`}>
      <strong>{warning.itemId ? `${name(warning.itemId)}: ` : ""}{warningNames[warning.code] || "Check this receipt detail."}</strong>
      {"difference" in warning && typeof warning.difference === "number" && <span>Difference: {receiptMoney(warning.difference, entry.currency)}</span>}
      {warning.observedText && <span>Printed: {warning.observedText}</span>}
    </li>)}</ul>}
    {scan && <details className="receipt-printed-evidence"><summary>Check or correct printed totals</summary>
      <p>Enter only amounts you can read on the receipt. These are evidence from the image, separate from the itemised calculation.</p>
      <label>Printed currency<select aria-label="Printed currency" value={scan.printedCurrency || ""} onChange={event => onChange({ ...entry, receiptScan: { ...scan, printedCurrency: event.target.value || null, fieldSources: { ...scan.fieldSources, printedCurrency: "user" }, acknowledgement: undefined } })}><option value="">Not readable</option>{CURRENCIES.map(currency => <option key={currency.code} value={currency.code}>{currency.code} · {currency.name}</option>)}</select></label>
      <div className="fieldpair">{(["printedSubtotal", "printedTotal"] as const).map(field => <PrintedAmount key={field} label={field === "printedTotal" ? "Printed grand total" : "Printed subtotal (optional)"} value={scan[field]} onChange={value => {
        onChange({ ...entry, receiptScan: { ...scan, [field]: value, fieldSources: { ...scan.fieldSources, [field]: "user" }, acknowledgement: undefined } });
      }} />)}</div>
    </details>}
    <ReceiptReviewSummary entry={entry} />
  </section>;
}

/** Nothing is acknowledged in the editor. The footer confirms this current evidence on submit. */
export function ReceiptReviewSummary({ entry, fxWarning }: { entry: ReceiptEditor; fxWarning?: string }) {
  const scan = entry.receiptScan && reconcileReceiptScan(entry);
  const warnings = scan?.warnings.filter(warning => !warning.resolved) || [];
  const amount = receiptEditorTotal(entry);
  const points = warnings.flatMap((warning, index) => {
    const ids = warning.itemId ? [warning.itemId] : warning.itemIds || [];
    // Missing financial values and empty names require correction, never acceptance.
    if (warning.code === 'uncertain-description' && ids.some(id => !entry.items.find(item => item.id === id)?.name.trim())) return [];
    let message: string;
    if (warning.code === 'ambiguous-currency' && entry.currency) message = `Currency read as ${entry.currency}`;
    else if (warning.code === 'missing-printed-total') message = `Printed total not readable — saving the itemised ${amount === null ? 'amount once prices are complete' : receiptMoney(amount, entry.currency)}`;
    else if (warning.code === 'total-mismatch' || warning.code === 'subtotal-mismatch') message = `${warning.code === 'total-mismatch' ? 'Itemised total differs from printed total' : 'Item prices differ from printed subtotal'} by ${receiptMoney(Math.abs(warning.difference || 0), entry.currency)}`;
    else if (resolvable.has(warning.code)) message = receiptWarningLabel(warning.code);
    else return [];
    const names = ids.map(id => entry.items.find(item => item.id === id)?.name).filter(Boolean).join(', ');
    return [{ key: `${warning.code}:${index}`, message: `${message}${names ? `: ${names}` : ''}`, ids, observedText: warning.observedText, lineIndex: warning.lineIndex }];
  });
  if (!points.length && !fxWarning) return null;
  return <section className="receipt-review-summary" aria-label="Confirm when saving">
    <h4>Confirm when saving</h4>
    <p>Check these details against the receipt. Confirm &amp; save expense accepts the itemised amount and these points.</p>
    <ul>{points.map(point => <li key={point.key}>
      <span>{point.message}</span>
      {point.observedText && <small>Printed: {point.observedText}</small>}
      {point.ids.map(id => <a key={id} href={`#expense-item-${id}`}>Check {entry.items.find(item => item.id === id)?.name || 'item'}</a>)}
      {entry.receiptId && <a href={`/api/receipt?id=${encodeURIComponent(entry.receiptId)}`} target="_blank" rel="noopener noreferrer">{point.lineIndex === undefined ? 'View photo' : `View photo, line ${point.lineIndex + 1}`}</a>}
    </li>)}{fxWarning && <li><span>{fxWarning}</span><a href="#expense-fx-panel">Check rate</a></li>}</ul>
  </section>;
}
