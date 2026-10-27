import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomInt } from 'node:crypto';
import { join } from 'node:path';
const root = process.env.ONEBOT_CONFIG_ROOT ? join(process.env.ONEBOT_CONFIG_ROOT, 'workspace') : '/root/.openclaw/workspace';
const listPath = join(root, 'lunch-list.json'), statePath = join(root, 'lunch-state.json');
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const day = date => Date.parse(`${date}T00:00:00+08:00`), now = day(date), dayMs = 86400000;
try {
  const list = JSON.parse(await readFile(listPath, 'utf8')), state = JSON.parse(await readFile(statePath, 'utf8'));
  if (!Array.isArray(list) || !list.length || !Array.isArray(state.history)) throw new Error('午饭清单或记录格式无效');
  const existing = state.history.find(x => x?.date === date && typeof x.name === 'string' && x.name);
  if (existing) { process.stdout.write(JSON.stringify({ status: 'succeeded', date, dish: existing.name, reused: true, historySize: state.history.length })); process.exit(0); }
  const recent = new Set(state.history.filter(x => x && typeof x.date === 'string' && now - day(x.date) >= 0 && now - day(x.date) < 7 * dayMs).map(x => String(x.name)));
  const candidates = list.map(String).filter(x => x && !recent.has(x));
  if (!candidates.length) throw new Error('没有可用的七日去重菜品');
  const dish = candidates[randomInt(candidates.length)];
  const history = [...state.history, { date, name: dish }].filter(x => x && typeof x.date === 'string' && now - day(x.date) <= 30 * dayMs).slice(-30);
  const tmp = `${statePath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...state, history }, null, 2) + '\n', { mode: 0o600 }); await rename(tmp, statePath);
  process.stdout.write(JSON.stringify({ status: 'succeeded', date, dish, historySize: history.length }));
} catch (e) { process.stderr.write(String(e?.message ?? e)); process.exitCode = 1; }
