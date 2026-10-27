#!/usr/bin/env python3
"""Reject private runtime files or unredacted data in the Git index.

Reads staged Git objects, never prints offending values, and leaves the working
configuration alone. Install the local hook with --install-hook.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess


def load_policy(root):
    path = root / 'onebot-onebot-custom/scripts/prepare-sanitized-git.py'
    spec = importlib.util.spec_from_file_location('snapshot_policy', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def forbidden(path, policy):
    if len(path.parts) == 1 and (path.name == 'openclaw.json' or path.name.startswith('onebot-') and path.suffix == '.json'):
        return True
    if any(part in policy.BLOCKED for part in path.parts):
        return True
    return path.name == '.env' or path.name in policy.DEBUG_FILES or path.name.endswith(('.db', '.sqlite', '.sqlite3', '.pem', '.key', '.token'))


def check(root):
    policy = load_policy(root)
    mapping = policy.privacy_mapping(root)
    credentials = policy.local_credentials(root)
    records = subprocess.check_output(['git', '-C', str(root), 'ls-files', '--stage', '-z']).split(b'\0')
    files, issues = {}, []
    proc = subprocess.Popen(['git', '-C', str(root), 'cat-file', '--batch'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        for record in records:
            if not record:
                continue
            meta, raw_path = record.split(b'\t', 1)
            mode, oid, stage = meta.split()
            path = Path(os.fsdecode(raw_path))
            if stage != b'0':
                issues.append({'file': str(path), 'category': 'unmerged_index'})
                continue
            if forbidden(path, policy):
                issues.append({'file': str(path), 'category': 'private_runtime_file'})
                continue
            if mode in (b'120000', b'160000'):
                issues.append({'file': str(path), 'category': 'unreviewed_link_or_submodule'})
                continue
            proc.stdin.write(oid + b'\n')
            proc.stdin.flush()
            header = proc.stdout.readline().split()
            data = proc.stdout.read(int(header[2]))
            proc.stdout.read(1)
            try:
                data.decode('utf-8')
            except UnicodeError:
                issues.append({'file': str(path), 'category': 'unreviewed_binary'})
                continue
            files[path] = data
    finally:
        proc.stdin.close()
        proc.stdout.close()
        proc.wait()
    issues.extend(policy.scan_snapshot(files, mapping, credentials))
    for path, data in files.items():
        if path.parent == policy.EXAMPLE_DIRECTORY and path.suffix == '.json':
            expected = policy.example_configs().get(path)
            if expected is None or data != expected:
                issues.append({'file': str(path), 'category': 'configuration_example_must_be_generic'})
    return {'passed': not issues, 'filesChecked': len(files), 'knownCredentialsCompared': len(credentials), 'issues': issues}


def install_hook(root):
    configured = subprocess.run(['git', '-C', str(root), 'config', '--get', 'core.hooksPath'], capture_output=True, text=True)
    if configured.returncode == 0:
        directory = Path(configured.stdout.strip())
        if not directory.is_absolute():
            directory = root / directory
    else:
        directory = Path(subprocess.check_output(['git', '-C', str(root), 'rev-parse', '--absolute-git-dir'], text=True).strip()) / 'hooks'
    directory.mkdir(parents=True, exist_ok=True)
    hook = directory / 'pre-commit'
    marker = '# openclaw sanitized-index guard'
    if hook.exists() and marker not in hook.read_text():
        raise RuntimeError('Existing pre-commit hook must be preserved; refusing to replace it')
    hook.write_text('#!/bin/sh\n' + marker + '\nset -eu\nrepo=$(git rev-parse --show-toplevel)\nexec python3 "$repo/onebot-onebot-custom/scripts/check-sanitized-index.py" --root "$repo"\n')
    hook.chmod(0o755)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument('--install-hook', action='store_true')
    args = parser.parse_args()
    root = Path(args.root).resolve()
    try:
        if args.install_hook:
            install_hook(root)
            print(json.dumps({'hookInstalled': True}))
            return
        result = check(root)
        print(json.dumps(result, ensure_ascii=False))
        raise SystemExit(0 if result['passed'] else 1)
    except Exception as error:
        # Parser/library failures must not echo a token-bearing input or URL.
        print(json.dumps({'passed': False, 'errorType': type(error).__name__}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
