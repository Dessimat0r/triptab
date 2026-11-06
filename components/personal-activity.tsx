"use client";
import { t as uiText } from "@/lib/ui-language";
import { useId, useMemo, useState } from "react";
import { useAccountResource } from "./use-account-resource";
import { X } from "lucide-react";
import ModalA11y from "./modal-accessibility";
import { formatMoney } from "@/lib/money-format";
import { formatCalendarDate } from "@/lib/dates";
import { financialFormatHeaders } from "@/lib/financial-format";
import { peopleSummary, personalActivity, personNames } from "@/lib/personal-activity";
import type { Ledger, Trip } from "@/lib/model";

/**
 * Activity and People across every holiday and bill (F-05, D04), archived
 * ones included unless switched off. Built from trips this account can
 * already read (the open ledger plus its own archive, access-checked by the
 * server); nothing is netted across bills. Archived entries are read-only
 * here: restore the holiday or bill to open it.
 */
export default function PersonalActivity({ ledger, accountId, refreshKey, onClose, onOpen }: {
  ledger: Ledger; accountId: string; refreshKey?: unknown; onClose: () => void; onOpen: (tripId: string, entryId?: string) => void;
}) {
  const id = useId();
  const [tab, setTab] = useState<"activity" | "people">("activity");
  const [search, setSearch] = useState(""), [place, setPlace] = useState(""), [person, setPerson] = useState(""), [direction, setDirection] = useState("");
  const [withArchived, setWithArchived] = useState(true);
  // R02: this account's own archive only, re-read on every refresh so a lost
  // membership disappears while the panel is open.
  const archived = useAccountResource<Trip[]>(accountId, "/api/trip?mode=archived-data",
    body => (body as { trips?: Trip[] } | null)?.trips ?? [], { init: { headers: financialFormatHeaders() }, refreshKey });
  const archivedIds = useMemo(() => new Set((archived ?? []).map(trip => trip.id)), [archived]);
  const all = useMemo<Ledger>(() => withArchived && archived?.length
    ? { trips: [...ledger.trips, ...archived.filter(trip => !ledger.trips.some(open => open.id === trip.id))] } : ledger, [ledger, archived, withArchived]);
  const entries = useMemo(() => personalActivity(all, accountId), [all, accountId]);
  const names = useMemo(() => personNames(all), [all]);
  const people = useMemo(() => peopleSummary(all, accountId), [all, accountId]);
  const trips = new Map(all.trips.map(trip => [trip.id, trip]));
  const isArchived = (tripId: string) => archivedIds.has(tripId) && !ledger.trips.some(trip => trip.id === tripId);
  const peopleInEntries = [...new Set(entries.flatMap(entry => entry.people))].sort((a, b) => (names.get(a) ?? "").localeCompare(names.get(b) ?? ""));
  const query = search.trim().toLocaleLowerCase();
  const shown = entries.filter(entry => (!place || entry.tripId === place) && (!person || entry.people.includes(person))
    && (!direction || entry.direction === direction)
    && (!query || [entry.title, entry.tripName, ...entry.people.map(key => names.get(key) ?? "")].some(text => text.toLocaleLowerCase().includes(query))));
  const money = (amount: number | null | undefined, currency: string) => amount === null || amount === undefined ? uiText("Needs review") : formatMoney(amount, currency);
  return <ModalA11y className="overlay" onClose={onClose}>
    <section className="modal personal-activity" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <div className="modalheading"><h2 id={`${id}-title`}>{uiText("Activity and people")}</h2>
        <button type="button" className="iconbutton" aria-label={uiText("Close")} onClick={onClose}><X /></button></div>
      <div className="segmented" role="tablist" aria-label={uiText("View")}>
        {(["activity", "people"] as const).map(value => <button key={value} type="button" role="tab" aria-selected={tab === value} className={tab === value ? "primary" : "quiet"}
          onClick={() => setTab(value)}>{value === "activity" ? uiText("Activity") : uiText("People")}</button>)}
      </div>
      {tab === "activity" ? <>
        <div className="activity-filters">
          <label>{uiText("Search")}<input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder={uiText("Expense, bill or person")} /></label>
          <label>{uiText("Holiday or bill")}<select value={place} onChange={event => setPlace(event.target.value)}><option value="">{uiText("All")}</option>
            {all.trips.map(trip => <option key={trip.id} value={trip.id}>{trip.name}{isArchived(trip.id) ? uiText(" (archived)") : ""}</option>)}</select></label>
          <label>{uiText("Person")}<select value={person} onChange={event => setPerson(event.target.value)}><option value="">{uiText("Everyone")}</option>
            {peopleInEntries.map(key => <option key={key} value={key}>{names.get(key)}</option>)}</select></label>
          <label>{uiText("Owed or owing")}<select value={direction} onChange={event => setDirection(event.target.value)}><option value="">{uiText("All")}</option>
            <option value="i-owe">{uiText("I owe")}</option><option value="owed-to-me">{uiText("Owed to me")}</option></select></label>
        </div>
        {!!archived?.length && <label className="checklabel"><input type="checkbox" checked={withArchived} onChange={event => { setWithArchived(event.target.checked); setPlace(""); }} />{uiText("Include archived holidays and bills")}</label>}
        {!shown.length ? <p className="footnote">{entries.length ? uiText("Nothing matches these filters.") : uiText("No expenses or payments involve you yet.")}</p>
          : <ul className="activity-list">{shown.map(entry => <li key={`${entry.tripId}:${entry.type}:${entry.id}`}>
            <button type="button" className="activity-row" disabled={isArchived(entry.tripId)} onClick={() => onOpen(entry.tripId, entry.id)}>
              <span><b>{entry.title}</b><small>{entry.tripName} · {entry.tripKind === "bill" ? uiText("Bill") : uiText("Holiday")}{isArchived(entry.tripId) ? uiText(" · Archived") : ""} · {formatCalendarDate(entry.date)}</small>
                {entry.type === "expense" && <small>{entry.paidByMe ? uiText("You paid") : uiText("{value0} paid", { value0: names.get(entry.people[0]) ?? uiText("Someone") })}</small>}
                {entry.type === "payment" && <small>{entry.paidByMe ? uiText("To {value0}", { value0: names.get(entry.people[0]) ?? "" }) : uiText("From {value0}", { value0: names.get(entry.people[0]) ?? "" })}</small>}</span>
              <span className="activity-amount"><b>{money(entry.amount, entry.currency)}</b>
                {entry.type === "expense" && <small>{uiText("Your share ")}{money(entry.myShare, entry.currency)}</small>}</span>
            </button></li>)}</ul>}
      </> : <>
        <p className="footnote">{uiText("Amounts follow each bill's or holiday's suggested settlement. They are shown separately and never combined across bills; settle each one in its own bill.")}</p>
        {!people.length ? <p className="footnote">{uiText("Nobody owes you, and you owe nobody.")}</p> : <ul className="people-list">{people.map(entry => <li key={entry.key}>
          <h3>{entry.name}{entry.linked ? <small>{uiText(" · on TripTab")}</small> : null}</h3>
          {entry.byCurrency.map(line => <div key={line.currency} className="people-currency">
            {line.owesMe > 0 && <p>{uiText("Owes you {value0}", { value0: formatMoney(line.owesMe, line.currency) })}<small>{" · "}{line.owesMeTrips.map(tripId => trips.get(tripId)?.name).join(", ")}</small></p>}
            {line.iOwe > 0 && <p>{uiText("You owe {value0}", { value0: formatMoney(line.iOwe, line.currency) })}<small>{" · "}{line.iOweTrips.map(tripId => trips.get(tripId)?.name).join(", ")}</small></p>}
            <div className="action-row">{[...new Set([...line.owesMeTrips, ...line.iOweTrips])].map(tripId => isArchived(tripId)
              ? <small key={tripId} className="footnote">{uiText("{value0} is archived. Restore it to settle up.", { value0: trips.get(tripId)?.name ?? "" })}</small>
              : <button key={tripId} type="button" className="quiet" onClick={() => onOpen(tripId)}>
              {uiText("Settle up in {value0}", { value0: trips.get(tripId)?.name ?? "" })}</button>)}</div>
          </div>)}
        </li>)}</ul>}
      </>}
    </section>
  </ModalA11y>;
}
