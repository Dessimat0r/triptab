/**
 * Read-only logical SQLite/D1 export. This must run while all application and
 * background writes are frozen. Separate D1 calls do not form a read snapshot.
 * Restore into an EMPTY database using a tool that honors the transaction.
 * A missing COMPLETE footer means the export failed and must not be restored.
 */
export interface ReadOnlyD1Statement {
  bind(...values: unknown[]): ReadOnlyD1Statement;
  all<T = Record<string, unknown>>(): Promise<{ success: boolean; results?: T[]; error?: string }>;
}

export interface ReadOnlyD1Database {
  prepare(sql: string): ReadOnlyD1Statement;
}

export interface D1SqlExportManifest {
  format: 'triptab-d1-logical-sql-v1';
  mode: 'schema' | 'database';
  tables: Array<{ name: string; rows: number; pagination: 'rowid' | 'offset' | 'sequence' }>;
  skipped: Array<{ name: string; reason: string }>;
  pages: number;
  bytes: number;
  statements: number;
  complete: boolean;
}

export interface D1SqlExportOptions {
  maintenanceFreezeConfirmed: true;
  mode?: 'schema' | 'database';
  pageSize?: number;
  maxPages?: number;
  maxBytes?: number;
  maxSchemaObjects?: number;
  onComplete?: (manifest: D1SqlExportManifest) => void | Promise<void>;
}

interface SchemaRow { type: string; name: string; tbl_name: string; sql: string | null }
interface ColumnRow { cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number; hidden: number }
interface ExportTable {
  schema: SchemaRow;
  columns: ColumnRow[];
  rowidAlias?: string;
  orderColumns: string[];
  sequence: boolean;
}

const encoder = new TextEncoder();
const INT64_MIN = -(BigInt(1) << BigInt(63));
const INT64_MAX = (BigInt(1) << BigInt(63)) - BigInt(1);

/** Identifiers originate exclusively from sqlite_schema / table_xinfo. */
export function quoteSqlIdentifier(name: string): string {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) {
    throw new Error('Invalid discovered SQLite identifier');
  }
  return `"${name.replaceAll('"', '""')}"`;
}

function positiveInt(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error(`Invalid ${label}`);
  return result;
}

async function readRows<T>(db: ReadOnlyD1Database, sql: string, values: unknown[] = []): Promise<T[]> {
  // Exactly one statement per call; no batch(), exec(), write, or user SQL.
  const statement = db.prepare(sql);
  const result = await (values.length ? statement.bind(...values) : statement).all<T>();
  if (result.success !== true || !Array.isArray(result.results)) {
    throw new Error(`D1 export read failed${result.error ? `: ${result.error}` : ''}`);
  }
  return result.results;
}

/** Remove comments, strings and quoted identifiers before inspecting keywords. */
function sqlKeywords(sql: string): string {
  let result = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const end = c === '[' ? ']' : c;
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === end) {
          if (c !== '[' && sql[i + 1] === end) { i += 2; continue; }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw new Error('Unterminated SQL quote in discovered schema');
      result += ' ';
    } else if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i++;
      result += ' ';
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated SQL comment in discovered schema');
      i = end + 2;
      result += ' ';
    } else { result += c; i++; }
  }
  return result;
}

function validateSchema(row: SchemaRow): void {
  quoteSqlIdentifier(row.name);
  quoteSqlIdentifier(row.tbl_name);
  if (!['table', 'index', 'view', 'trigger'].includes(row.type)) throw new Error(`Unsupported schema type: ${row.type}`);
  if (row.sql === null) {
    if (row.type === 'index' && row.name.startsWith('sqlite_autoindex_')) return;
    throw new Error(`Missing SQL for schema object ${row.name}`);
  }
  if (typeof row.sql !== 'string' || row.sql.includes('\0')) throw new Error(`Invalid schema SQL: ${row.name}`);
  const keywords = sqlKeywords(row.sql);
  if (/^\s*CREATE\s+VIRTUAL\s+TABLE\b/i.test(keywords)) throw new Error(`Virtual table export is unsupported: ${row.name}`);
  const prefix: Record<string, RegExp> = {
    table: /^\s*CREATE\s+TABLE\b/i,
    index: /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
    view: /^\s*CREATE\s+VIEW\b/i,
    trigger: /^\s*CREATE\s+TRIGGER\b/i,
  };
  if (!prefix[row.type].test(keywords)) throw new Error(`Unknown schema SQL: ${row.name}`);
  if (row.type !== 'trigger' && /;\s*\S/.test(keywords)) throw new Error(`Multiple statements in schema object: ${row.name}`);
  if (row.type === 'trigger' && !/\bEND\s*;?\s*$/i.test(keywords)) throw new Error(`Unknown trigger SQL: ${row.name}`);
  if (row.type === 'table' && /\bAS\s+SELECT\b/i.test(keywords)) throw new Error(`CREATE TABLE AS export is unsupported: ${row.name}`);
}

