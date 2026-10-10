"use client";

import { useId, useState } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { formatCalendarDate } from "@/lib/dates";
import { formatMoney as money } from "@/lib/money-format";
import { EXPENSE_CATEGORIES, EXPENSE_SORTS, expenseFilterActive, type ExpenseCategory, type ExpenseFilter, type SpendingBreakdown } from "@/lib/expense-insights";
import type { Currency, Trip } from "@/lib/model";
import "./expense-insights.css";

export function ExpenseFilterBar({ filter, onChange, members, shown, total }: {
  filter: ExpenseFilter; onChange: (next: ExpenseFilter) => void;
  members: Trip["members"]; shown: number; total: number;
}) {
  const id = useId();
  const chosen = [filter.payer, filter.participant, filter.category].filter(Boolean).length;
  const [open, setOpen] = useState(chosen > 0 || filter.sort !== "recent");
  const set = <K extends keyof ExpenseFilter>(key: K, value: ExpenseFilter[K]) => onChange({ ...filter, [key]: value });
  const active = expenseFilterActive(filter);
  return <div className="expense-filters" role="search" aria-label="Find expenses">
    <div className="expense-search-row">
      <label className="expense-search" htmlFor={`${id}-query`}>
        <span className="sr-only">Search expenses</span>
        <Search size={17} aria-hidden="true" />
        <input id={`${id}-query`} type="search" value={filter.query} maxLength={100} autoComplete="off" enterKeyHint="search"
          placeholder="Search names, items or places" onChange={event => set("query", event.target.value)} />
      </label>
      <button type="button" className="quiet expense-filter-toggle" aria-expanded={open} aria-controls={`${id}-fields`} onClick={() => setOpen(value => !value)}>
        <SlidersHorizontal size={16} aria-hidden="true" />Filter{chosen ? <span className="badge" aria-label={`${chosen} active`}>{chosen}</span> : null}
      </button>
    </div>
    {open && <div id={`${id}-fields`} className="expense-filter-fields">
      <label>Paid by
        <select value={filter.payer} onChange={event => set("payer", event.target.value)}>
          <option value="">Anyone</option>
          {members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select>
      </label>
      <label>Shared by
        <select value={filter.participant} onChange={event => set("participant", event.target.value)}>
          <option value="">Anyone</option>
          {members.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select>
      </label>
      <label>Category
        <select value={filter.category} onChange={event => set("category", event.target.value as ExpenseCategory | "")}>
          <option value="">All categories</option>
          {EXPENSE_CATEGORIES.map(category => <option key={category} value={category}>{category}</option>)}
        </select>
      </label>
      <label>Sort
        <select value={filter.sort} onChange={event => set("sort", event.target.value as ExpenseFilter["sort"])}>
          {EXPENSE_SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
    </div>}
    <p className="expense-filter-status" role="status">
      {active ? <>Showing {shown} of {total} {total === 1 ? "expense" : "expenses"}
        <button type="button" className="link-button" onClick={() => onChange({ ...filter, query: "", payer: "", participant: "", category: "" })}>
          <X size={14} aria-hidden="true" />Clear filters
        </button></> : null}
    </p>
  </div>;
}

type BreakdownView = "category" | "day" | "traveller";
const VIEWS: [BreakdownView, string][] = [["category", "Category"], ["day", "Day"], ["traveller", "Traveller"]];

function percent(amount: number, total: number) {
  if (!total) return 0;
  return Math.round(amount / total * 1000) / 10;
}

function BarRow({ label, detail, amount, total, currency, selected, onSelect }: {
  label: string; detail?: string; amount: number; total: number; currency: Currency;
  selected?: boolean; onSelect?: () => void;
}) {
  const share = percent(amount, total);
  const body = <>
    <span className="breakdown-label"><span>{label}</span>{detail && <small>{detail}</small>}</span>
    <span className="breakdown-value"><b>{money(amount, currency)}</b><small>{share}%</small></span>
    <span className="breakdown-track" aria-hidden="true"><span className="breakdown-bar" style={{ width: `${Math.max(share, amount > 0 ? 1 : 0)}%` }} /></span>
  </>;
  return <li>{onSelect
    ? <button type="button" className="breakdown-row" aria-pressed={!!selected} onClick={onSelect}>{body}</button>
    : <div className="breakdown-row">{body}</div>}</li>;
}

/** Where the money went. Category rows filter the expense list below. */
export function SpendingBreakdownPanel({ breakdown, members, currency, category, onCategory, filtered }: {
  breakdown: SpendingBreakdown; members: Trip["members"]; currency: Currency;
  category: ExpenseCategory | ""; onCategory: (category: ExpenseCategory | "") => void; filtered: boolean;
}) {
  const id = useId();
  const [view, setView] = useState<BreakdownView>("category");
  const top = breakdown.categories[0];
  const days = breakdown.days.length;
  const names = new Map(members.map(member => [member.id, member.name]));
  return <details className="panel spending-breakdown">
    <summary>
      <span className="spending-summary-title">Spending breakdown</span>
      <small>{breakdown.counted
        ? `${money(breakdown.total, currency)}${top ? ` · Most on ${top.category.toLowerCase()} (${percent(top.amount, breakdown.total)}%)` : ""}`
        : "No amounts to show yet"}{filtered ? " · Matching your search" : ""}</small>
    </summary>
    <div className="spending-breakdown-body">
      <div className="breakdown-views" role="group" aria-label="Break down spending by">
        {VIEWS.map(([value, label]) => <button key={value} type="button" className="breakdown-view" aria-pressed={view === value} aria-controls={`${id}-list`} onClick={() => setView(value)}>{label}</button>)}
      </div>
      <ul id={`${id}-list`} className="breakdown-list" aria-label={view === "category" ? "Spending by category" : view === "day" ? "Spending by day" : "Each traveller’s share"}>
        {view === "category" && breakdown.categories.map(entry => <BarRow key={entry.category} label={entry.category}
          detail={`${entry.count} ${entry.count === 1 ? "expense" : "expenses"}${category === entry.category ? " · Showing below" : ""}`}
          amount={entry.amount} total={breakdown.total} currency={currency} selected={category === entry.category}
          onSelect={() => onCategory(category === entry.category ? "" : entry.category)} />)}
        {view === "day" && breakdown.days.map(entry => <BarRow key={entry.date} label={formatCalendarDate(entry.date)}
          detail={`${entry.count} ${entry.count === 1 ? "expense" : "expenses"}`} amount={entry.amount} total={breakdown.total} currency={currency} />)}
        {view === "traveller" && breakdown.travellers.map(entry => <BarRow key={entry.memberId} label={names.get(entry.memberId) || "Unknown"}
          amount={entry.amount} total={breakdown.total} currency={currency} />)}
      </ul>
      <p className="footnote">
        {view === "category" ? "Categories follow each expense’s icon. Change an icon to recategorise it; tap a category to list only its expenses."
          : view === "day" ? `${days} ${days === 1 ? "day" : "days"} with spending · ${money(days ? Math.round(breakdown.total / days) : 0, currency)} a day on average.`
            : "What each person owes for these expenses, whoever paid upfront."}
        {breakdown.needsReview ? ` ${breakdown.needsReview} ${breakdown.needsReview === 1 ? "expense needs" : "expenses need"} review and ${breakdown.needsReview === 1 ? "is" : "are"} not included.` : ""}
      </p>
    </div>
  </details>;
}
