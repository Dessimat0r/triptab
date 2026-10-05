import { canonicalJson as canonical } from './data-utils';
import { z } from 'zod';

const amount = z.number().int().min(0).max(100000000);
const identifier = z.string().min(1).max(100);
const confidence = z.enum(['high', 'medium', 'low']);
const source = z.enum(['default', 'receipt', 'ai', 'user']);
export const scanSourceSchema = z.object({
  lineIndex: z.number().int().min(0).max(1000).optional(),
  observedText: z.string().max(1000).optional(),
  confidence: confidence.optional(),
}).strict();
export const sourceLineSchema = scanSourceSchema.extend({
  kind: z.enum(['item', 'tax-summary', 'adjustment', 'subtotal', 'total', 'other']).optional(),
  amount: z.number().int().min(-100000000).max(100000000).nullable().optional(),
  mappedTo: z.enum(['discount', 'tax', 'tip', 'included', 'unmapped']).optional(),
}).strict();
export const itemFieldSourcesSchema = z.object({
  name: source.optional(), amount: source.optional(), quantity: source.optional(),
}).strict();
export const fieldSourcesSchema = z.object({
  title: source.optional(), currency: source.optional(), date: source.optional(), time: source.optional(),
  timezone: z.enum(['default', 'ai', 'user']).optional(), payer: z.enum(['default', 'ai', 'user']).optional(),
  tax: source.optional(), tip: source.optional(), discount: source.optional(),
}).strict();
export const RECEIPT_SCAN_WARNING_CODES = [
  'missing-printed-total', 'unreadable-amount', 'uncertain-description', 'ambiguous-currency',
  'subtotal-mismatch', 'total-mismatch', 'possible-duplicate', 'unmapped-adjustment',
  'included-tax-ambiguous', 'image-may-be-incomplete', 'low-confidence', 'unassigned-item', 'currency-mismatch',
] as const;
export const receiptScanWarningSchema = z.object({
  code: z.enum(RECEIPT_SCAN_WARNING_CODES),
  itemId: identifier.optional(), itemIds: z.array(identifier).max(200).optional(),
  lineIndex: z.number().int().min(0).max(1000).optional(),
  observedText: z.string().max(1000).optional(),
  difference: z.number().int().min(-200000000).max(20200000000).optional(),
  // Only an authenticated browser review may add this marker; it never cures
  // missing financial values or missing independent printed-total evidence.
  resolved: z.literal(true).optional(),
}).strict();
export const receiptScanSchema = z.object({
  version: z.literal(1),
  // Preserve the observed currency code even when this app cannot settle it.
  printedCurrency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  printedSubtotal: amount.nullable().optional(), printedTotal: amount.nullable().optional(),
  calculatedSubtotal: z.number().int().min(0).max(20000000000).optional(),
  calculatedTotal: z.number().int().min(-100000000).max(20200000000).optional(),
  status: z.enum(['matched', 'needs-review', 'incomplete']),
  warnings: z.array(receiptScanWarningSchema).max(1000),
  sourceLines: z.array(sourceLineSchema).max(1000).optional(),
  fieldSources: z.object({
    printedSubtotal: z.enum(['receipt', 'user']).optional(),
    printedTotal: z.enum(['receipt', 'user']).optional(),
    printedCurrency: z.enum(['receipt', 'user']).optional(),
  }).strict().optional(),
  processedAt: z.string().datetime({ offset: true }).optional(),
  processor: z.string().min(1).max(80).optional(),
  attemptId: identifier.optional(), imageIds: z.array(identifier).max(6).optional(),
  acknowledgement: z.object({ fingerprint: z.string().regex(/^scan-v1:[a-f0-9]{64}$/) }).strict().optional(),
  // A human may review a receipt whose printed total is absent/unreadable.
  // Keep the unknown evidence and incomplete status rather than inventing it.
  missingTotalAcknowledgement: z.object({ fingerprint: z.string().regex(/^scan-v1:[a-f0-9]{64}$/) }).strict().optional(),
}).strict();
export type ReceiptScan = z.infer<typeof receiptScanSchema>;
export type ReceiptScanWarning = z.infer<typeof receiptScanWarningSchema>;
/** The empty placeholder row a new draft starts with; nothing a person could have typed. */
export function blankReceiptItem(item: { name: string; amount: number | null; quantity?: unknown; scanSource?: unknown }) {
  return !item.name.trim() && item.amount === 0 && item.quantity === undefined && item.scanSource === undefined;
}
/**
 * Whether recognition may fill a saved item field whose provenance is unknown.
 * Legacy values may have been typed by a person, so only a missing name, a null
 * price or an untouched placeholder row is safe to infer. Native and connected-
 * assistant rescans share this one rule so they cannot diverge.
 */
