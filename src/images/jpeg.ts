/**
 * JPEG: segments are walked from SOI to EOI and only the keep list survives. Camera details, location, XMP, IPTC, the
 * MPF index of an iPhone HDR gain map, comments and unknown APPn segments all go; anything after EOI (the gain map
 * itself, a motion photo's video, padding, a web page) is cut off. A non-default Exif orientation is written back as a
 * tiny Exif block holding only that tag, so photos don't turn sideways.
 */
import { need, type Cleaned } from './clean.js';

const SOI = 0xd8, EOI = 0xd9, SOS = 0xda, DQT = 0xdb, DHT = 0xc4, DRI = 0xdd, APP0 = 0xe0, APP1 = 0xe1, APP2 = 0xe2, APP14 = 0xee;
const isSof = (m: number) => m >= 0xc0 && m <= 0xcf && m !== DHT && m !== 0xc8 && m !== 0xcc;
const isRst = (m: number) => m >= 0xd0 && m <= 0xd7;
const startsWith = (d: Buffer, s: string) => d.subarray(0, s.length).toString('latin1') === s;

/** Tag 0x0112 from an APP1 Exif segment's data (either byte order), or 1 when absent or unreadable. */
function orientation(data: Buffer): number {
  if (!startsWith(data, 'Exif\0\0') || data.length < 14) return 1;
  const t = data.subarray(6);
  const le = t.toString('latin1', 0, 2) === 'II';
  if (!le && t.toString('latin1', 0, 2) !== 'MM') return 1;
  const u16 = (i: number) => (le ? t.readUInt16LE(i) : t.readUInt16BE(i));
  const u32 = (i: number) => (le ? t.readUInt32LE(i) : t.readUInt32BE(i));
  const ifd = u32(4);
  if (ifd + 2 > t.length) return 1;
  const n = u16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > t.length) return 1;
    if (u16(e) === 0x0112) {
      const v = u16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/** An APP1 segment holding only an orientation tag (big-endian TIFF, one IFD entry). */
function orientationSegment(value: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('MM\0*', 0, 'latin1');
  tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10);
  tiff.writeUInt16BE(3, 12);
  tiff.writeUInt32BE(1, 14);
  tiff.writeUInt16BE(value, 18);
  tiff.writeUInt32BE(0, 22);
  const data = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const head = Buffer.from([0xff, APP1, 0, 0]);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
}

export function clean(b: Buffer): Cleaned {
  const kept: Buffer[] = [];
  let i = 2;
  let rotate = 1;
  let width = 0, height = 0;
  let scans = 0;
  let ended = false;
  let app0 = false;
  while (i < b.length) {
    need(b[i] === 0xff);
    while (b[i] === 0xff) i++;
    need(i < b.length);
    const m = b[i]!;
    i++;
    if (m === EOI) { ended = true; break; }
    need(m !== SOI && !isRst(m) && m !== 0x01 && m !== 0x00);
    need(i + 2 <= b.length);
    const len = b.readUInt16BE(i);
    need(len >= 2 && i + len <= b.length);
    const data = b.subarray(i + 2, i + len);
    const seg = Buffer.concat([Buffer.from([0xff, m]), b.subarray(i, i + len)]);
    i += len;
    if (m === APP0 && startsWith(data, 'JFIF\0')) {
      // The 14-byte JFIF header only: its thumbnail could show the uncropped original of an edited photo.
      need(data.length >= 14);
      const header = Buffer.from(data.subarray(0, 14));
      header[12] = 0;
      header[13] = 0;
      kept.push(Buffer.concat([Buffer.from([0xff, APP0, 0, 16]), header]));
      if (kept.length === 1) app0 = true;
    }
    else if (m === APP1) { if (rotate === 1) rotate = orientation(data); }
    else if (m === APP2 && startsWith(data, 'ICC_PROFILE\0')) kept.push(seg);
    else if (m === APP14 && startsWith(data, 'Adobe')) kept.push(seg);
    else if (m === DQT || m === DHT || m === DRI) kept.push(seg);
    else if (isSof(m)) {
      need(data.length >= 6);
      if (width === 0) { height = data.readUInt16BE(1); width = data.readUInt16BE(3); }
      kept.push(seg);
    } else if (m === SOS) {
      need(width > 0);
      // The entropy-coded data runs to the next marker that is neither a stuffed 00 nor a restart marker.
      let j = i;
      while (j + 1 < b.length && !(b[j] === 0xff && b[j + 1] !== 0x00 && !isRst(b[j + 1]!) && b[j + 1] !== 0xff)) j++;
      need(j + 1 < b.length);
      kept.push(seg, b.subarray(i, j));
      i = j;
      scans++;
    }
    // Anything else (APPn not listed, COM, DAC, JPG, DNL, unknown) is dropped.
  }
  need(ended && scans > 0 && width > 0 && height > 0);
  const head = [Buffer.from([0xff, SOI])];
  const body = app0 ? [kept[0]!, ...(rotate !== 1 ? [orientationSegment(rotate)] : []), ...kept.slice(1)] : [...(rotate !== 1 ? [orientationSegment(rotate)] : []), ...kept];
  return { type: 'jpeg', bytes: Buffer.concat([...head, ...body, Buffer.from([0xff, EOI])]), width, height, frames: 1 };
}
