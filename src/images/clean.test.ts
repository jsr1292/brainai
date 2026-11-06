import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';
import sharp, { type Metadata } from 'sharp';
import { cleanImage, ImageError, type Cleaned } from './clean.js';
import * as fx from '../testing/imageFixtures.js';

const has = (b: Buffer, s: string | number[]) => b.includes(typeof s === 'string' ? Buffer.from(s, 'latin1') : Buffer.from(s));
const code = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof ImageError) return e.code; throw e; }
  return 'accepted';
};

/** The cleaned bytes still decode, at the same size, with nothing but the pixels (and at most an orientation). */
async function decodes(out: Cleaned): Promise<Metadata> {
  const m = await sharp(out.bytes).metadata();
  assert.equal(m.width, out.width);
  assert.equal(m.height, out.height);
  for (const k of ['xmp', 'iptc', 'comments'] as const) assert.equal(m[k], undefined, k);
  if (m.exif) assert.ok(m.exif.length < 64, `exif left: ${m.exif.length} bytes`);
  return m;
}

test('a JPEG with GPS and camera details keeps only its pixels and its orientation', async () => {
  const input = await fx.jpegWithGps();
  const exif = (await sharp(input).metadata()).exif!;
  assert.ok(has(exif, [0x88, 0x25]) || has(exif, [0x25, 0x88]), 'the fixture has a GPS block');
  const out = cleanImage(input);
  assert.deepEqual([out.type, out.width, out.height, out.frames], ['jpeg', 64, 48, 1]);
  const m = await decodes(out);
  assert.equal(m.orientation, 6);
  assert.ok(!has(out.bytes, 'Pixel 8') && !has(out.bytes, 'Google'));
  assert.ok(!has(out.bytes, [0x88, 0x25]) && !has(out.bytes, [0x25, 0x88]), 'no GPS pointer');
});

test('an iPhone HDR photo loses its MPF index and the gain map after EOI', async () => {
  const out = cleanImage(await fx.iphoneHdr());
  await decodes(out);
  assert.ok(!has(out.bytes, 'MPF\0'));
  assert.equal(out.bytes.indexOf(Buffer.from([0xff, 0xd8]), 2), -1, 'one SOI only');
  assert.deepEqual([...out.bytes.subarray(-2)], [0xff, 0xd9]);
});

test('a motion photo loses the video after the picture', async () => {
  const out = cleanImage(await fx.motionPhoto());
  await decodes(out);
  assert.ok(!has(out.bytes, 'ftypmp42'));
});

test('a PNG loses its text and private chunks, and every chunk left has a valid CRC', async () => {
  const out = cleanImage(await fx.pngWithText());
  await decodes(out);
  for (const t of ['tEXt', 'iTXt', 'prVt']) assert.ok(!has(out.bytes, t), t);
  for (const [type, data] of fx.pngChunks(out.bytes)) {
    const at = out.bytes.indexOf(Buffer.concat([Buffer.from(type, 'latin1'), data]));
    assert.equal(out.bytes.readUInt32BE(at + 4 + data.length), crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])) >>> 0, type);
  }
});

test('an APNG counts its frames, and more than 100 is too many', async () => {
  const out = cleanImage(await fx.apng(3));
  assert.equal(out.frames, 3);
  await decodes(out);
  const many = await fx.apng(120);
  assert.equal(code(() => cleanImage(many)), 'too_big');
});

test('a picture that is also a web page keeps the picture and loses the page', async () => {
  for (const input of [await fx.polyglotPng(), await fx.polyglotGif()]) {
    const out = cleanImage(input);
    await decodes(out);
    assert.ok(!has(out.bytes, '<html'));
  }
});

test('a header claiming 50,000 × 50,000 is refused as too large', async () => {
  const huge = await fx.hugePng();
  assert.equal(code(() => cleanImage(huge)), 'too_big');
});

test('a WebP loses its EXIF chunk and the VP8X flags for it, and its RIFF size is rewritten', async () => {
  const input = await fx.webpWithExif();
  assert.ok(has(input, 'EXIF'));
  const out = cleanImage(input);
  await decodes(out);
  assert.ok(!has(out.bytes, 'EXIF') && !has(out.bytes, 'XMP '));
  assert.equal(out.bytes.subarray(12, 16).toString('latin1'), 'VP8X');
  assert.equal(out.bytes[20]! & 0x0c, 0);
  assert.equal(out.bytes.readUInt32LE(4), out.bytes.length - 8);
});

