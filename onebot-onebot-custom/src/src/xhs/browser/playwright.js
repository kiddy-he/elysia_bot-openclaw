import { fail } from '../errors.js';
export async function loadChromium() {
  try { return (await import('playwright-core')).chromium; } catch {}
  try { return (await import('../../browser-runtime/node_modules/playwright-core/index.mjs')).chromium; }
  catch { fail('browser_dependency_missing'); }
}
