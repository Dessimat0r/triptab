"use client";
import { t as uiText } from "@/lib/ui-language";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function useListPaging(scope: string) {
  const [paging, setPaging] = useState<{ scope: string; counts: Record<string, number> }>({ scope, counts: {} });
  // Reset during render so A → B → A resets even if no list was expanded in B.
  if (paging.scope !== scope) setPaging({ scope, counts: {} });
  const counts = paging.scope === scope ? paging.counts : {};
  return (key: string, step: number) => ({
    shown: counts[key] ?? step,
    step,
    onMore: () => setPaging(previous => ({ scope, counts: { ...(previous.scope === scope ? previous.counts : {}), [key]: (previous.scope === scope ? previous.counts[key] ?? step : step) + step } })),
  });
}

/**
 * Renders the first `shown` items, then a Show more footer. Only visible items
 * are rendered, so hidden rows cost nothing. Rows sit in their own container so
 * row `:last-child` rules and `role="list"` see rows only; the footer and the
 * status message follow it. Each rendered row carries `data-entry-id`, which
 * Show more uses to focus the first newly revealed row.
 */
export default function PagedList<T>({ items, itemKey, renderItem, shown, step, onMore, noun, className = "", role }: {
  items: readonly T[]; itemKey: (item: T) => string; renderItem: (item: T, index: number) => ReactNode;
  shown: number; step: number; onMore: () => void; noun: string; className?: string; role?: "list";
}) {
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef<{ index: number; id: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const visible = Math.min(shown, items.length);
  useLayoutEffect(() => {
    if (pending.current === null) return;
    const { index, id } = pending.current;
    pending.current = null;
    const rows = root.current?.querySelectorAll<HTMLElement>("[data-entry-id]");
    const row = Array.from(rows ?? []).find(row => row.dataset.entryId === id) ?? rows?.[index];
    const target = row?.querySelector<HTMLElement>(".expense-open, .draft > .quiet") || row?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)") || row || root.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
    setAnnouncement(`Showing ${visible} of ${items.length} ${noun}`);
  }, [visible, items.length, noun]);
  return <div ref={root} className={`paged-list ${className}`} role="group" aria-label={noun} tabIndex={-1}>
    <div className="paged-list-items" role={role}>{items.slice(0, visible).map((item, index) => renderItem(item, index))}</div>
    {visible < items.length && <div className="list-more">
      <p className="muted">{uiText("Showing ")}{visible}{uiText(" of ")}{items.length} {noun}</p>
      <button type="button" className="quiet" onClick={() => { pending.current = { index: visible, id: itemKey(items[visible]) }; onMore(); }}>{uiText("Show ")}{Math.min(step, items.length - visible)}{uiText(" more")}</button>
    </div>}
    <span className="sr-only" role="status">{announcement}</span>
  </div>;
}
