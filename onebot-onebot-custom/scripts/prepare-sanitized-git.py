#!/usr/bin/env python3
"""Build a reviewed, allowlisted Git snapshot without modifying live bot files.

Output contains placeholder identities/configuration, never credentials or state.
Run --stage only after reviewing the dry-run report. No commit/push is performed.
"""
import argparse
import ast
import collections
import json
import os
from pathlib import Path
import re
import subprocess
import uuid
from urllib.parse import unquote, urlsplit

CONFIGS = ['openclaw.json', 'onebot-app-config.json', 'onebot-model-routing.json',
           'onebot-role-routing.json', 'onebot-features.json', 'onebot-services.json',
           'onebot-workspaces.json', 'onebot-bilibili.json', 'onebot-delivery.json',
           'onebot-executors.json', 'onebot-reach.json', 'onebot-x.json', 'onebot-xhs.json']
SKILLS = ['qzone-ops', 'agy-proxy', 'elysia-tts', 'xiaohongshu-ops']
BLOCKED = {'node_modules', '.git', '.venv', '__pycache__', 'state', 'data', 'logs',
           'downloads', 'outputs', 'browser-profile', 'memory', 'secrets', 'agents'}
SOURCE_SUFFIXES = {'.js', '.mjs', '.ts', '.json', '.md', '.py', '.sh', '.txt', '.yaml',
                   '.yml', '.html', '.css', '.service', '.lock', '.toml'}
KEY_PATTERN = re.compile(r'(?:sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{25,}|AQ\.[A-Za-z0-9_-]{25,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,})')
SYNTHETIC_KEYS = {'sk-abcdefghijklmnopqrstuvwxyz', 'sk-abcdefghijklmnopqrstuv'}
SENSITIVE_FIELD = re.compile(r'(?i)^(?:api[_-]?key|access[_-]?token|auth_token|ct0|password|passwd|secret|cookie|cookies|authorization|token)$')
PRIVATE_KEY = re.compile(r'-----BEGIN (?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY-----')
PRIVATE_IP = re.compile(r'(?<![\d.])(?:192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?![\d.])')


# URL credentials need their own check: local service tokens often have no
# recognizable API-key prefix, including in WS/WSS and database URLs.
URL_PATTERN = re.compile(r"(?:wss?|https?|socks5?|redis|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|amqps?)://[^\s<>\"'`\\]+", re.I)
URL_QUERY = re.compile(r'([?&])([A-Za-z0-9_%.-]+)=([^&#]*)')
URL_SECRET_FIELD = re.compile(r'(?i)(?:^|[_-])(?:key|token|secret|password|passwd|authorization|auth|credential|signature|sig|session|code|csrf)(?:$|[_-])|^(?:apikey|accesskey|accesstoken|refreshtoken|xsectoken)$')
LOCAL_SECRET_FIELD = re.compile(r'(?i)^(?:key|access|refresh|api[_-]?key|access[_-]?token|refresh[_-]?token|auth_token|ct0|password|passwd|admin_password|web_password|secret|cookie|cookies|authorization|token|BN_COOKIE_KEY)$')
DEBUG_FILES = {'ws-probe.mjs'}


