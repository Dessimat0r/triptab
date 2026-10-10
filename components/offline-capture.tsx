'use client';
import { t as uiText } from '@/lib/ui-language';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CURRENCIES, type Ledger } from '@/lib/model';
import {
  offlineStore,
  type OfflineContext,
  type OfflineExpense,
} from '@/lib/offline-store';
import OfflineEntryEditor from './offline-entry-editor';
import { prepareReceiptImage } from './receipt-capture';

export default function OfflineCapture({
  accountId,
  name,
  ledger,
  onSynced,
  showControls,
  onReview,
}: {
  accountId: string;
  name: string;
  ledger: Ledger;
  onSynced: () => Promise<void>;
  showControls: boolean;
  onReview: (tripId: string) => void;
}) {
  const [editing, setEditing] = useState<OfflineExpense | null>(null);
  const [enabled, setEnabled] = useState(false),
    [entries, setEntries] = useState<OfflineExpense[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const syncedCallback = useRef(onSynced);
  useEffect(() => {
    syncedCallback.current = onSynced;
  }, [onSynced]);
  const running = useRef(false),
    current = useRef(accountId);
  useEffect(() => {
    current.current = accountId;
    return () => {
      current.current = '';
    };
  }, [accountId]);
  const refresh = useCallback(async () => {
    const store = await offlineStore(),
      active = await store.operation<{ accountId: string } | undefined>(
        'settings',
        'get',
        'active',
      );
    if (active && active.accountId !== accountId) {
      await store.operation('contexts', 'delete', active.accountId);
      await store.operation('settings', 'delete', 'active');
    }
    const rows = await store.operation<OfflineExpense[]>('queue', 'getAll');
    if (current.current === accountId) {
      setEnabled(active?.accountId === accountId);
      setEntries(rows.filter((entry) => entry.accountId === accountId));
    }
  }, [accountId]);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  useEffect(() => {
    if (!enabled) return;
    void offlineStore()
      .then((store) =>
        store.operation('contexts', 'put', {
          accountId,
          name,
          trips: ledger.trips.map(({ id, name, currency, members }) => ({
            id,
            name,
            currency,
            members: members.map(
              ({ id, name, userId, weight, joinedOn, leftOn, retired }) => ({
                id,
                name,
                userId,
                weight,
                joinedOn,
                leftOn,
                retired,
              }),
            ),
          })),
          currencies: CURRENCIES,
        } satisfies OfflineContext),
      )
      .catch(() =>
        setMessage('Offline holiday details could not be refreshed.'),
      );
  }, [enabled, accountId, name, ledger]);
  const sync = useCallback(async () => {
    if (running.current || !navigator.onLine) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    const run = async () => {
      const store = await offlineStore(),
        rows = await store.operation<OfflineExpense[]>('queue', 'getAll');
      let saved = 0;
      for (const queued of rows.filter(
        (entry) => entry.accountId === accountId,
      )) {
        if (current.current !== accountId) return;
        if (queued.photo && queued.receiptId) {
          const check = await fetch(
            `/api/receipt?id=${encodeURIComponent(queued.receiptId)}`,
            { headers: { 'X-TripTab-Account': accountId } },
          );
          await check.body?.cancel();
          if (check.status === 404) {
            delete queued.receiptId;
            await store.enqueue(queued);
          } else if (!check.ok)
            throw Error('Sign in again to check the queued receipt photo.');
        }
        if (queued.photo && !queued.receiptId) {
          const image = await prepareReceiptImage(
            new File([queued.photo], 'Offline receipt', {
              type: queued.photo.type,
            }),
          );
          const response = await fetch(
            `/api/receipt?tripId=${encodeURIComponent(queued.tripId)}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': image.type,
                'X-TripTab-Account': accountId,
              },
              body: image,
            },
          );
          const body = (await response.json()) as {
            receiptId?: string;
            error?: string;
          };
          if (!response.ok || !body.receiptId)
            throw Error(
              body.error || 'The queued receipt photo could not be uploaded.',
            );
          queued.receiptId = body.receiptId;
          await store.enqueue(queued);
        }
        if (current.current !== accountId) return;
        const response = await fetch('/api/offline-expenses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accountId,
            tripId: queued.tripId,
            expense: {
              ...queued.expense,
              ...(queued.receiptId ? { receiptId: queued.receiptId } : {}),
            },
          }),
        });
        const body = (await response.json()) as {
          error?: string;
          receiptId?: string;
        };
        if (!response.ok)
          throw Error(body.error || 'The queued expense could not be synced.');
        await store.operation('queue', 'delete', queued.id);
        saved++;
        if (queued.receiptId && body.receiptId !== queued.receiptId)
          await fetch(
            `/api/receipt?id=${encodeURIComponent(queued.receiptId)}`,
            { method: 'DELETE', headers: { 'X-TripTab-Account': accountId } },
          ).catch(() => {});
      }
      if (current.current === accountId && saved) {
        setMessage(
          `${saved} ${saved === 1 ? 'expense synced' : 'expenses synced'}.`,
        );
        await syncedCallback.current();
      }
    };
    try {
      if (navigator.locks)
        await navigator.locks.request(`triptab-offline-sync:${accountId}`, run);
      else await run();
    } catch (cause) {
      if (current.current === accountId)
        setMessage(
          cause instanceof Error
            ? cause.message
            : 'Sync did not finish. Pending entries remain on this device.',
        );
    } finally {
      running.current = false;
      if (current.current === accountId) {
        setBusy(false);
        await refresh().catch(() => {});
      }
    }
  }, [accountId, refresh]);
  useEffect(() => {
    const online = () => void sync();
    window.addEventListener('online', online);
    window.addEventListener('focus', online);
    void sync();
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('focus', online);
    };
  }, [sync]);
  if (!showControls && !entries.length) return null;
  return (
    <section className="panel offline-capture">
      <h3>{uiText('Offline expense capture')}</h3>
      <p className="footnote">
        {uiText(
          'Keep holiday names and travellers on this device. New expenses and receipt photos wait here until you open TripTab while connected.',
        )}
      </p>
      <button
        className="quiet"
        disabled={busy}
        onClick={async () => {
          try {
            const store = await offlineStore();
            if (enabled) {
              await store.operation('settings', 'delete', 'active');
              await store.operation('contexts', 'delete', accountId);
              setEnabled(false);
            } else {
              await store.operation('contexts', 'put', {
                accountId,
                name,
                trips: ledger.trips.map(({ id, name, currency, members }) => ({
                  id,
                  name,
                  currency,
                  members: members.map(
                    ({
                      id,
                      name,
                      userId,
                      weight,
                      joinedOn,
                      leftOn,
                      retired,
                    }) => ({
                      id,
                      name,
                      userId,
                      weight,
                      joinedOn,
                      leftOn,
                      retired,
                    }),
                  ),
                })),
                currencies: CURRENCIES,
              });
              await store.operation('settings', 'put', {
                key: 'active',
                accountId,
              });
              setEnabled(true);
            }
            setMessage(
              enabled
                ? 'Offline capture disabled. Pending expenses are retained.'
                : 'Offline capture enabled on this device.',
            );
          } catch {
            setMessage('This browser cannot enable offline capture.');
          }
        }}
      >
        {enabled ? uiText('Disable on this device') : uiText('Enable on this device')}
      </button>
      {enabled && (
        <a className="quiet" href="/offline.html">
          {uiText('Open capture form')}
        </a>
      )}
      {entries.length > 0 && (
        <>
          <p role="status">
            {entries.length}
            {uiText(' pending expenses for this account.')}
          </p>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void sync()}
          >
            {busy ? uiText('Syncing…') : uiText('Sync pending expenses')}
          </button>
          <details>
            <summary>{uiText('Review pending entries')}</summary>
            <ul>
              {entries.map((entry) => (
                <li key={entry.id}>
                  {entry.expense.title} · {entry.expense.date} ·{' '}
                  {(entry.expense.items[0].amount / 100).toFixed(2)}{' '}
                  {entry.expense.currency}
                  <button
                    className="textbutton"
                    disabled={busy}
                    onClick={() => setEditing(entry)}
                  >
                    {uiText('Edit pending')}
                  </button>
                  <button
                    className="textbutton"
                    onClick={() => onReview(entry.tripId)}
                  >
                    {uiText('Review holiday')}
                  </button>
                  <button
                    className="textbutton"
                    disabled={busy}
                    onClick={async () => {
                      const store = await offlineStore();
                      await store.operation('queue', 'delete', entry.id);
                      await refresh();
                    }}
                  >
                    {uiText('Discard')}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      {message && (
        <p role="status" className="footnote">
          {uiText(message)}
        </p>
      )}
      {editing && (
        <OfflineEntryEditor
          entry={editing}
          trip={ledger.trips.find((trip) => trip.id === editing.tripId)}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
    </section>
  );
}
