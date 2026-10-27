#!/usr/bin/python3
"""Write bounded, sanitized image request metadata; never copy response images."""
import datetime
import json
import os
from pathlib import Path
import re
import sys
import uuid
from urllib.parse import urlsplit, urlunsplit


def redact(value, limit=1500):
    text = str(value)
    text = re.sub(r'data:image/[^;\s]+;base64,[A-Za-z0-9+/=]+', '[IMAGE DATA REDACTED]', text, flags=re.I)
    text = re.sub(r'\bsk-[a-z0-9_-]+', '[KEY REDACTED]', text, flags=re.I)
    text = re.sub(r'\bBearer\s+[^\s"\x27,;]+', 'Bearer [REDACTED]', text, flags=re.I)
    text = re.sub(r'((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*["\x27]?\s*[:=]\s*["\x27]?)[^\s"\x27,;}]+', r'\1[REDACTED]', text, flags=re.I)
    def clean_url(match):
        try:
            url = urlsplit(match[0])
            return urlunsplit((url.scheme, url.netloc.rsplit('@', 1)[-1], url.path, '', ''))
        except ValueError:
            return '[URL REDACTED]'
    text = re.sub(r'https?://[^\s"\x27<>]+', clean_url, text, flags=re.I)
    text = re.sub(r'[A-Za-z0-9+/=_-]{256,}', '[LONG DATA REDACTED]', text)
    return re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', text)[:limit]


def bounded_text(path):
    with open(path, 'rb') as stream:
        return stream.read(65536).decode('utf-8', 'replace')


def summarize_body(path, format):
    text = bounded_text(path)
    values = []
    if format == 'sse':
        for line in text.splitlines():
            if line.startswith('data: '):
                try:
                    values.append(json.loads(line[6:]))
                except ValueError:
                    pass
    try:
        values.append(json.loads(text))
    except ValueError:
        pass
    errors = []
    for value in values:
        if not isinstance(value, dict):
            continue
        response = value.get('response')
        error = value.get('error') or (response.get('error') if isinstance(response, dict) else None)
        if isinstance(error, dict):
            errors.append({key: redact(error[key]) for key in ('code', 'type', 'message')
                           if isinstance(error.get(key), (str, int))})
        elif isinstance(error, str):
            errors.append({'message': redact(error)})
    if errors:
        return {'errors': errors[:3]}
    # Unknown/HTML bodies can contain prompts, cookies or images. Record their
    # shape and size instead of logging arbitrary text.
    return {'bodyKind': 'sse' if format == 'sse' else 'json' if values else 'empty' if not text else 'non-json'}


def main():
    label, format, body, headers, stderr, http, curl_exit, attempt, elapsed, outcome = sys.argv[1:]
    record = {'time': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'label': label, 'attempt': int(attempt), 'http': http,
              'curlExit': int(curl_exit), 'elapsedSeconds': int(elapsed), 'outcome': outcome,
              'responseBytes': Path(body).stat().st_size}
    record['endpoint'] = redact(os.environ.get('AGY_IMAGE_DIAGNOSTIC_ENDPOINT', ''), 512)
    record['model'] = redact(os.environ.get('AGY_IMAGE_DIAGNOSTIC_MODEL', ''), 128)
    trace_id = os.environ.get('AGY_IMAGE_TRACE_ID', '')
    if re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', trace_id):
        record['traceId'] = trace_id
    header_values = {}
    for line in bounded_text(headers).splitlines():
        key, sep, value = line.partition(':')
        if sep and key.lower() in ('content-type', 'x-request-id', 'request-id', 'x-amzn-requestid', 'cf-ray', 'retry-after'):
            header_values[key.lower()] = redact(value.strip(), 256)
    record['headers'] = header_values
    record['transportError'] = redact(bounded_text(stderr))
    if outcome != 'success':
        record.update(summarize_body(body, format))
        record['failureResponse'] = body if label == 'reference_plan' else body + '.attempt-' + attempt
        record['failureStderr'] = stderr
        record['failureHeaders'] = headers
    root = Path(os.environ.get('IMAGE_DIAGNOSTICS_DIR', '/root/.openclaw/state/image-diagnostics'))
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    path = root / ('attempt-' + str(uuid.uuid4()) + '.json')
    record['diagnosticsPath'] = str(path)
    encoded = json.dumps(record, ensure_ascii=False)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(encoded + '\n')
    print(label + '_attempt_diagnostics=' + encoded, file=sys.stderr)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never expose a body/secret in a traceback or change request semantics.
        print('image_diagnostics_error=write-failed', file=sys.stderr)
