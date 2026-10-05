import { transpileWithSharedImports } from './helpers/transpile';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JsxEmit, ModuleKind, ScriptTarget } from 'typescript';
import type { AuditChange } from '../components/activity-panel';
import type { ActivityEvent } from '../lib/store';

// Execute the actual component module and render its real field component.
// Only CSS loading and import locations are adapted for Node; diff logic and
// descriptions remain the same code used by both history interfaces.
const source = await readFile(new URL('../components/activity-panel.tsx', import.meta.url), 'utf8');
const compiled = transpileWithSharedImports(source + '\nexport { changes, ActivityEventDetails, ActivityDetailBody };', {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX },
}).outputText
  .replace('import "./activity-details.css";', '')
  .replace('from "@/lib/money-format"', `from ${JSON.stringify(import.meta.resolve('../lib/money-format.ts'))}`)
  .replaceAll('from "react"', `from ${JSON.stringify(import.meta.resolve('react'))}`)
  .replaceAll('from "react/jsx-runtime"', `from ${JSON.stringify(import.meta.resolve('react/jsx-runtime'))}`);
const renderer = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')) as {
  changes(event: ActivityEvent, currency: 'GBP', names: Record<string, string>, accountNames: Record<string, string>): AuditChange[];
  ActivityChanges: ComponentType<{ fields: AuditChange[]; before: boolean; after: boolean }>;
  ActivityEventDetails: ComponentType<HistoryDetailProps>;
  ActivityDetailBody: ComponentType<HistoryDetailProps>;
};
type HistoryDetailProps = { event: ActivityEvent; currency: 'GBP'; memberNames: Record<string, string>; actorMemberNames: Record<string, string> };
const names = { alice: 'Alice', bob: 'Bob' };
const question = { id: 'question', role: 'user', text: 'Was service included?', createdAt: '2026-10-04T12:00:00Z', itemId: 'dinner', authorMemberId: 'bob', authorName: 'Bob' };
const assistant = { id: 'answer', role: 'assistant', text: 'Service is already included.', createdAt: '2026-10-04T12:01:00Z', itemId: 'dinner', replyTo: 'question' };
const snapshot = (conversation: Record<string, unknown>[]) => ({ id: 'expense', currency: 'GBP', items: [{ id: 'dinner', name: 'Dinner', amount: 1000, members: ['alice', 'bob'] }], conversation });
function event(before: Record<string, unknown>[], after: Record<string, unknown>[]): ActivityEvent {
  return { id: 'earlier-repair', sequence: 1, tripId: 'holiday', actorId: 'alice-account', actorName: 'Alice',
    createdAt: '2026-10-04T13:00:00Z', entityType: 'expense', entityId: 'expense', action: 'update',
    before: snapshot(before), after: snapshot(after), revision: 2, source: 'web' };
}
function render(change: ActivityEvent) {
  const fields = renderer.changes(change, 'GBP', names, {});
  return { fields, html: renderToStaticMarkup(createElement(renderer.ActivityChanges, { fields, before: true, after: true })) };
}

test('historical assistant-only attribution repair visibly explains the old label without assigning its reply to a human', () => {
  const change = event([question, { ...assistant, authorMemberId: 'alice', authorName: 'Alice' }], [question, assistant]);
  const original = structuredClone(change);
  const { fields, html } = render(change);
  assert.deepEqual(fields.map(field => field.label), ['Assistant attribution corrected']);
  assert.match(fields[0].before, /Incorrectly stored human attribution\nName: Alice\nTraveller: Alice \(traveller alice\)/);
  assert.match(fields[0].after, /ChatGPT\/Codex assistant; no human attribution/);
  assert.notEqual(fields[0].before, fields[0].after);
  for (const description of [fields[0].before, fields[0].after]) {
    assert.match(description, /Reply by ChatGPT\/Codex/);
    assert.match(description, /Service is already included\./);
    assert.match(description, /2026-10-04T12:01:00\.000Z/);
    assert.match(description, /Dinner/);
    assert.match(description, /replying to message question/);
  }
  assert.match(html, /Assistant attribution corrected/);
  assert.doesNotMatch(html, /Reply by Alice|Reply by Bob/);
  assert.deepEqual(change, original, 'history rendering cannot scrub or mutate either raw snapshot');
});

test('body, item context, reply target and role changes remain ordinary message changes', () => {
  const stamped = { ...assistant, authorMemberId: 'alice', authorName: 'Alice' };
  for (const altered of [
    { ...assistant, text: 'Service is charged separately.' },
    { ...assistant, itemId: 'other-item' },
    { ...assistant, replyTo: 'other-question' },
    { ...assistant, role: 'user' },
    { ...assistant, createdAt: '2026-10-04T12:02:00Z' },
  ]) {
    const { fields } = render(event([question, stamped], [question, altered]));
    assert.deepEqual(fields.map(field => field.label), ['Message changed']);
    assert.notEqual(fields[0].before, fields[0].after);
  }
});

