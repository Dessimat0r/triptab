import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createD1SqlExportStream, generateD1SqlExport, inspectD1ExportMetadata, type ReadOnlyD1Database, type D1SqlExportManifest } from '../lib/operator-backup-sql';

function adapter(database: DatabaseSync, calls: string[] = []): ReadOnlyD1Database {
  return {
    prepare(sql) {
      calls.push(sql);
      let values: unknown[] = [];
      const prepared = {
        bind(...bound: unknown[]) { values = bound; return prepared; },
        async all<T>() {
          const result = database.prepare(sql).all(...values as never[]) as T[];
          return { success: true, results: result };
        },
      };
      return prepared;
    },
  };
}

async function collect(generator: AsyncIterable<string>): Promise<string> {
  let result = '';
  for await (const chunk of generator) result += chunk;
  return result;
}

function schema(db: DatabaseSync) {
  return db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name <> '_cf_METADATA' AND tbl_name <> '_cf_METADATA' ORDER BY type, name").all();
}

test('complete round trip preserves int64, fractional REAL, UTF-8/NUL text, BLOB, rowids, generated columns, sequence, migration ledger, indexes/views/triggers', async () => {
  const source = new DatabaseSync(':memory:');
  source.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE parent(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE data(i INTEGER, f REAL, t TEXT, b BLOB, n, parent_id INTEGER REFERENCES parent(id), doubled INTEGER GENERATED ALWAYS AS (i*2) VIRTUAL, words TEXT GENERATED ALWAYS AS (t || '!') STORED);
    CREATE INDEX ix_data_parent ON data(parent_id);
    CREATE TABLE audit(action TEXT NOT NULL);
    CREATE TRIGGER data_audit AFTER INSERT ON data BEGIN INSERT INTO audit VALUES('insert'); END;
    CREATE VIEW data_view AS SELECT t FROM data;
    CREATE TABLE pairs(a TEXT, b INTEGER, v TEXT, PRIMARY KEY(a,b)) WITHOUT ROWID;
    CREATE TABLE auto(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT);
    CREATE TABLE __drizzle_migrations(id INTEGER PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER);
    CREATE TABLE _cf_METADATA(key TEXT PRIMARY KEY, value BLOB);
    INSERT INTO parent VALUES(1,'one');
    INSERT INTO data(rowid,i,f,t,b,n,parent_id) VALUES(-10,-9223372036854775808,1.2345678901234567,CAST(X'610062C3A9F09F9880' AS TEXT),X'00FFAABB',NULL,1);
    INSERT INTO data(rowid,i,f,t,b,n,parent_id) VALUES(9223372036854775807,9223372036854775807,1.0000000000000002,'plain',X'',NULL,1);
    INSERT INTO pairs VALUES('a',2,'two'),('a',1,'one'),('b',1,'other');
    INSERT INTO auto(text) VALUES('old'),('kept');
    DELETE FROM auto WHERE id=1;
    UPDATE sqlite_sequence SET seq=9007199254740993 WHERE name='auto';
    INSERT INTO __drizzle_migrations VALUES(1,'hash',9007199254740993);
    INSERT INTO _cf_METADATA VALUES('platform',X'FF');
  `);
  const calls: string[] = [];
  let manifest: D1SqlExportManifest | undefined;
  const sql = await collect(generateD1SqlExport(adapter(source, calls), { maintenanceFreezeConfirmed: true, pageSize: 1, onComplete(value) { manifest = value; } }));
  assert.match(sql, /-- COMPLETE triptab-d1-logical-sql-v1 tables=7 rows=11 statements=\d+\n$/);
  assert.match(sql, /CAST\('9223372036854775807' AS INTEGER\)/);
  assert.match(sql, /CAST\('-9223372036854775808' AS INTEGER\)/);
  assert.match(sql, /CAST\(X'610062C3A9F09F9880' AS TEXT\)/);
  assert.match(sql, /PLATFORM OBJECT SKIPPED/);
  assert.ok(!sql.includes('CREATE TABLE _cf_METADATA'));
  assert.ok(sql.indexOf('CREATE TRIGGER') > sql.lastIndexOf('\nINSERT INTO'));
  assert.ok(calls.some((query) => query.includes('> CAST(? AS INTEGER)')));
  assert.ok(calls.some((query) => query.includes('OFFSET ?')));
  assert.ok(calls.every((query) => /^(SELECT|PRAGMA) /.test(query)));
  assert.equal(manifest?.complete, true);
  assert.equal(manifest?.bytes, Buffer.byteLength(sql));

  const restored = new DatabaseSync(':memory:');
  restored.exec(sql);
  assert.deepEqual(schema(restored), schema(source));
  const valuesQuery = "SELECT CAST(rowid AS TEXT) rowid, typeof(i) it, CAST(i AS TEXT) i, printf('%!.26g',f) f, typeof(f) ft, hex(CAST(t AS BLOB)) t, typeof(t) tt, hex(b) b, typeof(b) bt, n, CAST(parent_id AS TEXT) parent_id, doubled, hex(CAST(words AS BLOB)) words FROM data ORDER BY rowid";
  // doubled can exceed JS int64; compare its SQLite numeric text instead.
  const safeQuery = valuesQuery.replace('doubled,', "printf('%!.26g',doubled) doubled,");
  assert.deepEqual(restored.prepare(safeQuery).all(), source.prepare(safeQuery).all());
  assert.deepEqual(restored.prepare('SELECT * FROM pairs ORDER BY a,b').all(), source.prepare('SELECT * FROM pairs ORDER BY a,b').all());
  assert.deepEqual(restored.prepare('SELECT * FROM audit').all(), source.prepare('SELECT * FROM audit').all());
  assert.deepEqual(restored.prepare('SELECT name,CAST(seq AS TEXT) seq FROM sqlite_sequence').all(), source.prepare('SELECT name,CAST(seq AS TEXT) seq FROM sqlite_sequence').all());
  assert.deepEqual(restored.prepare('PRAGMA foreign_key_check').all(), []);
  restored.exec("INSERT INTO data(i,t) VALUES(3,'new');");
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM audit').get()?.n, 3);
  source.close(); restored.close();
});

test('schema export excludes all row data and retains migration/table definitions and post-row triggers', async () => {
  const source = new DatabaseSync(':memory:');
  source.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES('secret'); CREATE TABLE __drizzle_migrations(id INTEGER); INSERT INTO __drizzle_migrations VALUES(1);");
  const sql = await collect(generateD1SqlExport(adapter(source), { maintenanceFreezeConfirmed: true, mode: 'schema' }));
  assert.ok(sql.includes('CREATE TABLE __drizzle_migrations'));
  assert.ok(!sql.includes('INSERT INTO'));
  assert.ok(!sql.includes('secret'));
  const restored = new DatabaseSync(':memory:'); restored.exec(sql);
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM t').get()?.n, 0);
  source.close(); restored.close();
});

test('internally discovered unusual identifiers are quoted, never interpolated as executable SQL', async () => {
  const source = new DatabaseSync(':memory:');
  source.exec('CREATE TABLE "odd""table; DROP TABLE important; --" ("weird""col" TEXT); CREATE TABLE important(a);');
  const table = 'odd"table; DROP TABLE important; --';
  source.prepare(`INSERT INTO "${table.replaceAll('"', '""')}" VALUES(?)`).run("unsafe ' value\0ok");
  const sql = await collect(generateD1SqlExport(adapter(source), { maintenanceFreezeConfirmed: true }));
  const restored = new DatabaseSync(':memory:'); restored.exec(sql);
  assert.equal(restored.prepare(`SELECT "weird""col" a FROM "${table.replaceAll('"', '""')}"`).get()?.a, "unsafe ' value\0ok");
  assert.ok(restored.prepare("SELECT name FROM sqlite_schema WHERE name='important'").get());
  source.close(); restored.close();
});

test('introspection records exact schema/counts and typed migration records without precision loss', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE __drizzle_migrations(id INTEGER, hash TEXT, created_at INTEGER); INSERT INTO __drizzle_migrations VALUES(1,'a',9007199254740993); CREATE TABLE _cf_METADATA(k TEXT); INSERT INTO _cf_METADATA VALUES('internal');");
  const metadata = await inspectD1ExportMetadata(adapter(db));
  assert.deepEqual(metadata.tables, [{ name: '__drizzle_migrations', row_count: '1' }]);
  assert.equal(metadata.migration_records[0].rows[0].v2, '9007199254740993');
  assert.ok(!metadata.schema.some((object) => object.name === '_cf_METADATA'));
  assert.equal(metadata.skipped[0].name, '_cf_METADATA');
  db.close();
});

