"use client";
import { languageName } from "@/lib/receipt-languages";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLiveRefresh } from "./use-live-refresh";
import type { Currency } from "@/lib/model";
import type { ActivityEvent } from "@/lib/store";
import { formatMoney } from "@/lib/money-format";
import { receiptWarningLabel } from "@/lib/receipt-scan";
import { expenseIconSchema, iconLabel } from "@/lib/expense-icons";
import "./activity-details.css";

export type ActivityPanelProps = {
  tripId: string;
  accountId?: string;
  expenseId?: string;
  draftId?: string;
  title?: string;
  description?: string;
  emptyText?: string;
  refreshKey?: string | number;
  currency?: Currency;
  memberNames?: Record<string, string>;
  actorMemberNames?: Record<string, string>;
  onRestore?: (event: ActivityEvent) => void;
  busy?: boolean;
};

type SequencedEvent = { id: string; sequence: number };
type Page<T> = { events: T[]; nextCursor: number | null };
type State<T> = Page<T> & { key: string; loading: boolean; error: string };
export type AuditChange = { label: string; before: string; after: string };

class ActivityError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}

async function activityPage<T extends SequencedEvent>(endpoint: string, signal: AbortSignal, before?: number): Promise<Page<T>> {
  const url = new URL(endpoint, location.origin);
  url.searchParams.set("limit", "20");
  if (before !== undefined) url.searchParams.set("before", String(before));
  const response = await fetch(url.pathname + url.search, { cache: "no-store", credentials: "same-origin", signal });
  const body = await response.json() as Page<T> & { error?: string };
  if (!response.ok) throw new ActivityError(body.error || "Unable to load activity. Please try again.", response.status);
  if (!Array.isArray(body.events) || body.events.length > 50 ||
    body.events.some(event => !event || typeof event.id !== "string" || !event.id || !Number.isSafeInteger(event.sequence) || event.sequence < 1) ||
    (body.nextCursor !== null && (!Number.isSafeInteger(body.nextCursor) || body.nextCursor < 1))) {
    throw new ActivityError("The activity response was incomplete. Please try again.");
  }
  return { events: body.events, nextCursor: body.nextCursor };
}

