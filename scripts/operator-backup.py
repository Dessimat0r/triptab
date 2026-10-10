#!/usr/bin/env python3
"""Protected one-off D1/R2 backup client. Does not modify the remote Site.

The token is supplied through TRIPTAB_BACKUP_TOKEN or stdin, never argv.
All plaintext is confined to a 0700 temporary directory and removed on exit.
The final artifact is AES-256-GCM encrypted; its 0600 key is kept separately.
"""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


class BackupError(Exception):
    pass


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def private_dir(path):
    path = Path(path).resolve()
    if any((parent / '.git').exists() for parent in (path, *path.parents)):
        raise BackupError('Backup artifacts and recovery keys must be stored outside Git repositories.')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_symlink() or path.stat().st_uid != os.getuid():
        raise BackupError('Backup directory ownership is invalid.')
    path.chmod(0o700)
    return path


def json_file(path, value):
    with open(path, 'x', encoding='utf-8') as target:
        os.chmod(path, 0o600)
        json.dump(value, target, indent=2, ensure_ascii=False)
        target.write('\n')


def sha_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BackupError('Backup endpoint redirected; the token was not forwarded.')


class Client:
    def __init__(self, base_url, token, allow_localhost=False):
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise BackupError('Use a plain HTTPS Site origin without credentials.')
        if parsed.path not in ('', '/'):
            raise BackupError('Base URL must be the Site origin.')
        if parsed.scheme != 'https' and not (
                allow_localhost and parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1')):
            raise BackupError('Remote backup requests require HTTPS.')
        if not token or '\n' in token or '\r' in token:
            raise BackupError('Provide the operator token through stdin or environment.')
        self.base = base_url.rstrip('/') + '/__triptab_backup/'
        self.token = token
        self.snapshot = None
        self.last_request_at = 0.0
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, route, query=None):
        url = self.base + route
        if query:
            url += '?' + urllib.parse.urlencode(query)
        req = urllib.request.Request(url, headers={
            'Authorization': 'Bearer ' + self.token, 'Cache-Control': 'no-store',
            'Accept': 'application/json' if route in ('metadata', 'objects') else 'application/octet-stream',
        })
        for attempt in range(4):
            remaining = 0.2 - (time.monotonic() - self.last_request_at)
            if remaining > 0:
                time.sleep(remaining)
            self.last_request_at = time.monotonic()
            try:
                response = self.opener.open(req, timeout=90)
                break
            except urllib.error.HTTPError as error:
                if error.code == 429 and attempt < 3:
                    retry_after = error.headers.get('Retry-After', '1')
                    delay = min(5, max(1, int(retry_after))) if retry_after.isdecimal() else 1
                    error.close()
                    time.sleep(delay)
                    continue
                raise BackupError('Backup request failed with HTTP ' + str(error.code) + '.') from None
            except (urllib.error.URLError, TimeoutError):
                raise BackupError('Backup endpoint could not be reached.') from None
        snapshot = response.headers.get('X-TripTab-Snapshot-Id')
        if not snapshot or (self.snapshot and snapshot != self.snapshot):
            response.close()
            raise BackupError('The backup snapshot identity changed or was missing.')
        if not self.snapshot:
            self.snapshot = snapshot
        return response

    def get_json(self, route, query=None):
        with self.request(route, query) as response:
            body = response.read(16 * 1024 * 1024 + 1)
        if len(body) > 16 * 1024 * 1024:
            raise BackupError('Backup metadata exceeded its size limit.')
        try:
            return json.loads(body)
        except (ValueError, UnicodeError):
            raise BackupError('Backup metadata was not valid JSON.') from None

    def download(self, route, path, limit, query=None):
        digest, size = hashlib.sha256(), 0
        with self.request(route, query) as response, open(path, 'xb') as target:
            os.chmod(path, 0o600)
            content_type = response.headers.get('Content-Type', '')
            declared = response.headers.get('Content-Length')
            expected_sha = response.headers.get('X-Content-SHA256')
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise BackupError('Backup payload exceeded its configured size limit.')
                digest.update(chunk)
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
        value = digest.hexdigest()
        if declared and int(declared) != size:
            raise BackupError('Backup payload was incomplete.')
        if expected_sha and expected_sha.lower() != value:
            raise BackupError('Backup payload checksum failed.')
        return {'sha256': value, 'size_bytes': size, 'content_type': content_type}

    def objects(self):
        objects, cursor, cursors, keys = [], None, set(), set()
        while True:
            page = self.get_json('objects', {'cursor': cursor} if cursor else None)
            if page.get('snapshot_id', self.snapshot) != self.snapshot:
                raise BackupError('Object listing snapshot identity changed.')
            entries = page.get('objects')
            if not isinstance(entries, list):
                raise BackupError('Object listing did not contain an object array.')
            for entry in entries:
                key = entry.get('key')
                if not isinstance(key, str) or not key or key in keys:
                    raise BackupError('Object listing contained a missing or duplicate key.')
                if not isinstance(entry.get('size'), int) or entry['size'] < 0:
                    raise BackupError('Object listing contained an invalid size.')
                keys.add(key)
                objects.append(entry)
            if not page.get('truncated', False):
                break
            cursor = page.get('cursor')
            if not isinstance(cursor, str) or not cursor or cursor in cursors:
                raise BackupError('Object listing cursor did not advance.')
            cursors.add(cursor)
        return sorted(objects, key=lambda item: item['key'])


