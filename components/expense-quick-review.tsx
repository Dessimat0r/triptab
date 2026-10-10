"use client";
import { t as uiText } from "@/lib/ui-language";


import { useState, type ReactNode } from "react";
import { ChevronRight, Users, User } from "lucide-react";
import type { SaveBlocker } from "@/lib/expense-readiness";

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
  const controls = "input:not([type=hidden]), select, textarea, button";
  const control = target.matches(controls) ? target
    : (focus && target.querySelector<HTMLElement>(focus)) || target.querySelector<HTMLElement>(controls);
  // Evidence jumps may lead into a collapsed optional editor such as the manual rate.
  for (let parent = control?.parentElement; parent && target.contains(parent); parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  }
  // Complete the jump before another pointer action or footer resize can interrupt it.
  target.scrollIntoView({ behavior: "instant", block: "start" });
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
    <h3 id="quick-split-title">{unassigned === 1 ? uiText("1 item needs") : uiText("{value0} items need", { value0: unassigned })}{uiText(" people")}</h3>
    <div className="quick-split-actions">
      {ordered.map((choice, index) => <button key={choice.key} type="button" className={index === 0 ? "primary" : "quiet"} disabled={disabled}
        data-autofocus={autoFocus && index === 0 ? true : undefined}
        onClick={() => { rememberChoice(tripId, choice.key); onAssign(choice.ids); }}>
        {choice.icon}{uiText(choice.label)}
      </button>)}
    </div>
  </section>;
}

/** Posting blockers link to their correction; waiting/offline notices can be plain text. */
export function SaveChecklist({ blockers, attempted = false, hidden = false }: { blockers: SaveBlocker[]; attempted?: boolean; hidden?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  if (hidden || !blockers.length) return null;
  // The first blocker is the next thing to fix; the rest are one tap away so
  // the pinned footer stays small on phones.
  const shown = expanded || attempted ? blockers : blockers.slice(0, 1);
  return <div className="save-checklist" role="group" aria-label={uiText("Before you can save")}>
    <ul>
      {shown.map(blocker => <li key={blocker.key}>
        {blocker.target ? <button type="button" className="save-checklist-item" onClick={() => focusExpenseTarget(blocker.target!, blocker.focus)}>
          {blocker.message}<ChevronRight size={14} aria-hidden="true" />
        </button> : <span className="save-checklist-note">{blocker.message}</span>}
      </li>)}
    </ul>
    {blockers.length > 1 && !attempted && <button type="button" className="save-checklist-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? uiText("Show fewer") : uiText("{value0} more", { value0: blockers.length - 1 })}
    </button>}
  </div>;
}

/**
 * The purchase time (date, time and time zone) is usually right, so it
 * collapses to one line. It opens by itself while a value is missing or a
 * receipt left a default in place; Done collapses it again.
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
  return <section id={id} className="purchase-details" aria-label={uiText("Purchase details")}>
    {!shown && <div className="purchase-details-summary">
      <p>{summary}</p>
      <button type="button" className="textbutton" aria-expanded={false} onClick={() => setOpen(true)}>{uiText("Change")}</button>
    </div>}
    {shown && children}
    {shown && !needsAttention && <button type="button" className="quiet purchase-details-done" aria-expanded={true} onClick={() => setOpen(false)}>{uiText("Done")}</button>}
  </section>;
}

/** Rarely needed tools stay one tap away instead of lengthening every expense. */
export function MoreOptions({ defaultOpen, title = "More options", hint, children }: { defaultOpen: boolean; title?: string; hint: string; children: ReactNode }) {
  return <details className="expense-more-options" open={defaultOpen || undefined}>
    <summary>{title} <small>{hint}</small></summary>
    <div className="expense-more-options-body">{children}</div>
  </details>;
}
