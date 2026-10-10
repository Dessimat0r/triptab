/**
 * Dedicated export-only Worker. Import this from an independent maintenance
 * build, never from TripTab's ordinary app Worker. There are no write, import,
 * arbitrary SQL, authenticated app, scheduled cleanup, or CORS endpoints here.
 *
 * Download over HTTPS with a short-lived operator token. The matching operator
 * client must encrypt its restricted temporary archive and remove plaintext.
 * This is an application-consistent manual export, not a D1 Time Travel bookmark.
 */

export interface ReadOnlyD1Statement {
  bind(...values: unknown[]): ReadOnlyD1Statement;
  all<T = Record<string, unknown>>(): Promise<{ success: boolean; results?: T[]; error?: string }>;
}

export interface ReadOnlyD1Database {
  prepare(sql: string): ReadOnlyD1Statement;
}

export interface BackupR2Object {
  key: string;
  size: number;
  etag: string;
  uploaded: Date;
  httpMetadata?: Record<string, unknown>;
  customMetadata?: Record<string, string>;
}

export interface ReadOnlyR2Bucket {
  list(options: {
    limit: number;
    cursor?: string;
    include: ["httpMetadata", "customMetadata"];
  }): Promise<{ objects: BackupR2Object[]; truncated: boolean; cursor?: string }>;
  get(key: string): Promise<(BackupR2Object & { body: ReadableStream<Uint8Array> }) | null>;
}

export interface BackupEnvironment {
  DB: ReadOnlyD1Database;
  RECEIPTS: ReadOnlyR2Bucket;
  TRIPTAB_BACKUP_TOKEN: string;
  TRIPTAB_BACKUP_ISSUED_AT: string;
  TRIPTAB_BACKUP_EXPIRES_AT: string;
  TRIPTAB_BACKUP_SNAPSHOT_ID: string;
  /** Independent export-only artifact replaces all ordinary app request paths. */
  TRIPTAB_BACKUP_FREEZE_CONFIRMED: "true";
}

export interface BackupDependencies {
  exportDatabaseSql(
    db: ReadOnlyD1Database,
    mode: "database" | "schema",
  ): AsyncIterable<string | Uint8Array>;
  /** Stable ordered schema, table counts, and exact existing migration records. */
  inspectDatabase(db: ReadOnlyD1Database): Promise<Record<string, unknown>>;
  /** Test clock; omit from the actual Worker entry. */
  now?: () => number;
}

const PREFIX = "/__triptab_backup/";
const MAX_LEASE_MS = 60 * 60 * 1_000;
const MAX_OBJECT_BYTES = 256 * 1_024 * 1_024;
const MAX_SQL_BYTES = 512 * 1_024 * 1_024;
const STREAM_CHUNK_BYTES = 64 * 1_024;
const MAX_CONCURRENT_STREAMS = 2;
const encoder = new TextEncoder();

interface Lease {
  snapshotId: string;
  issuedAt: string;
  expiresAt: string;
  expiresMs: number;
}

function privateHeaders(lease?: Lease): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store, private, max-age=0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  });
  if (lease) headers.set("X-TripTab-Snapshot-Id", lease.snapshotId);
  return headers;
}

function maintenance(): Response {
  const headers = privateHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Retry-After", "60");
  return new Response('{"error":"TripTab is temporarily unavailable for maintenance."}', {
    status: 503, headers,
  });
}

