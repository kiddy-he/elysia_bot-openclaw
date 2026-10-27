import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loadRoleRouting, groupRoleIds, groupRequireMention, selectGroupRoles, selectGroupReplyInstruction } from "../src/src/role-routing.js";

const routing = {
    groups: {
        "700000011": { roles: ["elysia", "yuexia"] },
        "700000008": { roles: ["elysia"], requireMention: true },
    },
    roles: {
        elysia: { agentId: "main", selfIds: ["700000006"], names: ["爱莉希雅", "爱莉"] },
        yuexia: { agentId: "onebot-yuexia", selfIds: ["700000005"], names: ["月下初拥", "月下"] },
    },
};

test("mention-only group ignores a message without an @", () => {
    const sel = selectGroupRoles({ routing, groupId: "700000008", atIds: [], text: "大家早上好" });
    assert.equal(sel.requireMention, true);
    assert.equal(sel.explicit, false);
    assert.deepEqual(sel.targets, []);
});

test("mention-only group ignores a bare role name without an @", () => {
    const sel = selectGroupRoles({ routing, groupId: "700000008", atIds: [], text: "爱莉不是说今天要下雨吗" });
    assert.equal(sel.explicit, false);
    assert.deepEqual(sel.targets, []);
});

test("mention-only group routes an @Elysia message to the elysia agent", () => {
    const sel = selectGroupRoles({ routing, groupId: "700000008", atIds: ["700000006"], text: "爱莉在吗" });
    assert.equal(sel.explicit, true);
    assert.deepEqual(sel.targets.map((role) => role.agentId), ["main"]);
});

test("mention-only group does not route @-ing an unrelated member", () => {
    const sel = selectGroupRoles({ routing, groupId: "700000008", atIds: ["123456789"], text: "叫一下别人" });
    assert.equal(sel.explicit, false);
    assert.deepEqual(sel.targets, []);
});

test("mention-only group routes @-ing a role by its account self id even without a name", () => {
    const sel = selectGroupRoles({
        routing,
        groupId: "700000008",
        atIds: ["700000006"],
        text: "在么",
        resolveRoleAgentId: (id) => (id === "700000006" ? "main" : ""),
    });
    assert.equal(sel.explicit, true);
    assert.deepEqual(sel.targets.map((role) => role.agentId), ["main"]);
});

test("default group keeps the existing behavior: no @ routes to all roles", () => {
    const sel = selectGroupRoles({ routing, groupId: "700000011", atIds: [], text: "随便聊聊" });
    assert.equal(sel.requireMention, false);
    assert.equal(sel.explicit, false);
    assert.deepEqual(sel.targets.map((role) => role.agentId), ["main", "onebot-yuexia"]);
});

test("the live routing file marks 700000008 as mention-only for elysia only", () => {
    const live = loadRoleRouting();
    assert.deepEqual(groupRoleIds(live, "700000008"), ["elysia"]);
    assert.equal(groupRequireMention(live, "700000008"), true);
    assert.deepEqual(groupRoleIds(live, "700000011"), ["elysia", "yuexia"]);
    assert.equal(groupRequireMention(live, "700000011"), false);
    assert.equal(groupRequireMention(live, "390467776"), false);
});

test("group reply instruction separates admins from regular members", () => {
    const guest = selectGroupReplyInstruction({ isGroup: true, peerFollowup: false, isGroupAdmin: false, senderName: "Ninja" });
    assert.match(guest, /不要称呼对方为“舰长”/);
    assert.match(guest, /昵称：Ninja/);
    const admin = selectGroupReplyInstruction({ isGroup: true, peerFollowup: false, isGroupAdmin: true, senderName: "ExampleAdmin" });
    assert.match(admin, /admin（舰长）/);
    assert.doesNotMatch(admin, /不要称呼对方为“舰长”/);
    assert.equal(selectGroupReplyInstruction({ isGroup: false, peerFollowup: false, isGroupAdmin: true }), "");
    assert.equal(selectGroupReplyInstruction({ isGroup: true, peerFollowup: true, isGroupAdmin: true }), "");
});

test('a named voice does not summon a second role when another role is explicitly @-mentioned', () => {
    for (const phrase of ['用爱莉的声线说一句：今天你也很可爱哦', '使用爱莉希雅的音色朗读：你好']) {
        const result = selectGroupRoles({ routing, groupId: '700000011', atIds: ['700000005'], text: phrase });
        assert.deepEqual(result.targets.map(role => role.agentId), ['onebot-yuexia']);
    }
});
test('direct role address remains effective alongside a voice selection', () => {
    const result = selectGroupRoles({ routing, groupId: '700000011', atIds: [], text: '月下，用爱莉的声线说一句你好' });
    assert.deepEqual(result.targets.map(role => role.agentId), ['onebot-yuexia']);
    const two = selectGroupRoles({ routing, groupId: '700000011', atIds: ['700000006', '700000005'], text: '用爱莉的声线朗读' });
    assert.equal(two.targets.length, 2);
});
