'use client';

import { t as uiText } from "@/lib/ui-language";
import { useState } from 'react';
import type { Trip } from '@/lib/model';

export default function SettlementReminder({
  trip,
  transfer,
  accountId,
}: {
  trip: Trip;
  transfer: { from: string; to: string; amount: number };
  accountId?: string;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const debtor = trip.members.find((member) => member.id === transfer.from);
  const creditor = trip.members.find((member) => member.id === transfer.to);
  if (
    !debtor?.userId ||
    debtor.userId === accountId ||
    (creditor?.userId !== accountId && trip.ownerId !== accountId)
  )
    return null;
  return (
    <div className="settlement-reminder">
      <button
        className="quiet"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setMessage('');
          try {
            const response = await fetch('/api/remind', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tripId: trip.id, ...transfer }),
            });
            const body = (await response.json()) as {
              message?: string;
              error?: string;
            };
            if (!response.ok)
              throw Error(body.error || 'Unable to send reminder.');
            setMessage(body.message || 'Reminder sent.');
          } catch (cause) {
            setMessage(
              cause instanceof Error
                ? cause.message
                : 'Unable to send reminder.',
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? uiText('Sending…') : uiText("Remind {value0}", { value0: debtor.name })}
      </button>
      {message && <small role="status">{uiText(message)}</small>}
    </div>
  );
}
