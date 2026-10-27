import { fail, safeError } from '../errors.js';
import { runBrowser } from './runtime.js';
import { loadChromium } from './playwright.js';
const emit = frame => {
  const body = JSON.stringify(frame);
  process.stdout.write(Buffer.byteLength(body) <= 512 * 1024 ? body + '\n' : '{"ok":false,"error":{"code":"response_size"}}\n');
};
try {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 8192) fail('invalid_request'); }
  const chromium = await loadChromium();
  emit({ ok: true, data: await runBrowser(JSON.parse(input), { chromium, emit }) });
} catch (error) { emit({ ok: false, error: safeError(error) }); }
