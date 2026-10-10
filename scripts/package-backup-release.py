#!/usr/bin/env python3
"""Finalize the explicit export-only artifact after Sites' source packager.

The Sites packager always appends source drizzle files. This bounded post-package
step removes only that injected migration subtree, after verifying the separate
export-only Worker/profile. It never modifies source migrations or app archives.
"""
import json
from pathlib import Path
import os
import sys
import tarfile
import tempfile


def finalize(path):
    path = Path(path).resolve()
    with tarfile.open(path, 'r:*') as source:
        members = source.getmembers()
        names = [entry.name.rstrip('/') for entry in members]
        if len(set(names)) != len(names):
            raise ValueError('Duplicate artifact paths.')
        profile = json.load(source.extractfile('dist/.openai/release-profile.json'))
        if profile != {'profile': 'backup', 'appliesMigrations': False, 'exportOnly': True}:
            raise ValueError('This is not an export-only build.')
        config = json.load(source.extractfile('dist/server/wrangler.json'))
        if config.get('main') != 'index.js' or config.get('triggers', {}).get('crons'):
            raise ValueError('Backup Worker entry or cleanup configuration is invalid.')
        worker = source.extractfile('dist/server/index.js').read().decode('utf-8')
        if '__triptab_backup/' not in worker or 'handler.fetch(request' in worker:
            raise ValueError('Artifact is not the independent backup Worker.')
        for entry in members:
            if not (entry.name.rstrip('/') == 'dist' or entry.name.startswith('dist/')) or '..' in Path(entry.name).parts or not (entry.isdir() or entry.isfile()):
                raise ValueError('Unexpected artifact path/type.')
        fd, temporary = tempfile.mkstemp(prefix='triptab-export-only-', dir=path.parent)
        os.close(fd)
        try:
            with tarfile.open(temporary, 'w:gz') as target:
                for entry in members:
                    name = entry.name.rstrip('/')
                    if name == 'dist/.openai/drizzle' or name.startswith('dist/.openai/drizzle/'):
                        continue
                    target.addfile(entry, source.extractfile(entry) if entry.isfile() else None)
            with tarfile.open(temporary, 'r:*') as target:
                if any(e.name.rstrip('/') == 'dist/.openai/drizzle' or e.name.startswith('dist/.openai/drizzle/') for e in target):
                    raise ValueError('Migration subtree remains.')
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary): os.unlink(temporary)


if __name__ == '__main__':
    if len(sys.argv) != 2: sys.exit('Supply the locally packaged backup archive path.')
    try:
        finalize(sys.argv[1])
        print('Export-only archive verified; migration payload excluded.')
    except Exception:
        sys.exit('Backup archive verification failed; original artifact retained.')
