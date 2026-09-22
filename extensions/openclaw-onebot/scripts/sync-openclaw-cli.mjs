#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readdir, readFile, writeFile } from 'node:fs/promises';

const home = process.env.OPENCLAW_HOME ?? join(homedir(), '.openclaw');
const dist = join(home, 'lib', 'node_modules', 'openclaw', 'dist');
const types = join(dist, 'plugin-sdk', 'src', 'channels', 'plugins', 'types.core.d.ts');
const find = async (prefix, exclude = '') =>
  (await readdir(dist)).find(
    (name) => name.startsWith(prefix) && name.endsWith('.js') && (!exclude || !name.startsWith(exclude)),
  );
const replaceOnce = (text, search, insert, file) => {
  if (text.includes(insert)) return text;
  if (!text.includes(search)) throw new Error(`Missing patch anchor in ${file}`);
  return text.replace(search, insert);
};
const patch = async (file, transforms) => {
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return false; }
  const next = transforms.reduce((acc, [search, insert]) => replaceOnce(acc, search, insert, file), text);
  if (next !== text) await writeFile(file, next);
  return next !== text;
};
const findWithText = async (prefix, needle, exclude = '') => {
  const entries = await readdir(dist);
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.js') || (exclude && name.startsWith(exclude))) continue;
    const text = await readFile(join(dist, name), 'utf8');
    if (text.includes(needle)) return name;
  }
};

const cli = await find('channels-cli-');
const channels = await findWithText('channels-', '\t\taccessToken: opts.accessToken,', 'channels-cli-');
if (!cli || !channels) {
  console.log(`[onebot] OpenClaw CLI dist not found under ${dist}; skipping sync.`);
  process.exit(0);
}

const changed = await Promise.all([
  patch(join(dist, cli), [
    [`"accessToken",\n\t"password",`, `"accessToken",\n\t"sharedDir",\n\t"containerSharedDir",\n\t"password",`],
    [`.option("--access-token <token>", "Matrix access token").option("--password <password>", "Matrix password")`, `.option("--access-token <token>", "Matrix access token").option("--shared-dir <path>", "Host directory mounted into NapCat for outbound media/files").option("--container-shared-dir <path>", "Container path corresponding to the shared host directory").option("--password <password>", "Matrix password")`],
  ]),
  patch(join(dist, channels), [[`\t\taccessToken: opts.accessToken,\n\t\tpassword: opts.password,`, `\t\taccessToken: opts.accessToken,\n\t\tsharedDir: opts.sharedDir,\n\t\tcontainerSharedDir: opts.containerSharedDir,\n\t\tpassword: opts.password,`]]),
  patch(types, [[`    accessToken?: string;\n    password?: string;`, `    accessToken?: string;\n    sharedDir?: string;\n    containerSharedDir?: string;\n    password?: string;`]]),
]);

console.log(changed.some(Boolean) ? `[onebot] Synced OpenClaw CLI shared-dir flags in ${home}.` : `[onebot] OpenClaw CLI shared-dir flags already in sync.`);