export function mayRecognizeUnknownProvenance(field: 'name' | 'amount', item: { name: string; amount: number | null; quantity?: unknown; scanSource?: unknown }) {
  return field === 'name' ? !item.name.trim() : item.amount === null || blankReceiptItem(item);
}

export type ScanSource = z.infer<typeof scanSourceSchema>;
export type FieldSources = z.infer<typeof fieldSourcesSchema>;
export type ReceiptSourceLine = z.infer<typeof sourceLineSchema>;

/** Source ordinals are observations, not stable identities across rescans. */
export function mergeReceiptSourceLines(previous: ReceiptSourceLine[] = [], incoming: ReceiptSourceLine[] = []): ReceiptSourceLine[] {
  const identity = (line: ReceiptSourceLine) => canonical({ observedText: line.observedText, kind: line.kind,
    amount: line.amount, ...(!line.observedText && line.amount === undefined ? { lineIndex: line.lineIndex } : {}) });
  const lines = [...previous];
  const used = new Set<number>();
  for (const line of incoming) {
    // Match occurrences one-to-one against the previous scan only. Two
    // identical coupons/tax lines on one photo are two physical observations.
    const index = previous.findIndex((value, position) => !used.has(position) && identity(value) === identity(line));
    if (index < 0) lines.push(line);
    else { used.add(index); lines[index] = { ...previous[index], ...line }; }
  }
  return lines;
}

const warningLabels: Record<ReceiptScanWarning['code'], string> = {
  'missing-printed-total': 'Printed total is unavailable', 'unreadable-amount': 'Item price is unreadable',
  'uncertain-description': 'Item description needs checking', 'ambiguous-currency': 'Original currency needs confirmation',
  'subtotal-mismatch': 'Item prices differ from the printed subtotal', 'total-mismatch': 'Itemised total differs from the printed total',
  'possible-duplicate': 'Possible duplicate receipt lines', 'unmapped-adjustment': 'Unresolved discount, refund or charge',
  'included-tax-ambiguous': 'Tax may already be included', 'image-may-be-incomplete': 'Receipt image may be incomplete',
  'low-confidence': 'Receipt detail needs checking', 'unassigned-item': 'Item needs people assigned',
  'currency-mismatch': 'Original currency differs from the printed currency',
};
export function receiptWarningLabel(code: string): string {
  return warningLabels[code as ReceiptScanWarning['code']] || 'Receipt detail needs checking';
}

export type ScannableReceipt = {
  currency: string | null;
  items: {
    id: string; name: string; amount: number | null; members: string[];
    scanSource?: ScanSource; fieldSources?: z.infer<typeof itemFieldSourcesSchema>;
    units?: { total: number; allocations: Record<string, number>; label?: string };
    percentages?: Record<string, number>;
  }[];
  tax: number; tip: number; discount: number;
  percentages?: Record<string, number>;
  fieldSources?: FieldSources;
  receiptScan?: ReceiptScan;
};

const generatedCodes = new Set<ReceiptScanWarning['code']>([
  'missing-printed-total', 'unreadable-amount', 'unassigned-item', 'subtotal-mismatch', 'total-mismatch', 'currency-mismatch',
]);
function warningKey(warning: ReceiptScanWarning): string {
  return JSON.stringify([warning.code, warning.itemId, warning.itemIds, warning.lineIndex, warning.observedText]);
}

