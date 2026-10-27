import { segmentsOf } from './quoted-message.js';

function fileIdentity(segment) {
    const data = segment.data ?? {};
    const id = String(data.file_id ?? '').trim();
    const name = String(data.name ?? data.file ?? '');
    const size = String(data.file_size ?? data.size ?? '');
    return id && id.length <= 2048 && name && /^\d+$/u.test(size) ? { id, name, size } : null;
}

/** QQ file download acknowledgements can masquerade as incoming friend messages.
 * Only suppress empty attachment stubs proven to refer to our own earlier file
 * in this peer's private history. Never classify by filename or human prose.
 */
export async function isPrivateFileReceipt(account, event, { fetchImpl = fetch, log } = {}) {
    if (event.post_type !== 'message' || event.message_type !== 'private' || event.group_id != null
        || !/^\d+$/u.test(String(event.user_id ?? '')) || !/^\d+$/u.test(String(event.self_id ?? ''))
        || String(event.user_id) === String(event.self_id) || !account.httpUrl)
        return false;
    const segments = segmentsOf(event.message ?? event.raw_message);
    const files = segments.filter(segment => segment.type === 'file');
    if (!files.length || files.length > 8 || segments.some(segment => segment.type !== 'file'
        && (segment.type !== 'text' || String(segment.data.text ?? '').trim())))
        return false;
    if (files.some(segment => String(segment.data.url ?? '').trim() || String(segment.data.path ?? '').trim()))
        return false;
    const identities = files.map(fileIdentity);
    const eventTime = Number(event.time);
    if (identities.some(value => !value) || !Number.isFinite(eventTime) || eventTime <= 0)
        return false;
    try {
        const response = await fetchImpl(`${account.httpUrl}/get_friend_msg_history`, {
            method: 'POST', headers: { 'Content-Type': 'application/json',
                ...(account.accessToken ? { Authorization: `Bearer ${account.accessToken}` } : {}) },
            body: JSON.stringify({ user_id: Number(event.user_id), count: 100 }),
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return false;
        const result = await response.json();
        if (result.retcode !== 0 || !Array.isArray(result.data?.messages)) return false;
        const sentFiles = [];
        for (const message of result.data.messages.slice(0, 100)) {
            if (message.message_type !== 'private' || message.group_id != null
                || String(message.sender?.user_id ?? message.user_id) !== String(event.self_id)
                || (message.self_id != null && String(message.self_id) !== String(event.self_id))
                || (message.target_id != null && String(message.target_id) !== String(event.user_id))
                || (message.peer_id != null && String(message.peer_id) !== String(event.user_id))
                || String(message.message_id) === String(event.message_id)
                || !Number.isFinite(Number(message.time)) || Number(message.time) <= 0 || Number(message.time) > eventTime)
                continue;
            for (const segment of segmentsOf(message.message ?? message.raw_message)) {
                if (segment.type === 'file') {
                    const identity = fileIdentity(segment);
                    if (identity) sentFiles.push(identity);
                }
            }
        }
        return identities.every(file => sentFiles.some(sent => sent.id === file.id && sent.name === file.name && sent.size === file.size));
    } catch {
        // A failed lookup cannot establish that an attachment is a receipt.
        log?.debug?.(`[onebot:${account.accountId ?? 'default'}] Private file receipt lookup unavailable`);
        return false;
    }
}
