"use client";
import { t as uiText } from "@/lib/ui-language";


import { useEffect, useId, useRef, useState } from "react";
import PagedList from "./paged-list";
import { Check } from "lucide-react";
import { validCalendarDate } from "@/lib/dates";
import { TripReceiptLanguage } from "@/components/receipt-language-select";
import { receiptLanguageSchema } from "@/lib/receipt-languages";
import type { Trip } from "@/lib/model";

export type TripDetailsProps = {
  trip: Trip;
  paging: { shown: number; step: number; onMore: () => void };
  accountId?: string;
  busy: boolean;
  error?: string;
  onSave: (next: Trip) => Promise<boolean>;
};

type Member = Trip["members"][number];

/** Budget text in hundredths; undefined when empty and null when unreadable. */
export function parseBudget(text: string): number | undefined | null {
  const value = text.trim().replace(",", ".");
  if (!value) return undefined;
  if (!/^\d+(\.\d{0,2})?$/.test(value)) return null;
  const hundredths = Math.round(Number(value) * 100);
  return Number.isSafeInteger(hundredths) && hundredths > 0 && hundredths <= 100000000 ? hundredths : null;
}

function TravellerName({ trip, member, index, busy, onSave }: {
  trip: Trip; member: Member; index: number; busy: boolean; onSave: TripDetailsProps["onSave"];
}) {
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const value = draft ?? member.name;
  const locked = busy || submitting;
  const form = useRef<HTMLFormElement>(null), input = useRef<HTMLInputElement>(null);
  // Saving disables the row and a saved name removes Save, so focus would fall to
  // <body>. Return it to the name field once the row is editable again.
  const refocus = useRef(false);
  useEffect(() => { if (refocus.current && !locked) { refocus.current = false; input.current?.focus(); } });
  return <form ref={form} className="traveller-name-form" data-entry-id={member.id} tabIndex={-1} onSubmit={async event => {
    event.preventDefault();
    if (locked) return;
    refocus.current = !!form.current?.contains(document.activeElement);
    setError("");
    setSaved(false);
    const name = value.trim();
    if (!name || name.length > 50) { setError("Enter a traveller name between 1 and 50 characters."); return; }
    if (trip.members.some(person => person.id !== member.id && person.name.trim().toLowerCase() === name.toLowerCase())) {
      setError("Each traveller needs a different name. Add a surname or nickname."); return;
    }
    if (name === member.name) { setDraft(null); setSaved(true); return; }
    setSubmitting(true);
    try {
      const next = { ...trip, members: trip.members.map(person => person.id === member.id ? { ...person, name } : person) };
      if (await onSave(next)) { setDraft(null); setSaved(true); }
      else setError("Unable to save this traveller name. Your edit is still here; try again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save this traveller name. Your edit is still here.");
    } finally { setSubmitting(false); }
  }}>
    <span className={`avatar color${index % 5}`} aria-hidden="true">{member.name.slice(0, 1).toUpperCase()}</span>
    <div className="traveller-name-fields">
      <label htmlFor={`${id}-name`}>{uiText("Traveller ")}{index + 1}{uiText(" name")}<input ref={input} id={`${id}-name`} value={value} required maxLength={50} disabled={locked} autoComplete="off" aria-describedby={`${id}-account${error ? " " + id + "-error" : ""}`} onChange={event => {
          setDraft(event.target.value); setError(""); setSaved(false);
        }} />
      </label>
      <p id={`${id}-account`} className="traveller-account-note">{member.userId ? uiText("Account connected") : uiText("Not linked to an account")}{member.email ? ` · ${member.email}` : ""}</p>
      {error && <p id={`${id}-error`} className="trip-details-error" role="alert">{uiText(error)}</p>}
      {saved && <p className="trip-details-success" role="status"><Check size={15} aria-hidden="true" />{uiText(" Traveller name saved.")}</p>}
    </div>
    {(value.trim() !== member.name || submitting || error) && <button type="submit" className="quiet" disabled={locked || value.trim() === member.name} aria-label={uiText("Save traveller {value0} name", { value0: index + 1 })}>{submitting ? uiText("Saving…") : uiText("Save")}</button>}
  </form>;
}

