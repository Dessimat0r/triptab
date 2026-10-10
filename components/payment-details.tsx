"use client";

import { useEffect, useId, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import PagedList from "./paged-list";
import { formatMoney as money } from "@/lib/money-format";
import { hasPaymentDetails, MAX_BANK_DETAILS, normalisePaymentHandle, PAYMENT_METHODS, paymentLinks, type PayTo, type PaymentMethodKey } from "@/lib/payment-links";
import type { Currency, Trip } from "@/lib/model";
import "./payment-details.css";

type Member = Trip["members"][number];

/** Only the linked account edits its own traveller; anyone may fill in an unlinked traveller. */
export function canEditPaymentDetails(member: Member, accountId?: string): boolean {
  return !member.userId || member.userId === accountId;
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { return false; }
}

/** One-tap ways to pay a settlement. Opening a link never records a payment. */
export function SettlementPayActions({ payee, amount, currency, reference }: {
  payee: Member; amount: number; currency: Currency; reference: string;
}) {
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(""), 4000);
    return () => clearTimeout(timer);
  }, [status]);
  if (!hasPaymentDetails(payee.payTo)) return null;
  const links = paymentLinks(payee.payTo, amount, currency, reference);
  const formatted = money(amount, currency);
  const copy = async (text: string, label: string) => setStatus(await copyText(text) ? `${label} copied.` : `Copy is unavailable here. Select the ${label.toLowerCase()} to copy it.`);
  const manual = links.filter(link => !link.withAmount).map(link => link.label);
  return <div className="settlement-pay" role="group" aria-label={`Ways to pay ${payee.name}`}>
    <div className="settlement-pay-actions">
      {links.map(link => <a key={link.key} className="quiet" href={link.href} target="_blank" rel="noopener noreferrer"
        aria-label={link.withAmount ? `Pay ${payee.name} ${formatted} with ${link.label} (opens ${link.label})` : `Open ${payee.name}’s ${link.label} page (opens ${link.label}; enter ${formatted})`}>
        {link.label}<ExternalLink size={14} aria-hidden="true" />
      </a>)}
      <button type="button" className="quiet" onClick={() => void copy((amount / 100).toFixed(2), "Amount")}><Copy size={14} aria-hidden="true" />Copy amount</button>
      {payee.payTo.bank && <button type="button" className="quiet" onClick={() => void copy(payee.payTo!.bank!, "Bank details")}><Copy size={14} aria-hidden="true" />Copy bank details</button>}
    </div>
    {payee.payTo.bank && <small className="settlement-bank">Bank details: <span>{payee.payTo.bank}</span></small>}
    {manual.length > 0 && <small className="settlement-pay-note">{manual.join(" and ")} {manual.length === 1 ? "opens" : "open"} {payee.name}’s page; enter {formatted} there.</small>}
    <small className="settlement-pay-status" role="status">{status}</small>
  </div>;
}

type Draft = Record<PaymentMethodKey | "bank", string>;
const emptyDraft = (payTo?: PayTo): Draft => ({ paypal: payTo?.paypal ?? "", monzo: payTo?.monzo ?? "", revolut: payTo?.revolut ?? "", wise: payTo?.wise ?? "", bank: payTo?.bank ?? "" });

