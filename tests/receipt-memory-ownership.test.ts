import assert from 'node:assert/strict';
import test from 'node:test';
import { receiptMemorySchema, type ReceiptMemory } from '../lib/receipt-context';
import { ReceiptMemoryOwnershipError, receiptAliasIdentity, validateReceiptMemoryOwnership } from '../lib/receipt-memory-ownership';

const active = new Set(['alice', 'bob']);
const bobAlias = { name: 'my snack', itemId: 'snack', scopeMemberId: 'bob' };
const aliceAlias = { name: 'my drink', itemId: 'drink', scopeMemberId: 'alice' };
const memory = (aliases: ReceiptMemory['aliases'], notes = 'Shared receipt notes'): ReceiptMemory => ({ notes, aliases });
const denied = (previous: ReceiptMemory | undefined, incoming: ReceiptMemory | undefined, actor: string | undefined = 'alice', members = active) => {
  assert.throws(() => validateReceiptMemoryOwnership(previous, incoming, actor, members), ReceiptMemoryOwnershipError);
};

test('active other-speaker aliases cannot be dropped or rewritten by a retained-receipt memory replacement', () => {
  const previous = memory([bobAlias]);
  for (const incoming of [
    undefined,
    memory([]),
    memory([{ ...bobAlias, name: 'renamed' }]),
    memory([{ ...bobAlias, itemId: 'another-item' }]),
    memory([{ name: bobAlias.name, memberId: 'bob', scopeMemberId: 'bob' }]),
    memory([{ ...bobAlias, scopeMemberId: 'alice' }]),
    memory([{ name: bobAlias.name, itemId: bobAlias.itemId }]),
  ]) denied(previous, incoming);
  assert.deepEqual(previous, memory([bobAlias]));
});

test('existing active-speaker aliases remain protected even when their item or traveller target is gone', () => {
  const previous = memory([{ ...bobAlias, itemId: 'removed-item' }, { name: 'old friend', memberId: 'removed-target', scopeMemberId: 'bob' }]);
  assert.deepEqual(validateReceiptMemoryOwnership(previous, memory([...previous.aliases].reverse(), 'New shared notes'), 'alice', active), []);
  denied(previous, memory([]));
});

test('removing a scoped traveller releases its saved aliases without permitting new foreign claims', () => {
  const previous = memory([bobAlias]);
  const remainingMembers = new Set(['alice']);
  assert.deepEqual(validateReceiptMemoryOwnership(previous, memory([], 'Bob has left the holiday'), 'alice', remainingMembers), []);
  assert.deepEqual(validateReceiptMemoryOwnership(previous, undefined, 'alice', remainingMembers), []);
  assert.deepEqual(validateReceiptMemoryOwnership(previous, memory([bobAlias]), 'alice', remainingMembers), []);
  denied(previous, memory([{ ...bobAlias, name: 'rewritten removed speaker' }]), 'alice', remainingMembers);
  denied(undefined, memory([bobAlias]), 'alice', remainingMembers);
  denied(previous, memory([bobAlias, bobAlias]), 'alice', remainingMembers);
});

test('the fifty-alias cap can be freed by removing inactive scopes while retaining compatible history', () => {
  const previous = receiptMemorySchema.parse(memory(Array.from({ length: 50 }, (_, index) => ({
    name: `former-${index}`, itemId: `old-item-${index}`, scopeMemberId: 'former-traveller',
  }))));
  const incoming = receiptMemorySchema.parse(memory([...previous.aliases.slice(1), aliceAlias], 'One obsolete alias removed'));
  assert.equal(incoming.aliases.length, 50);
  assert.deepEqual(validateReceiptMemoryOwnership(previous, incoming, 'alice', active), [aliceAlias]);
  assert.equal(previous.aliases.length, 50);
});

