"use client";

import { useId } from "react";
import { X } from "lucide-react";
import { balances, expenseShares, expenseTotal, type Trip } from "@/lib/model";
import ModalA11y from "./modal-accessibility";

export type MemberStatementProps = {
  trip: Trip;
  memberId: string;
  onClose: () => void;
};

function displayDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .format(new Date(date + "T00:00:00Z"));
}

export default function MemberStatement({ trip, memberId, onClose }: MemberStatementProps) {
  const id = useId();
  const index = trip.members.findIndex(member => member.id === memberId);
  const member = trip.members[index];
  const money = (value: number) => new Intl.NumberFormat("en-GB", {
    style: "currency", currency: trip.currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(value / 100);
  let error = "";
  let net = 0;
  let expenses: { expense: Trip["expenses"][number]; cost: number; paid: number }[] = [];
  const payments = trip.payments.filter(payment => payment.from === memberId || payment.to === memberId)
    .slice().sort((left, right) => right.date.localeCompare(left.date) || (right.time || "").localeCompare(left.time || ""));
  try {
    if (!member) throw Error("This traveller is no longer in the holiday.");
    net = balances(trip)[index];
    expenses = trip.expenses.map(expense => ({
      expense,
      cost: expenseShares(expense, trip.members, trip.currency)[index],
      paid: expense.payer === memberId ? expenseTotal(expense, trip.currency) : 0,
    })).filter(row => row.cost !== 0 || row.paid !== 0)
      .sort((left, right) => right.expense.date.localeCompare(left.expense.date) || right.expense.time.localeCompare(left.expense.time));
  } catch (cause) {
    error = cause instanceof Error ? cause.message : "Unable to calculate this statement. Review the holiday expenses.";
  }
  const cost = expenses.reduce((sum, row) => sum + row.cost, 0);
  const paid = expenses.reduce((sum, row) => sum + row.paid, 0);
  const sent = payments.reduce((sum, payment) => sum + (payment.from === memberId ? payment.amount : 0), 0);
  const received = payments.reduce((sum, payment) => sum + (payment.to === memberId ? payment.amount : 0), 0);
  const traveller = (value: string) => trip.members.find(person => person.id === value)?.name || "Traveller";

  return <ModalA11y className="overlay" onClose={onClose}>
    <section className="modal member-statement" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`}>
      <div className="modalheading">
        <div>
          <span className="eyebrow">HOW THE BALANCE ADDS UP</span>
          <h2 id={`${id}-title`}>{member?.name || "Traveller"}’s statement</h2>
          <p id={`${id}-hint`} className="footnote">{trip.name} · All amounts below are in {trip.currency}.</p>
        </div>
        <button type="button" className="iconbutton" aria-label="Close traveller statement" onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : <>
        <div className="statement-summary">
          <p className="statement-net"><span>{net > 0 ? "Should receive" : net < 0 ? "Still owes" : "Settled up"}</span><strong>{money(Math.abs(net))}</strong></p>
          <dl className="statement-totals">
            <div><dt>Paid upfront</dt><dd>{money(paid)}</dd></div>
            <div><dt>Cost share</dt><dd>−{money(cost)}</dd></div>
            <div><dt>Payments sent</dt><dd>+{money(sent)}</dd></div>
            <div><dt>Payments received</dt><dd>−{money(received)}</dd></div>
          </dl>
          <p className="footnote">Paid upfront − cost share + payments sent − payments received = balance. A positive balance is money to receive; a negative balance is money still owed.</p>
        </div>
        <section className="statement-section" aria-labelledby={`${id}-expenses`}>
          <h3 id={`${id}-expenses`}>Expenses</h3>
          <p className="footnote">Cost shares include receipt percentages, item assignments, tax, tips, discounts and currency conversion. Every penny follows the holiday’s saved split.</p>
          {expenses.length ? <ul className="statement-entries">
            {expenses.map(({ expense, cost, paid }) => <li key={expense.id} className="statement-entry">
              <div className="statement-entry-heading">
                <strong>{expense.title}</strong>
                <time dateTime={expense.date}>{displayDate(expense.date)} · {expense.time}</time>
              </div>
              <p className="footnote">Paid by {traveller(expense.payer)} · {expense.currency} receipt · {expense.timezone}</p>
              <dl>
                <div><dt>Cost share</dt><dd>{money(cost)}</dd></div>
                <div><dt>Paid upfront</dt><dd>{money(paid)}</dd></div>
              </dl>
              {expense.currency !== trip.currency && <p className="footnote">{expense.bankAmount !== undefined
                ? `Uses the recorded bank charge of ${money(expense.bankAmount)} for the whole receipt.`
                : expense.fx ? `${expense.fx.source === "reference" ? "Daily reference" : "Manual"} exchange rate: ${expense.fx.rate} ${trip.currency} per ${expense.currency}, dated ${displayDate(expense.fx.asOf)}.` : ""}</p>}
            </li>)}
          </ul> : <p className="statement-empty">No expenses involving this traveller yet.</p>}
        </section>
        <section className="statement-section" aria-labelledby={`${id}-payments`}>
          <h3 id={`${id}-payments`}>Recorded payments</h3>
          {payments.length ? <ul className="statement-entries">
            {payments.map(payment => <li key={payment.id} className="statement-entry">
              <div className="statement-entry-heading">
                <strong>{payment.from === memberId ? `Sent to ${traveller(payment.to)}` : `Received from ${traveller(payment.from)}`}</strong>
                <span>{money(payment.amount)}</span>
              </div>
              <p className="footnote"><time dateTime={payment.date}>{displayDate(payment.date)}{payment.time ? ` · ${payment.time}` : ""}</time>{payment.timezone ? ` · ${payment.timezone}` : ""}{payment.method ? ` · ${payment.method}` : ""}</p>
              {payment.note && <p className="statement-payment-note">{payment.note}</p>}
            </li>)}
          </ul> : <p className="statement-empty">No payments sent or received yet.</p>}
          <p className="footnote">Recorded payments describe money already transferred between travellers.</p>
        </section>
      </>}
      <div className="statement-actions"><button type="button" className="quiet" onClick={onClose}>Close statement</button></div>
    </section>
  </ModalA11y>;
}
