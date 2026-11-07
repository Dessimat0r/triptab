'use client';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import ModalA11y from './modal-accessibility';
import { t as uiText, currencyDisplayName } from '@/lib/ui-language';
import { CURRENCIES, type Currency, type Ledger } from '@/lib/model';
import './bills.css';

/** `accounts[i]` is the verified account chosen for `names[i]` (F-04); never inferred from a name. */
export type BillStartValues = { names: string[]; accounts?: (string | undefined)[]; name: string; currency: Currency; currencyDefault: boolean; file?: File; billPhoto?: File };
export default function BillStart({ ledger, displayName, busy, onClose, onStart }: {
  ledger: Ledger; displayName: string; busy: boolean; onClose: () => void; onStart: (values: BillStartValues) => Promise<void>;
}) {
  const id = useId();
  const [names, setNames] = useState<string[]>([]), [entry, setEntry] = useState(''), [name, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>(ledger.trips.at(-1)?.currency || 'GBP');
  const [currencyDefault, setCurrencyDefault] = useState(true), [error, setError] = useState('');
  // F-04 / D03: people this account already shares a holiday or bill with, verified by the server.
  const [connections, setConnections] = useState<{ id: string; name: string }[]>([]);
  const [linked, setLinked] = useState<Record<string, string>>({});
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/trip?mode=connections', { signal: controller.signal, cache: 'no-store' })
      .then(async response => response.ok ? (await response.json() as { people?: { id: string; name: string }[] }).people ?? [] : [])
      .then(people => { if (!controller.signal.aborted) setConnections(people); }).catch(() => {});
    return () => controller.abort();
  }, []);
  const connectedChoices = connections.filter(person => !names.some(value => linked[value.toLocaleLowerCase()] === person.id)).slice(0, 8);
  const suggestions = useMemo(() => {
    const unique = new Map<string, string>();
    for (const trip of [...ledger.trips].reverse()) for (const person of trip.members) if (!unique.has(person.name.toLocaleLowerCase())) unique.set(person.name.toLocaleLowerCase(), person.name);
    return [...unique.values()].filter(value => ![displayName, ...names].some(name => name.toLocaleLowerCase() === value.toLocaleLowerCase()) && entry.trim() && value.toLocaleLowerCase().startsWith(entry.trim().toLocaleLowerCase())).slice(0, 5);
  }, [ledger, names, displayName, entry]);
  function add(values: string[]) {
    const next = [...names];
    for (const value of values.map(value => value.trim()).filter(Boolean)) {
      if (value.length > 50 || next.length >= 19) { setError('A bill can be split between up to 20 people.'); return false; }
      if ([displayName, ...next].some(name => name.toLocaleLowerCase() === value.toLocaleLowerCase())) { setError('Each person needs a different name.'); return false; }
      next.push(value);
    }
    setNames(next); setEntry(''); setError(''); return next;
  }
  const picker = useRef<HTMLInputElement>(null), photoPicker = useRef<HTMLInputElement>(null), cameraPicker = useRef<HTMLInputElement>(null), pending = useRef<string[]>([]);
  function values(next: string[], file?: File, billPhoto?: File): BillStartValues {
    return { names: [displayName, ...next], accounts: [undefined, ...next.map(value => linked[value.toLocaleLowerCase()])], name: name.trim(), currency, currencyDefault, file, billPhoto };
  }
  function addConnected(person: { id: string; name: string }) {
    const label = person.name.trim().slice(0, 50) || 'Friend';
    if (add([label]) === false) return;
    setLinked(previous => ({ ...previous, [label.toLocaleLowerCase()]: person.id }));
  }
  async function enter() {
    if (busy) return;
    const next = add(entry.split(','));
    if (next === false) return;
    await onStart(values(next));
  }
  // The picker opens inside this tap; the bill is created once a photo is chosen.
  function choosePhoto(camera: boolean) {
    if (busy) return;
    const next = add(entry.split(','));
    if (next === false) return;
    pending.current = next;
    (camera ? cameraPicker : photoPicker).current?.click();
  }
  function scan() {
    if (busy) return;
    const next = add(entry.split(','));
    if (next === false) return;
    pending.current = next; picker.current?.click();
  }
  return <ModalA11y className="overlay" onClose={() => { if (!busy) onClose(); }}>
    <section className="modal small bill-start" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}>
      <div className="modalheading"><h2 id={`${id}-title`}>{uiText('Split a bill')}</h2><button type="button" className="iconbutton" aria-label={uiText('Close')} disabled={busy} onClick={onClose}><X /></button></div>
      <div className="bill-name-chips"><span>{displayName} · {uiText('You')}</span>{names.map((name, index) => <button type="button" className="quiet" key={name} disabled={busy} aria-label={uiText('Remove {value0}', { value0: name })} onClick={() => { setNames(names.filter((_, i) => i !== index)); setLinked(previous => { const next = { ...previous }; delete next[name.toLocaleLowerCase()]; return next; }); }}>{name}{linked[name.toLocaleLowerCase()] ? <small>{uiText(' · on TripTab')}</small> : null}<X size={16} /></button>)}</div>
      <label htmlFor={`${id}-people`}>{uiText("Who's splitting?")}<input id={`${id}-people`} value={entry} maxLength={1000} disabled={busy} autoComplete="off" placeholder={uiText('Names, separated by commas')} onChange={event => {
        const value = event.target.value;
        if (value.includes(',')) { const parts = value.split(','); const tail = parts.pop()!; if (add(parts) !== false) setEntry(tail); }
        else { setEntry(value); setError(''); }
      }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(entry.split(',')); } }} /></label>
      {connectedChoices.length > 0 && <div className="bill-suggestions bill-connected" aria-label={uiText('People on TripTab you share a holiday or bill with')}>{connectedChoices.map(person => <button type="button" className="quiet" key={person.id} disabled={busy}
        aria-label={uiText('Add {value0} (on TripTab)', { value0: person.name })} onClick={() => addConnected(person)}>{person.name}<small>{uiText(' · on TripTab')}</small></button>)}</div>}
      {suggestions.length > 0 && <div className="bill-suggestions">{suggestions.map(name => <button type="button" className="quiet" key={name} disabled={busy} aria-label={uiText('Add {value0}', { value0: name })} onClick={() => add([name])}>{name}</button>)}</div>}
      <details><summary>{uiText('More options')}</summary><label>{uiText('Name')}<input value={name} maxLength={100} disabled={busy} placeholder={uiText('Named after the receipt')} onChange={event => setName(event.target.value)} /></label><label>{uiText('Currency')}<select value={currency} disabled={busy} onChange={event => { setCurrency(event.target.value as Currency); setCurrencyDefault(false); }}>{CURRENCIES.map(({ code, name }) => <option key={code} value={code}>{code} · {currencyDisplayName(code, name)}</option>)}</select></label></details>
      {error && <p className="error" role="alert">{uiText(error)}</p>}
      <div className="bill-start-actions">
        <button type="button" className="primary" disabled={busy} onClick={scan}>{uiText('Scan receipt')}</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => void enter()}>{uiText('Enter amount')}</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => choosePhoto(false)}>{uiText('Choose image')}</button>
        <button type="button" className="quiet" disabled={busy} onClick={() => choosePhoto(true)}>{uiText('Take photo')}</button>
        <input ref={picker} type="file" hidden aria-label={uiText('Scan receipt photo')} accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" capture="environment" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) void onStart(values(pending.current, file));
        }} />
        <input ref={photoPicker} type="file" hidden aria-label={uiText('Choose bill image')} accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) void onStart(values(pending.current, undefined, file));
        }} />
        <input ref={cameraPicker} type="file" hidden aria-label={uiText('Take bill photo')} accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif" capture="environment" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) void onStart(values(pending.current, undefined, file));
        }} />
      </div>
      <p className="footnote">{uiText('Bill images are shared with bill members without scanning or changing any amounts.')}</p>
    </section>
  </ModalA11y>;
}
