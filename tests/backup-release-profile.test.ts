import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sites } from '../build/sites-vite-plugin';

test('backup packaging removes stale migration output while normal packaging retains unchanged migrations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'triptab-backup-profile-'));
  try {
    await mkdir(join(root, '.openai'));
    await mkdir(join(root, 'drizzle'));
    await writeFile(join(root, '.openai/hosting.json'), JSON.stringify({ project_id: 'fixture', d1: 'DB', r2: 'RECEIPTS' }));
    const sql = 'CREATE TABLE example(id TEXT PRIMARY KEY);\n';
    await writeFile(join(root, 'drizzle/0013_fixture.sql'), sql);
    for (const copyMigrations of [true, false, true]) {
      const plugin = sites({ copyMigrations }) as unknown as {
        configResolved(config: { root: string; command: string }): void;
        closeBundle(): Promise<void>;
      };
      plugin.configResolved({ root, command: 'build' });
      await plugin.closeBundle();
      const marker = JSON.parse(await readFile(join(root, 'dist/.openai/release-profile.json'), 'utf8'));
      assert.equal(marker.exportOnly, !copyMigrations);
      assert.equal(marker.appliesMigrations, copyMigrations);
      assert.equal(await readFile(join(root, 'drizzle/0013_fixture.sql'), 'utf8'), sql);
      if (copyMigrations) assert.equal(await readFile(join(root, 'dist/.openai/drizzle/0013_fixture.sql'), 'utf8'), sql);
      else await assert.rejects(access(join(root, 'dist/.openai/drizzle')));
      assert.deepEqual(JSON.parse(await readFile(join(root, 'dist/.openai/hosting.json'), 'utf8')), { project_id: 'fixture', d1: 'DB', r2: 'RECEIPTS' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