def q(name):
    return '"' + name.replace('"', '""') + '"'


def sql_authorizer(action, *_):
    return sqlite3.SQLITE_DENY if action in (sqlite3.SQLITE_ATTACH, sqlite3.SQLITE_DETACH) else sqlite3.SQLITE_OK


def restore_sql(sql_path, db_path):
    database = sqlite3.connect(db_path)
    database.set_authorizer(sql_authorizer)
    try:
        # Keep a single SQL statement in memory. SQLite's statement parser
        # handles quoted values and trigger bodies; never split on semicolons.
        pending = ''
        with sql_path.open('r', encoding='utf-8') as source:
            for line in source:
                pending += line
                if sqlite3.complete_statement(pending):
                    database.execute(pending)
                    pending = ''
        if re.sub(r'--[^\n]*(?:\n|$)', '', pending).strip():
            raise BackupError('Database export ended with an incomplete SQL statement.')
        database.commit()
        check_database(database)
    except Exception:
        database.close()
        raise
    return database


def check_database(database):
    database.execute('PRAGMA foreign_keys=ON')
    if database.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
        raise BackupError('Restored SQLite integrity check failed.')
    if database.execute('PRAGMA foreign_key_check').fetchone() is not None:
        raise BackupError('Restored SQLite foreign-key check failed.')


