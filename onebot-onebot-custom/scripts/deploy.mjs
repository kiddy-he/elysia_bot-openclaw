import { cp, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "src");
const target = resolve(root, "../extensions/openclaw-onebot/dist");
const mode = process.argv[2];
if (!["--check", "--deploy"].includes(mode)) throw new Error("Use --check or --deploy");

async function files(dir, prefix = "") {
  const result = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) result.push(...await files(join(dir, entry.name), name));
    else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts"))) result.push(name);
  }
  return result;
}

const entries = await files(source);
for (const name of entries.filter((name) => name.endsWith(".js"))) {
  const check = spawnSync(process.execPath, ["--check", join(source, name)], { encoding: "utf8" });
  if (check.status !== 0) throw new Error(`Syntax check failed: ${name}\n${check.stderr}`);
}
const tests = spawnSync(process.execPath, ["--test", ...((await readdir(join(root, "tests"))).filter((name) => name.endsWith(".test.mjs")).map((name) => join(root, "tests", name)))], { encoding: "utf8" });
if (tests.status !== 0) throw new Error(`Tests failed:\n${tests.stdout}\n${tests.stderr}`);
if (mode === "--check") {
  console.log(`Checked ${entries.length} source files and tests`);
  process.exit(0);
}

// Keep the currently running artifact intact until every source file validates.
const backup = resolve(root, `../state/backups/onebot-dist-pre-deploy-${Date.now()}`);
await mkdir(backup, { recursive: true, mode: 0o700 });
for (const name of entries) {
  const destination = join(target, name);
  const sourceFile = join(source, name);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await stat(destination);
    await mkdir(dirname(join(backup, name)), { recursive: true });
    await cp(destination, join(backup, name));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, await readFile(sourceFile));
  await rename(temporary, destination);
}
console.log(`Deployed ${entries.length} files; previous artifacts backed up at ${backup}`);
console.log("Restart openclaw-gateway.service to load deployed modules");