/** Reconcile integer hundredths against independently observed printed values.
 * Allocation warnings are separate from recognition status. Legacy entries
 * without source evidence remain untouched rather than gaining invented facts.
 */
export function reconcileReceiptScan(entry: ScannableReceipt): ReceiptScan | undefined {
  if (!entry.receiptScan) return undefined;
  const scan = receiptScanSchema.parse(entry.receiptScan);
  const items = new Map(entry.items.map(item => [item.id, item]));
  const sourceGroups = new Map<number, string[]>();
  for (const item of entry.items) {
    const line = item.scanSource?.lineIndex;
    if (line !== undefined) sourceGroups.set(line, [...(sourceGroups.get(line) || []), item.id]);
  }
  const warnings: ReceiptScanWarning[] = [];
  const add = (warning: ReceiptScanWarning) => {
    if (!warnings.some(candidate => warningKey(candidate) === warningKey(warning))) warnings.push(warning);
  };
  for (const warning of scan.warnings) {
    if (generatedCodes.has(warning.code)) continue;
    if (warning.itemId && !items.has(warning.itemId)) continue;
    if (warning.itemIds?.some(itemId => !items.has(itemId))) continue;
    if (warning.code === 'possible-duplicate' && warning.lineIndex !== undefined
      && (sourceGroups.get(warning.lineIndex)?.length || 0) < 2) continue;
    if (warning.code === 'unmapped-adjustment' && warning.lineIndex !== undefined) {
      const lines = scan.sourceLines?.filter(candidate => warning.observedText
        ? candidate.observedText === warning.observedText : candidate.lineIndex === warning.lineIndex) || [];
      if (lines.length && lines.every(line => line.mappedTo && line.mappedTo !== 'unmapped')) continue;
    }
    if (warning.code === 'ambiguous-currency' && !entry.currency) continue;
    if (warning.code === 'ambiguous-currency' && entry.currency && entry.fieldSources?.currency === 'user') continue;
    if (warning.code === 'uncertain-description' && warning.itemId) {
      const item = items.get(warning.itemId)!;
      if (!item.name.trim()) continue;
      if (item.name.trim() && item.fieldSources?.name === 'user') continue;
    }
    add(warning);
  }
  let calculatedSubtotal = 0;
  let incomplete = !entry.items.length;
  for (const item of entry.items) {
    if (item.amount === null) {
      incomplete = true;
      add({ code: 'unreadable-amount', itemId: item.id });
    } else {
      if (!Number.isSafeInteger(item.amount) || item.amount < 0 || item.amount > 100000000) {
        throw new Error('Receipt amounts must be non-negative integer hundredths');
      }
      calculatedSubtotal += item.amount;
    }
    if (!item.name.trim()) {
      incomplete = true;
      add({ code: 'uncertain-description', itemId: item.id });
    }
    if (!item.members.length && !entry.percentages) add({ code: 'unassigned-item', itemId: item.id });
    if (item.scanSource?.confidence === 'low'
      && (item.fieldSources?.amount !== 'user' || item.fieldSources?.name !== 'user')) {
      const candidate: ReceiptScanWarning = { code: 'low-confidence', itemId: item.id };
      const resolved = scan.warnings.find(warning => warningKey(warning) === warningKey(candidate) && warning.resolved);
      add(resolved || candidate);
    }
  }
  // Equal names and prices can be distinct purchases. Only repeated physical
  // source-line evidence is a deterministic duplicate suspicion.
  for (const [lineIndex, itemIds] of sourceGroups) {
    if (itemIds.length < 2) continue;
    const candidate: ReceiptScanWarning = { code: 'possible-duplicate', lineIndex, itemIds };
    const resolved = scan.warnings.find(warning => warningKey(warning) === warningKey(candidate) && warning.resolved);
    add(resolved || candidate);
  }
  const calculatedTotal = calculatedSubtotal + entry.tax + entry.tip - entry.discount;
  if (![entry.tax, entry.tip, entry.discount].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100000000)
    || ![calculatedSubtotal, calculatedTotal].every(Number.isSafeInteger)) {
    throw new Error('Receipt amounts must be integer hundredths');
  }
  if (!entry.currency) {
    incomplete = true;
    add({ code: 'ambiguous-currency' });
  }
  if (scan.printedCurrency && scan.printedCurrency !== entry.currency) {
    add({ code: 'currency-mismatch', observedText: scan.printedCurrency });
  }
  if (scan.printedTotal === undefined || scan.printedTotal === null) {
    incomplete = true;
    add({ code: 'missing-printed-total' });
  } else if (calculatedTotal !== scan.printedTotal) {
    add({ code: 'total-mismatch', difference: calculatedTotal - scan.printedTotal });
  }
  if (scan.printedSubtotal !== undefined && scan.printedSubtotal !== null && calculatedSubtotal !== scan.printedSubtotal) {
    add({ code: 'subtotal-mismatch', difference: calculatedSubtotal - scan.printedSubtotal });
  }
  for (const line of scan.sourceLines || []) {
    if ((line.kind !== 'adjustment' && !(typeof line.amount === 'number' && line.amount < 0))
      || (line.mappedTo && line.mappedTo !== 'unmapped')) continue;
    const candidate: ReceiptScanWarning = { code: 'unmapped-adjustment',
      ...(line.lineIndex === undefined ? {} : { lineIndex: line.lineIndex }),
      ...(line.observedText === undefined ? {} : { observedText: line.observedText }),
    };
    const resolved = scan.warnings.find(warning => warningKey(warning) === warningKey(candidate) && warning.resolved);
    add(resolved || candidate);
  }
  if (entry.tax > 0 && scan.sourceLines?.some(line => line.kind === 'tax-summary' && line.mappedTo === 'included')
    && !scan.sourceLines.some(line => line.kind === 'adjustment' && line.mappedTo === 'tax')) {
    const candidate: ReceiptScanWarning = { code: 'included-tax-ambiguous' };
    const resolved = scan.warnings.find(warning => warningKey(warning) === warningKey(candidate) && warning.resolved);
    add(resolved || candidate);
  }
  const unresolved = warnings.filter(warning => !warning.resolved && warning.code !== 'unassigned-item');
  return { ...scan, calculatedSubtotal, calculatedTotal, warnings,
    status: incomplete ? 'incomplete' : unresolved.length ? 'needs-review' : 'matched' };
}

