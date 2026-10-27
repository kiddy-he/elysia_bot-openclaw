#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { XhsService } from './index.js';
import { safeError } from './errors.js';

const args = process.argv.slice(2), ctrl = new AbortController();
process.on('SIGTERM', () => ctrl.abort()); process.on('SIGINT', () => ctrl.abort());
let service;
try {
  const option = name => { const n = args.indexOf(name); return n === -1 ? undefined : args[n + 1]; };
  if (args.includes('--help')) {
    process.stdout.write('komachi-xhs [--data-dir DIR] [--backend http|browser|interactive] [--browser-path FILE] [--allow-no-sandbox] [--direct] [--interaction-port PORT] [--interaction-public-origin HTTPS_ORIGIN] [--headed]\nJSON stdin: {operation,params,context}. Operator CLI only; do not expose raw context to untrusted clients.\n--import-session FILE imports operator-provided credentials without printing values. --run-pending drains persistent jobs.\n--backend interactive uses a temporary browser for human login and HTTP for business calls. interaction_url is a private operator credential, bound to 127.0.0.1. --headed requires a local display.\n');
  } else {
    service = await XhsService.create({ dataDir: option('--data-dir'), backend: option('--backend') ?? 'http', executablePath: option('--browser-path'), chromiumSandbox: !args.includes('--allow-no-sandbox'), directConnection: true, interactionPort: option('--interaction-port') === undefined ? 0 : Number(option('--interaction-port')), interactionPublicOrigin: option('--interaction-public-origin'), headed: args.includes('--headed') });
    if (args.includes('--import-session')) {
      const path = option('--import-session');
      const content = await readFile(path); if (content.length > 256 * 1024) throw new Error('invalid');
      const ctx = { accountId: 'local', scope: 'operator', actorId: 'operator', requestId: crypto.randomUUID(), operator: true };
      console.log(JSON.stringify({ version: 1, ok: true, data: await service.importSession(JSON.parse(content), ctx) }));
    } else if (args.includes('--run-pending')) {
      await service.runPending({ signal: ctrl.signal }); console.log(JSON.stringify({ version: 1, ok: true, data: { drained: true } }));
    } else {
      let body = ''; for await (const chunk of process.stdin) { body += chunk; if (Buffer.byteLength(body) > 8192) throw new Error('invalid'); }
      const input = JSON.parse(body);
      if (Object.keys(input).some(k => !['operation', 'params', 'context'].includes(k))) throw new Error('invalid');
      const response = await service.execute(input.operation, input.params ?? {}, input.context, { signal: ctrl.signal, onProgress: event => console.log(JSON.stringify(event)) });
      console.log(JSON.stringify(response)); if (!response.ok) process.exitCode = 1;
    }
  }
} catch (e) { console.log(JSON.stringify({ version: 1, ok: false, error: e.name === 'SyntaxError' ? { code: 'invalid_json' } : safeError(e) })); process.exitCode = 1; }
finally { await service?.close(); }
