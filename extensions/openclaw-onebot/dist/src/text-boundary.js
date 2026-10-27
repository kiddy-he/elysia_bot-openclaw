import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';

/** Remove transport control bytes while preserving Chinese, emoji and layout. */
export function cleanConversationText(value) {
    return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, '');
}
export function cleanDisplayName(value, fallback = '') {
    return cleanConversationText(value).replace(/\s+/gu, ' ').trim().slice(0, 120) || String(fallback);
}

/** Only natural-language agent payloads are normalized. Commands, paths,
 * recipient/session ids and executable arguments retain their exact values. */
export function createAgentTextExec(run = promisify(execFile)) {
    return (file, args = [], options) => {
        const normalized = [...args];
        if (basename(file) === 'openclaw' && args[0] === 'agent') {
            const index = args.indexOf('--message');
            if (index >= 0 && typeof args[index + 1] === 'string') normalized[index + 1] = cleanConversationText(args[index + 1]);
        }
        return run(file, normalized, options);
    };
}
