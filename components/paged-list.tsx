"use client";
import { Children, isValidElement, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function useListPaging(scope: string) {
  const [paging, setPaging] = useState<{ scope: string; counts: Record<string, number> }>({ scope, counts: {} });
  // Reset during render so A → B → A resets even if no list was expanded in B.
  if (paging.scope !== scope) setPaging({ scope, counts: {} });
  const counts = paging.scope === scope ? paging.counts : {};
  return (key: string, step: number) => ({
    shown: counts[key] ?? step,
    onMore: () => setPaging(previous => ({ scope, counts: { ...(previous.scope === scope ? previous.counts : {}), [key]: (previous.scope === scope ? previous.counts[key] ?? step : step) + step } })),
  });
}
export default function PagedList({ children, shown, onMore, step, noun, className = "", role }: {
  children: ReactNode; shown: number; onMore: () => void; step: number; noun: string; className?: string; role?: "list";
}) {
  const entries = Children.toArray(children);
  const root = useRef<HTMLDivElement>(null);
  const pending = useRef<{ index: number; id?: string } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useLayoutEffect(() => {
    if (pending.current === null) return;
    const { index, id } = pending.current;
    pending.current = null;
    const rows = root.current?.querySelectorAll<HTMLElement>("[data-entry-id]");
    const row = (id ? Array.from(rows ?? []).find(row => row.dataset.entryId === id) : undefined) ?? rows?.[index];
    const target = row?.querySelector<HTMLElement>(".expense-open, .draft > .quiet") || row?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)") || row || root.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "nearest" });
    setAnnouncement(`Showing ${Math.min(shown, entries.length)} of ${entries.length} ${noun}`);
  }, [shown, entries.length, noun]);
  return <div ref={root} className={`paged-list ${className}`} role={role ?? "group"} aria-label={noun} tabIndex={-1}>
    {entries.slice(0, shown)}
    {shown < entries.length && <div className="list-more">
      <p className="muted">Showing {shown} of {entries.length} {noun}</p>
      <button type="button" className="quiet" onClick={() => { const entry = entries[shown]; pending.current = { index: shown, id: isValidElement<{ "data-entry-id"?: string }>(entry) ? entry.props["data-entry-id"] : undefined }; onMore(); }}>Show {Math.min(step, entries.length - shown)} more</button>
    </div>}
    <span className="sr-only" role="status">{announcement}</span>
  </div>;
}