/** Keep the reader's loaded range and open details while new immutable events arrive. */
export function useActivityPages<T extends SequencedEvent>(endpoint: string, key: string, refreshKey: string | number = 0, ownerField?: keyof T, accountId?: string) {
  const [state, setState] = useState<State<T>>({ key: "", events: [], nextCursor: null, loading: true, error: "" });
  const saved = useRef(state);
  const headRequest = useRef<AbortController | null>(null);
  const olderRequest = useRef<AbortController | null>(null);
  const refreshAfterOlder = useRef(false);
  const scope = useRef({ endpoint, key, accountId });
  const active: State<T> = state.key === key ? state : { key, events: [], nextCursor: null, loading: true, error: "" };
  useLayoutEffect(() => { saved.current = state; scope.current = { endpoint, key, accountId }; }, [state, endpoint, key, accountId]);

  const refresh = useCallback(async () => {
    if (scope.current.key !== key || scope.current.endpoint !== endpoint || scope.current.accountId !== accountId) return;
    // Do not restart an in-flight check or interrupt a reader loading older
    // pages. A queued check fills in anything that arrived during pagination.
    if (headRequest.current) return;
    if (olderRequest.current) { refreshAfterOlder.current = true; return; }
    const controller = new AbortController();
    headRequest.current = controller;
    let previous = saved.current.key === key ? saved.current : null;
    setState(value => value.key === key
      ? value.error ? { ...value, error: "" } : value
      : { key, events: [], nextCursor: null, loading: true, error: "" });
    try {
      let page = await activityPage<T>(endpoint, controller.signal);
      if (ownerField && accountId && page.events.some(event => event[ownerField] !== accountId)) throw new ActivityError("Your account changed. Reopen your account to view its history.", 401);
      if (ownerField && previous?.events[0]?.[ownerField] !== page.events[0]?.[ownerField]) previous = null;
      const owner = ownerField ? page.events[0]?.[ownerField] : undefined;
      const known = new Set(previous?.events.map(event => event.id));
      const events = [...page.events];
      let overlaps = page.events.some(event => known.has(event.id));
      while (previous?.events.length && events.length && !overlaps && page.nextCursor !== null) {
        const cursor = page.nextCursor;
        page = await activityPage<T>(endpoint, controller.signal, cursor);
        if (ownerField && accountId && page.events.some(event => event[ownerField] !== accountId)) throw new ActivityError("Your account changed. Reopen your account to view its history.", 401);
        if (ownerField && page.events.some(event => event[ownerField] !== owner)) throw new ActivityError("Your account changed. Reload account activity.", 401);
        if (page.nextCursor !== null && page.nextCursor >= cursor) throw new ActivityError("The activity page did not advance. Please try again.");
        events.push(...page.events);
        overlaps = page.events.some(event => known.has(event.id));
      }
      if (controller.signal.aborted || scope.current.key !== key || scope.current.accountId !== accountId) return;
      // Audit records are append-only. Keep previously authorized objects for
      // known IDs so expanded receipt diffs do not recalculate every poll.
      const retained = new Map(previous?.events.map(event => [event.id, event]));
      const combined = events.length ? [...events.map(event => retained.get(event.id) || event), ...(previous?.events || [])] : [];
      const unique = [...new Map(combined.map(event => [event.id, event])).values()].sort((left, right) => right.sequence - left.sequence);
      const nextCursor = overlaps && previous ? previous.nextCursor : page.nextCursor;
      setState(value => value.key === key && !value.loading && !value.error && value.nextCursor === nextCursor &&
        value.events.length === unique.length && unique.every((event, index) => event === value.events[index])
        ? value : { key, events: unique, nextCursor, loading: false, error: "" });
    } catch (cause) {
      if (controller.signal.aborted || scope.current.key !== key || scope.current.accountId !== accountId) return;
      setState(value => ({ ...(value.key === key ? value : { key, events: [], nextCursor: null }),
        ...(cause instanceof ActivityError && [401, 403].includes(cause.status) ? { events: [], nextCursor: null } : {}),
        loading: false, error: cause instanceof Error ? cause.message : "Unable to load activity." }));
    } finally { if (headRequest.current === controller) headRequest.current = null; }
  }, [endpoint, key, ownerField, accountId]);

  useEffect(() => {
    refreshAfterOlder.current = false;
    void refresh();
    return () => { headRequest.current?.abort(); headRequest.current = null; olderRequest.current?.abort(); olderRequest.current = null; refreshAfterOlder.current = false; };
  }, [refresh]);
  useEffect(() => { void refresh(); }, [refreshKey, refresh]);
  useLiveRefresh(refresh, { accountId });
  useEffect(() => {
    if (refreshAfterOlder.current && !olderRequest.current && !headRequest.current) {
      refreshAfterOlder.current = false;
      void refresh();
    }
  }, [state, refresh]);

  async function loadOlder() {
    if (headRequest.current || olderRequest.current || active.loading || active.nextCursor === null) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    setState(previous => previous.key === key ? { ...previous, loading: true, error: "" } : previous);
    try {
      const page = await activityPage<T>(endpoint, controller.signal, active.nextCursor);
      if (ownerField && accountId && page.events.some(event => event[ownerField] !== accountId)) throw new ActivityError("Your account changed. Reopen your account to view its history.", 401);
      if (ownerField && page.events.some(event => event[ownerField] !== active.events[0]?.[ownerField])) throw new ActivityError("Your account changed. Reload account activity.", 401);
      if (page.nextCursor !== null && page.nextCursor >= active.nextCursor) throw new ActivityError("The activity page did not advance. Please try again.");
      if (!controller.signal.aborted && scope.current.key === key && scope.current.accountId === accountId) setState(previous => {
        if (previous.key !== key) return previous;
        const retained = new Map(previous.events.map(event => [event.id, event]));
        const events = [...new Map([...previous.events, ...page.events.map(event => retained.get(event.id) || event)].map(event => [event.id, event])).values()].sort((left, right) => right.sequence - left.sequence);
        return { ...previous, events, nextCursor: page.nextCursor, loading: false, error: "" };
      });
    } catch (cause) {
      if (!controller.signal.aborted && scope.current.key === key && scope.current.accountId === accountId) setState(previous => previous.key === key ? { ...previous,
        ...(cause instanceof ActivityError && [401, 403].includes(cause.status) ? { events: [], nextCursor: null } : {}),
        loading: false, error: cause instanceof Error ? cause.message : "Unable to load older changes." } : previous);
    } finally {
      if (olderRequest.current === controller) {
        olderRequest.current = null;
        if (controller.signal.aborted) refreshAfterOlder.current = false;
      }
    }
  }
  return { ...active, loadOlder, retry: () => void refresh() };
}

