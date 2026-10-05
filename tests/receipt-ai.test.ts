import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { applyReceiptTranscription, consumeReceiptProcessBudget, getChatGPTPlanModel, processReceiptImage, ReceiptAIError, type ReceiptTranscription } from '../lib/receipt-ai';
import { draftSchema, shares, validateLedger, type Draft, type Ledger, type Trip } from '../lib/model';

const owner = 'receipt-ai-owner';
const png = new Uint8Array(await readFile(new URL('../public/icons/icon-192.png', import.meta.url)));
const trip: Trip = {
  id: 'holiday', ownerId: owner, name: 'Private holiday', currency: 'GBP',
  members: [{ id: 'alice', name: 'Alice', userId: owner, email: 'private@example.com' }, { id: 'bob', name: 'Bob' }],
  expenses: [], payments: [], drafts: [],
};
const draft: Draft = {
  id: 'draft', title: 'New receipt', currency: 'GBP', payer: 'alice', items: [],
  tax: 0, tip: 0, discount: 0, receiptId: 'photo', status: 'waiting', source: 'manual',
  memory: { notes: 'Shared context', aliases: [] },
};
const transcription: ReceiptTranscription = {
  title: 'Café 🍎', currency: 'EUR', items: [{ id: null, name: 'Coffee', amount: 250 }, { id: null, name: 'Pastry', amount: 350 }],
  tax: 0, tip: 50, discount: 0, printedTotal: 650, date: '2026-09-28', time: '10:15', summary: 'Read two items and a separate tip.',
};
function completed(output: unknown = transcription) {
  return { type: 'response.completed', response: { status: 'completed', error: null,
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] } };
}
function streamResponse(events: unknown[], options: { split?: number; terminalNewline?: boolean; crlf?: boolean } = {}) {
  const newline = options.crlf ? '\r\n' : '\n';
  let text = events.map(event => `event: ${(event as { type: string }).type}${newline}data: ${JSON.stringify(event)}${newline}${newline}`).join('');
  if (options.terminalNewline === false) text = text.trimEnd();
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += options.split ?? bytes.length) controller.enqueue(bytes.slice(offset, offset + (options.split ?? bytes.length)));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
const input = { accessToken: 'test-credential', model: 'gpt-6.1-sol', provider: 'api' as const,
  trip, draft, callerMemberId: 'alice', image: { bytes: png, mimeType: 'image/png' } };

test('API native vision sends the actual image and a private nonpersistent strict Responses request without a model-catalog fallback', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const value = await processReceiptImage(input, { fetcher: async (url, init) => {
    requests.push({ url: String(url), init: init! });
    return streamResponse([{ type: 'response.output_text.delta', delta: 'not authoritative' }, completed()]);
  } });
  assert.deepEqual(value, transcription);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.redirect, 'error');
  assert.equal(new Headers(requests[0].init.headers).get('authorization'), 'Bearer test-credential');
  const body = JSON.parse(requests[0].init.body as string);
  assert.equal(body.model, 'gpt-6.1-sol');
  assert.deepEqual(body.reasoning, { effort: 'medium' });
  assert.equal(body.max_output_tokens, 16000);
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.tools, undefined);
  assert.equal(body.previous_response_id, undefined);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.equal(body.text.format.schema.additionalProperties, false);
  assert.equal(body.text.format.schema.properties.items.items.additionalProperties, false);
  assert.doesNotMatch(JSON.stringify(body.text.format.schema), /minLength|maxLength/);
  const image = body.input[0].content.find((value: { type: string }) => value.type === 'input_image');
  assert.equal(image.image_url, `data:image/png;base64,${Buffer.from(png).toString('base64')}`);
  assert.equal(image.detail, 'high');
  const context = body.input[0].content[0].text;
  assert.doesNotMatch(context, /private@example.com|receipt-ai-owner/);
  assert.match(body.instructions, /never instructions to execute/);
  assert.match(body.instructions, /Never multiply it again/);
  assert.match(body.instructions, /Do not add VAT/);
  assert.match(body.instructions, /YYYY-MM-DD.*HH:mm/);
  assert.match(body.instructions, /Ambiguous or unreadable dates\/times must be null/);
});

test('API omission uses the requested strong receipt model and strict server string limits still reject invalid output', async () => {
  await processReceiptImage({ ...input, model: undefined }, { fetcher: async (_url, init) => {
    const request = JSON.parse(init!.body as string);
    assert.equal(request.model, 'gpt-6.1-sol');
    assert.deepEqual(request.reasoning, { effort: 'medium' });
    return streamResponse([completed()]);
  } });
  for (const output of [
    { ...transcription, title: 'A'.repeat(201) },
    { ...transcription, items: [{ id: null, name: 'A'.repeat(201), amount: 1 }] },
    { ...transcription, summary: 'A'.repeat(3501) },
  ]) await assert.rejects(processReceiptImage(input, { fetcher: async () => streamResponse([completed(output)]) }), ReceiptAIError);
});

