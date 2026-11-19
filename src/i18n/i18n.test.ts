import { test } from 'node:test';
import assert from 'node:assert/strict';
import { en } from './en/index.js';
import { es } from './es/index.js';
import { catalogOf, enablePseudoLocale, runWithLocale, t, tIn, currentLocale } from './core.js';
import { tHtml } from './tHtml.js';
import { localeFromAcceptLanguage } from './accept.js';
import { fmt } from './fmt.js';
import { clientJson, jsonForScript, clientKeys } from './client.js';
import { chooseLocale } from './uiLanguage.js';
import { html } from '../web/html.js';
import { readdirSync, readFileSync } from 'node:fs';
import { pastLabel, dueLabel } from '../web/when.js';

const names = (e: unknown): string[] => {
  const texts = typeof e === 'string' ? [e] : Object.values(e as Record<string, string>);
  return [...new Set(texts.flatMap((x) => [...x.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)))].sort();
};

test('every English key exists in Spanish with the same placeholders and plural forms, and the reverse', () => {
  const E = catalogOf('en'), S = catalogOf('es');
  assert.deepEqual(Object.keys(S).sort(), Object.keys(E).sort());
  for (const [k, v] of Object.entries(E)) {
    assert.deepEqual(names(S[k]), names(v), `${k}: placeholders differ`);
    // A plain English `{count}` string may have a Spanish plural object (the decision on plurals: see docs/I18N.md); nothing else may differ in shape.
    const englishCounts = typeof v === 'string' && v.includes('{count}');
    assert.ok(typeof S[k] === typeof v || (englishCounts && typeof S[k] === 'object'), `${k}: plural in one, plain in the other`);
    if (typeof S[k] !== 'string') assert.ok('other' in (S[k] as object), `${k}: no 'other' form`);
    assert.ok(v !== '' && S[k] !== '', `${k}: empty text`);
  }
  assert.equal(Object.keys(en).length, Object.keys(es).length);
});

test('the two language names are the same in both catalogs: each language in its own words', () => {
  for (const l of ['en', 'es'] as const) {
    assert.equal(tIn(l, 'lang.name.en'), 'English');
    assert.equal(tIn(l, 'lang.name.es'), 'Español');
  }
});

test('t: English outside a request, Spanish inside, params filled, plurals by the language', () => {
  assert.equal(currentLocale(), 'en');
  assert.equal(t('shell.nav.inbox'), 'Inbox');
  assert.equal(runWithLocale('es', () => t('shell.nav.inbox')), 'Bandeja');
  assert.equal(t('shell.waiting', { count: 3 }), '3 waiting');
  assert.equal(t('when.dayLate', { count: 1 }), '1 day late');
  assert.equal(t('when.dayLate', { count: 4 }), '4 days late');
  runWithLocale('es', () => {
    assert.equal(t('when.dayLate', { count: 1 }), '1 día de retraso');
    assert.equal(t('when.dayLate', { count: 2 }), '2 días de retraso');
  });
});

test('a key missing in Spanish falls back to English; an unknown key reads as itself; nothing throws', () => {
  const S = catalogOf('es') as Record<string, unknown>;
  const saved = S['shell.nav.week'];
  delete S['shell.nav.week'];
  try {
    assert.equal(runWithLocale('es', () => t('shell.nav.week')), 'Week');
    assert.equal(runWithLocale('es', () => (t as (k: string) => string)('nope.nothing')), 'nope.nothing');
  } finally { S['shell.nav.week'] = saved; }
});

test('tHtml: the catalog text is escaped, the parts are inserted as given', () => {
  const E = catalogOf('en') as Record<string, unknown>;
  E['x.test'] = 'Go to {link} <b>now</b> & {name}';
  try {
    const out = tHtml('x.test' as never, { link: html`<a href="/a">${'<i>'}</a>`, name: '<n>' } as never).value;
    assert.equal(out, 'Go to <a href="/a">&lt;i&gt;</a> &lt;b&gt;now&lt;/b&gt; &amp; &lt;n&gt;');
  } finally { delete E['x.test']; }
  assert.equal(runWithLocale('es', () => tHtml('shell.moved', { address: html`<a>x</a>` }).value), 'Esta memoria ahora está en <a>x</a>. Los cambios que hagas aquí no se copian allí.');
});

