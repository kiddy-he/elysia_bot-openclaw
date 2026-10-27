"""Offline regression checks: no quota consumption or QQ delivery."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
POLICY = SCRIPTS / 'image-request-policy.sh'
SCRIPT = SCRIPTS / 'agy-proxy-diagnose.sh'
PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5hkAAAAASUVORK5CYII='

STUB = '''#!/usr/bin/python3
import json,os,sys
from pathlib import Path
args=sys.argv[1:]
state=Path(os.environ['TEST_ROOT'])
count=state/'count'
attempt=int(count.read_text())+1 if count.exists() else 1
count.write_text(str(attempt))
timeout=args[args.index('--max-time')+1]
assert int(timeout)>0
with (state/'calls').open('a') as f:f.write(json.dumps({'args':args,'timeout':int(timeout)})+'\\n')
out=Path(args[args.index('--output')+1])
scenario=json.loads(os.environ['TEST_SCENARIO'])
step=scenario[min(attempt-1,len(scenario)-1)]
if '--data-binary' in args:
 body=args[args.index('--data-binary')+1]
 if body.startswith('@'):
  body=Path(body[1:]).read_text()
 with (state/'bodies').open('a') as f:f.write(body+'\\n')
out.write_text(step.get('body','{}'))
if '--dump-header' in args:
 Path(args[args.index('--dump-header')+1]).write_text(step.get('headers',''))
print(step.get('stderr',''),file=sys.stderr,end='')
print(step.get('http','200'),end='')
sys.exit(step.get('exit',0))
'''


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='agy-retry-policy-test-')
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        (self.bin / 'curl').write_text(STUB)
        (self.bin / 'curl').chmod(0o700)
        (self.bin / 'sleep').write_text('#!/bin/sh\nexit 0\n')
        (self.bin / 'sleep').chmod(0o700)
        self.env = dict(os.environ, PATH=str(self.bin) + ':' + os.environ['PATH'], TEST_ROOT=str(self.root), IMAGE_DIAGNOSTICS_DIR=str(self.root / 'diagnostics'), PENDING_REFERENCE_DIR=str(self.root / 'pending'))
        self.output = self.root / 'response'

    def tearDown(self):
        # The public script intentionally preserves failed responses for local
        # diagnostics. Remove only the exact artifacts created by these tests.
        for path in getattr(self, 'artifacts', []):
            Path(path).unlink(missing_ok=True)
        self.temp.cleanup()

    def run_policy(self, scenario, format='json', extra='', options=None, url='https://example.invalid/images'):
        env = dict(self.env, TEST_SCENARIO=json.dumps(scenario), **(options or {}))
        command = 'source "$1"\nimage_policy_init || exit $?\n' + extra + '\nimage_http_request test "$2" "$3" --data-binary "@$4" "$5"'
        request = self.root / 'request'
        request.write_text('{"prompt":"synthetic request"}')
        result = subprocess.run(['/bin/bash', '-c', command, 'test', str(POLICY), format, str(self.output), str(request), url], env=env, capture_output=True, text=True, timeout=5)
        for line in result.stderr.splitlines():
            if any(token in line for token in ['failure_response=', 'failure_stderr=', 'failure_headers=']):
                self.artifacts = getattr(self, 'artifacts', []) + [line.split('=', 1)[1]]
        count = int((self.root / 'count').read_text()) if (self.root / 'count').exists() else 0
        return result, count

    def test_wyzlab_uses_host_proxy_even_with_no_proxy_environment(self):
        result, calls = self.run_policy([{'body': '{}'}], options={'NO_PROXY': '*', 'no_proxy': '*'}, url='https://provider.example.invalid/v1/images/edits')
        self.assertEqual(result.returncode, 0)
        self.assertEqual(calls, 1)
        args = json.loads((self.root / 'calls').read_text())['args']
        self.assertEqual(args[args.index('--proxy') + 1], 'http://127.0.0.1:7890')
        self.assertEqual(args[args.index('--noproxy') + 1], '')

    def test_other_image_endpoints_keep_existing_route(self):
        result, _ = self.run_policy([{'body': '{}'}])
        self.assertEqual(result.returncode, 0)
        args = json.loads((self.root / 'calls').read_text())['args']
        self.assertNotIn('--proxy', args)
        self.assertEqual(args[args.index('--noproxy') + 1], '*')

    def test_success_is_not_repeated(self):
        result, calls = self.run_policy([{'body': '{"data":[{}]}'}])
        self.assertEqual(result.returncode, 0)
        self.assertEqual(calls, 1)
        self.assertEqual(result.stdout, '200')
        self.assertEqual((self.output.with_name('response.curl-exit')).read_text(), '0')
        self.assertEqual(json.loads((self.root / 'calls').read_text())['timeout'], 900)

    def test_transient_failures_retry_up_to_three_attempts(self):
        result, calls = self.run_policy([{'http': '503'}, {'http': '200', 'body': '{"data":', 'exit': 28}, {'body': '{"data":[{}]}'}])
        self.assertEqual(calls, 3)
        self.assertEqual(result.stdout, '200')
        self.assertIn('retry_in_seconds=5', result.stderr)
        self.assertIn('retry_in_seconds=10', result.stderr)
        self.assertEqual((self.output.with_name('response.attempt-2')).read_text(), '{"data":')

    def test_permanent_errors_are_not_retried(self):
        for status in ['400', '401', '403', '404', '413']:
            with self.subTest(status=status):
                (self.root / 'count').unlink(missing_ok=True)
                result, calls = self.run_policy([{'http': status}])
                self.assertEqual(calls, 1)
                self.assertEqual(result.stdout, status)

    def test_permanent_error_keeps_private_response_and_sanitized_persistent_metadata(self):
        error = {'error': {'code': 'invalid_api_key', 'type': 'authentication_error',
                           'message': 'invalid api_key=sk-synthetic-secret https://name:password@example.test/path?token=secret'}}
        result, calls = self.run_policy([{'http': '401', 'body': json.dumps(error),
                                         'headers': 'HTTP/2 401\nx-request-id: upstream-test-123\nSet-Cookie: private-cookie\n'}],
                                        options={'AGY_IMAGE_TRACE_ID': 'parent-trace-test'})
        self.assertEqual(calls, 1)
        response = self.output.with_name('response.attempt-1')
        self.assertEqual(json.loads(response.read_text()), error)
        self.assertEqual(response.stat().st_mode & 0o777, 0o600)
        records = list((self.root / 'diagnostics').glob('attempt-*.json'))
        self.assertEqual(len(records), 1)
        record = json.loads(records[0].read_text())
        self.assertEqual(record['http'], '401')
        self.assertEqual(record['errors'][0]['code'], 'invalid_api_key')
        self.assertEqual(record['traceId'], 'parent-trace-test')
        self.assertEqual(record['headers']['x-request-id'], 'upstream-test-123')
        self.assertEqual(record['outcome'], 'failed')
        self.assertEqual(records[0].stat().st_mode & 0o777, 0o600)
        self.assertEqual(records[0].parent.stat().st_mode & 0o777, 0o700)
        self.assertNotIn('sk-synthetic-secret', records[0].read_text() + result.stderr)
        self.assertNotIn('private-cookie', records[0].read_text() + result.stderr)
        self.assertNotIn('name:password', result.stderr)

    def test_invalid_json_and_transport_failure_have_diagnostics_without_body_leaks(self):
        result, calls = self.run_policy([{'http': '000', 'exit': 28, 'body': '<html>PRIVATE BODY</html>',
                                         'stderr': 'timed out api_key=sk-synthetic-secret'}])
        self.assertEqual(calls, 3)
        records = [json.loads(p.read_text()) for p in (self.root / 'diagnostics').glob('attempt-*.json')]
        self.assertEqual(len(records), 3)
        self.assertTrue(all(r['curlExit'] == 28 and r['bodyKind'] == 'non-json' for r in records))
        self.assertNotIn('PRIVATE BODY', result.stderr)
        self.assertNotIn('sk-synthetic-secret', result.stderr)

    def test_invalid_json_retries_but_exhaustion_never_succeeds(self):
        result, calls = self.run_policy([{'body': '<html>incomplete upstream</html>'}])
        self.assertEqual(calls, 3)
        self.assertIn('failure_response=', result.stderr)
        self.assertRaises(ValueError, json.loads, self.output.read_text())

    def test_sse_retry_replays_same_request_and_completed_refusal_stops(self):
        result, calls = self.run_policy([{'body': 'event: response.created\ndata: {"type":"response.created"}\n\n'}, {'body': 'data: {"type":"response.completed","response":{"output":[]}}\n\n'}], format='sse')
        self.assertEqual(calls, 2)
        self.assertEqual(len(set((self.root / 'bodies').read_text().splitlines())), 1)
        self.assertEqual(result.stdout, '200')

    def test_expired_workflow_never_starts_another_request(self):
        result, calls = self.run_policy([{}], extra='AGY_IMAGE_POLICY_DEADLINE=$(( $(date +%s) - 1 ))')
        self.assertEqual(calls, 0)
        self.assertEqual(self.output.with_name('response.curl-exit').read_text(), '124')
        self.assertIn('workflow-timeout', result.stderr)

    def test_sse_explicit_authentication_error_is_not_retried(self):
        body = 'data: {"type":"error","error":{"type":"authentication_error"}}\n\n'
        result, calls = self.run_policy([{'body': body}], format='sse')
        self.assertEqual(calls, 1)
        self.assertNotIn('retry_in_seconds=', result.stderr)

    def test_configuration_and_remaining_budget_are_enforced(self):
        result, calls = self.run_policy([{}], options={'IMAGE_MAX_ATTEMPTS': '99'})
        self.assertEqual(result.returncode, 2)
        self.assertEqual(calls, 0)
        result, calls = self.run_policy([{}], extra='AGY_IMAGE_POLICY_DEADLINE=$(( $(date +%s) + 30 ))')
        self.assertEqual(calls, 1)
        self.assertLessEqual(json.loads((self.root / 'calls').read_text())['timeout'], 30)

    def test_generation_uses_policy_and_only_returns_a_real_image(self):
        prompt = self.root / 'prompt'
        prompt.write_text('Elysia in a formal gown, pink hair and elf ears.')
        success = json.dumps({'data': [{'b64_json': PNG}]})
        env = dict(self.env, IMAGE_API_KEY='synthetic-test-key', IMAGE_OPTIMIZED_PROMPT_FILE=str(prompt),
                   TEST_SCENARIO=json.dumps([{'http': '502'}, {'http': '200', 'body': success}]))
        # This test covers transport and image decoding. Visual quality has its
        # own schema and end-to-end mock tests; never touch production pending state.
        definitions = self.definitions() + '\nverify_generated_reference_image() { return 0; }\n'
        result = subprocess.run(['/bin/bash', '-c', definitions + '\nimage_generate "synthetic request"'], env=env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(int((self.root / 'count').read_text()), 2)
        self.assertIn('image_generate_curl_exit=0', result.stdout)
        self.assertNotIn('synthetic-test-key', result.stdout + result.stderr)
        image = next(line.split('=', 1)[1] for line in result.stdout.splitlines() if line.startswith('image_output='))
        self.assertTrue(Path(image).read_bytes().startswith(b'\x89PNG'))
        self.artifacts = [image]
        for line in result.stderr.splitlines():
            if any(token in line for token in ['failure_response=', 'failure_stderr=', 'failure_headers=']):
                self.artifacts.append(line.split('=', 1)[1])

    def test_edit_and_reference_generation_share_bounded_retries(self):
        source = self.root / 'source.png'
        source.write_bytes(base64.b64decode(PNG))
        definitions = SCRIPT.read_text().split('\ncase "${1:-all}" in')[0]
        # Source text in the same script directory, retaining the real policy
        # include, request construction, parsing and media validation.
        definitions = definitions.replace('source "$(dirname "${BASH_SOURCE[0]}")/image-request-policy.sh"', 'source ' + str(POLICY))
        definitions += '\noptimize_prompt_llm() { printf "Synthetic Elysia portrait"; }\nverify_generated_reference_image() { return 0; }\n'
        for mode in ['edit', 'reference']:
            with self.subTest(mode=mode):
                (self.root / 'count').unlink(missing_ok=True)
                (self.root / 'bodies').unlink(missing_ok=True)
                if mode == 'edit':
                    body = json.dumps({'data': [{'b64_json': PNG}]})
                    invoke = 'image_edit_files edit "synthetic scene" "$1"'
                else:
                    body = 'data: ' + json.dumps({'type': 'response.completed', 'response': {'output': [{'type': 'image_generation_call', 'result': PNG}]}}) + '\n\n'
                    invoke = 'image_generate_from_references "synthetic scene" https://example.invalid/reference.png'
                env = dict(self.env, IMAGE_API_KEY='synthetic-test-key', IMAGE_RESPONSES_MODEL='gpt-6-luna', TEST_SCENARIO=json.dumps([{'http': '503'}, {'body': body}]))
                result = subprocess.run(['/bin/bash', '-c', definitions + '\n' + invoke, 'test', str(source)], env=env, capture_output=True, text=True, timeout=5)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(int((self.root / 'count').read_text()), 2)
                image = next(line.split('=', 1)[1] for line in result.stdout.splitlines() if line.startswith('image_output='))
                self.assertTrue(Path(image).read_bytes().startswith(b'\x89PNG'))
                self.artifacts = getattr(self, 'artifacts', []) + [image]
                for line in result.stderr.splitlines():
                    if any(token in line for token in ['failure_response=', 'failure_stderr=', 'failure_headers=']):
                        self.artifacts.append(line.split('=', 1)[1])

    def definitions(self):
        return SCRIPT.read_text().split('\ncase "${1:-all}" in')[0].replace(
            'source "$(dirname "${BASH_SOURCE[0]}")/image-request-policy.sh"', 'source ' + str(POLICY))

    def test_gemini_optimizer_is_first_and_success_never_calls_gpt(self):
        definitions = self.definitions() + '''
optimize_prompt_openclaw_fallback() {
 printf '%s\\n' "$2" >> "$TEST_ROOT/models"
 [ "$2" != antigravity/gemini-3.8-flash-high ] || { printf 'Synthetic optimized prompt'; return 0; }
 return 1
}
optimize_prompt_llm 'synthetic scene'
'''
        result = subprocess.run(['/bin/bash', '-c', definitions], env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'models').read_text().splitlines(), ['antigravity/gemini-3.8-flash-high'])
        self.assertFalse((self.root / 'count').exists())

    def test_gemini_optimizer_failure_uses_gpt_then_registered_grok(self):
        definitions = self.definitions() + '''
optimize_prompt_openclaw_fallback() {
 printf '%s\\n' "$2" >> "$TEST_ROOT/models"
 [ "$2" != grok/grok-4.7 ] || { printf 'Synthetic optimized prompt'; return 0; }
 return 1
}
optimize_prompt_llm 'synthetic scene'
'''
        env = dict(self.env, IMAGE_API_KEY='synthetic-test-key', TEST_SCENARIO=json.dumps([{'http': '502'}]))
        result = subprocess.run(['/bin/bash', '-c', definitions], env=env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'models').read_text().splitlines(), [
            'antigravity/gemini-3.8-flash-high', 'novacode-gpt/gpt-6-luna', 'grok/grok-4.7'])
        body = json.loads((self.root / 'bodies').read_text().splitlines()[0])
        self.assertEqual(body['model'], 'gpt-6-luna')

    def test_gemini_responses_plan_executes_image2_once_then_verifies(self):
        (self.root / 'source.png').write_bytes(base64.b64decode(PNG))
        config = self.root / 'config.json'
        config.write_text(json.dumps({'proxy': {'api_key': 'synthetic-local-key'}}))
        definitions = self.definitions() + '''
CONFIG="$TEST_ROOT/config.json"
download_reference_image() { cp "$TEST_ROOT/source.png" "${!#}"; }
optimize_prompt_llm() { printf 'unexpected second optimization' >&2; return 99; }
verify_generated_reference_image() { printf 'visual_verification=passed\\n'; return 0; }
image_generate_from_references 'synthetic scene' https://example.invalid/reference.png
'''
        plan = {'status': 'completed', 'output': [{'type': 'message', 'content': [
            {'type': 'output_text', 'text': json.dumps({'action': 'generate', 'prompt': 'A distinct new scene based on the identity reference.'})}]}]}
        env = dict(self.env, IMAGE_API_KEY='synthetic-test-key', TEST_SCENARIO=json.dumps([
            {'body': json.dumps(plan)}, {'body': json.dumps({'data': [{'b64_json': PNG}]})}]))
        result = subprocess.run(['/bin/bash', '-c', definitions], env=env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(int((self.root / 'count').read_text()), 2)
        body = json.loads((self.root / 'bodies').read_text().splitlines()[0])
        self.assertEqual(body['model'], 'gemini-3.8-flash-high')
        self.assertEqual(body['input'][0]['content'][1]['image_url'], 'https://example.invalid/reference.png')
        self.assertIn('reference_generate_adapter=gemini-plan-images-edit', result.stdout)
        self.assertNotIn('unexpected second optimization', result.stderr)
        self.assertEqual(result.stdout.count('image_output='), 1)
        self.assertLess(result.stdout.index('visual_verification=passed'), result.stdout.index('image_output='))
        self.artifacts = [next(line.split('=', 1)[1] for line in result.stdout.splitlines() if line.startswith('image_output='))]

    def test_gemini_plan_unavailable_falls_back_before_generation_only(self):
        (self.root / 'source.png').write_bytes(base64.b64decode(PNG))
        definitions = self.definitions() + '''
plan_reference_with_gemini() { printf '%s\\n' "$2" > "$TEST_ROOT/plan-model"; return 1; }
image_generate_from_references_native() { printf 'native_model=%s\\nimage_output=%s\\n' "$IMAGE_RESPONSES_MODEL" "$TEST_ROOT/source.png"; }
image_generate_from_references 'synthetic scene' https://example.invalid/ref.png
'''
        result = subprocess.run(['/bin/bash', '-c', definitions], env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 0)
        self.assertEqual((self.root / 'plan-model').read_text().strip(), 'gemini-3.8-flash-high')
        self.assertIn('native_model=gpt-6-luna', result.stdout)

    def test_gemini_refusal_or_image_failure_never_uses_native_fallback(self):
        for failure in ['refusal', 'image']:
            definitions = self.definitions() + '''
image_generate_from_references_native() { printf 'WRONG_NATIVE_FALLBACK'; return 0; }
verify_generated_reference_image() { return 0; }
'''
            if failure == 'refusal':
                definitions += 'plan_reference_with_gemini() { return 3; }\n'
            else:
                definitions += 'plan_reference_with_gemini() { printf "Synthetic plan"; }\nimage_edit_references() { printf "image_edit_http=400\\nimage_edit_error=moderation_blocked\\n"; return 1; }\n'
            definitions += 'image_generate_from_references "synthetic scene" https://example.invalid/ref.png'
            result = subprocess.run(['/bin/bash', '-c', definitions], env=self.env, capture_output=True, text=True, timeout=5)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('WRONG_NATIVE_FALLBACK', result.stdout)
            self.assertNotIn('image_output=', result.stdout)


if __name__ == '__main__':
    unittest.main(verbosity=2)
