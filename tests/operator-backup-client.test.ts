import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('operator client verifies encrypted restore, corruption, incomplete exports and existing-file safety', async () => {
  const run = promisify(execFile);
  const { stderr } = await run('python3', [fileURLToPath(new URL('./operator-backup-client.test.py', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 45_000,
    maxBuffer: 1024 * 1024,
  });
  assert.match(stderr, /Ran 5 tests/);
  assert.match(stderr, /\nOK\n/);
});