function same(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => same(value, right[index]));
  const a = auditRecord(left), b = auditRecord(right);
  if (a && b) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return keys.every(key => same(a[key], b[key]));
  }
  return Object.is(left, right);
}
export function auditText(value: unknown): string { return typeof value === "string" ? value : ""; }
export function auditRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
let timestampFormatter: Intl.DateTimeFormat | undefined;
export function auditTimestamp(value: unknown, exact = false): string {
  const text = auditText(value);
  const date = new Date(text);
  if (!text || !Number.isFinite(date.getTime())) return "Date unavailable";
  return exact ? date.toISOString() + " (UTC)" : (timestampFormatter ??= new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" })).format(date);
}
export function auditSource(value: string): string {
  return value === "chatgpt" ? "via ChatGPT/Codex" : value === "system" ? "by TripTab system" : "in TripTab";
}
let amountFormatter: Intl.NumberFormat | undefined;
let quantityFormatter: Intl.NumberFormat | undefined;
function money(value: unknown, currency?: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Not recorded";
  try {
    if (currency) return formatMoney(value, currency);
  } catch {}
  return `${(amountFormatter ??= new Intl.NumberFormat("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })).format(value / 100)} (holiday currency)`;
}
function traveller(value: unknown, names: Record<string, string>): string {
  const id = auditText(value);
  return id ? `${names[id] || "Earlier traveller"} (traveller ${id})` : "Not recorded";
}
function reference(value: unknown, label: string): string { return auditText(value) ? `${label} ${auditText(value)}` : "Not recorded"; }
function accountReference(value: unknown, names: Record<string, string>): string {
  const id = auditText(value);
  return id && names[id] ? `${names[id]} (account ${id})` : reference(value, "Account");
}
function percentages(value: unknown, names: Record<string, string>): string {
  const entries = auditRecord(value);
  if (!entries) return "By receipt item";
  return Object.entries(entries).map(([id, percent]) => `${traveller(id, names)}: ${percent}%`).join("\n") || "No participants";
}
function quantity(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? (quantityFormatter ??= new Intl.NumberFormat("en-GB", { maximumFractionDigits: 6 })).format(value) : "Not recorded";
}
function itemName(snapshot: Record<string, unknown>, id: unknown): string {
  const item = (Array.isArray(snapshot.items) ? snapshot.items : []).map(auditRecord).find(value => value?.id === id);
  return auditText(item?.name) || "Earlier item";
}
function itemReference(snapshot: Record<string, unknown>, id: unknown): string {
  return auditText(id) ? `${itemName(snapshot, id)} (item ${auditText(id)})` : "This receipt";
}
function itemDescription(value: unknown, currency: string | undefined, names: Record<string, string>): string {
  const item = auditRecord(value);
  if (!item) return "Not recorded";
  const members = Array.isArray(item.members) ? item.members.filter((id): id is string => typeof id === "string") : [];
  const units = auditRecord(item.units), allocations = auditRecord(units?.allocations);
  const split = units ? `${quantity(units.total)} ${auditText(units.label) || "units"} in total${allocations ? `\n${Object.entries(allocations).map(([id, amount]) => `${traveller(id, names)}: ${quantity(amount)} ${auditText(units.label) || "units"}`).join("\n")}` : ""}`
    : item.percentages ? percentages(item.percentages, names) : members.length ? `Shared equally by:\n${members.map(id => traveller(id, names)).join("\n")}` : "No participants";
  const participantOrder = units || item.percentages ? `Participant order:\n${members.map(id => traveller(id, names)).join("\n")}\n` : "";
  const purchased = auditRecord(item.quantity);
  const purchasedDetail = purchased ? `Purchased quantity: ${quantity(purchased.total)} ${auditText(purchased.label) || "units"}\n${auditText(purchased.sourceText) ? `Receipt text: ${auditText(purchased.sourceText)}\n` : ""}` : "";
  const source = auditRecord(item.scanSource);
  const evidence = source ? `Receipt evidence: ${typeof source.lineIndex === "number" ? `line ${source.lineIndex + 1}` : "line not identified"}${source.confidence ? ` · ${auditText(source.confidence)} confidence` : ""}\n${auditText(source.observedText) ? `Observed text: ${auditText(source.observedText)}\n` : ""}` : "";
  const translations = auditRecord(item.translations);
  const bilingual = `${item.nameLanguage ? `Original language: ${languageName(item.nameLanguage)}\n` : ""}${translations ? Object.entries(translations).map(([code,value])=>{const translation=auditRecord(value);return `${languageName(code)}: ${auditText(translation?.text)}\nTranslated from: ${auditText(translation?.sourceText)}\nLast paired reading name: ${auditText(translation?.pairedText)}\nTranslation origin: ${auditText(translation?.provenance)}\n`;}).join("") : ""}`;
  const provenance = item.fieldSources ? `Field origins: ${readable(item.fieldSources)}\n` : "";
  return `${auditText(item.name) || "Description needs confirmation"} (item ${auditText(item.id)})\nFull line total: ${item.amount === null ? "Price needs confirmation" : money(item.amount, currency)}\n${bilingual}${purchasedDetail}${evidence}${provenance}${participantOrder}${split}`;
}
function scanDescription(value: unknown, currency: string | undefined): string {
  const scan = auditRecord(value);
  if (!scan) return "No recorded scan evidence";
  const labels: Record<string, string> = { matched: "Matches printed total", "needs-review": "Needs review", incomplete: "Incomplete receipt evidence" };
  const warnings = entries(scan.warnings).map(warning => `${warning.resolved ? "Reviewed" : "Needs review"}: ${auditText(warning.message) || receiptWarningLabel(auditText(warning.code))}${warning.itemId ? ` (item ${auditText(warning.itemId)})` : ""}`);
  const lines = entries(scan.sourceLines).map(line => `${typeof line.lineIndex === "number" ? `Line ${line.lineIndex + 1}: ` : ""}${auditText(line.observedText) || auditText(line.kind)}${typeof line.amount === "number" ? ` · ${money(line.amount, currency)}` : ""}${line.mappedTo ? ` · ${auditText(line.mappedTo)}` : ""}`);
  return [labels[auditText(scan.status)] || "Status not recorded",
    `Printed subtotal: ${money(scan.printedSubtotal, currency)}`,
    `Printed total: ${money(scan.printedTotal, currency)}`,
    `Printed currency: ${auditText(scan.printedCurrency) || "Not readable"}`,
    `Calculated total: ${money(scan.calculatedTotal, currency)}`,
    ...(warnings.length ? ["Warnings:", ...warnings] : []),
    ...(lines.length ? ["Source lines:", ...lines] : []),
    ...(scan.acknowledgement ? ["Participant explicitly accepted this total difference"] : []),
    ...(scan.missingTotalAcknowledgement ? ["Participant reviewed every line because the printed total was unavailable"] : []),
    ...(scan.processor ? [`Processed by: ${auditText(scan.processor)}`] : []),
    ...(scan.processedAt ? [`Processed at: ${auditTimestamp(scan.processedAt, true)}`] : []),
    ...(Array.isArray(scan.imageIds) ? [`Source images: ${scan.imageIds.map(auditText).join(", ")}`] : []),
  ].join("\n");
}
function memoryAliases(value: unknown, snapshot: Record<string, unknown>, names: Record<string, string>): string {
  if (!Array.isArray(value) || !value.length) return "No saved names";
  return value.map(value => {
    const alias = auditRecord(value);
    if (!alias) return "Earlier saved name";
    const meaning = alias.itemId ? itemReference(snapshot, alias.itemId) : alias.memberId ? traveller(alias.memberId, names) : "this receipt";
    const scope = alias.scopeMemberId ? ` (used by ${traveller(alias.scopeMemberId, names)})` : "";
    return `“${auditText(alias.name) || "Saved name"}” means ${meaning}${scope}`;
  }).join("\n");
}
function entries(value: unknown) { return (Array.isArray(value) ? value : []).map(auditRecord).filter((entry): entry is Record<string, unknown> => !!entry); }
function messageDescription(value: unknown, snapshot: Record<string, unknown>, names: Record<string, string>): string {
  const message = auditRecord(value);
  if (!message) return "Not recorded";
  const question = message.replyTo ? entries(snapshot.conversation).find(entry => entry.id === message.replyTo) : null;
  const assistant = message.role === "assistant";
  const author = assistant ? "ChatGPT/Codex" : auditText(message.authorName) || names[auditText(message.authorMemberId)] || "Traveller";
  const context = message.itemId || question?.itemId;
  return `${assistant ? "Reply" : "Question"} by ${author}${!assistant && message.authorMemberId ? ` · ${traveller(message.authorMemberId, names)}` : ""}\n${auditTimestamp(message.createdAt, true)}\n${context ? itemReference(snapshot, context) : "Whole receipt"}\nMessage ${auditText(message.id)}${message.replyTo ? ` · replying to message ${auditText(message.replyTo)}` : ""}\n\n${auditText(message.text)}`;
}
function assistantAttributionCorrected(before: Record<string, unknown> | undefined, after: Record<string, unknown> | undefined): boolean {
  if (!before || !after || before.role !== "assistant" || after.role !== "assistant"
    || after.authorMemberId !== undefined || after.authorName !== undefined
    || (before.authorMemberId === undefined && before.authorName === undefined)) return false;
  const earlier = { ...before }, current = { ...after };
  delete earlier.authorMemberId; delete earlier.authorName;
  delete current.authorMemberId; delete current.authorName;
  return same(earlier, current);
}
function order(value: unknown, describe: (id: string) => string): string {
  if (!Array.isArray(value) || !value.length) return "No entries";
  return value.map((id, index) => `${index + 1}. ${describe(auditText(id))}`).join("\n");
}
const REASONS: Record<string, string> = {
  "upload-started": "Image upload started", "upload-complete": "Image upload completed", "receipt-detached": "Image detached from the receipt",
  "image-deletion": "Image removal requested", "orphan-expired": "Unused image expired", "upload-failed": "Failed upload cleanup", "cleanup-retry": "Retrying image cleanup", "image-deleted": "Stored image deleted",
  created: "Invitation created", replaced: "Invitation replaced", revoked: "Invitation revoked", accepted: "Invitation accepted", expired: "Invitation expired",
};
const STATES: Record<string, string> = { pending: "Upload pending", active: "Available", deleting: "Removal pending", waiting: "Waiting for review", review: "Ready for review", revoked: "Revoked", accepted: "Accepted", expired: "Expired" };
const PRIVATE_FIELD = /(?:password|token|secret|credential|cookie|sessionhash|endpoint|authkey|p256dh)/i;
function fieldLabel(key: string): string { return key.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/[_-]/g, " ").replace(/^./, char => char.toUpperCase()); }
function readable(value: unknown): string {
  if (value === undefined || value === null || value === "") return "Not recorded";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length ? value.map((entry, index) => `${index + 1}. ${readable(entry)}`).join("\n") : "No entries";
  const object = auditRecord(value);
  return object ? Object.entries(object).filter(([key]) => !PRIVATE_FIELD.test(key)).map(([key, value]) => `${fieldLabel(key)}: ${readable(value)}`).join("\n") || "No recorded details" : "Not recorded";
}

