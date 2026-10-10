'use client';
import { t as uiText } from '@/lib/ui-language';

import { useEffect, useId, useState } from 'react';
import { useConfirmation } from './confirmation-dialog';
import ModalA11y from './modal-accessibility';
import PagedList, { useListPaging } from './paged-list';
import type { Trip } from '@/lib/model';
import type { ArchivedTrip } from '@/lib/trip-lifecycle';
import './trip-controls.css';

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
  const body = (await response.json()) as { error?: string };
  if (!response.ok) throw Error(body.error || 'Unable to change this holiday.');
}

export default function TripControls({
  trip,
  accountId,
  busy,
  onChanged,
}: {
  trip: Trip;
  accountId?: string;
  busy: boolean;
  onChanged: () => Promise<void>;
}) {
  const [owner, setOwner] = useState(''),
    [confirmName, setConfirmName] = useState(''),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState('');
  const { confirm, dialog } = useConfirmation(`${trip.id}:${accountId}`);
  const own = trip.ownerId === accountId;
  async function action(value: 'archive' | 'leave' | 'transfer' | 'delete') {
    if (busy || saving) return;
    if (
      value === 'leave' &&
      !(await confirm({
        title: 'Leave this holiday?',
        message:
          'You will lose access. Your expenses, payments and balance remain in the group’s records.',
        confirmLabel: 'Leave holiday',
        destructive: true,
      }))
    )
      return;
    if (
      value === 'transfer' &&
      !(await confirm({
        title: 'Transfer ownership?',
        message:
          'The new owner will manage invitations and holiday ownership. You stay as a traveller.',
        confirmLabel: 'Transfer ownership',
      }))
    )
      return;
    setSaving(true);
    setMessage('');
    try {
      await change(value, trip.id, { memberId: owner, confirmName });
      await onChanged();
      setMessage(
        value === 'transfer' ? 'Ownership transferred.' : 'Holiday updated.',
      );
    } catch (cause) {
      setMessage(
        cause instanceof Error
          ? cause.message
          : 'Unable to change this holiday.',
      );
    } finally {
      setSaving(false);
    }
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
                <h3>{trip.name}</h3>
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
                    {uiText('Restore holiday')}
                  </button>
                  <a
                    className="quiet"
                    href={`/api/export?scope=trip&format=json&receipts=1&tripId=${encodeURIComponent(trip.id)}`}
                  >
                    {uiText('Download JSON')}
                  </a>
                </div>
              </article>
            )}
          />
        ) : (
          <p>{uiText('No archived holidays.')}</p>
        )}
        {error && (
          <p className="error" role="alert">
            {uiText(error)}
          </p>
        )}
      </section>
    </ModalA11y>
  );
}