function portableExclusionReason(row: SchemaRow): string | undefined {
  if (row.name === '_cf_METADATA' || row.tbl_name === '_cf_METADATA') {
    return 'Cloudflare-owned _cf_METADATA is provisioned by the destination platform';
  }
  if (['sqlite_stat1', 'sqlite_stat4'].includes(row.name) || ['sqlite_stat1', 'sqlite_stat4'].includes(row.tbl_name)) {
    return 'Rebuildable SQLite optimizer statistics are omitted; run ANALYZE after restore if needed';
  }
  return undefined;
}

function literal(type: unknown, value: unknown): string {
  if (type === 'null') {
    if (value !== null) throw new Error('Invalid NULL encoding');
    return 'NULL';
  }
  if (typeof value !== 'string') throw new Error(`SQLite value was not encoded as text: ${String(type)}`);
  if (type === 'integer') {
    if (!/^-?\d+$/.test(value)) throw new Error('Invalid integer encoding');
    const integer = BigInt(value);
    if (integer < INT64_MIN || integer > INT64_MAX) throw new Error('Integer exceeds SQLite 64-bit range');
    return `CAST('${value}' AS INTEGER)`;
  }
  if (type === 'real') {
    if (!/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) || !Number.isFinite(Number(value))) {
      throw new Error('Non-finite or invalid REAL value cannot be exported');
    }
    return `CAST('${value}' AS REAL)`;
  }
  if (type === 'text' || type === 'blob') {
    if (!/^(?:[\da-f]{2})*$/i.test(value)) throw new Error('Invalid hex encoding');
    const bytes = `X'${value}'`;
    return type === 'text' ? `CAST(${bytes} AS TEXT)` : bytes;
  }
  throw new Error(`Unknown SQLite storage class: ${String(type)}`);
}

function projection(columns: string[]): string {
  return columns.flatMap((name, index) => {
    const column = quoteSqlIdentifier(name);
    // SQLite performs integer conversion before D1's JS-number boundary.
    // %!.26g is SQLite's round-trip representation of a binary64 REAL.
    return [
      `typeof(${column}) AS "t${index}"`,
      `CASE typeof(${column}) WHEN 'integer' THEN CAST(${column} AS TEXT) WHEN 'real' THEN printf('%!.26g', ${column}) WHEN 'text' THEN hex(CAST(${column} AS BLOB)) WHEN 'blob' THEN hex(${column}) WHEN 'null' THEN NULL ELSE 'UNSUPPORTED' END AS "v${index}"`,
    ];
  }).join(', ');
}

function terminate(sql: string): string {
  return `${sql.trim().replace(/;+\s*$/, '')};\n`;
}