function TripDetailsForm({ trip, paging, accountId, busy, error: externalError, onSave }: TripDetailsProps) {
  const id = useId();
  const [draft, setDraft] = useState<Partial<{ name: string; startDate: string; endDate: string; receiptLanguage: string; budget: string }>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const locked = busy || submitting;
  const values = { name: draft.name ?? trip.name, startDate: draft.startDate ?? trip.startDate ?? "", endDate: draft.endDate ?? trip.endDate ?? "", receiptLanguage: draft.receiptLanguage ?? trip.receiptLanguage ?? "auto",
    budget: draft.budget ?? (trip.budget ? (trip.budget / 100).toFixed(2) : "") };
  const parsedBudget = parseBudget(values.budget);
  const changed = values.name.trim() !== trip.name || values.startDate !== (trip.startDate || "") || values.endDate !== (trip.endDate || "") || values.receiptLanguage !== (trip.receiptLanguage || "auto") || parsedBudget !== (trip.budget ?? undefined);
  function change(field: keyof typeof values, value: string) {
    setDraft(previous => ({ ...previous, [field]: value })); setError(""); setSaved(false);
  }
  return <section className="panel trip-details-panel" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>{uiText("Holiday details")}</h3>
    <p className="footnote">{uiText("Travellers in this holiday can update its name, dates, budget and display names.")}</p>
    <form className="holiday-details-form" onSubmit={async event => {
      event.preventDefault();
      if (locked) return;
      setError(""); setSaved(false);
      const name = values.name.trim();
      if (!name || name.length > 100) { setError("Enter a holiday name between 1 and 100 characters."); return; }
      if (values.startDate && !validCalendarDate(values.startDate)) { setError("Enter a valid holiday start date."); return; }
      if (values.endDate && !validCalendarDate(values.endDate)) { setError("Enter a valid holiday end date."); return; }
      if (values.startDate && values.endDate && values.endDate < values.startDate) { setError("The end date must be on or after the start date."); return; }
      const next: Trip = { ...trip, name };
      if (values.receiptLanguage !== (trip.receiptLanguage || "auto")) next.receiptLanguage = receiptLanguageSchema.parse(values.receiptLanguage);
      if (values.startDate) next.startDate = values.startDate; else delete next.startDate;
      if (values.endDate) next.endDate = values.endDate; else delete next.endDate;
      if (parsedBudget === null) { setError("Enter the budget as an amount such as 1500 or 1500.00, or leave it empty."); return; }
      if (parsedBudget) next.budget = parsedBudget; else delete next.budget;
      setSubmitting(true);
      try {
        if (await onSave(next)) { setDraft({}); setSaved(true); }
        else setError("Unable to save the holiday details. Your edits are still here; try again.");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to save the holiday details. Your edits are still here.");
      } finally { setSubmitting(false); }
    }}>
      <label htmlFor={`${id}-name`}>{uiText("Holiday name")}<input id={`${id}-name`} value={values.name} required maxLength={100} disabled={locked} onChange={event => change("name", event.target.value)} />
      </label>
      <div className="fieldpair holiday-dates">
        <label htmlFor={`${id}-start`}>{uiText("Start date (optional)")}<input id={`${id}-start`} type="date" value={values.startDate} max={values.endDate || undefined} disabled={locked} onChange={event => change("startDate", event.target.value)} />
        </label>
        <label htmlFor={`${id}-end`}>{uiText("End date (optional)")}<input id={`${id}-end`} type="date" value={values.endDate} min={values.startDate || undefined} disabled={locked} onChange={event => change("endDate", event.target.value)} />
        </label>
      </div>
      <label htmlFor={`${id}-budget`}>{uiText("Group budget in ")}{trip.currency}{uiText(" (optional)")}<input id={`${id}-budget`} inputMode="decimal" autoComplete="off" value={values.budget} disabled={locked} placeholder={uiText("e.g. 2000")} onChange={event => change("budget", event.target.value)} />
      </label>
      <TripReceiptLanguage value={receiptLanguageSchema.parse(values.receiptLanguage)} onChange={value=>change("receiptLanguage",value)} destination={()=>values.name} busy={locked} accountId={accountId} tripId={trip.id} />
      {(error || externalError) && <p className="error" role="alert">{externalError || uiText(error)}</p>}
      <div className="holiday-details-actions">
        <button type="submit" className="primary phone-wide" disabled={locked || !changed}>{submitting ? uiText("Saving…") : uiText("Save holiday details")}</button>
        {saved && <p className="trip-details-success" role="status"><Check size={15} aria-hidden="true" />{uiText(" Holiday details saved.")}</p>}
      </div>
    </form>
    <p className="footnote">{uiText("Settle in ")}{trip.currency}{uiText(". Each expense keeps its original currency and transaction time. Saved expenses and payments keep the same traveller assignments when a display name changes.")}</p>
    <div className="trip-traveller-names">
      <h3>{uiText("Traveller display names")}</h3>
      <p className="footnote">{uiText("These labels belong to this holiday. Connected accounts and personal profiles keep their identities.")}</p>
      <PagedList {...paging} noun={uiText("traveller names")} items={trip.members} itemKey={member => member.id}
        renderItem={(member, index) => <TravellerName key={member.id} trip={trip} member={member} index={index} busy={locked} onSave={onSave} />} />
    </div>
  </section>;
}

export default function TripDetails(props: TripDetailsProps) {
  return <TripDetailsForm key={props.trip.id} {...props} />;
}
