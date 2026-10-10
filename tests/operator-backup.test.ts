import assert from "node:assert/strict";
import test from "node:test";
import { createBackupHandler, type BackupEnvironment, type ReadOnlyD1Database } from "../lib/operator-backup";

const START = Date.parse("2026-10-10T12:00:00.000Z");
const TOKEN = "A".repeat(43);
const SNAPSHOT = "triptab-test-snapshot-01";
const db = { prepare() { throw new Error("Private database error / sk-secret!"); } } as ReadOnlyD1Database;

function environment(overrides: Partial<BackupEnvironment> = {}): BackupEnvironment {
  return {
    DB: db,
    RECEIPTS: {
      async list() { return { objects: [], truncated: false }; },
      async get() { return null; },
    },
    TRIPTAB_BACKUP_TOKEN: TOKEN,
    TRIPTAB_BACKUP_ISSUED_AT: new Date(START).toISOString(),
    TRIPTAB_BACKUP_EXPIRES_AT: new Date(START + 30 * 60_000).toISOString(),
    TRIPTAB_BACKUP_SNAPSHOT_ID: SNAPSHOT,
    TRIPTAB_BACKUP_FREEZE_CONFIRMED: "true",
    ...overrides,
  };
}

function request(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://test.example/__triptab_backup/${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, ...headers },
  });
}

function handler(options: { now?: () => number; inspectDatabase?: (db: ReadOnlyD1Database) => Promise<Record<string, unknown>> } = {}) {
  return createBackupHandler({
    async *exportDatabaseSql(_db, mode) { yield `-- ${mode}\n`; yield "SELECT 'receipt';\n"; },
    async inspectDatabase() { return { schema: [], tables: [], migration_records: [] }; },
    now: () => START,
    ...options,
  });
}

test("ordinary app, MCP, HTTP, method, cookie and browser requests all remain maintenance", async () => {
  let inspection = 0;
  const fetch = handler({ async inspectDatabase() { inspection++; return {}; } });
  const rejected = [
    new Request("https://test.example/", { headers: { Authorization: `Bearer ${TOKEN}` } }),
    new Request("https://test.example/mcp", { headers: { Authorization: `Bearer ${TOKEN}` } }),
    new Request("http://test.example/__triptab_backup/metadata", { headers: { Authorization: `Bearer ${TOKEN}` } }),
    new Request("https://test.example/__triptab_backup/metadata", { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } }),
    request("metadata", { Cookie: "session=private" }),
    request("metadata", { Origin: "https://evil.example" }),
  ];
  for (const candidate of rejected) {
    const response = await fetch(candidate, environment());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), "no-store, private, max-age=0");
    assert.doesNotMatch(await response.text(), /snapshot|private|sk-secret/i);
  }
  assert.equal(inspection, 0);
});

test("missing, incorrect, oversized and malformed authorization does not access storage", async () => {
  let inspection = 0;
  const fetch = handler({ async inspectDatabase() { inspection++; return {}; } });
  for (const authorization of ["", "Bearer wrong", `Bearer ${"B".repeat(43)}`, `Bearer ${"A".repeat(1_000)}`, `Basic ${TOKEN}`, `Bearer ${TOKEN} suffix`]) {
    const response = await fetch(request("health", { Authorization: authorization }), environment());
    assert.equal(response.status, 503);
  }
  assert.equal(inspection, 0);
});

test("invalid/future/expired or longer than one-hour lease fails closed", async () => {
  const fetch = handler();
  for (const override of [
    { TRIPTAB_BACKUP_TOKEN: "short" },
    { TRIPTAB_BACKUP_ISSUED_AT: new Date(START + 1).toISOString() },
    { TRIPTAB_BACKUP_EXPIRES_AT: new Date(START).toISOString() },
    { TRIPTAB_BACKUP_EXPIRES_AT: new Date(START + 60 * 60_000 + 1).toISOString() },
    { TRIPTAB_BACKUP_SNAPSHOT_ID: "unsafe/header" },
    { TRIPTAB_BACKUP_FREEZE_CONFIRMED: "false" as "true" },
  ]) assert.equal((await fetch(request("health"), environment(override))).status, 503);
});

