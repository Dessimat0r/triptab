'use client';
import { t as uiText } from '@/lib/ui-language';

import { useId, useState } from 'react';
import ModalA11y from './modal-accessibility';
import { previewImport, type ImportPreview } from '@/lib/import-ledger';
import { tripSummary } from '@/lib/trip-insights';
import { formatMoney } from '@/lib/money-format';
export default function ImportHoliday({
  accountId,
  onClose,
  onImported,
}: {
  accountId: string;
  onClose: () => void;
  onImported: (tripId: string) => Promise<void>;
}) {
  const id = useId(),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [selected, setSelected] = useState(0),
    [memberId, setMemberId] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const trip = preview?.trips[selected],
    summary = trip ? tripSummary(trip) : null;
  return (
    <ModalA11y className="overlay" onClose={onClose}>
      <section
        className="modal small"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
      >
        <div className="modalheading">
          <h2 id={`${id}-title`}>{uiText('Import a holiday')}</h2>
          <button className="quiet" onClick={onClose} disabled={busy}>
            {uiText('Close')}
          </button>
        </div>
        <p className="footnote">
          {uiText(
            'Restore a TripTab JSON export, TripTab CSV or Splitwise CSV as a new holiday. CSV also accepts Date, Description, Amount, Currency, Paid by and Shared by columns.',
          )}
        </p>
        <label>
          {uiText('Import file')}
          <input
            type="file"
            accept=".json,.csv,application/json,text/csv"
            disabled={busy}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              setError('');
              setPreview(null);
              setMemberId('');
              if (!file) return;
              try {
                if (file.size > 2_000_000)
                  throw Error('Import files must be no larger than 2 MB.');
                setPreview(previewImport(await file.text(), file.name));
                setSelected(0);
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : 'The file could not be read.',
                );
              }
            }}
          />
        </label>
        {trip && (
          <form
            className="repeat-expense-form"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError('');
              try {
                const response = await fetch('/api/import', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ accountId, trip, memberId }),
                });
                const body = (await response.json()) as {
                  error?: string;
                  tripId?: string;
                };
                if (!response.ok || !body.tripId)
                  throw Error(body.error || 'Import did not finish.');
                await onImported(body.tripId);
                onClose();
              } catch (cause) {
                setError(
                  cause instanceof Error
                    ? cause.message
                    : 'Import did not finish.',
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {preview!.trips.length > 1 && (
              <label>
                {uiText('Holiday')}
                <select
                  value={selected}
                  onChange={(event) => {
                    setSelected(Number(event.target.value));
                    setMemberId('');
                  }}
                >
                  {preview!.trips.map((trip, index) => (
                    <option key={trip.id} value={index}>
                      {trip.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p>
              {trip.name} · {trip.expenses.length}
              {uiText(' expenses · ')}
              {trip.payments.length}
              {uiText(' payments')}
              {summary?.ok
                ? ` · ${formatMoney(summary.spending.total, trip.currency)}`
                : ''}
            </p>
            <label>
              {uiText('Which traveller are you?')}
              <select
                value={memberId}
                onChange={(event) => setMemberId(event.target.value)}
                required
              >
                <option value="">{uiText('Choose your traveller')}</option>
                {trip.members
                  .filter((member) => !member.retired)
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
              </select>
            </label>
            {preview!.notes.map((note) => (
              <p className="footnote" key={note}>
                {note}
              </p>
            ))}
            <button className="primary wide" disabled={busy || !memberId}>
              {busy ? 'Importing…' : 'Create imported holiday'}
            </button>
          </form>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </ModalA11y>
  );
}
