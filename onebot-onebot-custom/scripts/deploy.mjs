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
    else if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts") || entry.name.endsWith(".html") || ["LICENSE","NOTICE"].includes(entry.name))) result.push(name);
  }
  return result;
}

const reachIntegration=join(root,'integrations/agent-reach');
for(const name of ['xhs-media.py','prepare-xhs-login.py']){
  const check=spawnSync('python3',['-c','import ast,sys; ast.parse(open(sys.argv[1]).read())',join(reachIntegration,name)],{encoding:'utf8'});
  if(check.status!==0)throw new Error(`Reach helper syntax check failed: ${name}`);
}
const entries = await files(source);
const manifest = JSON.parse(await readFile(join(source, "openclaw.plugin.json"), "utf8"));
const { BUSINESS_TOOLS } = await import("../src/src/features/catalog.js");
if (JSON.stringify(manifest.contracts?.tools?.slice().sort()) !== JSON.stringify(Object.keys(BUSINESS_TOOLS).sort())) throw new Error("Tool manifest/catalog mismatch");
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

// Fixed administrative helpers execute only as openclaw-reach, outside the bot's home.
for(const name of ['xhs-media.py','prepare-xhs-login.py','xhs-command']){
 const destination=join('/opt/openclaw-agent-reach',name),temporary=destination+'.'+process.pid+'.tmp';
 await writeFile(temporary,await readFile(join(reachIntegration,name)),{mode:0o755});await rename(temporary,destination);
}
const reachSkill=resolve(root,'../skills/agent-reach-ops/SKILL.md');
await mkdir(dirname(reachSkill),{recursive:true});await cp(join(reachIntegration,'agent-reach-ops.SKILL.md'),reachSkill);
const xhsSkill=resolve(root,'../workspace/skills/xiaohongshu-ops/SKILL.md');await mkdir(dirname(xhsSkill),{recursive:true});await cp(join(reachIntegration,'xiaohongshu-ops.SKILL.md'),xhsSkill);

// Install the exact locked dependencies before publishing new runtime modules.
const runtimePackage=resolve(target,"../package.json");
const runtimeMetadata=JSON.parse(await readFile(runtimePackage,"utf8"));
runtimeMetadata.dependencies=JSON.parse(await readFile(join(root,"package.json"),"utf8")).dependencies;
await writeFile(runtimePackage,JSON.stringify(runtimeMetadata,null,2)+"\n");
await cp(join(root,"package-lock.json"),resolve(target,"../package-lock.json"));
const dependencies=spawnSync("npm",["ci","--omit=dev","--legacy-peer-deps","--no-audit","--no-fund"],{cwd:resolve(target,".."),encoding:"utf8"});
if (dependencies.status !== 0) throw new Error(`Dependency install failed: ${dependencies.stderr}`);

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
const runtimeManifest = resolve(target, "../openclaw.plugin.json");
await cp(runtimeManifest, join(backup, "openclaw.plugin.json"));
await writeFile(`${runtimeManifest}.${process.pid}.tmp`, JSON.stringify(manifest, null, 2) + "\n");
await rename(`${runtimeManifest}.${process.pid}.tmp`, runtimeManifest);
console.log(`Deployed ${entries.length} files; previous artifacts backed up at ${backup}`);
console.log("Restart openclaw-gateway.service to load deployed modules");
