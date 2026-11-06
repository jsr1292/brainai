/**
 * WebP: the RIFF chunks are walked up to the RIFF length and only the keep list survives. EXIF and XMP go, their VP8X
 * flags are cleared, and the RIFF size is rewritten; anything after the RIFF length is cut off.
 */
import { need, type Cleaned } from './clean.js';

const KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ICCP', 'ANIM', 'ANMF']);
const EXIF_FLAG = 0x08, XMP_FLAG = 0x04;

export function clean(b: Buffer): Cleaned {
  need(b.length >= 12);
  const end = 8 + b.readUInt32LE(4);
  need(end <= b.length && end >= 12);
  const kept: Buffer[] = [];
  let i = 12;
  let width = 0, height = 0, frames = 0;
  let image = false;
  while (i < end) {
    need(i + 8 <= end);
    const fourcc = b.subarray(i, i + 4).toString('latin1');
    const size = b.readUInt32LE(i + 4);
    need(size <= end - i - 8);
    const padded = size + (size & 1);
    const chunkEnd = Math.min(i + 8 + padded, end);
    const data = b.subarray(i + 8, i + 8 + size);
    if (KEEP.has(fourcc)) {
      const chunk = Buffer.from(b.subarray(i, chunkEnd));
      if (fourcc === 'VP8X') {
        need(size >= 10);
        chunk[8] = chunk[8]! & ~(EXIF_FLAG | XMP_FLAG);
        width = 1 + data.readUIntLE(4, 3);
        height = 1 + data.readUIntLE(7, 3);
      } else if (fourcc === 'VP8 ' && width === 0) {
        need(size >= 10 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a);
        width = data.readUInt16LE(6) & 0x3fff;
        height = data.readUInt16LE(8) & 0x3fff;
      } else if (fourcc === 'VP8L' && width === 0) {
        need(size >= 5 && data[0] === 0x2f);
        const bits = data.readUInt32LE(1);
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
      if (fourcc === 'ANMF') frames++;
      if (fourcc === 'VP8 ' || fourcc === 'VP8L' || fourcc === 'ANMF') image = true;
      kept.push(chunk);
    }
    i = chunkEnd;
  }
  need(image);
  const body = Buffer.concat(kept);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return { type: 'webp', bytes: Buffer.concat([head, body]), width, height, frames: Math.max(frames, 1) };
}