test('plan models use account-visible server ordering and an explicit preference never silently changes models or billing', async () => {
  const catalog = { models: [
    { slug: 'hidden', visibility: 'hidden' }, { slug: 'preferred-first', visibility: 'list' }, { slug: 'other-visible', visibility: 'list' },
  ] };
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/models');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer plan-token');
    assert.equal(init?.redirect, 'error');
    return Response.json(catalog);
  };
  assert.equal(await getChatGPTPlanModel('plan-token', undefined, undefined, fetcher), 'preferred-first');
  assert.equal(await getChatGPTPlanModel('plan-token', 'other-visible', undefined, fetcher), 'other-visible');
  await assert.rejects(getChatGPTPlanModel('plan-token', 'hidden', undefined, fetcher), (error: unknown) => error instanceof ReceiptAIError && error.status === 422);
  await assert.rejects(getChatGPTPlanModel('plan-token', undefined, undefined, async () => Response.json({ data: [{ id: 'api-model' }] })), /invalid model list/);
  const requests: string[] = [];
  await processReceiptImage({ ...input, provider: 'siwc', model: 'other-visible' }, { fetcher: async (url, init) => {
    requests.push(String(url));
    if (String(url).endsWith('/models')) return Response.json(catalog);
    const request = JSON.parse(init!.body as string);
    assert.equal(request.model, 'other-visible');
    assert.equal(request.max_output_tokens, undefined, 'plan preview forbids token-limit parameters');
    assert.equal(request.reasoning, undefined, 'plan preview receives no forced reasoning parameter');
    return streamResponse([completed()]);
  } });
  assert.deepEqual(requests, ['https://api.openai.com/v1/models', 'https://api.openai.com/v1/responses']);
});

test('native vision accepts split UTF-8 SSE, CRLF and a completed event at EOF without using output deltas', async () => {
  for (const options of [{ split: 1 }, { split: 7, crlf: true }, { split: 3, terminalNewline: false }]) {
    const value = await processReceiptImage(input, { fetcher: async () => streamResponse([
      { type: 'response.output_text.delta', delta: '{"title":"wrong"}' }, completed(),
    ], options) });
    assert.deepEqual(value, transcription);
  }
});

