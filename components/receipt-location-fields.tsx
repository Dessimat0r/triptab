"use client";
import { useId, useRef, useEffect, useLayoutEffect, useState } from 'react';
import { MapPin, X } from 'lucide-react';
import type { ReceiptLocation, ReceiptLocationHint } from '@/lib/receipt-location';

export type ReceiptPlace = { location?: ReceiptLocation; locationHint?: ReceiptLocationHint };
export default function ReceiptLocationFields({ value, onChange, disabled = false }: {
  value: ReceiptPlace; onChange: (value: ReceiptPlace) => void; disabled?: boolean;
}) {
  const id = useId(), [status, setStatus] = useState(''), [locating, setLocating] = useState(false);
  const generation = useRef(0), live = useRef(true), latest = useRef({ value, onChange, disabled });
  useLayoutEffect(() => { latest.current = { value, onChange, disabled }; }, [value, onChange, disabled]);
  useEffect(() => { const alive = live, counter = generation; alive.current = true; return () => { alive.current = false; counter.current++; }; }, []);
  function locate() {
    if (disabled || locating) return;
    if (!navigator.geolocation) { setStatus('Location is unavailable here. Enter a city or venue, or let the receipt provide it.'); return; }
    const request = ++generation.current;
    setLocating(true); setStatus('Finding your current location…');
    navigator.geolocation.getCurrentPosition(position => {
      if (!live.current || request !== generation.current) return;
      setLocating(false);
      if (latest.current.disabled) return;
      latest.current.onChange({ ...latest.current.value, locationHint: {
        latitude: Math.round(position.coords.latitude * 10000) / 10000,
        longitude: Math.round(position.coords.longitude * 10000) / 10000,
        accuracy: position.coords.accuracy, capturedAt: new Date().toISOString(),
      } });
      setStatus('Current position added as a hint. The receipt may be from somewhere else.');
    }, () => { if (live.current && request === generation.current) { setLocating(false); setStatus('Location was not shared. Enter a place or leave it to the receipt.'); } },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 });
  }
  return <div className="receipt-place-fields">
    <label htmlFor={id}>Receipt location <small>optional</small></label>
    <input id={id} value={value.location?.label ?? ''} maxLength={300} disabled={disabled}
      placeholder="City or venue · otherwise read from receipt" onChange={event => onChange({ ...value,
        location: event.target.value.trim() ? { label: event.target.value, source: 'user' } : undefined })} />
    <div className="receipt-place-actions">
      <button type="button" className="textbutton" disabled={disabled || locating} onClick={locate}><MapPin size={16} aria-hidden="true" />{locating ? 'Locating…' : 'Use current location'}</button>
      {value.location?.source && value.location.source !== 'user' && <small>{value.location.source === 'receipt' ? 'From receipt' : 'From discussion'}</small>}
      {value.locationHint && <button type="button" className="textbutton" disabled={disabled} onClick={() => { generation.current++; setLocating(false); onChange({ ...value, locationHint: undefined }); setStatus(''); }}><X size={16} aria-hidden="true" />Remove device hint</button>}
    </div>
    {(status || value.locationHint) && <small role="status">{status || 'Current device position is saved as a hint, separately from the receipt location.'}</small>}
  </div>;
}
