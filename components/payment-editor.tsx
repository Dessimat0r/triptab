"use client";

import { useId, useState } from "react";
import { X } from "lucide-react";
import { balances, paymentSchema, type Payment, type Trip } from "@/lib/model";
import { localDate } from "@/lib/dates";
import ModalA11y from "./modal-accessibility";
import RestorationNotice, { type RestorationInfo } from "./restoration-notice";

export type PaymentEditorProps = {
  trip: Trip;
  initial: Payment;
  busy: boolean;
  error?: string;
  restoredFrom?: RestorationInfo;
  onClose: () => void;
  onSave: (payment: Payment) => Promise<boolean>;
};

function amountInMinorUnits(value: string): number {
  const normalized = value.trim().replace(",", ".");
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(normalized)) {
    throw new Error("Enter a positive amount with at most two decimal places.");
  }
  const [whole, fraction = ""] = normalized.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export default function PaymentEditor({ trip, initial, busy, error, restoredFrom, onClose, onSave }: PaymentEditorProps) {
  const id = useId();
  const [paymentId] = useState(initial.id);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [amount, setAmount] = useState(initial.amount ? (initial.amount / 100).toFixed(2) : "");
  const [date, setDate] = useState(() => initial.date || localDate());
  const [time, setTime] = useState(initial.time || "");
  const [timezone, setTimezone] = useState(() => initial.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/London");
  const [method, setMethod] = useState(initial.method || "");
  const [note, setNote] = useState(initial.note || "");
  const [review, setReview] = useState<Payment | null>(null);
  const [localError, setLocalError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const locked = busy || submitting;
  const existing = trip.payments.some(payment => payment.id === paymentId);
  const name = (memberId: string) => trip.members.find(member => member.id === memberId)?.name || "Traveller";
  const money = (value: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: trip.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100);

  function validate(payment: Payment): Payment {
    const parsed = paymentSchema.safeParse(payment);
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || "Check the payment details.");
    if (!trip.members.some(member => member.id === payment.from) || !trip.members.some(member => member.id === payment.to)) {
      throw new Error("Choose two travellers from this holiday.");
    }
    if (payment.from === payment.to) throw new Error("Choose a different recipient.");
    if (payment.amount <= 0) throw new Error("The payment must be greater than zero.");
    return parsed.data;
  }

  let warning = "";
  let before: number[] = [];
  try {
    before = balances({ ...trip, payments: trip.payments.filter(payment => payment.id !== paymentId) });
    if (review) {
      const sender = before[trip.members.findIndex(member => member.id === review.from)];
      const recipient = before[trip.members.findIndex(member => member.id === review.to)];
      if (sender >= 0 || recipient <= 0) {
        warning = "This transfer goes against the current balances. Confirm it only if this money was actually transferred.";
      } else if (review.amount > Math.min(-sender, recipient)) {
        warning = "This amount is larger than the current balance between these travellers and will create an overpayment. Confirm it only if this money was actually transferred.";
      }
    }
  } catch {
    warning = "Current balances could not be checked. Review the holiday expenses before confirming this payment.";
  }
  if (review) {
    const matches = trip.payments.filter(payment => payment.id !== paymentId &&
      payment.from === review.from && payment.to === review.to &&
      payment.amount === review.amount && payment.date === review.date);
    if (matches.length) {
      const details = [...new Set(matches.slice(0, 3).map(payment =>
        [payment.time ? `at ${payment.time}${payment.timezone ? ` (${payment.timezone})` : ""}` : "", payment.method ? `by ${payment.method}` : ""].filter(Boolean).join(" "),
      ).filter(Boolean))].join("; ");
      warning += `${warning ? " " : ""}${matches.length === 1 ? "Another recorded payment has" : `${matches.length} recorded payments have`} the same sender, recipient, amount and date${details ? `: ${details}` : "."}${details ? "." : ""} Confirm only if this was a separate transfer.`;
    }
  }

  return (
    <ModalA11y className="overlay" onClose={() => { if (!locked) onClose(); }}>
      <section className="modal small payment-editor" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
        <div className="modalheading">
          <div>
            <span className="eyebrow">MONEY ALREADY TRANSFERRED</span>
            <h2 id={`${id}-title`}>{review ? "Review payment" : existing ? "Edit payment" : "Record a payment"}</h2>
          </div>
          <button type="button" className="iconbutton" aria-label="Close payment editor" disabled={locked} onClick={onClose}><X /></button>
        </div>
        {restoredFrom && <RestorationNotice info={restoredFrom} />}
        <form onSubmit={async event => {
          event.preventDefault();
          if (locked) return;
          setLocalError("");
          try {
            if (!review) {
              setReview(validate({
                id: paymentId, from, to, amount: amountInMinorUnits(amount), date,
                ...(time ? { time } : {}),
                ...(timezone.trim() ? { timezone: timezone.trim() } : {}),
                ...(method.trim() ? { method: method.trim() } : {}),
                ...(note.trim() ? { note: note.trim() } : {}),
              }));
              return;
            }
            const payment = validate(review);
            setSubmitting(true);
            if (await onSave(payment)) onClose();
          } catch (cause) {
            setLocalError(cause instanceof Error ? cause.message : "Unable to record this payment. Your details are still here.");
          } finally {
            setSubmitting(false);
          }
        }}>
          {review ? (
            <div className="payment-review">
              <p><strong>{name(review.from)}</strong> paid <strong>{name(review.to)}</strong></p>
              <h3>{money(review.amount)}</h3>
              <dl>
                <dt>Date</dt><dd>{review.date}{review.time ? ` at ${review.time}` : ""}</dd>
                {review.timezone && <><dt>Timezone</dt><dd>{review.timezone}</dd></>}
                {review.method && <><dt>Method</dt><dd>{review.method}</dd></>}
                {review.note && <><dt>Note</dt><dd>{review.note}</dd></>}
              </dl>
              {before.length === trip.members.length && (
                <p className="footnote">
                  Before this payment: {name(review.from)} {before[trip.members.findIndex(member => member.id === review.from)] < 0 ? "owes" : "is owed"} {money(Math.abs(before[trip.members.findIndex(member => member.id === review.from)] || 0))}; {name(review.to)} {before[trip.members.findIndex(member => member.id === review.to)] < 0 ? "owes" : "is owed"} {money(Math.abs(before[trip.members.findIndex(member => member.id === review.to)] || 0))}.
                </p>
              )}
              {warning && <p className="payment-warning" role="status">{warning}</p>}
              <p className="footnote">Confirming records the transfer in TripTab. It does not send money.</p>
            </div>
          ) : (
            <>
              <div className="fieldpair">
                <label htmlFor={`${id}-from`}>Paid by
                  <select id={`${id}-from`} value={from} disabled={locked} onChange={event => setFrom(event.target.value)} required>
                    <option value="">Choose a traveller</option>
                    {trip.members.map(member => <option value={member.id} key={member.id}>{member.name}</option>)}
                  </select>
                </label>
                <label htmlFor={`${id}-to`}>Paid to
                  <select id={`${id}-to`} value={to} disabled={locked} onChange={event => setTo(event.target.value)} required>
                    <option value="">Choose a traveller</option>
                    {trip.members.map(member => <option value={member.id} key={member.id}>{member.name}</option>)}
                  </select>
                </label>
              </div>
              <label htmlFor={`${id}-amount`}>Amount ({trip.currency})
                <input id={`${id}-amount`} value={amount} disabled={locked} required inputMode="decimal" maxLength={16} placeholder="0.00" onChange={event => setAmount(event.target.value)} />
              </label>
              <div className="fieldpair">
                <label htmlFor={`${id}-date`}>Date
                  <input id={`${id}-date`} type="date" value={date} disabled={locked} required onChange={event => setDate(event.target.value)} />
                </label>
                <label htmlFor={`${id}-time`}>Time (optional)
                  <input id={`${id}-time`} type="time" value={time} disabled={locked} onChange={event => setTime(event.target.value)} />
                </label>
              </div>
              <label htmlFor={`${id}-timezone`}>Timezone
                <input id={`${id}-timezone`} value={timezone} disabled={locked} maxLength={100} placeholder="Europe/London" required={!!time} onChange={event => setTimezone(event.target.value)} />
              </label>
              <label htmlFor={`${id}-method`}>Payment method (optional)
                <input id={`${id}-method`} value={method} disabled={locked} maxLength={80} placeholder="Bank transfer, cash…" onChange={event => setMethod(event.target.value)} />
              </label>
              <label htmlFor={`${id}-note`}>Note (optional)
                <textarea id={`${id}-note`} value={note} disabled={locked} maxLength={500} rows={3} placeholder="Add any useful details" onChange={event => setNote(event.target.value)} />
              </label>
            </>
          )}
          {(localError || error) && <p className="error" role="alert">{localError || error}</p>}
          <div className="payment-actions">
            {review && <button type="button" className="quiet" disabled={locked} onClick={() => { setReview(null); setLocalError(""); }}>Edit details</button>}
            <button className="primary" disabled={locked}>{locked ? "Saving…" : review ? "Confirm payment" : "Review payment"}</button>
          </div>
        </form>
      </section>
    </ModalA11y>
  );
}
