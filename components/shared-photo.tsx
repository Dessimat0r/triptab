'use client';
import { t as uiText } from '@/lib/ui-language';

import { useEffect, useState } from 'react';
import { offlineStore } from '@/lib/offline-store';
import type { Trip } from '@/lib/model';

export default function SharedPhoto({
  trips,
  selected,
  accountId,
  busy,
  onSelect,
  onReceive,
}: {
  trips: Trip[];
  selected?: string;
  accountId?: string;
  busy: boolean;
  onSelect: (id: string) => void;
  onReceive: (file: File) => Promise<boolean>;
}) {
  const [photo, setPhoto] = useState<{
      id: string;
      photo: Blob;
      createdAt: number;
    } | null>(null),
    [message, setMessage] = useState(''),
    [working, setWorking] = useState(false);
  useEffect(() => {
    let active = true;
    offlineStore()
      .then(async (store) => {
        const rows = await store.operation<
          { id: string; photo: Blob; createdAt: number }[]
        >('shared', 'getAll');
        for (const row of rows)
          if (row.createdAt < Date.now() - 86400000)
            await store.operation('shared', 'delete', row.id);
        if (active)
          setPhoto(
            rows.find((row) => row.createdAt >= Date.now() - 86400000) ?? null,
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [accountId]);
  if (!photo) return null;
  return (
    <section className="panel shared-photo">
      <h3>{uiText('A photo was shared with TripTab')}</h3>
      <p className="footnote">
        {uiText(
          'Choose its holiday, then upload it for review. It is kept on this device until you attach or discard it.',
        )}
      </p>
      {accountId ? (
        <>
          <label>
            {uiText('Holiday')}
            <select
              value={selected ?? trips[0]?.id ?? ''}
              disabled={busy || working}
              onChange={(event) => onSelect(event.target.value)}
            >
              {trips.map((trip) => (
                <option key={trip.id} value={trip.id}>
                  {trip.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            disabled={busy || working || !trips.length}
            onClick={async () => {
              setWorking(true);
              setMessage('');
              try {
                if (
                  await onReceive(
                    new File([photo.photo], 'Shared receipt', {
                      type: photo.photo.type,
                    }),
                  )
                ) {
                  const store = await offlineStore();
                  await store.operation('shared', 'delete', photo.id);
                  setPhoto(null);
                } else
                  setMessage(
                    'Upload did not finish. The shared photo is still here.',
                  );
              } finally {
                setWorking(false);
              }
            }}
          >
            {working ? 'Uploading…' : 'Attach receipt photo'}
          </button>
        </>
      ) : (
        <p>{uiText('Sign in to choose a holiday.')}</p>
      )}
      <button
        className="quiet"
        disabled={working}
        onClick={async () => {
          const store = await offlineStore();
          await store.operation('shared', 'delete', photo.id);
          setPhoto(null);
        }}
      >
        {uiText('Discard photo')}
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
