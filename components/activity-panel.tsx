"use client";

import { useEffect, useRef, useState } from "react";
import type { Currency } from "@/lib/model";
import type { ActivityEvent } from "@/lib/store";

export type ActivityPanelProps = {
  tripId: string;
  refreshKey?: number;
  currency?: Currency;
  memberNames?: Record<string, string>;
  onRestore?: (event: ActivityEvent) => void;
  busy?: boolean;
};

type Page = { events: ActivityEvent[]; nextCursor: number | null };
type State = Page & { key: string; loading: boolean; error: string };
type Change = { label: string; before: string; after: string };

class ActivityError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

async function activityPage(tripId: string, signal: AbortSignal, before?: number): Promise<Page> {
  const params = new URLSearchParams({ tripId, limit: "20" });
  if (before !== undefined) params.set("before", String(before));
  const response = await fetch(`/api/activity?${params}`, { cache: "no-store", credentials: "same-origin", signal });
  const body = await response.json() as Page & { error?: string };
  if (!response.ok) throw new ActivityError(body.error || "Unable to load this holiday's activity.", response.status);
  if (!Array.isArray(body.events) || body.events.length > 50 ||
    (body.nextCursor !== null && (!Number.isSafeInteger(body.nextCursor) || body.nextCursor < 1))) {
    throw new ActivityError("The activity response was incomplete. Please try again.");
  }
  return { events: body.events, nextCursor: body.nextCursor };
}

function same(left: unknown, right: unknown) { return JSON.stringify(left) === JSON.stringify(right); }
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function money(value: unknown, currency?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not recorded";
  try {
    if (currency) return new Intl.NumberFormat("en-GB", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100);
  } catch {}
  return `${new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 100)} (holiday currency)`;
}
function percentages(value: unknown, names: Record<string, string>): string {
  const entries = record(value);
  if (!entries) return "Item shares";
  return Object.entries(entries).map(([id, percent], index) => `${names[id] || `Person ${index + 1}`}: ${percent}%`).join("; ");
}
function quantity(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-GB", { maximumFractionDigits: 6 }).format(value)
    : "Not recorded";
}
function itemDescription(value: unknown, currency: string | undefined, names: Record<string, string>): string {
  const item = record(value);
  if (!item) return "Not recorded";
  const members = Array.isArray(item.members) ? item.members.filter((id): id is string => typeof id === "string") : [];
  const units = record(item.units);
  const allocations = record(units?.allocations);
  const split = units ? `${quantity(units.total)} ${text(units.label) || "units"} total${allocations ? `; ${Object.entries(allocations).map(([id, amount], index) => `${names[id] || `Person ${index + 1}`}: ${quantity(amount)}`).join("; ")}` : ""}`
    : item.percentages ? percentages(item.percentages, names) : members.length
    ? members.every(id => names[id]) ? members.map(id => names[id]).join(", ") : `${members.length} ${members.length === 1 ? "person" : "people"}`
    : "No participants";
  return `${text(item.name) || "Item"}: ${money(item.amount, currency)} · ${split}`;
}

function itemName(snapshot: Record<string, unknown>, id: unknown): string {
  const item = (Array.isArray(snapshot.items) ? snapshot.items : []).map(record).find(value => value?.id === id);
  return text(item?.name) || "an earlier item";
}

function memoryAliases(value: unknown, snapshot: Record<string, unknown>, names: Record<string, string>): string {
  if (!Array.isArray(value) || !value.length) return "No saved names";
  return value.map(value => {
    const alias = record(value);
    if (!alias) return "Earlier saved name";
    const meaning = alias.itemId ? itemName(snapshot, alias.itemId)
      : alias.memberId ? names[text(alias.memberId)] || "an earlier traveller" : "this receipt";
    const scope = alias.scopeMemberId ? ` (for ${names[text(alias.scopeMemberId)] || "an earlier traveller"})` : "";
    return `“${text(alias.name) || "Saved name"}” means ${meaning}${scope}`;
  }).join("; ");
}