function json(data: unknown, lease: Lease, status = 200): Response {
  const headers = privateHeaders(lease);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

function validLease(env: BackupEnvironment, now: number): Lease | null {
  // Fail closed if this artifact was accidentally built without its explicit
  // maintenance profile, operator configuration, or actual storage bindings.
  if (env.TRIPTAB_BACKUP_FREEZE_CONFIRMED !== "true" || !env.DB || !env.RECEIPTS ||
      typeof env.TRIPTAB_BACKUP_TOKEN !== "string" ||
      !/^[A-Za-z0-9_-]{43,256}$/.test(env.TRIPTAB_BACKUP_TOKEN) ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(env.TRIPTAB_BACKUP_SNAPSHOT_ID ?? "")) return null;
  const issuedAt = env.TRIPTAB_BACKUP_ISSUED_AT;
  const expiresAt = env.TRIPTAB_BACKUP_EXPIRES_AT;
  const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
  if (!utc.test(issuedAt ?? "") || !utc.test(expiresAt ?? "")) return null;
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || issuedMs > now ||
      expiresMs <= now || expiresMs <= issuedMs || expiresMs - issuedMs > MAX_LEASE_MS) return null;
  return { snapshotId: env.TRIPTAB_BACKUP_SNAPSHOT_ID, issuedAt, expiresAt, expiresMs };
}

async function sameBearer(request: Request, configured: string): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  const candidate = header.startsWith("Bearer ") && header.length <= 264 ? header.slice(7) : "";
  // Always digest both values and compare all digest bytes. Avoid an ordinary
  // equality comparison of either the secret token or its digest.
  const [expected, supplied] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
  ]);
  const a = new Uint8Array(expected);
  const b = new Uint8Array(supplied);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

