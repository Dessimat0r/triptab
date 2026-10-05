import { transpileWithSharedImports } from './helpers/transpile';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JsxEmit, ModuleKind, ScriptTarget } from 'typescript';
import type { ActivityEvent } from '../lib/store';

// Execute the exact activity field formatter used by PR2's History interface.
const source = await readFile(new URL('../components/activity-panel.tsx', import.meta.url), 'utf8');
const compiled = transpileWithSharedImports(source + '\nexport { changes };', {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022, jsx: JsxEmit.ReactJSX },
}).outputText
  .replace('import "./activity-details.css";', '')
  .replace('from "@/lib/money-format"', `from ${JSON.stringify(import.meta.resolve('../lib/money-format.ts'))}`);
const renderer = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')) as {
  changes(event: ActivityEvent, currency: 'GBP', names: Record<string, string>, accountNames?: Record<string, string>): {label: string; before: string; after: string}[];
};
const assistant = {id: 'answer', role: 'assistant', text: 'Service is included.', createdAt: '2026-10-04T12:00:00Z', itemId: 'dinner', authorMemberId: 'alice', authorName: 'Wrong historical Alice'};
const snapshot = (message: Record<string, unknown>) => ({items: [{id: 'dinner', name: 'Dinner', amount: 1000, members: ['alice']}], conversation: [message]});
function event(before: Record<string, unknown>, after: Record<string, unknown>): ActivityEvent {
  return {id: 'saved-history', sequence: 1, tripId: 'holiday', actorId: 'alice-account', actorName: 'Alice', createdAt: '2026-10-04T12:01:00Z', entityType: 'expense', entityId: 'expense', action: 'update',
    before: snapshot(before), after: snapshot(after), revision: 2, source: 'web'};
}

test('legacy assistant stamps never label an AI reply as a human in raw history snapshots', () => {
  const change = event(assistant, {...assistant, text: 'Service is charged separately.', authorName: 'Another incorrect human'});
  const original = structuredClone(change);
  const conversation = renderer.changes(change, 'GBP', {alice: 'Alice'}, {}).find(field => field.label === 'Receipt conversation' || field.label === 'Message changed');
  assert(conversation);
  assert.match(conversation.before, /ChatGPT\/Codex/);
  assert.match(conversation.after, /ChatGPT\/Codex/);
  assert.match(conversation.before, /Dinner/);
  assert.match(conversation.before, /Service is included/);
  assert.match(conversation.after, /Dinner/);
  assert.match(conversation.after, /Service is charged separately/);
  assert.doesNotMatch(conversation.before + conversation.after, /Alice|incorrect human/);
  assert.deepEqual(change, original, 'display labels cannot rewrite immutable audit evidence');
});

test('human messages keep their original saved author names and current-name fallback', () => {
  const before = {...assistant, role: 'user', authorName: 'Earlier Alice'};
  const after = {...before, text: 'Please check this charge.', authorName: undefined};
  const conversation = renderer.changes(event(before, after), 'GBP', {alice: 'Alice'}, {}).find(field => field.label === 'Receipt conversation' || field.label === 'Message changed');
  assert(conversation);
  assert.match(conversation.before, /Earlier Alice/);
  assert.match(conversation.after, /Alice/);
  assert.doesNotMatch(conversation.before + conversation.after, /ChatGPT\/Codex/);
});