test("metadata uses stable fingerprint and states that Time Travel bookmark is absent", async () => {
  const fetch = handler({ async inspectDatabase() { return { z: ["table"], a: { rows: 4 } }; } });
  const response = await fetch(request("metadata"), environment());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-TripTab-Snapshot-Id"), SNAPSHOT);
  const metadata = await response.json() as Record<string, unknown>;
  assert.equal(metadata.snapshot_id, SNAPSHOT);
  assert.equal(metadata.time_travel_bookmark, null);
  assert.match(String(metadata.database_fingerprint), /^[a-f0-9]{64}$/);
  const other = handler({ async inspectDatabase() { return { a: { rows: 4 }, z: ["table"] }; } });
  const otherMetadata = await (await other(request("metadata"), environment())).json() as Record<string, unknown>;
  assert.equal(metadata.database_fingerprint, otherMetadata.database_fingerprint);
});

test("SQL responses stream only fixed server-generated export modes", async () => {
  const fetch = handler();
  assert.equal(await (await fetch(request("database"), environment())).text(), "-- database\nSELECT 'receipt';\n");
  assert.equal(await (await fetch(request("schema"), environment())).text(), "-- schema\nSELECT 'receipt';\n");
  for (const path of ["database?sql=DELETE+FROM+receipts", "schema?sql=SELECT+token", "database?x=1", "object?key=first&key=second", "objects?limit=101", "objects?limit=0", "objects?limit=1.5"]) {
    assert.equal((await fetch(request(path), environment())).status, 400);
  }
});

test("R2 listing is paginated and preserves exact object metadata", async () => {
  const env = environment({ RECEIPTS: {
    async list(options) {
      assert.deepEqual(options, { limit: 2, cursor: "page 2", include: ["httpMetadata", "customMetadata"] });
      return {
        objects: [{ key: "owner/receipt", size: 3, etag: "abc", uploaded: new Date(START), httpMetadata: { contentType: "image/jpeg" }, customMetadata: { note: "value" } }],
        truncated: true, cursor: "page 3",
      };
    },
    async get() { throw new Error("not used"); },
  } });
  const body = await (await handler()(request("objects?limit=2&cursor=page%202"), env)).json() as Record<string, unknown>;
  assert.equal(body.snapshot_id, SNAPSHOT);
  assert.equal(body.cursor, "page 3");
  assert.deepEqual(body.objects, [{ key: "owner/receipt", size: 3, etag: "abc", uploaded: new Date(START).toISOString(), httpMetadata: { contentType: "image/jpeg" }, customMetadata: { note: "value" } }]);
});

test("R2 object streams preserve all binary bytes and enforce size bound", async () => {
  const bytes = new Uint8Array([0, 255, 128, 10]);
  const env = environment({ RECEIPTS: {
    async list() { return { objects: [], truncated: false }; },
    async get(key) {
      assert.equal(key, "owner name/receipt#1");
      return { key, size: bytes.length, etag: "abc", uploaded: new Date(START), body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    },
  } });
  const response = await handler()(request("object?key=owner%20name%2Freceipt%231"), env);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get("X-TripTab-Object-Size"), "4");
  env.RECEIPTS.get = async key => ({ key, size: 256 * 1_024 * 1_024 + 1, etag: "abc", uploaded: new Date(START), body: new ReadableStream() });
  assert.equal((await handler()(request("object?key=owner%20name%2Freceipt%231"), env)).status, 413);
});

test("an R2 body shorter than its declared size fails the download", async () => {
  const env = environment({ RECEIPTS: {
    async list() { return { objects: [], truncated: false }; },
    async get(key) {
      return { key, size: 4, etag: "abc", uploaded: new Date(START), body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close(); } }) };
    },
  } });
  const response = await handler()(request("object?key=receipt"), env);
  await assert.rejects(response.arrayBuffer(), /Backup stream incomplete/);
});

test("storage exceptions do not leak private error messages or credentials", async () => {
  const fetch = handler({ async inspectDatabase() { throw new Error("database private / sk-secret!"); } });
  const response = await fetch(request("metadata"), environment());
  assert.equal(response.status, 500);
  assert.equal(await response.text(), '{"error":"Backup request failed."}');
});

test("expired leases terminate active downloads instead of allowing continued export", async () => {
  let current = START;
  const fetch = handler({ now: () => current });
  const response = await fetch(request("database"), environment());
  current = START + 60 * 60_000;
  await assert.rejects(response.text(), /Backup stream incomplete/);
});

test("per-isolate request throttling bounds burst requests", async () => {
  const fetch = handler();
  for (let i = 0; i < 30; i++) assert.equal((await fetch(request("health"), environment())).status, 200);
  assert.equal((await fetch(request("health"), environment())).status, 429);
});
