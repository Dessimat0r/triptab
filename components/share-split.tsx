"use client";

import { useEffect, useId, useState } from "react";
import { Check } from "lucide-react";
import { allocate, itemSplitError, receiptSplitError, type Trip } from "@/lib/model";

export function equalPercentages(ids: string[]): Record<string, number> {
  const values = allocate(10000, ids.map(() => 1));
  return Object.fromEntries(ids.map((id, i) => [id, values[i] / 100]));
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

export default function ShareSplit({ members, selected, percentages, scope, alwaysPercent = false, onChange }: {
  members: Trip["members"];
  selected: string[];
  percentages?: Record<string, number>;
  scope: string;
  alwaysPercent?: boolean;
  onChange: (selected: string[], percentages?: Record<string, number>) => void;
}) {
  const [mode, setMode] = useState<"equal" | "one" | "custom">(() => {
    if (selected.length === 1) return "one";
    if (!percentages) return "equal";
    const equal = equalPercentages(selected);
    return selected.every(id => percentages[id] === equal[id]) ? "equal" : "custom";
  });
  const statusId = useId();
  const error = alwaysPercent ? receiptSplitError({ percentages: percentages || equalPercentages(selected) }) : itemSplitError({ id: "split", name: "split", amount: 0, members: selected, percentages });
  const percentageTotal = percentages ? Object.values(percentages).reduce((sum, value) => sum + value, 0) : selected.length ? 100 : 0;
  function chooseMode(next: typeof mode) {
    setMode(next);
    const ids = selected.length ? selected : members.map(member => member.id);
    if (next === "one") {
      const person = ids[0];
      onChange([person], alwaysPercent ? { [person]: 100 } : undefined);
    } else if (next === "equal") {
      onChange(ids, alwaysPercent ? equalPercentages(ids) : undefined);
    } else {
      onChange(ids, percentages || equalPercentages(ids));
    }
  }
  function toggle(id: string) {
    const ids = selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id];
    if (mode === "custom") {
      const next = Object.fromEntries(ids.map(member => [member, percentages?.[member] ?? 0]));
      onChange(ids, next);
    } else {
      onChange(ids, alwaysPercent ? equalPercentages(ids) : undefined);
    }
  }
  return <fieldset className="share-split">
    <legend>Share of {scope}</legend>
    <div className="split-modes" role="group" aria-label={`Split options for ${scope}`}>
      {([['equal', 'Equal'], ['one', 'One person'], ['custom', 'Custom percentages']] as const).map(([value, label]) =>
        <button type="button" key={value} aria-pressed={mode === value} className={mode === value ? "chosen" : ""} onClick={() => chooseMode(value)}>{label}</button>,
      )}
    </div>
    {mode === "one" ? <label className="single-share">
      Responsible for this {scope.startsWith("item") ? "item" : "receipt"}
      <select aria-label={`Person for ${scope}`} value={selected[0] || ""} onChange={event => {
        const id = event.target.value;
        onChange([id], alwaysPercent ? { [id]: 100 } : undefined);
      }}>
        {members.map(member => <option key={member.id} value={member.id}>{member.name} · 100%</option>)}
      </select>
    </label> : <div className="personchips">
      {members.map((member, i) => <button type="button" key={member.id} className={selected.includes(member.id) ? "chosen" : ""} aria-pressed={selected.includes(member.id)} onClick={() => toggle(member.id)}>
        <span aria-hidden="true" className={`chipavatar color${i % 5}`}>{member.name.slice(0, 1).toUpperCase()}</span>
        {member.name}
        {selected.includes(member.id) && <Check size={13} />}
      </button>)}
    </div>}
    {mode === "custom" && <div className="percentage-rows">
      {selected.map(id => {
        const member = members.find(person => person.id === id);
        return <label className="percentage-row" key={id}>
          <span>{member?.name || "Unknown traveller"}</span>
          <PercentageInput label={`${member?.name || id} percentage for ${scope}`} describedBy={statusId} invalid={!!error} value={percentages?.[id] ?? 0} onChange={value => onChange(selected, { ...percentages, [id]: value })} />
        </label>;
      })}
    </div>}
    {(mode === "custom" || alwaysPercent || error) && <div id={statusId} className={`split-total ${error ? "negative" : "positive"}`} role="status" aria-live="polite">
      <strong>Total {Number.isFinite(percentageTotal) ? Number(percentageTotal.toFixed(2)) : "—"}% / 100%</strong>
      {error && <span>{error}</span>}
    </div>}
  </fieldset>;
}
