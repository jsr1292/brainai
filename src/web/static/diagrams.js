// Diagrams in a page (round 2 section 12). A ```mermaid block arrives as its text inside .diagram; this module draws
// it when it scrolls into view. A drawing kept on the device (IndexedDB) shows at once, with no frame and no Mermaid;
// otherwise one hidden renderer frame (/diagram-frame) draws it under its own policy and sends back the SVG with its
// styles moved aside. Here the SVG goes through DOMPurify's SVG profile, the styles come back through CSSOM (never a
// style attribute), positioning is removed, and the result lives in a shadow root inside a paint-contained host.
// app.js imports this module only for a page or preview with data-diagrams.

export const MERMAID_VERSION = '12.3.0';
const PURIFY = '/static/vendor/dompurify-3.4.17/purify.es.mjs';
const TOO_SMALL = 0.62;
const CACHE_CAP = 20 * 1024 * 1024;
const DB_NAME = 'brain';
const STORE = 'diagrams';

// One palette per theme for the colour scales (mindmap, timeline, pie, git graph, XY chart, …).
const PALETTE = {
  light: ['#4a6fa5', '#c47f3e', '#5e9e6e', '#a5566a', '#7a6fb0', '#3e9ea3', '#a89a3a', '#8a6b4f', '#5a7fb8', '#c98c52', '#6fa880', '#b06a7c'],
  dark: ['#8aa8dc', '#e0a874', '#8cc79b', '#d98fa1', '#ae9fe0', '#79c8cc', '#d6c870', '#c2a085', '#9db8e8', '#ebb98a', '#a2d4b0', '#e3a3b3'],
};

/** The colours the frame draws with, read from the page's own CSS variables. */
export function themeVars(read, dark) {
  return {
    surface: read('--surface'), raised: read('--raised'), line: read('--line'), lineStrong: read('--line-strong'),
    fg: read('--fg'), muted: read('--muted'), ink2: read('--ink2'), dark: !!dark, palette: PALETTE[dark ? 'dark' : 'light'],
  };
}

/** The scale a diagram is shown at: as drawn if it fits, otherwise shrunk to the width it has. */
export function fitScale(naturalWidth, hostWidth) {
  return naturalWidth > 0 ? Math.min(1, hostWidth / naturalWidth) : 1;
}

/** Shrunk this far, Mermaid's 16 px words are under about 10 px: shown as an overview with Open full size. */
export const tooSmall = (scale) => scale < TOO_SMALL;

/** One plain sentence for what went wrong, from Mermaid's message (a small table of the common cases). */
export function reword(raw, kind) {
  const text = String(raw || '');
  const m = /line (\d+)/i.exec(text);
  const line = m ? Number(m[1]) : null;
  let reason = null;
  let withLine = true;
  if (text.startsWith('This diagram turns on HTML labels')) { reason = text; withLine = false; }
  else if (/Maximum text size/i.test(text)) { reason = 'it is too long to draw (at most 20,000 characters).'; withLine = false; }
  else if (/Edge limit/i.test(text)) { reason = 'it has too many lines between boxes (at most 300).'; withLine = false; }
  else if (/No diagram type detected/i.test(text)) { reason = 'the first word must name a kind of diagram, such as `flowchart` or `sequenceDiagram`.'; withLine = false; }
  else if (/got 'EOF'|Unclosed/i.test(text)) reason = "a bracket opened here isn't closed.";
  else if (kind === 'sequenceDiagram' && /ARROW/.test(text)) reason = 'a message needs an arrow such as `->>` between the two names.';
  else if (/Expecting[\s\S]*('LINK'|ARROW)/.test(text)) reason = 'a line between two boxes needs an arrow such as `-->`.';
  const tail = ' The rest of the page is fine.';
  if (reason === null) {
    return line !== null
      ? `This diagram couldn't be drawn. Line ${line} has something the diagram drawer doesn't understand.${tail}`
      : `This diagram couldn't be drawn: it has something the diagram drawer doesn't understand.${tail}`;
  }
  return withLine && line !== null ? `This diagram couldn't be drawn. Line ${line}: ${reason}${tail}` : `This diagram couldn't be drawn: ${reason}${tail}`;
}

/** The diagram's text as lines, the bad one (1-based) marked. */
export function markLine(text, n) {
  return text.split('\n').map((t, i) => ({ text: t, bad: n !== null && i + 1 === n }));
}

