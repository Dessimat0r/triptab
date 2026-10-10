import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('final packaging excludes migrations only for an independently verified backup Worker', async () => {
  const script = String.raw`
import importlib.util,io,json,tarfile,tempfile,hashlib
from pathlib import Path
spec=importlib.util.spec_from_file_location('package_backup',Path('scripts/package-backup-release.py'))
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
 path=Path(directory)/'backup.tar'
 def fixture(profile='backup',cron=False,worker="const path='/__triptab_backup/';"):
  values={
   'dist/.openai/release-profile.json':json.dumps({'profile':profile,'appliesMigrations':profile!='backup','exportOnly':profile=='backup'}),
   'dist/.openai/hosting.json':'{"d1":"DB","r2":"RECEIPTS","project_id":"fixture"}',
   'dist/server/wrangler.json':json.dumps({'main':'index.js','triggers':{'crons':['* * * * *'] if cron else []}}),
   'dist/server/index.js':worker,
   'dist/.openai/drizzle/0012_fixture.sql':'CREATE TABLE example(id);',
   'dist/.openai/drizzle/meta/_journal.json':'{"entries":[]}',
  }
  with tarfile.open(path,'w:gz') as target:
   entry=tarfile.TarInfo('dist');entry.type=tarfile.DIRTYPE;target.addfile(entry)
   for name,value in values.items():
    data=value.encode();entry=tarfile.TarInfo(name);entry.size=len(data);target.addfile(entry,io.BytesIO(data))
  return values
 values=fixture();module.finalize(path)
 with tarfile.open(path) as target:
  assert all('/drizzle/' not in entry.name for entry in target)
  assert target.extractfile('dist/.openai/hosting.json').read().decode()==values['dist/.openai/hosting.json']
  assert target.extractfile('dist/server/index.js').read().decode()==values['dist/server/index.js']
 for kwargs in [{'profile':'app'},{'cron':True},{'worker':"handler.fetch(request); const path='/__triptab_backup/';"}]:
  fixture(**kwargs);before=hashlib.sha256(path.read_bytes()).hexdigest()
  try: module.finalize(path)
  except ValueError: pass
  else: raise AssertionError('Unsafe profile accepted')
  assert hashlib.sha256(path.read_bytes()).hexdigest()==before
print('Safe backup packaging verified.')
`;
  const { stdout } = await promisify(execFile)('python3', ['-c', script], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    timeout: 15_000,
  });
  assert.match(stdout, /Safe backup packaging verified/);
});