def schema_rows(database):
    return [dict(zip(('type', 'name', 'tbl_name', 'sql'), row)) for row in database.execute(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name")]


def table_records(database):
    records = {}
    for (name,) in database.execute("SELECT name FROM sqlite_schema WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence') ORDER BY name"):
        columns = [row[1] for row in database.execute('PRAGMA table_info(' + q(name) + ')')]
        records[name] = {'columns': columns, 'row_count': database.execute('SELECT COUNT(*) FROM ' + q(name)).fetchone()[0]}
    return records


def stable_value(value):
    if isinstance(value, bytes):
        return {'binary_base64': base64.b64encode(value).decode('ascii')}
    return value


def table_hash(database, name, columns):
    digest = hashlib.sha256()
    fields = ','.join(q(column) for column in columns)
    order = ','.join(str(index + 1) for index in range(len(columns)))
    for row in database.execute('SELECT ' + fields + ' FROM ' + q(name) + ' ORDER BY ' + order):
        encoded = json.dumps([stable_value(value) for value in row], ensure_ascii=False, separators=(',', ':'))
        digest.update(encoded.encode('utf-8') + b'\n')
    return digest.hexdigest()


def migration_records(database, tables):
    result = []
    for name, record in tables.items():
        if 'migration' in name.lower():
            rows = [[stable_value(value) for value in row] for row in database.execute('SELECT * FROM ' + q(name))]
            result.append({'table': name, 'columns': record['columns'], 'rows': rows})
    return result


def compare_metadata_counts(metadata, records):
    remote = metadata.get('database', {}).get('tables')
    if not isinstance(remote, list):
        raise BackupError('Database metadata must expose all table row counts.')
    expected = {}
    for table in remote:
        name = table.get('name')
        count = table.get('row_count', table.get('rowCount', table.get('count')))
        if isinstance(count, str) and count.isdecimal():
            count = int(count)
        if not isinstance(name, str) or not isinstance(count, int):
            raise BackupError('Database metadata table counts were invalid.')
        expected[name] = count
    actual = {name: record['row_count'] for name, record in records.items()}
    if expected != actual:
        raise BackupError('Restored database table counts did not match the source.')


def compare_metadata_schema(metadata, database):
    remote = metadata.get('database', {}).get('schema')
    if not isinstance(remote, list):
        raise BackupError('Database metadata must expose the complete source schema.')
    expected = [item for item in remote if item.get('sql') is not None and not item['name'].startswith('sqlite_')]
    expected.sort(key=lambda item: (item['type'], item['name']))
    if expected != schema_rows(database):
        raise BackupError('Restored database schema, indexes or triggers did not match the source.')


def verify_receipts(database, objects):
    tables = table_records(database)
    if 'receipts' not in tables:
        raise BackupError('Backup is missing the receipts table.')
    object_map = {item['key']: item for item in objects}
    columns = tables['receipts']['columns']
    receipts = [dict(zip(columns, row)) for row in database.execute('SELECT * FROM receipts')]
    referenced, active_missing, other_missing, checksum_mismatches = set(), [], [], []
    id_to_receipt = {}
    for receipt in receipts:
        key = urllib.parse.quote(receipt['owner'], safe="-_.!~*'()") + '/' + receipt['id']
        id_to_receipt[receipt['id']] = receipt
        referenced.add(key)
        found = object_map.get(key)
        if found is None:
            (active_missing if receipt.get('state', 'active') == 'active' else other_missing).append(key)
            continue
        expected_digest = receipt.get('sha256')
        expected_size = receipt.get('size_bytes')
        if (expected_digest and expected_digest.lower() != found['sha256']) or (
                expected_size and expected_size != found['size_bytes']):
            checksum_mismatches.append(key)
    missing_live_rows = []
    if 'trips' in tables:
        for (data,) in database.execute('SELECT data FROM trips'):
            try:
                trip = json.loads(data)
            except (ValueError, TypeError):
                raise BackupError('Restored trip data contained invalid JSON.') from None
            for kind in ('expenses', 'drafts'):
                for entry in trip.get(kind, []):
                    receipt_id = entry.get('receiptId')
                    if receipt_id and receipt_id not in id_to_receipt:
                        missing_live_rows.append(receipt_id)
    result = {'receipt_row_count': len(receipts), 'active_missing_objects': active_missing,
              'pending_or_deleting_missing_objects': other_missing,
              'receipt_byte_mismatches': checksum_mismatches,
              'live_trip_receipt_ids_missing_database_rows': sorted(set(missing_live_rows)),
              'unreferenced_object_keys': sorted(set(object_map) - referenced)}
    if active_missing or checksum_mismatches or missing_live_rows:
        raise BackupError('Receipt-reference or stored receipt-byte verification failed.')
    return result


def verify_finances(command, path):
    if not command:
        return None
    completed = subprocess.run([*command, str(path)], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if completed.returncode:
        raise BackupError('Application financial validation failed.')
    if len(completed.stdout) > 1024 * 1024:
        raise BackupError('Application financial verification output exceeded its limit.')
    try:
        result = json.loads(completed.stdout)
    except (ValueError, UnicodeError):
        raise BackupError('Application financial verification returned invalid JSON.') from None
    if not isinstance(result, dict) or not isinstance(result.get('financialFingerprint'), str):
        raise BackupError('Application financial verification omitted its fingerprint.')
    return result


def verify_migrations(database, db_path, paths, workspace, financial_command):
    baseline = table_records(database)
    hashes = {name: table_hash(database, name, record['columns']) for name, record in baseline.items()}
    finances_before = verify_finances(financial_command, db_path)
    target_path = workspace / 'migration-check.sqlite'
    with sqlite3.connect(target_path) as target:
        database.backup(target)
        target.set_authorizer(sql_authorizer)
        migrations = []
        for migration_path in paths:
            migration_path = Path(migration_path)
            sql = migration_path.read_text(encoding='utf-8')
            # sqlite executescript respects trigger bodies and comments; the
            # Drizzle delimiter is a SQL comment, so no unsafe semicolon split.
            target.executescript(sql)
            target.commit()
            check_database(target)
            migrations.append({'name': migration_path.name, 'sha256': sha_file(migration_path)})
            copied = workspace / 'migrations' / migration_path.name
            copied.parent.mkdir(mode=0o700, exist_ok=True)
            shutil.copyfile(migration_path, copied)
            copied.chmod(0o600)
        after = table_records(target)
        for name, record in baseline.items():
            if name not in after or after[name]['row_count'] != record['row_count'] or (
                    table_hash(target, name, record['columns']) != hashes[name]):
                raise BackupError('A pending migration changed a pre-existing row or field.')
        finances_after = verify_finances(financial_command, target_path)
        if finances_before != finances_after:
            raise BackupError('Pending migrations changed application financial verification results.')
        return {'migrations': migrations, 'integrity_check': 'ok', 'foreign_key_check': 'ok',
                'existing_table_row_counts_and_fields_preserved': True,
                'application_financial_verification': finances_before,
                'post_migration_tables': after,
                'limitation': 'Local SQLite verification does not establish provider import capability or a D1 Time Travel bookmark.'}


def crypto(mode, source, destination, key_path):
    helper = Path(__file__).with_name('encrypt-archive.mjs')
    completed = subprocess.run(['node', str(helper), mode, str(source), str(destination), str(key_path)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if completed.returncode:
        raise BackupError('Encrypted archive verification failed.')


def check_dump_end(path, metadata):
    # SQL streams finish with an explicit marker only after every table/schema
    # record was exported. HTTP EOF alone can occur after a streaming failure.
    with open(path, 'rb') as source:
        source.seek(max(0, path.stat().st_size - 1024))
        tail = source.read().decode('utf-8', errors='strict').rstrip()
    complete = re.search(r'-- COMPLETE triptab-d1-logical-sql-v1 tables=(\d+) rows=(\d+) statements=(\d+)$', tail)
    if not complete:
        raise BackupError('Database export did not contain its completed-snapshot marker.')
    tables = metadata.get('database', {}).get('tables', [])
    expected_rows = sum(int(item['row_count']) for item in tables)
    if int(complete[1]) != len(tables) or int(complete[2]) != expected_rows:
        raise BackupError('Completed database export marker counts did not match source metadata.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--key-dir', required=True)
    parser.add_argument('--token-stdin', action='store_true')
    parser.add_argument('--migration', action='append', default=[])
    parser.add_argument('--verify-command', action='append', default=[],
                        help='Repeat for each local verifier argv component; use = for components beginning with -.')
    parser.add_argument('--allow-localhost-test', action='store_true')
    parser.add_argument('--max-database-bytes', type=int, default=4 * 1024 ** 3)
    parser.add_argument('--max-object-bytes', type=int, default=256 * 1024 ** 2)
    args = parser.parse_args()
    os.umask(0o077)
    def interrupted(_signal, _frame):
        raise BackupError('Backup was interrupted; temporary plaintext was removed.')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    token = sys.stdin.readline().strip() if args.token_stdin else os.environ.pop('TRIPTAB_BACKUP_TOKEN', '').strip()
    client = Client(args.base_url, token, args.allow_localhost_test)
    output_dir, key_dir = private_dir(args.output_dir), private_dir(args.key_dir)
    if output_dir == key_dir or output_dir in key_dir.parents or key_dir in output_dir.parents:
        raise BackupError('Store the recovery key in a separate directory from the encrypted backup.')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + os.urandom(4).hex()
    encrypted_path = output_dir / (stamp + '.triptab-backup.enc')
    key_path = key_dir / (stamp + '.recovery-key.json')
    completed = False
    encrypted_created = False
    try:
        with tempfile.TemporaryDirectory(prefix='triptab-private-backup-') as temporary:
            workspace = Path(temporary)
            workspace.chmod(0o700)
            before = client.get_json('metadata')
            if before.get('snapshot_id') != client.snapshot or not before.get('database_fingerprint'):
                raise BackupError('Database snapshot metadata was incomplete.')
            json_file(workspace / 'source-metadata.json', before)
            sql_info = client.download('database', workspace / 'database.sql', args.max_database_bytes)
            check_dump_end(workspace / 'database.sql', before)
            client.download('schema', workspace / 'schema.sql', 64 * 1024 ** 2)
            database = restore_sql(workspace / 'database.sql', workspace / 'restore-check.sqlite')
            try:
                records = table_records(database)
                compare_metadata_counts(before, records)
                compare_metadata_schema(before, database)
                json_file(workspace / 'database-schema.json', schema_rows(database))
                json_file(workspace / 'migration-records.json', migration_records(database, records))
                objects = client.objects()
                (workspace / 'objects').mkdir(mode=0o700)
                total_bytes = 0
                for item in objects:
                    filename = hashlib.sha256(item['key'].encode('utf-8')).hexdigest() + '.bin'
                    info = client.download('object', workspace / 'objects' / filename, args.max_object_bytes,
                                           {'key': item['key']})
                    if item['size'] != info['size_bytes']:
                        raise BackupError('An object changed while the backup was being downloaded.')
                    item.update(info, archive_path='objects/' + filename, copied_at=utc_now())
                    total_bytes += info['size_bytes']
                # Re-list all objects to detect additions/deletions/replacements.
                after_objects = client.objects()
                identity = lambda entries: [(entry['key'], entry['size'], entry.get('etag'), entry.get('uploaded')) for entry in entries]
                if identity(objects) != identity(after_objects):
                    raise BackupError('The R2 object listing changed during the backup.')
                # Independently download every complete SQL value and every R2
                # object a second time. Compare exact bytes, not only listing
                # sizes/ETags or provider metadata. Writes must remain paused.
                second_sql = workspace / 'database-second.sql'
                second_sql_info = client.download('database', second_sql, args.max_database_bytes)
                check_dump_end(second_sql, before)
                if second_sql_info['sha256'] != sql_info['sha256']:
                    raise BackupError('Two complete database exports did not match.')
                second_sql.unlink()
                second_dir = workspace / 'object-verification'
                second_dir.mkdir(mode=0o700)
                for item in objects:
                    copy_path = second_dir / hashlib.sha256(item['key'].encode('utf-8')).hexdigest()
                    second_info = client.download('object', copy_path, args.max_object_bytes, {'key': item['key']})
                    if second_info['size_bytes'] != item['size_bytes'] or second_info['sha256'] != item['sha256']:
                        raise BackupError('Two complete object-byte exports did not match.')
                    copy_path.unlink()
                second_dir.rmdir()
                if identity(objects) != identity(client.objects()):
                    raise BackupError('The R2 object listing changed after the second complete export.')
                receipt_report = verify_receipts(database, objects)
                migration_report = verify_migrations(database, workspace / 'restore-check.sqlite', args.migration, workspace, args.verify_command)
                after = client.get_json('metadata')
                if before['database_fingerprint'] != after.get('database_fingerprint'):
                    raise BackupError('Database data or schema changed while the backup was being downloaded.')
                json_file(workspace / 'object-manifest.json', objects)
                report = {'format': 'triptab-operator-backup-v1', 'created_at': utc_now(),
                          'snapshot_id': client.snapshot, 'database_fingerprint': before['database_fingerprint'],
                          'database': sql_info, 'tables': records, 'object_count': len(objects),
                          'object_size_bytes': total_bytes, 'sqlite_integrity_check': 'ok',
                          'sqlite_foreign_key_check': 'ok', 'source_schema_indexes_and_triggers_verified': True,
                          'receipts': receipt_report,
                          'migration_verification': migration_report,
                          'd1_time_travel_bookmark': before.get('time_travel_bookmark', before.get('d1_time_travel_bookmark')),
                          'excluded_provider_internal_tables': before.get('database', {}).get('skipped', []),
                          'restore_limitations': ['No Cloudflare Time Travel bookmark is created by an application-level export.',
                                                 'Provider-level D1/R2 import and application smoke tests require an isolated hosted restore.']}
                json_file(workspace / 'verification.json', report)
            finally:
                database.close()
            # The SQLite verification copies are unnecessary in the recovery
            # archive: database.sql plus exact objects/schema/migrations suffice.
            (workspace / 'restore-check.sqlite').unlink()
            (workspace / 'migration-check.sqlite').unlink()
            archive_path = workspace / 'backup.tar'
            with tarfile.open(archive_path, 'w') as archive:
                for item in sorted(workspace.iterdir()):
                    if item != archive_path:
                        archive.add(item, arcname=item.name, recursive=True)
            archive_sha = sha_file(archive_path)
            crypto('encrypt', archive_path, encrypted_path, key_path)
            encrypted_created = True
            roundtrip_path = workspace / 'roundtrip.tar'
            crypto('decrypt', encrypted_path, roundtrip_path, key_path)
            if sha_file(roundtrip_path) != archive_sha:
                raise BackupError('Encrypted archive round-trip checksum failed.')
            summary = {'status': 'verified', 'created_at': report['created_at'],
                       'encrypted_backup': str(encrypted_path), 'recovery_key': str(key_path),
                       'encrypted_size_bytes': encrypted_path.stat().st_size,
                       'encrypted_sha256': sha_file(encrypted_path), 'plaintext_archive_sha256': archive_sha,
                       'table_count': len(records), 'row_count': sum(table['row_count'] for table in records.values()),
                       'object_count': len(objects), 'object_size_bytes': total_bytes,
                       'sqlite_restore_verified': True, 'encryption_roundtrip_verified': True,
                       'two_complete_database_and_object_exports_matched': True,
                       'application_financial_verification_complete': bool(args.verify_command),
                       'migrations_verified': [item['name'] for item in migration_report['migrations']],
                       'd1_time_travel_bookmark_available': bool(report['d1_time_travel_bookmark']),
                       'applied_migration_record_available': bool(
                           json.loads((workspace / 'migration-records.json').read_text(encoding='utf-8'))),
                       'hosted_restore_verified': False}
            json_file(output_dir / (stamp + '.verification-summary.json'), summary)
            completed = True
            # Only paths and aggregate counts appear in console output.
            print(json.dumps(summary, indent=2))
    finally:
        if not completed and encrypted_created:
            encrypted_path.unlink(missing_ok=True)
            key_path.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except BackupError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        # Never render raw SQL, receipt details, response content or tokens.
        print('Backup failed during local verification (' + type(error).__name__ + ').', file=sys.stderr)
        sys.exit(1)
