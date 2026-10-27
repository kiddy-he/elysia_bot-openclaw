import { strict as assert } from "node:assert";
import { test } from "node:test";
import { GROUP_GUEST_QUOTA_SCRIPT, resolveGroupQuotaAction, formatGroupGuestQuotaResult, runGroupGuestQuotaAction, prepareQuotaPersonaReply, validateQuotaPersonaReply } from "../src/src/group-guest-quota.js";

const guest = { isGroup: true, isGroupAdmin: false, peerFollowup: false, explicit: true, roleCount: 1, roleNames: ["爱莉希雅", "爱莉", "月下初拥", "月下"] };
const quota = `\n== Quota ==\naccount_count=1\naccount_1 forbidden=false disabled=false subscription_tier=PRO model_count=2\naccount_1 model=gemini-3.8-flash-high remaining=75% reset=2026-10-14T00:00:00Z\naccount_1 model=gemini-3.5-flash-lite remaining=100% reset=unknown\naccount_1 model=gemini-3.1-flash-image remaining=0% reset=unknown\naccount_1 model=claude-opus-5-5-low remaining=100% reset=unknown\naccount_1 quota_group=Gemini Models bucket=gemini-5h remaining=75% reset=2026-10-14T00:00:00Z\naccount_1 quota_group=Gemini Models bucket=gemini-weekly remaining=0.13% reset=2026-10-20T00:00:00Z\naccount_1 quota_group=Claude and GPT models bucket=3p-5h remaining=100% reset=unknown\naccount_1 quota_group=Claude and GPT models bucket=3p-weekly remaining=99.5% reset=2026-10-21T00:00:00Z\n`;
const refreshed = `refresh_http=200\nrefresh_total=1\nrefresh_success=1\nrefresh_failed=0\n${quota}`;

test('extended fixed quota run keeps the fixed command and accepts task cancellation', async () => {
    const controller = new AbortController(); let executions = 0;
    const value = await runGroupGuestQuotaAction('refresh', async (file, args, options) => {
        executions++; assert.equal(file, GROUP_GUEST_QUOTA_SCRIPT); assert.deepEqual(args, ['refresh']);
        assert.equal(options.timeout, 901000); assert.equal(options.signal, controller.signal);
        return { stdout: refreshed };
    }, { timeoutMs: 901000, signal: controller.signal });
    assert.equal(executions, 1); assert.match(value, /额度已刷新/u);
});

test("only the inbound model enum selects a fixed quota action, regardless of wording", () => {
    for (const [quotaAction, expected] of [['query', 'quota'], ['refresh', 'refresh']]) {
        for (const text of ['刷新agy额度并检查还剩多少', '/agy quota', '那更新后呢', 'anything'])
            assert.equal(resolveGroupQuotaAction({ ...guest, text, intent: { quotaAction } }), expected);
    }
    for (const quotaAction of ['none', 'unknown', undefined, 'quota', 'refresh; id', true])
        assert.equal(resolveGroupQuotaAction({ ...guest, text: '/agy refresh', intent: { quotaAction } }), null);
    assert.equal(resolveGroupQuotaAction({ ...guest, text: '刷新agy额度' }), null);
});

test("trusted routing still requires an explicitly selected single group role for both members and admins", () => {
    const intent = { quotaAction: 'refresh' };
    for (const changes of [{ isGroup: false }, { peerFollowup: true }, { explicit: false }, { roleCount: 0 }, { roleCount: 2 }])
        assert.equal(resolveGroupQuotaAction({ ...guest, intent, ...changes }), null);
    assert.equal(resolveGroupQuotaAction({ ...guest, isGroupAdmin: true, intent }), 'refresh');
});

test("independent business tasks and quoted literal speech do not get swallowed by the quota handler", () => {
    for (const conflict of [{ imageGeneration: true }, { xiaohongshuOperation: true }, { speechMode: 'literal' },
        ...['create', 'list', 'cancel'].map(reminderAction => ({ reminderAction }))])
        assert.equal(resolveGroupQuotaAction({ ...guest, intent: { quotaAction: 'refresh', ...conflict } }), null);
});

