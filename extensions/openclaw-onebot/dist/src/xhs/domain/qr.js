import qrcode from 'qrcode-generator';
import sharp from 'sharp';
import { fail } from '../errors.js';
export async function loginQrPng(value) {
  let url;
  try { url = new URL(value); } catch { fail('login_qr_invalid'); }
  if (typeof value !== 'string' || value.length > 4096 || url.protocol !== 'https:' || url.hostname !== 'www.xiaohongshu.com' || url.pathname !== '/mobile/login') fail('login_qr_invalid');
  const code = qrcode(0, 'M'); code.addData(value, 'Byte'); code.make();
  const count = code.getModuleCount(), side = count + 8, pixels = Buffer.alloc(side * side, 255);
  for (let y = 0; y < count; y++) for (let x = 0; x < count; x++) if (code.isDark(y, x)) pixels[(y + 4) * side + x + 4] = 0;
  return sharp(pixels, { raw: { width: side, height: side, channels: 1 } }).resize(side * 6, side * 6, { kernel: 'nearest' }).png().toBuffer();
}