test('ANALYZE optimizer caches are explicitly recorded as rebuildable exclusions, never mistaken for user data', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT); CREATE INDEX t_value ON t(value); INSERT INTO t VALUES(1,\'one\'); ANALYZE;');
  const metadata = await inspectD1ExportMetadata(adapter(db));
  assert.ok(metadata.skipped.some((item) => item.name === 'sqlite_stat1' && item.reason.includes('Rebuildable')));
  assert.ok(!metadata.schema.some((item) => item.name === 'sqlite_stat1'));
  const sql = await collect(generateD1SqlExport(adapter(db), { maintenanceFreezeConfirmed: true }));
  const restored = new DatabaseSync(':memory:'); restored.exec(sql);
  assert.deepEqual(restored.prepare('SELECT * FROM t').all(), db.prepare('SELECT * FROM t').all());
  db.close(); restored.close();
});

test('virtual tables fail before emitting a misleading SQL archive', async () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE VIRTUAL TABLE docs USING fts5(text);');
  const iterator = generateD1SqlExport(adapter(db), { maintenanceFreezeConfirmed: true });
  await assert.rejects(iterator.next(), /Virtual table export is unsupported/);
  db.close();
});

test('unsupported rowid shadowing aborts rather than silently losing hidden rowid identities', async () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE t(rowid TEXT, _rowid_ TEXT, oid TEXT);');
  await assert.rejects(collect(generateD1SqlExport(adapter(db), { maintenanceFreezeConfirmed: true })), /All rowid aliases are shadowed/);
  db.close();
});

