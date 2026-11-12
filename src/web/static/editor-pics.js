// The editor's pictures (round 2 section 12): ＋ Add picture, paste and drop. Photos are redrawn on the device before
// they leave it, so only pixels go up (location, camera details and iPhone HDR extras stay behind); the server then
// cleans every upload again. app.js imports this module for an editor form with data-pics and calls setUpEditor.

const MAX_SIDE = 2560;
const QUALITY = 0.85;
const PNG_KEEP_BYTES = 4 * 1024 * 1024;
const HEIC = "This browser can't read HEIC pictures. Save it as JPEG first.";
const UNREADABLE = "This browser can't read this picture. Save it as JPEG first.";

/** The size that fits within `max` on its longest side, the same shape, never larger, never a zero side. */
export function fitWithin(w, h, max) {
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/**
 * What to do with a picture before it goes up. Every JPEG and WebP photo is redrawn (that is what removes its
 * location and camera details), as JPEG at most 2560 px; a PNG up to 2560 px and 4 MB goes as it is, so text stays
 * sharp, and a larger one is redrawn as PNG; a GIF goes as it is. A picture the browser can't decode (width null) is
 * refused with the reason. Anything else it can decode is redrawn as JPEG.
 */
export function redrawPlan({ type, name, width, height, bytes }) {
  const t = (type || '').toLowerCase();
  if (width == null || height == null) {
    return { action: 'refuse', message: /hei[cf]/.test(t) || /\.hei[cf]$/i.test(name || '') ? HEIC : UNREADABLE };
  }
  if (t === 'image/gif') return { action: 'keep' };
  if (t === 'image/png') {
    if (Math.max(width, height) <= MAX_SIDE && bytes <= PNG_KEEP_BYTES) return { action: 'keep' };
    return { action: 'redraw', format: 'image/png', ...fitWithin(width, height, MAX_SIDE) };
  }
  return { action: 'redraw', format: 'image/jpeg', ...fitWithin(width, height, MAX_SIDE) };
}

const size = (bytes) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

/** The status line for one picture: what the device did to it, and whether it was added. */
export function stripText({ name, before, after, redrawn, fromPhoto, error }) {
  if (error) return `${name} · ${error}`;
  const parts = [name];
  if (redrawn) parts.push(after < before ? `made smaller on this device, ${size(before)} → ${size(after)}` : 'redrawn on this device');
  else parts.push(size(after));
  if (redrawn && fromPhoto) parts.push('location and camera details removed');
  parts.push('Added ✓');
  return parts.join(' · ');
}

/**
 * The text with a picture's line put in at the cursor (replacing any selection) as its own paragraph. Returns the
 * new text, the description's range (selected, so the owner just types over it) and where the line ends.
 */
export function insertPicture(text, start, end, markdown) {
  // Never inside another picture's line (its description is selected right after it goes in): after that line.
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const nl = text.indexOf('\n', start);
  const lineEnd = nl < 0 ? text.length : nl;
  for (const m of text.slice(lineStart, lineEnd).matchAll(/!\[[^\]]*\]\([^)]*\)/g)) {
    const from = lineStart + m.index, to = from + m[0].length;
    if (start > from && start < to) {
      start = lineEnd;
      end = lineEnd;
      break;
    }
  }
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after === '' || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const at = before.length + lead.length;
  const alt = /^!\[([^\]]*)\]/.exec(markdown)?.[1] ?? '';
  return { text: before + lead + markdown + trail + after, selStart: at + 2, selEnd: at + 2 + alt.length, end: at + markdown.length };
}

/** A paste is taken as pictures only when it carries no text: Word and Excel put a picture of the text there too. */
export function pasteTakesFiles({ files, text }) {
  return files > 0 && (text || '').trim() === '';
}

/** A drop of pictures is taken; a drop of other files is blocked, so the browser never opens them over the editor. */
export function dropAction({ files, pictures }) {
  if (pictures > 0) return 'pictures';
  return files > 0 ? 'block' : 'none';
}

/** Where the next picture goes: after the last one, unless the owner has changed the text since (then their cursor). */
export function nextCursor(expected, actual, saved, selection) {
  return actual === expected ? saved : selection;
}

/**
 * The browser's own decode, upright as the photo was taken; a browser that doesn't know that option gets a plain
 * decode (current engines turn photos upright by default). Null when it can't read the file at all.
 */
export async function decodeFile(file, create = (f, o) => (o ? createImageBitmap(f, o) : createImageBitmap(f))) {
  try {
    return await create(file, { imageOrientation: 'from-image' });
  } catch {
    try {
      return await create(file);
    } catch {
      return null;
    }
  }
}

// ---- The page part ----

function redraw(bitmap, plan) {
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext('2d');
  if (plan.format === 'image/jpeg') {
    // JPEG has no transparency: a transparent area becomes the page's white instead of black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, plan.width, plan.height);
  }
  ctx.drawImage(bitmap, 0, 0, plan.width, plan.height);
  // The canvas is emptied once the blob is made: iOS Safari counts every live canvas against one memory budget.
  return new Promise((resolve, reject) => canvas.toBlob((b) => {
    canvas.width = 0;
    canvas.height = 0;
    if (b) resolve(b); else reject(new Error('redraw'));
  }, plan.format, QUALITY));
}

