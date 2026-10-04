import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Log, LogLevel, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

test('the unchanged registry migration runs on PR2 alone in native D1 with transactional immutable identity writes', async () => {
  // Use workerd's D1 engine without the shared preview or any persisted database.
  const worker = new Miniflare({modules: true, script: 'export default {fetch(){return new Response("Registry native regression")}}',
    compatibilityDate: '2026-05-15', d1Databases: {DB: 'receipt-registry-backport-native'}, d1Persist: false, log: new Log(LogLevel.NONE)});
  try {
    const database = await worker.getD1Database('DB');
    const prefix = (await readdir(new URL('../drizzle/', import.meta.url))).filter(file => file.endsWith('.sql') && file < '0005').sort();
    assert.equal(prefix.length, 5, 'this regression must not depend on the later audit or cleanup migrations');
    for (const file of prefix) for (const sql of unstable_splitSqlQuery(await readFile(new URL('../drizzle/' + file, import.meta.url), 'utf8'))) await database.prepare(sql).run();
    const legacy = {id: 'legacy', role: 'user', text: 'My earlier meal', createdAt: '2026-10-01T12:00:00Z'};
    const old = {id: 'historical', role: 'user', text: 'Earlier words', createdAt: '2026-10-01T12:00:00Z', authorMemberId: 'bob', authorName: 'Bob'};
    const latest = {...old, text: 'Latest trusted words'};
    const assistant = {id: 'answer', role: 'assistant', text: 'Check the receipt', createdAt: '2026-10-01T12:01:00Z', authorMemberId: 'alice', authorName: 'Incorrect human'};
    const live = JSON.stringify({id: 'holiday', members: [], expenses: [{id: 'expense', conversation: [legacy]}], drafts: []});
    await database.prepare('INSERT INTO trips(id,owner,data) VALUES(?,?,?)').bind('holiday', 'alice-account', live).run();
    const insert = `INSERT INTO activity_events (id,trip_id,actor_id,actor_name,created_at,entity_type,entity_id,action,before_data,after_data,revision,source)
      VALUES (?,?,?,'Alice','2026-10-04T12:00:00Z','expense','expense','update',?,?,1,'web')`;
    await database.prepare(insert).bind('old-event', 'holiday', 'alice-account', JSON.stringify({conversation: [old]}), JSON.stringify({conversation: [latest, assistant]})).run();
    const evidence = await database.prepare('SELECT before_data,after_data FROM activity_events WHERE id=?').bind('old-event').first();
    const migration = unstable_splitSqlQuery(await readFile(new URL('../drizzle/0007_receipt_message_registry.sql', import.meta.url), 'utf8'));
    assert.equal(migration.length, 8);
    assert(!migration.some(sql => sql.trim() === 'END'));
    for (const sql of migration) await database.prepare(sql).run();
    const message = async (id: string) => {
      const row = await database.prepare('SELECT message_data FROM receipt_messages WHERE trip_id=? AND message_id=?').bind('holiday', id).first<{message_data: string}>();
      assert(row); return JSON.parse(row.message_data);
    };
    assert.deepEqual(await message('historical'), latest);
    assert.deepEqual(await message('legacy'), legacy);
    const safeAssistant = {id: assistant.id, role: assistant.role, text: assistant.text, createdAt: assistant.createdAt};
    assert.deepEqual(await message('answer'), safeAssistant);
    assert.deepEqual(await database.prepare('SELECT before_data,after_data FROM activity_events WHERE id=?').bind('old-event').first(), evidence);
    assert.equal((await database.prepare('SELECT data FROM trips WHERE id=?').bind('holiday').first<{data: string}>())?.data, live);
    const fresh = {...latest, id: 'fresh', text: 'A new question'};
    await database.prepare(insert).bind('new-event', 'holiday', 'alice-account', null, JSON.stringify({conversation: [fresh]})).run();
    assert.deepEqual(await message('fresh'), fresh);
    const plan = await database.prepare('EXPLAIN QUERY PLAN SELECT message_data FROM receipt_messages WHERE trip_id=? AND message_id IN (SELECT value FROM json_each(?)) LIMIT 100')
      .bind('holiday', '["fresh"]').all<{detail: string}>();
    assert(plan.results.some(row => /SEARCH receipt_messages USING INDEX receipt_messages_trip_message_idx/.test(row.detail)));
    await assert.rejects(database.prepare('UPDATE receipt_messages SET message_data=? WHERE trip_id=? AND message_id=?').bind('{}', 'holiday', 'fresh').run(), /immutable/);
    await assert.rejects(database.prepare('DELETE FROM receipt_messages WHERE trip_id=? AND message_id=?').bind('holiday', 'fresh').run(), /immutable/);
    await assert.rejects(database.prepare('INSERT OR REPLACE INTO receipt_messages VALUES (?,?,?)').bind('holiday', 'fresh', '{}').run(), /immutable/);
    const before = (await database.prepare('SELECT COUNT(*) AS count FROM activity_events').first<{count: number}>())!.count;
    await database.prepare("CREATE TRIGGER refuse_registry BEFORE INSERT ON receipt_messages BEGIN SELECT RAISE(ABORT,'registry unavailable'); END").run();
    await assert.rejects(database.batch([database.prepare(insert).bind('failed-event', 'holiday', 'alice-account', null, JSON.stringify({conversation: [{...fresh, id: 'failed'}]}))]), /registry unavailable/);
    assert.equal((await database.prepare('SELECT COUNT(*) AS count FROM activity_events').first<{count: number}>())?.count, before);
    assert.equal(await database.prepare('SELECT message_id FROM receipt_messages WHERE message_id=?').bind('failed').first(), null);
    assert.deepEqual(await message('fresh'), fresh);
  } finally {await worker.dispose();}
});