test('real infinity, D1 read failure, and missing maintenance freeze never produce a complete archive', async () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE t(f REAL); INSERT INTO t VALUES(1e999);');
  await assert.rejects(collect(generateD1SqlExport(adapter(db), { maintenanceFreezeConfirmed: true })), /Non-finite/);
  const failure: ReadOnlyD1Database = { prepare() { return { bind() { return this; }, async all() { return { success: false, error: 'read failed' }; } }; } };
  await assert.rejects(collect(generateD1SqlExport(failure, { maintenanceFreezeConfirmed: true })), /D1 export read failed/);
  await assert.rejects(collect(generateD1SqlExport(adapter(db), { maintenanceFreezeConfirmed: false } as never)), /maintenance write freeze/);
  db.close();
});

test('page and byte guard failures leave no COMPLETE footer, and stream errors are propagated', async () => {
  const db = new DatabaseSync(':memory:'); db.exec("CREATE TABLE t(a TEXT); INSERT INTO t VALUES('a'),('b');");
  let partial = '';
  await assert.rejects(async () => {
    for await (const chunk of generateD1SqlExport(adapter(db), { maintenanceFreezeConfirmed: true, pageSize: 1, maxPages: 1 })) partial += chunk;
  }, /page limit exceeded/);
  assert.ok(!partial.includes('-- COMPLETE'));
  await assert.rejects(collect(generateD1SqlExport(adapter(db), { maintenanceFreezeConfirmed: true, maxBytes: 100 })), /byte limit exceeded/);
  const reader = createD1SqlExportStream(adapter(db), { maintenanceFreezeConfirmed: true, maxBytes: 100 }).getReader();
  await assert.rejects(reader.read(), /byte limit exceeded/);
  db.close();
});

test('schema response with unsupported/multiple statement SQL is rejected', async () => {
  for (const sql of ['DROP TABLE t', 'CREATE TABLE t(x); DROP TABLE other;', 'CREATE TRIGGER x AFTER INSERT ON t BEGIN SELECT 1; END; DROP TABLE t']) {
    const fake: ReadOnlyD1Database = { prepare() { return { bind() { return this; }, async all<T>() { return { success: true, results: [{ type: sql.includes('TRIGGER') ? 'trigger' : 'table', name: 't', tbl_name: 't', sql }] as T[] }; } }; } };
    await assert.rejects(collect(generateD1SqlExport(fake, { maintenanceFreezeConfirmed: true })), /Unknown schema SQL|Multiple statements|Unknown trigger SQL/);
  }
});