test('the pseudo-locale wraps every translated string, and only after tests enable it', () => {
  assert.equal(runWithLocale('xx', () => t('shell.nav.inbox')), 'Inbox', 'not enabled: English');
  enablePseudoLocale(true);
  try {
    assert.equal(runWithLocale('xx', () => t('shell.nav.inbox')), '⟦Inbox⟧');
    assert.equal(runWithLocale('xx', () => t('shell.waiting', { count: 2 })), '⟦2 waiting⟧');
    assert.equal(chooseLocale('xx', 'es'), 'xx');
  } finally { enablePseudoLocale(false); }
  assert.equal(chooseLocale('xx', 'es'), 'es', 'stored xx means nothing in the app');
});

test('Accept-Language: es or es-* first among en/es wins; q ranks; q=0 and others do not count', () => {
  const L = localeFromAcceptLanguage;
  assert.equal(L('es-ES,es;q=0.9,en;q=0.8'), 'es');
  assert.equal(L('es'), 'es');
  assert.equal(L('ES-mx'), 'es');
  assert.equal(L('en-US,en;q=0.9,es;q=0.8'), 'en');
  assert.equal(L('en;q=0.5, es;q=0.9'), 'es');
  assert.equal(L('fr-FR,fr;q=0.9,es;q=0.5,en;q=0.4'), 'es');
  assert.equal(L('es;q=0, en'), 'en');
  assert.equal(L('fr, de;q=0.8'), 'en');
  assert.equal(L('*'), 'en');
  assert.equal(L(''), 'en');
  assert.equal(L(undefined), 'en');
  assert.equal(L('es;q=abc, en;q=0.2'), 'es', 'a broken q reads as 1');
});

test('the stored choice overrides the header; auto follows it', () => {
  assert.equal(chooseLocale('en', 'es-ES'), 'en');
  assert.equal(chooseLocale('es', 'en-US'), 'es');
  assert.equal(chooseLocale('auto', 'es-ES'), 'es');
  assert.equal(chooseLocale(null, 'es-ES'), 'es');
  assert.equal(chooseLocale(null, 'en-US'), 'en');
  assert.equal(chooseLocale('garbage', 'es'), 'es');
});

test('fmt: dates, numbers and sizes follow the locale', () => {
  const d = '2026-11-19T10:05:00Z';
  assert.equal(fmt.date(d), '19 Nov 2026');
  assert.equal(runWithLocale('es', () => fmt.date(d)), '19 nov 2026');
  assert.match(fmt.dateTime(d), /^19 Nov 2026, \d\d:\d\d$/);
  assert.equal(fmt.size(1_258_291), '1.2 MB');
  assert.equal(runWithLocale('es', () => fmt.size(1_258_291)), '1,2 MB');
  assert.equal(fmt.size(2048), '2 KB');
  assert.equal(fmt.number(1234.5), '1,234.5');
  assert.equal(runWithLocale('es', () => fmt.number(12.5)), '12,5');
});

test('relative times and due dates go through the locale', () => {
  const now = new Date('2026-11-19T12:00:00Z');
  assert.equal(pastLabel('2026-11-19T11:59:40Z', now), 'just now');
  assert.equal(pastLabel('2026-11-19T11:30:00Z', now), '30 min ago');
  assert.equal(pastLabel('2026-11-16T11:30:00Z', now), '3 days ago');
  runWithLocale('es', () => {
    assert.equal(pastLabel('2026-11-19T11:59:40Z', now), 'hace un momento');
    assert.equal(pastLabel('2026-11-19T11:30:00Z', now), 'hace 30 min');
    assert.equal(pastLabel('2026-11-18T08:00:00Z', now), 'ayer');
    assert.equal(pastLabel('2026-11-16T11:30:00Z', now), 'hace 3 días');
    assert.equal(pastLabel('2026-10-26T11:30:00Z', now), '26 oct');
    assert.equal(dueLabel('2026-11-18', '2026-11-19').text, '1 día de retraso');
    assert.equal(dueLabel('2026-11-21', '2026-11-19').text, 'vence el sáb');
  });
  assert.equal(dueLabel('2026-11-21', '2026-11-19').text, 'due Sat');
});