// Synchronous browser/Worker SHA-256 keeps the review fingerprint independent
// of runtime-specific crypto imports. It is an invalidation marker, not auth.
function sha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bytes.length * 8, false);
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const constants = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ];
  const rotate = (number: number, count: number) => (number >>> count) | (number << (32 - count));
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index++) {
      const left = words[index - 15], right = words[index - 2];
      words[index] = words[index - 16] + (rotate(left,7) ^ rotate(left,18) ^ (left >>> 3))
        + words[index - 7] + (rotate(right,17) ^ rotate(right,19) ^ (right >>> 10));
    }
    let [a,b,c,d,e,f,g,h] = state;
    for (let index = 0; index < 64; index++) {
      const first = (h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + constants[index] + words[index]) >>> 0;
      const second = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h=g; g=f; f=e; e=(d+first)>>>0; d=c; c=b; b=a; a=(first+second)>>>0;
    }
    [a,b,c,d,e,f,g,h].forEach((number,index) => { state[index] += number; });
  }
  return Array.from(state).map(number => number.toString(16).padStart(8,'0')).join('');
}

export function receiptScanFingerprint(entry: ScannableReceipt): string {
  // UI acknowledgement and server validation hash the same derived evidence,
  // even after an edit has removed a stale warning from the stored scan.
  const scan = reconcileReceiptScan(entry);
  const financialSources = Object.fromEntries(Object.entries(entry.fieldSources || {})
    .filter(([field]) => ['currency', 'tax', 'tip', 'discount'].includes(field)));
  return `scan-v1:${sha256(canonical({ currency: entry.currency, items: entry.items,
    tax: entry.tax, tip: entry.tip, discount: entry.discount, percentages: entry.percentages,
    fieldSources: Object.keys(financialSources).length ? financialSources : undefined,
    receiptScan: scan && { version: scan.version, printedCurrency: scan.printedCurrency, printedSubtotal: scan.printedSubtotal,
      printedTotal: scan.printedTotal, sourceLines: scan.sourceLines, fieldSources: scan.fieldSources,
      warnings: scan.warnings.filter(warning => !generatedCodes.has(warning.code) && warning.code !== 'unassigned-item'),
      imageIds: scan.imageIds, attemptId: scan.attemptId },
  }))}`;
}