/** The drawer couldn't load (not a mistake in the diagram): a timeout, no drawer, or a Mermaid file that didn't arrive. */
export function drawerFailed(error) {
  return /^(timeout|unavailable)$/.test(String(error)) || /dynamically imported module|Importing a module script failed/i.test(String(error));
}

/** The version drawings are kept under: Mermaid's, plus the renderer's fingerprint, so a changed renderer redraws. */
export function rendererVersion(rendererUrl) {
  const v = rendererUrl ? /[?&]v=([0-9a-f]+)/.exec(rendererUrl)?.[1] : null;
  return v ? `${MERMAID_VERSION}+${v}` : MERMAID_VERSION;
}

/** Where a drawing is kept: by Mermaid version, theme and the text's hash. */
export const cacheKey = (version, theme, hashHex) => `${version}:${theme}:${hashHex}`;

/** Which kept drawings to drop (oldest first) so the rest fit in `cap` bytes. Entries: { key, bytes, at }. */
export function evictOrder(entries, cap) {
  let total = entries.reduce((n, e) => n + e.bytes, 0);
  const out = [];
  for (const e of [...entries].sort((a, b) => a.at - b.at)) {
    if (total <= cap) break;
    out.push(e.key);
    total -= e.bytes;
  }
  return out;
}

// ---- The page part ----

const kindOf = (text) => {
  const lines = text.split('\n').map((l) => l.trim());
  let i = 0;
  while (i < lines.length && lines[i] === '') i++;
  if (lines[i] === '---') { i++; while (i < lines.length && lines[i] !== '---') i++; i++; }
  while (i < lines.length && (lines[i] === '' || lines[i].startsWith('%%'))) i++;
  return (lines[i] || '').split(/\s+/)[0];
};

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// -- Kept on the device (IndexedDB). Every failure is quiet: the diagram is simply drawn again. --

function openDb() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => {
      // Another tab (or the login page) deleting the store: let go of it, so the deletion isn't blocked.
      req.result.onversionchange = () => { req.result.close(); dbp = null; };
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
  });
}
let dbp = null;
const db = () => (dbp ??= openDb());

async function kept(key) {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function keep(key, value) {
  const d = await db();
  if (!d) return;
  try {
    const tx = d.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put(value, key);
    // Keep the whole store under its cap, oldest drawings first out.
    const all = store.openCursor();
    const entries = [];
    all.onsuccess = () => {
      const c = all.result;
      if (c) { entries.push({ key: c.key, bytes: c.value.bytes || 0, at: c.value.at || 0 }); c.continue(); return; }
      for (const k of evictOrder(entries, CACHE_CAP)) store.delete(k);
    };
  } catch { /* storage full or refused: nothing kept */ }
}

// -- The renderer frame: one per page, made on the first drawing that isn't kept. --

let frame = null;
let frameReady = null;
const waiting = new Map();
let seq = 0;

function renderer() {
  if (frameReady) return frameReady;
  frame = document.createElement('iframe');
  frame.className = 'diagram-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.title = 'Diagram drawer';
  frameReady = new Promise((resolve) => {
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow || !e.data) return;
      if (e.data.ready === true) { resolve(true); return; }
      if (e.data.ready === false) { resolve(false); return; }
      const done = waiting.get(e.data.id);
      if (done) { waiting.delete(e.data.id); done(e.data); }
    });
  });
  frame.src = '/diagram-frame';
  document.body.append(frame);
  return frameReady;
}