def url_credentials(url, path=None):
    """Return credential locations, never credential values, for one URL."""
    try:
        parsed = urlsplit(url)
    except ValueError:
        parsed = None
    issues = []
    test_fixture = path is not None and ('tests' in path.parts or '.test.' in path.name)
    authority = url.split('://', 1)[1].split('/', 1)[0].split('?', 1)[0]
    if '@' in authority:
        userinfo = authority.rsplit('@', 1)[0]
        synthetic_userinfo = test_fixture and userinfo in {'user:pass', 'name:password', 'a:b', 'github.com', 'x.com', 'pbs.twimg.com'}
        if not userinfo.startswith('${REDACTED_') and not synthetic_userinfo:
            issues.append(('url_userinfo', None))
    for match in URL_QUERY.finditer(url):
        name, value = unquote(match[2]), unquote(match[3])
        if not URL_SECRET_FIELD.search(name) or not value:
            continue
        # Runtime interpolation and explicit documentation placeholders contain
        # no literal credentials. Keep only this public API's fixed token.
        if re.fullmatch(r'\$\{[^{}]+\}|<[^<>]+>|\[(?:omitted|redacted)\]', value, re.I):
            continue
        if parsed is not None and parsed.hostname == 'cdn.syndication.twimg.com' and name == 'token' and value in {'0', '1'}:
            continue
        if value.lower() in {'synthetic', 'test', 'example', 'mock', 'fake', 'secret', 'hidden', 'redacted', 'xxx', 'x'}:
            continue
        if test_fixture and value in {'private', 'keep'}:
            continue
        issues.append(('url_query_credential', match.span()))
    return issues


def sanitize_urls(text, path=None):
    def replace(match):
        url = match[0]
        for category, span in reversed(url_credentials(url, path)):
            if category == 'url_query_credential':
                start, end = span
                field = URL_QUERY.fullmatch(url[start:end])
                url = url[:start] + field[1] + field[2] + '=${REDACTED_URL_CREDENTIAL}' + url[end:]
        # Apply after query replacements so their source offsets remain valid.
        if any(category == 'url_userinfo' for category, _ in url_credentials(url, path)):
            url = re.sub(r'(?<=://)[^/@]+@', '${REDACTED_URL_USERINFO}@', url, count=1)
        return url
    return URL_PATTERN.sub(replace, text)


def local_credentials(root):
    """Read known local values into memory; never print or persist the values."""
    result = set()

    def add(value):
        if not isinstance(value, str):
            return
        value = value.strip()
        if len(value) >= 12 and '\n' not in value and not value.startswith(('${', '/', 'http://', 'https://')):
            result.add(value)

    def walk(value):
        if isinstance(value, dict):
            if value.get('source') in {'file', 'env', 'exec'}:
                return
            for key, item in value.items():
                if LOCAL_SECRET_FIELD.fullmatch(key):
                    add(item)
                if isinstance(item, (dict, list)):
                    walk(item)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    directory = root / 'secrets'
    for path in sorted(directory.glob('*')):
        if not path.is_file() or path.is_symlink():
            continue
        text = path.read_text().strip()
        try:
            value = json.loads(text)
        except ValueError:
            add(text)
        else:
            add(value)
            walk(value)
    for path in [root / 'openclaw.json', root.parent / '.antigravity_tools/gui_config.json',
                 root.parent / '.local/share/opencode/auth.json']:
        if path.is_file():
            walk(json.loads(path.read_text()))
    for path in [root.parent / '.antigravity-manager.env',
                 root / 'onebot-onebot-custom/integrations/bilibili-notify/.env']:
        if path.is_file():
            for line in path.read_text().splitlines():
                match = re.match(r'\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)', line)
                if match and re.search(r'(?i)(?:key|token|secret|password|cookie)$', match[1]):
                    add(match[2].strip().strip(chr(34) + chr(39)))
    for key, value in os.environ.items():
        if re.search(r'(?i)(?:key|token|secret|password|cookie)$', key):
            add(value)
    # Gateway env can carry the OneBot token even when the archive process has
    # no such variable. Only inspect the relevant local service process env.
    for directory in Path('/proc').glob('[0-9]*'):
        try:
            command = (directory / 'cmdline').read_bytes()
            if not any(marker in command for marker in (b'openclaw', b'onebot', b'LLBot')):
                continue
            for entry in (directory / 'environ').read_bytes().split(b'\0'):
                key, separator, value = entry.partition(b'=')
                if separator and re.search(rb'(?i)(?:key|token|secret|password|cookie)$', key):
                    add(value.decode())
        except (OSError, UnicodeError):
            continue
    return result


