import { readFile, readdir, mkdir, copyFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.OPENCLAW_DIST ?? "/opt/node-v25.9.0-linux-x64/lib/node_modules/openclaw/dist";
const mode = process.argv[2] ?? "--check";
if (!["--check", "--apply"].includes(mode)) throw new Error("Use --check or --apply");
const helperName = "local-gemini-native-search.js";
const helper = await readFile(join(project, "src/src/gemini-native-search.js"), "utf8");
const importLine = `import { withGeminiNativeSearch } from "./${helperName}";\n`;
const targets = [];
for (const name of await readdir(root)) {
    if (!/^(?:stream|proxy)-.*\.js$/u.test(name)) continue;
    const path = join(root, name);
    const original = await readFile(path, "utf8");
    let next = original;
    if (original.includes("function applyGeminiWebSearchPayload(") && !original.includes(importLine)) {
        const start = next.indexOf('const GEMINI_WEB_SEARCH_MARKER =');
        const end = next.indexOf("function stream(model, context, options)", start);
        if (start < 0 || end < 0) throw new Error(`Unexpected stream structure: ${name}`);
        next = next.slice(0, start) + 'function applyGeminiWebSearchPayload(model, context, options) {\n\treturn withGeminiNativeSearch(model, context, options);\n}\n' + next.slice(end);
    }
    if (original.includes("function createOpenAICompletionsToolsCompatWrapper(")) {
        const start = next.indexOf('const ANTIGRAVITY_GEMINI_WEB_SEARCH_TOOL =');
        const end = next.indexOf("/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */\nfunction createOpenAIThinkingLevelWrapper", start);
        if (start >= 0 && end >= 0) {
            next = next.slice(0, start) + `/** Local provider search compatibility: service-owned grounding. */
function createOpenAICompletionsToolsCompatWrapper(baseStreamFn) {
 const underlying = baseStreamFn ?? streamSimple;
 return (model, context, options) => {
  const effectiveOptions = withGeminiNativeSearch(model, context, options);
  if (effectiveOptions !== options) return underlying(model, context, effectiveOptions);
  return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
   if (!shouldStripOpenAICompletionTools(model)) return;
   delete payloadObj.tools;
   delete payloadObj.tool_choice;
   delete payloadObj.parallel_tool_calls;
  });
 };
}
` + next.slice(end);
        } else if (!next.includes(importLine)) throw new Error(`Unexpected proxy structure: ${name}`);
    }
    if (next !== original && !next.includes(importLine)) next = importLine + next;
    if (next.includes(importLine)) targets.push({ path, original, next });
}
if (targets.length !== 2) throw new Error(`Expected exactly two core search adapters, found ${targets.length}; review installed version`);
for (const target of targets) {
    if (/function:\s*\{\s*name:\s*"web_search"/u.test(target.next)) throw new Error(`Stale search function remains in ${target.path}`);
}
if (mode === "--check") {
    console.log(JSON.stringify({ targets: targets.map((t) => t.path), changesRequired: targets.some((t) => t.next !== t.original), helperInstalled: await readFile(join(root, helperName), "utf8").then((s) => s === helper).catch(() => false) }));
    process.exit(0);
}
const backup = resolve(project, `../state/backups/gemini-native-search-core-${Date.now()}`);
await mkdir(backup, { recursive: true, mode: 0o700 });
for (const target of targets) {
    const checked = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: target.next, encoding: "utf8" });
    if (checked.status !== 0) throw new Error(checked.stderr);
}
for (const target of targets) await copyFile(target.path, join(backup, target.path.split("/").at(-1)));
try { await copyFile(join(root, helperName), join(backup, helperName)); } catch (error) { if (error.code !== "ENOENT") throw error; }
const helperTemporary = join(root, `${helperName}.tmp`);
await writeFile(helperTemporary, helper);
await rename(helperTemporary, join(root, helperName));
for (const target of targets) {
    const temporary = `${target.path}.local.tmp`;
    await writeFile(temporary, target.next);
    await rename(temporary, target.path);
    const valid = spawnSync(process.execPath, ["--check", target.path], { encoding: "utf8" });
    if (valid.status !== 0) throw new Error(valid.stderr);
}
console.log(JSON.stringify({ applied: targets.map((t) => t.path), backup }));
