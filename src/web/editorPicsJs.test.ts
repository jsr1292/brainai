/*
 * editor-pics.js, the editor's pictures: its pure helpers run here in node; the page part runs only when
 * setUpEditor is called, so importing it has no side effects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const p = await import(new URL('./static/editor-pics.js', import.meta.url).href);
const MB = 1048576, KB = 1024;
const HEIC = "This browser can't read HEIC pictures. Save it as JPEG first.";

test('every JPEG and WebP photo is redrawn as JPEG, at most 2560 px; PNG is kept up to 2560 px and 4 MB; GIF is kept', () => {
  assert.deepEqual(p.redrawPlan({ type: 'image/jpeg', name: 'IMG_4417.jpeg', width: 4032, height: 3024, bytes: 3.1 * MB }), { action: 'redraw', format: 'image/jpeg', width: 2560, height: 1920 });
  assert.deepEqual(p.redrawPlan({ type: 'image/jpeg', name: 'a.jpg', width: 800, height: 600, bytes: 90 * KB }), { action: 'redraw', format: 'image/jpeg', width: 800, height: 600 });
  assert.deepEqual(p.redrawPlan({ type: 'image/webp', name: 'a.webp', width: 100, height: 50, bytes: 9 * KB }), { action: 'redraw', format: 'image/jpeg', width: 100, height: 50 });
  assert.deepEqual(p.redrawPlan({ type: 'image/png', name: 'shot.png', width: 1179, height: 2556, bytes: 1.2 * MB }), { action: 'keep' });
  assert.deepEqual(p.redrawPlan({ type: 'image/png', name: 'shot.png', width: 1179, height: 2556, bytes: 4.5 * MB }), { action: 'redraw', format: 'image/png', width: 1179, height: 2556 });
  assert.deepEqual(p.redrawPlan({ type: 'image/png', name: 'wide.png', width: 3000, height: 1000, bytes: 2 * MB }), { action: 'redraw', format: 'image/png', width: 2560, height: 853 });
  assert.deepEqual(p.redrawPlan({ type: 'image/gif', name: 'a.gif', width: 300, height: 200, bytes: 2 * MB }), { action: 'keep' });
});

test('a picture the browser cannot read is refused with the reason, HEIC by its type or its name', () => {
  assert.deepEqual(p.redrawPlan({ type: 'image/heic', name: 'IMG_1.HEIC', width: null, height: null, bytes: MB }), { action: 'refuse', message: HEIC });
  assert.deepEqual(p.redrawPlan({ type: '', name: 'IMG_2.heif', width: null, height: null, bytes: MB }), { action: 'refuse', message: HEIC });
  assert.deepEqual(p.redrawPlan({ type: 'image/x-foo', name: 'a.foo', width: null, height: null, bytes: MB }), { action: 'refuse', message: "This browser can't read this picture. Save it as JPEG first." });
});

test('fitWithin keeps the shape, never enlarges, and never gives a zero side', () => {
  assert.deepEqual(p.fitWithin(4032, 3024, 2560), { width: 2560, height: 1920 });
  assert.deepEqual(p.fitWithin(1, 9000, 2560), { width: 1, height: 2560 });
  assert.deepEqual(p.fitWithin(800, 600, 2560), { width: 800, height: 600 });
});

test('the status line says what happened to the picture', () => {
  assert.equal(p.stripText({ name: 'IMG_4417.jpeg', before: 3.1 * MB, after: 412 * KB, redrawn: true, fromPhoto: true }),
    'IMG_4417.jpeg · made smaller on this device, 3.1 MB → 412 KB · location and camera details removed · Added ✓');
  assert.equal(p.stripText({ name: 'shot.png', before: 412 * KB, after: 412 * KB, redrawn: false, fromPhoto: false }), 'shot.png · 412 KB · Added ✓');
  assert.equal(p.stripText({ name: 'a.jpg', before: 90 * KB, after: 95 * KB, redrawn: true, fromPhoto: true }), 'a.jpg · redrawn on this device · location and camera details removed · Added ✓');
  assert.equal(p.stripText({ name: 'big.png', before: 5 * MB, after: 3 * MB, redrawn: true, fromPhoto: false }), 'big.png · made smaller on this device, 5.0 MB → 3.0 MB · Added ✓');
  assert.equal(p.stripText({ name: 'a.jpg', error: "This picture's file is damaged." }), "a.jpg · This picture's file is damaged.");
});

test('a picture goes in at the cursor as its own paragraph, with its description selected', () => {
  const md = '![Describe the picture](/images/x.jpg)';
  const sel = (r: { text: string; selStart: number; selEnd: number }) => r.text.slice(r.selStart, r.selEnd);
  const a = p.insertPicture('', 0, 0, md);
  assert.deepEqual([a.text, a.selStart, a.selEnd, a.end], [md, 2, 22, md.length]);
  assert.equal(p.insertPicture('Hello', 5, 5, md).text, `Hello\n\n${md}`);
  const mid = p.insertPicture('A\n\nB', 3, 3, md);
  assert.equal(mid.text, `A\n\n${md}\n\nB`);
  assert.equal(sel(mid), 'Describe the picture');
  assert.equal(p.insertPicture('A\nB', 2, 2, md).text, `A\n\n${md}\n\nB`);
  assert.equal(p.insertPicture('Old text', 0, 3, md).text, `${md}\n\n text`, 'a selection is replaced');
  let r = { text: 'Intro', end: 5 } as { text: string; end: number; selStart?: number; selEnd?: number };
  for (const n of [1, 2, 3]) r = p.insertPicture(r.text, r.end, r.end, `![Describe the picture](/images/${n}.png)`);
  assert.equal(r.text, 'Intro\n\n![Describe the picture](/images/1.png)\n\n![Describe the picture](/images/2.png)\n\n![Describe the picture](/images/3.png)');
});

test('a picture never goes inside another picture\'s line: with its description selected, the new one goes after it', () => {
  const first = '![Describe the picture](/images/1.jpg)';
  const text = `Intro\n\n${first}\n\nMore`;
  const at = text.indexOf('Describe');
  const r = p.insertPicture(text, at, at + 'Describe the picture'.length, '![Describe the picture](/images/2.png)');
  assert.equal(r.text, `Intro\n\n${first}\n\n![Describe the picture](/images/2.png)\n\nMore`);
  const inUrl = text.indexOf('/images/1');
  assert.equal(p.insertPicture(text, inUrl, inUrl, '![x](/images/3.png)').text, `Intro\n\n${first}\n\n![x](/images/3.png)\n\nMore`);
});

test('a paste with text (Word, Excel) stays the browser\'s own paste; only a paste of pictures alone is taken', () => {
  assert.equal(p.pasteTakesFiles({ files: 1, text: 'Quarterly table' }), false);
  assert.equal(p.pasteTakesFiles({ files: 2, text: '  \n' }), true);
  assert.equal(p.pasteTakesFiles({ files: 0, text: '' }), false);
});

test('a dropped file that is not a picture is blocked, so the browser never leaves the unsaved text', () => {
  assert.equal(p.dropAction({ files: 2, pictures: 1 }), 'pictures');
  assert.equal(p.dropAction({ files: 1, pictures: 0 }), 'block');
  assert.equal(p.dropAction({ files: 0, pictures: 0 }), 'none');
});

test('if the owner typed while pictures were going in, the next one goes where the cursor is now', () => {
  assert.deepEqual(p.nextCursor('abc', 'abc', { start: 3, end: 3 }, { start: 1, end: 2 }), { start: 3, end: 3 });
  assert.deepEqual(p.nextCursor('abc', 'aXc', { start: 3, end: 3 }, { start: 1, end: 2 }), { start: 1, end: 2 });
});

test('decoding asks for an upright picture, and falls back to a plain decode on a browser that refuses the option', async () => {
  const bitmap = { width: 4, height: 3 };
  const picky = async (_f: unknown, o?: unknown) => { if (o) throw new TypeError('imageOrientation'); return bitmap; };
  assert.equal(await p.decodeFile('f', picky), bitmap);
  const never = async () => { throw new Error('cannot decode'); };
  assert.equal(await p.decodeFile('f', never), null);
  let seen: unknown;
  await p.decodeFile('f', async (_f: unknown, o?: unknown) => { seen = o; return bitmap; });
  assert.deepEqual(seen, { imageOrientation: 'from-image' });
});
