/**
 * Every uploaded picture passes through here (round 2 section 12, "What the server does to every upload"). It works on
 * the bytes only and never decodes pixels: the type comes from the first bytes, each format's structure is walked,
 * only listed parts are kept, anything after the end marker is cut off (not refused), and the size comes from the
 * header. So production needs no image library and a "decompression bomb" can't hurt the server.
 */
import { clean as cleanJpeg } from './jpeg.js';
import { clean as cleanPng } from './png.js';
import { clean as cleanWebp } from './webp.js';
import { clean as cleanGif } from './gif.js';

export type ImageType = 'jpeg' | 'png' | 'webp' | 'gif';
export interface Cleaned { type: ImageType; bytes: Buffer; width: number; height: number; frames: number }

export const MAX_UPLOAD = 10 * 1024 * 1024;
export const MAX_SIDE = 10_000;
export const MAX_PIXELS = 40_000_000;
export const MAX_FRAMES = 100;
export const EXT: Record<ImageType, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' };

export type ImageErrorCode = 'svg' | 'unsupported' | 'unknown' | 'broken' | 'too_big' | 'too_large';
const MESSAGES: Record<ImageErrorCode, string> = {
  svg: "SVG pictures can't be added: they can carry script.",
  unsupported: "This kind of picture isn't supported. Save it as JPEG first; the editor does this for you.",
  unknown: "This file isn't a picture the brain can show (JPEG, PNG, WebP or GIF).",
  broken: "This picture's file is damaged.",
  too_big: 'This picture is too large (at most 10,000 px on a side, 40 megapixels and 100 frames).',
  too_large: 'This picture is over 10 MB.',
};

export class ImageError extends Error {
  constructor(readonly code: ImageErrorCode, message = MESSAGES[code]) {
    super(message);
  }
}

/** Throws the "damaged" error unless `ok`; the format walkers use it for every bounds check. */
export function need(ok: boolean): asserts ok {
  if (!ok) throw new ImageError('broken');
}

const startsWith = (b: Buffer, bytes: number[], at = 0) => bytes.every((x, i) => b[at + i] === x);
const ascii = (b: Buffer, at: number, len: number) => b.subarray(at, at + len).toString('latin1');

function sniff(b: Buffer): ImageType {
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return 'gif';
  const head = b.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) throw new ImageError('svg');
  const brand = ascii(b, 4, 4) === 'ftyp' ? ascii(b, 8, 4) : '';
  if (['heic', 'heix', 'mif1', 'msf1', 'avif', 'avis'].includes(brand)) throw new ImageError('unsupported');
  if (ascii(b, 0, 4) === 'II*\0' || ascii(b, 0, 4) === 'MM\0*' || ascii(b, 0, 2) === 'BM') throw new ImageError('unsupported');
  throw new ImageError('unknown');
}

/** The cleaned picture, or an ImageError saying why it can't be added. */
export function cleanImage(input: Buffer): Cleaned {
  if (input.length > MAX_UPLOAD) throw new ImageError('too_large');
  const type = sniff(input);
  const out = type === 'jpeg' ? cleanJpeg(input) : type === 'png' ? cleanPng(input) : type === 'webp' ? cleanWebp(input) : cleanGif(input);
  need(out.width > 0 && out.height > 0);
  if (out.width > MAX_SIDE || out.height > MAX_SIDE || out.width * out.height > MAX_PIXELS || out.frames > MAX_FRAMES) throw new ImageError('too_big');
  return out;
}
