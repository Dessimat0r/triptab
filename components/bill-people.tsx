'use client';
import { useEffect, useId, useState } from 'react';
import ModalA11y from './modal-accessibility';
import { TravellerName } from './trip-details';
import PaymentDetailsPanel from './payment-details';
import { memberRemovalBlocker, removeMember } from '@/lib/trip-insights';
import { t as uiText } from '@/lib/ui-language';
import type { Trip } from '@/lib/model';
type Connection = { id: string; name: string };
/** The server checks the connection again; the name is only a label (D03). */
async function linkConnected(tripId: string, memberId: string, accountId: string) {
  const response = await fetch('/api/trip', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'add-connected', tripId, memberId, accountId }) }).catch(() => null);
  if (response?.ok) return '';
  const body = await response?.json().catch(() => null) as { error?: string } | null;
  return body?.error || 'They couldn’t be added directly. Invite them from Bill options.';
}

export default function BillPeople({ trip, accountId, busy, onSave, onClose, confirm, onLinked }: {
  trip: Trip; accountId?: string; busy: boolean; onSave: (next: Trip) => Promise<boolean>; onClose: () => void;
  confirm: (options: { title: string; message: string; confirmLabel: string; destructive?: boolean }) => Promise<boolean>;
  /** Reload after the server linked an account, so the bill shows it. */
  onLinked?: () => Promise<unknown>;
}) {
  const id = useId(), [name, setName] = useState(''), [error, setError] = useState(''), [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const locked = busy || submitting;
  async function persist(next: Trip) { setSubmitting(true); try { return await onSave(next); } finally { setSubmitting(false); } }
  // F-04 / D03: people this account already shares a holiday or bill with.
  const [connections, setConnections] = useState<Connection[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/trip?mode=connections', { signal: controller.signal, cache: 'no-store' })
      .then(async response => response.ok ? (await response.json() as { people?: Connection[] }).people ?? [] : [])
      .then(people => { if (!controller.signal.aborted) setConnections(people); }).catch(() => {});
    return () => controller.abort();
  }, []);
  const choices = connections.filter(person => !trip.members.some(member => member.userId === person.id)).slice(0, 8);
  async function addConnected(person: Connection) {
    if (locked) return;
    setError(''); setNotice('');
    const label = person.name.trim().slice(0, 50) || 'Friend';
    const same = trip.members.find(member => member.name.toLocaleLowerCase() === label.toLocaleLowerCase());
    // Identity never comes from a name: an existing person with the same name
    // is linked only when the user says it is the same person.
    if (same?.userId) { setError('Each person needs a different name.'); return; }
    if (same && !await confirm({ title: uiText('Is {value0} the same person?', { value0: same.name }),
      message: uiText('“{value0}” is already on this bill. Link them to {value1}’s TripTab account? They will see this bill only, and be told they were added.', { value0: same.name, value1: person.name }),
      confirmLabel: uiText('Link {value0}', { value0: same.name }) })) return;
    if (!same && trip.members.length >= 20) { setError('A bill can be split between up to 20 people.'); return; }
    setSubmitting(true);
    try {
      const memberId = same?.id ?? crypto.randomUUID();
      if (!same && !await onSave({ ...trip, members: [...trip.members, { id: memberId, name: label }] })) return;
      const failure = await linkConnected(trip.id, memberId, person.id);
      await onLinked?.();
      if (failure) setError(same ? failure : `${label} was added as a name. ${failure}`);
      else setNotice(uiText('{value0} was added and can now see this bill.', { value0: label }));
    } finally { setSubmitting(false); }
  }
  return <ModalA11y className="overlay" onClose={() => { if (!locked) onClose(); }}><section className="modal bill-people" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
    <div className="modalheading"><h2 id={`${id}-title`}>{uiText('People')}</h2><button type="button" className="iconbutton" aria-label={uiText('Close people')} disabled={locked} onClick={onClose}>×</button></div>
    {trip.members.map((member, index) => <div key={member.id}><TravellerName trip={trip} member={member} index={index} busy={locked} onSave={onSave} /><button type="button" className="quiet" aria-label={uiText('Remove {value0}', { value0: member.name })} disabled={locked} onClick={async () => {
      const blocker = memberRemovalBlocker(trip, member.id); if (blocker) { setError(blocker); return; }
      if (await confirm({ title: uiText('Remove {value0}?', { value0: member.name }), message: uiText('This person has no entries. Their removal stays in history.'), confirmLabel: uiText('Remove'), destructive: true })) await persist(removeMember(trip, member.id));
    }}>{uiText('Remove')}</button></div>)}
    <form onSubmit={async event => { event.preventDefault(); if (locked) return; const value = name.trim();
      if (!value || value.length > 50 || trip.members.some(member => member.name.toLocaleLowerCase() === value.toLocaleLowerCase())) { setError('Each person needs a different name.'); return; }
      if (trip.members.length >= 20) { setError('A bill can be split between up to 20 people.'); return; }
      if (await persist({ ...trip, members: [...trip.members, { id: crypto.randomUUID(), name: value }] })) { setName(''); setError(''); }
    }}><label>{uiText('New person name')}<input value={name} maxLength={50} disabled={locked} onChange={event => setName(event.target.value)} /></label><button type="submit" className="quiet" disabled={locked || trip.members.length >= 20}>{uiText('Add')}</button></form>
    {choices.length > 0 && <div className="bill-people-connected"><h3>{uiText('Add someone on TripTab')}</h3>
      <p className="footnote">{uiText('People you already share a holiday or bill with. They can see this bill only, and can leave it.')}</p>
      <div className="bill-suggestions">{choices.map(person => <button type="button" className="quiet" key={person.id} disabled={locked}
        aria-label={uiText('Add {value0} (on TripTab)', { value0: person.name })} onClick={() => void addConnected(person)}>{person.name}<small>{uiText(' · on TripTab')}</small></button>)}</div></div>}
    {error && <p className="error" role="alert">{uiText(error)}</p>}
    {notice && <p className="footnote" role="status">{notice}</p>}
    <PaymentDetailsPanel trip={trip} accountId={accountId} busy={locked} paging={{ shown: 20, step: 20, onMore: () => {} }} onSave={onSave} />
  </section></ModalA11y>;
}
