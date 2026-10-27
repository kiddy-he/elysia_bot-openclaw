#!/usr/bin/env python3
"""Validate local identity references and stream Responses image parts to a file.

Paths are accepted only below the local character library. Base64 stays out of
argv and logs. Remote references retain the existing HTTPS workflow.
"""
import base64
import json
from pathlib import Path
import sys

ROOT = Path('/root/letu_chara_image').resolve()


def local_reference(value):
    original = Path(value)
    resolved = original.resolve(strict=True)
    resolved.relative_to(ROOT)
    if not original.is_absolute() or not resolved.is_file():
        raise ValueError('Local reference outside character library')
    if not 12 <= resolved.stat().st_size <= 32 * 1024 * 1024:
        raise ValueError('Invalid local reference size')
    head = resolved.read_bytes()[:12]
    if head.startswith(b'\x89PNG\r\n\x1a\n'):
        mime = 'image/png'
    elif head.startswith(b'\xff\xd8\xff'):
        mime = 'image/jpeg'
    elif head.startswith(b'RIFF') and head[8:12] == b'WEBP':
        mime = 'image/webp'
    else:
        raise ValueError('Unsupported local reference format')
    return resolved, mime


def main():
    mode, *values = sys.argv[1:]
    if mode == 'validate':
        for value in values:
            local_reference(value)
        return
    if mode != 'parts':
        raise ValueError('Unknown local reference operation')
    parts = []
    for value in values:
        if value.startswith('/'):
            file, mime = local_reference(value)
            value = 'data:' + mime + ';base64,' + base64.b64encode(file.read_bytes()).decode('ascii')
        parts.append({'type': 'input_image', 'image_url': value, 'detail': 'high'})
    json.dump(parts, sys.stdout)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('local_reference_error=invalid-or-unavailable', file=sys.stderr)
        sys.exit(2)