function exactParameters(url: URL, allowed: string[]): boolean {
  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!allowed.includes(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(stableJson(value))));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function* objectBytes(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** All normal app paths stay in maintenance, including the MCP endpoint. */
export function createBackupHandler(dependencies: BackupDependencies) {
  const now = dependencies.now ?? Date.now;
  let concurrentStreams = 0;
  // Best-effort per-isolate request throttling; this is not a global durable
  // quota. The authorization lease and fixed route/size limits are definitive.
  let limiterSnapshot = "";
  let bucket = 30;
  let lastRefill = now();

  function acquireRequest(lease: Lease): boolean {
    const current = now();
    if (limiterSnapshot !== lease.snapshotId) {
      limiterSnapshot = lease.snapshotId;
      bucket = 30;
      lastRefill = current;
    }
    bucket = Math.min(30, bucket + Math.max(0, current - lastRefill) * 0.006);
    lastRefill = current;
    if (bucket < 1) return false;
    bucket--;
    return true;
  }

  function streamResponse(
    source: AsyncIterable<string | Uint8Array>, lease: Lease, maximumBytes: number,
    contentType: string, extraHeaders: Record<string, string> = {}, expectedBytes?: number,
  ): Response {
    const iterator = source[Symbol.asyncIterator]();
    let released = false;
    let total = 0;
    let pending: Uint8Array | null = null;
    let offset = 0;
    function release() {
      if (released) return;
      released = true;
      concurrentStreams--;
    }
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (now() >= lease.expiresMs) throw new Error("Expired export");
          while (!pending || offset === pending.byteLength) {
            const next = await iterator.next();
            if (next.done) {
              if (expectedBytes !== undefined && total !== expectedBytes) throw new Error("Incomplete object export");
              release();
              controller.close();
              return;
            }
            pending = typeof next.value === "string" ? encoder.encode(next.value) : next.value;
            offset = 0;
            total += pending.byteLength;
            if (total > maximumBytes) throw new Error("Export exceeds bounded size");
          }
          if (now() >= lease.expiresMs) throw new Error("Expired export");
          const end = Math.min(offset + STREAM_CHUNK_BYTES, pending.byteLength);
          controller.enqueue(pending.subarray(offset, end));
          offset = end;
        } catch {
          release();
          await iterator.return?.().catch(() => undefined);
          controller.error(new Error("Backup stream incomplete; discard this response."));
        }
      },
      async cancel() {
        release();
        await iterator.return?.().catch(() => undefined);
      },
    });
    const headers = privateHeaders(lease);
    headers.set("Content-Type", contentType);
    for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
    return new Response(body, { headers });
  }

  return async function fetch(request: Request, env: BackupEnvironment): Promise<Response> {
    const url = new URL(request.url);
    const lease = validLease(env, now());
    if (!lease || url.protocol !== "https:" || request.method !== "GET" ||
        request.headers.has("Cookie") || request.headers.has("Origin") ||
        !url.pathname.startsWith(PREFIX) || !(await sameBearer(request, env.TRIPTAB_BACKUP_TOKEN))) {
      return maintenance();
    }
    if (!acquireRequest(lease)) return json({ error: "Too many backup requests." }, lease, 429);
    const route = url.pathname.slice(PREFIX.length);
    try {
      if (route === "health" && exactParameters(url, [])) {
        return json({ status: "export-only", snapshot_id: lease.snapshotId }, lease);
      }
      if (route === "metadata" && exactParameters(url, [])) {
        const database = await dependencies.inspectDatabase(env.DB);
        if (now() >= lease.expiresMs) return maintenance();
        return json({
          format: "triptab-manual-backup-v1",
          snapshot_id: lease.snapshotId,
          issued_at: lease.issuedAt,
          expires_at: lease.expiresAt,
          database,
          database_fingerprint: await fingerprint(database),
          time_travel_bookmark: null,
        }, lease);
      }
      if ((route === "schema" || route === "database") && exactParameters(url, [])) {
        if (concurrentStreams >= MAX_CONCURRENT_STREAMS) return json({ error: "Backup stream busy." }, lease, 429);
        concurrentStreams++;
        try {
          return streamResponse(dependencies.exportDatabaseSql(env.DB, route), lease, MAX_SQL_BYTES, "application/sql; charset=utf-8");
        } catch {
          concurrentStreams--;
          throw new Error("Failed export construction");
        }
      }
      if (route === "objects" && exactParameters(url, ["cursor", "limit"])) {
        const limitText = url.searchParams.get("limit") ?? "100";
        const cursor = url.searchParams.get("cursor");
        if (!/^(?:[1-9]\d?|100)$/.test(limitText) || (cursor !== null && (cursor.length === 0 || encoder.encode(cursor).byteLength > 4_096))) {
          return json({ error: "Invalid backup parameters." }, lease, 400);
        }
        const page = await env.RECEIPTS.list({
          limit: Number(limitText), ...(cursor ? { cursor } : {}), include: ["httpMetadata", "customMetadata"],
        });
        if (now() >= lease.expiresMs) return maintenance();
        if (page.objects.length > Number(limitText) || (page.truncated && !page.cursor)) throw new Error("Invalid storage result");
        return json({
          snapshot_id: lease.snapshotId,
          objects: page.objects.map(object => ({
            key: object.key, size: object.size, etag: object.etag, uploaded: object.uploaded.toISOString(),
            httpMetadata: object.httpMetadata ?? {}, customMetadata: object.customMetadata ?? {},
          })),
          truncated: page.truncated,
          ...(page.truncated ? { cursor: page.cursor } : {}),
        }, lease);
      }
      if (route === "object" && exactParameters(url, ["key"])) {
        const key = url.searchParams.get("key");
        if (!key || key.includes("\0") || encoder.encode(key).byteLength > 1_024) {
          return json({ error: "Invalid backup parameters." }, lease, 400);
        }
        if (concurrentStreams >= MAX_CONCURRENT_STREAMS) return json({ error: "Backup stream busy." }, lease, 429);
        concurrentStreams++;
        let handedOff = false;
        try {
          const object = await env.RECEIPTS.get(key);
          if (!object) return json({ error: "Object not found." }, lease, 404);
          if (!Number.isSafeInteger(object.size) || object.size < 0 || object.size > MAX_OBJECT_BYTES) {
            await object.body.cancel().catch(() => undefined);
            return json({ error: "Object exceeds backup size limit." }, lease, 413);
          }
          const response = streamResponse(objectBytes(object.body), lease, object.size, "application/octet-stream", {
            "X-TripTab-Object-Size": String(object.size),
          }, object.size);
          handedOff = true;
          return response;
        } finally {
          if (!handedOff) concurrentStreams--;
        }
      }
      return json({ error: "Invalid backup route or parameters." }, lease, 400);
    } catch {
      // Never return database errors, object keys, credentials, or stack traces.
      return json({ error: "Backup request failed." }, lease, 500);
    }
  };
}
