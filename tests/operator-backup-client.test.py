#!/usr/bin/env python3
"""Synthetic local tests only: no production access or paid API requests."""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import unittest
import urllib.parse

HERE = Path(__file__).parents[1] / 'scripts'


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='triptab-backup-test-')
        self.root = Path(self.temporary.name)
        self.token = 'fixture-only-' + '0' * 48
        self.snapshot = 'fixture-snapshot-only'
        self.bytes = bytes(range(256)) * 17
        self.key = 'fixture-owner%2Btest%40example.invalid/fixture-receipt'
        self.dump_requests = 0
        self.object_requests = 0
        self.change_second_object = False
        self.omit_marker = False
        database = sqlite3.connect(':memory:')
        database.executescript('''
          CREATE TABLE profiles(id TEXT PRIMARY KEY, email TEXT NOT NULL);
          CREATE TABLE auth_credentials(user_id TEXT PRIMARY KEY);
          CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL);
          CREATE TABLE trips(id TEXT PRIMARY KEY,owner TEXT NOT NULL,data TEXT NOT NULL);
          CREATE TABLE account_activity_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT NOT NULL);
          CREATE TRIGGER account_activity_events_no_delete BEFORE DELETE ON account_activity_events
            BEGIN SELECT RAISE(ABORT,'append-only'); END;
          CREATE TABLE receipts(id TEXT PRIMARY KEY,owner TEXT NOT NULL,trip_id TEXT NOT NULL,
            state TEXT NOT NULL,size_bytes INTEGER NOT NULL,sha256 TEXT NOT NULL);
          CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,applied_at TEXT NOT NULL);
        ''')
        database.execute('INSERT INTO profiles VALUES(?,?)', ('fixture-owner', 'example@example.invalid'))
        database.execute('INSERT INTO auth_credentials VALUES(?)', ('fixture-owner',))
        database.execute('INSERT INTO auth_sessions VALUES(?,?)', ('fake-session-hash', 'fixture-owner'))
        trip = {'expenses': [{'receiptId': 'fixture-receipt'}], 'drafts': []}
        database.execute('INSERT INTO trips VALUES(?,?,?)', ('fixture-trip', 'fixture-owner', json.dumps(trip)))
        database.execute('INSERT INTO account_activity_events(user_id) VALUES(?)', ('fixture-owner',))
        database.execute('INSERT INTO receipts VALUES(?,?,?,?,?,?)',
                         ('fixture-receipt', 'fixture-owner+test@example.invalid', 'fixture-trip', 'active',
                          len(self.bytes), hashlib.sha256(self.bytes).hexdigest()))
        database.execute('INSERT INTO d1_migrations(name,applied_at) VALUES(?,?)', ('0011_fixture.sql', '2026-01-01'))
        database.commit()
        names = [row[0] for row in database.execute("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")]
        tables = [{'name': name, 'row_count': str(database.execute('SELECT COUNT(*) FROM "' + name + '"').fetchone()[0])}
                  for name in names]
        schema = [dict(zip(('type', 'name', 'tbl_name', 'sql'), row)) for row in database.execute(
            'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name')]
        self.database_metadata = {'tables': tables, 'schema': schema, 'skipped': []}
        self.sql = ('\n'.join(database.iterdump()) + '\n' +
                    '-- COMPLETE triptab-d1-logical-sql-v1 tables=' + str(len(tables)) +
                    ' rows=' + str(sum(int(table['row_count']) for table in tables)) + ' statements=100\n').encode()
        database.close()
        suite = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.headers.get('Authorization') != 'Bearer ' + suite.token:
                    self.send_error(401)
                    return
                path = urllib.parse.urlsplit(self.path)
                endpoint = path.path.rsplit('/', 1)[-1]
                if endpoint == 'metadata':
                    content = {'snapshot_id': suite.snapshot,
                               'database_fingerprint': hashlib.sha256(json.dumps(suite.database_metadata).encode()).hexdigest(),
                               'database': suite.database_metadata, 'time_travel_bookmark': None}
                    body, content_type = json.dumps(content).encode(), 'application/json'
                elif endpoint == 'database':
                    suite.dump_requests += 1
                    body = suite.sql
                    if suite.omit_marker:
                        body = body[:body.index(b'-- COMPLETE')]
                    content_type = 'text/plain'
                elif endpoint == 'schema':
                    body, content_type = b'-- fixture schema preserved in database.sql\n', 'text/plain'
                elif endpoint == 'objects':
                    body = json.dumps({'snapshot_id': suite.snapshot, 'truncated': False, 'objects': [
                        {'key': suite.key, 'size': len(suite.bytes), 'etag': 'fixture-etag',
                         'uploaded': '2026-01-01', 'httpMetadata': {'contentType': 'image/jpeg'}, 'customMetadata': {}}]}).encode()
                    content_type = 'application/json'
                elif endpoint == 'object':
                    suite.object_requests += 1
                    body = suite.bytes
                    if suite.change_second_object and suite.object_requests == 2:
                        body = bytes([body[0] ^ 1]) + body[1:]
                    content_type = 'image/jpeg'
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('X-TripTab-Snapshot-Id', suite.snapshot)
                self.end_headers()
                self.wfile.write(body)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def run_client(self):
        migrations = self.root / 'migrations'
        migrations.mkdir()
        mirror = HERE.parent
        paths = []
        for name in ('0012_trip_lifecycle_email_recovery.sql', '0013_account_preferences.sql'):
            path = migrations / name
            sql = (mirror / 'drizzle' / name).read_bytes()
            path.write_bytes(sql)
            paths.append(path)
        command = ['python3', str(HERE / 'operator-backup.py'), '--base-url', 'http://127.0.0.1:' + str(self.server.server_port),
                   '--allow-localhost-test', '--output-dir', str(self.root / 'backups'),
                   '--key-dir', str(self.root / 'keys'), '--token-stdin']
        for path in paths:
            command.extend(['--migration', str(path)])
        return subprocess.run(command, input=self.token + '\n', stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True)

    def test_complete_backup_and_fresh_restore(self):
        result = self.run_client()
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary['object_count'], 1)
        self.assertEqual(self.dump_requests, 2)
        self.assertEqual(self.object_requests, 2)
        archive, key = Path(summary['encrypted_backup']), Path(summary['recovery_key'])
        self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
        self.assertEqual(key.stat().st_mode & 0o777, 0o600)
        self.assertTrue(archive.read_bytes().startswith(b'TRIPBK01'))
        self.assertNotIn(b'CREATE TABLE', archive.read_bytes())
        verified = subprocess.run(['python3', str(HERE / 'verify-operator-backup.py'), str(archive), str(key)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertEqual(json.loads(verified.stdout)['object_count'], 1)
        self.assertNotIn(self.token, result.stdout + result.stderr + verified.stdout + verified.stderr)

    def test_changed_second_object_fails_without_artifact(self):
        self.change_second_object = True
        result = self.run_client()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('Two complete object-byte exports did not match', result.stderr)
        self.assertEqual(list((self.root / 'backups').iterdir()), [])
        self.assertEqual(list((self.root / 'keys').iterdir()), [])

    def test_truncated_dump_fails_without_artifact(self):
        self.omit_marker = True
        result = self.run_client()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('completed-snapshot marker', result.stderr)
        self.assertEqual(list((self.root / 'backups').iterdir()), [])

    def test_ciphertext_corruption_is_rejected(self):
        result = self.run_client()
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        archive = Path(summary['encrypted_backup'])
        corrupt = bytearray(archive.read_bytes())
        corrupt[len(corrupt) // 2] ^= 1
        archive.write_bytes(corrupt)
        verified = subprocess.run(['python3', str(HERE / 'verify-operator-backup.py'), str(archive), summary['recovery_key']],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.assertNotEqual(verified.returncode, 0)
        self.assertIn('Encrypted archive verification failed', verified.stderr)

    def test_existing_output_and_key_are_never_deleted(self):
        source = self.root / 'source.bin'
        source.write_bytes(b'fixture plaintext')
        existing_output = self.root / 'existing-output.enc'
        existing_output.write_bytes(b'preserve existing artifact')
        created_key = self.root / 'new-key.json'
        failed = subprocess.run(['node', str(HERE / 'encrypt-archive.mjs'), 'encrypt',
                                 str(source), str(existing_output), str(created_key)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(existing_output.read_bytes(), b'preserve existing artifact')
        self.assertFalse(created_key.exists())
        existing_key = self.root / 'existing-key.json'
        existing_key.write_bytes(b'preserve existing key')
        new_output = self.root / 'new-output.enc'
        failed = subprocess.run(['node', str(HERE / 'encrypt-archive.mjs'), 'encrypt',
                                 str(source), str(new_output), str(existing_key)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotEqual(failed.returncode, 0)
        self.assertEqual(existing_key.read_bytes(), b'preserve existing key')
        self.assertFalse(new_output.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
