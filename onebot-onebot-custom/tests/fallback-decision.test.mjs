import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseTextFallbackDecision, parseTextReviewDecision } from "../src/src/fallback-decision.js";

test("strict fallback JSON keeps the existing behaviour", () => {
    const decision = parseTextFallbackDecision('{"judgement":"replaced","reason":"测试","output_text":"第一行\\n第二行"}');
    assert.deepEqual(decision, {
        judgement: "replaced",
        replaced: true,
        reason: "测试",
        outputText: "第一行\n第二行",
        recovered: false,
    });
});

test("missing closing quote and brace are repaired", () => {
    const text = '{"judgement":"replaced","reason":"测试","output_text":"第一行\n第二行';
    const decision = parseTextFallbackDecision(text);
    assert.equal(decision.judgement, "replaced");
    assert.equal(decision.outputText, "第一行\n第二行");
    assert.equal(decision.recovered, true);
});

test("raw newlines inside a closed string are repaired", () => {
    const text = '{"judgement":"replaced","reason":"测试","output_text":"第一行\n第二行"}';
    const decision = parseTextFallbackDecision(text);
    assert.equal(decision.judgement, "replaced");
    assert.equal(decision.outputText, "第一行\n第二行");
    assert.equal(decision.recovered, true);
});

test("a string truncated in the middle still yields its visible prefix", () => {
    const text = '{"judgement":"replaced","reason":"测试","output_text":"这是一段被截断的回';
    const decision = parseTextFallbackDecision(text);
    assert.equal(decision.judgement, "replaced");
    assert.equal(decision.outputText, "这是一段被截断的回");
    assert.equal(decision.recovered, true);
});

test("unescaped ASCII quotes inside output_text do not cut the reply", () => {
    const text = '{"judgement":"replaced","reason":"测试","output_text":"她说："你好", 然后笑了';
    const decision = parseTextFallbackDecision(text);
    assert.equal(decision.judgement, "replaced");
    assert.equal(decision.outputText, '她说："你好", 然后笑了');
});

test("code fences and trailing prose after the object are ignored", () => {
    const text = '```json\n{"judgement":"replaced","reason":"测试","output_text":"你好"}\n```\n补充说明';
    const decision = parseTextFallbackDecision(text);
    assert.equal(decision.judgement, "replaced");
    assert.equal(decision.outputText, "你好");
});

test("escaped quotes, newlines and backslashes are decoded", () => {
    const text = '{"judgement":"replaced","reason":"测试","output_text":"她说：\\"你好\\"\\n第二行\\\\结尾"}';
    const decision = parseTextFallbackDecision(text);
    assert.equal(decision.outputText, '她说："你好"\n第二行\\结尾');
});

test("blocked decisions may omit output_text", () => {
    const decision = parseTextFallbackDecision('{"judgement":"blocked","reason":"测试"}');
    assert.equal(decision.judgement, "blocked");
    assert.equal(decision.outputText, "");
    assert.equal(decision.recovered, false);
});

test("clean and replaced decisions still require output_text", () => {
    assert.equal(parseTextFallbackDecision('{"judgement":"clean","reason":"测试"}'), null);
    assert.equal(parseTextFallbackDecision('{"judgement":"replaced","reason":"测试"}'), null);
});

test("invalid or missing judgements are rejected", () => {
    assert.equal(parseTextFallbackDecision('{"judgement":"maybe","output_text":"你好"}'), null);
    assert.equal(parseTextFallbackDecision('没有 JSON'), null);
    assert.equal(parseTextFallbackDecision(""), null);
});

test("trailing commas are tolerated", () => {
    const decision = parseTextFallbackDecision('{"judgement":"replaced","reason":"测试","output_text":"你好",}');
    assert.equal(decision.judgement, "replaced");
    assert.equal(decision.outputText, "你好");
    assert.equal(decision.recovered, true);
});

test("output_text is capped and reasons are bounded", () => {
    const text = `{"judgement":"replaced","reason":"${"原".repeat(400)}","output_text":"${"文".repeat(13000)}"}`;
    const decision = parseTextFallbackDecision(text);
    assert.equal(decision.reason.length, 300);
    assert.equal(decision.outputText.length, 12000);
});

test("review decisions recover from incomplete JSON but still fail closed without a judgement", () => {
    const recovered = parseTextReviewDecision('{"judgement":"reject","reason":"测试');
    assert.equal(recovered.judgement, "reject");
    assert.equal(recovered.reason, "测试");
    assert.equal(recovered.recovered, true);
    assert.equal(parseTextReviewDecision('{"reason":"测试"}'), null);
    assert.deepEqual(parseTextReviewDecision('{"judgement":"clean"'), { judgement: "clean", reason: "", recovered: true });
});
