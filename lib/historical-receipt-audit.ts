import { total, type Ledger } from './model';
import { receiptScanFingerprint } from './receipt-scan';

export type ReceiptAuditClassification = 'confirmed-discrepancy' | 'potential-missing-discount' | 'explicitly-acknowledged-discrepancy' | 'insufficient-evidence';
export type ReceiptAuditFinding = {
  tripId: string; tripName: string; expenseId: string; title: string; currency: string;
  classification: ReceiptAuditClassification; storedTotal: number | null; printedTotal: number | null;
  difference: number | null; evidence: string[]; exceptionReason?: string; currentAcknowledgement: boolean; reviewUrl: string;
};

/** Pure inspection only. Its input must already have been restricted by server authorisation. */
export function auditHistoricalReceipts(ledger: Ledger): ReceiptAuditFinding[] {
  const findings: ReceiptAuditFinding[] = [];
  for (const trip of ledger.trips) for (const expense of trip.expenses) {
    const scan = expense.receiptScan;
    if (!scan && !expense.receiptId && expense.source !== 'ai') continue;
    let storedTotal: number | null = null;
    try { storedTotal = total(expense); } catch { /* Preserve the record for manual inspection. */ }
    const printedTotal = scan?.printedTotal ?? null;
    const difference = storedTotal !== null && printedTotal !== null ? storedTotal - printedTotal : null;
    const negativeLines = scan?.sourceLines?.filter(line => typeof line.amount === 'number' && line.amount < 0) ?? [];
    const promotional = negativeLines.filter(line => /bogof|buy\s*one|multibuy|multi.buy|loyalty|coupon|discount|saving|promotion|offer/i.test(line.observedText ?? ''));
    const unmapped = negativeLines.filter(line => !line.mappedTo || line.mappedTo === 'unmapped');
    const suspicious = promotional.length > 0 && (unmapped.length > 0 || expense.discount === 0);
    const acknowledgement = scan?.acknowledgement;
    let currentAcknowledgement = false;
    try { currentAcknowledgement = !!acknowledgement && acknowledgement.fingerprint === receiptScanFingerprint(expense); } catch { /* Insufficient evidence. */ }
    const evidence: string[] = [];
    if (difference) evidence.push(`Stored calculation ${storedTotal}; printed total ${printedTotal}; difference ${difference} (integer hundredths).`);
    if (acknowledgement) evidence.push(currentAcknowledgement ? 'A prior acknowledgement matches the stored financial evidence.' : 'A prior acknowledgement exists but does not match the current evidence.');
    for (const line of unmapped) evidence.push(`Unmapped negative line ${line.lineIndex ?? '?'}: ${line.observedText ?? '(no text)'} (${line.amount}).`);
    if (suspicious) evidence.push('Promotional evidence may be affected by the original unmapped-discount defect. Item qualification requires human review.');
    if (difference === null) evidence.push('No independently recorded printed total or complete stored calculation is available.');
    const classification: ReceiptAuditClassification = difference
      ? currentAcknowledgement ? 'explicitly-acknowledged-discrepancy' : 'confirmed-discrepancy'
      : suspicious ? 'potential-missing-discount' : 'insufficient-evidence';
    // Fully evidenced, matching receipts without suspicious handling are clean.
    if (difference === 0 && !suspicious && !unmapped.length && !acknowledgement) continue;
    findings.push({ tripId: trip.id, tripName: trip.name, expenseId: expense.id, title: expense.title, currency: expense.currency,
      classification, storedTotal, printedTotal, difference, evidence, exceptionReason: acknowledgement?.reason,
      currentAcknowledgement, reviewUrl: `/expenses?receiptTrip=${encodeURIComponent(trip.id)}&receiptExpense=${encodeURIComponent(expense.id)}` });
  }
  return findings;
}