export function receiptScanSaveError(entry: ScannableReceipt, options: {
  allowAcknowledgement?: boolean; previous?: ScannableReceipt;
} = {}): string | null {
  const scan = reconcileReceiptScan(entry);
  if (!scan) return null;
  if (!entry.items.length || !entry.currency || entry.items.some(item => item.amount === null || !item.name.trim())) {
    return 'Complete unreadable receipt values and confirm the currency before saving.';
  }
  let fingerprint: string | undefined;
  const trustedAcknowledgement = (value: string | undefined, previous: string | undefined) => {
    if (!value) return false;
    fingerprint ??= receiptScanFingerprint(entry);
    return value === fingerprint && (options.allowAcknowledgement !== false || previous === fingerprint);
  };
  const missingTotal = scan.printedTotal === undefined || scan.printedTotal === null;
  if (missingTotal && !trustedAcknowledgement(scan.missingTotalAcknowledgement?.fingerprint,
    options.previous?.receiptScan?.missingTotalAcknowledgement?.fingerprint)) {
    return 'Enter the printed receipt total or explicitly confirm that it is unavailable and you reviewed the itemised amount before saving.';
  }
  const unresolved = scan.warnings.filter(warning => !warning.resolved && warning.code !== 'unassigned-item'
    && !(missingTotal && warning.code === 'missing-printed-total'));
  const uncertainties = unresolved.filter(warning => warning.code !== 'subtotal-mismatch' && warning.code !== 'total-mismatch');
  if (uncertainties.length) return 'Review and resolve the receipt scan warnings before saving.';
  if (!unresolved.length) return null;
  const acknowledgement = scan.acknowledgement?.fingerprint;
  if (trustedAcknowledgement(acknowledgement, options.previous?.receiptScan?.acknowledgement?.fingerprint)) return null;
  return 'The itemised amounts do not match the printed receipt. Correct them or explicitly confirm that you reviewed this difference before saving.';
}

/** An AI client cannot manufacture human review acknowledgement/resolutions. */
export function receiptScanHumanReviewChanged(entry: ScannableReceipt, previous?: ScannableReceipt): boolean {
  if (!entry.receiptScan) return false;
  if (entry.receiptScan.acknowledgement && canonical(entry.receiptScan.acknowledgement) !== canonical(previous?.receiptScan?.acknowledgement)) return true;
  if (entry.receiptScan.missingTotalAcknowledgement && canonical(entry.receiptScan.missingTotalAcknowledgement)
    !== canonical(previous?.receiptScan?.missingTotalAcknowledgement)) return true;
  const oldResolutions = new Set((previous?.receiptScan?.warnings || []).filter(warning => warning.resolved).map(warningKey));
  const resolved = entry.receiptScan.warnings.filter(warning => warning.resolved);
  if (resolved.length && previous && receiptScanFingerprint(entry) !== receiptScanFingerprint(previous)) return true;
  return resolved.some(warning => !oldResolutions.has(warningKey(warning)));
}
