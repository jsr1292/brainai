// Renders src/web/static/icon.svg to the PNG icons. Run once: node scripts/make-icons.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'web', 'static');
const svg = readFileSync(join(dir, 'icon.svg'));
const BG = '#121a33';

const plain = (size, file) => sharp(svg, { density: 384 }).resize(size, size).png().toFile(join(dir, file));

// Maskable: glyph shrunk into the central 60% (safe zone) on a full-bleed background.
async function maskable(size, file) {
  const inner = Math.round(size * 0.6);
  const glyph = await sharp(svg, { density: 384 }).resize(inner, inner).png().toBuffer();
  await sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: glyph, gravity: 'centre' }])
    .png()
    .toFile(join(dir, file));
}

await plain(192, 'icon-192.png');
await plain(512, 'icon-512.png');
await maskable(512, 'icon-maskable-512.png');
await plain(180, 'apple-touch-icon.png');

// The desktop app's tray icon when an update is ready: the same icon with a filled red dot (28% of the size) at the
// top right. The plain tray icon is the app's own window icon.
async function trayUpdate(size, file) {
  const d = size * 0.28;
  const dot = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size - d / 2}" cy="${d / 2}" r="${d / 2}" fill="#e5484d"/></svg>`);
  await sharp(svg, { density: 384 }).resize(size, size).composite([{ input: dot }]).png().toFile(file);
}

await trayUpdate(64, join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'src-tauri', 'icons', 'tray-update.png'));