/** Streaming export. Consumption must reach the final COMPLETE footer. */
export async function* generateD1SqlExport(db: ReadOnlyD1Database, options: D1SqlExportOptions): AsyncGenerator<string> {
  if (options.maintenanceFreezeConfirmed !== true) throw new Error('A maintenance write freeze is required');
  const mode = options.mode ?? 'database';
  if (mode !== 'schema' && mode !== 'database') throw new Error('Invalid export mode');
  const pageSize = positiveInt(options.pageSize, 10, 1000, 'page size');
  const maxPages = positiveInt(options.maxPages, 10000, 1_000_000, 'page limit');
  const maxBytes = positiveInt(options.maxBytes, 128 * 1024 * 1024, 2 ** 31 - 1, 'byte limit');
  const schemaLimit = positiveInt(options.maxSchemaObjects, 5000, 10000, 'schema limit');
  const manifest: D1SqlExportManifest = { format: 'triptab-d1-logical-sql-v1', mode, tables: [], skipped: [], pages: 0, bytes: 0, statements: 2, complete: false };
  const emitted = (text: string): string => {
    manifest.bytes += encoder.encode(text).byteLength;
    if (manifest.bytes > maxBytes) throw new Error('D1 export byte limit exceeded; discard incomplete export');
    return text;
  };

  const schema = await readRows<SchemaRow>(db, 'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name LIMIT ?', [schemaLimit + 1]);
  if (schema.length > schemaLimit) throw new Error('D1 export schema limit exceeded');
  const retained: SchemaRow[] = [];
  for (const row of schema) {
    const exclusionReason = portableExclusionReason(row);
    if (exclusionReason) {
      manifest.skipped.push({ name: row.name, reason: exclusionReason });
      continue;
    }
    validateSchema(row);
    if (row.name.startsWith('sqlite_') && !(row.name === 'sqlite_sequence' || (row.type === 'index' && row.sql === null && row.name.startsWith('sqlite_autoindex_')))) {
      throw new Error(`Unsupported SQLite internal object: ${row.name}`);
    }
    retained.push(row);
  }

  const tables: ExportTable[] = [];
  for (const row of retained.filter((item) => item.type === 'table')) {
    const allColumns = await readRows<ColumnRow>(db, `PRAGMA table_xinfo(${quoteSqlIdentifier(row.name)})`);
    if (allColumns.length === 0 || allColumns.length > 2000) throw new Error(`Invalid columns for ${row.name}`);
    for (const column of allColumns) {
      quoteSqlIdentifier(column.name);
      if (![0, 2, 3].includes(column.hidden)) throw new Error(`Unsupported hidden column in ${row.name}`);
      if (!Number.isInteger(column.pk) || column.pk < 0) throw new Error(`Invalid primary key metadata in ${row.name}`);
    }
    const columns = allColumns.filter((column) => column.hidden === 0);
    if (columns.length === 0) throw new Error(`No writable columns in ${row.name}`);
    const sequence = row.name === 'sqlite_sequence';
    const withoutRowid = /\bWITHOUT\s+ROWID\b/i.test(sqlKeywords(row.sql!));
    const existingNames = new Set(allColumns.map((column) => column.name.toLowerCase()));
    const rowidAlias = !withoutRowid && !sequence ? ['rowid', '_rowid_', 'oid'].find((alias) => !existingNames.has(alias)) : undefined;
    if (!withoutRowid && !sequence && !rowidAlias) throw new Error(`All rowid aliases are shadowed in ${row.name}; lossless export is unsupported`);
    const primaryKeys = allColumns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
    if (withoutRowid && primaryKeys.length === 0) throw new Error(`Missing WITHOUT ROWID key in ${row.name}`);
    const pagination = sequence ? 'sequence' : rowidAlias ? 'rowid' : 'offset';
    manifest.tables.push({ name: row.name, rows: 0, pagination });
    tables.push({ schema: row, columns, rowidAlias, orderColumns: sequence ? ['name'] : primaryKeys, sequence });
  }

  yield emitted('-- TripTab logical D1 backup v1; restore only into an empty database.\n-- Requires a COMPLETE footer and a maintenance-frozen source.\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n');
  for (const skipped of manifest.skipped) {
    // Hex comment payload avoids newline/comment injection from discovered names.
    yield emitted(`-- PLATFORM OBJECT SKIPPED name_utf8_hex=${Array.from(encoder.encode(skipped.name), (byte) => byte.toString(16).padStart(2, '0')).join('')} reason_utf8_hex=${Array.from(encoder.encode(skipped.reason), (byte) => byte.toString(16).padStart(2, '0')).join('')}\n`);
  }
  for (const table of tables.filter((table) => !table.sequence)) {
    manifest.statements++;
    yield emitted(terminate(table.schema.sql!));
  }

  if (mode === 'database') {
    for (const table of [...tables.filter((table) => !table.sequence), ...tables.filter((table) => table.sequence)]) {
      const tableManifest = manifest.tables.find((item) => item.name === table.schema.name)!;
      const insertColumns = table.rowidAlias ? [table.rowidAlias, ...table.columns.map((column) => column.name)] : table.columns.map((column) => column.name);
      const selectProjection = projection(insertColumns);
      const quotedTable = quoteSqlIdentifier(table.schema.name);
      if (table.sequence) { manifest.statements++; yield emitted('DELETE FROM "sqlite_sequence";\n'); }
      let cursor: string | undefined;
      let offset = 0;
      while (true) {
        if (++manifest.pages > maxPages) throw new Error('D1 export page limit exceeded; discard incomplete export');
        const parameters: unknown[] = [];
        let suffix: string;
        if (table.rowidAlias) {
          const rowid = quoteSqlIdentifier(table.rowidAlias);
          const where = cursor === undefined ? '' : ` WHERE ${rowid} > CAST(? AS INTEGER)`;
          if (cursor !== undefined) parameters.push(cursor);
          suffix = `${where} ORDER BY ${rowid} LIMIT ?`;
          parameters.push(pageSize);
        } else {
          suffix = ` ORDER BY ${table.orderColumns.map(quoteSqlIdentifier).join(', ')} LIMIT ? OFFSET ?`;
          parameters.push(pageSize, offset);
        }
        const rows = await readRows<Record<string, unknown>>(db, `SELECT ${selectProjection} FROM ${quotedTable}${suffix}`, parameters);
        if (rows.length > pageSize) throw new Error('D1 returned an oversized export page');
        for (const row of rows) {
          const values = insertColumns.map((_column, index) => literal(row[`t${index}`], row[`v${index}`]));
          if (table.rowidAlias) {
            const next = row.v0;
            if (row.t0 !== 'integer' || typeof next !== 'string') throw new Error('Invalid rowid cursor');
            if (cursor !== undefined && BigInt(next) <= BigInt(cursor)) throw new Error('Non-increasing rowid cursor');
            cursor = next;
          }
          tableManifest.rows++;
          manifest.statements++;
          yield emitted(`INSERT INTO ${quotedTable} (${insertColumns.map(quoteSqlIdentifier).join(', ')}) VALUES (${values.join(', ')});\n`);
        }
        offset += rows.length;
        if (rows.length < pageSize) break;
      }
    }
  }

  // Restore constraints/triggers only after rows, so audit/no-delete triggers
  // cannot fire during restoration and duplicate historical events.
  for (const type of ['index', 'view', 'trigger']) {
    for (const object of retained.filter((row) => row.type === type && row.sql !== null)) {
      manifest.statements++;
      yield emitted(terminate(object.sql!));
    }
  }
  manifest.statements += 2;
  const footer = `COMMIT;\nPRAGMA foreign_keys=ON;\n-- COMPLETE triptab-d1-logical-sql-v1 tables=${manifest.tables.length} rows=${manifest.tables.reduce((total, table) => total + table.rows, 0)} statements=${manifest.statements}\n`;
  const finalChunk = emitted(footer);
  manifest.complete = true;
  await options.onComplete?.(manifest);
  yield finalChunk;
}