function changes(event: ActivityEvent, currency: Currency | undefined, names: Record<string, string>): Change[] {
  const before = event.before || {};
  const after = event.after || {};
  const result: Change[] = [];
  const labels: Record<string, string> = {
    name: "Name", title: "Title", currency: "Currency", date: "Date", startDate: "Start date", endDate: "End date",
    time: "Time", timezone: "Timezone", method: "Payment method", note: "Note", status: "Review status", source: "Entry source",
  };
  for (const [key, label] of Object.entries(labels)) {
    if (!same(before[key], after[key])) result.push({ label, before: text(before[key]) || "Not recorded", after: text(after[key]) || "Not recorded" });
  }
  for (const [key, label] of Object.entries({ amount: "Amount", tax: "Tax", tip: "Tip", discount: "Discount", bankAmount: "Actual bank charge" })) {
    if (!same(before[key], after[key])) result.push({
      label,
      before: money(before[key], key === "bankAmount" || event.entityType === "payment" ? currency : text(before.currency) || currency),
      after: money(after[key], key === "bankAmount" || event.entityType === "payment" ? currency : text(after.currency) || currency),
    });
  }
  for (const [key, label] of Object.entries({ from: "Paid by", to: "Paid to", payer: "Receipt payer" })) {
    if (!same(before[key], after[key])) result.push({ label, before: before[key] ? names[text(before[key])] || "Previous traveller" : "Not recorded", after: after[key] ? names[text(after[key])] || "Selected traveller" : "Not recorded" });
  }
  if (!same(before.percentages, after.percentages)) result.push({ label: "Whole-receipt split", before: percentages(before.percentages, names), after: percentages(after.percentages, names) });
  if (!same(before.adjustmentAllocation, after.adjustmentAllocation)) {
    const policy = (value: unknown) => value === "selected-participants" ? "People selected on receipt items" : "Earlier rule: all travellers";
    result.push({ label: "Adjustment split when item prices are zero", before: policy(before.adjustmentAllocation), after: policy(after.adjustmentAllocation) });
  }
  if (!same(before.fx, after.fx)) {
    const rate = (value: unknown) => {
      const fx = record(value);
      return fx ? `${fx.rate} · ${text(fx.asOf)} · ${text(fx.source)}` : "No recorded rate";
    };
    result.push({ label: "Exchange rate", before: rate(before.fx), after: rate(after.fx) });
  }
  if (!same(before.receiptId, after.receiptId)) result.push({ label: "Receipt image", before: before.receiptId ? "Previous attached image" : "No image", after: after.receiptId ? "Attached image" : "No image" });
  if (!same(before.expenseId, after.expenseId)) result.push({ label: "Receipt review", before: before.expenseId ? "Existing expense" : "New expense", after: after.expenseId ? "Existing expense" : "New expense" });
  if (!same(before.userId, after.userId)) result.push({ label: "Traveller account", before: before.userId ? "Previously linked account" : "Not linked", after: after.userId ? "Linked account" : "Not linked" });
  if (!same(before.memberOrder, after.memberOrder)) {
    const order = (value: unknown) => Array.isArray(value) ? value.map((id, index) => names[text(id)] || `Person ${index + 1}`).join(", ") : "Not recorded";
    result.push({ label: "Traveller order", before: order(before.memberOrder), after: order(after.memberOrder) });
  }
  if (!same(before.conversation, after.conversation)) {
    const description = (value: unknown, snapshot: Record<string, unknown>) => {
      if (!Array.isArray(value) || !value.length) return "No messages";
      const latest = record(value[value.length - 1]);
      const question = latest?.replyTo ? value.map(record).find(message => message?.id === latest.replyTo) : null;
      const context = latest?.itemId || question?.itemId;
      const author = text(latest?.authorName) || names[text(latest?.authorMemberId)] || (latest?.role === "assistant" ? "ChatGPT/Codex" : "Traveller");
      return `${value.length} ${value.length === 1 ? "message" : "messages"}${latest ? ` · ${author}${context ? ` about ${itemName(snapshot, context)}` : " about this receipt"}: ${text(latest.text).slice(0, 300)}` : ""}`;
    };
    result.push({ label: "Receipt conversation", before: description(before.conversation, before), after: description(after.conversation, after) });
  }
  const oldMemory = record(before.memory);
  const newMemory = record(after.memory);
  if (text(oldMemory?.notes) !== text(newMemory?.notes)) {
    result.push({ label: "Remembered receipt notes", before: text(oldMemory?.notes) || "No saved notes", after: text(newMemory?.notes) || "No saved notes" });
  }
  if (!same(oldMemory?.aliases || [], newMemory?.aliases || [])) {
    result.push({ label: "Remembered names", before: memoryAliases(oldMemory?.aliases, before, names), after: memoryAliases(newMemory?.aliases, after, names) });
  }
  const oldItems = new Map((Array.isArray(before.items) ? before.items : []).map(value => { const item = record(value); return [text(item?.id), value]; }));
  const newItems = new Map((Array.isArray(after.items) ? after.items : []).map(value => { const item = record(value); return [text(item?.id), value]; }));
  let changedItems = 0;
  for (const id of new Set([...oldItems.keys(), ...newItems.keys()])) {
    if (same(oldItems.get(id), newItems.get(id))) continue;
    changedItems++;
    if (changedItems <= 12) result.push({
      label: oldItems.has(id) ? newItems.has(id) ? "Item changed" : "Item removed" : "Item added",
      before: itemDescription(oldItems.get(id), text(before.currency) || currency, names),
      after: itemDescription(newItems.get(id), text(after.currency) || currency, names),
    });
  }
  if (changedItems > 12) result.push({ label: "More items", before: "", after: `${changedItems - 12} further item changes` });
  return result;
}

