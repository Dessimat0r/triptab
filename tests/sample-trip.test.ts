import assert from 'node:assert/strict';
import test from 'node:test';
import { sampleTrip } from '../lib/sample-trip';
import { total, shares, validateLedger } from '../lib/model';

test('staging sample creates distinct, valid user-owned fixtures with conserved foreign-currency receipt shares', () => {
  for (const displayName of ['Chris', 'Gary', '']) {
    const first = sampleTrip({ id: 'test-owner', displayName });
    const second = sampleTrip({ id: 'test-owner', displayName });
    assert.notEqual(first.id, second.id);
    assert.equal(first.ownerId, 'test-owner');
    assert.equal(first.members[0].userId, 'test-owner');
    assert.equal(first.members[1].userId, undefined);
    assert.equal(new Set(first.members.map(member => member.name)).size, 2);
    assert.deepEqual(validateLedger({ trips: [first] }).trips[0], first);
    assert.equal(total(first.expenses[0]), 1320);
    assert.equal(Object.values(shares(first.expenses[0], first.members)).reduce((sum, amount) => sum + amount, 0), 1320);
    assert.equal(first.expenses[0].receiptId, undefined);
  }
});
