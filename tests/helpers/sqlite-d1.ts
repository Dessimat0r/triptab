import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
export class SQLiteStatement {
  values: (string | number | null)[] = [];
  constructor(
    readonly sqlite: DatabaseSync,
    readonly sql: string,
  ) {}
  bind(...values: (string | number | null)[]) {
    this.values = values;
    return this;
  }
  async first<T>() {
    return (this.sqlite.prepare(this.sql).get(...this.values) ||
      null) as T | null;
  }
  async all<T>() {
    return {
      results: this.sqlite.prepare(this.sql).all(...this.values) as T[],
    };
  }
  async run() {
    const statement = this.sqlite.prepare(this.sql);
    const results = statement.columns().length
      ? statement.all(...this.values)
      : [];
    if (!statement.columns().length) statement.run(...this.values);
    return {
      results,
      success: true,
      meta: {
        changes: Number(
          this.sqlite.prepare('SELECT changes() AS changes').get()?.changes ||
            0,
        ),
      },
    };
  }
}
export class SQLiteD1 {
  sqlite = new DatabaseSync(':memory:');
  beforeBatch?: (statements: SQLiteStatement[]) => void;
  private pending: Promise<unknown> = Promise.resolve();
  prepare(sql: string) {
    return new SQLiteStatement(this.sqlite, sql);
  }
  batch(statements: SQLiteStatement[]) {
    const operation = this.pending.then(async () => {
      this.beforeBatch?.(statements);
      this.sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        this.sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        this.sqlite.exec('ROLLBACK');
        throw error;
      }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  asD1() {
    return this as unknown as D1Database;
  }
}
export async function storage() {
  const database = new SQLiteD1();
  for (const file of (await readdir(new URL('../../drizzle/', import.meta.url)))
    .filter((file) => file.endsWith('.sql'))
    .sort())
    database.sqlite.exec(
      await readFile(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'),
    );
  return database;
}