function eventLabel(event: ActivityEvent, currency?: Currency): string {
  const snapshot = event.after || event.before || {};
  if (event.entityType === "payment") return `${money(snapshot.amount, currency)} payment`;
  return text(snapshot.title) || text(snapshot.name) || ({ trip: "Holiday", expense: "Expense", member: "Traveller", draft: "Receipt draft" }[event.entityType]) || "Entry";
}

export default function ActivityPanel({ tripId, refreshKey = 0, currency, memberNames = {}, onRestore, busy = false }: ActivityPanelProps) {
  const [attempt, setAttempt] = useState(0);
  const key = `${tripId}:${refreshKey}:${attempt}`;
  const [state, setState] = useState<State>({ key: "", events: [], nextCursor: null, loading: true, error: "" });
  const olderRequest = useRef<AbortController | null>(null);
  const active: State = state.key === key ? state : { key, events: [], nextCursor: null, loading: true, error: "" };

  useEffect(() => {
    const controller = new AbortController();
    activityPage(tripId, controller.signal).then(page => {
      if (!controller.signal.aborted) setState({ ...page, key, loading: false, error: "" });
    }).catch(cause => {
      if (!controller.signal.aborted) setState({ key, events: [], nextCursor: null, loading: false, error: cause instanceof Error ? cause.message : "Unable to load activity." });
    });
    return () => { controller.abort(); olderRequest.current?.abort(); };
  }, [tripId, key]);

  async function loadOlder() {
    if (active.loading || active.nextCursor === null) return;
    const controller = new AbortController();
    olderRequest.current?.abort();
    olderRequest.current = controller;
    setState(previous => previous.key === key ? { ...previous, loading: true, error: "" } : previous);
    try {
      const page = await activityPage(tripId, controller.signal, active.nextCursor);
      if (!controller.signal.aborted) setState(previous => {
        if (previous.key !== key) return previous;
        const ids = new Set(previous.events.map(event => event.id));
        return { ...previous, events: [...previous.events, ...page.events.filter(event => !ids.has(event.id))], nextCursor: page.nextCursor, loading: false, error: "" };
      });
    } catch (cause) {
      if (!controller.signal.aborted) setState(previous => previous.key === key ? {
        ...previous,
        ...(cause instanceof ActivityError && [401, 403].includes(cause.status) ? { events: [], nextCursor: null } : {}),
        loading: false, error: cause instanceof Error ? cause.message : "Unable to load older changes.",
      } : previous);
    }
  }

  return (
    <section className="activity-panel" aria-label="Holiday activity" aria-busy={active.loading}>
      <h2 className="subheading">Activity</h2>
      <p className="footnote">See who changed expenses, payments and travellers. Earlier snapshots remain in the history.</p>
      {active.loading && !active.events.length && <p role="status">Loading activity…</p>}
      {active.error && <p className="error" role="alert">{active.error}</p>}
      {!active.loading && !active.error && !active.events.length && <p className="footnote">No recorded changes yet. Activity starts when this version of TripTab saves a change.</p>}
      <ol className="activity-list">
        {active.events.map(event => {
          const fields = changes(event, currency, memberNames);
          const parsedDate = new Date(event.createdAt);
          return (
            <li key={event.id} className="activity-event">
              <p><strong>{event.actorName || "Traveller"}</strong> {({ create: "created", update: "updated", delete: "removed" }[event.action]) || "changed"} <strong>{eventLabel(event, currency)}</strong></p>
              <p className="footnote"><time dateTime={event.createdAt}>{Number.isFinite(parsedDate.getTime()) ? parsedDate.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Date unavailable"}</time>{event.source === "chatgpt" ? " · via ChatGPT/Codex" : " · in TripTab"}</p>
              <details>
                <summary>View {event.action === "update" ? "changes" : "details"}</summary>
                {fields.length ? (
                  <dl className="activity-changes">
                    {fields.map((field, index) => (
                      <div key={`${field.label}-${index}`}>
                        <dt>{field.label}</dt>
                        <dd>
                          {event.before && field.before && <span className="activity-before"><span className="muted">Before: </span>{field.before}</span>}
                          {event.after && field.after && <span className="activity-after"><span className="muted">After: </span>{field.after}</span>}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : <p className="footnote">Entry metadata changed.</p>}
              </details>
              {onRestore && event.action === "delete" && event.before && ["expense", "payment"].includes(event.entityType) && <button type="button" className="quiet" disabled={busy} onClick={() => onRestore(event)}>Review {event.entityType} to restore</button>}
            </li>
          );
        })}
      </ol>
      {active.nextCursor !== null && <button type="button" className="quiet" disabled={active.loading} onClick={loadOlder}>{active.loading ? "Loading…" : "Load older changes"}</button>}
      {active.error && !active.events.length && <button type="button" className="quiet" onClick={() => setAttempt(value => value + 1)}>Retry activity</button>}
    </section>
  );
}
