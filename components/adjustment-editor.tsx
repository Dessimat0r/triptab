"use client";
import { t as uiText } from "@/lib/ui-language";
import { useId, useState } from "react";
import { Minus, Pencil, Plus } from "lucide-react";
import { applyAdjustments, type Adjustment } from "@/lib/adjustments";
import { parseAmountText } from "@/lib/amount-text";
import { formatMoney } from "@/lib/money-format";
import { shares } from "@/lib/model";
import type { ReceiptEditor } from "@/lib/receipt-processing";

/** Values for opening the form, e.g. from an unmapped receipt line or a reconciliation difference. */
export type AdjustmentDraft = Partial<Omit<Adjustment, "scope">> & { scope?: Adjustment["scope"]; editing?: string };

const money = (amount: number, currency: string | null | undefined) => currency ? formatMoney(amount, currency) : (amount / 100).toFixed(2);
const newId = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `adjustment-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function describeScope(adjustment: Adjustment, entry: ReceiptEditor) {
  if (adjustment.scope.type === "receipt") return uiText("Whole receipt");
  const count = adjustment.scope.itemIds.length;
  return count === 1 ? entry.items.find(item => item.id === (adjustment.scope as { itemIds: string[] }).itemIds[0])?.name || uiText("1 item")
    : uiText("{value0} items", { value0: count });
}

/**
 * Discounts and charges as their own rows (F-02). Printed item prices never
 * change; each row shows what it takes off which lines, and the form shows
 * every person's resulting change before it is added.
 */
export default function AdjustmentEditor({ entry, members, onChange, draft, onDraft }: {
  entry: ReceiptEditor;
  members: { id: string; name: string }[];
  onChange: (entry: ReceiptEditor) => void;
  /** The open form, or null. Owned by the parent so other controls can open it. */
  draft: AdjustmentDraft | null;
  onDraft: (draft: AdjustmentDraft | null) => void;
}) {
  const adjustments = entry.adjustments ?? [];
  const result = applyAdjustments(entry.items, adjustments);
  const remove = (id: string) => onChange({ ...entry, adjustments: adjustments.filter(value => value.id !== id) });
  return <section className="adjustment-list" id="expense-discounts" aria-labelledby="expense-discounts-title">
    <h4 id="expense-discounts-title">{uiText("Discounts and charges")}</h4>
    {!!adjustments.length && <ul>
      {adjustments.map(adjustment => {
        const applied = result.applied.find(value => value.id === adjustment.id);
        const sign = adjustment.kind === "discount" ? "−" : "+";
        return <li key={adjustment.id} data-adjustment-id={adjustment.id}>
          <div className="adjustment-row">
            <span>
              <strong>{adjustment.label || (adjustment.kind === "discount" ? uiText("Discount") : uiText("Charge"))}</strong>
              <small>{describeScope(adjustment, entry)}{adjustment.percent !== undefined ? ` · ${adjustment.percent}%` : ""}</small>
            </span>
            <b>{applied ? `${sign}${money(applied.amount, entry.currency)}` : uiText("Check")}</b>
            <button type="button" className="iconbutton" aria-label={uiText("Edit {value0}", { value0: adjustment.label || uiText("discount") })}
              onClick={() => onDraft({ ...adjustment, editing: adjustment.id })}><Pencil size={16} aria-hidden="true" /></button>
            <button type="button" className="iconbutton" aria-label={uiText("Remove {value0}", { value0: adjustment.label || uiText("discount") })}
              onClick={() => remove(adjustment.id)}><Minus size={16} aria-hidden="true" /></button>
          </div>
          {applied?.allocation && <small className="adjustment-lines">{Object.keys(applied.allocation).map(itemId => {
            const item = entry.items.find(value => value.id === itemId);
            const index = entry.items.findIndex(value => value.id === itemId);
            return item && item.amount !== null ? `${item.name || uiText("Item")} ${money(item.amount, entry.currency)} → ${money(result.net[index] ?? 0, entry.currency)}` : "";
          }).filter(Boolean).join(" · ")}</small>}
        </li>;
      })}
    </ul>}
    {!!result.errors.length && <p className="error" role="alert">{uiText(result.errors[0])}</p>}
    {draft ? <AdjustmentForm key={draft.editing || draft.id || "new"} entry={entry} members={members} draft={draft}
      onCancel={() => onDraft(null)}
      onSave={adjustment => {
        const next = draft.editing ? adjustments.map(value => value.id === draft.editing ? adjustment : value) : [...adjustments, adjustment];
        onChange({ ...entry, adjustments: next }); onDraft(null);
      }} />
      : <div className="action-row">
        <button type="button" className="quiet" onClick={() => onDraft({ kind: "discount" })}><Plus size={16} aria-hidden="true" />{uiText(" Add discount")}</button>
        <button type="button" className="quiet" onClick={() => onDraft({ kind: "charge" })}><Plus size={16} aria-hidden="true" />{uiText(" Add charge")}</button>
      </div>}
  </section>;
}

function AdjustmentForm({ entry, members, draft, onSave, onCancel }: {
  entry: ReceiptEditor; members: { id: string; name: string }[]; draft: AdjustmentDraft;
  onSave: (adjustment: Adjustment) => void; onCancel: () => void;
}) {
  const formId = useId();
  const [kind, setKind] = useState<Adjustment["kind"]>(draft.kind ?? "discount");
  const [label, setLabel] = useState(draft.label ?? "");
  const [mode, setMode] = useState<"amount" | "percent">(draft.percent !== undefined ? "percent" : "amount");
  const [amountText, setAmountText] = useState(draft.amount ? (draft.amount / 100).toFixed(2) : "");
  const [percentText, setPercentText] = useState(draft.percent !== undefined ? String(draft.percent) : "");
  const [scopeType, setScopeType] = useState<"receipt" | "items">(draft.scope?.type ?? "items");
  const [itemIds, setItemIds] = useState<string[]>(draft.scope?.type === "items" ? draft.scope.itemIds : []);
  const [manual, setManual] = useState(!!draft.allocation);
  const [parts, setParts] = useState<Record<string, string>>(Object.fromEntries(Object.entries(draft.allocation ?? {}).map(([itemId, part]) => [itemId, (part / 100).toFixed(2)])));

  const amount = parseAmountText(amountText)?.hundredths;
  const percent = /^\d{1,3}([.,]\d{1,2})?$/.test(percentText.trim()) ? Number(percentText.trim().replace(",", ".")) : undefined;
  const chosen = entry.items.filter(item => itemIds.includes(item.id)).map(item => item.id);
  const allocation = manual && mode === "amount" && scopeType === "items"
    ? Object.fromEntries(chosen.map(itemId => [itemId, parseAmountText(parts[itemId] ?? "")?.hundredths ?? 0])) : undefined;
  const candidate: Adjustment | null = (mode === "amount" ? amount : percent) && (scopeType === "receipt" || chosen.length) ? {
    id: draft.editing ?? draft.id ?? newId(), kind, ...(label.trim() ? { label: label.trim().slice(0, 80) } : {}),
    ...(mode === "amount" ? { amount: amount! } : { percent: percent! }),
    scope: scopeType === "receipt" ? { type: "receipt" } : { type: "items", itemIds: chosen },
    ...(allocation ? { allocation } : {}),
    ...(draft.sourceLineIndex !== undefined ? { sourceLineIndex: draft.sourceLineIndex } : {}),
    source: draft.source ?? "user",
  } : null;
  const others = (entry.adjustments ?? []).filter(value => value.id !== draft.editing);
  const before = applyAdjustments(entry.items, others);
  const after = candidate ? applyAdjustments(entry.items, [...others, candidate]) : null;
  const problem = !candidate ? (scopeType === "items" && !chosen.length ? uiText("Choose the items it applies to") : uiText(mode === "amount" ? "Enter the amount" : "Enter a percentage up to 100"))
    : percent !== undefined && mode === "percent" && percent > 100 ? uiText("Enter a percentage up to 100")
      : after?.errors.length ? uiText(after.errors[0]) : null;
  const total = (value: ReturnType<typeof applyAdjustments>) => value.net.reduce<number>((sum, net) => sum + (net ?? 0), 0) + value.receiptDelta + entry.tax + entry.tip - entry.discount;
  const preview = (() => {
    if (!candidate || problem || entry.items.some(item => item.amount === null)) return null;
    try {
      const old = shares({ ...entry, adjustments: others }, members);
      const next = shares({ ...entry, adjustments: [...others, candidate] }, members);
      return { total: total(after!), changes: members.map((member, index) => ({ name: member.name, change: next[index] - old[index] })).filter(value => value.change) };
    } catch { return null; }
  })();
  const defaultParts = after?.applied.find(value => value.id === candidate?.id)?.allocation;

  return <fieldset className="adjustment-form" aria-labelledby={`${formId}-legend`}>
    <legend id={`${formId}-legend`}>{draft.editing ? uiText("Edit discount or charge") : kind === "discount" ? uiText("Add discount") : uiText("Add charge")}</legend>
    <div className="segmented" role="radiogroup" aria-label={uiText("Type")}>
      {(["discount", "charge"] as const).map(value => <label key={value}><input type="radio" name={`${formId}-kind`} checked={kind === value} onChange={() => setKind(value)} />{value === "discount" ? uiText("Discount") : uiText("Charge")}</label>)}
    </div>
    <label>{uiText("Label (optional)")}<input value={label} maxLength={80} placeholder={kind === "discount" ? uiText("BOGOF, coupon, loyalty…") : uiText("Service, deposit…")} onChange={event => setLabel(event.target.value)} /></label>
    <div className="segmented" role="radiogroup" aria-label={uiText("Amount or percentage")}>
      <label><input type="radio" name={`${formId}-mode`} checked={mode === "amount"} onChange={() => setMode("amount")} />{uiText("Amount")}</label>
      <label><input type="radio" name={`${formId}-mode`} checked={mode === "percent"} onChange={() => { setMode("percent"); setManual(false); }} />{uiText("Percent")}</label>
    </div>
    {mode === "amount" ? <label>{uiText("Amount")}<input aria-label={uiText("Discount amount")} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amountText}
      onChange={event => { if (parseAmountText(event.target.value)) setAmountText(event.target.value); }} /></label>
      : <label>{uiText("Percent")}<input aria-label={uiText("Discount percent")} inputMode="decimal" autoComplete="off" placeholder="10" value={percentText}
        onChange={event => setPercentText(event.target.value)} /></label>}
    <div className="segmented" role="radiogroup" aria-label={uiText("Applies to")}>
      <label><input type="radio" name={`${formId}-scope`} checked={scopeType === "items"} onChange={() => setScopeType("items")} />{uiText("Chosen items")}</label>
      <label><input type="radio" name={`${formId}-scope`} checked={scopeType === "receipt"} onChange={() => { setScopeType("receipt"); setManual(false); }} />{uiText("Whole receipt")}</label>
    </div>
    {scopeType === "items" && <fieldset className="adjustment-items">
      <legend>{uiText("Applies to these items")}</legend>
      {entry.items.map((item, index) => <label key={item.id}>
        <input type="checkbox" checked={itemIds.includes(item.id)} onChange={event => setItemIds(previous => event.target.checked ? [...previous, item.id] : previous.filter(value => value !== item.id))} />
        <span>{item.name || uiText("Item {value0}", { value0: index + 1 })}</span>
        <small>{item.amount === null ? uiText("Unreadable") : money(item.amount, entry.currency)}</small>
      </label>)}
    </fieldset>}
    {scopeType === "items" && mode === "amount" && chosen.length > 1 && <div className="adjustment-split">
      <label><input type="checkbox" checked={manual} onChange={event => {
        setManual(event.target.checked);
        if (event.target.checked && defaultParts) setParts(Object.fromEntries(Object.entries(defaultParts).map(([itemId, part]) => [itemId, (part / 100).toFixed(2)])));
      }} />{uiText("Split between items manually")}</label>
      {manual ? chosen.map(itemId => <label key={itemId}>{entry.items.find(item => item.id === itemId)?.name || uiText("Item")}
        <input inputMode="decimal" autoComplete="off" aria-label={uiText("Part for {value0}", { value0: entry.items.find(item => item.id === itemId)?.name || uiText("item") })}
          value={parts[itemId] ?? ""} onChange={event => { if (parseAmountText(event.target.value)) setParts(previous => ({ ...previous, [itemId]: event.target.value })); }} />
      </label>) : defaultParts && <small>{uiText("Shared in proportion to the printed prices: ")}{Object.entries(defaultParts).map(([itemId, part]) => `${entry.items.find(item => item.id === itemId)?.name || uiText("item")} ${money(part, entry.currency)}`).join(", ")}</small>}
    </div>}
    {problem ? <p className="footnote" role="status">{problem}</p> : preview && <p className="adjustment-preview" role="status">
      {uiText("New total {value0}", { value0: money(preview.total, entry.currency) })}
      {preview.changes.length ? ` · ${preview.changes.map(value => `${value.name} ${value.change < 0 ? "−" : "+"}${money(Math.abs(value.change), entry.currency)}`).join(" · ")}` : ""}
    </p>}
    {before.errors.length > 0 && <p className="footnote">{uiText(before.errors[0])}</p>}
    <div className="action-row">
      <button type="button" className="primary" disabled={!candidate || !!problem} onClick={() => candidate && onSave(candidate)}>{draft.editing ? uiText("Save changes") : uiText("Add")}</button>
      <button type="button" className="quiet" onClick={onCancel}>{uiText("Cancel")}</button>
    </div>
  </fieldset>;
}