async function draw(text, vars) {
  const ready = await Promise.race([renderer(), new Promise((r) => setTimeout(() => r(false), 20000))]);
  // No drawer this time (it didn't load): every diagram keeps its text, at once, instead of waiting in turn.
  if (ready !== true) { frameReady = Promise.resolve(false); return { error: 'unavailable' }; }
  const id = `${Date.now().toString(36)}${(seq++).toString(36)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: 'timeout' }); }, 20000);
    waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
    frame.contentWindow.postMessage({ id, text, vars }, location.origin);
  });
}

// -- Putting a drawing in the page. --

let purify = null;
const POSITION = ['position', 'inset', 'top', 'left', 'right', 'bottom', 'z-index'];

/** The sanitised drawing, its styles back on through CSSOM, ready for a shadow root. */
async function build(drawing) {
  purify ??= (await import(PURIFY)).default;
  const frag = purify.sanitize(drawing.svg, {
    USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['style'], FORBID_ATTR: ['style'], RETURN_DOM_FRAGMENT: true,
  });
  for (const el of frag.querySelectorAll('[data-mm-css]')) {
    el.style.cssText = el.getAttribute('data-mm-css');
    for (const p of POSITION) el.style.removeProperty(p);
    el.removeAttribute('data-mm-css');
  }
  let sheet = null;
  try {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(drawing.css || '');
  } catch { sheet = null; }
  return { frag, sheet };
}

function button(text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'link-button';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

/** A drawing in place of the text: the host with its shadow root, the fit rule and the footer. */
async function show(block, drawing) {
  const { frag, sheet } = await build(drawing);
  const svg = frag.querySelector('svg');
  if (!svg) return false;
  const pre = block.querySelector('pre.diagram-src');
  block.querySelector('.diagram-host')?.remove();
  block.querySelector('.diagram-foot')?.remove();
  block.querySelector('.diagram-problem')?.remove();
  const host = document.createElement('div');
  host.className = 'diagram-host';
  const root = host.attachShadow({ mode: 'open' });
  if (sheet) root.adoptedStyleSheets = [sheet];
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.style.maxWidth = 'none';
  svg.style.display = 'block';
  root.append(svg);
  block.insertBefore(host, pre);
  block.classList.remove('diagram-failed');
  block.classList.add('diagram-drawn');
  const fit = () => {
    // The host's own width: the block's padding is not room for the drawing.
    const scale = fitScale(drawing.width, host.clientWidth || drawing.width);
    svg.style.width = `${Math.round(drawing.width * scale)}px`;
    svg.style.margin = '0 auto';
    block.classList.toggle('diagram-small', tooSmall(scale));
  };
  fit();
  // Again only when the block's width really changes, a frame later, so resizing never loops.
  let lastWidth = host.clientWidth;
  block._fitObserver?.disconnect();
  block._fitObserver = new ResizeObserver(() => {
    if (host.clientWidth === lastWidth) return;
    lastWidth = host.clientWidth;
    requestAnimationFrame(fit);
  });
  block._fitObserver.observe(host);
  const foot = document.createElement('div');
  foot.className = 'diagram-foot';
  const note = document.createElement('span');
  note.className = 'diagram-note';
  note.textContent = 'Diagram · drawn from text in this page';
  const small = document.createElement('span');
  small.className = 'diagram-toosmall';
  small.textContent = 'Too small to read here';
  // Full size is viewer.js, the same viewer as pictures (its URL, fingerprinted, is on the article).
  const full = () => import(block.closest('[data-diagrams]').dataset.viewer)
    .then((m) => m.openViewerNode({ node: svg.cloneNode(true), width: drawing.width, height: drawing.height, sheet }));
  const open = button('Open full size', full);
  open.classList.add('diagram-open');
  const toggle = button('Show the text', () => {
    pre.hidden = !pre.hidden;
    toggle.textContent = pre.hidden ? 'Show the text' : 'Hide the text';
  });
  foot.append(note, small, open, toggle, button('Full size', full));
  block.insertBefore(foot, pre);
  pre.hidden = true;
  block.classList.add('diagram-drawn');
  return true;
}

/** The anchor of the section a block sits in: the nearest heading above it in the article ('' for the lead). */
function sectionOf(block) {
  for (let el = block; el && !el.matches?.('article'); el = el.previousElementSibling || el.parentElement) {
    const h = el.matches?.('.sec-head') ? el.querySelector('h2[id], h3[id]') : null;
    if (h) return h.id;
    if (el.parentElement?.matches?.('article') && !el.previousElementSibling) break;
  }
  return '';
}

/** The calm box: what is wrong, the text with the bad line marked, and Ask an AI to fix it. */
function problem(block, error, text) {
  const kind = kindOf(text);
  const sentence = reword(error, kind);
  const m = /line (\d+)/i.exec(String(error || ''));
  const box = document.createElement('div');
  box.className = 'diagram-problem';
  box.setAttribute('role', 'note');
  const p = document.createElement('p');
  // `code` in the sentence (an arrow such as `->>`) shows as code, built from text nodes only.
  sentence.split('`').forEach((part, i) => {
    if (i % 2 === 1) { const c = document.createElement('code'); c.textContent = part; p.append(c); } else if (part) p.append(document.createTextNode(part));
  });
  const code = document.createElement('pre');
  code.className = 'diagram-problem-src';
  code.tabIndex = 0;
  for (const l of markLine(text, m ? Number(m[1]) : null)) {
    const span = document.createElement(l.bad ? 'mark' : 'span');
    span.textContent = `${l.text}\n`;
    code.append(span);
  }
  box.append(p, code);
  const form = document.querySelector('details.asknote:not(.ask-line) form');
  if (form) {
    box.append(button('Ask an AI to fix it', () => {
      const details = form.closest('details');
      const select = form.querySelector('select[name="section"]');
      const area = form.querySelector('textarea[name="text"]');
      if (select) {
        const anchor = sectionOf(block);
        if ([...select.options].some((o) => o.value === anchor)) select.value = anchor;
      }
      if (area) area.value = `The diagram in this section can't be drawn: ${sentence.replace(/^This diagram couldn't be drawn[.:] /, '').replace(/ The rest of the page is fine\.$/, '')}`;
      if (details) details.open = true;
      details?.scrollIntoView({ block: 'center' });
      area?.focus();
    }));
  }
  block.querySelector('.diagram-problem')?.remove();
  block.insertBefore(box, block.querySelector('pre.diagram-src'));
  block.querySelector('pre.diagram-src').hidden = true;
  block.classList.add('diagram-failed');
  return { box, sentence };
}

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const readVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Draws one block: from the device if it was kept, otherwise through the frame (and keeps it). */
async function render(block, hooks, version) {
  const code = block.querySelector('pre.diagram-src code');
  if (!code) return;
  const text = code.textContent.replace(/\n$/, '');
  const dark = !!darkQuery?.matches;
  const key = cacheKey(version, dark ? 'dark' : 'light', await sha256(text));
  let drawing = await kept(key);
  if (!drawing) {
    const r = await draw(text, themeVars(readVar, dark));
    if (r.error && drawerFailed(r.error)) {
      // Not the diagram's fault: its text stays, with one quiet line, and nothing is reported.
      if (!block.querySelector('.diagram-unavailable')) {
        const note = document.createElement('p');
        note.className = 'diagram-unavailable';
        note.textContent = "The diagram drawer couldn't load here, so its text is shown. It draws next time.";
        block.append(note);
      }
      return;
    }
    if (r.error) {
      const { sentence } = problem(block, r.error === 'timeout' ? '' : r.error, text);
      hooks.onProblem?.(block, sentence);
      return;
    }
    drawing = { svg: r.svg, css: r.css, width: r.width, height: r.height, bytes: r.svg.length + r.css.length, at: Date.now() };
    keep(key, drawing);
  }
  if (await show(block, drawing)) hooks.onDrawn?.(block);
}