function changes(event: ActivityEvent, currency: Currency | undefined, names: Record<string, string>, accountNames: Record<string, string>): AuditChange[] {
  const before = event.before || {}, after = event.after || {}, result: AuditChange[] = [], handled = new Set(["id"]);
  const add = (key: string, label: string, describe: (value: unknown, snapshot: Record<string, unknown>) => string = readable) => {
    handled.add(key);
    if (!same(before[key], after[key])) result.push({ label, before: describe(before[key], before), after: describe(after[key], after) });
  };
  for (const [key, label] of Object.entries({ name: "Name", title: "Title", currency: "Currency", date: "Transaction date", startDate: "Start date", endDate: "End date", time: "Transaction time", timezone: "Transaction timezone", method: "Payment method", note: "Note", email: "Traveller email" })) add(key, label);
  add("receiptLanguage", "Receipt language setting", languageName);
  add("detectedLanguage", "Detected receipt language", languageName);
  add("location", "Purchase place", value => {
    const place = auditRecord(value);
    const origin = { user: "Entered manually", receipt: "Read from receipt", chat: "From receipt conversation" }[auditText(place?.source)];
    return place ? `${auditText(place.label)}${origin ? `\n${origin}` : ""}` : "Not recorded";
  });
  add("locationHint", "Device location hint", value => {
    const hint = auditRecord(value);
    return hint ? `Latitude: ${hint.latitude}\nLongitude: ${hint.longitude}\nAccuracy: ${hint.accuracy} metres\nCaptured: ${auditTimestamp(hint.capturedAt, true)}\nHint only; not a confirmed purchase place` : "Not recorded";
  });
  handled.add("languageViewId");
  add("source", "Entry source", value => value === "ai" ? "AI assisted" : value === "manual" ? "Entered manually" : readable(value));
  add("icon", "Icon & background", value => {
    const icon = expenseIconSchema.safeParse(value);
    return icon.success ? iconLabel(icon.data) : value === undefined ? "Automatic suggestion" : readable(value);
  });
  add("fieldSources", "Receipt field origins");
  add("receiptScan", "Receipt scan review", (value, snapshot) => scanDescription(value, auditText(snapshot.currency) || currency));
  add("status", String(event.entityType) === "invite" ? "Invitation status" : "Review status", value => String(event.entityType) === "invite" && value === "pending" ? "Waiting for the traveller to join" : STATES[auditText(value)] || readable(value));
  add("memberName", "Invited traveller name");
  add("emailRestricted", "Invitation email restriction", value => value === true ? "Only the invited email can join" : value === false ? "Anyone with the link can join as this traveller" : "Not recorded");
  for (const [key, label] of Object.entries({ amount: "Amount", tax: "Tax", tip: "Tip", discount: "Discount", bankAmount: "Actual bank charge" })) add(key, label, (value, snapshot) => money(value, key === "bankAmount" || String(event.entityType) === "payment" ? currency : auditText(snapshot.currency) || currency));
  for (const [key, label] of Object.entries({ from: "Paid by", to: "Paid to", payer: "Receipt payer", memberId: "Traveller" })) add(key, label, value => traveller(value, names));
  add("percentages", "Whole-receipt split", value => percentages(value, names));
  add("adjustmentAllocation", "Adjustment split when item prices are zero", value => value === "selected-participants" ? "People selected on receipt items" : "Earlier rule: all travellers");
  add("fx", "Exchange rate", value => {
    const fx = auditRecord(value); return fx ? `Rate: ${fx.rate}\nAs of: ${auditText(fx.asOf)}\nSource: ${auditText(fx.source)}` : "No recorded rate";
  });
  for (const [key, label, entity] of [["receiptId", "Receipt image", "Image"], ["sourceDraftId", "Linked receipt draft", "Draft"], ["expenseId", "Receipt review target", "Expense"], ["userId", "Traveller account", "Account"], ["ownerId", "Holiday organiser account", "Account"], ["uploaderId", "Image uploaded by", "Account"], ["initiatorId", "Cleanup initiated by account", "Account"]]) add(key, label, value => entity === "Account" ? accountReference(value, accountNames) : reference(value, entity));
  for (const [key, label, entity] of [["memberOrder", "Traveller order", "Traveller"], ["expenseOrder", "Expense order", "Expense"], ["paymentOrder", "Payment order", "Payment"], ["draftOrder", "Receipt draft order", "Draft"]]) add(key, label, value => order(value, id => key === "memberOrder" ? traveller(id, names) : `${entity} ${id}`));
  handled.add("items");
  const oldItems = new Map(entries(before.items).map(item => [auditText(item.id), item])), newItems = new Map(entries(after.items).map(item => [auditText(item.id), item]));
  for (const id of new Set([...oldItems.keys(), ...newItems.keys()])) if (!same(oldItems.get(id), newItems.get(id))) result.push({
    label: oldItems.has(id) ? newItems.has(id) ? "Item changed" : "Item removed" : "Item added",
    before: itemDescription(oldItems.get(id), auditText(before.currency) || currency, names), after: itemDescription(newItems.get(id), auditText(after.currency) || currency, names),
  });
  const oldItemOrder = [...oldItems.keys()], newItemOrder = [...newItems.keys()];
  if (!same(oldItemOrder, newItemOrder)) result.push({ label: "Item order", before: order(oldItemOrder, id => itemReference(before, id)), after: order(newItemOrder, id => itemReference(after, id)) });
  handled.add("conversation");
  const oldMessages = new Map(entries(before.conversation).map(message => [auditText(message.id), message])), newMessages = new Map(entries(after.conversation).map(message => [auditText(message.id), message]));
  for (const id of new Set([...oldMessages.keys(), ...newMessages.keys()])) if (!same(oldMessages.get(id), newMessages.get(id))) {
    const earlier = oldMessages.get(id), current = newMessages.get(id);
    if (assistantAttributionCorrected(earlier, current)) {
      const recorded = [auditText(earlier?.authorName) && `Name: ${auditText(earlier?.authorName)}`,
        auditText(earlier?.authorMemberId) && `Traveller: ${traveller(earlier?.authorMemberId, names)}`].filter(Boolean).join("\n");
      result.push({ label: "Assistant attribution corrected",
        before: `Incorrectly stored human attribution${recorded ? `\n${recorded}` : ""}\n\n${messageDescription(earlier, before, names)}`,
        after: `ChatGPT/Codex assistant; no human attribution\n\n${messageDescription(current, after, names)}` });
    } else result.push({
      label: oldMessages.has(id) ? newMessages.has(id) ? "Message changed" : "Message removed" : "Message added",
      before: messageDescription(earlier, before, names), after: messageDescription(current, after, names),
    });
  }
  const oldMessageOrder = [...oldMessages.keys()], newMessageOrder = [...newMessages.keys()];
  if (!same(oldMessageOrder, newMessageOrder)) {
    const describe = (snapshot: Record<string, unknown>, map: Map<string, Record<string, unknown>>) => (id: string) => {
      const message = map.get(id); return `${message?.role === "assistant" ? "Reply" : "Question"} ${id} · ${auditTimestamp(message?.createdAt, true)} · ${message?.itemId ? itemReference(snapshot, message.itemId) : "Whole receipt"}`;
    };
    result.push({ label: "Conversation order", before: order(oldMessageOrder, describe(before, oldMessages)), after: order(newMessageOrder, describe(after, newMessages)) });
  }
  handled.add("memory");
  const oldMemory = auditRecord(before.memory), newMemory = auditRecord(after.memory);
  if (!same(oldMemory?.notes, newMemory?.notes)) result.push({ label: "Remembered receipt notes", before: auditText(oldMemory?.notes) || "No saved notes", after: auditText(newMemory?.notes) || "No saved notes" });
  if (!same(oldMemory?.aliases || [], newMemory?.aliases || [])) result.push({ label: "Remembered names", before: memoryAliases(oldMemory?.aliases, before, names), after: memoryAliases(newMemory?.aliases, after, names) });
  add("state", String(event.entityType) === "invite" ? "Invitation state" : "Image state", value => STATES[auditText(value)] || readable(value));
  add("reason", "Reason", value => String(event.entityType) === "invite" && value === "owner" ? "Revoked by the holiday organiser" : REASONS[auditText(value)] || readable(value));
  add("deletionReason", "Original image removal reason", value => REASONS[auditText(value)] || readable(value));
  add("contentType", "Image format", value => ({ "image/jpeg": "JPEG image", "image/png": "PNG image", "image/webp": "WebP image" }[auditText(value)] || readable(value)));
  add("sizeBytes", "Stored image size", value => typeof value === "number" ? `${value.toLocaleString("en-GB")} bytes` : "Not recorded");
  add("sha256", "Image checksum (SHA-256)");
  for (const [key, label] of Object.entries({ createdAt: "Created at", expiresAt: "Expires at", acceptedAt: "Accepted at", revokedAt: "Revoked at" })) add(key, label, value => value ? auditTimestamp(value, true) : "Not recorded");
  add("initiatorName", "Cleanup initiated by");
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) if (!handled.has(key) && !PRIVATE_FIELD.test(key) && !same(before[key], after[key])) result.push({ label: fieldLabel(key), before: readable(before[key]), after: readable(after[key]) });
  return result;
}

