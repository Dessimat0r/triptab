"use client";
import { t as uiText } from "@/lib/ui-language";
import { useEffect, useId, useState } from "react";
import { Minus, Pencil, Plus } from "lucide-react";
import { adjustmentSchema, applyAdjustments, nextOfferLetter, offerLetters, type Adjustment } from "@/lib/adjustments";
import { builtInOffers, offerRuleSchema, type OfferRule, type SavedOffer } from "@/lib/offer-rules";
import { parseAmountText } from "@/lib/amount-text";
import { formatMoney } from "@/lib/money-format";
import { previewAdjustment } from "@/lib/adjustment-preview";
import type { ReceiptEditor } from "@/lib/receipt-processing";

/** Values for opening the form, e.g. from an unmapped receipt line or a reconciliation difference. */
export type AdjustmentDraft = Partial<Omit<Adjustment, "scope">> & { scope?: Adjustment["scope"]; editing?: string };

const money = (amount: number, currency: string | null | undefined) => currency ? formatMoney(amount, currency) : (amount / 100).toFixed(2);
const newId = () => typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `adjustment-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export function OfferBadge({ letter, onClick, active }: { letter: string; onClick?: () => void; active?: boolean }) {
  const style = `offer-badge offer-badge--${offerLetters.indexOf(letter) % 5}`;
  return onClick ? <button type="button" className={style} aria-label={`Group ${letter}`} aria-pressed={active} onClick={onClick}>{letter}</button>
    : <span className={style} aria-label={`Group ${letter}`}>{letter}</span>;
}

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
type Member = { id: string; name: string; weight?: number };

export default function AdjustmentEditor({ entry, members, onChange, draft, onDraft, highlightedGroup }: {
  entry: ReceiptEditor;
  members: Member[];
  onChange: (entry: ReceiptEditor) => void;
  /** The open form, or null. Owned by the parent so other controls can open it. */
  draft: AdjustmentDraft | null;
  onDraft: (draft: AdjustmentDraft | null) => void;
  highlightedGroup?: string;
}) {
  const adjustments = entry.adjustments ?? [];
  const result = applyAdjustments(entry.items, adjustments, entry.currency);
  const remove = (id: string) => onChange({ ...entry, adjustments: adjustments.filter(value => value.id !== id) });
  return <section className="adjustment-list" id="expense-discounts" aria-labelledby="expense-discounts-title">
    <h4 id="expense-discounts-title">{uiText("Discounts and charges")}</h4>
    {!!adjustments.length && <ul>
      {adjustments.map(adjustment => {
        const applied = result.applied.find(value => value.id === adjustment.id);
        const sign = adjustment.kind === "discount" ? "−" : "+";
        return <li key={adjustment.id} className={adjustment.group && adjustment.group === highlightedGroup ? "offer-highlight" : undefined} data-adjustment-id={adjustment.id}>
          <div className="adjustment-row">
            <span>
              <strong>{adjustment.group && <OfferBadge letter={adjustment.group} onClick={() => onDraft({ ...adjustment, editing: adjustment.id })} />}{adjustment.label || (adjustment.kind === "discount" ? uiText("Discount") : uiText("Charge"))}</strong>
              <small>{describeScope(adjustment, entry)}{adjustment.percent !== undefined ? ` · ${adjustment.percent}%` : ""}</small>
            </span>
            <b>{applied ? `${sign}${money(applied.amount, entry.currency)}` : uiText("Check")}</b>
            <button type="button" className="iconbutton" aria-label={uiText("Edit {value0}", { value0: adjustment.label || uiText("discount") })}
              onClick={() => onDraft({ ...adjustment, editing: adjustment.id })}><Pencil size={16} aria-hidden="true" /></button>
            <button type="button" className="iconbutton" aria-label={uiText("Remove {value0}", { value0: adjustment.label || uiText("discount") })}
              onClick={() => remove(adjustment.id)}><Minus size={16} aria-hidden="true" /></button>
          </div>
          {applied?.expected !== undefined && applied.expected !== applied.amount && <small className="adjustment-lines">{`Receipt ${money(applied.amount, entry.currency)} · Rule calculates ${money(applied.expected, entry.currency)}`}</small>}
          {applied?.members && <small className="adjustment-lines">{Object.entries(applied.members).map(([id, amount]) => `${members.find(member => member.id === id)?.name ?? id} ${sign}${money(amount, entry.currency)}`).join(" · ")}</small>}
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
      onSave={(next, items) => { onChange({ ...entry, adjustments: next, items }); onDraft(null); }} />
      : <div className="action-row">
        <button type="button" className="quiet" onClick={() => onDraft({ kind: "discount" })}><Plus size={16} aria-hidden="true" />{uiText(" Add discount")}</button>
        <button type="button" className="quiet" onClick={() => onDraft({ kind: "charge" })}><Plus size={16} aria-hidden="true" />{uiText(" Add charge")}</button>
      </div>}
  </section>;
}

function AdjustmentForm({ entry, members, draft, onSave, onCancel }: {
  entry: ReceiptEditor; members: Member[]; draft: AdjustmentDraft;
  /** Receives the complete ordered list that was previewed (R03). */
  onSave: (adjustments: Adjustment[], items: ReceiptEditor['items']) => void; onCancel: () => void;
}) {
  const formId = useId();
  const [kind, setKind] = useState<Adjustment["kind"]>(draft.kind ?? "discount");
  const [label, setLabel] = useState(draft.label ?? "");
  const [mode, setMode] = useState<"amount" | "percent" | "rule">(draft.rule ? "rule" : draft.percent !== undefined ? "percent" : "amount");
  const [ruleMode, setRuleMode] = useState<keyof typeof builtInOffers | "custom">("custom");
  const [benefit, setBenefit] = useState<OfferRule["benefit"]>(draft.rule?.benefit ?? "percent");
  const [ruleValue, setRuleValue] = useState(draft.rule ? String(draft.rule.benefit === "percent" ? draft.rule.value : draft.rule.value / 100) : "");
  const [buy, setBuy] = useState(draft.rule?.buy?.toString() ?? "");
  const [cheapest, setCheapest] = useState(draft.rule?.cheapest?.toString() ?? "");
  const [cap, setCap] = useState(draft.rule?.cap === undefined ? "" : String(draft.rule.cap / 100));
  const [limit, setLimit] = useState(draft.rule?.limit?.toString() ?? "");
  const [ruleCurrency, setRuleCurrency] = useState(draft.rule?.currency);
  const [savedOffers, setSavedOffers] = useState<SavedOffer[]>([]);
  const [savedName, setSavedName] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [savingRule, setSavingRule] = useState(false);
  const [printedText, setPrintedText] = useState(draft.printedAmount === undefined ? "" : (draft.printedAmount / 100).toFixed(2));
  const [stacking, setStacking] = useState(draft.stacking ?? false);
  const [group, setGroup] = useState(draft.group ?? "");
  const [portions, setPortions] = useState(draft.scope?.type === "items" ? draft.scope.portions ?? {} : {});
  const [purchased, setPurchased] = useState<Record<string, string>>({});
  const [sharing, setSharing] = useState<"items" | "cheapest" | "equal" | "exact">(draft.memberSplit?.mode ?? (draft.rewardOnly ? "cheapest" : "items"));
  const [people, setPeople] = useState<string[] | null>(draft.memberSplit?.mode === "equal" ? draft.memberSplit.memberIds : draft.memberSplit?.mode === "exact" ? Object.keys(draft.memberSplit.amounts) : null);
  const [memberAmounts, setMemberAmounts] = useState<Record<string, string>>(draft.memberSplit?.mode === "exact"
    ? Object.fromEntries(Object.entries(draft.memberSplit.amounts).map(([id, amount]) => [id, (amount / 100).toFixed(2)])) : {});
  useEffect(() => {
    if (mode !== "rule") return;
    const controller = new AbortController();
    void fetch("/api/receipt/offer-rules", { signal: controller.signal }).then(async response => {
      if (!response.ok) return;
      const rules: unknown = await response.json();
      if (Array.isArray(rules)) setSavedOffers(rules as SavedOffer[]);
    }).catch(() => {});
    return () => controller.abort();
  }, [mode]);
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
  const selectRule = (offer: SavedOffer, preset: typeof ruleMode) => {
    const { rule, name } = offer;
    setRuleMode(preset); setLabel(name); setBenefit(rule.benefit);
    setRuleValue(String(rule.benefit === "percent" ? rule.value : rule.value / 100));
    setBuy(rule.buy?.toString() ?? ""); setCheapest(rule.cheapest?.toString() ?? "");
    setCap(rule.cap === undefined ? "" : String(rule.cap / 100)); setLimit(rule.limit?.toString() ?? "");
    setRuleCurrency(rule.currency);
    if (rule.buy) setScopeType("items");
  };
  const ruleResult = offerRuleSchema.safeParse({
    version: 1, benefit, value: benefit === "percent" ? (ruleValue.trim() ? Number(ruleValue.replace(",", ".")) : NaN) : parseAmountText(ruleValue)?.hundredths,
    buy: buy ? Number(buy) : undefined, cheapest: cheapest ? Number(cheapest) : undefined,
    cap: cap ? parseAmountText(cap)?.hundredths ?? NaN : undefined, limit: limit ? Number(limit) : undefined, currency: ruleCurrency,
  });
  const printed = parseAmountText(printedText)?.hundredths || undefined;
  const fromEvidence = draft.sourceLineIndex === undefined ? undefined : entry.receiptScan?.sourceLines?.find(line => line.lineIndex === draft.sourceLineIndex)?.amount;
  const printedAmount = printed ?? (fromEvidence && fromEvidence < 0 ? -fromEvidence : undefined);
  const rule = kind === "discount" && mode === "rule" && ruleResult.success ? ruleResult.data : undefined;
  const items = entry.items.map(item => {
    const total = Number(purchased[item.id]);
    return rule?.buy && chosen.includes(item.id) && !item.quantity && Number.isSafeInteger(total) && total > 1 && total <= 200
      ? { ...item, quantity: { total }, fieldSources: { ...item.fieldSources, quantity: "user" as const } } : item;
  });
  const chosenPortions = Object.fromEntries(chosen.flatMap(id => portions[id] === undefined ? [] : [[id, portions[id]]]));
  const participantIds = [...new Set(entry.items.filter(item => scopeType === "receipt" || chosen.includes(item.id)).flatMap(item => item.members))];
  const selectedPeople = people ?? participantIds;
  const memberSplit = sharing === "equal" ? { mode: "equal", memberIds: selectedPeople }
    : sharing === "exact" ? { mode: "exact", amounts: Object.fromEntries(selectedPeople.map(id => [id, parseAmountText(memberAmounts[id] ?? "")?.hundredths ?? 0])) } : undefined;
  const labelValue = label.trim().slice(0, 80);
  const parsed = adjustmentSchema.safeParse({
    id: draft.editing ?? draft.id ?? newId(), kind, ...(labelValue ? { label: labelValue } : {}),
    ...(rule ? { rule, printedAmount } : mode === "percent" ? { percent } : mode === "amount" ? { amount } : {}),
    scope: scopeType === "receipt" ? { type: "receipt" } : { type: "items", itemIds: chosen, ...(Object.keys(chosenPortions).length ? { portions: chosenPortions } : {}) },
    group: scopeType === "items" && kind === "discount" ? group || nextOfferLetter(entry.adjustments ?? []) : undefined,
    stacking: stacking || undefined, rewardOnly: sharing === "cheapest" && !!rule?.cheapest || undefined, memberSplit,
    ...(allocation && !rule ? { allocation } : {}),
    sourceLineIndex: draft.sourceLineIndex, source: "user",
  });
  const candidate = parsed.success ? parsed.data : null;
  const existingGroups = [...new Map((entry.adjustments ?? []).flatMap(value => value.group && value.scope.type === "items" ? [[value.group, value.scope] as const] : [])).entries()].sort();
  async function saveRule(replace: boolean) {
    if (!rule || !savedName.trim() || savingRule) return;
    setSavingRule(true); setSaveMessage("");
    const currency = rule.benefit === "percent" && !rule.cap ? undefined : entry.currency ?? undefined;
    try {
      const response = await fetch(`/api/receipt/offer-rules${replace ? "?replace=true" : ""}`, { method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: savedName, rule: { ...rule, currency } }) });
      const result = await response.json() as SavedOffer & { error?: string };
      if (!response.ok) throw Error(result.error ?? "Could not save the rule.");
      setSavedOffers(previous => [...previous.filter(offer => offer.name.normalize("NFKC").toLowerCase() !== result.name.normalize("NFKC").toLowerCase()), result]);
      setSaveMessage("Rule saved");
    } catch (error) { setSaveMessage(error instanceof Error ? error.message : "Could not save the rule."); }
    finally { setSavingRule(false); }
  }
  // R03: one ordered list, with an edited row kept in place, for the
  // preview, its validation and Save. Shares use the rule Save stamps.
  const { list, before, after: applied, outcome } = previewAdjustment({ ...entry, items }, members, candidate, draft.editing);
  const after = candidate ? applied : null;
  const problem = !candidate ? (scopeType === "items" && !chosen.length ? uiText("Choose the items it applies to") : parsed.error?.issues[0]?.message ?? "Check the offer")
    : after?.errors[0] ?? (memberSplit && !outcome && !entry.items.some(item => item.amount === null) ? "Check that the saving does not exceed anyone’s share." : null);
  const preview = !problem && outcome ? { total: outcome.total,
    changes: outcome.changes.map(value => ({ name: members.find(member => member.id === value.id)?.name ?? "", change: value.change })) } : null;
  const defaultParts = after?.applied.find(value => value.id === candidate?.id)?.allocation;

  return <fieldset className="adjustment-form" aria-labelledby={`${formId}-legend`}>
    <legend id={`${formId}-legend`}>{draft.editing ? uiText("Edit discount or charge") : kind === "discount" ? uiText("Add discount") : uiText("Add charge")}</legend>
    <div className="segmented" role="radiogroup" aria-label={uiText("Type")}>
      {(["discount", "charge"] as const).map(value => <label key={value}><input type="radio" name={`${formId}-kind`} checked={kind === value} onChange={() => { setKind(value); if (value === "charge" && mode === "rule") setMode("amount"); }} />{value === "discount" ? uiText("Discount") : uiText("Charge")}</label>)}
    </div>
    <label>{uiText("Label (optional)")}<input value={label} maxLength={80} placeholder={kind === "discount" ? uiText("BOGOF, coupon, loyalty…") : uiText("Service, deposit…")} onChange={event => setLabel(event.target.value)} /></label>
    <div className="segmented" role="radiogroup" aria-label={uiText("Amount or percentage")}>
      <label><input type="radio" name={`${formId}-mode`} checked={mode === "amount"} onChange={() => setMode("amount")} />{uiText("Amount")}</label>
      <label><input type="radio" name={`${formId}-mode`} checked={mode === "percent"} onChange={() => { setMode("percent"); setManual(false); }} />{uiText("Percent")}</label>
      {kind === "discount" && <label><input type="radio" name={`${formId}-mode`} checked={mode === "rule"} onChange={() => { setMode("rule"); setManual(false); }} />Offer rule</label>}
    </div>
    {mode === "amount" ? <label>{uiText("Amount")}<input aria-label={uiText("Discount amount")} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amountText}
      onChange={event => { if (parseAmountText(event.target.value)) setAmountText(event.target.value); }} /></label>
      : mode === "percent" ? <label>{uiText("Percent")}<input aria-label={uiText("Discount percent")} inputMode="decimal" autoComplete="off" placeholder="10" value={percentText}
        onChange={event => setPercentText(event.target.value)} /></label> : <div className="offer-rule-fields">
        <label>Offer rule<select value={ruleMode} onChange={event => {
          const key = event.target.value;
          if (key === "custom") setRuleMode("custom");
          else if (key.startsWith("saved:")) {
            const selected = savedOffers.find(offer => offer.name === key.slice(6));
            if (selected) { selectRule(selected, "custom"); setSavedName(selected.name); }
          } else selectRule(builtInOffers[key as keyof typeof builtInOffers], key as keyof typeof builtInOffers);
        }}>
          <option value="custom">Custom rule…</option>
          {Object.entries(builtInOffers).map(([key, offer]) => <option value={key} key={key}>{offer.name}</option>)}
          {savedOffers.filter(offer => !offer.rule.currency || offer.rule.currency === entry.currency).map(offer => <option key={offer.name} value={`saved:${offer.name}`}>{offer.name}</option>)}
        </select></label>
        {ruleMode === "custom" && <div className="offer-fields-row">
          <label>Portions per offer<input type="number" min={1} max={200} placeholder="All selected" value={buy} onChange={event => { setBuy(event.target.value); if (event.target.value) setScopeType("items"); }} /></label>
          <label>Cheapest portions discounted<input type="number" min={1} max={200} placeholder="All qualifying" value={cheapest} onChange={event => setCheapest(event.target.value)} /></label>
          <label>Saving type<select value={benefit} onChange={event => setBenefit(event.target.value as OfferRule["benefit"])}><option value="percent">Percentage off</option><option value="amount">Amount off</option><option value="price">Set price</option></select></label>
        </div>}
        {ruleMode !== "bogof" && <label>{benefit === "percent" ? "Percentage off" : benefit === "amount" ? "Amount off" : "Offer price"}<input inputMode="decimal" value={ruleValue} onChange={event => setRuleValue(event.target.value)} /></label>}
        {ruleMode === "custom" && <div className="offer-fields-row">
          <label>Maximum saving (optional)<input inputMode="decimal" value={cap} onChange={event => setCap(event.target.value)} /></label>
          <label>Maximum uses (optional)<input type="number" min={1} max={200} value={limit} onChange={event => setLimit(event.target.value)} /></label>
        </div>}
        <label>Printed saving (optional)<input inputMode="decimal" placeholder={printedAmount === undefined ? "" : (printedAmount / 100).toFixed(2)} value={printedText} onChange={event => setPrintedText(event.target.value)} /></label>
        {rule && <details><summary>Save this rule for future receipts</summary>
          <label>Rule name<input value={savedName} maxLength={80} onChange={event => { setSavedName(event.target.value); setSaveMessage(""); }} /></label>
          <button type="button" className="quiet" disabled={savingRule || !savedName.trim()} onClick={() => void saveRule(false)}>Save rule</button>
          {savedOffers.some(offer => offer.name.normalize("NFKC").toLowerCase() === savedName.trim().normalize("NFKC").toLowerCase()) && <>
            <button type="button" className="quiet" disabled={savingRule} onClick={() => void saveRule(true)}>Update saved rule</button>
          </>}
          {saveMessage && <p className="footnote" role="status">{saveMessage}</p>}
        </details>}
      </div>}
    <div className="segmented" role="radiogroup" aria-label={uiText("Applies to")}>
      <label><input type="radio" name={`${formId}-scope`} checked={scopeType === "items"} onChange={() => setScopeType("items")} />{uiText("Chosen items")}</label>
      <label><input type="radio" name={`${formId}-scope`} checked={scopeType === "receipt"} onChange={() => { setScopeType("receipt"); setManual(false); }} />{uiText("Whole receipt")}</label>
    </div>
    {scopeType === "items" && <fieldset className="adjustment-items">
      <legend>{uiText("Applies to these items")}</legend>
      {kind === "discount" && existingGroups.length > 0 && <label>Group<select value={group} onChange={event => {
        const letter = event.target.value;
        const existing = existingGroups.find(([key]) => key === letter)?.[1];
        setGroup(letter);
        setItemIds(existing?.itemIds ?? []);
        setPortions(existing?.portions ?? {});
      }}><option value="">New group</option>{existingGroups.map(([letter]) => <option value={letter} key={letter}>Group {letter}</option>)}</select></label>}
      {items.map((item, index) => <div key={item.id}>
        <label><input type="checkbox" checked={itemIds.includes(item.id)} onChange={event => setItemIds(previous => event.target.checked ? [...previous, item.id] : previous.filter(value => value !== item.id))} />
          <span>{item.name || uiText("Item {value0}", { value0: index + 1 })}</span>
          <small>{item.amount === null ? uiText("Unreadable") : money(item.amount, entry.currency)}</small></label>
        {itemIds.includes(item.id) && rule?.buy && !entry.items[index].quantity && <label className="offer-portions">
          <span>Purchased portions</span><input aria-label={`Purchased portions for ${item.name || index + 1}`} type="number" min={1} max={200} placeholder="1" value={purchased[item.id] ?? ""} onChange={event => setPurchased(previous => ({ ...previous, [item.id]: event.target.value }))} />
        </label>}
        {itemIds.includes(item.id) && Number.isSafeInteger(item.quantity?.total) && item.quantity!.total > 1 && <label className="offer-portions">
          <span>Qualifying portions</span><input aria-label={`Qualifying portions for ${item.name || index + 1}`} type="number" min={1} max={Math.min(item.quantity!.total, 200)} value={portions[item.id] ?? item.quantity!.total} onChange={event => {
            const value = Number(event.target.value);
            setPortions(previous => { const next = { ...previous }; if (value === item.quantity!.total) delete next[item.id]; else next[item.id] = value; return next; });
          }} />
        </label>}
      </div>)}
      {(stacking || after?.errors.some(error => error.includes("overlap"))) && <label><input type="checkbox" checked={stacking} onChange={event => setStacking(event.target.checked)} />This offer stacks with the other discount</label>}
    </fieldset>}
    <details open={sharing !== "items" ? true : undefined}><summary>{kind === "discount" ? "Change split" : "Change who pays the charge"}</summary>
      <label>Split method<select value={sharing} onChange={event => setSharing(event.target.value as typeof sharing)}>
        <option value="items">Follow item shares</option>
        {rule?.cheapest && <option value="cheapest">Give saving to discounted portions</option>}
        <option value="equal">Split equally between selected people</option>
        <option value="exact">Set amounts per person</option>
      </select></label>
      {(sharing === "equal" || sharing === "exact") && members.map(member => <div className="offer-person" key={member.id}>
        <label><input type="checkbox" checked={selectedPeople.includes(member.id)} onChange={event => setPeople(event.target.checked ? [...selectedPeople, member.id] : selectedPeople.filter(id => id !== member.id))} />{member.name}</label>
        {sharing === "exact" && selectedPeople.includes(member.id) && <input aria-label={`Amount for ${member.name}`} inputMode="decimal" value={memberAmounts[member.id] ?? ""} onChange={event => setMemberAmounts(previous => ({ ...previous, [member.id]: event.target.value }))} />}
      </div>)}
    </details>
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
      <button type="button" className="primary" disabled={!candidate || !!problem} onClick={() => list && !problem && onSave(list, items)}>{draft.editing ? uiText("Save changes") : uiText("Add")}</button>
      <button type="button" className="quiet" onClick={onCancel}>{uiText("Cancel")}</button>
    </div>
  </fieldset>;
}