test('assistant attribution corrections do not conceal conversation reorders or human author changes', () => {
  const { fields } = render(event([question, { ...assistant, authorName: 'Alice' }], [assistant, question]));
  assert.deepEqual(fields.map(field => field.label), ['Assistant attribution corrected', 'Conversation order']);
  assert.notEqual(fields[1].before, fields[1].after);
  const human = render(event([question], [{ ...question, authorName: 'Earlier Bob' }]));
  assert.deepEqual(human.fields.map(field => field.label), ['Message changed']);
  assert.match(human.html, /Question by Earlier Bob/);
});

test('the correction label requires absent human stamps after the change and safely escapes the stored label', () => {
  const unchanged = render(event([assistant], [assistant]));
  assert.deepEqual(unchanged.fields, []);
  const stillStamped = render(event([{ ...assistant, authorName: 'Alice' }], [{ ...assistant, authorName: 'Bob' }]));
  assert.deepEqual(stillStamped.fields.map(field => field.label), ['Message changed']);
  const correction = render(event([{ ...assistant, authorName: '<img src=x onerror=alert(1)>' }], [assistant]));
  assert.match(correction.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(correction.html, /<img|Reply by &lt;img/);
});

test('closed history details do not inspect or render receipt snapshots', () => {
  const change = event([], []);
  Object.defineProperty(change, 'before', { get() { throw Error('A closed row must not inspect its receipt snapshot'); } });
  Object.defineProperty(change, 'after', { get() { throw Error('A closed row must not inspect its receipt snapshot'); } });
  const html = renderToStaticMarkup(createElement(renderer.ActivityEventDetails, { event: change, currency: 'GBP', memberNames: names, actorMemberNames: {} }));
  assert.match(html, /<details><summary>View changes<\/summary><\/details>/);
  assert.doesNotMatch(html, /activity-changes|activity-identifiers/);
});

test('expanded history details retain every large receipt item and its complete before and after values', () => {
  const change = event([], []);
  change.before = { id: 'expense', currency: 'GBP', items: Array.from({ length: 200 }, (_, index) => ({ id: 'item-' + index, name: 'Before item ' + index, amount: 1000, members: ['alice', 'bob'] })) };
  change.after = { ...change.before, items: (change.before.items as Record<string, unknown>[]).map(item => ({ ...item, name: String(item.name).replace('Before', 'After'), amount: 1200 })) };
  const original = structuredClone(change);
  const html = renderToStaticMarkup(createElement(renderer.ActivityDetailBody, { event: change, currency: 'GBP', memberNames: names, actorMemberNames: {} }));
  assert.equal((html.match(/<dt>Item changed<\/dt>/g) || []).length, 200);
  assert.match(html, /Before item 199/);
  assert.match(html, /After item 199/);
  assert.match(html, /Full line total: £10\.00/);
  assert.match(html, /Full line total: £12\.00/);
  assert.match(html, /2026-10-04T13:00:00\.000Z \(UTC\)/);
  assert.deepEqual(change, original, 'deferred rendering cannot mutate immutable audit snapshots');
});

test('history distinguishes purchased quantities from cost allocations and escapes source text', () => {
  const change = event([], []);
  const item = { id: 'pizza', name: 'Pizza', amount: 800, members: ['alice', 'bob'],
    quantity: { total: 2, label: 'slices', sourceText: '2 x Stck <script>' },
    units: { total: 2, label: 'slices', allocations: { alice: 1.5, bob: 0.5 } } };
  change.before = { id: 'expense', currency: 'GBP', items: [item] };
  change.after = { ...change.before, items: [{ ...item, quantity: { total: 3, label: 'pieces' } }] };
  const original = structuredClone(change);
  const { fields, html } = render(change);
  assert.deepEqual(fields.map(field => field.label), ['Item changed']);
  assert.match(fields[0].before, /Purchased quantity: 2 slices\nReceipt text: 2 x Stck <script>/);
  assert.match(fields[0].after, /Purchased quantity: 3 pieces/);
  for (const detail of [fields[0].before, fields[0].after]) {
    assert.match(detail, /Full line total: £8\.00/);
    assert.match(detail, /Alice \(traveller alice\): 1\.5 slices/);
    assert.match(detail, /Bob \(traveller bob\): 0\.5 slices/);
  }
  assert.match(html, /2 x Stck &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.deepEqual(change, original);
});