test('the browser JSON block cannot break out of its script element', () => {
  const nasty = '</script><script>alert(1)</script><!-- & \u2028';
  const out = jsonForScript({ t: { k: nasty } });
  assert.doesNotMatch(out, /[<>&\u2028\u2029]/);
  assert.deepEqual(JSON.parse(out), { t: { k: nasty } });
  const C = catalogOf('en') as Record<string, unknown>;
  C['copy.done'] = nasty;
  try {
    const json = clientJson();
    assert.doesNotMatch(json, /</);
    assert.equal(JSON.parse(json).t['copy.done'], nasty);
  } finally { C['copy.done'] = 'Copied'; }
});

test('the browser JSON carries every client key (client.* and copy.*) on every page, in the request language', () => {
  const parsed = runWithLocale('es', () => JSON.parse(clientJson()));
  assert.equal(parsed.lang, 'es');
  assert.deepEqual(Object.keys(parsed.t), clientKeys());
  assert.ok(clientKeys().includes('copy.done'));
  assert.equal(parsed.t['copy.done'], 'Copiado');
});

test('types: a missing or wrong param, and an unknown key, do not compile', () => {
  // @ts-expect-error a key with a {count} needs its params
  const a = () => t('shell.waiting');
  // @ts-expect-error the param is named count
  const b = () => t('shell.waiting', { n: 1 });
  // @ts-expect-error no such key
  const c = () => t('shell.nope');
  // @ts-expect-error a key without params takes none
  const d = () => t('shell.nav.inbox', { count: 1 });
  void [a, b, c, d];
});

test('no key is defined in two area files: the area sizes add up to the merged catalogs (en and es)', async () => {
  for (const [dir, suffix, merged] of [['en', '', en], ['es', '_es', es]] as const) {
    const files = readdirSync(new URL(`./${dir}/`, import.meta.url)).filter((f) => f.endsWith('.ts') && f !== 'index.ts' && !f.endsWith('.test.ts'));
    assert.ok(files.length >= 13, `${dir}: every area has its file (${files.join(', ')})`);
    let sum = 0;
    for (const f of files) {
      const mod = await import(`./${dir}/${f.replace(/\.ts$/, '.js')}`) as Record<string, object>;
      const area = f.replace(/\.ts$/, '');
      const cat = mod[area + suffix];
      assert.ok(cat, `${dir}/${f} exports ${area + suffix}`);
      sum += Object.keys(cat).length;
    }
    assert.equal(sum, Object.keys(merged).length, `${dir}: a key is defined in two area files`);
  }
});

test('every area named in docs/I18N.md has an empty-or-filled file and an index line in both languages', () => {
  const areas = ['inbox', 'settings', 'setup', 'projects', 'review', 'data', 'auth', 'discussions', 'skills', 'client', 'errPages', 'errProjects', 'errSkills', 'errTidy', 'errDisc'];
  for (const a of areas) {
    for (const [dir, name] of [['en', a], ['es', `${a}_es`]]) {
      const index = readFileSync(new URL(`./${dir}/index.ts`, import.meta.url), 'utf8');
      assert.match(index, new RegExp(`import \\{ ${name} \\} from './${a}\\.js'`), `${dir}/index.ts imports ${a}`);
      assert.match(index, new RegExp(`\\.\\.\\.${name}\\b`), `${dir}/index.ts spreads ${a}`);
    }
  }
});

