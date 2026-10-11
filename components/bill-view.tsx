'use client';
import { useMemo, useSyncExternalStore, useState, type ReactNode } from 'react';
import { travellerFinancialPreview, type Trip } from '@/lib/model';
import { formatMoney as money } from '@/lib/money-format';
import { t as uiText } from '@/lib/ui-language';
import { billSummaryText } from './trip-summary';
import { SettlementPayActions } from './payment-details';
import './bills.css';

const subscribeCapabilities = () => () => {};

export default function BillView({ trip, receipts, payments, calculationError, due, busy, onStatement, onPayment, onArchive }: {
  trip: Trip; receipts: ReactNode; payments: ReactNode; calculationError: string; due: { from: string; to: string; amount: number }[]; busy: boolean;
  onStatement: (memberId: string) => void; onPayment: (suggestion?: { from: string; to: string; amount: number }) => void; onArchive: () => Promise<void>;
}) {
  const previews = useMemo(() => trip.members.map(member => travellerFinancialPreview(trip, member.id)), [trip]);
  const canShare = useSyncExternalStore(subscribeCapabilities, () => typeof navigator.share === 'function', () => false);
  const [status, setStatus] = useState(''), [fallback, setFallback] = useState('');
  const name = (id: string) => trip.members.find(member => member.id === id)!.name;
  const failed = calculationError || previews.find(preview => !preview.available)?.message;
  async function share(copy: boolean) {
    const text = billSummaryText(trip);
    try { if (copy) await navigator.clipboard.writeText(text); else await navigator.share({ title: trip.name, text }); setStatus(copy ? 'Summary copied.' : 'Summary shared.'); }
    catch (cause) { if (cause instanceof DOMException && cause.name === 'AbortError') return; setFallback(text); setStatus('Select the summary to copy it.'); }
  }
  return <div className="bill-view">
    <div className="bill-receipts"><h2>{uiText('Receipts')}</h2>{receipts}{payments}</div>
    <div className="bill-finances">
      <h2>{uiText('Who owes what')}</h2>
      {failed ? <p className="error" role={calculationError ? undefined : 'alert'}>{uiText('Review the flagged receipts before using settlement suggestions.')}</p> : <div className="panel bill-shares">{trip.members.map((member, i) => {
        const preview = previews[i]; if (!preview.available) return null;
        return <button type="button" className="bill-share" key={member.id} aria-label={uiText('View statement for {value0}', { value0: member.name })} onClick={() => onStatement(member.id)}>
          <b>{member.name}</b><span>{uiText('Paid {value0} · share {value1}', { value0: money(preview.paidUpfront, trip.currency), value1: money(preview.costShare, trip.currency) })}</span>
          <strong>{preview.netBalance > 0 ? uiText('Is owed {value0}', { value0: money(preview.netBalance, trip.currency) }) : preview.netBalance < 0 ? uiText('Owes {value0}', { value0: money(-preview.netBalance, trip.currency) }) : uiText('Settled')}</strong>
          {!!(preview.paymentsSent || preview.paymentsReceived) && <small>{uiText('Payments sent {value0} · received {value1}', { value0: money(preview.paymentsSent, trip.currency), value1: money(preview.paymentsReceived, trip.currency) })}</small>}
        </button>;
      })}</div>}
      {!failed && <><div className="sectionheading"><h2>{uiText('Settle up')}</h2><button type="button" className="quiet" disabled={busy || trip.members.length < 2} onClick={() => onPayment()}>{uiText('Record payment')}</button></div><div className="panel bill-settlements">{due.length ? due.map(transfer => <div className="settlement" key={`${transfer.from}:${transfer.to}`}>
        <div><strong>{name(transfer.from)}</strong><span>{uiText(' pays ')}{name(transfer.to)}</span></div><b>{money(transfer.amount, trip.currency)}</b><button type="button" className="quiet" disabled={busy} onClick={() => onPayment(transfer)}>{uiText('Mark paid')}</button>
        <SettlementPayActions payee={trip.members.find(member => member.id === transfer.to)!} amount={transfer.amount} currency={trip.currency} reference={`TripTab: ${trip.name}`} />
      </div>) : !trip.expenses.length && !trip.payments.length ? <div className="empty"><h3>{uiText('Add a receipt to see who owes what.')}</h3></div> : <div className="empty"><h3>{uiText('Everyone’s settled')}</h3>{trip.expenses.length > 0 && <button type="button" className="quiet" disabled={busy || trip.drafts.length > 0} onClick={() => void onArchive()}>{uiText('Archive bill')}</button>}</div>}</div></>}
      {!failed && trip.expenses.length > 0 && <div className="bill-share-actions"><button type="button" className="quiet" onClick={() => void share(true)}>{uiText('Copy summary')}</button>{canShare && <button type="button" className="quiet" onClick={() => void share(false)}>{uiText('Share')}</button>}</div>}
      {status && <p role="status">{uiText(status)}</p>}{fallback && <textarea readOnly aria-label={uiText('Bill summary')} value={fallback} />}
    </div>
  </div>;
}