test('new scoped claims require the trusted actor’s active member identity', () => {
  denied(undefined, memory([bobAlias]));
  assert.throws(() => validateReceiptMemoryOwnership(undefined, memory([aliceAlias]), undefined, active), ReceiptMemoryOwnershipError);
  denied(undefined, memory([aliceAlias]), 'alice', new Set(['bob']));
  assert.deepEqual(validateReceiptMemoryOwnership(undefined, memory([aliceAlias]), 'alice', active), [aliceAlias]);
  assert.deepEqual(validateReceiptMemoryOwnership(undefined, memory([{ name: 'shared drink', itemId: 'drink' }]), undefined, active),
    [{ name: 'shared drink', itemId: 'drink' }]);
});

test('own aliases, shared aliases and shared notes remain collaborative', () => {
  const previous = memory([bobAlias, aliceAlias, { name: 'shared snack', itemId: 'snack' }]);
  const replacement = { name: 'me', memberId: 'alice', scopeMemberId: 'alice' };
  const shared = { name: 'shared drink', itemId: 'drink' };
  const incoming = memory([shared, bobAlias, replacement], 'Collaboratively corrected notes');
  assert.deepEqual(validateReceiptMemoryOwnership(previous, incoming, 'alice', active), [shared, replacement]);
  assert.deepEqual(validateReceiptMemoryOwnership(memory([aliceAlias, shared]), undefined, 'alice', active), []);
});

test('saved duplicate aliases are matched individually instead of allowing another speaker’s entry to disappear or multiply', () => {
  const previous = memory([bobAlias, bobAlias]);
  assert.deepEqual(validateReceiptMemoryOwnership(previous, memory([bobAlias, bobAlias]), 'alice', active), []);
  denied(previous, memory([bobAlias]));
  denied(previous, memory([bobAlias, bobAlias, bobAlias]));
  assert.deepEqual(validateReceiptMemoryOwnership(previous, memory([bobAlias]), 'alice', new Set(['alice'])), []);
});

test('trusted merged receipt baselines permit transfers without turning saved foreign aliases into new claims', () => {
  const savedExpense = memory([bobAlias]);
  const savedDraft = memory([{ name: 'my dessert', itemId: 'dessert', scopeMemberId: 'bob' }]);
  const previous = memory([...savedExpense.aliases, ...savedDraft.aliases]);
  const incoming = memory([...savedDraft.aliases, ...savedExpense.aliases, aliceAlias], 'Merged review context');
  assert.deepEqual(validateReceiptMemoryOwnership(previous, incoming, 'alice', active), [aliceAlias]);
  denied(undefined, incoming);
  denied(previous, memory([...savedDraft.aliases, aliceAlias]));
});

test('trusted merge identities normalize names within a scope while leaving exact ownership comparisons intact', () => {
  const corrected = { name: '  MY\u00a0SNACK ', itemId: 'corrected-snack', scopeMemberId: 'bob' };
  assert.equal(receiptAliasIdentity(bobAlias), receiptAliasIdentity(corrected));
  assert.notEqual(receiptAliasIdentity(bobAlias), receiptAliasIdentity({ ...bobAlias, scopeMemberId: 'alice' }));
  assert.notEqual(receiptAliasIdentity(bobAlias), receiptAliasIdentity({ name: bobAlias.name, itemId: bobAlias.itemId }));
  // A normalized identity is suitable only for independently trusted context
  // merging; it must not itself authorize a caller's alias rewrite.
  denied(memory([bobAlias]), memory([corrected]));
});

test('ownership validation leaves frozen inputs untouched and accepts an unchanged historic baseline without guessing its author', () => {
  const alias = Object.freeze({ name: 'old me', itemId: 'removed-item', scopeMemberId: 'unknown-historical-speaker' });
  const previous = Object.freeze(memory([alias])); Object.freeze(previous.aliases);
  const incoming = Object.freeze(memory([alias], 'Updated shared notes')); Object.freeze(incoming.aliases);
  assert.deepEqual(validateReceiptMemoryOwnership(previous, incoming, undefined, active), []);
  assert.deepEqual(previous, memory([alias]));
  assert.deepEqual(incoming, memory([alias], 'Updated shared notes'));
});