test('only a valid completed Responses event can become a receipt proposal', async () => {
  const refused = { type: 'response.completed', response: { status: 'completed', error: null,
    output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Cannot process.' }] }] } };
  for (const events of [
    [], [{ type: 'response.output_text.done', text: JSON.stringify(transcription) }],
    [{ type: 'response.incomplete' }], [{ type: 'response.failed' }], [{ type: 'error' }], [refused],
    [{ ...completed(), response: { ...completed().response, status: 'incomplete' } }],
    [completed({ ...transcription, items: [{ id: null, name: 'Coffee', amount: 2.5 }] })],
    [completed({ ...transcription, date: '2026-02-30' })],
    [completed({ ...transcription, expenseId: 'forged-target' })],
    [completed({ ...transcription, items: [{ id: null, name: 'Coffee', amount: 250, members: ['bob'] }] })],
  ]) {
    await assert.rejects(processReceiptImage(input, { fetcher: async () => streamResponse(events) }), ReceiptAIError);
  }
  await assert.rejects(processReceiptImage(input, { fetcher: async () => Response.json(completed()) }), /completed receipt stream/);
  await assert.rejects(processReceiptImage(input, { fetcher: async () => new Response('data: bad-json\n\n', { headers: { 'content-type': 'text/event-stream' } }) }), /invalid receipt stream/);
});

test('plan usage failures after streaming starts remain failures and never fall back to API billing', async () => {
  let calls = 0;
  await assert.rejects(processReceiptImage({ ...input, provider: 'siwc', model: undefined }, { fetcher: async (url) => {
    calls++;
    return String(url).endsWith('/models') ? Response.json({ models: [{ slug: 'plan-model', visibility: 'list' }] }) : streamResponse([
      { type: 'response.output_text.done', text: JSON.stringify(transcription) },
      { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } },
    ]);
  } }), (error: unknown) => error instanceof ReceiptAIError && error.status === 429 && error.code === 'chatgpt_plan_usage_limit');
  assert.equal(calls, 2);
  await assert.rejects(processReceiptImage(input, { fetcher: async () => Response.json({ error: { message: 'PRIVATE UPSTREAM DIAGNOSTIC' } }, { status: 429 }) }),
    (error: unknown) => error instanceof ReceiptAIError && error.code === 'openai_api_usage_limit' && !error.message.includes('PRIVATE'));
});

test('streamed API quota and credential failures preserve their recovery status without exposing upstream diagnostics', async () => {
  for (const [code, status, publicCode] of [
    ['insufficient_quota', 429, 'openai_api_usage_limit'], ['rate_limit_exceeded', 429, 'openai_api_usage_limit'],
    ['invalid_api_key', 401, 'openai_api_authorization'], ['permission_denied', 403, 'openai_api_authorization'],
  ] as const) {
    await assert.rejects(processReceiptImage(input, { fetcher: async () => streamResponse([
      { type: 'response.output_text.delta', delta: JSON.stringify(transcription) },
      { type: 'response.failed', response: { error: { code, message: 'PRIVATE PROVIDER DIAGNOSTICS' } } },
    ]) }), (error: unknown) => error instanceof ReceiptAIError && error.status === status && error.code === publicCode && !error.message.includes('PRIVATE'));
  }
});

test('native top-level error SSE events retain API and plan quota/auth recovery without trusting their diagnostic message', async () => {
  for (const [provider, code, status] of [
    ['api', 'insufficient_quota', 429], ['api', 'invalid_api_key', 401],
    ['siwc', 'subscription_sharing_usage_limit_exceeded', 429], ['siwc', 'subscription_sharing_invalid_user', 401],
  ] as const) {
    await assert.rejects(processReceiptImage({ ...input, provider }, { fetcher: async (url) =>
      String(url).endsWith('/models') ? Response.json({ models: [{ slug: input.model, visibility: 'list' }] })
        : streamResponse([{ type: 'error', code, message: 'PRIVATE STREAM ERROR DETAIL' }]),
    }), (error: unknown) => error instanceof ReceiptAIError && error.status === status && !error.message.includes('PRIVATE'));
  }
});

test('invalid image/context, oversized streams, network faults and cancellation cannot produce a proposal', async () => {
  for (const image of [{ bytes: png, mimeType: 'image/gif' }, { bytes: new Uint8Array(), mimeType: 'image/png' }, { bytes: new Uint8Array(5 * 1024 * 1024 + 1), mimeType: 'image/png' }]) {
    await assert.rejects(processReceiptImage({ ...input, image }, { fetcher: async () => { assert.fail('invalid image must not contact a model'); } }), /saved JPEG/);
  }
  await assert.rejects(processReceiptImage({ ...input, questionId: 'missing-question' }, { fetcher: async () => { assert.fail('invalid question must not contact a model'); } }), /saved user question/);
  await assert.rejects(processReceiptImage(input, { fetcher: async () => new Response(`:${'x'.repeat(1_000_001)}`, { headers: { 'content-type': 'text/event-stream' } }) }), /too large/);
  await assert.rejects(processReceiptImage(input, { fetcher: async () => { throw new Error('PRIVATE NETWORK DETAILS'); } }),
    (error: unknown) => error instanceof ReceiptAIError && error.status === 503 && !error.message.includes('PRIVATE'));
  await assert.rejects(processReceiptImage(input, { signal: AbortSignal.abort(), fetcher: async () => { throw new Error('aborted'); } }),
    (error: unknown) => error instanceof ReceiptAIError && error.status === 408);
});

test('the native request treats saved human/item context as data and omits legacy assistant attribution', async () => {
  const contextual: Draft = { ...draft, conversation: [
    { id: 'question', role: 'user', text: 'Does this include service?', itemId: 'removed-line', authorMemberId: 'bob', authorName: 'Bob', createdAt: '2026-10-04T10:00:00Z' },
    { id: 'legacy-ai', role: 'assistant', text: 'Earlier answer', authorMemberId: 'alice', authorName: 'Alice', createdAt: '2026-10-04T10:01:00Z' },
  ] };
  await processReceiptImage({ ...input, draft: contextual, questionId: 'question' }, { fetcher: async (_url, init) => {
    const context = JSON.parse(JSON.parse(init!.body as string).input[0].content[0].text.split('\n').slice(1).join('\n'));
    assert.equal(context.callerMemberId, 'alice');
    assert.equal(context.speakerMemberId, 'bob');
    assert.equal(context.questionItemId, 'removed-line');
    assert.equal(context.receipt.conversation[0].authorMemberId, 'bob');
    assert.equal(context.receipt.conversation[1].authorMemberId, undefined);
    assert.equal(context.receipt.conversation[1].authorName, undefined);
    return streamResponse([completed()]);
  } });
});

test('image projection creates review-only item rows with server IDs/default shares, preserving metadata, questions, memory and any expense target', () => {
  const original: Draft = { ...draft, expenseId: 'approved-expense', date: '2026-10-01', time: '19:00', timezone: 'Europe/London',
    fx: { rate: 1, source: 'manual', asOf: '2026-10-01' }, bankAmount: 650,
    conversation: [{ id: 'question', role: 'user', text: 'Please read it.', authorMemberId: 'alice', authorName: 'Alice', createdAt: '2026-10-04T10:00:00Z' }],
  };
  const before = structuredClone(original);
  const result = applyReceiptTranscription(trip, original, transcription, 'question');
  assert.deepEqual(original, before);
  assert.equal(result.status, 'review');
  assert.equal(result.source, 'ai');
  assert.equal(result.receiptId, 'photo');
  assert.equal(result.expenseId, 'approved-expense');
  assert.equal(result.currency, 'EUR');
  assert.equal(result.fx, undefined);
  assert.equal(result.bankAmount, undefined);
  assert.equal(result.date, original.date);
  assert.equal(result.time, original.time);
  assert.equal(result.timezone, original.timezone);
  assert.deepEqual(result.memory, original.memory);
  assert.deepEqual(result.items.map(({ id, ...item }) => { assert.match(id, /^[0-9a-f-]{36}$/); return item; }),
    [{ name: 'Coffee', amount: 250, members: ['alice', 'bob'] }, { name: 'Pastry', amount: 350, members: ['alice', 'bob'] }]);
  assert.equal(new Set(result.items.map(item => item.id)).size, 2);
  assert.deepEqual(result.conversation![0], original.conversation![0]);
  assert.equal(result.conversation![1].role, 'assistant');
  assert.equal(result.conversation![1].replyTo, 'question');
  assert.equal(result.conversation![1].authorMemberId, undefined);
  assert.equal(result.conversation![1].authorName, undefined);
  assert.match(result.conversation![1].text, /share their cost equally/);
});

test('corrections retain exact saved item shares and remainder pennies, original currency bank details and inherited question context', () => {
  const existing: Draft = { ...draft, currency: 'EUR', items: [
    { id: 'line', name: 'Chocolate', amount: 1001, members: ['bob', 'alice'], units: { total: 3, label: 'bars', allocations: { bob: 1.5, alice: 1.5 } } },
  ], fx: { rate: 0.85, source: 'manual', asOf: '2026-10-01' }, bankAmount: 851,
  conversation: [{ id: 'question', role: 'user', text: 'Is this the correct price?', itemId: 'line', createdAt: '2026-10-04T10:00:00Z' }] };
  const result = applyReceiptTranscription(trip, existing, { ...transcription, items: [{ id: 'line', name: 'Chocolate bars', amount: 1001 }], tip: 0, printedTotal: 1001 }, 'question');
  assert.deepEqual(result.items[0].members, ['bob', 'alice']);
  assert.deepEqual(result.items[0].units, existing.items[0].units);
  assert.deepEqual(shares(result, trip.members), shares(existing, trip.members));
  assert.deepEqual(result.fx, existing.fx);
  assert.equal(result.bankAmount, existing.bankAmount);
  assert.equal(result.conversation!.at(-1)!.itemId, 'line');
});

test('initial itemisation retains whole-receipt percentage splits and its summary accurately describes the resulting shares', () => {
  const result = applyReceiptTranscription(trip, { ...draft, percentages: { alice: 70, bob: 30 } }, transcription);
  assert.deepEqual(result.percentages, { alice: 70, bob: 30 });
  assert.deepEqual(shares(result, trip.members), [455, 195]);
  assert.match(result.conversation!.at(-1)!.text, /saved whole-receipt percentage split/);
  assert.doesNotMatch(result.conversation!.at(-1)!.text, /share their cost equally/);
});

test('printed purchase details replace browser placeholders only on an opted-in initial blank draft and preserve existing manual or posted details', () => {
  const placeholder: Draft = { ...draft, date: '2026-10-04', time: '12:00', timezone: 'Europe/London',
    items: [{ id: 'blank', name: '', amount: 0, members: ['alice', 'bob'] }] };
  const initial = applyReceiptTranscription(trip, placeholder, transcription, undefined, { readPurchaseDetails: true });
  assert.equal(initial.date, '2026-09-28');
  assert.equal(initial.time, '10:15');
  assert.equal(initial.timezone, 'Europe/London');
  const manual = applyReceiptTranscription(trip, placeholder, transcription);
  assert.equal(manual.date, placeholder.date);
  assert.equal(manual.time, placeholder.time);
  for (const protectedDraft of [
    { ...placeholder, expenseId: 'posted-expense' },
    { ...placeholder, status: 'review' as const },
    { ...placeholder, items: [{ id: 'manual-line', name: 'Already entered', amount: 500, members: ['alice'] }] },
    { ...placeholder, tip: 100 },
    { ...placeholder, currency: 'EUR' as const, bankAmount: 650 },
  ]) {
    const result = applyReceiptTranscription(trip, protectedDraft, transcription, undefined, { readPurchaseDetails: true });
    assert.equal(result.date, placeholder.date);
    assert.equal(result.time, placeholder.time);
  }
  const unreadableDate = applyReceiptTranscription(trip, placeholder, { ...transcription, date: null, time: null }, undefined, { readPurchaseDetails: true });
  assert.equal(unreadableDate.date, placeholder.date);
  assert.equal(unreadableDate.time, placeholder.time);
});

test('transcription refuses unknown/duplicate item IDs, invalid totals and schema-injected fields without inventing balancing lines', () => {
  for (const value of [
    { ...transcription, items: [{ id: 'foreign-line', name: 'Coffee', amount: 250 }] },
    { ...transcription, discount: 651 },
    { ...transcription, items: [{ id: null, name: 'Coffee', amount: 100000000 }], tax: 1 },
    { ...transcription, payer: 'bob' },
  ]) assert.throws(() => applyReceiptTranscription(trip, draft, value), ReceiptAIError);
  const existing = { ...draft, items: [{ id: 'line', name: 'Coffee', amount: 250, members: ['alice'] }] };
  assert.throws(() => applyReceiptTranscription(trip, existing, { ...transcription, items: [{ id: 'line', name: 'Coffee', amount: 250 }, { id: 'line', name: 'Duplicate', amount: 250 }] }), /duplicate/);
  const result = applyReceiptTranscription(trip, draft, { ...transcription, printedTotal: 750 });
  assert.equal(result.items.length, 2);
  assert.equal(result.tax, 0);
  assert.match(result.conversation!.at(-1)!.text, /printed total \(7.50 EUR\).*extracted total \(6.50 EUR\)/);
});

function budgetStorage() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE auth_rate_limits(key_hash TEXT PRIMARY KEY,window_start INTEGER NOT NULL,attempts INTEGER NOT NULL)');
  const statements: string[] = [];
  const database = { prepare(sql: string) { statements.push(sql); return { bind(...values: (string | number)[]) { return {
    async first() { return sqlite.prepare(sql).get(...values) ?? null; }, async run() { return sqlite.prepare(sql).run(...values); },
  }; } }; } } as unknown as D1Database;
  return { sqlite, database, statements };
}