export function ActivityChanges({ fields, before, after }: { fields: AuditChange[]; before: boolean; after: boolean }) {
  return fields.length ? <dl className="activity-changes">{fields.map((field, index) => <div key={`${field.label}-${index}`}>
    <dt>{field.label}</dt><dd>{before && <span className="activity-before"><span className="muted">Before: </span>{field.before}</span>}{after && <span className="activity-after"><span className="muted">After: </span>{field.after}</span>}</dd>
  </div>)}</dl> : <p className="footnote">No additional recorded field changes.</p>;
}

function eventLabel(event: ActivityEvent, currency?: Currency): string {
  const snapshot = event.after || event.before || {};
  const entity = String(event.entityType);
  if (entity === "payment") return `${money(snapshot.amount, currency)} payment`;
  const labels: Record<string, string> = { trip: "Holiday", expense: "Expense", member: "Traveller", draft: "Receipt draft", invite: "Traveller invitation", receipt: "Receipt image" };
  return auditText(snapshot.title) || auditText(snapshot.name) || labels[entity] || "Entry";
}

type ActivityDetailProps = Pick<ActivityPanelProps, "currency"> & {
  event: ActivityEvent;
  memberNames: Record<string, string>;
  actorMemberNames: Record<string, string>;
};

function ActivityDetailBody({ event, currency, memberNames, actorMemberNames }: ActivityDetailProps) {
  const fields = useMemo(() => changes(event, currency, memberNames, actorMemberNames), [event, currency, memberNames, actorMemberNames]);
  const actor = event.actorName || "Traveller", tripName = actorMemberNames[event.actorId];
  const snapshot = event.after || event.before || {};
  return <>
    <dl className="activity-identifiers">
      <div><dt>Recorded at</dt><dd><time dateTime={event.createdAt}>{auditTimestamp(event.createdAt, true)}</time></dd></div>
      <div><dt>Changed by</dt><dd>{actor}{tripName ? ` · current traveller name: ${tripName}` : ""}<br />{event.source === "system" ? "System reference" : "Account"} {event.actorId}</dd></div>
      <div><dt>Record</dt><dd>{eventLabel(event, currency)} · {event.entityId}</dd></div>
      <div><dt>Change reference</dt><dd>{event.id} · holiday revision {event.revision}</dd></div>
      {event.entityType === "invite" && <div><dt>Invitation for</dt><dd>{auditText(snapshot.memberName) || memberNames[auditText(snapshot.memberId)] || "Earlier traveller"} · traveller {auditText(snapshot.memberId)}</dd></div>}
      {event.entityType === "receipt" && <>
        {!!snapshot.uploaderId && <div><dt>Image uploaded by</dt><dd>{accountReference(snapshot.uploaderId, actorMemberNames)}</dd></div>}
        {!!snapshot.initiatorId && <div><dt>Cleanup initiated by</dt><dd>{auditText(snapshot.initiatorName) || accountReference(snapshot.initiatorId, actorMemberNames)} · account {auditText(snapshot.initiatorId)}</dd></div>}
        {!!snapshot.sha256 && <div><dt>Image checksum (SHA-256)</dt><dd>{auditText(snapshot.sha256)}</dd></div>}
      </>}
    </dl>
    <p className="footnote">Traveller references use current holiday names with stable IDs. Message authors retain their recorded names.</p>
    {event.snapshotOmitted ? <p className="footnote">The full before and after details are too large for this history page. They remain saved. <a href={event.snapshotDownload} download>Download full shared history entry</a> to inspect the original snapshots, including shared traveller contacts.</p>
      : <ActivityChanges fields={fields} before={!!event.before} after={!!event.after} />}
  </>;
}

