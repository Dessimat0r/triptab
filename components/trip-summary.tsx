"use client";
import { t as uiText } from "@/lib/ui-language";


import { useId, useMemo, useState } from "react";
import { Printer, Share2, X } from "lucide-react";
import ModalA11y from "./modal-accessibility";
import { formatCalendarDate, localDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money-format";
import { spendingSummary, tripSummary } from "@/lib/trip-insights";
import type { Trip } from "@/lib/model";
import "./trip-summary.css";

/** Plain-text version for sharing in a chat or email. */
export function tripSummaryText(trip: Trip, today = localDate()): string {
  const summary = tripSummary(trip, today);
  if (!summary.ok) return `${trip.name}: ${uiText(summary.message)}`;
  const money = (value: number) => formatMoney(value, trip.currency);
  const name = (id: string) => trip.members.find(member => member.id === id)?.name || uiText("Traveller");
  const lines = [
    uiText("{name} — TripTab summary", { name: trip.name }),
    trip.startDate && trip.endDate ? `${formatCalendarDate(trip.startDate)} – ${formatCalendarDate(trip.endDate)}` : "",
    uiText("Total spent: {amount} ({count} expenses)", { amount: money(summary.spending.total), count: trip.expenses.length }),
    summary.spending.budget ? uiText("Budget: {amount} ({percent}% used)", { amount: money(summary.spending.budget.amount), percent: summary.spending.budget.usedPercent }) : "",
    "",
    uiText("Each person’s share:"),
    ...summary.travellers.map(person => uiText("• {name}: share {share}, paid {paid}", { name: person.name, share: money(person.share), paid: money(person.paid) })),
    "",
    uiText(summary.transfers.length ? "To settle up:" : "Everyone is settled up."),
    ...summary.transfers.map(transfer => uiText("• {from} pays {to} {amount}", { from: name(transfer.from), to: name(transfer.to), amount: money(transfer.amount) })),
  ];
  return lines.filter((line, index) => line || lines[index - 1]).join("\n").trim();
}

export function BudgetCard({ trip, today = localDate() }: { trip: Trip; today?: string }) {
  const summary = useMemo(() => spendingSummary(trip, today), [trip, today]);
  if (!trip.budget && !summary.total) return null;
  const money = (value: number) => formatMoney(value, trip.currency);
  const budget = summary.budget;
  const over = !!budget && budget.remaining < 0;
  return <div className="panel budget-card" aria-label={uiText("Group spending")}>
    <div className="budget-figures">
      <div><span className="muted">{uiText("Spent so far")}</span><strong>{money(summary.total)}</strong></div>
      {summary.days > 0 && <div><span className="muted">{uiText("Per day")}</span><strong>{money(summary.dailyAverage)}</strong></div>}
      {budget && <div><span className="muted">{over ? uiText("Over budget") : uiText("Left")}</span><strong className={over ? "negative" : "positive"}>{money(Math.abs(budget.remaining))}</strong></div>}
    </div>
    {budget && <>
      <div className="budget-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, budget.usedPercent)}
        aria-label={uiText("{value0}% of the {value1} budget used", { value0: budget.usedPercent, value1: money(budget.amount) })}>
        <span style={{ width: `${Math.min(100, budget.usedPercent)}%` }} className={over ? "over" : budget.usedPercent > 85 ? "near" : ""} />
      </div>
      <p className="footnote">{budget.usedPercent}{uiText("% of ")}{money(budget.amount)}
        {budget.perDayLeft !== undefined && budget.daysLeft ? uiText(budget.daysLeft === 1 ? " · {amount} a day for the {count} day left" : " · {amount} a day for the {count} days left", { amount: money(budget.perDayLeft), count: budget.daysLeft }) : ""}
        {budget.projected !== undefined ? uiText(" · On track for {value0}", { value0: money(budget.projected) }) : ""}</p>
    </>}
    {summary.unavailable > 0 && <p className="footnote">{uiText(summary.unavailable === 1 ? "{count} expense needs review and is not included." : "{count} expenses need review and are not included.", { count: summary.unavailable })}</p>}
  </div>;
}

export default function TripSummary({ trip, onClose }: { trip: Trip; onClose: () => void }) {
  const id = useId();
  const [shareStatus, setShareStatus] = useState("");
  const today = localDate();
  const summary = tripSummary(trip, today);
  const money = (value: number) => formatMoney(value, trip.currency);
  const name = (memberId: string) => trip.members.find(member => member.id === memberId)?.name || "Traveller";
  async function share() {
    const text = tripSummaryText(trip, today);
    try {
      if (navigator.share) { await navigator.share({ title: uiText("{name} summary", { name: trip.name }), text }); return; }
      await navigator.clipboard.writeText(text);
      setShareStatus("Summary copied. Paste it into a message or email.");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setShareStatus("Unable to share from this browser. Use Print instead.");
    }
  }
  const largestGroup = summary.ok ? Math.max(1, ...summary.spending.byGroup.map(group => group.amount)) : 1;
  return <ModalA11y className="overlay trip-summary-overlay" onClose={onClose}>
    <section className="modal trip-summary" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <div className="modalheading">
        <div>
          <span className="eyebrow">{uiText("END-OF-TRIP SUMMARY")}</span>
          <h2 id={`${id}-title`}>{trip.name}</h2>
          <p className="footnote">{trip.startDate && trip.endDate ? `${formatCalendarDate(trip.startDate)} – ${formatCalendarDate(trip.endDate)} · ` : ""}{trip.members.length}{uiText(" travellers · Amounts in ")}{trip.currency}</p>
        </div>
        <button type="button" className="iconbutton no-print" aria-label={uiText("Close summary")} onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      {!summary.ok ? <p className="error" role="alert">{uiText(summary.message)}</p> : <>
        <dl className="trip-summary-totals">
          <div><dt>{uiText("Total spent")}</dt><dd>{money(summary.spending.total)}</dd></div>
          <div><dt>{uiText("Expenses")}</dt><dd>{trip.expenses.length}</dd></div>
          {summary.spending.days > 0 && <div><dt>{uiText("Per day")}</dt><dd>{money(summary.spending.dailyAverage)}</dd></div>}
          {summary.spending.budget && <div><dt>{uiText("Budget used")}</dt><dd>{summary.spending.budget.usedPercent}%</dd></div>}
        </dl>
        <section aria-labelledby={`${id}-people`}>
          <h3 id={`${id}-people`}>{uiText("Each person")}</h3>
          <table className="trip-summary-table">
            <thead><tr><th scope="col">{uiText("Traveller")}</th><th scope="col">{uiText("Share")}</th><th scope="col">{uiText("Paid")}</th><th scope="col">{uiText("Balance")}</th></tr></thead>
            <tbody>{summary.travellers.map(person => <tr key={person.id}>
              <th scope="row">{person.name}</th><td>{money(person.share)}</td><td>{money(person.paid)}</td>
              <td className={person.net > 0 ? "positive" : person.net < 0 ? "negative" : "muted"}>{person.net > 0 ? "+" : person.net < 0 ? "−" : ""}{money(Math.abs(person.net))}</td>
            </tr>)}</tbody>
          </table>
          <p className="footnote">{uiText("Balance = paid − share + payments sent − payments received.")}</p>
        </section>
        <section aria-labelledby={`${id}-transfers`}>
          <h3 id={`${id}-transfers`}>{uiText("Final transfers")}</h3>
          {summary.transfers.length ? <ul className="trip-summary-transfers">{summary.transfers.map(transfer => <li key={`${transfer.from}:${transfer.to}`}>
            <span><strong>{name(transfer.from)}</strong>{uiText(" pays ")}{name(transfer.to)}</span><b>{money(transfer.amount)}</b>
          </li>)}</ul> : <p>{uiText("Everyone is settled up.")}</p>}
        </section>
        {summary.spending.byGroup.length > 0 && <section aria-labelledby={`${id}-groups`}>
          <h3 id={`${id}-groups`}>{uiText("Where the money went")}</h3>
          <ul className="trip-summary-bars">{summary.spending.byGroup.map(group => <li key={group.group}>
            <span>{uiText(group.group)}</span>
            <span className="trip-summary-bar" aria-hidden="true"><span style={{ width: `${group.amount / largestGroup * 100}%` }} /></span>
            <b>{money(group.amount)}</b>
          </li>)}</ul>
          <p className="footnote">{uiText("Grouped by each expense’s icon.")}</p>
        </section>}
        {summary.spending.byDay.length > 1 && <section aria-labelledby={`${id}-days`}>
          <h3 id={`${id}-days`}>{uiText("By day")}</h3>
          <ul className="trip-summary-days">{summary.spending.byDay.map(day => <li key={day.date}><span>{formatCalendarDate(day.date)}</span><b>{money(day.amount)}</b></li>)}</ul>
        </section>}
      </>}
      {shareStatus && <p className="footnote" role="status">{uiText(shareStatus)}</p>}
      <div className="trip-summary-actions no-print">
        <button type="button" className="quiet" onClick={() => window.print()}><Printer size={16} aria-hidden="true" />{uiText(" Print or save as PDF")}</button>
        <button type="button" className="primary" disabled={!summary.ok} onClick={() => void share()}><Share2 size={16} aria-hidden="true" />{uiText(" Share summary")}</button>
      </div>
    </section>
  </ModalA11y>;
}
