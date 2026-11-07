'use client';
import { useState } from 'react';
import { financialFormatHeaders } from '@/lib/financial-format';
import { t as uiText } from '@/lib/ui-language';

/**
 * R01: a plain download link cannot send the money-format declaration, so the
 * server would refuse it. This fetches the file with the declaration and saves
 * it from a Blob. A refusal (426) or any other failure shows the server's own
 * message and downloads nothing.
 */
export async function downloadFile(url: string, fallbackName: string, signal?: AbortSignal) {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: financialFormatHeaders(), signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || 'Unable to download this file. Try again.');
  }
  const blob = await response.blob();
  const suppliedName = response.headers.get('content-disposition')?.match(/filename="([a-zA-Z0-9._-]+)"/)?.[1];
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = suppliedName || fallbackName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

export default function DownloadButton({ url, fileName, label, className = 'quiet' }: { url: string; fileName: string; label: string; className?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <>
    <button type="button" className={className} disabled={busy} onClick={async () => {
      setBusy(true); setError('');
      try { await downloadFile(url, fileName); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to download this file. Try again.'); }
      finally { setBusy(false); }
    }}>{uiText(label)}</button>
    {error && <span role="alert" className="footnote">{uiText(error)}</span>}
  </>;
}
