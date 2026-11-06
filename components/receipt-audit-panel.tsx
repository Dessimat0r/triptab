'use client';
import { useEffect, useState } from 'react';
import type { ReceiptAuditFinding } from '@/lib/historical-receipt-audit';
import { formatMoney } from '@/lib/money-format';

export default function ReceiptAuditPanel({ tripId, onReview }: { tripId: string; onReview: (id: string) => void }) {
  const [state, setState] = useState<{ tripId: string; findings?: ReceiptAuditFinding[]; error?: string }>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void fetch(`/api/receipt/audit?tripId=${encodeURIComponent(tripId)}`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => { const body = await response.json() as { error?: string; findings: ReceiptAuditFinding[] }; if (!response.ok) throw Error(body.error || 'Unable to inspect receipts.'); return body; })
      .then(body => setState({ tripId, findings: body.findings }))
      .catch(error => { if (!controller.signal.aborted) setState({ tripId, error: String(error.message || error) }); });
    return () => controller.abort();
  }, [open, tripId]);
  const current = state?.tripId === tripId ? state : undefined;
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Historical receipt discrepancy report</summary>
    <p>This read-only report compares stored calculations with recorded receipt evidence. It never changes amounts, shares or payments. A suspicious line requires review against the photo.</p>
    <a href={`/api/receipt/audit?tripId=${encodeURIComponent(tripId)}`} download="receipt-discrepancies.json">Download this report</a>
    {!current && open && <p role="status">Inspecting stored receipts…</p>}
    {current?.error && <p role="alert">{current.error}</p>}
    {current?.findings?.length === 0 && <p>No discrepancies found in the available evidence. Receipts without recorded totals cannot be verified.</p>}
    {current?.findings?.map(finding => <article className="panel" key={finding.expenseId}>
      <h3>{finding.title}</h3><p>{finding.classification.replaceAll('-', ' ')}</p>
      <p>Expense: {finding.expenseId} · {finding.currency}{finding.difference !== null ? ` · Difference ${formatMoney(finding.difference, finding.currency)}` : ' · Difference unknown'}</p>
      <ul>{finding.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>
      {finding.exceptionReason && <p>Saved reason: {finding.exceptionReason}</p>}
      <button type="button" className="quiet" onClick={() => onReview(finding.expenseId)}>Review receipt</button>
    </article>)}
  </details>;
}