test("only quota fields reach the group, with Beijing reset times", () => {
    const reply = formatGroupGuestQuotaResult("quota", `${quota}\napi_key=secret\nemail=private@example.com\nrefresh_error=raw upstream secret\naccount_1 model=secret@example.com remaining=10% reset=unknown\n`);
    assert.match(reply, /gemini-3.8-flash-high：\n5小时配额：剩余 75%/);
    assert.match(reply, /周配额：剩余 0\.13%/);
    assert.match(reply, /claude-opus-5-5-low：\n5小时配额：剩余 100%/);
    assert.doesNotMatch(reply, /gemini-3.5-flash-lite/);
    assert.match(reply, /10\/14 08:00（北京时间）/);
    assert.match(reply, /缓存数据/);
    assert.doesNotMatch(reply, /secret|@|PRO|api_key|refresh_error/);
    assert.equal(formatGroupGuestQuotaResult("quota", "account_1 model=gemini remaining=101% reset=unknown"), "这次没能查到可用的模型额度明细，请稍后再试。");
});

test("refresh success, partial refresh, empty quota and stale cache are distinguished", () => {
    assert.match(formatGroupGuestQuotaResult("refresh", refreshed), /额度已刷新/);
    assert.match(formatGroupGuestQuotaResult("refresh", refreshed.replace("refresh_total=1", "refresh_total=2").replace("refresh_failed=0", "refresh_failed=1")), /失败 1 项.*缓存/);
    assert.doesNotMatch(formatGroupGuestQuotaResult("refresh", quota), /额度已刷新/);
    assert.doesNotMatch(formatGroupGuestQuotaResult("refresh", refreshed.replace("refresh_http=200", "refresh_http=500")), /75%|额度已刷新/);
    assert.match(formatGroupGuestQuotaResult("quota", "account_count=0"), /没能查到/);
});

test("execution passes only the fixed path and subcommand, without shell or user args", async () => {
    for (const action of ["quota", "refresh"]) {
        let calls = 0;
        const reply = await runGroupGuestQuotaAction(action, async (file, args, options) => {
            calls += 1;
            assert.equal(file, GROUP_GUEST_QUOTA_SCRIPT);
            assert.deepEqual(args, [action]);
            assert.equal(options.shell, undefined);
            assert.ok(options.timeout > 0);
            return { stdout: action === "refresh" ? refreshed : quota };
        });
        assert.equal(calls, 1);
        assert.match(reply, /75%/);
    }
    await assert.rejects(runGroupGuestQuotaAction("credentials", async () => assert.fail("must not execute")), /Unsupported/);
});

test("timeouts and script errors never leak output or trigger an automatic retry", async () => {
    let calls = 0;
    const reply = await runGroupGuestQuotaAction("refresh", async () => {
        calls += 1;
        throw Object.assign(new Error("token=secret private account"), { stdout: refreshed, stderr: "credentials" });
    });
    assert.equal(calls, 1);
    assert.match(reply, /未能完成/);
    assert.doesNotMatch(reply, /secret|credentials|75%|已刷新/);
});

test('window buckets are never replaced by model-level aggregates and missing windows stay unknown', () => {
    const onlyModels = quota.split('\n').filter(line => !line.includes('quota_group=')).join('\n');
    const reply = formatGroupGuestQuotaResult('quota', onlyModels);
    assert.equal((reply.match(/未知（上游未返回）/gu) ?? []).length, 6);
    assert.doesNotMatch(reply, /剩余 \d/u);
    const missing = formatGroupGuestQuotaResult('quota', quota.replace('account_1 model=claude-opus-5-5-low remaining=100% reset=unknown', ''));
    assert.match(missing, /claude-opus-5-5-low（上游未返回该模型明细）/u);
    assert.doesNotMatch(missing, /5小时配额：剩余 100%/u);
});

