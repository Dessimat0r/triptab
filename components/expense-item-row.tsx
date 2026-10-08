"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";

/**
 * One line of an itemised expense. Collapsed, it reads as a single row (name,
 * price and a flag when something needs checking) with the people chips
 * beneath it. Opening the row shows the line's own editors. A line that cannot
 * be saved as it is opens by itself, and a correction jump opens a closed one
 * (the editors stay in the document inside the closed disclosure).
 */
export default function ExpenseItemRow({ id, index, name, detail, price, flag, unassigned, open: initiallyOpen, sharing, children }: {
  id: string;
  index: number;
  name: string;
  /** The other language's name, when the line has both. */
  detail?: string;
  price: string;
  /** A short reason the line needs checking, such as "Check" or "Price". */
  flag?: string;
  unassigned?: boolean;
  /** Whether the line opens when first shown. Later changes never close it under the person. */
  open: boolean;
  /** The line's people, given whether the line is open so its split method can follow. */
  sharing?: (open: boolean) => ReactNode;
  children: ReactNode;
}) {
  const [defaultOpen] = useState(initiallyOpen);
  const [open, setOpen] = useState(initiallyOpen);
  const label = name.trim() || `Item ${index + 1}`;
  return <div className={`item${open ? " item--open" : ""}${unassigned ? " item--unassigned" : ""}`} id={id}>
    <details className="item-edit" open={defaultOpen || undefined} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="item-summary-name">{label}{detail && <small>{detail}</small>}</span>
        {flag && <span className="item-flag"><AlertTriangle size={13} aria-hidden="true" />{flag}</span>}
        <span className="item-summary-price">{price}</span>
        <ChevronDown className="item-summary-chevron" size={18} aria-hidden="true" />
        <span className="sr-only">{open ? `Close item ${index + 1}` : `Edit item ${index + 1}`}</span>
      </summary>
      <div className="item-body">{children}</div>
    </details>
    {sharing?.(open)}
  </div>;
}
