#!/usr/bin/env python3
"""Decrypt and verify a backup in an isolated temporary directory only."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile

spec = importlib.util.spec_from_file_location('triptab_backup', Path(__file__).with_name('operator-backup.py'))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive')
    parser.add_argument('key')
    parser.add_argument('--verify-command', action='append', default=[])
    args = parser.parse_args()
    os.umask(0o077)
    archive_path, key_path = Path(args.archive).resolve(), Path(args.key).resolve()
    if key_path.stat().st_mode & 0o077:
        raise backup.BackupError('Recovery key permissions must restrict access to its owner.')
    with tempfile.TemporaryDirectory(prefix='triptab-private-restore-') as temporary:
        workspace = Path(temporary)
        workspace.chmod(0o700)
        plain_archive = workspace / 'archive.tar'
        backup.crypto('decrypt', archive_path, plain_archive, key_path)
        content = workspace / 'content'
        content.mkdir(mode=0o700)
        with tarfile.open(plain_archive, 'r:') as archive:
            for member in archive:
                target = content / member.name
                if Path(member.name).is_absolute() or content.resolve() not in target.resolve().parents:
                    raise backup.BackupError('Recovery archive contained an unsafe path.')
                if member.isdir():
                    target.mkdir(parents=True, mode=0o700, exist_ok=True)
                elif member.isfile():
                    target.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
                    source = archive.extractfile(member)
                    with source, target.open('xb') as destination:
                        os.chmod(target, 0o600)
                        while chunk := source.read(1024 * 1024):
                            destination.write(chunk)
                else:
                    raise backup.BackupError('Recovery archive contained an unsupported file type.')
        report = json.loads((content / 'verification.json').read_text(encoding='utf-8'))
        objects = json.loads((content / 'object-manifest.json').read_text(encoding='utf-8'))
        metadata = json.loads((content / 'source-metadata.json').read_text(encoding='utf-8'))
        if backup.sha_file(content / 'database.sql') != report['database']['sha256']:
            raise backup.BackupError('Recovery SQL checksum did not match its manifest.')
        backup.check_dump_end(content / 'database.sql', metadata)
        for item in objects:
            path = content / item['archive_path']
            if content.resolve() not in path.resolve().parents or path.stat().st_size != item['size_bytes'] or (
                    backup.sha_file(path) != item['sha256']):
                raise backup.BackupError('Recovery object bytes did not match their manifest.')
        restored = backup.restore_sql(content / 'database.sql', workspace / 'restored.sqlite')
        try:
            tables = backup.table_records(restored)
            backup.compare_metadata_counts(metadata, tables)
            backup.compare_metadata_schema(metadata, restored)
            backup.verify_receipts(restored, objects)
            migrations = []
            for migration in report['migration_verification']['migrations']:
                path = content / 'migrations' / migration['name']
                if content.resolve() not in path.resolve().parents or backup.sha_file(path) != migration['sha256']:
                    raise backup.BackupError('Recovery migration checksum did not match its manifest.')
                migrations.append(path)
            backup.verify_migrations(restored, workspace / 'restored.sqlite', migrations, workspace, args.verify_command)
        finally:
            restored.close()
        print(json.dumps({'status': 'verified', 'archive_sha256': backup.sha_file(archive_path),
                          'sqlite_integrity_check': 'ok', 'sqlite_foreign_key_check': 'ok',
                          'table_count': len(tables), 'row_count': sum(table['row_count'] for table in tables.values()),
                          'object_count': len(objects), 'all_object_byte_checksums_verified': True,
                          'application_financial_verification_complete': bool(args.verify_command),
                          'hosted_restore_verified': False}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except backup.BackupError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception as error:
        print('Recovery verification failed (' + type(error).__name__ + ').', file=sys.stderr)
        sys.exit(1)
