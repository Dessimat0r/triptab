"use client";

import { useState, type ReactNode } from "react";
import { Check, ChevronRight, Users, User } from "lucide-react";
import type { SaveBlocker } from "@/lib/expense-readiness";
import "./expense-quick-review.css";

type QuickChoice = "everyone" | "me";
const preferenceKey = (tripId: string) => `triptab:quick-split:${tripId}`;

function rememberedChoice(tripId: string): QuickChoice | null {
  try {
    const value = localStorage.getItem(preferenceKey(tripId));
    return value === "everyone" || value === "me" ? value : null;
  } catch {
    return null;
  }
}

function rememberChoice(tripId: string, choice: QuickChoice) {
  try { localStorage.setItem(preferenceKey(tripId), choice); } catch { /* A remembered choice is only a convenience. */ }
}

/** Scroll to a field that needs attention and put focus on the control that fixes it. */
export function focusExpenseTarget(id: string, focus?: string) {
  const target = document.getElementById(id);
  if (!target) return;
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  const controls = "input:not([type=hidden]), select, textarea, button";
  const control = target.matches(controls) ? target
    : (focus && target.querySelector<HTMLElement>(focus)) || target.querySelector<HTMLElement>(controls);
  control?.focus({ preventScroll: true });
}

/**
 * One choice for every unassigned line instead of a tap per item. Shown only
 * while lines have nobody assigned; per-item controls stay available below.
 */
export function QuickSplit({ tripId, unassigned, members, currentMemberId, disabled, autoFocus, onAssign }: {
  tripId: string; unassigned: number; members: { id: string; name: string }[]; currentMemberId?: string; disabled?: boolean;
  /** The allocation is the receipt's next step, so it takes the dialog's initial focus. */
  autoFocus?: boolean;
  onAssign: (memberIds: string[]) => void;
}) {
  const [remembered] = useState(() => rememberedChoice(tripId));
  if (!unassigned || !members.length) return null;
  const me = members.find(member => member.id === currentMemberId);
  // Labels say exactly what is affected: only the lines nobody is on yet.
  const scope = unassigned === 1 ? "the remaining item" : `${unassigned} remaining items`;
  const choices: { key: QuickChoice; label: string; icon: ReactNode; ids: string[] }[] = [
    { key: "everyone", label: `Share ${scope} equally`, icon: <Users size={17} aria-hidden="true" />, ids: members.map(member => member.id) },
    ...(me && members.length > 1 ? [{ key: "me" as const, label: `Give ${scope} to ${me.name}`, icon: <User size={17} aria-hidden="true" />, ids: [me.id] }] : []),
  ];
  const ordered = remembered ? [...choices].sort((a, b) => Number(b.key === remembered) - Number(a.key === remembered)) : choices;
  return <section className="quick-split" aria-labelledby="quick-split-title">
    <h3 id="quick-split-title">{unassigned === 1 ? "1 item needs" : `${unassigned} items need`} people</h3>
    <p className="footnote">Only items with nobody on them yet change. You can still adjust any item below.</p>
    <div className="quick-split-actions">
      {ordered.map((choice, index) => <button key={choice.key} type="button" className={index === 0 ? "primary" : "quiet"} disabled={disabled}
        data-autofocus={autoFocus && index === 0 ? true : undefined}
        onClick={() => { rememberChoice(tripId, choice.key); onAssign(choice.ids); }}>
        {choice.icon}{choice.label}
      </button>)}
    </div>
    {remembered && <p className="quick-split-memory">Your last choice on this holiday is listed first.</p>}
  </section>;
}

/** The short, actionable reasons Save is unavailable, each linking to its field. */
export function SaveChecklist({ blockers, attempted = false }: { blockers: SaveBlocker[]; attempted?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (!blockers.length) return null;
  // The first blocker is the next thing to fix; the rest are one tap away so
  // the pinned footer stays small on phones.
  const shown = expanded || attempted ? blockers : blockers.slice(0, 1);
  return <div className="save-checklist" role={attempted ? "alert" : "status"} aria-label="Before you can save">
    <span className="save-checklist-title">Before saving</span>
    <ul>
      {shown.map(blocker => <li key={blocker.key}>
        <button type="button" className="save-checklist-item" onClick={() => focusExpenseTarget(blocker.target, blocker.focus)}>
          {blocker.message}<ChevronRight size={14} aria-hidden="true" />
        </button>
      </li>)}
    </ul>
    {blockers.length > 1 && !attempted && <button type="button" className="save-checklist-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? "Show fewer" : `${blockers.length - 1} more`}
    </button>}
  </div>;
}

/**
 * A compact confirmation once nothing blocks Save: what was bought, what it
 * costs in the holiday currency and who owes what.
 */
export function ReadyToSave({ title, originalTotal, convertedTotal, payerName, shares, disabled, onEdit }: {
  title: string; originalTotal: string; convertedTotal?: string; payerName: string;
  shares: { id: string; name: string; amount: string }[]; disabled?: boolean; onEdit: () => void;
}) {
  return <section className="ready-to-save" aria-labelledby="ready-to-save-title">
    <div className="ready-to-save-heading">
      <span className="ready-to-save-icon" aria-hidden="true"><Check size={18} /></span>
      <div>
        <h3 id="ready-to-save-title">Ready to save</h3>
        <p>{title} · {payerName} paid {originalTotal}{convertedTotal ? ` (${convertedTotal})` : ""}</p>
      </div>
    </div>
    {!!shares.length && <dl className="ready-to-save-shares">
      {shares.map(share => <div key={share.id}><dt>{share.name}</dt><dd>{share.amount}</dd></div>)}
    </dl>}
    <div className="ready-to-save-actions">
      <button type="submit" className="primary" disabled={disabled}>Save expense now</button>
      <button type="button" className="quiet" onClick={onEdit}>Check details</button>
    </div>
  </section>;
}

/**
 * Purchase details that are usually right (payer, date, time, currency and
 * time zone) collapse to a single line. They open by themselves while any of
 * them needs attention; Done collapses them again once nothing is missing.
 */
export function PurchaseDetails({ id, summary, needsAttention, children }: {
  id: string; summary: string; needsAttention: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(needsAttention);
  const [previousNeed, setPreviousNeed] = useState(needsAttention);
  if (needsAttention !== previousNeed) {
    setPreviousNeed(needsAttention);
    if (needsAttention) setOpen(true);
  }
  const shown = open || needsAttention;
  return <section id={id} className="purchase-details" aria-label="Purchase details">
    {!shown && <div className="purchase-details-summary">
      <p>{summary}</p>
      <button type="button" className="quiet" aria-expanded={false} onClick={() => setOpen(true)}>Edit</button>
    </div>}
    {shown && children}
    {shown && !needsAttention && <button type="button" className="quiet purchase-details-done" aria-expanded={true} onClick={() => setOpen(false)}>Done</button>}
  </section>;
}

/** Rarely needed tools stay one tap away instead of lengthening every expense. */
export function MoreOptions({ defaultOpen, children }: { defaultOpen: boolean; children: ReactNode }) {
  return <details className="expense-more-options" open={defaultOpen || undefined}>
    <summary>More options <small>receipt language, conversation, import</small></summary>
    <div className="expense-more-options-body">{children}</div>
  </details>;
}