/** One picture: decode, redraw if the rule says so, upload, and give back the line and the status sentence. */
async function prepareAndSend(file) {
  const bitmap = await decodeFile(file);
  const plan = redrawPlan({ type: file.type, name: file.name, width: bitmap ? bitmap.width : null, height: bitmap ? bitmap.height : null, bytes: file.size });
  if (plan.action === 'refuse') {
    bitmap?.close?.();
    return { line: null, text: stripText({ name: file.name, error: plan.message }) };
  }
  let body = file;
  if (plan.action === 'redraw') {
    try {
      body = await redraw(bitmap, plan);
    } catch {
      bitmap?.close?.();
      return { line: null, text: stripText({ name: file.name, error: "This picture couldn't be made smaller on this device. Try a smaller picture." }) };
    }
  }
  bitmap?.close?.();
  let res;
  try {
    res = await fetch('/images?alt=', { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' }, credentials: 'same-origin' });
  } catch {
    return { line: null, text: stripText({ name: file.name, error: "The picture couldn't be sent. Check the connection and try again." }) };
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || typeof json.markdown !== 'string') {
    const error = json && typeof json.error === 'string' ? json.error : "The picture couldn't be added.";
    return { line: null, text: stripText({ name: file.name, error }) };
  }
  const redrawn = plan.action === 'redraw';
  const fromPhoto = redrawn && plan.format === 'image/jpeg';
  return { line: json.markdown, text: stripText({ name: file.name, before: file.size, after: body.size, redrawn, fromPhoto }) };
}

/** Shows Add picture and wires it, paste and drop to the form's text. */
export function setUpEditor(form) {
  const button = form.querySelector('.add-pic');
  const input = form.querySelector('.pic-input');
  const strip = form.querySelector('.pic-strip');
  const area = form.querySelector('textarea[name="body"]');
  if (!button || !input || !strip || !area) return;
  button.hidden = false;
  let busy = Promise.resolve();
  let cursor = null;
  let expected = null;
  const isPicture = (f) => f.type.startsWith('image/') || /\.(hei[cf]|jpe?g|png|gif|webp)$/i.test(f.name);

  const add = (files) => {
    const list = [...files].filter(isPicture);
    if (list.length === 0) return false;
    // One at a time, so the lines go in the order the pictures were given.
    busy = busy.then(async () => {
      strip.hidden = false;
      strip.textContent = list.length === 1 ? `${list[0].name} · adding…` : `Adding ${list.length} pictures…`;
      const lines = [];
      cursor = { start: area.selectionStart, end: area.selectionEnd };
      expected = area.value;
      for (const file of list) {
        const r = await prepareAndSend(file);
        lines.push(r.text);
        if (r.line) {
          if (area.editorApi) {
            // The editor is up (UI round, task 3): the picture goes in at its own cursor.
            area.editorApi.insert(r.line);
          } else {
            // The owner may have typed meanwhile (over the last description): then their cursor is where it goes.
            cursor = nextCursor(expected, area.value, cursor, { start: area.selectionStart, end: area.selectionEnd });
            const ins = insertPicture(area.value, cursor.start, cursor.end, r.line);
            area.value = ins.text;
            area.focus();
            area.setSelectionRange(ins.selStart, ins.selEnd);
            area.dispatchEvent(new Event('input', { bubbles: true }));
            cursor = { start: ins.end, end: ins.end };
          }
          expected = area.value;
        }
        strip.textContent = lines.join('\n');
      }
    });
    return true;
  };

  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    add(input.files);
    input.value = '';
  });
  // The text is written in the editor when it is mounted (UI round, task 3): the pictures then go into the editor.
  const onPaste = (e) => {
    const cd = e.clipboardData;
    if (cd && pasteTakesFiles({ files: cd.files.length, text: cd.getData('text/plain') }) && add(cd.files)) e.preventDefault();
  };
  const onDragOver = (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault();
  };
  const onDrop = (e) => {
    const files = e.dataTransfer ? [...e.dataTransfer.files] : [];
    const action = dropAction({ files: files.length, pictures: files.filter(isPicture).length });
    if (action === 'none') return;
    e.preventDefault();
    if (action === 'pictures') add(files);
    else {
      strip.hidden = false;
      strip.textContent = `${files[0].name} · Only pictures can be added here (JPEG, PNG, WebP or GIF).`;
    }
  };
  area.addEventListener('paste', onPaste);
  area.addEventListener('dragover', onDragOver);
  area.addEventListener('drop', onDrop);
  // The editor, once it is up, takes the paste and the drop instead of the hidden box.
  area.addEventListener('cm:ready', () => {
    const dom = area.editorApi && area.editorApi.dom;
    if (!dom) return;
    dom.addEventListener('paste', onPaste);
    dom.addEventListener('dragover', onDragOver);
    dom.addEventListener('drop', onDrop);
  });
}
