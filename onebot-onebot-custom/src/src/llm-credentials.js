import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';

export async function resolveProviderCredential(config, provider) {
    const ref = provider.apiKey;
    if (typeof ref === 'string') return ref.trim();
    if (ref?.source === 'env') return process.env[ref.id]?.trim();
    const source = config.secrets?.providers?.[ref?.provider];
    if (ref?.source === 'file' && source?.mode === 'singleValue') return (await readFile(source.path, 'utf8')).trim();
    if (ref?.source === 'exec' && source?.command) return new Promise((resolve, reject) => {
        const child = execFile(source.command, source.args ?? [], { timeout: 10000, maxBuffer: 65536 }, (err, stdout) => {
            if (err) return reject(new Error('credential unavailable'));
            try { resolve(JSON.parse(stdout).values?.[ref.id]); } catch { reject(new Error('credential unavailable')); }
        });
        child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ protocolVersion: 1, ids: [ref.id] }));
    });
    throw new Error('credential unavailable');
}