function PaymentDetailsRow({ trip, member, index, accountId, busy, onSave }: {
  trip: Trip; member: Member; index: number; accountId?: string; busy: boolean; onSave: (next: Trip) => Promise<boolean>;
}) {
  const id = useId();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const editable = canEditPaymentDetails(member, accountId);
  const own = !!accountId && member.userId === accountId;
  const locked = busy || submitting;
  const methods = PAYMENT_METHODS.filter(method => member.payTo?.[method.key]);
  async function save() {
    if (!draft) return;
    const nextErrors: typeof errors = {}, payTo: PayTo = {};
    for (const method of PAYMENT_METHODS) {
      const value = normalisePaymentHandle(method.key, draft[method.key]);
      if (value === null) nextErrors[method.key] = `Enter a ${method.label} username, such as ${method.example}.`;
      else if (value) payTo[method.key] = value;
    }
    const bank = draft.bank.trim();
    if (bank.length > MAX_BANK_DETAILS) nextErrors.bank = `Use at most ${MAX_BANK_DETAILS} characters.`;
    else if (bank) payTo.bank = bank;
    setErrors(nextErrors); setError(""); setSaved(false);
    if (Object.keys(nextErrors).length) return;
    const next: Trip = { ...trip, members: trip.members.map(person => {
      if (person.id !== member.id) return person;
      const updated = { ...person };
      if (hasPaymentDetails(payTo)) updated.payTo = payTo; else delete updated.payTo;
      return updated;
    }) };
    setSubmitting(true);
    try {
      if (await onSave(next)) { setDraft(null); setSaved(true); }
      else setError("Unable to save these payment details. Your edits are still here; try again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save these payment details.");
    } finally { setSubmitting(false); }
  }
  return <div className="payment-details-row" data-entry-id={member.id} tabIndex={-1}>
    <div className="payment-details-heading">
      <span className={`avatar color${index % 5}`} aria-hidden="true">{member.name.slice(0, 1).toUpperCase()}</span>
      <div className="payment-details-identity">
        <b>{member.name}{own ? " (you)" : ""}</b>
        <small>{hasPaymentDetails(member.payTo)
          ? [...methods.map(method => `${method.label} ${member.payTo![method.key]}`), ...(member.payTo.bank ? ["Bank details"] : [])].join(" · ")
          : "No payment details yet"}</small>
        {!editable && <small>Only {member.name} can change these.</small>}
      </div>
      {editable && !draft && <button type="button" className="quiet" disabled={locked} aria-label={`${hasPaymentDetails(member.payTo) ? "Edit" : "Add"} payment details for ${member.name}`}
        onClick={() => { setDraft(emptyDraft(member.payTo)); setErrors({}); setError(""); setSaved(false); }}>
        {hasPaymentDetails(member.payTo) ? "Edit" : "Add"}
      </button>}
    </div>
    {saved && <p className="trip-details-success" role="status"><Check size={15} aria-hidden="true" /> Payment details saved.</p>}
    {draft && <form className="payment-details-form" onSubmit={event => { event.preventDefault(); if (!locked) void save(); }}>
      <div className="payment-details-fields">
        {PAYMENT_METHODS.map(method => <label key={method.key} htmlFor={`${id}-${method.key}`}>{method.label} username
          <input id={`${id}-${method.key}`} value={draft[method.key]} maxLength={80} autoComplete="off" autoCapitalize="none" spellCheck={false}
            placeholder={method.example} disabled={locked} aria-invalid={!!errors[method.key]} aria-describedby={errors[method.key] ? `${id}-${method.key}-error` : undefined}
            onChange={event => { setDraft({ ...draft, [method.key]: event.target.value }); setErrors({ ...errors, [method.key]: undefined }); }} />
          {errors[method.key] && <span id={`${id}-${method.key}-error`} className="trip-details-error">{errors[method.key]}</span>}
        </label>)}
      </div>
      <label htmlFor={`${id}-bank`}>Bank details (optional)
        <textarea id={`${id}-bank`} rows={2} value={draft.bank} maxLength={MAX_BANK_DETAILS} disabled={locked} placeholder="Name, IBAN or sort code and account number"
          aria-invalid={!!errors.bank} onChange={event => { setDraft({ ...draft, bank: event.target.value }); setErrors({ ...errors, bank: undefined }); }} />
        {errors.bank && <span className="trip-details-error">{errors.bank}</span>}
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="payment-details-actions">
        <button type="submit" className="primary" disabled={locked}>{submitting ? "Saving…" : "Save payment details"}</button>
        <button type="button" className="quiet" disabled={submitting} onClick={() => { setDraft(null); setErrors({}); setError(""); }}>Cancel</button>
      </div>
    </form>}
  </div>;
}

export default function PaymentDetailsPanel({ trip, accountId, busy, paging, onSave }: {
  trip: Trip; accountId?: string; busy: boolean;
  paging: { shown: number; step: number; onMore: () => void };
  onSave: (next: Trip) => Promise<boolean>;
}) {
  const id = useId();
  return <section id="payment-details" className="panel payment-details-panel" aria-labelledby={`${id}-heading`} tabIndex={-1}>
    <h3 id={`${id}-heading`}>How to pay each traveller</h3>
    <p className="footnote">Add a PayPal, Monzo, Revolut or Wise username, or bank details, so others can pay you from Settle up. Everyone on this holiday can see them and changes stay in its history. A traveller connected to an account can only be changed by that account.</p>
    <PagedList {...paging} noun="payment details" items={trip.members} itemKey={member => member.id}
      renderItem={(member, index) => <PaymentDetailsRow key={member.id} trip={trip} member={member} index={index} accountId={accountId} busy={busy} onSave={onSave} />} />
  </section>;
}