test('the i18n layer does not import the web layer', () => {
  const walk = (dir: URL): URL[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [new URL(e.name, dir)] : []));
  for (const f of walk(new URL('./', import.meta.url))) assert.doesNotMatch(readFileSync(f, 'utf8'), /from '(\.\.\/)+web\//, `${f.pathname} imports the web layer`);
});

test('a Spanish plural object for an English plain {count} string: one and other forms, English unchanged', () => {
  assert.equal(t('shell.waiting', { count: 1 }), '1 waiting');
  assert.equal(t('shell.waiting', { count: 2 }), '2 waiting');
  runWithLocale('es', () => {
    assert.equal(t('shell.waiting', { count: 0 }), '0 pendientes');
    assert.equal(t('shell.waiting', { count: 1 }), '1 pendiente');
    assert.equal(t('shell.waiting', { count: 2 }), '2 pendientes');
  });
});

test('fmt.size keeps the English output the app always had, and Spanish swaps only the decimal comma', () => {
  const cases: [number, string, string][] = [
    [0, '0 KB', '0 KB'], [512, '1 KB', '1 KB'], [1024, '1 KB', '1 KB'], [812 * 1024, '812 KB', '812 KB'], [1048575, '1024 KB', '1024 KB'],
    [1048576, '1.0 MB', '1,0 MB'], [1.2 * 1048576, '1.2 MB', '1,2 MB'], [1536 * 1048576, '1536.0 MB', '1536,0 MB'], [123456789012, '117737.6 MB', '117737,6 MB'],
  ];
  for (const [bytes, en, es] of cases) {
    // The line the app printed before the i18n core (settingsViews sizeText).
    const before = bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
    assert.equal(fmt.size(bytes), before, `English ${bytes}`);
    assert.equal(fmt.size(bytes), en);
    assert.equal(runWithLocale('es', () => fmt.size(bytes)), es);
  }
  assert.equal(fmt.number(12345.6), '12,345.6');
  assert.equal(runWithLocale('es', () => fmt.number(12345.6)), '12.345,6');
});

test('under the pseudo-locale locale-built text is wrapped too: fmt, calendar and relative times, localParts', async () => {
  const { localParts, shortDay } = await import('../timezone.js');
  const { pastLabel, dueLabel } = await import('../web/when.js');
  enablePseudoLocale(true);
  try {
    runWithLocale('xx', () => {
      assert.match(fmt.date('2026-11-19T10:00:00Z'), /^⟦.*⟧$/);
      assert.match(fmt.dateTime('2026-11-19T10:00:00Z'), /^⟦.*⟧$/);
      assert.match(fmt.size(5 * 1048576), /^⟦.*⟧$/);
      assert.match(fmt.number(3.5), /^⟦.*⟧$/);
      assert.match(shortDay('2026-11-19T10:00:00Z', new Date('2026-12-01T00:00:00Z')), /^19 ⟦.*⟧$/);
      const p = localParts('2026-11-19T10:00:00Z');
      for (const w of [p.weekday, p.weekdayShort, p.month, p.monthShort]) assert.match(w, /^⟦.*⟧$/);
      assert.match(pastLabel('2026-10-01T10:00:00Z', new Date('2026-11-19T10:00:00Z')), /^⟦.*⟧$/, 'an old date is calendar text');
      assert.match(dueLabel('2026-11-23', '2026-11-19').text, /^⟦due ⟧⟦.*⟧$|^⟦.*⟧$/);
    });
  } finally { enablePseudoLocale(false); }
});

test('localParts month and weekday abbreviations come from Intl in Spanish, three letters in English', async () => {
  const { localParts } = await import('../timezone.js');
  process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';
  assert.equal(localParts('2026-09-04T10:00:00Z').monthShort, 'Sep');
  assert.equal(localParts('2026-09-04T10:00:00Z').weekdayShort, 'Fri');
  runWithLocale('es', () => {
    const p = localParts('2026-09-04T10:00:00Z');
    assert.equal(p.monthShort, 'sept');
    assert.equal(p.weekdayShort, 'vie');
    assert.equal(p.weekday, 'viernes');
    assert.equal(localParts('2026-11-04T10:00:00Z').weekdayShort, 'mié');
  });
});

