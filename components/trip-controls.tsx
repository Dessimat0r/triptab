'use client';
import { t as uiText } from '@/lib/ui-language';

import { useEffect, useId, useState } from 'react';
import { useConfirmation } from './confirmation-dialog';
import ModalA11y from './modal-accessibility';
import PagedList, { useListPaging } from './paged-list';
import { balances, isBill, type Trip } from '@/lib/model';
import { formatMoney } from '@/lib/money-format';
import type { ArchivedTrip, DeletedBill } from '@/lib/trip-lifecycle';
import './trip-controls.css';
import DownloadButton from './download-button';

async function change(
  action: string,
  tripId: string,
  extra: Record<string, string> = {},
) {
  const response = await fetch('/api/trip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, tripId, ...extra }),
  });
  const body = (await response.json()) as { error?: string; deleted?: boolean };
  if (!response.ok) throw Error(body.error || 'Unable to change this holiday.');
  if ((action === 'delete' || action === 'discard') && body.deleted !== true) throw Error('Deletion was not confirmed. Refresh and try again.');
}

/** F-04: leaving never erases what someone owes; say what remains. */
function leaveBalance(trip: Trip, accountId: string | undefined) {
  try {
    const index = trip.members.findIndex(member => member.userId === accountId);
    if (index < 0) return '';
    const value = balances(trip)[index];
    const amount = formatMoney(Math.abs(value), trip.currency);
    return value < 0 ? `You still owe ${amount} on this ${isBill(trip) ? 'bill' : 'holiday'}. ` : value > 0 ? `You are still owed ${amount}. ` : 'You are settled. ';
  } catch { return ''; }
}

type Confirm = ReturnType<typeof useConfirmation>['confirm'];
export type TripAction = 'archive' | 'leave' | 'transfer' | 'delete';

/**
 * Asks the confirmations a lifecycle action needs, then calls the server.
 * Shared by Manage this bill/holiday and the drawer's ⋯ menus (F-06), so both
 * paths ask the same questions. Returns false when the person cancels.
 */
export async function runTripAction(trip: Trip, accountId: string | undefined, value: TripAction, confirm: Confirm,
  extra: { memberId?: string; confirmName?: string } = {}): Promise<TripAction | false> {
  if (value === 'delete' && isBill(trip) && trip.members.some(member => member.userId && member.userId !== accountId)) {
    if (!await confirm({ title: 'Keep the shared bill’s records', message: 'Other people can open this bill. Its expenses, payments and history must stay available to them. Remove it from your list instead? This does not settle or change anyone’s balance.', confirmLabel: 'Remove from my list' })) return false;
    await change('archive', trip.id);
    return 'archive';
  }
  if (
    value === 'leave' &&
    !(await confirm({
      title: isBill(trip) ? 'Leave this bill?' : 'Leave this holiday?',
      message: `${leaveBalance(trip, accountId)}You will lose access. Your expenses, payments and balance remain in the group’s records; leaving does not settle them.`,
      confirmLabel: isBill(trip) ? 'Leave bill' : 'Leave holiday',
      destructive: true,
    }))
  )
    return false;
  if (
    value === 'transfer' &&
    !(await confirm({
      title: 'Transfer ownership?',
      message:
        isBill(trip) ? 'The new owner will manage invitations and bill ownership. You stay as a participant.' : 'The new owner will manage invitations and holiday ownership. You stay as a traveller.',
      confirmLabel: 'Transfer ownership',
    }))
  )
    return false;
  // F-06: a bill is deleted after one plain confirmation; typing the name is kept for holidays with entries.
  if (value === 'delete' && isBill(trip) && !(await confirm({
    title: 'Delete this bill?',
    message: `Delete “${trip.name}” with ${trip.expenses.length} ${trip.expenses.length === 1 ? 'expense' : 'expenses'} and ${trip.payments.length} ${trip.payments.length === 1 ? 'payment' : 'payments'}? You can restore it with its receipt photos for 30 days from Archived holidays → Recently deleted; after that it is removed for good. To keep it but hide it, use Remove from my list.`,
    confirmLabel: 'Delete bill', destructive: true,
  }))) return false;
  await change(value, trip.id, { memberId: extra.memberId || '',
  // The plain confirmation above stands in for typing a bill's name; the
  // server still checks the name, so a bill is never deleted by accident.
  confirmName: value === 'delete' && isBill(trip) ? trip.name : extra.confirmName || '' });
  return value;
}

