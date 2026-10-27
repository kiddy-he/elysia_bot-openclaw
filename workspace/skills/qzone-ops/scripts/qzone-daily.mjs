#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { getQzoneMsgList, uploadQzoneImage, publishQzoneMsg, deleteQzoneMsg } from "./qzone-client.mjs";
import { recoverPreparationFailure, retryMayRun, describePreparationFailure, notifyDailyFailure } from "./qzone-recovery.mjs";
import { TIME_POLICY, publicationTimeContext, chooseTimeTheme, assertTimeDraft, timeBoundScene, alignedReschedule, assertTimeReceipt } from "./qzone-time.mjs";

import { chooseCharacterPlan, characterDraftContext, localImageArguments } from "./qzone-characters.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = "/root/.openclaw/state/qzone-daily";
const IMAGE_SCRIPT = "/root/.openclaw/workspace/skills/agy-proxy/scripts/agy-proxy-diagnose.sh";

export function chinaDate(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

export function choosePublishAt(date, now = Date.now(), leadMs = 90 * 60000, random = crypto.randomInt) {
  const start = Math.ceil(Math.max(Date.parse(`${date}T08:00:00+08:00`), now + leadMs) / 1000) * 1000;
  const end = Date.parse(`${date}T22:00:00+08:00`);
  if (start >= end) return null;
  return start + random(Math.ceil((end - start) / 1000)) * 1000;
}

function init() {
  process.umask(0o077);
  fs.mkdirSync(path.join(ROOT, "days"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(ROOT, "images"), { recursive: true, mode: 0o700 });
}
function statePath(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid date");
  return path.join(ROOT, "days", `${date}.json`);
}
function readState(date) { const p = statePath(date); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null; }
function save(state) {
  const p = statePath(state.date), tmp = `${p}.${process.pid}.${crypto.randomUUID()}.tmp`;
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); fs.renameSync(tmp, p);
}
function event(type, fields = {}) { console.log(JSON.stringify({ time: new Date().toISOString(), type, ...fields })); }
function digest(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

export function readQualityReceipt(imagePath) {
  const receipt = JSON.parse(fs.readFileSync(`${imagePath}.quality.json`, "utf8"));
  if (receipt.accepted_for_delivery === true && receipt.passed === false) {
    // Validate all three scored candidates and highest-score selection locally;
    // a fallback remains an explicit below-threshold result, never a fake pass.
    return JSON.parse(execFileSync("/usr/bin/python3", [
      "/root/.openclaw/workspace/skills/agy-proxy/scripts/image-quality.py", `${imagePath}.quality.json`, "--delivery-image", imagePath,
    ], { encoding: "utf8", timeout: 10000, maxBuffer: 512 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
  }
  const flags = ["anatomy_consistent", "all_expected_characters_present", "no_extra_characters", "scene_and_actions_match", "identity_mapping_confident", "source_pose_and_layout_replaced", "scene_directed_pose_and_gaze"];
  if (receipt.policy_version !== "anatomy-v1" || receipt.passed !== true || receipt.image_sha256 !== digest(imagePath) ||
      typeof receipt.anatomy_score !== "number" || receipt.anatomy_score < 90 || receipt.anatomy_score > 100 ||
      typeof receipt.compliance_score !== "number" || receipt.compliance_score < 0 || receipt.compliance_score > 100 ||
      0.7 * receipt.anatomy_score + 0.3 * receipt.compliance_score < 85 ||
      flags.some((key) => receipt[key] !== true) ||
      !Array.isArray(receipt.severe_anatomy_errors) || receipt.severe_anatomy_errors.length ||
      !Array.isArray(receipt.failures) || receipt.failures.length) throw new Error("Missing or failed current anatomy-quality assessment");
  return receipt;
}

async function locked(date, action) {
  // The CLI holds an OS flock for the whole operation; crashes release it automatically.
  statePath(date);
  return action();
}

function cron(args) {
  // list/add expose --json; edit/enable/disable do not in the installed CLI.
  const json = ['list', 'add'].includes(args[0]);
  const output = execFileSync("/usr/local/bin/openclaw", ["cron", ...args, ...(json ? ["--json"] : [])], { encoding: "utf8", timeout: 40000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  if (json) return JSON.parse(output);
  return { ok: true };
}
export function ensurePublishJob(state, { runCron = cron, runFile = execFileSync, persist = save } = {}) {
  if (!state.publishAt || state.status === "published") return;
  const key = `qzone-elysia-publish:${state.date}`;
  const existing = runCron(["list", "--all"]).jobs.find((job) => job.declarationKey === key);
  if (existing) {
    state.publishJobId = existing.id; persist(state);
    runFile(process.execPath, ["/root/.openclaw/onebot-onebot-custom/scripts/bind-scheduled.mjs", "add-qzone", state.publishJobId, state.date], { stdio: "pipe", timeout: 15000 });
    runCron(["edit", state.publishJobId, "--at", new Date(state.publishAt).toISOString(), "--agent", "qq-auto-elysia-normal-main", "--command-argv", JSON.stringify([process.execPath, "/root/.openclaw/onebot-onebot-custom/scripts/run-scheduled.mjs", state.publishJobId])]);
    runCron(["enable", state.publishJobId]);
    return;
  }
  const result = runCron(["add", "--name", `qzone-elysia-publish-${state.date}`, "--declaration-key", key,
    "--agent", "qq-auto-elysia-normal-main", "--at", new Date(state.publishAt).toISOString(), "--session", "isolated", "--no-deliver", "--delete-after-run", "--disabled",
    "--command-argv", JSON.stringify([process.execPath, SCRIPT, "publish", state.date]), "--command-cwd", ROOT,
    "--timeout-seconds", "360", "--no-output-timeout-seconds", "360", "--output-max-bytes", "8192"]);
  state.publishJobId = result.id || result.job?.id;
  if (!state.publishJobId) throw new Error("Missing publish job identity");
  persist(state);
  runFile(process.execPath, ["/root/.openclaw/onebot-onebot-custom/scripts/bind-scheduled.mjs", "add-qzone", state.publishJobId, state.date], { stdio: "pipe", timeout: 15000 });
  runCron(["edit", state.publishJobId, "--command-argv", JSON.stringify([process.execPath, "/root/.openclaw/onebot-onebot-custom/scripts/run-scheduled.mjs", state.publishJobId])]);
  runCron(["enable", state.publishJobId]);
}

export function schedulePrepareRetry(state, at, attempt, { runCron = cron, runFile = execFileSync, persist = save } = {}) {
  const key = `qzone-elysia-prepare-retry:${state.date}:${attempt}`;
  const existing = runCron(["list", "--all"]).jobs.find(job => job.declarationKey === key);
  const result = existing ?? runCron(["add", "--name", `qzone-elysia-prepare-retry-${state.date}-${attempt}`, "--declaration-key", key,
    "--agent", "qq-auto-elysia-normal-main", "--at", new Date(at).toISOString(), "--session", "isolated", "--no-deliver", "--delete-after-run", "--disabled",
    "--command-argv", JSON.stringify([process.execPath, SCRIPT, "prepare-retry", state.date, String(attempt)]), "--command-cwd", ROOT,
    "--timeout-seconds", "4800", "--no-output-timeout-seconds", "4800", "--output-max-bytes", "8192"]);
  const id = result.id || result.job?.id;
  if (!id) throw new Error("Missing retry job identity");
  // Commit identity before enabling; stale or early invocations validate both
  // expected attempt and due time under the same OS lock as publishing.
  state.retryJobId = id; persist(state);
  runFile(process.execPath, ["/root/.openclaw/onebot-onebot-custom/scripts/bind-scheduled.mjs", "add-qzone-retry", id, state.date, "true", String(attempt)], { stdio: "pipe", timeout: 15000 });
  runCron(["edit", id, "--at", new Date(at).toISOString(), "--command-argv", JSON.stringify([process.execPath, "/root/.openclaw/onebot-onebot-custom/scripts/run-scheduled.mjs", id])]);
  runCron(["enable", id]);
  return id;
}

async function onPrepareFailure(state, imageLog) {
  const log = (state.error ?? '') + '\n' + (imageLog && fs.existsSync(imageLog) ? fs.readFileSync(imageLog, "utf8") : "");
  state.failureReason = describePreparationFailure(log);
  await recoverPreparationFailure(state, { persist: save,
    schedule: (at, attempt) => schedulePrepareRetry(state, at, attempt),
    cancelPublication: () => { if (state.publishJobId) cron(["disable", state.publishJobId]); },
  });
  event("prepare-recovery", { date: state.date, status: state.status, attempt: state.prepareAttempts,
    retryAt: state.retryAt ? new Date(state.retryAt).toISOString() : null,
    notification: Object.values(state.failureNotifications ?? {}).at(-1)?.state });
}

function runLogged(command, args, logPath, timeout, input = undefined) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(logPath, "w", 0o600);
    const child = spawn(command, args, { stdio: ["pipe", fd, fd], detached: true });
    fs.closeSync(fd);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      const stop = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5000); stop.unref();
    }, timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) resolve(); else reject(new Error(timedOut ? "Workflow timed out" : `Workflow exited ${code}; see private log`));
    });
    child.stdin.end(input);
  });
}

