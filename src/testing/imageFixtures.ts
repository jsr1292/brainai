/**
 * Picture files for tests: real encoder output from sharp (a dev dependency, never imported by production code),
 * then byte surgery for what an encoder won't write on request (an iPhone HDR gain map, a motion photo, private PNG
 * chunks, an APNG, files with a web page after their end marker, a header claiming 50,000 × 50,000).
 */
import sharp from 'sharp';
import { crc32 } from 'node:zlib';

const base = (w = 64, h = 48) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 100, b: 50 } } });

/** A PNG chunk with its length and CRC. */
export function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

/** The PNG's chunks as [type, data] pairs, in order. */
export function pngChunks(png: Buffer): [string, Buffer][] {
  const out: [string, Buffer][] = [];
  let i = 8;
  while (i < png.length) {
    const len = png.readUInt32BE(i);
    const type = png.subarray(i + 4, i + 8).toString('latin1');
    out.push([type, png.subarray(i + 8, i + 8 + len)]);
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const buildPng = (chunks: [string, Buffer][]) => Buffer.concat([PNG_SIG, ...chunks.map(([t, d]) => pngChunk(t, d))]);

/** A JPEG segment: FF, marker, length (including itself), data. */
export function jpegSegment(marker: number, data: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

/** Inserts a segment right after the JPEG's APP segments (before the first DQT). */
function afterApps(jpeg: Buffer, seg: Buffer): Buffer {
  let i = 2;
  while (jpeg[i] === 0xff && jpeg[i + 1]! >= 0xe0 && jpeg[i + 1]! <= 0xef) i += 2 + jpeg.readUInt16BE(i + 2);
  return Buffer.concat([jpeg.subarray(0, i), seg, jpeg.subarray(i)]);
}

/** A 64 × 48 JPEG with camera details, a GPS block and orientation 6 (rotate 90° to show it upright). */
export async function jpegWithGps(): Promise<Buffer> {
  return base().withExif({ IFD0: { Make: 'Google', Model: 'Pixel 8' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '12/1 34/1 0/1' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
}

/** Like an iPhone HDR photo: an MPF index in APP2 and a second (gain map) JPEG after the first one's EOI. */
export async function iphoneHdr(): Promise<Buffer> {
  const main = await jpegWithGps();
  const mpf = jpegSegment(0xe2, Buffer.concat([Buffer.from('MPF\0', 'latin1'), Buffer.alloc(40, 1)]));
  const gain = await base(32, 24).jpeg().toBuffer();
  return Buffer.concat([afterApps(main, mpf), gain]);
}

/** Like an Android motion photo: a JPEG followed by an MP4. */
export async function motionPhoto(): Promise<Buffer> {
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42', 'latin1'), Buffer.alloc(64 * 1024, 7)]);
  return Buffer.concat([await base().jpeg().toBuffer(), mp4]);
}

/** A PNG with text chunks and a private chunk before IEND. */
export async function pngWithText(): Promise<Buffer> {
  const chunks = pngChunks(await base().png().toBuffer());
  const end = chunks.pop()!;
  return buildPng([...chunks, ['tEXt', Buffer.from('Comment\0secret note', 'latin1')], ['iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x/>', 'latin1')], ['prVt', Buffer.from('private')], end]);
}

/** An APNG that says it has `frames` frames, each frame the same picture. */
export async function apng(frames: number): Promise<Buffer> {
  const chunks = pngChunks(await base(16, 16).png().toBuffer());
  const ihdr = chunks[0]!;
  const idat = chunks.filter(([t]) => t === 'IDAT');
  const others = chunks.slice(1).filter(([t]) => t !== 'IDAT' && t !== 'IEND');
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames, 0);
  let seq = 0;
  const fctl = () => {
    const d = Buffer.alloc(26);
    d.writeUInt32BE(seq++, 0);
    d.writeUInt32BE(16, 4);
    d.writeUInt32BE(16, 8);
    d.writeUInt16BE(1, 20);
    d.writeUInt16BE(10, 22);
    return d;
  };
  const out: [string, Buffer][] = [ihdr, ['acTL', actl], ...others, ['fcTL', fctl()], ...idat];
  for (let f = 1; f < frames; f++) {
    out.push(['fcTL', fctl()]);
    for (const [, d] of idat) {
      const s = Buffer.alloc(4);
      s.writeUInt32BE(seq++);
      out.push(['fdAT', Buffer.concat([s, d])]);
    }
  }
  out.push(['IEND', Buffer.alloc(0)]);
  return buildPng(out);
}

const PAGE = Buffer.from('<html><body><script>alert(1)</script></body></html>', 'latin1');
/** A valid PNG that is also a web page after its IEND. */
export async function polyglotPng(): Promise<Buffer> {
  return Buffer.concat([await base().png().toBuffer(), PAGE]);
}
/** A valid GIF that is also a web page after its trailer. */
export async function polyglotGif(): Promise<Buffer> {
  return Buffer.concat([await base().gif().toBuffer(), PAGE]);
}

/** A PNG whose IHDR claims 50,000 × 50,000, with a correct CRC. */
export async function hugePng(): Promise<Buffer> {
  const chunks = pngChunks(await base().png().toBuffer());
  const ihdr = Buffer.from(chunks[0]![1]);
  ihdr.writeUInt32BE(50_000, 0);
  ihdr.writeUInt32BE(50_000, 4);
  return buildPng([['IHDR', ihdr], ...chunks.slice(1)]);
}

/** A WebP with camera details (an EXIF chunk and the VP8X flag). */
export async function webpWithExif(): Promise<Buffer> {
  return base().withExif({ IFD0: { Make: 'Google', Model: 'Pixel 8' } }).webp().toBuffer();
}

/** A GIF with a comment extension before its trailer. */
export async function gifWithComment(): Promise<Buffer> {
  const gif = await base().gif().toBuffer();
  const comment = Buffer.concat([Buffer.from([0x21, 0xfe, 11]), Buffer.from('secret note', 'latin1'), Buffer.from([0])]);
  return Buffer.concat([gif.subarray(0, gif.length - 1), comment, gif.subarray(gif.length - 1)]);
}

export const svg = (): Buffer => Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>', 'utf8');
export const heic = (): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(64)]);
export const tiff = (): Buffer => Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.alloc(64)]);