test('the atomic receipt budget allows six attempts per account per minute independently of login/other users and bounds expired cleanup', async () => {
  const { sqlite, database, statements } = budgetStorage();
  const now = 6_000_000;
  sqlite.prepare('INSERT INTO auth_rate_limits VALUES(?,?,?)').run('live-login-budget', now, 10);
  for (let index = 0; index < 200; index++) sqlite.prepare('INSERT INTO auth_rate_limits VALUES(?,?,?)').run(`expired-${index}`, 0, 1);
  await consumeReceiptProcessBudget(database, owner, { now, provider: 'siwc' });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM auth_rate_limits WHERE window_start=0').get()!.n, 150);
  for (let attempt = 1; attempt < 5; attempt++) await consumeReceiptProcessBudget(database, owner, { now, provider: 'siwc' });
  const races = await Promise.allSettled(Array.from({ length: 3 }, () => consumeReceiptProcessBudget(database, owner, { now, provider: 'siwc' })));
  assert.equal(races.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of races.filter(result => result.status === 'rejected')) assert.ok(result.reason instanceof ReceiptAIError && result.reason.status === 429);
  await consumeReceiptProcessBudget(database, 'other-account', { now, provider: 'siwc' });
  await consumeReceiptProcessBudget(database, owner, { now: now + 60_000, provider: 'siwc' });
  assert.equal(sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE key_hash=?').get('live-login-budget')!.attempts, 10);
  assert.ok(statements.filter(sql => sql.startsWith('DELETE')).every(sql => sql.includes('LIMIT 50')));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM auth_rate_limits WHERE key_hash LIKE ?').get(`%${owner}%`)!.n, 0);
  sqlite.close();
});

test('the shared API minute limit is atomic across participants and per-user refusals cannot drain it', async () => {
  const { sqlite, database } = budgetStorage();
  const now = Date.UTC(2026, 9, 4, 12);
  for (let index = 0; index < 6; index++) await consumeReceiptProcessBudget(database, owner, { now, provider: 'api' });
  for (let index = 0; index < 20; index++) await assert.rejects(consumeReceiptProcessBudget(database, owner, { now, provider: 'api' }), { code: 'receipt_processing_rate_limit' });
  assert.equal(sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE window_start>?').get(now)!.attempts, 6);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM auth_rate_limits WHERE attempts=6').get()!.n, 2, 'both shared counters remain unchanged');
  for (let index = 0; index < 52; index++) await consumeReceiptProcessBudget(database, `participant-${index}`, { now, provider: 'api' });
  const races = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => consumeReceiptProcessBudget(database, `racer-${index}`, { now, provider: 'api' })));
  assert.equal(races.filter(result => result.status === 'fulfilled').length, 2);
  for (const result of races.filter(result => result.status === 'rejected')) assert.equal(result.reason.code, 'receipt_processing_shared_minute_limit');
  assert.equal(sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE window_start>?').get(now)!.attempts, 60);
  await consumeReceiptProcessBudget(database, 'personal-plan-participant', { now, provider: 'siwc' });
  assert.equal(sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE window_start>?').get(now)!.attempts, 60, 'individual SIWC usage does not spend the shared API allowance');
  await consumeReceiptProcessBudget(database, owner, { now: now + 60_000, provider: 'api' });
  assert.equal(sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE window_start>?').get(now + 60_000)!.attempts, 61);
  sqlite.close();
});

test('the shared daily API cap survives minute/auth cleanup and resets only on the next UTC day', async () => {
  const { sqlite, database } = budgetStorage();
  const now = Date.UTC(2026, 9, 4, 12);
  for (let index = 0; index < 500; index++) {
    await consumeReceiptProcessBudget(database, `participant-${index}`, { now: now + Math.floor(index / 50) * 60_000, provider: 'api' });
  }
  assert.equal(sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE window_start>?').get(now + 600_000)!.attempts, 500);
  // Exercise the same expiration predicate used by shared auth/MCP maintenance.
  for (let cleanup = 0; cleanup < 15; cleanup++) sqlite.prepare('DELETE FROM auth_rate_limits WHERE key_hash IN (SELECT key_hash FROM auth_rate_limits WHERE window_start < ? LIMIT 50)').run(now + 3_600_000);
  assert.equal(sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE window_start>?').get(now + 3_600_000)!.attempts, 500);
  await assert.rejects(consumeReceiptProcessBudget(database, 'new-account-after-cleanup', { now: now + 7_200_000, provider: 'api' }), { status: 429, code: 'receipt_processing_shared_daily_limit' });
  await consumeReceiptProcessBudget(database, 'individual-plan-after-cap', { now: now + 7_200_000, provider: 'siwc' });
  const tomorrow = Date.UTC(2026, 9, 5);
  await consumeReceiptProcessBudget(database, 'new-account-after-cleanup', { now: tomorrow, provider: 'api' });
  assert.equal(sqlite.prepare('SELECT attempts FROM auth_rate_limits WHERE window_start>?').get(tomorrow)!.attempts, 1);
  sqlite.close();
});

// Exercise the real HTTP handler and processing/validation with only its
// identity, credential and storage boundaries substituted. No provider calls.
const state = { data: { trips: [{ ...structuredClone(trip), drafts: [structuredClone(draft)] }] } as Ledger,
  revision: 7, profileId: owner, accessAllowed: true, metadataAllowed: true, imagePresent: true, imageType: 'image/png', imageSize: png.length,
  writes: 0, accessCalls: 0, providerCalls: 0, profileChecks: 0, savedSources: [] as string[],
  duringModel: undefined as (() => void) | undefined, invalidOutput: false, actorChanged: false };
function reset() {
  state.data = { trips: [{ ...structuredClone(trip), drafts: [structuredClone(draft)] }] };
  state.revision = 7; state.profileId = owner; state.accessAllowed = true; state.metadataAllowed = true;
  state.imagePresent = true; state.imageType = 'image/png'; state.imageSize = png.length;
  state.writes = 0; state.accessCalls = 0; state.providerCalls = 0; state.profileChecks = 0; state.savedSources = [];
  state.duringModel = undefined; state.invalidOutput = false; state.actorChanged = false;
  budgetDatabase.exec('DELETE FROM auth_rate_limits');
}
const budgetDatabase = new DatabaseSync(':memory:');
budgetDatabase.exec('CREATE TABLE auth_rate_limits(key_hash TEXT PRIMARY KEY,window_start INTEGER NOT NULL,attempts INTEGER NOT NULL)');
class BoundaryRequestError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
class BoundaryAccessError extends Error { constructor(message: string, readonly status = 403, readonly code = 'credential_denied') { super(message); } }
const store = {
  RequestError: BoundaryRequestError,
  sameOrigin(request: Request) { if (request.headers.get('origin') !== new URL(request.url).origin) throw new BoundaryRequestError('Invalid origin', 403); },
  async ensureProfile() { state.profileChecks++; return { id: state.actorChanged && state.profileChecks > 1 ? 'changed-account' : state.profileId }; },
  async readBoundedBody(request: Request, maximum: number) { const bytes = new Uint8Array(await request.arrayBuffer()); if (bytes.length > maximum) throw new BoundaryRequestError('Too large', 413); return bytes; },
  async readLedger(actor: string) { return { data: actor === owner ? structuredClone(state.data) : { trips: [] }, revision: state.revision }; },
  async receiptAccess() { return state.metadataAllowed ? { owner, tripId: trip.id } : null; },
  receiptKey(actor: string, id: string) { return `${encodeURIComponent(actor)}/${id}`; },
  bucket() { return { async get() { return state.imagePresent ? { size: state.imageSize, httpMetadata: { contentType: state.imageType }, async arrayBuffer() { return Uint8Array.from(png).buffer; } } : null; } }; },
  db() { return { prepare(sql: string) { return { bind(...values: (string | number)[]) { return {
    async first() { return budgetDatabase.prepare(sql).get(...values) ?? null; }, async run() { return budgetDatabase.prepare(sql).run(...values); },
  }; } }; } }; },
  async writeLedger(actor: string, data: Ledger, revision: number, options: { source: string }) {
    assert.equal(actor, owner); if (revision !== state.revision) throw new Error('CONFLICT');
    state.data = validateLedger(data, { previous: state.data }); state.revision++; state.writes++; state.savedSources.push(options.source);
    return { data: structuredClone(state.data), revision: state.revision };
  },
  failure(error: unknown) { return Response.json({ error: error instanceof Error ? error.message : 'Failure' }, { status: error instanceof BoundaryRequestError ? error.status : error instanceof Error && error.message === 'CONFLICT' ? 409 : 400 }); },
};
const credentialAccess = {
  ReceiptAIAccessError: BoundaryAccessError,
  async getReceiptAIAccess() { state.accessCalls++; if (!state.accessAllowed) throw new BoundaryAccessError('This account cannot use the receipt key.'); return { accessToken: 'test-api-key', model: 'gpt-6.1-sol', provider: 'api' }; },
};
const dataUrl = (source: string) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
Object.defineProperty(globalThis, Symbol.for('triptab.receipt-ai-route-store'), { value: store, configurable: true });
Object.defineProperty(globalThis, Symbol.for('triptab.receipt-ai-route-access'), { value: credentialAccess, configurable: true });
const storeUrl = dataUrl(`const store=globalThis[Symbol.for('triptab.receipt-ai-route-store')];\n${Object.keys(store).map(name => `export const ${name}=store.${name};`).join('\n')}`);
const accessUrl = dataUrl(`const access=globalThis[Symbol.for('triptab.receipt-ai-route-access')];\n${Object.keys(credentialAccess).map(name => `export const ${name}=access.${name};`).join('\n')}`);
const routeSource = await readFile(new URL('../app/api/receipt/process/route.ts', import.meta.url), 'utf8');
const routeCode = transpileModule(routeSource, { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText
  .replace("'cloudflare:workers'", JSON.stringify(dataUrl('export const env={};')))
  .replace("'@/lib/store'", JSON.stringify(storeUrl)).replace("'@/lib/receipt-ai-access'", JSON.stringify(accessUrl))
  .replace("'@/lib/receipt-ai'", JSON.stringify(new URL('../lib/receipt-ai.ts', import.meta.url).href))
  .replace("'zod'", JSON.stringify(import.meta.resolve('zod')));
const route = await import(dataUrl(routeCode)) as { POST(request: Request): Promise<Response> };
const requestBody = { tripId: trip.id, draftId: draft.id, receiptId: 'photo', revision: 7 };
async function http(body: unknown = requestBody, headers: Record<string, string> = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    state.providerCalls++; state.duringModel?.();
    return streamResponse([completed(state.invalidOutput ? { ...transcription, payer: 'forged' } : transcription)]);
  };
  try { return await route.POST(new Request('https://triptab.test/api/receipt/process', {
    method: 'POST', headers: { origin: 'https://triptab.test', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })); } finally { globalThis.fetch = originalFetch; }
}

test('HTTP receipt processing saves native extraction to the exact draft for review and preserves all approved money', async () => {
  reset();
  const posted = { id: 'approved', title: 'Already approved', currency: 'GBP' as const, payer: 'alice', tax: 0, tip: 0, discount: 0,
    items: [{ id: 'approved-line', name: 'Dinner', amount: 3000, members: ['alice'] }], date: '2026-09-01', time: '12:00', timezone: 'Europe/London' };
  const normalized = validateLedger({ trips: [{ ...state.data.trips[0], expenses: [posted] }] });
  state.data = normalized;
  state.data.trips[0].drafts[0].expenseId = 'approved';
  const approved = structuredClone(state.data.trips[0].expenses);
  const response = await http();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('etag'), null);
  const saved = await response.json() as { data: Ledger; revision: number; draft: Draft };
  assert.equal(saved.revision, 8);
  assert.equal(saved.draft.id, 'draft');
  assert.equal(saved.draft.receiptId, 'photo');
  assert.equal(saved.draft.expenseId, 'approved');
  assert.equal(saved.draft.status, 'review');
  assert.equal(saved.draft.source, 'ai');
  assert.equal(saved.draft.items.length, 2);
  assert.deepEqual(saved.data.trips[0].expenses, approved);
  assert.deepEqual(state.savedSources, ['web']);
  assert.equal(state.providerCalls, 1);
  assert.equal(state.profileChecks, 2);
});

test('HTTP refuses wrong account/trip/draft/image/revision and foreign or malformed requests before a model or key lookup', async () => {
  const scenarios: { body: unknown; status: number; headers?: Record<string, string> }[] = [
    { body: { ...requestBody, tripId: 'other' }, status: 404 },
    { body: { ...requestBody, draftId: 'other' }, status: 404 },
    { body: { ...requestBody, receiptId: 'other' }, status: 409 },
    { body: { ...requestBody, revision: 6 }, status: 409 },
    { body: { ...requestBody, questionId: 'other' }, status: 400 },
    { body: { ...requestBody, payer: 'bob' }, status: 400 },
    { body: requestBody, headers: { origin: 'https://evil.test' }, status: 403 },
    { body: requestBody, headers: { 'sec-fetch-site': 'cross-site' }, status: 403 },
    { body: requestBody, headers: { 'content-type': 'text/plain' }, status: 415 },
  ];
  for (const scenario of scenarios) {
    reset(); const before = structuredClone(state.data);
    const response = await http(scenario.body, scenario.headers);
    assert.equal(response.status, scenario.status);
    assert.equal(state.accessCalls, 0); assert.equal(state.providerCalls, 0); assert.equal(state.writes, 0);
    assert.deepEqual(state.data, before);
  }
  reset(); state.profileId = 'outsider';
  assert.equal((await http()).status, 404);
  assert.equal(state.accessCalls, 0); assert.equal(state.providerCalls, 0);
});

test('HTTP missing/unsupported/oversized/deleted images and credential refusal cannot start inference or save a draft', async () => {
  for (const problem of ['missing', 'metadata', 'type', 'oversized', 'credential'] as const) {
    reset();
    if (problem === 'missing') state.imagePresent = false;
    if (problem === 'metadata') state.metadataAllowed = false;
    if (problem === 'type') state.imageType = 'image/gif';
    if (problem === 'oversized') state.imageSize = 5 * 1024 * 1024 + 1;
    if (problem === 'credential') state.accessAllowed = false;
    const before = structuredClone(state.data), response = await http();
    assert.equal(response.status, problem === 'credential' ? 403 : problem === 'oversized' ? 413 : 404);
    assert.equal(state.providerCalls, 0); assert.equal(state.writes, 0);
    assert.deepEqual(state.data, before);
  }
});

test('HTTP changes during native inference reject late results without reverting the latest data or changing approved expenses', async () => {
  for (const race of ['revision', 'same-revision-photo', 'same-revision-question', 'membership', 'account', 'deletion'] as const) {
    reset();
    state.duringModel = () => {
      if (race === 'revision') state.revision++;
      if (race === 'same-revision-photo') state.data.trips[0].drafts[0].receiptId = 'replacement-photo';
      if (race === 'same-revision-question') state.data.trips[0].drafts[0].memory = { notes: 'New trusted context', aliases: [] };
      if (race === 'membership') state.metadataAllowed = false;
      if (race === 'account') state.actorChanged = true;
      if (race === 'deletion') state.data.trips[0].drafts = [];
    };
    const response = await http();
    assert.equal(response.status, 409, race);
    assert.equal(state.providerCalls, 1); assert.equal(state.writes, 0);
    assert.equal(state.data.trips[0].expenses.length, 0);
    if (race === 'same-revision-photo') assert.equal(state.data.trips[0].drafts[0].receiptId, 'replacement-photo');
    if (race === 'same-revision-question') assert.equal(state.data.trips[0].drafts[0].memory!.notes, 'New trusted context');
    if (race === 'deletion') assert.equal(state.data.trips[0].drafts.length, 0);
  }
});

test('HTTP invalid completed model output leaves the original waiting draft intact', async () => {
  reset(); state.invalidOutput = true;
  const before = structuredClone(state.data), response = await http();
  assert.equal(response.status, 502);
  assert.deepEqual(state.data, before);
  assert.equal(state.writes, 0);
  assert.equal(state.revision, 7);
  assert.equal(draftSchema.parse(state.data.trips[0].drafts[0]).status, 'waiting');
});

test('HTTP does not reinterpret a saved natural-language share question as initial image transcription', async () => {
  reset();
  state.data.trips[0].drafts[0].conversation = [{ id: 'share-question', role: 'user', text: 'Give Bob two bars and me one.', createdAt: '2026-10-04T10:00:00Z' }];
  const response = await http({ ...requestBody, questionId: 'share-question' });
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /connected ChatGPT tools.*change item shares/);
  assert.equal(state.accessCalls, 0);
  assert.equal(state.providerCalls, 0);
  assert.equal(state.writes, 0);
});
