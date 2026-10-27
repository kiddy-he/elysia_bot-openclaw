import sharp from 'sharp';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS } from '../domain/notes.js';
import { fail, checkAbort } from '../errors.js';
const execute = promisify(execFile);
export async function sha256(path) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); }
export async function validateImage(path, signal) {
  checkAbort(signal); const { size } = await stat(path); if (!size || size > MAX_IMAGE_BYTES) fail('image_size_limit');
  try {
    const image = sharp(path, { limitInputPixels: 16000000, failOn: 'warning', animated: true });
    const meta = await image.metadata();
    const pixels = meta.width * meta.height;
    if (!['jpeg', 'png', 'webp', 'gif', 'avif'].includes(meta.format) || !Number.isSafeInteger(pixels) || pixels <= 0 || pixels > 16000000) fail('invalid_image');
    // Force decoding rather than trusting headers. Animated height includes all pages.
    await image.stats(); checkAbort(signal);
    return { bytes: size, width: meta.width, height: meta.height, format: meta.format, mime_type: `image/${meta.format === 'jpeg' ? 'jpeg' : meta.format}` };
  } catch (e) { checkAbort(signal); fail(e.code === 'image_size_limit' ? e.code : 'invalid_image'); }
}
export async function validateVideo(path, signal) {
  const { size } = await stat(path); if (!size || size > MAX_VIDEO_BYTES) fail('video_size_limit'); checkAbort(signal);
  try {
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height', '-of', 'json', path], { timeout: 10000, maxBuffer: 65536, signal, env: { PATH: process.env.PATH } });
    const data = JSON.parse(stdout), video = data.streams?.filter(s => s.codec_type === 'video') ?? [], audio = data.streams?.filter(s => s.codec_type === 'audio') ?? [];
    const duration = Number(data.format?.duration), pixels = video[0]?.width * video[0]?.height;
    if (video.length !== 1 || video[0].codec_name !== 'h264' || audio.length > 1 || audio.some(a => !['aac', 'mp3'].includes(a.codec_name)) || !data.format?.format_name?.split(',').includes('mp4') || !Number.isFinite(duration) || duration <= 0 || duration > MAX_VIDEO_SECONDS || !Number.isSafeInteger(pixels) || pixels <= 0 || pixels > 8294400) fail('invalid_video');
    await execute('ffmpeg', ['-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe', '-i', path, '-frames:v', '1', '-an', '-f', 'null', '-'], { timeout: 10000, maxBuffer: 65536, signal, env: { PATH: process.env.PATH } }); checkAbort(signal);
    return { bytes: size, width: video[0].width, height: video[0].height, duration_seconds: duration, codec: 'h264', mime_type: 'video/mp4' };
  } catch { checkAbort(signal); fail('invalid_video'); }
}

export class TransferBudget {
  constructor(maxBytes = 256 * 1024 ** 2, maxRequests = 48) { this.maxBytes = maxBytes; this.maxRequests = maxRequests; this.bytes = 0; this.requests = 0; }
  request() { if (this.bytes >= this.maxBytes || this.requests >= this.maxRequests) fail('transfer_budget_exhausted'); this.requests++; }
  charge(bytes) { this.bytes += bytes; if (this.bytes > this.maxBytes) fail('transfer_budget_exhausted'); }
}
