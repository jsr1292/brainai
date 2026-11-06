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