test('a GIF loses its comment extension', async () => {
  const input = await fx.gifWithComment();
  assert.ok(has(input, [0x21, 0xfe]));
  const out = cleanImage(input);
  await decodes(out);
  assert.ok(!has(out.bytes, 'secret note'));
  assert.equal(out.type, 'gif');
});

test('SVG, HEIC, TIFF and other files are refused with their reason', async () => {
  assert.equal(code(() => cleanImage(fx.svg())), 'svg');
  assert.equal(code(() => cleanImage(Buffer.from('﻿  <svg xmlns="http://www.w3.org/2000/svg"/>'))), 'svg');
  assert.equal(code(() => cleanImage(fx.heic())), 'unsupported');
  assert.equal(code(() => cleanImage(fx.tiff())), 'unsupported');
  assert.equal(code(() => cleanImage(Buffer.from('hello'))), 'unknown');
  assert.equal(code(() => cleanImage(Buffer.alloc(0))), 'unknown');
  try { cleanImage(fx.svg()); } catch (e) { assert.equal((e as Error).message, "SVG pictures can't be added: they can carry script."); }
  try { cleanImage(fx.heic()); } catch (e) { assert.equal((e as Error).message, "This kind of picture isn't supported. Save it as JPEG first; the editor does this for you."); }
});

test('a damaged JPEG or PNG is refused as broken', async () => {
  const jpeg = await fx.jpegWithGps();
  assert.equal(code(() => cleanImage(jpeg.subarray(0, 200))), 'broken');
  const png = Buffer.from(await fx.pngWithText());
  const idat = png.indexOf(Buffer.from('IDAT', 'latin1'));
  png[idat + 6] = png[idat + 6]! ^ 0xff;
  assert.equal(code(() => cleanImage(png)), 'broken');
});

test('over 10 MB is refused before anything is read', () => {
  const big = Buffer.alloc(10 * 1024 * 1024 + 1);
  big.set([0xff, 0xd8, 0xff], 0);
  assert.equal(code(() => cleanImage(big)), 'too_large');
});

test('cleaning is repeatable: the same input gives the same bytes', async () => {
  const input = await fx.iphoneHdr();
  assert.deepEqual(cleanImage(input).bytes, cleanImage(input).bytes);
  const once = cleanImage(input).bytes;
  assert.deepEqual(cleanImage(once).bytes, once, 'cleaning a cleaned file changes nothing');
});

test('progressive JPEGs and large noisy photos keep every scan', async () => {
  const noise = Buffer.alloc(1600 * 1200 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
  for (const input of [
    await sharp(noise, { raw: { width: 1600, height: 1200, channels: 3 } }).jpeg({ progressive: true, quality: 90 }).toBuffer(),
    await sharp(noise, { raw: { width: 1600, height: 1200, channels: 3 } }).jpeg({ quality: 95, mozjpeg: true }).toBuffer(),
  ]) {
    const out = cleanImage(input);
    await decodes(out);
    const a = await sharp(input).raw().toBuffer();
    const b = await sharp(out.bytes).raw().toBuffer();
    assert.ok(a.equals(b), 'the same pixels');
  }
});

test('a JFIF thumbnail (it can show the uncropped original) is dropped, the JFIF header kept', async () => {
  const plain = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
  // JFIF 1.01, no units, 1:1, with a 2 × 2 RGB thumbnail of a recognisable colour.
  const thumb = Buffer.alloc(12, 0xab);
  const jfif = Buffer.concat([Buffer.from('JFIF\0', 'latin1'), Buffer.from([1, 1, 0, 0, 1, 0, 1, 2, 2]), thumb]);
  const input = Buffer.concat([plain.subarray(0, 2), fx.jpegSegment(0xe0, jfif), plain.subarray(2)]);
  const out = cleanImage(input);
  await decodes(out);
  assert.deepEqual([...out.bytes.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe0]);
  assert.equal(out.bytes.readUInt16BE(4), 16, 'the APP0 holds the 14-byte JFIF header only');
  assert.deepEqual([out.bytes[18], out.bytes[19]], [0, 0], 'no thumbnail size');
  assert.ok(!out.bytes.includes(thumb));
});