/**
 * Draws every diagram under `root` as it scrolls into view, one at a time, and again when the theme changes.
 * `hooks.onProblem(block, sentence)` and `hooks.onDrawn(block)` let the page report what it saw.
 */
export function setUpDiagrams(root, hooks = {}) {
  const blocks = [...root.querySelectorAll('.diagram')];
  if (blocks.length === 0) return;
  // A page (not a preview) reports what each diagram drew: a problem always, a success only where one was recorded.
  const { page, version } = root.dataset;
  const report = (block, error) => {
    if (!page || !version || block.dataset.block === undefined) return;
    fetch(`/pages/${page}/diagram-checks`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: Number(version), block: Number(block.dataset.block), error }),
    }).catch(() => {});
  };
  const outer = hooks;
  const seenBy = {
    onProblem: (block, sentence) => { report(block, sentence); outer.onProblem?.(block, sentence); },
    onDrawn: (block) => {
      if (block.hasAttribute('data-problem')) { report(block, null); block.removeAttribute('data-problem'); }
      outer.onDrawn?.(block);
    },
  };
  let queue = Promise.resolve();
  const keptAs = rendererVersion(root.dataset.renderer);
  const enqueue = (b) => { queue = queue.then(() => render(b, seenBy, keptAs)).catch(() => {}); };
  const seen = new Set();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting || seen.has(e.target)) continue;
      seen.add(e.target);
      io.unobserve(e.target);
      enqueue(e.target);
    }
  }, { rootMargin: '300px 0px' });
  for (const b of blocks) io.observe(b);
  darkQuery?.addEventListener?.('change', () => { for (const b of seen) enqueue(b); });
}
