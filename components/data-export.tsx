"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Download } from "lucide-react";
import type { Trip } from "@/lib/model";
import "./data-export.css";

export type DataExportProps = {
  trips?: Pick<Trip, "id" | "name">[];
  tripId?: string;
  compact?: boolean;
};

export default function DataExport({ trips = [], tripId, compact = false }: DataExportProps) {
  const id = useId();
  const [choice, setChoice] = useState(tripId || "");
  const selectedTrip = choice || tripId || trips[0]?.id || "";
  const [receipts, setReceipts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [history, setHistory] = useState<{ tripId: string; nextCursor: number | null } | null>(null);
  const [accountHistoryCursor, setAccountHistoryCursor] = useState<number | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, []);

  async function download(scope: "account" | "trip" | "activity" | "account-activity", format: "json" | "csv", older = false) {
    if (busy || ((scope === "trip" || scope === "activity") && !selectedTrip)) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const params = new URLSearchParams({ scope, format });
      if (scope === "trip" || scope === "activity") params.set("tripId", selectedTrip);
      if (scope === "trip" && format === "json" && receipts) params.set("receipts", "1");
      if (scope === "activity" && older && history?.tripId === selectedTrip && history.nextCursor !== null) params.set("before", String(history.nextCursor));
      if (scope === "account-activity" && older && accountHistoryCursor !== null) params.set("before", String(accountHistoryCursor));
      const response = await fetch(`/api/export?${params}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error || "Unable to download your data. Try again.");
      }
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const suppliedName = response.headers.get("content-disposition")?.match(/filename="([a-zA-Z0-9._-]+)"/)?.[1];
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = suppliedName || `triptab-${scope}.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
      if (scope === "activity" || scope === "account-activity") {
        const cursor = response.headers.get("x-export-next-cursor");
        const nextCursor = cursor && /^[1-9]\d*$/.test(cursor) && Number.isSafeInteger(Number(cursor)) ? Number(cursor) : null;
        if (scope === "activity") setHistory({ tripId: selectedTrip, nextCursor });
        else setAccountHistoryCursor(nextCursor);
        setStatus(nextCursor === null ? "History downloaded. There are no older changes." : "History page downloaded. Download older changes to continue.");
      } else setStatus("Your download is ready.");
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to download your data.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <section className={`account-section data-export${compact ? " compact" : ""}`} aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`}>Download your data</h3>
    <p className="footnote">Keep a copy of your profile and holidays you can currently access, including shared records. Photos and sign-in credentials are excluded.</p>
    <div className="data-export-actions">
      <button type="button" className="quiet" disabled={busy} onClick={() => download("account", "json")}><Download size={17} aria-hidden="true" />Account JSON</button>
      {!compact && <>
        <button type="button" className="quiet" disabled={busy} onClick={() => download("account-activity", "json")}><Download size={17} aria-hidden="true" />Account history JSON</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => download("account-activity", "csv")}><Download size={17} aria-hidden="true" />Account history CSV</button>
        {accountHistoryCursor !== null && <button type="button" className="quiet" disabled={busy} onClick={() => download("account-activity", "csv", true)}><Download size={17} aria-hidden="true" />Older account history CSV</button>}
      </>}
    </div>
    {(trips.length > 0 || tripId) && <>
      {trips.length > 1 ? <label htmlFor={`${id}-trip`}>Holiday
        <select id={`${id}-trip`} value={selectedTrip} disabled={busy} onChange={event => { setChoice(event.target.value); setHistory(null); setStatus(""); setError(""); }}>
          {trips.map(trip => <option key={trip.id} value={trip.id}>{trip.name}</option>)}
        </select>
      </label> : <p className="footnote">{trips.find(trip => trip.id === selectedTrip)?.name || "This holiday"}</p>}
      <label className="checklabel" htmlFor={`${id}-receipts`}>
        <input id={`${id}-receipts`} type="checkbox" checked={receipts} disabled={busy} onChange={event => setReceipts(event.target.checked)} />Include attached receipt details in holiday JSON
      </label>
      <div className="data-export-actions">
        <button type="button" className="quiet" disabled={busy || !selectedTrip} onClick={() => download("trip", "json")}><Download size={17} aria-hidden="true" />Holiday JSON</button>
        <button type="button" className="quiet" disabled={busy || !selectedTrip} onClick={() => download("trip", "csv")}><Download size={17} aria-hidden="true" />Expenses & payments CSV</button>
        <button type="button" className="quiet" disabled={busy || !selectedTrip} onClick={() => download("activity", "csv")}><Download size={17} aria-hidden="true" />Latest history CSV</button>
        {history?.tripId === selectedTrip && history.nextCursor !== null && <button type="button" className="quiet" disabled={busy} onClick={() => download("activity", "csv", true)}><Download size={17} aria-hidden="true" />Older history CSV</button>}
      </div>
      <p className="footnote">JSON keeps item splits, receipt conversations and drafts. Financial CSV contains posted expenses and payments. History downloads arrive in pages of up to 50 changes.</p>
    </>}
    {busy && <p role="status">Preparing your download…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {status && <p role="status" aria-live="polite">{status}</p>}
  </section>;
}
