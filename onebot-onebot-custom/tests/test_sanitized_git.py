import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import sys
from urllib.parse import quote, quote_plus
import unittest

spec = importlib.util.spec_from_file_location('sanitized_git', Path(__file__).resolve().parents[1] / 'scripts/prepare-sanitized-git.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SanitizedGitTests(unittest.TestCase):
    def test_config_credentials_become_placeholders_but_secret_refs_remain(self):
        value = {'apiKey': 'sensitive' * 3, 'nested': {'token': {'source': 'file', 'id': '/secret-reference'}}, 'enabled': True}
        result = json.loads(module.sanitize(json.dumps(value), {}, Path('openclaw.json')))
        self.assertEqual(result['apiKey'], '${OPENCLAW_APIKEY}')
        self.assertEqual(result['nested']['token'], value['nested']['token'])
        self.assertTrue(result['enabled'])

    def test_ids_and_private_addresses_are_replaced_consistently(self):
        text = 'group:123450001 /groups/123450001 http://192.0.2.10:8787'
        result = module.sanitize(text, {'123450001': '700000001'}, Path('test.md'))
        self.assertNotIn('123450001', result)
        self.assertEqual(result.count('700000001'), 2)
        self.assertIn('http://192.0.2.10:8787', result)

    def test_non_fixture_keys_are_scrubbed(self):
        key = 'sk-' + 'Z' * 24
        result = module.sanitize(key, {}, Path('test.md'))
        self.assertNotIn(key, result)
        self.assertIn('${REDACTED_API_KEY}', result)

    def test_real_private_key_is_a_hard_failure(self):
        with self.assertRaises(ValueError):
            module.sanitize('-----BEGIN ' + 'PRIVATE KEY-----', {}, Path('test.md'))

    def test_reports_keep_boolean_receipt_status_and_omit_receipt_values(self):
        result = json.loads(module.sanitize(json.dumps({'receipt': 'some-id', 'receiptVerified': True}), {}, Path('docs/result.json')))
        self.assertEqual(result['receipt'], '[omitted]')
        self.assertTrue(result['receiptVerified'])

    def test_runtime_files_and_dependencies_cannot_enter_source_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['state/message.json', 'node_modules/package.json', 'integrations/bilibili-notify/config/bn.yaml', '.env']:
                path = root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('{}')
                self.assertFalse(module.allowed(root, path))
            source = root / 'src/main.js'; source.parent.mkdir(); source.write_text('export const enabled=true;')
            self.assertTrue(module.allowed(root, source))

    def test_ws_and_wss_query_credentials_are_scrubbed(self):
        secret = 'random-service-' + 'Z' * 50
        for scheme in ['ws', 'wss', 'http', 'https']:
            url = scheme + '://localhost:3001/?' + 'access_token=' + secret + '&lang=en'
            result = module.sanitize(url, {}, Path('probe.mjs'))
            self.assertNotIn(secret, result)
            self.assertIn('${REDACTED_URL_CREDENTIAL}', result)
            self.assertIn('&lang=en', result)
            self.assertEqual(module.scan_snapshot({Path('probe.mjs'): result.encode()}, {}), [])

    def test_url_regex_source_is_preserved_without_hiding_invalid_url_tokens(self):
        pattern = 'https' + '://[^/@[:space:]]+([/?][^@[:space:]]*)?$'
        self.assertEqual(module.sanitize(pattern, {}, Path('script.sh')), pattern + '\n')
        invalid = 'ws' + '://[invalid/?' + 'access_token=' + 'Q' * 64
        result = module.sanitize(invalid, {}, Path('script.md'))
        self.assertNotIn('Q' * 64, result)

    def test_percent_encoded_query_names_cannot_hide_credentials(self):
        secret = 'private-value-' + 'Q' * 40
        url = 'wss' + '://localhost/?' + quote('access_token').replace('_', '%5F') + '=' + secret
        result = module.sanitize(url, {}, Path('probe.mjs'))
        self.assertNotIn(secret, result)

    def test_url_userinfo_is_removed_for_database_and_websocket_urls(self):
        for scheme in ['postgresql', 'mongodb', 'redis', 'socks5', 'wss']:
            url = scheme + '://' + 'user:' + 'P' * 32 + '@localhost/resource'
            result = module.sanitize(url, {}, Path('config.md'))
            self.assertNotIn('P' * 32, result)
            self.assertIn('${REDACTED_URL_USERINFO}@localhost', result)
            self.assertEqual(module.scan_snapshot({Path('config.md'): result.encode()}, {}), [])

    def test_snapshot_scanner_independently_rejects_unsanitized_urls(self):
        url = 'ws' + '://localhost/?' + 'access_token=' + 'Z' * 64
        issues = module.scan_snapshot({Path('probe.mjs'): url.encode()}, {})
        self.assertTrue(any(issue['category'] == 'url_query_credential' for issue in issues))
        self.assertNotIn('Z' * 64, json.dumps(issues))

    def test_runtime_url_interpolation_and_public_fixed_parameter_remain(self):
        urls = ['ws' + '://localhost/?' + 'access_token=${ONEBOT_ACCESS_TOKEN}',
                'https' + '://cdn.syndication.twimg.com/tweet-result?' + 'token=0']
        for url in urls:
            self.assertEqual(module.sanitize(url, {}, Path('config.md')), url + '\n')
            self.assertEqual(module.scan_snapshot({Path('config.md'): url.encode()}, {}), [])

    def test_only_explicit_synthetic_url_fixtures_are_preserved(self):
        sample = 'https' + '://user:pass@example.test/path?' + 'token=private'
        fixture = Path('tests/redaction.test.mjs')
        self.assertEqual(module.sanitize(sample, {}, fixture), sample + '\n')
        self.assertNotEqual(module.sanitize(sample, {}, Path('config.md')), sample + '\n')
        actual = 'service-value-' + 'Z' * 48
        url = 'wss' + '://localhost/?' + 'access_token=' + actual
        self.assertNotIn(actual, module.sanitize(url, {}, fixture))
        self.assertTrue(module.scan_snapshot({fixture: actual.encode()}, {}, {actual}))

    def test_known_local_credentials_fail_scan_even_without_a_prefix(self):
        secret = 'unprefixed/local+credential-' + 'q' * 37
        import base64
        for value in [secret, quote(secret, safe=''), base64.b64encode(secret.encode()).decode()]:
            issues = module.scan_snapshot({Path('source.js'): value.encode()}, {}, {secret})
            self.assertTrue(any(issue['category'] == 'known_local_credential' for issue in issues))
            self.assertNotIn(secret, json.dumps(issues))

    def test_local_secret_refs_are_not_misclassified_as_credential_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            actual = 'local-credential-' + 'A' * 38
            (root / 'secrets').mkdir()
            (root / 'secrets/service.key').write_text(actual)
            (root / 'openclaw.json').write_text(json.dumps({'apiKey': {'source': 'file', 'provider': 'service', 'id': 'provider-reference-value'}}))
            credentials = module.local_credentials(root)
            self.assertIn(actual, credentials)
            self.assertNotIn('provider-reference-value', credentials)

    def test_debug_probe_is_excluded_even_when_it_has_a_source_suffix(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'extensions/openclaw-onebot/dist/src/ws-probe.mjs'
            path.parent.mkdir(parents=True)
            path.write_text('export const debug = true;')
            self.assertFalse(module.allowed(root, path))

    def test_staging_removes_previously_tracked_debug_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'repo'
            root.mkdir()
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            def write(path, value):
                target = root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(value)
            write('.gitignore', '')
            write('onebot-features.json', json.dumps({'identities': {'adminIds': []}, 'groups': {}, 'accounts': {}}))
            write('onebot-role-routing.json', json.dumps({'roles': {}}))
            write('onebot-services.json', json.dumps({'jobs': {}}))
            probe = 'extensions/openclaw-onebot/dist/src/ws-probe.mjs'
            write(probe, 'export const debug = true;')
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], check=True)
            result = subprocess.run([sys.executable, str(Path(module.__file__)), '--root', str(root), '--output', str(Path(directory) / 'snapshot'), '--stage'], check=True, capture_output=True, text=True)
            report = json.loads(result.stdout)
            self.assertEqual(report['excludedTrackedFilesRemoved'], 4)
            tracked = subprocess.check_output(['git', '-C', str(root), 'ls-files'], text=True).splitlines()
            self.assertNotIn(probe, tracked)
            self.assertTrue((root / probe).is_file())

    def test_live_root_configs_are_excluded_but_source_and_examples_remain(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['openclaw.json', 'onebot-x.json', 'onebot-future-service.json']:
                (root / name).write_text('{}')
                self.assertFalse(module.allowed(root, root / name))
            example = root / module.EXAMPLE_DIRECTORY / 'openclaw.json'
            example.parent.mkdir(parents=True)
            example.write_text('{}')
            self.assertTrue(module.allowed(root, example))

    def test_examples_are_static_and_do_not_reproduce_runtime_topology(self):
        examples = module.example_configs()
        self.assertEqual(len(examples), 13)
        for path, data in examples.items():
            self.assertEqual(path.parent, module.EXAMPLE_DIRECTORY)
            json.loads(data)
            self.assertNotIn('/root/', data.decode())
            self.assertNotIn('/mnt/', data.decode())
        config = json.loads(examples[module.EXAMPLE_DIRECTORY / 'openclaw.json'])
        self.assertEqual(config['models']['providers']['example']['apiKey']['source'], 'env')
        self.assertEqual(json.loads(examples[module.EXAMPLE_DIRECTORY / 'onebot-services.json'])['jobs'], {})
        self.assertEqual(json.loads(examples[module.EXAMPLE_DIRECTORY / 'onebot-bilibili.json'])['routes'], [])

    def test_historical_mapping_discovers_old_identity_and_provider(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            (root / 'onebot-features.json').write_text(json.dumps({'identities': {'adminIds': []}, 'groups': {}, 'accounts': {}}))
            (root / 'onebot-role-routing.json').write_text(json.dumps({'roles': {}, 'groups': {'123456701': {}}, 'adminIds': ['123456702']}))
            (root / 'onebot-services.json').write_text(json.dumps({'jobs': {}}))
            (root / 'openclaw.json').write_text(json.dumps({'models': {'providers': {'old': {'baseUrl': 'https://old-provider.test.invalid/v1'}, 'private': {'baseUrl': 'https://private-provider.test/v1'}}}}))
            subprocess.run(['git', '-C', str(root), 'add', '.'], check=True)
            subprocess.run(['git', '-C', str(root), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], check=True)
            (root / 'onebot-role-routing.json').write_text(json.dumps({'roles': {}}))
            (root / 'openclaw.json').write_text('{}')
            mapping = module.privacy_mapping(root, ['HEAD'])
            self.assertIn('123456701', mapping)
            self.assertIn('123456702', mapping)
            self.assertEqual(mapping['private-provider.test'], 'provider.example.invalid')
            self.assertNotIn('old-provider.test.invalid', mapping)

    def test_installed_hook_blocks_forced_runtime_config_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / 'onebot-onebot-custom/scripts'
            scripts.mkdir(parents=True)
            import shutil
            source = Path(module.__file__).parent
            for name in ['prepare-sanitized-git.py', 'check-sanitized-index.py']:
                shutil.copyfile(source / name, scripts / name)
            subprocess.run(['git', 'init', '-q', str(root)], check=True)
            configs = {'onebot-features.json': {'identities': {'adminIds': []}, 'groups': {}, 'accounts': {}},
                       'onebot-role-routing.json': {'roles': {}}, 'onebot-services.json': {'jobs': {}},
                       'openclaw.json': {'gateway': {'port': 12345}}}
            for name, value in configs.items():
                (root / name).write_text(json.dumps(value))
            subprocess.run([sys.executable, str(scripts / 'check-sanitized-index.py'), '--root', str(root), '--install-hook'], capture_output=True, check=True)
            subprocess.run(['git', '-C', str(root), 'add', 'openclaw.json'], check=True)
            result = subprocess.run(['git', '-C', str(root), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'must fail'], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('private_runtime_file', result.stdout + result.stderr)
            subprocess.run(['git', '-C', str(root), 'rm', '--cached', 'openclaw.json'], capture_output=True, check=True)
            (root / 'README.md').write_text('Example source archive.\n')
            subprocess.run(['git', '-C', str(root), 'add', 'README.md'], check=True)
            result = subprocess.run(['git', '-C', str(root), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'safe fixture'], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertTrue((root / 'openclaw.json').is_file())

    def test_text_has_single_terminal_newline(self):
        self.assertEqual(module.sanitize('example\n\n', {}, Path('test.md')), 'example\n')


if __name__ == '__main__':
    unittest.main()
