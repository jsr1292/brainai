/**
 * GIF: blocks are walked to the trailer and only image data, graphic control extensions and the looping
 * (NETSCAPE2.0) block survive. Comments, plain-text and other application extensions go; anything after the trailer is
 * cut off.
 */
import { need, type Cleaned } from './clean.js';

/** Where the data sub-blocks starting at `i` end (after their zero terminator). */
function subBlocks(b: Buffer, i: number): number {
  for (;;) {
    need(i < b.length);
    const n = b[i]!;
    i += 1 + n;
    if (n === 0) return i;
  }
}

export function clean(b: Buffer): Cleaned {
  need(b.length >= 13);
  const width = b.readUInt16LE(6);
  const height = b.readUInt16LE(8);
  const packed = b[10]!;
  let i = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  need(i <= b.length);
  const kept: Buffer[] = [b.subarray(0, i)];
  let frames = 0;
  for (;;) {
    need(i < b.length);
    const tag = b[i]!;
    if (tag === 0x3b) { kept.push(b.subarray(i, i + 1)); break; }
    if (tag === 0x2c) {
      need(i + 10 <= b.length);
      const p = b[i + 9]!;
      let j = i + 10 + (p & 0x80 ? 3 * 2 ** ((p & 7) + 1) : 0);
      need(j < b.length);
      j = subBlocks(b, j + 1);
      kept.push(b.subarray(i, j));
      frames++;
      i = j;
      continue;
    }
    need(tag === 0x21 && i + 2 <= b.length);
    const label = b[i + 1]!;
    const j = subBlocks(b, i + 2);
    const appId = label === 0xff && b[i + 2] === 11 ? b.subarray(i + 3, i + 14).toString('latin1') : '';
    if (label === 0xf9 || appId === 'NETSCAPE2.0') kept.push(b.subarray(i, j));
    i = j;
  }
  need(frames > 0);
  return { type: 'gif', bytes: Buffer.concat(kept), width, height, frames };
}
