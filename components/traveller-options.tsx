"use client";
import { t as uiText } from "@/lib/ui-language";


import { useId, useState } from "react";
import { Check, UserMinus } from "lucide-react";
import PagedList from "./paged-list";
import { validCalendarDate } from "@/lib/dates";
import { memberRemovalBlocker, removeMember } from "@/lib/trip-insights";
import type { Trip } from "@/lib/model";
import "./traveller-options.css";

type Member = Trip["members"][number];
type Confirm = (options: { title: string; message: string; confirmLabel: string; cancelLabel?: string; destructive?: boolean }) => Promise<boolean>;

function TravellerRow({ trip, member, busy, onSave, confirm }: {
  trip: Trip; member: Member; busy: boolean; onSave: (next: Trip) => Promise<boolean>; confirm: Confirm;
}) {
  const id = useId();
  const [draft, setDraft] = useState<{ weight?: string; joinedOn?: string; leftOn?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<{ error?: string; saved?: string }>({});
  const values = {
    weight: draft.weight ?? String(member.weight ?? 1),
    joinedOn: draft.joinedOn ?? member.joinedOn ?? "",
    leftOn: draft.leftOn ?? member.leftOn ?? "",
  };
  const changed = values.weight !== String(member.weight ?? 1) || values.joinedOn !== (member.joinedOn ?? "") || values.leftOn !== (member.leftOn ?? "");
  const locked = busy || submitting;
  const removalBlocker = memberRemovalBlocker(trip, member.id);
  const change = (field: keyof typeof values, value: string) => { setDraft(previous => ({ ...previous, [field]: value })); setMessage({}); };
  async function persist(next: Trip, saved: string) {
    setSubmitting(true);
    try {
      if (await onSave(next)) { setDraft({}); setMessage({ saved }); }
      else setMessage({ error: "Unable to save. Your changes are still here; try again." });
    } finally { setSubmitting(false); }
  }
  return <form className="traveller-options-row" data-entry-id={member.id} tabIndex={-1} onSubmit={event => {
    event.preventDefault();
    if (locked) return;
    const weight = Number(values.weight);
    if (!Number.isInteger(weight) || weight < 1 || weight > 20) { setMessage({ error: "Count each traveller as between 1 and 20 people." }); return; }
    if (values.joinedOn && !validCalendarDate(values.joinedOn)) { setMessage({ error: "Enter a valid joining date." }); return; }
    if (values.leftOn && !validCalendarDate(values.leftOn)) { setMessage({ error: "Enter a valid leaving date." }); return; }
    if (values.joinedOn && values.leftOn && values.leftOn < values.joinedOn) { setMessage({ error: "The leaving date must be on or after the joining date." }); return; }
    const next: Member = { ...member };
    if (weight > 1) next.weight = weight; else delete next.weight;
    if (values.joinedOn) next.joinedOn = values.joinedOn; else delete next.joinedOn;
    if (values.leftOn) next.leftOn = values.leftOn; else delete next.leftOn;
    void persist({ ...trip, members: trip.members.map(person => person.id === member.id ? next : person) }, `${member.name}’s details saved.`);
  }}>
    <b className="traveller-options-name">{member.name}</b>
    <div className="traveller-options-fields">
      <label htmlFor={`${id}-weight`}>{uiText("Counts as")}<select id={`${id}-weight`} value={values.weight} disabled={locked} onChange={event => change("weight", event.target.value)}>
          {Array.from({ length: 20 }, (_, index) => <option key={index} value={String(index + 1)}>{index + 1} {index ? "people" : "person"}</option>)}
        </select>
      </label>
      <label htmlFor={`${id}-joined`}>{uiText("Joined on")}<input id={`${id}-joined`} type="date" value={values.joinedOn} min={trip.startDate} max={values.leftOn || trip.endDate} disabled={locked} onChange={event => change("joinedOn", event.target.value)} />
      </label>
      <label htmlFor={`${id}-left`}>{uiText("Left on")}<input id={`${id}-left`} type="date" value={values.leftOn} min={values.joinedOn || trip.startDate} max={trip.endDate} disabled={locked} onChange={event => change("leftOn", event.target.value)} />
      </label>
    </div>
    <div className="traveller-options-actions">
      {changed && <button type="submit" className="quiet" disabled={locked}>{submitting ? "Saving…" : "Save"}</button>}
      <button type="button" className="quiet" disabled={locked} onClick={async () => {
        if (removalBlocker) { setMessage({ error: removalBlocker }); return; }
        if (!await confirm({ title: `Remove ${member.name}?`, message: `${member.name} isn’t in any expense or payment, so removing them changes no amounts. Their removal will appear in activity history.`, confirmLabel: "Remove traveller", destructive: true })) return;
        await persist(removeMember(trip, member.id), `${member.name} was removed.`);
      }}><UserMinus size={16} aria-hidden="true" />{uiText(" Remove")}</button>
    </div>
    {message.error && <p className="trip-details-error" role="alert">{message.error}</p>}
    {message.saved && <p className="trip-details-success" role="status"><Check size={15} aria-hidden="true" /> {message.saved}</p>}
  </form>;
}

/** Weights for couples or families, joining and leaving dates, and safe removal. */
export default function TravellerOptions({ trip, busy, paging, onSave, confirm }: {
  trip: Trip; busy: boolean; paging: { shown: number; step: number; onMore: () => void };
  onSave: (next: Trip) => Promise<boolean>; confirm: Confirm;
}) {
  const id = useId();
  return <section className="panel traveller-options" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>{uiText("Who shares what")}</h3>
    <p className="footnote">{uiText("“Counts as” gives a couple or family more than one share when an expense is split equally, for expenses added or edited from now on. Joining and leaving dates choose who is ticked by default on new expenses; nobody’s existing shares change.")}</p>
    <PagedList {...paging} noun="travellers" items={trip.members} itemKey={member => member.id}
      renderItem={member => <TravellerRow key={member.id} trip={trip} member={member} busy={busy} onSave={onSave} confirm={confirm} />} />
  </section>;
}
