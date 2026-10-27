import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateFileReceipt } from '../src/src/private-file-receipt.js';

const account = { httpUrl: 'http://127.0.0.1:3002', accessToken: 'synthetic-token' };
const file = (overrides = {}) => ({ type: 'file', data: { file: 'test.wav', file_id: 'exact-file-id', file_size: '1234', url: '', path: '', ...overrides } });
const incoming = (overrides = {}) => ({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 222, user_id: 111, message_id: 2, time: 200, message: [file()], ...overrides });
const sent = (overrides = {}) => ({ message_type: 'private', self_id: 222, user_id: 222, sender: { user_id: 222 }, message_id: 1, time: 100, message: [file()], ...overrides });
const response = messages => ({ ok: true, json: async () => ({ retcode: 0, data: { messages } }) });
const detect = (event = incoming(), messages = [sent()]) => isPrivateFileReceipt(account, event, { fetchImpl: async () => response(messages) });

test('exact earlier self-sent private file stubs are receipts, including CQ strings', async () => {
    for (const message of [[file()], '[CQ:file,file=test.wav,file_id=exact-file-id,file_size=1234,url=,path=]']) {
        assert.equal(await isPrivateFileReceipt(account, incoming({ message }), { fetchImpl: async (url, request) => {
            assert.equal(url, account.httpUrl + '/get_friend_msg_history');
            assert.deepEqual(JSON.parse(request.body), { user_id: 111, count: 100 });
            assert.equal(request.headers.Authorization, 'Bearer synthetic-token');
            assert.ok(request.signal); return response([sent()]);
        } }), true);
    }
});
test('genuine uploads, accompanying text, quotes, media, groups and notices do not perform lookups', async () => {
    const events = [incoming({ message: [file({ url: 'https://example.invalid/audio' })] }), incoming({ message: [file({ path: '/tmp/audio.wav' })] }),
        incoming({ message: [file(), { type: 'text', data: { text: '分析这个文件' } }] }), incoming({ message: [file(), { type: 'reply', data: { id: 1 } }] }),
        incoming({ message: [file(), { type: 'record', data: { file: 'voice' } }] }), incoming({ message: [file({ file_id: '' })] }),
        incoming({ message_type: 'group', group_id: 333 }), incoming({ post_type: 'notice' }), incoming({ user_id: 222 }),
        incoming({ self_id: undefined }), incoming({ time: undefined }), incoming({ message: [{ type: 'text', data: { text: '对方已接收文件' } }] })];
    for (const event of events) assert.equal(await isPrivateFileReceipt(account, event, { fetchImpl: () => assert.fail('not a receipt candidate') }), false);
});
test('filename matches, another file id, another size and files without history are preserved', async () => {
    for (const messages of [[], [sent({ message: [file({ file_id: 'different' })] })], [sent({ message: [file({ file_size: '99' })] })], [sent({ message: [file({ file: 'different.wav' })] })]])
        assert.equal(await detect(incoming(), messages), false);
});
test('another sender, account, peer, group, future message or current event cannot prove an outgoing file', async () => {
    for (const overrides of [{ sender: { user_id: 111 }, user_id: 111 }, { self_id: 333 }, { target_id: 333 }, { peer_id: 333 },
        { message_type: 'group', group_id: 333 }, { group_id: 333 }, { time: 201 }, { time: undefined }, { message_id: 2 }])
        assert.equal(await detect(incoming(), [sent(overrides)]), false);
});
test('all files must match and whitespace does not turn a receipt into a conversation', async () => {
    assert.equal(await detect(incoming({ message: [file(), { type: 'text', data: { text: ' \n' } }] })), true);
    assert.equal(await detect(incoming({ message: [file(), file({ file_id: 'new-upload' })] })), false);
});
test('HTTP, API, malformed and network failures preserve the message without leaking raw errors', async () => {
    for (const fetchImpl of [async () => ({ ok: false }), async () => ({ ok: true, json: async () => ({ retcode: 1 }) }),
        async () => ({ ok: true, json: async () => ({ retcode: 0, data: { messages: {} } }) }), async () => { throw new Error('secret-token-and-content'); }]) {
        const logs = [];
        assert.equal(await isPrivateFileReceipt(account, incoming(), { fetchImpl, log: { debug: line => logs.push(line) } }), false);
        assert.doesNotMatch(logs.join('\n'), /secret-token-and-content/u);
    }
});
