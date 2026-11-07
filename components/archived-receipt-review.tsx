"use client";
import { useId, useState } from "react";
import { X } from "lucide-react";
import ModalA11y from "./modal-accessibility";
import { useAccountResource } from "./use-account-resource";
import { applyAdjustments } from "@/lib/adjustments";
import { financialFormatHeaders } from "@/lib/financial-format";
import { formatCalendarDate } from "@/lib/dates";
import { expenseTotal, type Trip } from "@/lib/model";
import { formatMoney } from "@/lib/money-format";
import { t as uiText } from "@/lib/ui-language";

/**
 * A historical-audit link to a receipt in an archived holiday or bill (R09).
 * The receipt is shown read-only from this account's own archive, which the
 * server checks; nothing is unarchived unless the person chooses Restore and
 * review. A deleted bill, a revoked membership or a guessed ID all show the
 * same "not available" message, so the link reveals nothing about them.
 */
export default function ArchivedReceiptReview({ accountId, tripId, expenseId, onClose, onRestore }: {
  accountId: string; tripId: string; expenseId: string; onClose: () => void;
  /** Restores the holiday or bill, then opens the receipt for editing. */
  onRestore: (tripId: string, expenseId: string) => Promise<boolean>;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const archive = useAccountResource<Trip[]>(accountId, "/api/trip?mode=archived-data",
    body => (body as { trips?: Trip[] } | null)?.trips ?? [], { init: { headers: financialFormatHeaders() } });
  const trip = archive?.find(value => value.id === tripId);
  const expense = trip?.expenses.find(value => value.id === expenseId);
  const money = (amount: number, currency: string) => formatMoney(amount, currency);
  let total: number | null = null;
  if (trip && expense) try { total = expenseTotal(expense, trip.currency); } catch { total = null; }
  const net = expense ? applyAdjustments(expense.items, expense.adjustments).net : [];
  const scan = expense?.receiptScan;
  return <ModalA11y className="overlay" onClose={onClose}>
    <section className="modal archived-receipt" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <div className="modalheading"><h2 id={`${id}-title`}>{expense ? expense.title : uiText("Receipt review")}</h2>
        <button type="button" className="iconbutton" aria-label={uiText("Close")} onClick={onClose}><X /></button></div>
      {archive === null ? <p role="status">{uiText("Checking this receipt…")}</p>
        : !trip || !expense ? <p role="alert">{uiText("This receipt isn’t available. It may have been deleted, or you may no longer have access to it.")}</p>
        : <>
          <p className="footnote">{uiText("{value0} is archived, so this receipt is read-only. Nothing here changes amounts, shares or payments.", { value0: trip.name })}</p>
          <p>{formatCalendarDate(expense.date)}{" · "}{uiText("Paid by {value0}", { value0: trip.members.find(member => member.id === expense.payer)?.name ?? uiText("someone") })}</p>
          <ul className="archived-receipt-items">{expense.items.map((item, index) => <li key={item.id}>
            <span>{item.name || uiText("Item {value0}", { value0: index + 1 })}</span>
            <b>{item.amount === null ? uiText("Needs review") : money(item.amount, expense.currency)}</b>
            {item.amount !== null && net[index] !== item.amount && net[index] !== null && <small>{uiText(" after discounts {value0}", { value0: money(net[index]!, expense.currency) })}</small>}
          </li>)}</ul>
          {!!expense.adjustments?.length && <ul>{expense.adjustments.map(adjustment => <li key={adjustment.id}>
            {adjustment.label || (adjustment.kind === "discount" ? uiText("Discount") : uiText("Charge"))}{" "}
            {adjustment.amount !== undefined ? `${adjustment.kind === "discount" ? "−" : "+"}${money(adjustment.amount, expense.currency)}` : `${adjustment.percent}%`}
          </li>)}</ul>}
          <p><b>{uiText("Saved total: {value0}", { value0: total === null ? uiText("can’t be calculated") : money(total, trip.currency) })}</b></p>
          {scan?.printedTotal !== undefined && scan.printedTotal !== null && <p>{uiText("Printed total: {value0}", { value0: money(scan.printedTotal, scan.printedCurrency || expense.currency) })}</p>}
          {scan?.acknowledgement?.reason && <p>{uiText("Saved reason: {value0}", { value0: scan.acknowledgement.reason })}</p>}
          <div className="action-row">
            <button type="button" className="primary" disabled={busy} onClick={async () => {
              setBusy(true);
              try { if (await onRestore(trip.id, expense.id)) onClose(); } finally { setBusy(false); }
            }}>{busy ? uiText("Restoring…") : uiText("Restore and review")}</button>
            <button type="button" className="quiet" onClick={onClose}>{uiText("Close")}</button>
          </div>
          <p className="footnote">{uiText("Restoring puts it back in your open list so you can edit the receipt. It doesn’t change any amounts.")}</p>
        </>}
    </section>
  </ModalA11y>;
}