function ActivityEventDetails(props: ActivityDetailProps) {
  const [visited, setVisited] = useState(false);
  // Closed rows need only their summary. Keep the body mounted after its first
  // expansion so closing and refreshing preserve the reader's details.
  return <details onToggle={event => { if (event.currentTarget.open) setVisited(true); }}>
    <summary>View {props.event.action === "update" ? "changes" : "details"}</summary>
    {visited && <ActivityDetailBody {...props} />}
  </details>;
}

export default function ActivityPanel({ tripId, accountId, expenseId, draftId, title, description, emptyText, refreshKey = 0, currency, memberNames = {}, actorMemberNames = {}, onRestore, busy = false }: ActivityPanelProps) {
  const scope = expenseId ? { kind: "expenseId", id: expenseId } : draftId ? { kind: "draftId", id: draftId } : null;
  const query = new URLSearchParams({ tripId });
  if (scope) query.set(scope.kind, scope.id);
  const history = useActivityPages<ActivityEvent>(`/api/activity?${query.toString()}`, JSON.stringify([accountId, tripId, scope?.kind, scope?.id]), refreshKey, undefined, accountId);
  const heading = title ?? (scope ? "Receipt history" : "Activity");
  const help = description ?? (scope
    ? "See who changed this receipt, its reviews and images, with the complete details before and after each change."
    : "See who changed this holiday and the complete details before and after each change. Earlier records remain in the history.");
  return <section className={`activity-panel${scope ? " receipt-activity" : ""}`} aria-label={scope ? heading : "Holiday activity"} aria-busy={history.loading}>
    <h2 className="subheading">{heading}</h2>
    {help && <p className="footnote">{help}</p>}
    {history.error ? <button type="button" className="quiet" disabled={history.loading} onClick={history.retry}>{scope ? "Retry receipt history" : "Retry activity"}</button> : <p className="footnote">History updates automatically.</p>}
    {history.loading && !history.events.length && <p role="status">Loading activity…</p>}
    {history.loading && !!history.events.length && <p role="status">Checking for changes…</p>}
    {history.error && <p className="error" role="alert">{history.error}</p>}
    {!history.loading && !history.error && !history.events.length && <p className="footnote">{emptyText ?? (scope ? "No recorded changes for this receipt yet." : "No recorded changes yet. Activity starts when this version of TripTab saves a change.")}</p>}
    <ol className="activity-list">{history.events.map(event => {
      const actor = event.actorName || "Traveller", tripName = actorMemberNames[event.actorId];
      return <li key={event.id} className="activity-event">
        <p><strong>{actor}{tripName && tripName !== actor ? ` (${tripName})` : ""}</strong> {({ create: "created", update: "updated", delete: "removed" }[event.action]) || "changed"} <strong>{eventLabel(event, currency)}</strong></p>
        <p className="footnote"><time dateTime={event.createdAt}>{auditTimestamp(event.createdAt)}</time> · {auditSource(event.source)}</p>
        <ActivityEventDetails event={event} currency={currency} memberNames={memberNames} actorMemberNames={actorMemberNames} />
        {onRestore && event.action === "delete" && event.before && ["expense", "payment"].includes(event.entityType) && <button type="button" className="quiet" disabled={busy} onClick={() => onRestore(event)}>Review {event.entityType} to restore</button>}
      </li>;
    })}</ol>
    {history.nextCursor !== null && <button type="button" className="quiet" disabled={history.loading} onClick={history.loadOlder}>{history.loading ? "Loading…" : "Load older changes"}</button>}
  </section>;
}
