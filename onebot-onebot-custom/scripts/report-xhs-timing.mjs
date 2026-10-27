// Read-only, sanitized report for opt-in isolated XHS live acceptance timing.
// No message text, media URLs, cookies, tokens, account IDs or receipt IDs emitted.
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const roots = process.argv.slice(2);
if (!roots.length) throw new Error('Usage: node scripts/report-xhs-timing.mjs <isolated live-* root> [...]');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const sum = values => values.reduce((a, b) => a + b, 0);
const config = readJson('/root/.openclaw/onebot-xhs.json');
const jobDb = new DatabaseSync(join(config.dataDir, 'state.db'), { readOnly: true });
try {
 const reports = roots.map(input => {
  const root = resolve(input);
  if (!root.startsWith('/root/.openclaw/state/xhs-integration-20261021/live-')) throw new Error('Isolated acceptance root required');
  const result = readJson(join(root, 'result.json'));
  const t = result.inboundAt;
  if (!Number.isFinite(t)) throw new Error('inboundAt is required');
  const relative = at => Number.isFinite(at) ? at - t : null;
  const events = readFileSync(join(root, 'timing.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s));
  const starts = new Map(events.filter(e => e.event === 'start').map(e => [e.id, e]));
  const spans = events.filter(e => e.event === 'end' && starts.has(e.id)).map(e => ({
   kind: e.kind, operation: e.operation, startMs: relative(starts.get(e.id).at),
   endMs: relative(e.at), durationMs: e.elapsedMs,
   ...(e.ok !== undefined ? { ok: e.ok } : {}), ...(e.status !== undefined ? { httpStatus: e.status } : {}),
  })).sort((a, b) => a.startMs - b.startMs);
  const logs = readFileSync(join(root, 'gateway.log'), 'utf8').split('\n');
  const logAt = phrase => {
   const line = logs.find(s => s.includes(phrase));
   return line ? relative(Date.parse(line.match(/^\S+/u)?.[0])) : null;
  };
  const intentAt = logAt('Turn intent model=');
  const failedIntentAt = logAt('Turn intent failed');
  const reviewAt = logAt('Text review decision');
  const finalAt = logAt('deliver(final)');
  const llm = spans.filter(e => e.kind === 'llm');
  // The test performs one primary agent turn, then text review, then outbound persona rewrite.
  const review = llm.filter(e => reviewAt !== null && e.endMs <= reviewAt).at(-1);
  const rewrite = llm.filter(e => finalAt !== null && e.startMs >= finalAt);
  const classifier = intentAt === null ? [] : llm.filter(e => e.endMs <= intentAt);
  const main = llm.filter(e => !classifier.includes(e) && e !== review && !rewrite.includes(e));
  const opDb = new DatabaseSync(join(root, 'state/business/operations.sqlite'), { readOnly: true });
  let operations;
  try {
   operations = opDb.prepare('SELECT kind,state,created,updated,result FROM operations ORDER BY created').all().map(row => {
    const value = JSON.parse(row.result ?? '{}');
    const xhs = value.xhs ?? {}, data = xhs.data ?? {};
    const resourceErrors = (data.resources ?? []).flatMap(v => v.error?.code ? [v.error.code] : []);
    const operation = { tool: row.kind, storeState: row.state, startMs: relative(row.created),
     endMs: relative(row.updated), durationMs: row.updated - row.created,
     ...(resourceErrors.length ? { resourceErrors } : {}), ...(xhs.error?.code ? { error: xhs.error.code } : {}) };
    if(row.kind==='xhs_media_workflow') {
     operation.workflow={elapsedMs:data.elapsed_ms,deliveryStatus:data.delivery_status,mediaCount:data.media_count,postCount:data.posts?.length,
      stages:Object.entries((data.timings??[]).reduce((groups,step)=>{const g=groups[step.operation]??={calls:0,elapsedMs:0};g.calls++;g.elapsedMs+=step.elapsedMs;return groups;},{})).map(([operation,metrics])=>({operation,...metrics})),
      backgroundJobs:(data.job_ids??[]).map(id=>{
       const job=jobDb.prepare('SELECT state,result FROM jobs WHERE id=?').get(id);
       const result=JSON.parse(job?.result??'{}'),artifacts=result.artifacts??[];
       return {state:job?.state,artifactCount:artifacts.length,bytes:sum(artifacts.map(a=>a.bytes??0)),failureCount:result.failures?.length??null,
        albumSizes:Object.values(artifacts.reduce((groups,a)=>{const id=a.post?.post_id??'unknown';groups[id]=(groups[id]??0)+1;return groups;},{}))};
      })};
    }
    if (row.kind === 'xhs_download_images' && data.job_id) {
     const job = jobDb.prepare('SELECT id,state,created,result FROM jobs WHERE id=?').get(data.job_id);
     const finish = jobDb.prepare("SELECT created FROM events WHERE job=? AND type='job_finished' ORDER BY created DESC LIMIT 1").get(data.job_id);
     const jobResult = JSON.parse(job?.result ?? '{}');
     const artifacts = jobResult.artifacts ?? [];
     operation.backgroundJob = { state: job?.state, startMs: relative(job?.created), endMs: relative(finish?.created),
      durationMs: job && finish ? finish.created - job.created : null,
      artifactCount: artifacts.length, bytes: sum(artifacts.map(a => a.bytes ?? 0)),
      imageCount: artifacts.filter(a => a.kind === 'image').length, failureCount: jobResult.failures?.length ?? null,
      albumSizes: Object.values(artifacts.reduce((groups, a) => {
       const id = a.post?.post_id ?? 'unknown'; groups[id] = (groups[id] ?? 0) + 1; return groups;
      }, {})) };
    }
    return operation;
   });
  } finally { opDb.close(); }
  const receipts = result.receipts.map(r => ({ action: r.action, ok: r.ok,
   startMs: relative(r.startedAt), endMs: relative(r.at), durationMs: r.durationMs,
   ...(r.nodeTypes ? { nodeCount: r.nodeTypes.length,
    imagesPerNode: r.nodeTypes.map(node => node.filter(type => type === 'image').length),
    eachNodeHasTitleText: r.nodeTypes.every(node => node[0] === 'text') } : {}),
   ...(r.types ? { segmentTypes: r.types } : {}) }));
  const media = receipts.find(r => r.action.includes('forward') && r.ok);
  const text = receipts.find(r => r.segmentTypes?.includes('text') && r.ok);
  const resourceErrors = operations.flatMap(op => op.resourceErrors ?? []);
  return {
   sample: basename(root), inboundAt: new Date(t).toISOString(), syntheticInbound: result.syntheticInbound,
   realLLM: result.realLLM, realXhs: result.realXhs, realQq: result.realQq,
   testHarnessFinished: result.finished,
   performance:result.performance,
   businessOutcome: media ? 'media_delivered' : [...resourceErrors,...operations.map(o=>o.error)].includes('challenge_required') ? 'challenge_required' : 'no_media_receipt',
   classification: { outcome: intentAt !== null ? 'succeeded' : failedIntentAt !== null ? 'failed' : 'not_observed',
    decisionAtMs: intentAt ?? failedIntentAt, networkDurationMs: sum(classifier.map(e => e.durationMs)) || null },
   llm: { mainRoundCount: main.length, mainNetworkDurationMs: sum(main.map(e => e.durationMs)),
    reviewNetworkDurationMs: review?.durationMs ?? null, rewriteNetworkDurationMs: sum(rewrite.map(e => e.durationMs)),
    spans: llm.map(e => ({ ...e, role: classifier.includes(e) ? 'classification' : e === review ? 'text_review' : rewrite.includes(e) ? 'persona_rewrite' : 'main' })) },
   operations, receipts,
   milestones: { reviewDecisionMs: reviewAt, finalDispatchMs: finalAt,
    firstMediaReceiptMs: media?.endMs ?? null, planningRoundsBeforeMedia: media ? main.filter(e=>e.startMs<media.endMs).length : null, finalTextReceiptMs: text?.endMs ?? null,
    mediaToTextMs: media && text ? text.endMs - media.endMs : null,
    finalDispatchToTextRequestMs: finalAt !== null && Number.isFinite(text?.startMs) ? text.startMs - finalAt : null },
   foregroundQueue: { observedCount: spans.filter(e => e.kind === 'xhs-queue').length,
    maxWaitMs: Math.max(0, ...spans.filter(e => e.kind === 'xhs-queue').map(e => e.durationMs)) },
  };
 });
 console.log(JSON.stringify({ version: 1, unit: 'milliseconds', reports }, null, 2));
} finally { jobDb.close(); }
