import assert from 'node:assert/strict';
import test from 'node:test';
import { createReceiptFlowWorker } from './helpers/receipt-flow-worker';

test('native D1 Worker downloads immutable shared snapshots in valid UTF-8 without weakening trip or session permissions', async () => {
  const fixture = await createReceiptFlowWorker();
  try {
    const snapshot = { title: 'Printed line 🥐 '.repeat(20_000), members: [{ id: 'bob', name: 'Bob', email: 'typed-contact@example.test' }] };
    await fixture.db.prepare(`INSERT INTO activity_events(id,trip_id,actor_id,actor_name,created_at,entity_type,entity_id,action,before_data,after_data,revision,source)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind('native-large-entry', fixture.tripId, fixture.owner.id, fixture.owner.displayName,
      '2026-10-05T12:00:00Z', 'expense', 'native-expense', 'update', JSON.stringify(snapshot), JSON.stringify({ ...snapshot, title: snapshot.title + ' amended' }), 1, 'web').run();
    const path = `/api/activity-entry?tripId=${fixture.tripId}&eventId=native-large-entry`;
    const response = await fixture.browserRequest(path);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const event = await response.json() as { id: string; before: typeof snapshot; after: typeof snapshot };
    assert.equal(event.id, 'native-large-entry');
    assert.deepEqual(event.before, snapshot);
    assert.equal(event.after.title, snapshot.title + ' amended');
    assert.equal(event.after.members[0].email, 'typed-contact@example.test', 'explicit shared-history download has the same raw snapshots as the authorized History view');
    assert.equal((await fixture.worker.dispatchFetch(fixture.origin + path)).status, 401);
    assert.equal((await fixture.browserRequest('/api/activity-entry?tripId=other-trip&eventId=native-large-entry')).status, 404);
    assert.equal((await fixture.browserRequest(path, { headers: { origin: 'https://foreign.test' } })).status, 403);
    const stored = await fixture.db.prepare('SELECT after_data FROM activity_events WHERE id=?').bind('native-large-entry').first<{ after_data: string }>();
    assert.equal(JSON.parse(stored!.after_data).title, snapshot.title + ' amended');
    await fixture.db.prepare('DELETE FROM auth_sessions WHERE user_id=?').bind(fixture.owner.id).run();
    assert.equal((await fixture.browserRequest(path)).status, 401);
  } finally { await fixture.dispose(); }
});
