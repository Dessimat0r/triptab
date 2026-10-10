"use client";
import { t as uiText } from "@/lib/ui-language";


import { useId, useState } from "react";
import { X } from "lucide-react";
import ModalA11y from "./modal-accessibility";
import { formatCalendarDate } from "@/lib/dates";
import { repeatExpense } from "@/lib/trip-insights";
import type { Expense, Trip } from "@/lib/model";

/** Copy a saved expense onto following days, such as a nightly room charge or daily parking. */
export default function RepeatExpenseDialog({ trip, expense, busy, onClose, onRepeat }: {
  trip: Trip; expense: Expense; busy: boolean; onClose: () => void;
  onRepeat: (copies: Expense[]) => Promise<boolean>;
}) {
  const id = useId();
  const untilDefault = trip.endDate && trip.endDate > expense.date ? trip.endDate : "";
  const [mode, setMode] = useState<"times" | "until">(untilDefault ? "until" : "times");
  const [times, setTimes] = useState("1");
  const [until, setUntil] = useState(untilDefault);
  const [every, setEvery] = useState("1");
  const [error, setError] = useState("");
  const step = Number(every);
  const count = mode === "times" ? Number(times)
    : until && until > expense.date && step >= 1 ? Math.floor((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${expense.date}T00:00:00Z`)) / 86_400_000 / step) : 0;
  let preview: Expense[] = [];
  try { preview = Number.isSafeInteger(count) && count >= 1 && count <= 60 ? repeatExpense(expense, count, () => crypto.randomUUID(), { everyDays: step }) : []; }
  catch { preview = []; }
  const room = 1000 - trip.expenses.length;
  return <ModalA11y className="overlay" onClose={onClose}>
    <section className="modal small" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <div className="modalheading">
        <div><span className="eyebrow">{uiText("REPEAT EXPENSE")}</span><h2 id={`${id}-title`}>{uiText("Repeat “")}{expense.title}”</h2></div>
        <button type="button" className="iconbutton" aria-label={uiText("Close")} onClick={onClose}><X aria-hidden="true" /></button>
      </div>
      <p className="footnote">{uiText("Adds copies of the saved expense with the same amount, payer and split on later days. Current traveller weights and rounding apply. Receipt photos and chats are not copied.")}</p>
      <form className="repeat-expense-form" onSubmit={async event => {
        event.preventDefault();
        setError("");
        if (!preview.length) { setError("Choose between 1 and 60 repeats."); return; }
        if (preview.length > room) { setError(uiText("This holiday has room for {count} more expenses.", { count: room })); return; }
        if (await onRepeat(preview)) onClose();
      }}>
        <fieldset>
          <legend>{uiText("How long")}</legend>
          <label><input type="radio" name={`${id}-mode`} checked={mode === "until"} onChange={() => setMode("until")} />{uiText(" Until a date")}</label>
          <label><input type="radio" name={`${id}-mode`} checked={mode === "times"} onChange={() => setMode("times")} />{uiText(" A number of times")}</label>
        </fieldset>
        {mode === "until" ? <label htmlFor={`${id}-until`}>{uiText("Last date")}<input id={`${id}-until`} type="date" value={until} min={expense.date} onChange={event => setUntil(event.target.value)} required />
        </label> : <label htmlFor={`${id}-times`}>{uiText("Number of copies")}<input id={`${id}-times`} type="number" inputMode="numeric" min={1} max={60} value={times} onChange={event => setTimes(event.target.value)} required />
        </label>}
        <label htmlFor={`${id}-every`}>{uiText("Every")}<select id={`${id}-every`} value={every} onChange={event => setEvery(event.target.value)}>
            <option value="1">{uiText("day")}</option><option value="2">{uiText("2 days")}</option><option value="7">{uiText("week")}</option>
          </select>
        </label>
        <p className="footnote" role="status">{preview.length
          ? preview.length === 1 ? uiText("1 copy: {date}.", { date: formatCalendarDate(preview[0].date) }) : uiText("{count} copies: {first} to {last}.", { count: preview.length, first: formatCalendarDate(preview[0].date), last: formatCalendarDate(preview.at(-1)!.date) })
          : uiText("No copies with these settings.")}</p>
        {error && <p className="error" role="alert">{uiText(error)}</p>}
        <button type="submit" className="primary wide" disabled={busy || !preview.length}>{busy ? uiText("Saving…") : uiText(preview.length === 1 ? "Add {count} copy" : "Add {count} copies", { count: preview.length })}</button>
      </form>
    </section>
  </ModalA11y>;
}
