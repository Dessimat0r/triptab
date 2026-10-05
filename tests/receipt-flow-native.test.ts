import assert from 'node:assert/strict';
import test from 'node:test';
import type { Draft, Ledger } from '../lib/model';
import { createReceiptFlowWorker, receiptFlowImage, type ReceiptFlowSnapshot, type ReceiptFlowToolResult } from './helpers/receipt-flow-worker';

function toolValue<T>(response: ReceiptFlowToolResult): T {
  assert.equal(response.error, undefined);
  assert.equal(response.result?.isError, undefined, response.result?.content?.[0]?.text);
  return JSON.parse(response.result?.content?.[0]?.text ?? 'null') as T;
}

test('native receipt HTTP journey uploads privately, stages AI evidence, refreshes, blocks unknown Save and audits a human-approved allocation', async () => {
  const fixture = await createReceiptFlowWorker();
  const { browserRequest, toolCall, readLedger, db, tripId } = fixture;
  try {
    const initial = await readLedger();
    assert.equal(initial.revision, 1);
    const upload = await browserRequest(`/api/receipt?tripId=${tripId}`, {
      method: 'POST', headers: { 'content-type': 'image/png' }, body: receiptFlowImage,
    });
    assert.equal(upload.status, 200, await upload.clone().text());
    const { receiptId } = await upload.json() as { receiptId: string };
    assert.match(receiptId, /^[0-9a-f-]{36}$/);
    const receiptRow = await db.prepare('SELECT owner,trip_id,state FROM receipts WHERE id=?').bind(receiptId).first<{ owner: string; trip_id: string; state: string }>();
    assert.deepEqual(receiptRow, { owner: fixture.owner.id, trip_id: tripId, state: 'active' });
    const waiting: Draft = { id: 'flow-draft', receiptId, title: '', currency: 'GBP', payer: 'alice', status: 'waiting',
      items: [], tax: 0, tip: 0, discount: 0, fieldSources: { title: 'default', currency: 'user', payer: 'user' } };
    initial.data.trips[0].drafts.push(waiting);
    const staged = await browserRequest('/api/ledger', { method: 'POST', body: JSON.stringify(initial) });
    assert.equal(staged.status, 200, await staged.clone().text());
    const waitingSnapshot = await staged.json() as ReceiptFlowSnapshot;
    assert.equal(waitingSnapshot.revision, 2);
    assert.equal((await db.prepare('SELECT state FROM receipts WHERE id=?').bind(receiptId).first<{ state: string }>())?.state, 'active');

    const context = toolValue<{ revision: number; receipt: Draft; callerMemberId: string }>(await toolCall('get_receipt_context', { tripId, draftId: waiting.id }));
    assert.equal(context.revision, 2);
    assert.equal(context.callerMemberId, 'alice');
    assert.equal(context.receipt.status, 'waiting');
    const nativeImage = await toolCall('get_receipt_image', { receipt_id: receiptId });
    assert.equal(nativeImage.result?.isError, undefined);
    assert.equal(nativeImage.result?.content?.[0]?.mimeType, 'image/png');
    assert.deepEqual(Buffer.from(nativeImage.result?.content?.[0]?.data ?? '', 'base64'), Buffer.from(receiptFlowImage));

    // This is a deterministic native-image proposal, not a paid model call.
    const proposal = toolValue<ReceiptFlowSnapshot>(await toolCall('update_receipt_draft', {
      trip_id: tripId, revision: context.revision, draft: { id: waiting.id,
        title: 'Printed receipt merchant', upsertItems: [
          { id: 'pizza', name: 'Pizza pieces', amount: 800, members: [], quantity: { total: 2, label: 'pieces', sourceText: '2 x Stck' },
            units: { total: 2, label: 'pieces', allocations: {} }, scanSource: { lineIndex: 0, observedText: '2 x Stck Pizza 8,00', confidence: 'high' } },
          { id: 'coffee', name: 'Coffee', amount: null, members: [], scanSource: { lineIndex: 1, observedText: 'Coffee ?,00', confidence: 'low' } },
        ], receiptScan: { version: 1, printedTotal: 1200, printedCurrency: 'GBP', sourceLines: [
          { lineIndex: 0, kind: 'item', amount: 800, observedText: '2 x Stck Pizza 8,00' },
          { lineIndex: 1, kind: 'item', amount: null, observedText: 'Coffee ?,00' },
          { lineIndex: 2, kind: 'total', amount: 1200, observedText: 'TOTAL 12,00' },
        ] },
      },
    }));
    assert.equal(proposal.revision, 3);
    assert.equal(proposal.data.trips[0].expenses.length, 0);
    const refreshed = await readLedger();
    assert.equal(refreshed.revision, proposal.revision);
    const draft = refreshed.data.trips[0].drafts[0];
    assert.equal(draft.status, 'review');
    assert.equal(draft.title, 'Printed receipt merchant');
    assert.equal(draft.items[1].amount, null);
    assert.deepEqual(draft.items.map(item => item.members), [[], []]);
    assert.equal(draft.items[0].quantity?.total, 2);
    assert.equal(draft.receiptScan?.status, 'incomplete');
    assert.deepEqual(draft.receiptScan?.imageIds, [receiptId]);
    assert.equal(draft.receiptScan?.processor, 'chatgpt-mcp');
    assert.equal(draft.receiptScan?.fieldSources?.printedTotal, 'receipt');

    const stale = await browserRequest('/api/ledger', { method: 'POST', body: JSON.stringify(waitingSnapshot) });
    assert.equal(stale.status, 409, 'native CAS prevents a stale browser from replacing the MCP proposal');
    const evidenceCount = (await db.prepare('SELECT COUNT(*) AS count FROM activity_events WHERE trip_id=?').bind(tripId).first<{ count: number }>())!.count;
    const incompleteExpense = { ...draft, id: 'flow-expense', sourceDraftId: draft.id, date: '2026-10-05', time: '12:30', timezone: 'Europe/Vienna' };
    delete (incompleteExpense as Partial<Draft>).status;
    const invalidData: Ledger = structuredClone(refreshed.data);
    invalidData.trips[0].drafts = [];
    // Deliberately submit the unknown amount to the real HTTP boundary: the
    // UI guard is useful, but storage must independently refuse it too.
    (invalidData.trips[0].expenses as unknown[]).push(incompleteExpense);
    const unknownSave = await browserRequest('/api/ledger', { method: 'POST', body: JSON.stringify({ revision: refreshed.revision, data: invalidData }) });
    assert.equal(unknownSave.status, 400);
    assert.match((await unknownSave.json() as { error: string }).error, /members|amount|person|number/i);
    assert.equal((await readLedger()).revision, refreshed.revision);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM activity_events WHERE trip_id=?').bind(tripId).first<{ count: number }>())!.count, evidenceCount);

    // A traveller explicitly corrects the unreadable price, chooses who owes
    // each item and confirms the uncertainty. This remains a distinct Save.
    const completeExpense = { ...incompleteExpense, items: draft.items.map(item => ({ ...item, amount: item.id === 'coffee' ? 400 : item.amount,
      members: ['alice', 'bob'], fieldSources: { ...item.fieldSources, name: 'user', amount: 'user' },
      ...(item.id === 'pizza' ? { units: { total: 2, label: 'pieces', allocations: { alice: 1, bob: 1 } } } : {}),
    })), receiptScan: { ...draft.receiptScan!, warnings: draft.receiptScan!.warnings.map(warning => warning.code === 'low-confidence' ? { ...warning, resolved: true } : warning) } };
    const completeData = structuredClone(refreshed.data);
    completeData.trips[0].drafts = [];
    (completeData.trips[0].expenses as unknown[]).push(completeExpense);
    const humanSave = await browserRequest('/api/ledger', { method: 'POST', body: JSON.stringify({ revision: refreshed.revision, data: completeData }) });
    assert.equal(humanSave.status, 200, await humanSave.clone().text());
    const final = await humanSave.json() as ReceiptFlowSnapshot;
    assert.equal(final.revision, 4);
    assert.equal(final.data.trips[0].drafts.length, 0);
    const expense = final.data.trips[0].expenses[0];
    assert.equal(expense.id, 'flow-expense');
    assert.equal(expense.sourceDraftId, waiting.id);
    assert.equal(expense.receiptId, receiptId);
    assert.equal(expense.receiptScan?.status, 'matched');
    assert.equal(expense.receiptScan?.calculatedTotal, 1200);
    assert.deepEqual(expense.items[0].units?.allocations, { alice: 1, bob: 1 });
    const displayedPhoto = await browserRequest(`/api/receipt?id=${receiptId}`);
    assert.equal(displayedPhoto.status, 200);
    assert.deepEqual(Buffer.from(await displayedPhoto.arrayBuffer()), Buffer.from(receiptFlowImage));
    const audit = await db.prepare('SELECT actor_id,entity_type,entity_id,action,source,revision FROM activity_events WHERE trip_id=? ORDER BY sequence').bind(tripId)
      .all<{ actor_id: string; entity_type: string; entity_id: string; action: string; source: string; revision: number }>();
    assert.ok(audit.results.some(row => row.entity_type === 'draft' && row.entity_id === waiting.id && row.action === 'create' && row.source === 'web'));
    assert.ok(audit.results.some(row => row.entity_type === 'draft' && row.entity_id === waiting.id && row.action === 'update' && row.source === 'chatgpt' && row.revision === 3));
    assert.ok(audit.results.some(row => row.entity_type === 'expense' && row.entity_id === expense.id && row.action === 'create' && row.source === 'web' && row.revision === 4));
    assert.ok(audit.results.every(row => row.actor_id === fixture.owner.id));
    const history = await browserRequest(`/api/activity?tripId=${tripId}&expenseId=${expense.id}`);
    assert.equal(history.status, 200, await history.clone().text());
    const events = await history.json() as { events: { entityId: string }[] };
    assert.ok(events.events.some(event => event.entityId === waiting.id), 'posted receipt history includes its draft proposal family');
  } finally { await fixture.dispose(); }
});

