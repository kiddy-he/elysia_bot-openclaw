import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const outputRoot = join(repoRoot, ".clawhub-skill", "openclaw-onebot");

const basePackage = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await cp(join(repoRoot, "SKILL.md"), join(outputRoot, "SKILL.md"));
await cp(join(repoRoot, "README.md"), join(outputRoot, "README.md"));
await cp(join(repoRoot, "LICENSE"), join(outputRoot, "LICENSE"));

const summary = {
  output: outputRoot,
  slug: "openclaw-onebot",
  displayName: "OpenClaw OneBot",
  version: basePackage.version,
};

await writeFile(join(outputRoot, "release.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
