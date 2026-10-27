import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const marker = '// OPENCLAW_LIVE_NOTICE_V1';
export function patchLiveNotify(source) {
    if (source.includes(marker)) return source;
    const replaceOnce = (before, after) => {
        if (source.split(before).length !== 2) throw new Error('Upstream live-notice patch anchor changed; refusing partial patch');
        source = source.replace(before, after);
    };
    replaceOnce('\t\tconst pushType = liveType === 1 ? 3 : liveType === 3 ? 9 : 0;\n\t\tawait this.broadcastWithMessageLayout({',
        `\t\tconst pushType = liveType === 1 ? 3 : liveType === 3 ? 9 : 0;
        ${marker}
        // Keep the original card renderer; send one composite with public room
        // metadata so OpenClaw can await copy generation before a single send.
        if (liveType === 1) {
            const segments = [];
            if (buffer) segments.push(this.contentBuilder.image(buffer, "image/jpeg"));
            segments.push(this.contentBuilder.text([notifyMsg, params.roomLink].filter(Boolean).join("\\n")));
            await this.push.broadcastToTargets(uid, this.contentBuilder.message(segments), pushType, {
                pushId: params.pushId,
                openclawLive: { kind: "live-start", uid: String(uid), roomId: String(liveRoomInfo.room_id),
                    upName: master.username, title: liveRoomInfo.title, areaName: liveRoomInfo.area_name,
                    startedAt: liveRoomInfo.live_time || "" }
            });
            return;
        }
\t\tawait this.broadcastWithMessageLayout({`);
    replaceOnce('\t\t\tconst payload = collapseSegments(segmentToPayload(content));\n\t\t\tawait push.broadcastToFeature(uid, liveTypeToFeature(type), payload, liveBroadcastOpts(type, o));',
        '\t\t\tconst payload = collapseSegments(segmentToPayload(content));\n\t\t\tif (o?.openclawLive) payload.openclawLive = o.openclawLive;\n\t\t\tawait push.broadcastToFeature(uid, liveTypeToFeature(type), payload, liveBroadcastOpts(type, o));');
    replaceOnce('\t\t\tpayload: serializePayload(payload),\n\t\t\tts:',
        '\t\t\tpayload: serializePayload(payload),\n\t\t\t...(payload.openclawLive ? { live: payload.openclawLive } : {}),\n\t\t\tts:');
    replaceOnce('\t\t\tconst timer = setTimeout(() => ctrl.abort(), timeoutMs);\n\t\t\ttry {\n\t\t\t\tconst req = buildWebhookRequest',
        '\t\t\tconst timer = setTimeout(() => ctrl.abort(), provider === "generic" && payload.openclawLive ? Math.max(timeoutMs, 180000) : timeoutMs);\n\t\t\ttry {\n\t\t\t\tconst req = buildWebhookRequest');
    return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    if (process.argv.length !== 4) throw new Error('Usage: node patch-live-notify.mjs INPUT_BUNDLE OUTPUT_BUNDLE');
    const input = await readFile(process.argv[2], 'utf8');
    const output = patchLiveNotify(input);
    const dir = dirname(resolve(process.argv[3]));
    await mkdir(dir, { recursive: true });
    await writeFile(process.argv[3], output);
    await writeFile(resolve(dir, 'live-notice-patch.json'), JSON.stringify({ version: 1, appliedAt: new Date().toISOString(),
        upstreamSha256: createHash('sha256').update(input).digest('hex'), patchedSha256: createHash('sha256').update(output).digest('hex') }, null, 2) + '\n');
    console.log('Prepared Bilibili live metadata/composite patch; original image renderer unchanged');
}
