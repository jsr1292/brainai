/*
 * The browser scripts in two languages: static/i18n.js reads the page's JSON block and defines T(key, english, params);
 * the scripts read their person-facing words through it. With a Spanish block Spanish appears, with no block the English
 * written in the script. Also: every client key a script uses is in the English catalog, with the same English as the
 * fallback written beside it, and every client key in the catalog is used.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { catalogOf, enablePseudoLocale, runWithLocale } from '../i18n/core.js';
import { clientJson, clientKeys } from '../i18n/client.js';

const STATIC = new URL('./static/', import.meta.url);
const scripts = readdirSync(STATIC).filter((f) => f.endsWith('.js'));
const source = (f: string): string => readFileSync(new URL(f, STATIC), 'utf8');

type TFn = ((key: string, english?: string, params?: Record<string, string | number>) => string) & { lang?: string };

/** Runs static/i18n.js against a page whose JSON block says `block` (null: no block), and returns the T it defines. */
function loadT(block: string | null): TFn {
  const ctx: { document: unknown; T?: TFn } = { document: { getElementById: (id: string) => (id === 'i18n' && block !== null ? { textContent: block } : null) } };
  vm.runInContext(source('i18n.js'), vm.createContext(ctx));
  return ctx.T as TFn;
}
const spanishBlock = (): string => runWithLocale('es', () => clientJson());
const englishBlock = (): string => runWithLocale('en', () => clientJson());

test('T: Spanish from the block, English fallback with none, {name} filled in, lang exposed', () => {
  const es = loadT(spanishBlock());
  assert.equal(es.lang, 'es');
  assert.equal(es('client.desk.skip', 'Skip to content'), 'Saltar al contenido');
  assert.equal(es('client.models.download', 'Download {mb} MB and continue', { mb: 120 }), 'Descargar 120 MB y continuar');
  assert.equal(es('client.no.such.key', 'Fallback {x}', { x: 1 }), 'Fallback 1', 'a key the page lacks reads the English given');
  assert.equal(es('client.no.such.key'), 'client.no.such.key');
  const none = loadT(null);
  assert.equal(none.lang, 'en');
  assert.equal(none('client.desk.skip', 'Skip to content'), 'Skip to content');
  assert.equal(none('client.models.download', 'Download {mb} MB and continue', { mb: 120 }), 'Download 120 MB and continue');
  const broken = loadT('{not json');
  assert.equal(broken('client.desk.skip', 'Skip to content'), 'Skip to content', 'a damaged block is the same as none');
  assert.equal(loadT(englishBlock()).lang, 'en');
});

/** Imports a script as a fresh copy while `T` is (or is not) a global, as when a page loads i18n.js first. */
async function fresh(file: string, t: TFn | null, tag: string): Promise<any> {
  const g = globalThis as { T?: TFn };
  const before = g.T;
  if (t) g.T = t; else delete g.T;
  try { return await import(`${new URL(file, STATIC).href}?${tag}`); } finally { if (before) g.T = before; else delete g.T; }
}

test('desk.js: palette, crumbs, toast and counts in Spanish, and in English with no block', async () => {
  const es = await fresh('desk.js', loadT(spanishBlock()), 'es');
  const en = await fresh('desk.js', null, 'en');
  assert.deepEqual(es.crumbParts('project', 'ferngrid'), ['Proyectos', 'ferngrid']);
  assert.deepEqual(es.crumbParts('discussion', ''), ['Proyectos', 'Debates', 'Debate']);
  assert.deepEqual(en.crumbParts('discussion', ''), ['Projects', 'Discussions', 'Discussion']);
  assert.equal(es.toastText('hacer algo'), 'Marcado «hacer algo»');
  assert.equal(en.toastText('item'), 'Ticked “item”');
  assert.equal(es.capLabel(12), '3 más ›');
  assert.equal(en.capLabel(12), '3 more ›');
  assert.deepEqual(es.paletteDo('ajustes').map((x: { label: string }) => x.label), ['Ir a Ajustes', 'Añadir «ajustes» como idea'], 'a place named exactly comes first');
  assert.deepEqual(es.paletteDo('settings').map((x: { label: string }) => x.label), ['Ir a Ajustes', 'Añadir «settings» como idea'], 'the English name still finds the place');
  assert.deepEqual(es.paletteDo('band').map((x: { label: string }) => x.label), ['Añadir «band» como idea', 'Ir a Bandeja'], 'a partial name keeps the idea first');
  assert.equal(es.paletteDo('').length, 10);
  assert.deepEqual(en.paletteDo('week').map((x: { label: string }) => x.label), ['Add “week” as an idea', 'Go to Last week']);
});

