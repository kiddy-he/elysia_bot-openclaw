import { mkdir, lstat, chmod, writeFile, rename, unlink, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../errors.js';
export async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || typeof process.getuid === 'function' && info.uid !== process.getuid()) fail('unsafe_data_directory');
  await chmod(path, 0o700);
}
export async function atomicJson(path, value, options) {
  return atomicFile(path, JSON.stringify(value), options);
}
export async function atomicFile(path, value, { beforeCommit } = {}) {
  await privateDir(dirname(path));
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, value, { mode: 0o600, flag: 'wx' });
    const handle = await open(tmp, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    await beforeCommit?.(); await rename(tmp, path);
  } finally { await unlink(tmp).catch(() => {}); }
}