test('native receipt flow keeps browser sessions separate from trusted MCP and denies unauthenticated images', async () => {
  const fixture = await createReceiptFlowWorker();
  try {
    const browserMcp = await fixture.browserRequest('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_trip_ledger', arguments: { trip_id: fixture.tripId } } }) });
    assert.equal(browserMcp.status, 401);
    const unauthenticated = await fixture.worker.dispatchFetch(fixture.origin + '/api/ledger');
    assert.equal(unauthenticated.status, 401);
    const upload = await fixture.browserRequest(`/api/receipt?tripId=${fixture.tripId}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: receiptFlowImage });
    const { receiptId } = await upload.json() as { receiptId: string };
    const privatePhoto = await fixture.worker.dispatchFetch(fixture.origin + '/api/receipt?id=' + receiptId);
    assert.equal(privatePhoto.status, 401);
    const foreignTripUpload = await fixture.browserRequest('/api/receipt?tripId=unknown-trip', { method: 'POST', headers: { 'content-type': 'image/png' }, body: receiptFlowImage });
    assert.equal(foreignTripUpload.status, 403);
    assert.equal((await fixture.db.prepare('SELECT COUNT(*) AS count FROM receipt_ai_settings').first<{ count: number }>())?.count, 0, 'no shared API key or provider inference is used');
  } finally { await fixture.dispose(); }
});
