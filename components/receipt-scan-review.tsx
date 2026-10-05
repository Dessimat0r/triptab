"use client";

import { useEffect, useId, useState } from "react";
import { CURRENCIES } from "@/lib/model";
import type { ReceiptEditor } from "@/lib/receipt-processing";
import { receiptEditorTotal } from "@/lib/receipt-processing";
import { reconcileReceiptScan, receiptScanFingerprint, receiptWarningNames } from "@/lib/receipt-scan";
import { formatMoney } from "@/lib/money-format";

export function receiptMoney(amount: number, currency: string | null | undefined) {
  return currency ? formatMoney(amount, currency) : `${(amount / 100).toFixed(2)} · currency needed`;
}
const resolvable = new Set(["uncertain-description", "possible-duplicate", "unmapped-adjustment", "included-tax-ambiguous", "image-may-be-incomplete", "low-confidence", "ambiguous-currency"]);

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
    onChange(!next || next === "." || !Number.isSafeInteger(amount) || amount > 100000000 ? null : amount);
  }} /></label>;
}

export default function ReceiptScanReview({ entry, onChange }: { entry: ReceiptEditor; onChange: (entry: ReceiptEditor) => void }) {
  const titleId = useId();
  if (!entry.receiptId && !entry.receiptScan) return null;
  const scan = entry.receiptScan && reconcileReceiptScan(entry);
  const calculated = receiptEditorTotal(entry);
  const unassigned = entry.percentages === undefined ? entry.items.filter(item => !item.members.length).length : 0;
  const unknown = entry.items.filter(item => item.amount === null).length;
  const warnings = scan?.warnings.filter(warning => !warning.resolved) || [];
  const mismatches = warnings.filter(warning => warning.code === "subtotal-mismatch" || warning.code === "total-mismatch");
  const acknowledged = !!scan?.acknowledgement && scan.acknowledgement.fingerprint === receiptScanFingerprint({ ...entry, receiptScan: scan });
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
      <strong>{warning.itemId ? `${name(warning.itemId)}: ` : ""}{receiptWarningNames[warning.code] || "Check this receipt detail."}</strong>
      {"difference" in warning && typeof warning.difference === "number" && <span>Difference: {receiptMoney(warning.difference, entry.currency)}</span>}
      {warning.observedText && <span>Printed: {warning.observedText}</span>}
      {resolvable.has(warning.code) && <button type="button" className="quiet" onClick={() => {
        if (!entry.receiptScan) return;
        const updated = scan!.warnings.map(value => value === warning ? { ...value, resolved: true as const } : value);
        onChange({ ...entry, ...(warning.code === "ambiguous-currency" && entry.currency ? { fieldSources: { ...entry.fieldSources, currency: "user" as const } } : {}), receiptScan: { ...entry.receiptScan, warnings: updated, acknowledgement: undefined } });
      }}>{warning.code === "unmapped-adjustment" ? "I corrected and checked this adjustment" : "I checked this against the receipt"}</button>}
    </li>)}</ul>}
    {scan && <details className="receipt-printed-evidence"><summary>Check or correct printed totals</summary>
      <p>Enter only amounts you can read on the receipt. These are evidence from the image, separate from the itemised calculation.</p>
      <label>Printed currency<select aria-label="Printed currency" value={scan.printedCurrency || ""} onChange={event => onChange({ ...entry, receiptScan: { ...scan, printedCurrency: event.target.value || null, fieldSources: { ...scan.fieldSources, printedCurrency: "user" }, acknowledgement: undefined } })}><option value="">Not readable</option>{CURRENCIES.map(currency => <option key={currency.code} value={currency.code}>{currency.code} · {currency.name}</option>)}</select></label>
      <div className="fieldpair">{(["printedSubtotal", "printedTotal"] as const).map(field => <PrintedAmount key={field} label={field === "printedTotal" ? "Printed grand total" : "Printed subtotal (optional)"} value={scan[field]} onChange={value => {
        onChange({ ...entry, receiptScan: { ...scan, [field]: value, fieldSources: { ...scan.fieldSources, [field]: "user" }, acknowledgement: undefined } });
      }} />)}</div>
    </details>}
    {scan && mismatches.length > 0 && <label className="checklabel receipt-total-ack"><input type="checkbox" checked={acknowledged} onChange={event => onChange({ ...entry, receiptScan: { ...scan, acknowledgement: event.target.checked ? { fingerprint: receiptScanFingerprint({ ...entry, receiptScan: scan }) } : undefined } })} />I checked the photo and item prices. Save the reviewed itemised amount despite this difference.</label>}
    {acknowledged && <p>Difference acknowledged. Any further changes require a new check.</p>}
  </section>;
}