def git(root, *args, **kwargs):
    return subprocess.check_output(['git', '-C', str(root), *args], **kwargs)


def allowed(root, path):
    rel = path.relative_to(root)
    if len(rel.parts) == 1 and (path.name in CONFIGS or path.name.startswith('onebot-') and path.suffix == '.json'):
        return False
    if not path.is_file() or path.is_symlink() or any(p in BLOCKED for p in rel.parts):
        return False
    if path.name in DEBUG_FILES or path.name == '.env' or '.bak' in path.name or path.name.endswith(('.tmp', '.log', '.debug.patch')):
        return False
    if 'integrations' in rel.parts and any(p in {'config', 'runtime'} for p in rel.parts):
        return False
    return path.suffix in SOURCE_SUFFIXES or path.name in {'.gitignore', '.env.example', 'LICENSE', 'NOTICE', 'xhs-command'}


def candidates(root):
    files = set()
    project = root / 'onebot-onebot-custom'
    for name in ['src', 'scripts', 'tests', 'docs', 'config', 'integrations']:
        files.update(p.relative_to(root) for p in (project / name).rglob('*') if allowed(root, p))
    for name in ['README.md', 'FEATURES.md', 'package.json', 'package-lock.json']:
        if (project / name).exists():
            files.add((project / name).relative_to(root))
    # Preserve the deployed plugin sources/manifest already versioned in this repo.
    plugin = root / 'extensions/openclaw-onebot'
    for p in (plugin / 'dist').rglob('*'):
        if allowed(root, p):
            files.add(p.relative_to(root))
    for name in ['package.json', 'package-lock.json', 'openclaw.plugin.json', 'README.md', 'LICENSE']:
        if (plugin / name).exists():
            files.add((plugin / name).relative_to(root))
    for skill in SKILLS:
        for p in (root / 'workspace/skills' / skill).rglob('*'):
            if allowed(root, p):
                files.add(p.relative_to(root))
    for p in (root / 'skills').rglob('SKILL.md'):
        files.add(p.relative_to(root))
    # Sanitize all existing tracked source/configuration, including unchanged
    # legacy counterparts, so new HEAD has no real identities in those files.
    for entry in git(root, 'ls-files', '-z').decode().split('\0'):
        if entry and allowed(root, root / entry):
            files.add(Path(entry))
    files.add(Path('.gitignore'))
    return sorted(files)


def identity_map(root):
    features = json.loads((root / 'onebot-features.json').read_text())
    roles = json.loads((root / 'onebot-role-routing.json').read_text())
    ids = set(features['identities']['adminIds']) | set(features['groups'])
    for account in features['accounts'].values():
        ids.update(account['privateAdminIds']); ids.update(account['groupIds'])
    for role in roles['roles'].values():
        ids.update(role['selfIds'])
    mapping = {value: str(700000001 + i) for i, value in enumerate(sorted(ids))}
    registry = json.loads((root / 'onebot-services.json').read_text())
    for value in registry['jobs']:
        mapping[value] = str(uuid.uuid5(uuid.NAMESPACE_URL, 'openclaw-sanitized-job:' + value))
    return mapping



# These are documentation examples, deliberately independent of live topology.
# Keep real root configurations untracked and never copy them into examples.
EXAMPLE_DIRECTORY = Path('onebot-onebot-custom/config/examples')


