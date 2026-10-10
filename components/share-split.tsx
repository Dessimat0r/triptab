"use client";
import { t as uiText } from "@/lib/ui-language";


import { useEffect, useId, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { allocate, itemSplitError, receiptSplitError, unitsScale, UNIT_SCALE, MAX_UNITS, type Item, type Trip } from "@/lib/model";
import "./share-split-units.css";

export function equalPercentages(ids: string[]): Record<string, number> {
  const values = allocate(10000, ids.map(() => 1));
  return Object.fromEntries(ids.map((id, i) => [id, values[i] / 100]));
}

function unitsText(value: number): string {
  const absolute = Math.abs(value);
  const fraction = String(absolute % UNIT_SCALE).padStart(6, "0").replace(/0+$/, "");
  return `${value < 0 ? "−" : ""}${Math.floor(absolute / UNIT_SCALE)}${fraction ? "." + fraction : ""}`;
}

function textScale(text: string): number | null {
  return unitsScale(text.trim().replace(",", "."));
}

function equalUnits(ids: string[], total: number, label?: string): NonNullable<Item["units"]> {
  const scaled = unitsScale(total);
  if (scaled === null || scaled <= 0 || !ids.length) throw Error("Enter a positive unit total and select at least one traveller.");
  const values = allocate(scaled, ids.map(() => 1));
  return { total, allocations: Object.fromEntries(ids.map((id, index) => [id, values[index] / UNIT_SCALE])), ...(label ? { label } : {}) };
}

function UnitsLabel({ value, label, onChange }: { value?: string; label: string; onChange: (label?: string) => void }) {
  const [text, setText] = useState(value || "");
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (active) setText(previous => previous.trim() === (value || "") ? previous : value || "");
    });
    return () => { active = false; };
  }, [value]);
  return <input aria-label={label} value={text} maxLength={40} placeholder={uiText("Bars, pieces, slices…")} autoComplete="off" onChange={event => {
    setText(event.target.value);
    onChange(event.target.value.trim() || undefined);
  }} />;
}

function UnitsInput({ value, onChange, label, describedBy, invalid }: {
  value: number; onChange: (value: number) => void; label: string; describedBy: string; invalid: boolean;
}) {
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : "");
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (active) setText(previous => textScale(previous) === unitsScale(value)
        ? previous : Number.isFinite(value) ? String(value) : "");
    });
    return () => { active = false; };
  }, [value]);
  return <input className="units-count-input" inputMode="decimal" autoComplete="off"
    aria-label={label} aria-describedby={describedBy} aria-invalid={invalid} value={text}
    onChange={event => {
      const next = event.target.value;
      setText(next);
      const scaled = textScale(next);
      onChange(scaled === null ? NaN : scaled / UNIT_SCALE);
    }} />;
}

function PercentageInput({ value, onChange, label, describedBy, invalid }: {
  value: number;
  onChange: (value: number) => void;
  label: string;
  describedBy: string;
  invalid: boolean;
}) {
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : "");
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => {
      if (active) setText(previous => {
        const parsed = previous.trim() ? Number(previous.replace(",", ".")) : NaN;
        return Object.is(parsed, value) ? previous : Number.isFinite(value) ? String(value) : "";
      });
    });
    return () => { active = false; };
  }, [value]);
  return <span className="percentage-input">
    <input
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      inputMode="decimal"
      value={text}
      onChange={event => {
        const next = event.target.value;
        if (/^-?\d*(?:[.,]\d*)?$/.test(next)) {
          setText(next);
          onChange(next.trim() ? Number(next.replace(",", ".")) : NaN);
        }
      }}
    />
    <span aria-hidden="true">%</span>
  </span>;
}

export type SplitMode = "equal" | "custom" | "units";
const modeLabels: Record<SplitMode, string> = { equal: "Equally", custom: "By percentage", units: "By quantity" };
const methodSummary: Record<SplitMode, string> = { equal: "Split equally", custom: "Split by percentage", units: "Split by quantity" };

/**
 * One sharing control for a whole bill, a single amount or a receipt line:
 * the people chips are always visible, and the split method opens in place
 * beneath them. Nothing reports an error while nobody is chosen yet; the
 * line, the bulk share and the Save checklist already say so once each.
 */