test('account window buckets remain isolated and unusable accounts are labelled', () => {
    const reply = formatGroupGuestQuotaResult('quota', quota + quota.replaceAll('account_1', 'account_2').replace('disabled=false', 'disabled=true').replaceAll('remaining=75%', 'remaining=12%'));
    assert.match(reply, /账户1[\s\S]*5小时配额：剩余 75%[\s\S]*账户2（账户不可用）[\s\S]*5小时配额：剩余 12%/u);
});


test('the complete response is generated by the model without appended host facts', async () => {
    const facts = formatGroupGuestQuotaResult('quota', quota);
    const candidate = facts.replace('我查到的剩余额度如下（缓存数据）：', '我帮你看了缓存里的额度，来看看吧♪').replaceAll('：剩余', '还剩');
    let calls = 0;
    const reply = await prepareQuotaPersonaReply(facts, { rewrite: async draft => { calls++; assert.equal(draft, facts); return candidate; } });
    assert.equal(calls, 1); assert.equal(reply, candidate);
});

test('wrong values, extra models, lost state and wrong window order cause regeneration', async () => {
    const facts = formatGroupGuestQuotaResult('quota', quota);
    for (const wrong of [facts.replace('75%', '74%'), facts.replace('0.13%', '13%'), facts.replace('缓存数据', '最新数据'), facts.replace('5小时配额', '周配额'), facts + '\ngemini-3.5-flash-lite：100%', facts.replace('10/14 08:00', '10/14 09:00')]) {
        assert.equal(validateQuotaPersonaReply(facts, wrong), false);
        let calls=0;
        const reply=await prepareQuotaPersonaReply(facts,{rewrite:async()=>++calls===1?wrong:facts.replace('我查到', '我帮你查到')});
        assert.equal(calls,2);assert.equal(reply,facts.replace('我查到','我帮你查到'));
    }
});

test('all-invalid summaries yield only a complete model-generated failure notice', async () => {
    const facts = formatGroupGuestQuotaResult('quota', quota); const notice='这次的额度总结没能整理好，暂时无法给你可靠的结果。'; let calls=0;
    const reply=await prepareQuotaPersonaReply(facts,{rewrite:async(text,attempt)=>{calls++;return attempt===2?notice:'剩余100%';}});
    assert.equal(calls,3);assert.equal(reply,notice);assert.doesNotMatch(reply,/gemini|100%/u);
    await assert.rejects(prepareQuotaPersonaReply(facts,{rewrite:async()=>{throw Error('unavailable');}}));
    const controller=new AbortController();controller.abort();
    await assert.rejects(prepareQuotaPersonaReply(facts,{signal:controller.signal,rewrite:async()=>assert.fail('cancelled request must not generate')}));
});

test('facts cannot move from one quota window to another', () => {
    const facts=formatGroupGuestQuotaResult('quota',quota);
    const swapped=facts.replace('5小时配额：剩余 75%，重置 10/14 08:00（北京时间）\n周配额：剩余 0.13%，重置 10/20 08:00（北京时间）', '5小时配额：剩余 0.13%，重置 10/20 08:00（北京时间）\n周配额：剩余 75%，重置 10/14 08:00（北京时间）');
    assert.equal(validateQuotaPersonaReply(facts,swapped),false);
    assert.equal(validateQuotaPersonaReply(facts,facts),true);
});

test('natural closing references to quota windows do not reject intact facts',()=>{
    const facts=formatGroupGuestQuotaResult('quota',quota);
    assert.equal(validateQuotaPersonaReply(facts,facts+'\nGemini的周配额见底了，5小时配额也要留意哦。'),true);
    assert.equal(validateQuotaPersonaReply(facts,facts+'\n周配额还剩99%。'),false);
    assert.equal(validateQuotaPersonaReply(facts,facts+'\n周配额重置10/30 18:00。'),false);
});