/** Operator-route adapter. Caller must enforce the global write freeze. */
export function exportDatabaseSql(db: ReadOnlyD1Database, mode: 'schema' | 'database'): AsyncGenerator<string> {
  return generateD1SqlExport(db, { maintenanceFreezeConfirmed: true, mode });
}

/**
 * Bounded inventory for before/after consistency checks. Counts are strings so
 * values never cross the JS-number boundary. Migration values use typed text /
 * hex envelopes; the SQL export includes every non-platform-owned table.
 */
export async function inspectD1ExportMetadata(db: ReadOnlyD1Database): Promise<{
  schema: SchemaRow[];
  tables: Array<{ name: string; row_count: string }>;
  migration_records: Array<{ table: string; columns: string[]; rows: Array<Record<string, unknown>> }>;
  skipped: Array<{ name: string; reason: string }>;
}> {
  const schema = await readRows<SchemaRow>(db, 'SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name LIMIT ?', [5001]);
  if (schema.length > 5000) throw new Error('D1 metadata schema limit exceeded');
  const retained: SchemaRow[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  for (const object of schema) {
    const exclusionReason = portableExclusionReason(object);
    if (exclusionReason) {
      skipped.push({ name: object.name, reason: exclusionReason });
    } else { validateSchema(object); retained.push(object); }
  }
  const tables: Array<{ name: string; row_count: string }> = [];
  const migration_records: Array<{ table: string; columns: string[]; rows: Array<Record<string, unknown>> }> = [];
  for (const table of retained.filter((row) => row.type === 'table')) {
    const count = await readRows<{ row_count: string }>(db, `SELECT CAST(COUNT(*) AS TEXT) AS row_count FROM ${quoteSqlIdentifier(table.name)}`);
    if (count.length !== 1 || typeof count[0].row_count !== 'string' || !/^\d+$/.test(count[0].row_count)) throw new Error('Invalid table count');
    tables.push({ name: table.name, row_count: count[0].row_count });
    if (/(?:^|_)drizzle_migrations$|^d1_migrations$/i.test(table.name)) {
      const columns = (await readRows<ColumnRow>(db, `PRAGMA table_xinfo(${quoteSqlIdentifier(table.name)})`)).filter((column) => column.hidden === 0).map((column) => column.name);
      if (columns.length === 0 || columns.length > 2000) throw new Error('Invalid migration table columns');
      const rows = await readRows<Record<string, unknown>>(db, `SELECT ${projection(columns)} FROM ${quoteSqlIdentifier(table.name)} ORDER BY ${columns.map(quoteSqlIdentifier).join(', ')} LIMIT ?`, [10001]);
      if (rows.length > 10000) throw new Error('D1 migration metadata limit exceeded');
      for (const row of rows) columns.forEach((_column, index) => literal(row[`t${index}`], row[`v${index}`]));
      migration_records.push({ table: table.name, columns, rows });
    }
  }
  return { schema: retained, tables, migration_records, skipped };
}

/** Errors abort the stream, never append a plausible completion marker. */
export function createD1SqlExportStream(db: ReadOnlyD1Database, options: D1SqlExportOptions): ReadableStream<Uint8Array> {
  const iterator = generateD1SqlExport(db, options);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) { controller.error(error); }
    },
    async cancel() { await iterator.return(undefined); },
  });
}
