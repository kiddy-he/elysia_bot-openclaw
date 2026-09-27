#!/usr/bin/env node

import { chmodSync, copyFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const home = process.env.HOME ?? "/root";
const routingPath = join(home, ".openclaw", "onebot-model-routing.json");
const openclawPath = join(home, ".openclaw", "openclaw.json");
const backupPath = `${openclawPath}.bak-model-routing`;
const routingBackupPath = `${routingPath}.bak`;
const requestedPreset = process.argv[2];
const validThinking = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function fail(message) {
  console.error(`model-routing: ${message}`);
  process.exit(1);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read ${label}: ${error.message}`);
  }
}

function validateRoute(route, label, registeredModels) {
  if (!route || typeof route.model !== "string" || !route.model.includes("/"))
    fail(`${label}.model must be a provider/model reference`);
  if (!validThinking.has(route.thinking))
    fail(`${label}.thinking must be one of ${[...validThinking].join(", ")}`);
  if (!registeredModels.has(route.model))
    fail(`${label}.model is not registered in openclaw.json: ${route.model}`);
}

const routing = readJson(routingPath, "routing config");
if (requestedPreset) {
  if (!routing.presets?.[requestedPreset])
    fail(`unknown preset '${requestedPreset}'; available: ${Object.keys(routing.presets ?? {}).join(", ")}`);
  routing.activePreset = requestedPreset;
}

const presetName = routing.activePreset;
const preset = routing.presets?.[presetName];
if (!preset)
  fail(`activePreset '${presetName}' does not exist`);

const openclaw = readJson(openclawPath, "openclaw config");
const registeredModels = new Set();
for (const [provider, providerConfig] of Object.entries(openclaw.models?.providers ?? {})) {
  for (const model of providerConfig.models ?? [])
    registeredModels.add(`${provider}/${model.id}`);
}

validateRoute(preset.conversation, "conversation", registeredModels);
validateRoute(preset.textReview, "textReview", registeredModels);
for (const [index, route] of (preset.contentFallbacks ?? []).entries())
  validateRoute(route, `contentFallbacks[${index}]`, registeredModels);
for (const [index, route] of (preset.errorFallbacks ?? []).entries())
  validateRoute(route, `errorFallbacks[${index}]`, registeredModels);
if (!preset.contentFallbacks?.length || !preset.errorFallbacks?.length)
  fail("both fallback lists must contain at least one route");

openclaw.agents.defaults.model.primary = preset.conversation.model;
openclaw.agents.defaults.model.fallbacks = [];
openclaw.agents.entries["text-fallback"].model.primary = preset.textReview.model;
openclaw.agents.entries["text-fallback"].model.fallbacks = [];

const allRoutes = [
  preset.conversation,
  preset.textReview,
  ...preset.contentFallbacks,
  ...preset.errorFallbacks,
];
for (const route of allRoutes) {
  const modelConfig = openclaw.agents.defaults.models[route.model] ??= {
    agentRuntime: { id: "openclaw" }
  };
  modelConfig.params ??= {};
  modelConfig.params.reasoningEffort = route.thinking;
}
openclaw.agents.defaults.modelPolicy.allow = [...new Set([
  ...openclaw.agents.defaults.modelPolicy.allow,
  ...allRoutes.map((route) => route.model),
])];

const temporaryOpenclawPath = join(dirname(openclawPath), `.openclaw.json.${process.pid}.tmp`);
const temporaryRoutingPath = join(dirname(routingPath), `.onebot-model-routing.json.${process.pid}.tmp`);
copyFileSync(openclawPath, backupPath);
copyFileSync(routingPath, routingBackupPath);
chmodSync(backupPath, 0o600);
chmodSync(routingBackupPath, 0o600);
writeFileSync(temporaryOpenclawPath, `${JSON.stringify(openclaw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
writeFileSync(temporaryRoutingPath, `${JSON.stringify(routing, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
renameSync(temporaryOpenclawPath, openclawPath);
renameSync(temporaryRoutingPath, routingPath);
chmodSync(openclawPath, 0o600);
chmodSync(routingPath, 0o600);

const validation = spawnSync("openclaw", ["config", "validate"], { encoding: "utf8" });
if (validation.status !== 0) {
  copyFileSync(backupPath, openclawPath);
  copyFileSync(routingBackupPath, routingPath);
  chmodSync(openclawPath, 0o600);
  chmodSync(routingPath, 0o600);
  fail(`OpenClaw validation failed; restored backup\n${validation.stderr || validation.stdout}`);
}

const restart = spawnSync("systemctl", ["--user", "restart", "openclaw-gateway.service"], { encoding: "utf8" });
if (restart.status !== 0)
  fail(`configuration applied but Gateway restart failed\n${restart.stderr || restart.stdout}`);

let gatewayReady = false;
for (let attempt = 0; attempt < 20; attempt += 1) {
  const health = spawnSync("openclaw", ["gateway", "call", "health", "--json", "--timeout", "5000"], { encoding: "utf8" });
  if (health.status === 0) {
    gatewayReady = true;
    break;
  }
  spawnSync("sleep", ["1"]);
}
if (!gatewayReady)
  fail("configuration applied but Gateway did not become ready within 20 seconds");

const sessionsResult = spawnSync("openclaw", ["sessions", "--agent", "main", "--json", "--limit", "all"], { encoding: "utf8" });
if (sessionsResult.status !== 0)
  fail(`configuration applied but existing OneBot sessions could not be listed\n${sessionsResult.stderr || sessionsResult.stdout}`);
let onebotSessionKeys;
try {
  onebotSessionKeys = JSON.parse(sessionsResult.stdout).sessions
    .map((session) => session.key)
    .filter((key) => /^agent:main:onebot:(?:direct|group):/u.test(key));
} catch (error) {
  fail(`configuration applied but session list JSON was invalid: ${error.message}`);
}
for (const key of onebotSessionKeys) {
  const patch = spawnSync("openclaw", [
    "gateway",
    "call",
    "sessions.patch",
    "--params",
    JSON.stringify({
      key,
      model: preset.conversation.model,
      thinkingLevel: preset.conversation.thinking,
    }),
    "--json",
    "--timeout",
    "15000",
  ], { encoding: "utf8" });
  if (patch.status !== 0)
    fail(`configuration applied but session model update failed for ${key}\n${patch.stderr || patch.stdout}`);
}

console.log(`model-routing: active preset=${presetName}`);
console.log(`conversation=${preset.conversation.model} thinking=${preset.conversation.thinking}`);
console.log(`review=${preset.textReview.model} thinking=${preset.textReview.thinking}`);
console.log(`contentFallbacks=${preset.contentFallbacks.map((route) => route.model).join(" -> ")}`);
console.log(`errorFallbacks=${preset.errorFallbacks.map((route) => route.model).join(" -> ")}`);
console.log(`updatedOneBotSessions=${onebotSessionKeys.length}`);
