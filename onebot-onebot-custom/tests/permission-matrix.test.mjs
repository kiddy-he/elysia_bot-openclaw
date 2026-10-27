import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { authorizeFeature, FEATURE_ACTIONS, BACKEND_FEATURES, outboundTargetAllowed, loadFeatureConfig } from '../src/src/feature-policy.js';
import { decideFeatureTool } from '../src/src/feature-tools.js';
const policy = loadFeatureConfig();
const allowed = (feature, action, context, config = policy) => authorizeFeature(config, feature, action, context).allowed;
const admin = '700000003', member = '188888888', visitor = '199999999';
test('complete configured identity/account/scope/mention/role-count permission matrix', t => {
    let cells = 0;
    for (const accountId of ['default', 'yuexia', 'unknown']) for (const scope of ['group', 'private'])
        for (const groupId of ['700000011', '700000008', '999999999']) for (const senderId of [admin, member, visitor])
            for (const explicit of [false, true]) for (const roleCount of [1, 2]) for (const internal of [false, true]) {
                const context = { accountId, scope, groupId, senderId, explicit, roleCount, internal, groupAdmin: true };
                const routeValid = ['default', 'yuexia'].includes(accountId) && (scope === 'private' || policy.accounts[accountId].groupIds.includes(groupId));
                const owner = senderId === admin, selected = scope === 'private' || (explicit && roleCount === 1);
                for (const [feature, actions] of Object.entries(FEATURE_ACTIONS)) for (const action of actions) {
                    const actual = allowed(feature, action, context); cells++;
                    if (!routeValid || !policy.features[feature].enabled || !policy.features[feature].actions[action].enabled) { assert.equal(actual, false); continue; }
                    if (internal) { assert.equal(actual, feature === 'conversation' && action === 'peer' && scope === 'group'); continue; }
                    if (feature === 'bilibili') { assert.equal(actual, owner && selected); continue; }
                    if (['xiaohongshu','x','github','v2ex','youtube','bilibili_video','reddit'].includes(feature)) { assert.equal(actual, true); continue; }
                    if (feature === 'reminders') { assert.equal(actual, true); continue; }
                    if (BACKEND_FEATURES.includes(feature)) { assert.equal(actual, owner && selected, `${feature}.${action} ${JSON.stringify(context)}`); continue; }
                    if (feature === 'quota') { assert.equal(actual, selected && (scope === 'group' || owner)); continue; }
                    if (feature === 'search') { assert.equal(actual, scope === 'group' || owner); continue; }
                    if (feature === 'images') { assert.equal(actual, action === 'generate' || scope === 'group' || owner); continue; }
                    if (feature === 'conversation') {
                        const expected = ['chat', 'media'].includes(action) ? true : action === 'peer' ? false : action === 'quote' ? scope === 'group' || owner
                            : action === 'mode' ? owner && selected : selected && (scope === 'private' || owner);
                        assert.equal(actual, expected, `${feature}.${action} ${JSON.stringify(context)}`);
                    }
                }
            }
    t.diagnostic(`${cells} action decisions checked across 432 trusted contexts`);
});
test('module/action revocation and account/group removal reject every action', t => {
    let cells = 0;
    const owner = { senderId: admin, accountId: 'default', scope: 'group', groupId: '700000011', explicit: true, roleCount: 1 };
    for (const [feature, actions] of Object.entries(FEATURE_ACTIONS)) for (const action of actions) {
        for (const change of [c => { c.features[feature].enabled = false; }, c => { c.features[feature].actions[action].enabled = false; },
            c => { c.groups['700000011'].enabled = false; }, c => { c.features[feature].accountIds = []; }, c => { c.features[feature].groupIds = []; }]) {
            const config = structuredClone(policy); change(config); assert.equal(allowed(feature, action, owner, config), false); cells++;
        }
    }
    for (const feature of BACKEND_FEATURES) {
        const config = structuredClone(policy); config.features[feature].enabled = false;
        assert.equal(decideFeatureTool(config, 'exec', { command: 'true' }, owner).allowed, false); cells++;
        assert.equal(decideFeatureTool(config, 'adsb_query', { query: 'health' }, owner).allowed, feature !== 'adsb'); cells++;
    }
    t.diagnostic(`${cells} revocation/bypass decisions checked`);
});
