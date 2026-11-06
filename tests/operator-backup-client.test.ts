import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { pythonCommand } from './python-command';

test(process.platform === 'win32'
  ? 'operator tools reject Windows when POSIX private file modes are unavailable'
  : 'operator client verifies encrypted restore, corruption, incomplete exports and existing-file safety', async () => {
  const run = promisify(execFile);
  const python = pythonCommand();
  if (process.platform === 'win32') {
    for (const script of ['operator-backup.py', 'verify-operator-backup.py']) {
      await assert.rejects(
        run(python.file, [...python.args, fileURLToPath(new URL(`../scripts/${script}`, import.meta.url))], {
          env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
        }),
        (error: unknown) => {
          assert.match((error as Error & { stderr: string }).stderr, /requires POSIX/);
          return true;
        },
      );
    }
    return;
  }
  const { stderr } = await run(python.file, [...python.args, fileURLToPath(new URL('./operator-backup-client.test.py', import.meta.url))], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 45_000,
    maxBuffer: 1024 * 1024,
  });
  assert.match(stderr, /Ran 5 tests/);
  assert.match(stderr, /\nOK\n/);
});
