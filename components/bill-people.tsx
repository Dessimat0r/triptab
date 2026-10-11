'use client';
import { useId, useState } from 'react';
import ModalA11y from './modal-accessibility';
import { TravellerName } from './trip-details';
import PaymentDetailsPanel from './payment-details';
import { memberRemovalBlocker, removeMember } from '@/lib/trip-insights';
import { t as uiText } from '@/lib/ui-language';
import type { Trip } from '@/lib/model';
export default function BillPeople({ trip, accountId, busy, onSave, onClose, confirm }: {
  trip: Trip; accountId?: string; busy: boolean; onSave: (next: Trip) => Promise<boolean>; onClose: () => void;
  confirm: (options: { title: string; message: string; confirmLabel: string; destructive?: boolean }) => Promise<boolean>;
}) {
  const id = useId(), [name, setName] = useState(''), [error, setError] = useState(''), [submitting, setSubmitting] = useState(false);
  const locked = busy || submitting;
  async function persist(next: Trip) { setSubmitting(true); try { return await onSave(next); } finally { setSubmitting(false); } }
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
    {error && <p className="error" role="alert">{uiText(error)}</p>}
    <PaymentDetailsPanel trip={trip} accountId={accountId} busy={locked} paging={{ shown: 20, step: 20, onMore: () => {} }} onSave={onSave} />
  </section></ModalA11y>;
}
