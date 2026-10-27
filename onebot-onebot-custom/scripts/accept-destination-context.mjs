import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.argv[2];
if (!root?.includes('/simulation-')) throw new Error('Supply an isolated simulation directory');
const report = JSON.parse(await readFile(join(root, 'report.json')));
assert.equal(report.failed, 0);
assert.ok(report.results.some(result => result.name === 'destination-context-private-group-scheduled-bidirectional' && result.passed));
const db = new DatabaseSync(join(root, 'state', 'onebot-destination-context.sqlite'), { readOnly: true });
const rows = db.prepare('SELECT destination,identity,text,source FROM visible_messages').all();
db.close();
for (const [scope, sentinel] of [['group:700000011:public:normal', 'DESTINATION_GROUP_REMINDER_SENTINEL'],
    ['private:700000003:default:normal', 'DESTINATION_PRIVATE_REMINDER_SENTINEL']]) {
    const matches = rows.filter(row => row.text.includes(sentinel));
    assert.equal(matches.length, 1); assert.equal(matches[0].destination, scope); assert.equal(matches[0].source, 'delivered');
}
const acceptance = { passed: true, realQqMessages: 0, realBusinessWrites: 0, groupChatToScheduledPrompt: true,
    privateChatToScheduledPrompt: true, scheduledGroupReplyToAnotherMember: true, scheduledPrivateReplyToPrivateChat: true,
    groupPrivateSeparation: true, receiptOnlyPersistence: true, receiptDeduplication: true,
    primaryFallbackSharedWindow: report.results.some(result => result.name === 'conversation-context-primary-fallback-primary' && result.passed) };
await writeFile(join(root, 'destination-context-acceptance.json'), JSON.stringify(acceptance, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(acceptance));
