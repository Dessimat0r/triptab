"use client";
import { t as uiText } from "@/lib/ui-language";
import { useId, useMemo, useState } from "react";
import { X } from "lucide-react";
import ModalA11y from "./modal-accessibility";
import { formatMoney } from "@/lib/money-format";
import { formatCalendarDate } from "@/lib/dates";
import { peopleSummary, personalActivity, personNames } from "@/lib/personal-activity";
import type { Ledger } from "@/lib/model";

/**
 * Activity and People across every open holiday and bill (F-05, D04).
 * Built from the ledger this account can already read; nothing is fetched
 * from other accounts and nothing is netted across bills.
 */
export default function PersonalActivity({ ledger, accountId, onClose, onOpen }: {
  ledger: Ledger; accountId: string; onClose: () => void; onOpen: (tripId: string, entryId?: string) => void;
}) {
  const id = useId();
  const [tab, setTab] = useState<"activity" | "people">("activity");
  const [search, setSearch] = useState(""), [place, setPlace] = useState(""), [person, setPerson] = useState(""), [direction, setDirection] = useState("");
  const entries = useMemo(() => personalActivity(ledger, accountId), [ledger, accountId]);
  const names = useMemo(() => personNames(ledger), [ledger]);
  const people = useMemo(() => peopleSummary(ledger, accountId), [ledger, accountId]);
  const trips = new Map(ledger.trips.map(trip => [trip.id, trip]));
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
            {ledger.trips.map(trip => <option key={trip.id} value={trip.id}>{trip.name}</option>)}</select></label>
          <label>{uiText("Person")}<select value={person} onChange={event => setPerson(event.target.value)}><option value="">{uiText("Everyone")}</option>
            {peopleInEntries.map(key => <option key={key} value={key}>{names.get(key)}</option>)}</select></label>
          <label>{uiText("Owed or owing")}<select value={direction} onChange={event => setDirection(event.target.value)}><option value="">{uiText("All")}</option>
            <option value="i-owe">{uiText("I owe")}</option><option value="owed-to-me">{uiText("Owed to me")}</option></select></label>
        </div>
        {!shown.length ? <p className="footnote">{entries.length ? uiText("Nothing matches these filters.") : uiText("No expenses or payments involve you yet.")}</p>
          : <ul className="activity-list">{shown.map(entry => <li key={`${entry.tripId}:${entry.type}:${entry.id}`}>
            <button type="button" className="activity-row" onClick={() => onOpen(entry.tripId, entry.id)}>
              <span><b>{entry.title}</b><small>{entry.tripName} · {entry.tripKind === "bill" ? uiText("Bill") : uiText("Holiday")} · {formatCalendarDate(entry.date)}</small>
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
            <div className="action-row">{[...new Set([...line.owesMeTrips, ...line.iOweTrips])].map(tripId => <button key={tripId} type="button" className="quiet" onClick={() => onOpen(tripId)}>
              {uiText("Settle up in {value0}", { value0: trips.get(tripId)?.name ?? "" })}</button>)}</div>
          </div>)}
        </li>)}</ul>}
      </>}
    </section>
  </ModalA11y>;
}