export default function ShareSplit({ id, members, selected, percentages, units, quantity, scope, alwaysPercent = false, legend, keepOne = false, methods, showMethods = true, onChange }: {
  id?: string;
  members: Trip["members"];
  selected: string[];
  percentages?: Record<string, number>;
  units?: Item["units"];
  quantity?: Item["quantity"];
  scope: string;
  alwaysPercent?: boolean;
  /** A visible heading. Without one the chips are labelled by `scope` for assistive technology. */
  legend?: string;
  /** The single-amount form always keeps someone on the purchase. */
  keepOne?: boolean;
  /** Further split choices listed with the methods, such as splitting by item. */
  methods?: ReactNode;
  /** A collapsed receipt line shows only its people; the method opens with the line. */
  showMethods?: boolean;
  onChange: (selected: string[], percentages?: Record<string, number>, units?: Item["units"]) => void;
}) {
  const [mode, setMode] = useState<SplitMode>(() => {
    if (units && !alwaysPercent) return "units";
    if (!percentages) return "equal";
    const equal = equalPercentages(selected);
    return selected.every(id => percentages[id] === equal[id]) ? "equal" : "custom";
  });
  // Incoming AI/manual review updates can introduce or remove a saved unit map.
  // Explicit mode buttons clear that map through onChange below.
  const activeMode: SplitMode = units && !alwaysPercent ? "units" : mode === "units" ? percentages ? "custom" : "equal" : mode;
  // Opened once for a split that already uses percentages or quantities; after
  // that the person decides, and a correction jump opens it when needed.
  const [initiallyOpen] = useState(() => activeMode !== "equal");
  const statusId = useId();
  const chosen = selected.length > 0;
  const error = alwaysPercent ? receiptSplitError({ percentages: percentages || equalPercentages(selected) }) : itemSplitError({ members: selected, percentages, units });
  const percentageTotal = percentages ? Object.values(percentages).reduce((sum, value) => sum + value, 0) : selected.length ? 100 : 0;
  const unitTotal = units?.total ?? 1;
  const quantityLabel = units?.label?.trim() || "units";
  const scaledTotal = unitsScale(unitTotal);
  const scaledAllocations = selected.map(id => unitsScale(units?.allocations[id] ?? 0));
  const allocatedUnits = scaledAllocations.every(value => value !== null)
    ? scaledAllocations.reduce<number>((sum, value) => sum + value!, 0) : null;
  function chooseMode(next: SplitMode) {
    setMode(next);
    const ids = selected.length ? selected : next === "units" ? [] : members.map(member => member.id);
    if (next === "equal") {
      onChange(ids, alwaysPercent ? equalPercentages(ids) : undefined, undefined);
    } else if (next === "units") {
      onChange(ids, undefined, units || (ids.length ? equalUnits(ids, quantity?.total ?? 1, quantity?.label) : { total: quantity?.total ?? 1, allocations: {}, ...(quantity?.label ? { label: quantity.label } : {}) }));
    } else {
      onChange(ids, percentages || equalPercentages(ids), undefined);
    }
  }
  function toggle(id: string) {
    const removing = selected.includes(id);
    if (removing && keepOne && selected.length === 1) return;
    const ids = removing ? selected.filter(value => value !== id) : members.map(member => member.id).filter(member => member === id || selected.includes(member));
    if (activeMode === "units") {
      onChange(ids, undefined, { ...units, total: unitTotal, allocations: Object.fromEntries(ids.map(member => [member, units?.allocations[member] ?? 0])) });
    } else if (activeMode === "custom") {
      const next = Object.fromEntries(ids.map(member => [member, percentages?.[member] ?? 0]));
      onChange(ids, next, undefined);
    } else {
      onChange(ids, alwaysPercent ? equalPercentages(ids) : undefined, undefined);
    }
  }
  const modes: SplitMode[] = alwaysPercent ? ["equal", "custom"] : ["equal", "custom", "units"];
  return <fieldset id={id} className="share-split">
    <legend className={legend ? undefined : "sr-only"}>{legend || `People for ${scope}`}</legend>
    <div className="personchips">
      {members.map((member, i) => <button type="button" key={member.id} className={selected.includes(member.id) ? "chosen" : ""} aria-pressed={selected.includes(member.id)} onClick={() => toggle(member.id)}>
        <span aria-hidden="true" className={`chipavatar color${i % 5}`}>{member.name.slice(0, 1).toUpperCase()}</span>
        {member.name}
        {selected.includes(member.id) && <Check size={13} aria-hidden="true" />}
      </button>)}
    </div>
    {showMethods && <details className="split-method" open={initiallyOpen || undefined}>
      <summary>{chosen ? methodSummary[activeMode] : "Split method"}<span className="split-method-change">{uiText("Change")}</span></summary>
      <div className="split-modes" role="group" aria-label={`Split options for ${scope}`}>
        {modes.map(value => <button type="button" key={value} aria-pressed={chosen && activeMode === value} className={chosen && activeMode === value ? "chosen" : ""} onClick={() => chooseMode(value)}>{modeLabels[value]}</button>)}
        {methods}
      </div>
      {chosen && activeMode === "custom" && <div className="percentage-rows">
        {selected.map(id => {
          const member = members.find(person => person.id === id);
          return <label className="percentage-row" key={id}>
            <span>{member?.name || "Unknown traveller"}</span>
            <PercentageInput label={`${member?.name || id} percentage for ${scope}`} describedBy={statusId} invalid={!!error} value={percentages?.[id] ?? 0} onChange={value => onChange(selected, { ...percentages, [id]: value }, undefined)} />
          </label>;
        })}
      </div>}
      {activeMode === "units" && <section className="units-split" aria-label={`Unit allocation for ${scope}`}>
        <p className="units-split-hint">{uiText("Units divide the full line total; they do not multiply its price. Use up to six decimal places, with a total up to ")}{MAX_UNITS.toLocaleString("en-GB")}.</p>
        <label className="units-label-field">{uiText("What do you call these? (optional)")}<UnitsLabel value={units?.label} label={`What do you call these for ${scope}?`} onChange={label => onChange(selected, undefined, { ...units, total: unitTotal, allocations: units?.allocations || {}, label })} />
        </label>
        <div className="units-split-controls">
          <label>{uiText("Total ")}{quantityLabel}
            <UnitsInput value={unitTotal} label={`Total ${quantityLabel} for ${scope}`} describedBy={statusId} invalid={scaledTotal === null || scaledTotal <= 0} onChange={total => onChange(selected, undefined, { ...units, total, allocations: units?.allocations || {} })} />
          </label>
          <button type="button" className="quiet" disabled={scaledTotal === null || scaledTotal <= 0 || !selected.length} onClick={() => onChange(selected, undefined, equalUnits(selected, unitTotal, units?.label))}>{uiText("Equal units")}</button>
        </div>
        <div className="units-split-rows">
          {selected.map(id => {
            const member = members.find(person => person.id === id);
            const value = units?.allocations[id] ?? 0;
            return <label className="units-split-row" key={id}>
              <span>{member?.name || "Unknown traveller"}</span>
              <UnitsInput value={value} label={`${member?.name || id} ${quantityLabel} for ${scope}`} describedBy={statusId} invalid={unitsScale(value) === null || !!error} onChange={value => onChange(selected, undefined, { ...units, total: unitTotal, allocations: { ...units?.allocations, [id]: value } })} />
            </label>;
          })}
        </div>
        {chosen && <div id={statusId} className={`split-total ${error ? "negative" : "positive"}`} role="status" aria-live="polite">
          <strong>{uiText("Allocated ")}{allocatedUnits === null ? "—" : unitsText(allocatedUnits)} / {scaledTotal === null ? "—" : unitsText(scaledTotal)} {quantityLabel}</strong>
          {scaledTotal !== null && allocatedUnits !== null && <span>{allocatedUnits === scaledTotal ? "Fully allocated" : allocatedUnits < scaledTotal ? `${unitsText(scaledTotal - allocatedUnits)} ${quantityLabel} remaining` : `${unitsText(allocatedUnits - scaledTotal)} ${quantityLabel} overallocated`}</span>}
          {error && <span>{error}</span>}
        </div>}
      </section>}
      {chosen && activeMode === "custom" && <div id={statusId} className={`split-total ${error ? "negative" : "positive"}`} role="status" aria-live="polite">
        <strong>{uiText("Total ")}{Number.isFinite(percentageTotal) ? Number(percentageTotal.toFixed(2)) : "—"}% / 100%</strong>
        {error && <span>{error}</span>}
      </div>}
    </details>}
  </fieldset>;
}