function history() {
  return fs.readdirSync(path.join(ROOT, "days")).filter((x) => x.endsWith(".json")).sort().slice(-30)
    .map((x) => JSON.parse(fs.readFileSync(path.join(ROOT, "days", x), "utf8")))
    .filter((x) => x.caption).map(({ date, theme, caption }) => ({ date, theme, caption }));
}

async function prepare(date = chinaDate(), expectedAttempt) {
  return locked(date, async () => {
    if (date !== chinaDate()) throw new Error("Only today's draft may be prepared");
    let state = readState(date);
    if (!state) {
      state = { version: 1, date, account: "default", visibility: 4, status: "planned", publishAt: choosePublishAt(date), createdAt: new Date().toISOString() };
      if (!state.publishAt) state.status = "expired";
      save(state);
    }
    if (expectedAttempt !== undefined && !retryMayRun(state, expectedAttempt)) return event("stale-retry-skipped", { date, expectedAttempt, status: state.status });
    if (["published", "expired", "uncertain", "publishing"].includes(state.status)) return event("prepare-skipped", { date, status: state.status });
    if (state.status === "retry_waiting" && expectedAttempt === undefined) return event("waiting-for-random-retry", { date, retryAt: state.retryAt });
    if (state.status === "ready") {
      try { assertTimeReceipt(state, state.publishAt); return event("already-ready", { date, publishAt: new Date(state.publishAt).toISOString() }); }
      catch { state.status = "failed"; state.error = "Publication-time verification missing or stale; regenerate required"; save(state); await onPrepareFailure(state); return; }
    }
    if (["drafting", "generating", "verifying-time"].includes(state.status)) {
      // A previous process died. Do not automatically repeat a possibly billed generation.
      state.status = "failed"; state.error = "Interrupted preparation requires inspection"; save(state);
      state.failureReason = "上次准备过程被中断，需先核对已有生成结果";
      await notifyDailyFailure(state, "prepare", { persist: save });
      throw new Error(state.error);
    }
    if (expectedAttempt !== undefined) {
      state.publishAt = choosePublishAt(date);
      state.retryAt = null; state.retryConsumedAt = new Date().toISOString();
    }
    if (!state.publishAt) { state.status = "expired"; save(state); return event("no-publication-slot", { date }); }
    if (state.status === "failed" && expectedAttempt === undefined) {
      await onPrepareFailure(state); return;
    }
    if (state.publishAt <= Date.now()) state.publishAt = choosePublishAt(date);
    if (!state.publishAt) { state.status = "expired"; save(state); return event("no-publication-slot", { date }); }
    // Theme, copy and scene share one immutable preparation time context.
    state.timePolicy = TIME_POLICY.version;
    state.timeContext = publicationTimeContext(state.publishAt);
    state.theme = chooseTimeTheme(state.publishAt, history());
    state.imageVerified = false;
    delete state.uploadedImage;
    delete state.timeVerification;
    state.prepareAttempts = expectedAttempt ?? 1;
    state.attemptHistory ??= [];
    state.attemptHistory.push({ attempt: state.prepareAttempts, startedAt: new Date().toISOString(), publishAt: state.publishAt });
    save(state);
    const attemptSuffix = state.prepareAttempts > 1 ? `-attempt-${state.prepareAttempts}` : "";
    const imageLog = path.join(ROOT, `${date}-image${attemptSuffix}.log`);
    try {
      state.referencePlan = chooseCharacterPlan();
      state.attemptHistory.at(-1).characterMode = state.referencePlan.mode;
      state.attemptHistory.at(-1).characters = state.referencePlan.characters.map(x => x.name);
      state.status = "drafting"; save(state); event("drafting", { date, theme: state.theme, mode: state.referencePlan.mode, characters: state.referencePlan.characters.map(x => x.name) });
      const draftLog = path.join(ROOT, `${date}-draft${attemptSuffix}.json`);
      await runLogged("python3", [path.join(path.dirname(SCRIPT), "qzone-draft.py")], draftLog, 420000, JSON.stringify({ date, publishAt: state.timeContext.publishAt, timeContext: state.timeContext, theme: state.theme, characterPlan: characterDraftContext(state.referencePlan), history: history() }));
      const draft = JSON.parse(fs.readFileSync(draftLog, "utf8"));
      assertTimeDraft(draft, state.timeContext);
      Object.assign(state, { caption: draft.caption, scene: draft.scene, draftModel: draft.model, status: "generating" }); save(state);
      event("generating-image", { date });
      await runLogged(IMAGE_SCRIPT, localImageArguments(state.referencePlan, timeBoundScene(draft.scene, state.timeContext)), imageLog, 3600000);
      const output = fs.readFileSync(imageLog, "utf8").match(/^image_output=(.+)$/m)?.[1]?.trim();
      if (!output || !fs.statSync(output).isFile()) throw new Error("No verified image output");
      const quality = readQualityReceipt(output);
      const retained = path.join(ROOT, "images", `${date}${path.extname(output) || ".png"}`);
      fs.copyFileSync(output, retained); fs.chmodSync(retained, 0o600);
      fs.copyFileSync(`${output}.quality.json`, `${retained}.quality.json`); fs.chmodSync(`${retained}.quality.json`, 0o600);
      Object.assign(state, { imagePath: retained, imageSha256: digest(retained), imageQualityPolicy: quality.policy_version, status: "verifying-time" }); save(state);
      event("verifying-publication-time", { date, period: state.timeContext.period });
      await runLogged("python3", [path.join(path.dirname(SCRIPT), "qzone-draft.py"), "--verify-image", retained], `${retained}.time.json`, 300000,
        JSON.stringify({ publishAt: state.timeContext.publishAt, caption: state.caption, scene: state.scene }));
      assertTimeReceipt(state, state.publishAt);
      state.imageVerified = true; state.timeVerification = { passed: true, period: state.timeContext.period }; state.status = "ready"; save(state);
      if (Date.now() >= Date.parse(`${date}T22:00:00+08:00`)) { state.status = "expired"; save(state); throw new Error("Image completed outside daily publication window"); }
      if (state.publishAt <= Date.now()) state.publishAt = alignedReschedule(state.timeContext);
      if (!state.publishAt) throw new Error("Publication-time period elapsed; regenerate content for a new random slot");
      ensurePublishJob(state);
      state.attemptHistory.at(-1).result = "ready"; save(state);
      event("ready", { date, publishAt: new Date(state.publishAt).toISOString() });
    } catch (error) {
      state.error = state.status === 'verifying-time' ? 'Publication-time visual verification failed' : error.message;
      state.attemptHistory.at(-1).result = "failed";
      await onPrepareFailure(state, imageLog);
      throw error;
    }
  });
}