export default function TripControls({
  trip,
  accountId,
  busy,
  onChanged,
  onBillDeleted,
}: {
  trip: Trip;
  accountId?: string;
  busy: boolean;
  onChanged: () => Promise<void>;
  /** F-14: a bill with entries was deleted and can be restored; offer Undo. */
  onBillDeleted?: (trip: Trip) => void;
}) {
  const [owner, setOwner] = useState(''),
    [confirmName, setConfirmName] = useState(''),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState('');
  const { confirm, dialog } = useConfirmation(`${trip.id}:${accountId}`);
  const own = trip.ownerId === accountId;
  async function action(value: TripAction) {
    if (busy || saving) return;
    setSaving(true);
    setMessage('');
    try {
      const completed = await runTripAction(trip, accountId, value, confirm, { memberId: owner, confirmName });
      if (!completed) return;
      if (completed === 'delete' && isBill(trip)) onBillDeleted?.(trip);
      await onChanged();
      setMessage(
        value === 'transfer' ? 'Ownership transferred.' : isBill(trip) ? 'Bill updated.' : 'Holiday updated.',
      );
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : isBill(trip) ? 'Unable to change this bill.' : 'Unable to change this holiday.',
      );
    } finally {
      setSaving(false);
    }
  }
  if (isBill(trip)) {
    return <section className="panel trip-controls"><h3>{uiText('Manage this bill')}</h3><p className="footnote">{uiText('Archive removes this bill from your open list. You can restore it from the archive.')}</p><button type="button" className="quiet" disabled={busy || saving} onClick={() => void action('archive')}>{uiText('Remove from my list')}</button>
      {own && <details><summary>{uiText('Transfer ownership')}</summary><label>{uiText('New owner')}<select value={owner} disabled={busy || saving} onChange={event => setOwner(event.target.value)}><option value="">{uiText('Choose a connected person')}</option>{trip.members.filter(member => member.userId && member.userId !== accountId).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label><button type="button" className="quiet" disabled={busy || saving || !owner} onClick={() => void action('transfer')}>{uiText('Transfer ownership')}</button></details>}
      {!own && <button type="button" className="danger quiet" disabled={busy || saving} onClick={() => void action('leave')}>{uiText('Leave bill')}</button>}
      {own && <details><summary>{uiText('Delete bill')}</summary><p className="footnote">{uiText('You can restore a deleted bill and its receipt photos for 30 days; after that it is removed for good. Bills another account can open must be archived instead.')}</p><button type="button" className="danger quiet" disabled={busy || saving} onClick={() => void action('delete')}>{uiText('Delete bill')}</button></details>}
      {message && <p className="footnote" role="status">{uiText(message)}</p>}{dialog}</section>;
  }
  return (
    <section className="panel trip-controls">
      <h3>{uiText('Manage this holiday')}</h3>
      <p className="footnote">
        {uiText(
          'Archive removes it from your open list. Other travellers keep their access, and you can restore it or download it from Archived holidays.',
        )}
      </p>
      <button
        className="quiet"
        disabled={busy || saving}
        onClick={() => void action('archive')}
      >
        {uiText('Archive for me')}
      </button>
      {own ? (
        <>
          <details>
            <summary>{uiText('Transfer ownership')}</summary>
            <label>
              {uiText('New owner')}
              <select
                value={owner}
                disabled={busy || saving}
                onChange={(event) => setOwner(event.target.value)}
              >
                <option value="">
                  {uiText('Choose a connected traveller')}
                </option>
                {trip.members
                  .filter(
                    (member) => member.userId && member.userId !== accountId,
                  )
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              className="quiet"
              disabled={busy || saving || !owner}
              onClick={() => void action('transfer')}
            >
              {uiText('Transfer ownership')}
            </button>
          </details>
          <details>
            <summary>{uiText('Delete holiday')}</summary>
            <p className="footnote">
              {uiText(
                'Deletion removes the holiday and receipt photos. Shared history is retained. Holidays that other accounts can still open must be transferred or archived instead.',
              )}
            </p>
            <label>
              {uiText('Type ')}
              {trip.name}
              {uiText(' to confirm')}
              <input
                value={confirmName}
                disabled={busy || saving}
                onChange={(event) => setConfirmName(event.target.value)}
                autoComplete="off"
              />
            </label>
            <button
              className="danger quiet"
              disabled={
                busy || saving || confirmName.trim() !== trip.name.trim()
              }
              onClick={() => void action('delete')}
            >
              {uiText('Delete holiday')}
            </button>
          </details>
        </>
      ) : (
        <button
          className="danger quiet"
          disabled={busy || saving}
          onClick={() => void action('leave')}
        >
          {uiText('Leave holiday')}
        </button>
      )}
      {message && (
        <p className="footnote" role="status">
          {uiText(message)}
        </p>
      )}
      {dialog}
    </section>
  );
}

export function ArchivedHolidays({
  accountId,
  onClose,
  onChanged,
}: {
  accountId: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const id = useId(),
    paging = useListPaging(accountId);
  const [trips, setTrips] = useState<ArchivedTrip[]>([]),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  // F-14: bills deleted in the last 30 days, which can still be restored.
  const [deleted, setDeleted] = useState<DeletedBill[]>([]);
  const { confirm, dialog } = useConfirmation(`deleted:${accountId}`);
  useEffect(() => {
    let active = true;
    fetch('/api/trip?mode=deleted', { cache: 'no-store' })
      .then(async response => response.ok ? ((await response.json()) as { bills?: DeletedBill[] }).bills ?? [] : [])
      .then(bills => { if (active) setDeleted(bills); }).catch(() => {});
    return () => { active = false; };
  }, [accountId]);
  async function deletedAction(bill: DeletedBill, action: 'restore-deleted' | 'purge-deleted') {
    if (busy) return;
    if (action === 'purge-deleted' && !await confirm({ title: 'Delete this bill for good?', message: `“${bill.name}” and its receipt photos will be removed now. This can’t be undone.`,
      confirmLabel: 'Delete for good', destructive: true })) return;
    setBusy(true); setError('');
    try {
      await change(action, bill.id);
      setDeleted(current => current.filter(value => value.id !== bill.id));
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to change this bill.');
    } finally { setBusy(false); }
  }
  useEffect(() => {
    let active = true;
    fetch('/api/trip?mode=archived', { cache: 'no-store' })
      .then(async (response) => {
        const body = (await response.json()) as {
          trips?: ArchivedTrip[];
          error?: string;
        };
        if (!response.ok)
          throw Error(body.error || 'Unable to load archived holidays.');
        if (active) setTrips(body.trips ?? []);
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : 'Unable to load holidays.',
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accountId]);
  return (
    <ModalA11y className="overlay" onClose={onClose}>
      <section
        className="modal small"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <div className="modalheading">
          <h2 id={`${id}-title`}>{uiText('Archived holidays')}</h2>
          <button
            className="iconbutton"
            aria-label={uiText('Close archived holidays')}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {loading ? (
          <p role="status">{uiText('Loading holidays…')}</p>
        ) : trips.length ? (
          <PagedList
            {...paging('archives', 10)}
            items={trips}
            noun={uiText("archived holidays")}
            itemKey={(trip) => trip.id}
            renderItem={(trip) => (
              <article
                className="archived-holiday"
                data-entry-id={trip.id}
                tabIndex={-1}
              >
                <h3>{trip.name}</h3>{trip.kind === "bill" && <span className="mini-tag">{uiText("Bill")}</span>}
                <p className="footnote">
                  {trip.travellers}
                  {uiText(' travellers · ')}
                  {trip.currency}
                  {uiText(' · archived ')}
                  {trip.archivedAt.slice(0, 10)}
                </p>
                <div className="button-row">
                  <button
                    className="quiet"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      setError('');
                      try {
                        await change('restore', trip.id);
                        setTrips((current) =>
                          current.filter((value) => value.id !== trip.id),
                        );
                        await onChanged();
                      } catch (cause) {
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : 'Unable to restore.',
                        );
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {uiText(trip.kind === 'bill' ? 'Restore bill' : 'Restore holiday')}
                  </button>
                  <DownloadButton
                    url={`/api/export?scope=trip&format=json&receipts=1&tripId=${encodeURIComponent(trip.id)}`}
                    fileName="triptab-trip.json"
                    label="Download JSON"
                  />
                </div>
              </article>
            )}
          />
        ) : (
          <p>{uiText('No archived holidays.')}</p>
        )}
        {deleted.length > 0 && <section className="recently-deleted" aria-labelledby={`${id}-deleted`}>
          <h3 id={`${id}-deleted`}>{uiText('Recently deleted')}</h3>
          <p className="footnote">{uiText('Deleted bills can be restored with their receipt photos for 30 days.')}</p>
          {deleted.map(bill => <article key={bill.id} className="archived-holiday" data-entry-id={bill.id}>
            <h3>{bill.name}</h3><span className="mini-tag">{uiText('Bill')}</span>
            <p className="footnote">{uiText('Deleted {value0} · can be restored until {value1}', { value0: bill.deletedAt.slice(0, 10), value1: bill.restoreUntil.slice(0, 10) })}</p>
            <div className="button-row">
              <button type="button" className="quiet" disabled={busy} onClick={() => void deletedAction(bill, 'restore-deleted')}>{uiText('Restore bill')}</button>
              <button type="button" className="quiet danger" disabled={busy} onClick={() => void deletedAction(bill, 'purge-deleted')}>{uiText('Delete for good')}</button>
            </div>
          </article>)}
        </section>}
        {error && (
          <p className="error" role="alert">
            {uiText(error)}
          </p>
        )}
        {dialog}
      </section>
    </ModalA11y>
  );
}
