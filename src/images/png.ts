/**
 * PNG (and APNG): chunks are walked from IHDR to IEND, each kept chunk's CRC is checked, and only the keep list
 * survives. Text chunks, Exif, private chunks and anything after IEND (a web page, a ZIP, padding) go.
 */
import { crc32 } from 'node:zlib';
import { need, type Cleaned } from './clean.js';

const KEEP = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sRGB', 'sBIT', 'pHYs', 'acTL', 'fcTL', 'fdAT']);

export function clean(b: Buffer): Cleaned {
  const kept: Buffer[] = [b.subarray(0, 8)];
  let i = 8;
  let width = 0, height = 0, frames = 1;
  let first = true;
  for (;;) {
    need(i + 12 <= b.length);
    const len = b.readUInt32BE(i);
    need(len <= b.length - i - 12);
    const type = b.subarray(i + 4, i + 8).toString('latin1');
    need(/^[A-Za-z]{4}$/.test(type));
    const end = i + 12 + len;
    if (first) { need(type === 'IHDR' && len === 13); first = false; }
    if (KEEP.has(type)) {
      need(b.readUInt32BE(i + 8 + len) === crc32(b.subarray(i + 4, i + 8 + len)) >>> 0);
      if (type === 'IHDR') { width = b.readUInt32BE(i + 8); height = b.readUInt32BE(i + 12); }
      if (type === 'acTL') { need(len === 8); frames = b.readUInt32BE(i + 8); }
      kept.push(b.subarray(i, end));
    }
    i = end;
    if (type === 'IEND') break;
  }
  return { type: 'png', bytes: Buffer.concat(kept), width, height, frames: Math.max(frames, 1) };
}