async function ownPosts() { return (await getQzoneMsgList({ account: "default", num: 20 })).msglist || []; }
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function findPublished(state, getPosts = ownPosts) {
  const posts = await getPosts();
  const matches = posts.filter((post) => state.tid ? post.tid === state.tid :
    post.content === state.caption && (post.pic || []).length === 1 && Number(post.created_time) * 1000 >= state.publishStartedAt - 60000);
  if (matches.length !== 1) return null;
  return matches[0];
}

export async function verifyQzonePicture(post) {
  const picture = post.pic?.[0];
  let source = picture?.url1 || picture?.url2 || picture?.smallurl;
  if (!source) throw new Error("Readback image has no URL");
  if (source.startsWith("//")) source = `https:${source}`;
  const url = new URL(source);
  if (!["http:", "https:"].includes(url.protocol) || ![".qq.com", ".qpic.cn"].some((suffix) => url.hostname.endsWith(suffix))) throw new Error("Unexpected Qzone image host");
  const response = await fetch(url, { headers: { Referer: "https://user.qzone.qq.com/700000006" }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Readback image HTTP ${response.status}`);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (size < 262144) { const next = await reader.read(); if (next.done) break; chunks.push(next.value); size += next.value.length; }
  } finally { await reader.cancel(); }
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "json", "-i", "pipe:0"], { input: Buffer.concat(chunks.map((x) => Buffer.from(x))), timeout: 10000, maxBuffer: 65536, stdio: ["pipe", "pipe", "pipe"] }));
  const image = probe.streams?.[0];
  const expectedRatio = Number(picture.width) / Number(picture.height);
  const ratioMatches = !Number.isFinite(expectedRatio) || Math.abs(image?.width / image?.height / expectedRatio - 1) < 0.03;
  if (!["mjpeg", "png", "webp"].includes(image?.codec_name) || image.width < 200 || image.height < 200 || !ratioMatches) {
    throw new Error(`Readback image is invalid or a placeholder (decoded ${image?.codec_name} ${image?.width}x${image?.height}; expected ${picture.width}x${picture.height})`);
  }
  return { width: image.width, height: image.height, codec: image.codec_name };
}

export async function publishState(state, { persist = save, getPosts = ownPosts, upload = uploadQzoneImage, post = publishQzoneMsg, wait = pause, verifyImage = verifyQzonePicture, now = Date.now } = {}) {
  if (state.status === "published") return { skipped: true, tid: state.tid };
  if (["publishing", "uncertain"].includes(state.status)) {
    const found = await findPublished(state, getPosts);
    if (!found || found.content !== state.caption || (found.pic || []).length !== 1) throw new Error("Uncertain publication; refused to repost");
    state.readbackImage = await verifyImage(found);
    state.tid = found.tid; state.status = "published"; persist(state); return { reconciled: true, tid: state.tid };
  }
  if (state.status !== "ready" || !state.imageVerified || digest(state.imagePath) !== state.imageSha256) throw new Error("No intact verified draft");
  readQualityReceipt(state.imagePath);
  if (state.publishAt && !state.makeupRequestedAt) assertTimeReceipt(state, now());
  if (!state.uploadedImage) { state.uploadedImage = await upload({ account: "default", imagePath: state.imagePath }); persist(state); }
  if (state.publishAt && !state.makeupRequestedAt) assertTimeReceipt(state, now());
  // Persist BEFORE the external write. An interrupted/uncertain write must never be retried blindly.
  state.status = "publishing"; state.publishStartedAt = Date.now(); persist(state);
  try {
    const result = await post({ account: "default", content: state.caption, ugcRight: state.visibility, images: [state.uploadedImage] });
    const tid = result.tid || result.data?.tid;
    if (!tid) throw new Error("Publication returned no tid");
    state.tid = String(tid); persist(state);
    for (let attempt = 0; attempt < 4; attempt++) {
      const found = await findPublished(state, getPosts);
      if (found && found.content === state.caption && (found.pic || []).length === 1) {
        state.readbackMetadata = { tid: found.tid, textMatches: true, pictureCount: found.pic.length, width: found.pic[0].width, height: found.pic[0].height }; persist(state);
        try { state.readbackImage = await verifyImage(found); }
        catch (error) { if (attempt === 3) throw error; await wait(2000); continue; }
        state.status = "published"; state.publishedAt = new Date().toISOString(); persist(state);
        return { tid: state.tid, pictures: 1, verified: true };
      }
      await wait(2000);
    }
    throw new Error("Publication readback was not verified");
  } catch (error) { state.status = "uncertain"; state.error = error.message; persist(state); throw error; }
}

async function publish(date) {
  return locked(date, async () => {
    const state = readState(date);
    if (!state) throw new Error("Missing daily draft");
    if (state.status === "published") return event("already-published", { date, tid: state.tid });
    const now = Date.now();
    if (date !== chinaDate(now) || now < Date.parse(`${date}T08:00:00+08:00`) || now >= Date.parse(`${date}T22:00:00+08:00`)) {
      state.status = "expired"; save(state); return event("outside-window", { date });
    }
    if (now < state.publishAt) throw new Error("Scheduled publish time has not arrived");
    try { event("publication", { date, ...await publishState(state) }); }
    catch (error) {
      if (!state.publishStartedAt && !state.tid && /publication.time|Publication.time|prepared period/iu.test(error.message)) {
        state.status = 'failed'; state.error = 'Publication-time validation failed before posting'; save(state);
        await onPrepareFailure(state); throw error;
      }
      state.failureReason = describePreparationFailure("", "publish");
      await notifyDailyFailure(state, "publish", { persist: save });
      throw error;
    }
    if (state.status === "published" && state.publishJobId) {
      try { execFileSync(process.execPath, ["/root/.openclaw/onebot-onebot-custom/scripts/bind-scheduled.mjs", "remove", state.publishJobId], { stdio: "pipe", timeout: 15000 }); }
      catch { event('publication-cleanup-warning', { date, published: true }); }
    }
  });
}

export async function makeupState(state, imagePath, { persist = save, getPosts = ownPosts,
  publish = publishState, now = Date.now() } = {}) {
  if (!state || state.account !== 'default' || state.visibility !== 4) throw new Error('Missing authorized default-account daily draft');
  if (state.status === 'published') return { skipped: true, tid: state.tid };
  if (state.publishStartedAt || state.tid || ['publishing', 'uncertain'].includes(state.status)) {
    // Use the normal reconcile-only path; never erase uncertain publication.
    return publish(state, { persist, getPosts });
  }
  if (state.date !== chinaDate(now - 86400000)) throw new Error('Explicit makeup is limited to yesterday');
  if (!state.caption || !state.scene) throw new Error('Missing original caption or scene');
  // Recover a preexisting post if the local state was lost, instead of reposting.
  const matches = (await getPosts()).filter(item => item.content === state.caption);
  if (matches.length) throw new Error('Matching caption already exists; reconcile it before makeup');
  readQualityReceipt(imagePath);
  state.makeupRequestedAt ??= new Date(now).toISOString();
  if (state.error) { state.previousPreparationError = state.error; delete state.error; }
  Object.assign(state, { status: 'ready', imagePath, imageSha256: digest(imagePath), imageVerified: true,
    imageQualityPolicy: 'anatomy-v1', makeupForDate: state.date });
  persist(state);
  return publish(state, { persist, getPosts });
}

async function makeup(date, imagePath) {
  return locked(date, async () => {
    const state = readState(date);
    try {
      const result = await makeupState(state, imagePath);
      event('makeup-publication', { date, ...result });
      if (state.status === 'published' && state.publishJobId) {
        cron(['disable', state.publishJobId]);
        execFileSync(process.execPath, ['/root/.openclaw/onebot-onebot-custom/scripts/bind-scheduled.mjs', 'remove', state.publishJobId], { stdio: 'pipe', timeout: 15000 });
      }
    } catch (error) {
      if (state?.status === 'published') { event('publication-cleanup-warning', { date, published: true }); return; }
      if (state) {
        state.failureReason = '补发尚未完成，已保留记录，需先核对结果';
        await notifyDailyFailure(state, 'publish', { persist: save });
      }
      throw error;
    }
  });
}

async function e2e(imagePath, draftPath) {
  const draft = JSON.parse(fs.readFileSync(draftPath, "utf8"));
  const reportPath = path.join(ROOT, "e2e-result.json");
  const retained = path.join(ROOT, "images", `e2e-${chinaDate()}${path.extname(imagePath) || ".png"}`);
  readQualityReceipt(imagePath);
  if (path.resolve(imagePath) !== path.resolve(retained)) fs.copyFileSync(`${imagePath}.quality.json`, `${retained}.quality.json`);
  fs.copyFileSync(imagePath, retained); fs.chmodSync(retained, 0o600); imagePath = retained;
  const state = { version: 1, date: chinaDate(), account: "default", visibility: 4, status: "ready", caption: draft.caption, scene: draft.scene, draftModel: draft.model, imagePath, imageSha256: digest(imagePath), imageVerified: true };
  const persist = (value) => fs.writeFileSync(reportPath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  persist(state);
  let failure;
  try { event("e2e-published", await publishState(state, { persist })); }
  catch (error) { failure = error; }
  finally {
    if (!state.tid && state.publishStartedAt) {
      const found = await findPublished(state).catch(() => null);
      if (found) { state.tid = found.tid; persist(state); }
    }
    if (state.tid) {
      await deleteQzoneMsg({ account: "default", tid: state.tid });
      for (let attempt = 0; attempt < 4; attempt++) {
        if (!(await ownPosts()).some((post) => post.tid === state.tid)) {
          state.deleted = true; state.deletedAt = new Date().toISOString(); persist(state); event("e2e-deleted", { tid: state.tid }); break;
        }
        await pause(2000);
      }
      if (!state.deleted) throw new Error("Test post deletion not confirmed");
    }
  }
  if (failure) throw failure;
  if (!state.deleted) throw new Error("End-to-end test did not complete");
}

async function seed() {
  const date = chinaDate();
  return locked(date, async () => {
    if (readState(date)) throw new Error("Daily state already exists");
    const test = JSON.parse(fs.readFileSync(path.join(ROOT, "e2e-result.json"), "utf8"));
    if (test.status !== "published" || !test.deleted || test.date !== date) throw new Error("A successful deleted test from today is required");
    const state = { version: 1, date, account: "default", visibility: 4, status: "ready", publishAt: choosePublishAt(date, Date.now(), 10 * 60000), theme: "花茶与草莓甜点", caption: test.caption, scene: test.scene, draftModel: test.draftModel, imagePath: test.imagePath, imageSha256: test.imageSha256, imageVerified: true, createdAt: new Date().toISOString() };
    if (!state.publishAt) state.status = "expired";
    save(state); ensurePublishJob(state); event("seeded", { date, status: state.status, publishAt: state.publishAt ? new Date(state.publishAt).toISOString() : null });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const requestedCommand = argv[0] === "--locked" ? argv[1] : argv[0];
  if (requestedCommand !== "status") {
    // Both prepare and the dynamically scheduled publish job check the switch.
    // This prevents an already-created one-shot job publishing after disable.
    execFileSync(process.execPath, ["/root/.openclaw/bin/feature-check.mjs", "qzone", "publish", "default"], { stdio: "pipe", timeout: 10000 });
    if (["prepare", "prepare-retry", "makeup"].includes(requestedCommand))
      execFileSync(process.execPath, ["/root/.openclaw/bin/feature-check.mjs", "images", "reference", "default"], { stdio: "pipe", timeout: 10000 });
  }
  init();
  if (argv[0] !== "--locked") {
    const child = spawn("flock", ["-n", "-E", "75", path.join(ROOT, "automation.lock"), process.execPath, SCRIPT, "--locked", ...argv], { stdio: "inherit" });
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    if (code === 75) event("busy");
    else if (code !== 0) process.exitCode = code || 1;
    return;
  }
  const [command, ...args] = argv.slice(1);
  if (command === "prepare") await prepare();
  else if (command === "prepare-retry") await prepare(args[0], Number(args[1]));
  else if (command === "publish") await publish(args[0]);
  else if (command === "makeup") await makeup(args[0], args[1]);
  else if (command === "notify-failure") {
    const state = readState(args[0]);
    if (!state || (!['failed', 'retry_waiting', 'uncertain'].includes(state.status) && !(state.status === 'published' && state.previousPreparationError))) throw new Error('No daily failure to notify');
    await notifyDailyFailure(state, 'prepare', { persist: save });
    event('failure-notification', { date: state.date, state: Object.values(state.failureNotifications ?? {}).at(-1)?.state });
  }
  else if (command === "e2e") await e2e(args[0], args[1]);
  else if (command === "seed") await seed();
  else if (command === "status") { const state = readState(chinaDate()); event("status", state ? { date: state.date, status: state.status, publishAt: state.publishAt ? new Date(state.publishAt).toISOString() : null, tid: state.tid } : { status: "unplanned" }); }
  else throw new Error("Use prepare, prepare-retry <date> <attempt>, publish <date>, makeup <yesterday> <verified-image>, notify-failure <date>, e2e <image> <draft>, seed or status");
}
if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) main().catch((error) => { event("error", { error: error.message }); process.exitCode = 1; });