test('graph3d.js: the live card, the stat line and the Find lines in Spanish', async () => {
  const es = await fresh('graph3d.js', loadT(spanishBlock()), 'es');
  const en = await fresh('graph3d.js', null, 'en');
  const p = { name: 'wildlog', onTheGo: false, state: 'parked', waiting: 2, late: 1, days: 9, facts: 12, pages: ['a'] };
  assert.equal(es.announce(p, 'Apps'), 'wildlog, Apps, aparcado, 2 pendientes, con retraso, tocado hace 9 días');
  assert.equal(en.announce(p, 'Apps'), 'wildlog, Apps, parked, 2 waiting, late, touched 9 days ago');
  assert.equal(es.statLine(p), '12 DATOS · 1 PÁGINA · HACE 9 D');
  assert.equal(en.statLine(p), '12 FACTS · 1 PAGE · 9D AGO');
  assert.equal(es.matchLine(3, 'x'), '3 proyectos coinciden con «x»');
  assert.equal(es.matchLine(0, 'x'), 'Ningún proyecto coincide con «x»');
  assert.equal(es.placeLine(1, 'NAS'), '1 proyecto se ejecuta en NAS');
  assert.equal(es.relatedText({ unlabelled: true, name: 'n', words: [] }), 'Un proyecto personal');
});

test('diagrams.js: the sentence is translated for the person and stays English when it is reported', async () => {
  const es = await fresh('diagrams.js', loadT(spanishBlock()), 'es');
  const say = loadT(spanishBlock());
  const raw = "Parse error on line 2:\nExpecting 'SQE', 'DOUBLECIRCLEEND', got 'EOF'";
  assert.equal(es.reword(raw, 'flowchart'), "This diagram couldn't be drawn. Line 2: a bracket opened here isn't closed. The rest of the page is fine.");
  assert.equal(es.reword(raw, 'flowchart', say), 'No se ha podido dibujar este diagrama. Línea 2: hay un paréntesis o corchete abierto aquí que no se cierra. El resto de la página está bien.');
  assert.match(es.reword('boom', 'pie', say), /^No se ha podido dibujar este diagrama: tiene algo/);
});

test('editor-pics.js: the status line in Spanish, with a decimal comma, and in English with no block', async () => {
  const es = await fresh('editor-pics.js', loadT(spanishBlock()), 'es');
  const en = await fresh('editor-pics.js', null, 'en');
  const MB = 1048576;
  const line = { name: 'big.png', before: 5 * MB, after: 1.5 * MB, redrawn: true, fromPhoto: true };
  assert.equal(es.stripText(line), 'big.png · reducida en este dispositivo, 5,0 MB → 1,5 MB · ubicación y datos de la cámara eliminados · Añadida ✓');
  assert.equal(en.stripText(line), 'big.png · made smaller on this device, 5.0 MB → 1.5 MB · location and camera details removed · Added ✓');
  assert.equal(es.redrawPlan({ type: 'image/heic', name: 'a.heic', width: null, height: null, bytes: 1 }).message, 'Este navegador no puede leer imágenes HEIC. Guárdala antes como JPEG.');
});