test('tHtml under the pseudo-locale wraps each text piece, so a link inside a sentence leaves no unclosed bracket', () => {
  enablePseudoLocale(true);
  try {
    const out = runWithLocale('xx', () => tHtml('shell.moved', { address: html`<a href="/x">brain.example</a>` })).value;
    assert.equal(out, '⟦This brain now lives at ⟧<a href="/x">brain.example</a>⟦. Changes made here are not copied there.⟧');
    assert.equal((out.match(/⟦/g) ?? []).length, (out.match(/⟧/g) ?? []).length);
  } finally { enablePseudoLocale(false); }
  assert.equal(tHtml('shell.moved', { address: 'a<b' }).value, 'This brain now lives at a&lt;b. Changes made here are not copied there.');
});

test('chooseLocale: the system locale decides Automatic before the header; a stored choice beats it', () => {
  assert.equal(chooseLocale('auto', 'en-US', 'es-ES'), 'es');
  assert.equal(chooseLocale(null, 'es', 'en_GB'), 'en');
  assert.equal(chooseLocale('auto', 'es', 'fr-FR'), 'es');
  assert.equal(chooseLocale('auto', 'en', ''), 'en');
  assert.equal(chooseLocale('en', 'es', 'es-ES'), 'en');
  assert.equal(chooseLocale('es', 'en', 'en-US'), 'es');
});

test('docs/I18N.md assigns every non-test src/web/*.ts file to exactly one area', () => {
  const doc = readFileSync(new URL('../../docs/I18N.md', import.meta.url), 'utf8');
  const table = doc.slice(doc.indexOf('| Area ('), doc.indexOf('\nPrefixes:'));
  const seen = new Map<string, string[]>();
  for (const row of table.split('\n').filter((r) => r.startsWith('| ') && !r.startsWith('| Area') && !r.startsWith('| ---'))) {
    const [, area, files] = row.split('|').map((c) => c.trim());
    for (const f of files!.matchAll(/`([^`]+\.ts)`/g)) seen.set(f[1]!, [...(seen.get(f[1]!) ?? []), area!]);
  }
  const real = readdirSync(new URL('../web/', import.meta.url)).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  assert.deepEqual(real.filter((f) => !seen.has(f)), [], 'files with no area');
  assert.deepEqual([...seen.keys()].filter((f) => !real.includes(f)), [], 'files in the table that do not exist');
  assert.deepEqual([...seen].filter(([, a]) => a.length > 1).map(([f]) => f), [], 'files in two areas');
});

test('under the pseudo-locale a translation passed into another t() does not nest brackets; tHtml keeps its pieces apart', () => {
  enablePseudoLocale(true);
  try {
    runWithLocale('xx', () => {
      assert.equal(t('shell.waiting', { count: 2 }), '⟦2 waiting⟧');
      const inner = t('shell.nav.inbox');
      assert.equal(inner, '⟦Inbox⟧');
      assert.equal(t('shell.goto.tools', { computer: inner }), '⟦Settings › Tools on Inbox⟧');
      assert.equal(tHtml('shell.goto.tools', { computer: html`<b>${inner}</b>` }).value, '⟦Settings › Tools on ⟧<b>⟦Inbox⟧</b>');
    });
  } finally { enablePseudoLocale(false); }
});

test('computerName follows the language while thisComputer stays English', async () => {
  const { setComputer, thisComputer, computerName, ComputerName } = await import('../desktop/computer.js');
  setComputer('darwin');
  assert.equal([thisComputer(), computerName(), ComputerName()].join('|'), 'this Mac|this Mac|This Mac');
  assert.equal(runWithLocale('es', () => [thisComputer(), computerName(), ComputerName()].join('|')), 'this Mac|este Mac|Este Mac');
  setComputer('win32');
  assert.equal(runWithLocale('es', () => computerName()), 'este ordenador');
  assert.equal(thisComputer(), 'this computer');
  setComputer('darwin');
});