def example_configs():
    admin, group, bot = '700000001', '700000002', '700000003'
    examples = {name: {'version': 1} for name in CONFIGS}
    examples['openclaw.json'] = {
        'models': {'providers': {'example': {
            'baseUrl': 'https://provider.example.invalid/v1',
            'apiKey': {'source': 'env', 'provider': 'default', 'id': 'EXAMPLE_MODEL_API_KEY'},
            'models': [{'id': 'example-model', 'name': 'Example model'}]}}},
        'gateway': {'auth': {'mode': 'token', 'token': {
            'source': 'env', 'provider': 'default', 'id': 'EXAMPLE_GATEWAY_TOKEN'}}},
        'channels': {'onebot': {'accounts': {'example': {
            'wsUrl': '${EXAMPLE_ONEBOT_WS_URL}', 'accessToken': '${EXAMPLE_ONEBOT_ACCESS_TOKEN}'}}}}}
    examples['onebot-role-routing.json'] = {
        'groups': {group: {'roles': ['elysia'], 'requireMention': True}},
        'adminIds': [admin], 'roles': {'elysia': {'accountId': 'example',
            'agentId': 'example-agent', 'selfIds': [bot], 'displayName': 'Example bot'}}}
    examples['onebot-features.json'] = {
        'version': 1, 'identities': {'adminIds': [admin]},
        'groups': {group: {'profile': 'example'}},
        'accounts': {'example': {'privateAdminIds': [admin], 'groupIds': [group]}},
        'profiles': {}, 'features': {}, 'automationBindings': {}}
    examples['onebot-services.json'] = {'version': 1, 'jobs': {}}
    examples['onebot-workspaces.json'] = {'version': 1, 'routes': {}, 'agents': {}, 'sessionMigrations': {}}
    examples['onebot-bilibili.json'] = {'version': 1, 'enabled': False,
        'secretFile': '${EXAMPLE_BILIBILI_SECRET_FILE}', 'upstream': '${EXAMPLE_BILIBILI_URL}', 'routes': []}
    examples['onebot-x.json'] = {'version': 1, 'enabled': False, 'publicLinks': True,
        'python': '${EXAMPLE_PYTHON}', 'bridge': '${EXAMPLE_X_BRIDGE}',
        'accountsDb': '${EXAMPLE_X_ACCOUNTS_DB}', 'proxy': '${EXAMPLE_PROXY_URL}'}
    examples['onebot-xhs.json'] = {'version': 1, 'enabled': False, 'accountId': 'example',
        'dataDir': '${EXAMPLE_XHS_DATA_DIR}', 'manualVerification': {'enabled': False,
            'publicOrigin': 'https://login.example.invalid', 'port': '${EXAMPLE_LOGIN_PORT}'}}
    examples['onebot-reach.json'] = {'version': 1, 'enabled': False,
        'user': '${EXAMPLE_SERVICE_USER}', 'home': '${EXAMPLE_REACH_HOME}',
        'executable': '${EXAMPLE_REACH_COMMAND}', 'platforms': {}}
    examples['onebot-executors.json'] = {'version': 1, 'tools': {}}
    examples['onebot-model-routing.json'] = {'activePreset': 'example', 'presets': {'example': {}}, 'flashLiteFallbacks': []}
    return {EXAMPLE_DIRECTORY / name: (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()
            for name, value in examples.items()}


def privacy_mapping(root, revisions=()):
    """Discover identifiers/provider hosts locally without recording originals."""
    mapping = identity_map(root)
    identities = {value for value in mapping if value.isdigit()}
    documents = []
    for name in CONFIGS:
        path = root / name
        if path.is_file():
            documents.append(json.loads(path.read_text()))
    for rev in revisions:
        for name in ('openclaw.json', 'onebot-role-routing.json', 'onebot-features.json'):
            result = subprocess.run(['git', '-C', str(root), 'show', rev + ':' + name], capture_output=True)
            if result.returncode == 0:
                documents.append(json.loads(result.stdout))
    official = {'api.openai.com', 'generativelanguage.googleapis.com', 'api.anthropic.com',
                'api.deepseek.com', 'api.x.ai', 'openrouter.ai', 'dashscope.aliyuncs.com'}
    hosts = set()
    def walk(value, field=''):
        if isinstance(value, dict):
            for key, item in value.items():
                if key.isdigit() and len(key) in range(5, 13) and not key.startswith('7000000'):
                    identities.add(key)
                walk(item, key)
        elif isinstance(value, list):
            for item in value:
                walk(item, field)
        elif isinstance(value, str):
            if re.search(r'(?i)(?:ids?|uin|qq|group|peer|target|recipient|sender)$', field) and value.isdigit() and len(value) in range(5, 13) and not value.startswith('7000000'):
                identities.add(value)
    for document in documents:
        walk(document)
        for provider in document.get('models', {}).get('providers', {}).values():
            for key in ('baseUrl', 'baseURL', 'url'):
                url = provider.get(key, '')
                if isinstance(url, str):
                    host = urlsplit(url).hostname
                    if host and host not in official | {'127.0.0.1', 'localhost', '::1'} and not host.endswith('.invalid'):
                        hosts.add(host)
    for index, value in enumerate(sorted(identities)):
        mapping[value] = str(700000001 + index)
    mapping.update({host: 'provider.example.invalid' for host in hosts})
    return mapping


def config_secrets(value):
    if isinstance(value, dict):
        return {key: ('${OPENCLAW_' + re.sub(r'[^A-Za-z0-9]', '_', key).upper() + '}'
                      if SENSITIVE_FIELD.fullmatch(key) and isinstance(item, str) and item and not item.startswith('${')
                      else config_secrets(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [config_secrets(item) for item in value]
    return value


def sanitize(text, mapping, path):
    if PRIVATE_KEY.search(text):
        raise ValueError('private key material in ' + str(path))
    for value in KEY_PATTERN.findall(text):
        if value not in SYNTHETIC_KEYS:
            text = text.replace(value, '${REDACTED_API_KEY}')
    text = sanitize_urls(text, path)
    for original, substitute in mapping.items():
        # IDs also appear inside workspace paths, route keys and agent names.
        text = text.replace(original, substitute)
    text = PRIVATE_IP.sub('192.0.2.10', text)
    text = text.replace('ExampleAdmin', 'ExampleAdmin')
    text = text.replace('login.example.invalid', 'login.example.invalid')
    text = re.sub(r'[A-Za-z0-9_.+-]+@(?:gmail|qq|outlook|hotmail|163|126)\.com', 'user@example.invalid', text)
    text = re.sub(r'(?:[a-zA-Z0-9_-]+\.)?(?:novacode\.top|wyzlab\.ai)', 'provider.example.invalid', text)
    # Historical acceptance docs contain real delivery receipts: keep timings and
    # booleans, omit recipient/session information and all receipt values.
    if path.suffix == '.json':
        data = json.loads(text)
        data = config_secrets(data)
        if path.name == 'onebot-workspaces.json':
            data['historicalSessions'] = '[local archive omitted]'
            data['sessionMigrations'] = {}
        if 'docs' in path.parts:
            def public_report(item):
                if isinstance(item, dict):
                    return {k: ('[omitted]' if re.search(r'(?i)(?:message.?id|receipt|session.?id|username|phone|cookie|token|recipient)', k)
                                and not isinstance(v, bool) else public_report(v)) for k, v in item.items()}
                if isinstance(item, list):
                    return [public_report(v) for v in item]
                return item
            data = public_report(data)
        text = json.dumps(data, ensure_ascii=False, indent=2) + '\n'
    return text.rstrip('\n') + '\n'


def scan_snapshot(files, mapping, known_secrets=()):
    issues = []
    for path, content in files.items():
        text = content.decode('utf-8')
        if PRIVATE_KEY.search(text) or PRIVATE_IP.search(text):
            issues.append({'file': str(path), 'category': 'private_material'})
        if any(key in text for key in mapping):
            issues.append({'file': str(path), 'category': 'original_identity'})
        if any(key not in SYNTHETIC_KEYS for key in KEY_PATTERN.findall(text)):
            issues.append({'file': str(path), 'category': 'credential'})
        for match in URL_PATTERN.finditer(text):
            for category, _ in url_credentials(match[0], path):
                issues.append({'file': str(path), 'line': text.count('\n', 0, match.start()) + 1, 'category': category})
        import base64
        from urllib.parse import quote
        for secret in known_secrets:
            variants = {secret, quote(secret, safe=''), base64.b64encode(secret.encode()).decode(), json.dumps(secret)[1:-1]}
            if any(value in text for value in variants):
                issues.append({'file': str(path), 'category': 'known_local_credential'})
                break
    return issues


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[2]))
    parser.add_argument('--output', required=True, help='Fresh directory outside the Git repository')
    parser.add_argument('--stage', action='store_true', help='Stage reviewed sanitized blobs; leave live files intact')
    args = parser.parse_args()
    root, output = Path(args.root).resolve(), Path(args.output).resolve()
    if output == root or root in output.parents or output.exists():
        raise SystemExit('Output must be a new directory outside the Git repository')
    if args.stage and git(root, 'diff', '--cached', '--name-only').strip():
        raise SystemExit('Existing staged changes must be preserved; refusing to replace them')
    mapping, files = privacy_mapping(root), {}
    for path in candidates(root):
        files[path] = sanitize((root / path).read_text(), mapping, path).encode()
    known_secrets = local_credentials(root)
    files.update(example_configs())
    issues = scan_snapshot(files, mapping, known_secrets)
    if issues:
        print(json.dumps({'passed': False, 'issues': issues})); raise SystemExit(1)
    output.mkdir(mode=0o700)
    counts = collections.Counter()
    for path, content in files.items():
        target = output / path; target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content); target.chmod(0o755 if (root / path).is_file() and os.access(root / path, os.X_OK) else 0o644)
        if path.suffix == '.py':
            ast.parse(content.decode(), filename=str(path)); counts['pythonSyntaxChecks'] += 1
        elif path.suffix in {'.js', '.mjs'}:
            checked = subprocess.run(['node', '--check', str(target)], capture_output=True, text=True)
            if checked.returncode:
                print(json.dumps({'passed': False, 'syntaxFile': str(path)})); raise SystemExit(1)
            counts['javascriptSyntaxChecks'] += 1
    report = {'passed': True, 'files': len(files), 'bytes': sum(map(len, files.values())),
              'identityMappings': len(mapping), 'realSecrets': 0, 'originalIdentityMatches': 0,
              'privateIPs': 0, 'excluded': ['credentials', 'cookies', 'state', 'chat history', 'media', 'dependencies', 'browser profiles'],
              'validation': dict(counts), 'workingRuntimeFilesModified': False, 'staged': args.stage,
              'knownLocalSecretsCompared': len(known_secrets), 'knownLocalSecretMatches': 0,
              'urlCredentialChecks': ['http', 'https', 'ws', 'wss', 'socks', 'database'],
              'debugProbeExcluded': True, 'liveRootConfigurationsExcluded': True,
              'configurationExamples': len(example_configs())}
    if args.stage:
        # An ignored file can still be tracked. Remove excluded files from the
        # index explicitly; candidate filtering alone does not remove them.
        tracked = set(Path(entry) for entry in git(root, 'ls-files', '-z').decode().split('\0') if entry)
        excluded = sorted(tracked - set(files))
        if excluded:
            subprocess.run(['git', '-C', str(root), 'update-index', '--force-remove', '--', *map(str, excluded)], check=True)
        report['excludedTrackedFilesRemoved'] = len(excluded)
        records = []
        for path, content in files.items():
            blob = git(root, 'hash-object', '-w', '--stdin', input=content).decode().strip()
            mode = '100755' if os.access(root / path, os.X_OK) else '100644'
            records.append(f'{mode} {blob}\t{path}\0'.encode())
        subprocess.run(['git', '-C', str(root), 'update-index', '-z', '--index-info'], input=b''.join(records), check=True)
    (output / 'SANITIZATION-REPORT.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
