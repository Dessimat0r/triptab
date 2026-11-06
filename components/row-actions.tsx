"use client";
import { t as uiText } from "@/lib/ui-language";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import { MoreHorizontal } from "lucide-react";

export type RowAction = { label: string; onSelect: () => void; destructive?: boolean; disabled?: boolean };

/**
 * A visible ⋯ menu for a list row (F-06, D06). It is the primary way to reach
 * row actions; swipe is only a shortcut that reveals the same Delete button.
 * Keyboard: Enter/Space opens, arrows move, Escape closes and returns focus.
 */
export function RowActionsMenu({ label, actions, disabled }: { label: string; actions: RowAction[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ top: -9999, right: 0 });
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  // Fixed to the viewport so list cards with hidden overflow cannot clip it;
  // it opens upwards when there is no room below the button.
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const place = () => {
      const button = trigger.current!.getBoundingClientRect(), height = menu.current!.offsetHeight;
      const below = window.innerHeight - button.bottom - 8;
      setPosition({ position: "fixed", right: Math.max(8, window.innerWidth - button.right),
        top: below >= height ? button.bottom + 4 : Math.max(8, button.top - height - 4) });
    };
    place();
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const first = menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus({ preventScroll: true });
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [open]);
  const move = (step: number) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(index + step + items.length) % items.length]?.focus();
  };
  if (!actions.length) return null;
  return <div className="row-actions">
    <button ref={trigger} type="button" className="iconbutton row-actions-trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} disabled={disabled} onClick={() => { setPosition({ top: -9999, right: 0 }); setOpen(value => !value); }}>
      <MoreHorizontal size={18} aria-hidden="true" />
    </button>
    {open && <div ref={menu} id={menuId} role="menu" className="row-actions-menu" style={position} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
      else if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
      else if (event.key === "Tab") setOpen(false);
    }}>
      {actions.map(action => <button key={action.label} type="button" role="menuitem" className={action.destructive ? "danger" : undefined}
        disabled={action.disabled} onClick={() => { setOpen(false); trigger.current?.focus({ preventScroll: true }); action.onSelect(); }}>{uiText(action.label)}</button>)}
    </div>}
  </div>;
}

/**
 * Swipe left on touch to reveal a Delete button (D06). The gesture never
 * deletes by itself: the revealed button still has to be pressed, and the
 * ⋯ menu offers the same action to everyone else.
 */
export function SwipeRow({ children, onDelete, deleteLabel, disabled, className }: {
  children: ReactNode; onDelete?: () => void; deleteLabel: string; disabled?: boolean; className?: string;
}) {
  const [offset, setOffset] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const start = useRef<{ x: number; y: number; id: number; horizontal?: boolean } | null>(null);
  const reveal = 88;
  const end = () => {
    if (!start.current) return;
    const open = start.current.horizontal ? offset <= -reveal / 2 : revealed;
    start.current = null; setRevealed(open); setOffset(open ? -reveal : 0);
  };
  if (!onDelete || disabled) return <div className={`swipe-row swipe-row--off${className ? ` ${className}` : ""}`}><div className="swipe-row-content">{children}</div></div>;
  return <div className={`swipe-row${revealed ? " swipe-row--revealed" : ""}${offset || revealed ? " swipe-row--active" : ""}${className ? ` ${className}` : ""}`}
    onPointerDown={(event: ReactPointerEvent) => { if (event.pointerType === "touch") start.current = { x: event.clientX - (revealed ? -reveal : 0), y: event.clientY, id: event.pointerId }; }}
    onPointerMove={(event: ReactPointerEvent) => {
      const current = start.current; if (!current || current.id !== event.pointerId) return;
      const dx = event.clientX - current.x, dy = event.clientY - current.y;
      // Decide once: a mostly vertical move is a scroll, not a swipe.
      if (current.horizontal === undefined && Math.hypot(dx, dy) > 8) current.horizontal = Math.abs(dx) > Math.abs(dy) * 1.5;
      if (current.horizontal) setOffset(Math.max(-reveal * 1.4, Math.min(0, dx)));
    }}
    onPointerUp={end} onPointerCancel={end}
    onClickCapture={event => {
      // A tap on a revealed row closes it rather than opening the entry.
      if (revealed && !(event.target as HTMLElement).closest(".swipe-row-delete")) { event.preventDefault(); event.stopPropagation(); setRevealed(false); setOffset(0); }
    }}>
    <button type="button" className="swipe-row-delete danger" aria-hidden={!revealed} tabIndex={revealed ? 0 : -1}
      onClick={() => { setRevealed(false); setOffset(0); onDelete(); }}>{uiText(deleteLabel)}</button>
    <div className="swipe-row-content" style={offset ? { transform: `translateX(${offset}px)` } : undefined}>{children}</div>
  </div>;
}