test('app.js reads its words through T: Spanish with a block, English with none', () => {
  // app.js: the models form button, the update line and the consent banner, run in a small fake page.
  const t = loadT(spanishBlock());
  const radio = { dataset: { mb: '40' } };
  const button = { textContent: '' };
  const form = { querySelector: () => button, querySelectorAll: () => [radio], addEventListener: (_: string, fn: () => void) => { fn(); } };
  const document = {
    body: { dataset: {}, classList: { add() {} }, append() {} },
    querySelectorAll: (s: string) => (s === '[data-models-form]' ? [form] : []),
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({ setAttribute() {}, append() {}, className: '' }),
    addEventListener: () => {},
    documentElement: { classList: { add() {} } },
  };
  const context = { document, T: t, navigator: {}, Element: class {}, Intl, Date, Number, String, Math, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: {} };
  vm.runInNewContext(source('app.js'), context);
  assert.equal(button.textContent, 'Descargar 40 MB y continuar');
  const none = { ...context, T: loadT(null) };
  button.textContent = '';
  vm.runInNewContext(source('app.js'), none);
  assert.equal(button.textContent, 'Download 40 MB and continue');
});

/** Every T('client.…', 'English') call (diagrams.js's reword names its translator `say`) in the scripts: the key and, where the English is a plain quoted string, that text. */
function usedKeys(): { file: string; key: string; english: string | null }[] {
  const out: { file: string; key: string; english: string | null }[] = [];
  for (const file of scripts) {
    const text = source(file);
    for (const m of text.matchAll(/\b(?:T|say)\(\s*'((?:client|copy)\.[\w.]+)'(?:\s*,\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"))?/g)) {
      const raw = m[2] ?? m[3] ?? null;
      out.push({ file, key: m[1]!, english: raw === null ? null : raw.replace(/\\(['"\\])/g, '$1') });
    }
  }
  return out;
}

test('every client key a script uses is in the English catalog, with the English written beside it', () => {
  const en = catalogOf('en');
  const used = usedKeys();
  assert.ok(used.length > 100, `found ${used.length} T() calls`);
  for (const { file, key, english } of used) {
    assert.ok(key in en, `${file} uses ${key}, which is not in src/i18n/en`);
    if (english !== null) assert.equal(english, en[key], `${file}: the English fallback of ${key} differs from the catalog`);
  }
});

test('every client.* key in the catalog is used by a script (no dead words embedded in every page)', () => {
  const used = new Set(usedKeys().map((u) => u.key));
  const dead = clientKeys().filter((k) => k.startsWith('client.') && !used.has(k));
  assert.deepEqual(dead, []);
});

test('the Spanish client catalog keeps the placeholders and has no leftover English markers', () => {
  const en = catalogOf('en'), es = catalogOf('es');
  for (const k of clientKeys()) {
    const e = en[k], s = es[k];
    assert.equal(typeof e, 'string', `${k}: client entries are plain strings (the browser gets one text per key)`);
    assert.equal(typeof s, 'string', `${k} has no Spanish`);
    const names = (x: string) => [...x.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    assert.equal(names(s as string), names(e as string), `${k}: placeholders differ`);
  }
});

test('clientJson is built once per language (en, es) and never cached for the pseudo-locale', () => {
  const en = clientJson();
  assert.equal(runWithLocale('en', () => clientJson()), en);
  const es = runWithLocale('es', () => clientJson());
  assert.notEqual(es, en);
  assert.equal(runWithLocale('es', () => clientJson()), es);
  assert.match(es, /"lang":"es"/);
  enablePseudoLocale(true);
  try {
    const a = runWithLocale('xx', () => clientJson());
    assert.match(a, /⟦/);
    assert.equal(runWithLocale('xx', () => clientJson()) === a, true);
    assert.equal(runWithLocale('en', () => clientJson()), en, 'English is unchanged by the pseudo-locale');
  } finally { enablePseudoLocale(false); }
  assert.equal(clientJson(), en);
});
