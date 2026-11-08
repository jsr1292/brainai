import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphFind, GraphOverview, GraphProject } from '../graph/data.js';

interface Camera { yaw: number; pitch: number; dist: number; fx: number; fy: number; fz: number }
interface Quality { record(workMs: number): void; level: 0 | 1 | 2 | 3; dpr(base: number): number; dust: number; floorTicks: boolean }
interface Box { x: number; y: number; w: number; h: number; id?: string; body?: 1 }
type Want = 'hover' | 'found' | 'related' | 'zoom';
interface Scene {
  W: number; H: number; small: boolean; cx: number; taken: Box[]; marks: { id: string; x: number; y: number; r: number }[];
  you: { x: number; y: number; top?: number } | null;
  nodes: { id: string; x: number; y: number; z: number; rad: number; want: Want; a: number; name: string | null; stat: string }[];
  places: { id: string; x: number; y: number; d: number; label: string; want: boolean; a: number }[];
  callouts: { id: string; x: number; y: number; rad: number; col: string; a: number; label: string; next: string }[];
  rings: { id: string; text: string; col: string; pts: { x: number; y: number; z: number; front: boolean }[] }[];
  extra?: unknown[];
}
interface Shown extends Box { id: string; kind: string; text?: string; stat?: string; from?: { x: number; y: number }; to?: { x: number; y: number }; next?: string; ly?: number }
interface Ink { bg: string; glow: string; glowAlpha: number; text: string; muted: string; faint: string; line: string; star: string; hot: string; spark: string; late: string; soon: string; core: [string, string]; minAlpha: number }
interface Graph3d {
  AREA_STYLE: Record<'apps' | 'home' | 'tools' | 'work' | 'personal' | 'unsorted', { colour: string; radius: number; tilt: number; node: number }>;
  nameAngle(name: string): number;
  layoutOrbit(names: string[]): { name: string; angle: number; lane: 0 | 1 }[];
  waitTicks(waiting: number, late: number): { late: number; amber: number; more: number };
  createQuality(): Quality;
  approach(current: number, target: number, dt: number, halfLife?: number): number;
  needsFrame(s: { dragging: boolean; pinching: boolean; flying: boolean; booting: boolean; turning: boolean }, cam: Camera, tgt: Camera): boolean;
  turnAllowed(s: { userOn: boolean; mobile: boolean; reducedMotion: boolean; sinceInputMs: number; touched: boolean }): boolean;
  BOOT_MS: number;
  bootWanted(storage: { getItem(k: string): string | null } | null, reducedMotion: boolean): boolean;
  keyAction(key: string, target: { tagName: string; isContentEditable?: boolean }, onWindow: boolean): string | null;
  announce(p: GraphProject, areaLabel: string): string;
  normalWords(s: string): string;
  localMatches(data: GraphOverview, q: string): Set<number>;
  relatedText(r: { name: string; words: string[]; unlabelled: boolean }): string;
  matchLine(n: number, q: string): string;
  placeLine(n: number, label: string): string;
  boxFree(b: Box, taken: Box[], W: number, H: number): boolean;
  focusBlock(sx: number, sy: number, rad: number, w: number, W: number): { x: number; y: number };
  sceneLabels(sc: Scene, measure: (text: string, font: string) => number): Shown[];
  START_CAMERA: Camera;
  viewFrame(W: number, H: number): { small: boolean; C: { x: number; y: number }; F: number };
  project(p: { x: number; y: number; z: number }, cam: Camera, C: { x: number; y: number }, F: number): { x: number; y: number; z: number; s: number };
  orbitPoint(o: { radius: number; tilt: number; node: number }, t: number, k?: number): { x: number; y: number; z: number };
  nodeRadius(p: { facts: number; state: string }): number;
  focusX(W: number, o: { sheet: boolean; insetRight: number }): number;
  hoverReplaces(focused: boolean, docked: boolean): boolean;
  createFinder(fetchJson: (url: string, signal: AbortSignal) => Promise<GraphFind>): { ask(q: string): Promise<GraphFind | null>; cancel(): void };
  stepIndex(at: number, dir: 'prev' | 'next', n: number): number;
  findTarget(server: string[], local: string[], drawn: Set<string>): string | null;
  nameShown(unlabelled: boolean, why: { hover: boolean; focus: boolean; found: boolean }): boolean;
  nameMatch(name: string, q: string): boolean;
  statLine(p: { facts: number; pages: string[]; days: number }): string;
  WINDOW_INK: Ink;
  WINDOW_INKS: { dark: Ink; paper: Ink };
  AREA_PAPER: Record<'apps' | 'home' | 'tools' | 'work' | 'personal' | 'unsorted', string>;
  areaColour(area: string, dark: boolean): string;
  setWindowTheme(dark: boolean): void;
  textAlpha(a: number): number;
  focusBody(sx: number, sy: number, rad: number, id: string): Box;
  focusRequests(f: { x: number; own: string; pages: { text: string; q: { x: number; y: number } }[]; decisions: { text: string; q: { x: number; y: number } }[] }, W: number, measure: (t: string, f: string) => number): unknown[];
  threadLook<T>(a: T, b: T, s: { focus: T | null; hover: T | null; lit: Set<T> | null }): 'on' | 'faint' | null;
}
const g = await import(new URL('./static/graph3d.js', import.meta.url).href) as Graph3d;
const graphSaturation = (hex: string) => { const a = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), hi = Math.max(...a), lo = Math.min(...a), l = (hi + lo) / 2; return hi === lo ? 0 : (hi - lo) / (1 - Math.abs(2 * l - 1)); };

const NAMES = ['dossiers', 'gps-tracklog', 'pine-lodge', 'inflow', 'calypsomods', 'bookshelf-ha', 'wildlog', 'casa-azul-garden', 'castle3d', 'csvmerge', 'odds-and-ends', 'brainai'];
const gaps = (lay: { angle: number; lane: number }[], lane: number) => {
  const a = lay.filter((x) => x.lane === lane).map((x) => x.angle).sort((x, y) => x - y);
  return a.map((v, i) => (i + 1 < a.length ? a[i + 1]! - v : a[0]! + 2 * Math.PI - v));
};

test('the area styles are the mockup\'s, with Tools & AI cyan and a grey Unsorted ring', () => {
  assert.deepEqual(g.AREA_STYLE.apps, { colour: '#5ee0a0', radius: 1.0, tilt: 0.28, node: 0 });
  assert.deepEqual(g.AREA_STYLE.home, { colour: '#d0c8b8', radius: 1.16, tilt: 1.05, node: 1.7 });
  assert.deepEqual(g.AREA_STYLE.work, { colour: '#ad94ff', radius: 0.84, tilt: -0.55, node: 0.4 });
  assert.deepEqual(g.AREA_STYLE.personal, { colour: '#f38cc0', radius: 0.66, tilt: 0.78, node: 3.6 });
  assert.deepEqual(g.AREA_STYLE.tools, { colour: '#6fd3f5', radius: 0.92, tilt: -0.18, node: 2.6 });
  assert.deepEqual(g.AREA_STYLE.unsorted, { colour: '#8a94a6', radius: 1.32, tilt: 0.12, node: 5.0 });
});

test('the dark Graph draws Home in stone, and paper beads carry no accent or link blue', () => {
  assert.ok(graphSaturation(g.AREA_STYLE.home.colour) <= .25);
  assert.ok(ratio(rgb(g.AREA_STYLE.home.colour), rgb('#02050a')) >= 4.5);
  assert.equal(g.WINDOW_INKS.paper.spark, '#3a3833');
});

test('a project keeps its place when others are added', () => {
  const before = new Map(g.layoutOrbit(NAMES).map((x) => [x.name, x.angle]));
  const after = new Map(g.layoutOrbit([...NAMES, 'newcomer']).map((x) => [x.name, x.angle]));
  assert.ok(NAMES.filter((n) => before.get(n) === after.get(n)).length >= 10);
  const shuffled = [...NAMES].reverse();
  assert.deepEqual(new Map(g.layoutOrbit(shuffled).map((x) => [x.name, x.angle])), before);
  for (const a of before.values()) assert.ok(a >= 0 && a < 2 * Math.PI);
  const n = g.nameAngle('wildlog');
  assert.ok(n >= 0 && n < 2 * Math.PI);
  assert.equal(g.nameAngle('wildlog'), n);
});

test('more than 24 projects in an area use two lanes, and neighbours keep the minimum gap', () => {
  const thirty = Array.from({ length: 30 }, (_, i) => `project-${i}`);
  const lay = g.layoutOrbit(thirty);
  assert.deepEqual(new Set(lay.map((x) => x.lane)), new Set([0, 1]));
  for (const lane of [0, 1]) {
    const per = lay.filter((x) => x.lane === lane).length;
    const min = Math.min((2 * Math.PI) / 48, (2 * Math.PI) / (2 * per));
    for (const gap of gaps(lay, lane)) assert.ok(gap >= min - 1e-9, `lane ${lane} gap ${gap} < ${min}`);
  }
  const twentyFour = g.layoutOrbit(thirty.slice(0, 24));
  assert.ok(twentyFour.every((x) => x.lane === 0));
  for (const gap of gaps(twentyFour, 0)) assert.ok(gap >= (2 * Math.PI) / 48 - 1e-9);
});

test('waiting ticks show 8 at most, late ones first', () => {
  assert.deepEqual(g.waitTicks(11, 2), { late: 2, amber: 6, more: 3 });
  assert.deepEqual(g.waitTicks(3, 0), { late: 0, amber: 3, more: 0 });
  assert.deepEqual(g.waitTicks(10, 9), { late: 8, amber: 0, more: 2 });
  assert.deepEqual(g.waitTicks(0, 0), { late: 0, amber: 0, more: 0 });
});

test('quality steps down once per slow window, in order, and never back up', () => {
  const q = g.createQuality();
  assert.deepEqual([q.level, q.dpr(3), q.dust, q.floorTicks], [0, 2, 1, true]);
  for (let i = 0; i < 30; i++) q.record(14);
  assert.equal(q.level, 1);
  assert.equal(q.dpr(3), 1.5);
  assert.equal(q.dpr(1), 1);
  for (let i = 0; i < 30; i++) q.record(14);
  assert.equal(q.level, 2);
  assert.equal(q.dust, 0.5);
  for (let i = 0; i < 30; i++) q.record(14);
  assert.equal(q.level, 3);
  assert.equal(q.floorTicks, false);
  for (let i = 0; i < 90; i++) q.record(4);
  assert.equal(q.level, 3);
  const fresh = g.createQuality();
  for (let i = 0; i < 30; i++) fresh.record(5);
  assert.equal(fresh.level, 0);
});

test('motion is the same at 30, 60 and 120 frames a second', () => {
  const run = (hz: number) => { let v = 0; for (let i = 0; i < hz; i++) v = g.approach(v, 1, 1 / hz); return v; };
  assert.ok(Math.abs(run(30) - run(60)) < 1e-9);
  assert.ok(Math.abs(run(60) - run(120)) < 1e-9);
  assert.ok(Math.abs(g.approach(0, 1, 0.13) - 0.5) < 1e-12);
});

test('nothing keeps the loop alive once the camera has settled', () => {
  const cam = { yaw: 0.5, pitch: -0.58, dist: 3.6, fx: 0, fy: 0, fz: 0 };
  const idle = { dragging: false, pinching: false, flying: false, booting: false, turning: false };
  assert.equal(g.needsFrame(idle, cam, { ...cam }), false);
  assert.equal(g.needsFrame(idle, cam, { ...cam, yaw: 0.5 + 5e-4 }), false);
  assert.equal(g.needsFrame({ ...idle, flying: true }, cam, cam), true);
  assert.equal(g.needsFrame(idle, cam, { ...cam, dist: 3 }), true);
});

test('Turn slowly: off on the phone until asked, stops 30 s after input on the Mac, never with reduced motion', () => {
  const base = { userOn: true, mobile: false, reducedMotion: false, sinceInputMs: 1000, touched: false };
  assert.equal(g.turnAllowed(base), true);
  assert.equal(g.turnAllowed({ ...base, sinceInputMs: 30_001 }), false);
  assert.equal(g.turnAllowed({ ...base, userOn: false }), false);
  assert.equal(g.turnAllowed({ ...base, reducedMotion: true }), false);
  assert.equal(g.turnAllowed({ ...base, mobile: true }), false);
  assert.equal(g.turnAllowed({ ...base, mobile: true, touched: true }), true);
  assert.equal(g.turnAllowed({ ...base, mobile: true, touched: true, reducedMotion: true }), false);
});

test('the boot plays once per browser session and never with reduced motion', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null };
  assert.equal(g.BOOT_MS, 1200);
  assert.equal(g.bootWanted(storage, false), true);
  assert.equal(g.bootWanted(storage, true), false);
  store.set('graph-booted', '1');
  assert.equal(g.bootWanted(storage, false), false);
  assert.equal(g.bootWanted(null, false), false);
  assert.equal(g.bootWanted({ getItem: () => { throw new Error('denied'); } }, false), false);
});

test('single-key shortcuts are ignored in a field or on a button', () => {
  assert.equal(g.keyAction('r', { tagName: 'INPUT' }, true), null);
  assert.equal(g.keyAction('+', { tagName: 'BUTTON' }, true), null);
  assert.equal(g.keyAction('ArrowRight', { tagName: 'DIV' }, true), 'next');
  assert.equal(g.keyAction('Escape', { tagName: 'DIV' }, false), null);
  assert.equal(g.keyAction('x', { tagName: 'DIV', isContentEditable: true }, true), null);
  const keys: [string, string][] = [['ArrowLeft', 'prev'], ['ArrowUp', 'tiltUp'], ['ArrowDown', 'tiltDown'], ['+', 'zoomIn'], ['=', 'zoomIn'], ['-', 'zoomOut'], ['−', 'zoomOut'], ['Enter', 'select'], ['Escape', 'back'], ['r', 'related'], ['R', 'related']];
  for (const [k, a] of keys) assert.equal(g.keyAction(k, { tagName: 'DIV' }, true), a, k);
  assert.equal(g.keyAction('q', { tagName: 'DIV' }, true), null);
});

const proj = (p: Partial<GraphProject>): GraphProject => ({
  name: 'x', area: 'apps', state: 'open', onTheGo: false, unlabelled: false, oneLiner: null, next: null, facts: 0, pages: [], waiting: 0, late: 0, days: 0, runsOn: [], ...p,
});

test('the card announcement reads like a sentence', () => {
  assert.equal(g.announce(proj({ name: 'wildlog', waiting: 1, late: 1, days: 9 }), 'Apps'), 'wildlog, Apps, 1 waiting, late, touched 9 days ago');
  assert.equal(g.announce(proj({ name: 'career', area: 'personal', onTheGo: true, waiting: 2, days: 5 }), 'Personal'), 'career, Personal, on the go, 2 waiting, touched 5 days ago');
  assert.equal(g.announce(proj({ name: 'a', state: 'idea', days: 0 }), 'Apps'), 'a, Apps, idea, touched today');
  assert.equal(g.announce(proj({ name: 'b', state: 'parked', days: 1, waiting: 3, late: 2 }), 'Work'), 'b, Work, parked, 3 waiting, 2 late, touched yesterday');
});

test('a related Personal project is never named on another project\'s card', () => {
  assert.equal(g.relatedText({ name: 'finances', words: ['banco'], unlabelled: true }), 'A Personal project');
  assert.equal(g.relatedText({ name: 'brainai', words: ['backups', 'nas'], unlabelled: false }), 'brainai: backups, nas');
  assert.equal(g.relatedText({ name: 'outline', words: [], unlabelled: false }), 'outline');
});

test('result lines say how many match', () => {
  assert.equal(g.matchLine(4, 'backups'), '4 projects match “backups”');
  assert.equal(g.matchLine(1, 'backups'), '1 project matches “backups”');
  assert.equal(g.matchLine(0, 'backups'), 'No project matches “backups”');
  assert.equal(g.placeLine(3, 'Mini PC'), '3 projects run on Mini PC');
  assert.equal(g.placeLine(1, 'Mini PC'), '1 project runs on Mini PC');
});

test('Find lights projects by name, one-liner, page titles, place labels and thread words, accents ignored', () => {
  const data: GraphOverview = {
    projects: [
      proj({ name: 'lanes', oneLiner: 'Fútbol blocks' }),
      proj({ name: 'brainai', pages: ['Runbook'], runsOn: ['minipc'] }),
      proj({ name: 'outline' }),
      proj({ name: 'wildlog' }),
    ],
    threads: [{ a: 2, b: 3, strength: 1, links: 2, words: ['restic', 'nas'] }],
    profileFacts: 0,
    places: [{ id: 'minipc', label: 'Mini PC' }],
  };
  assert.equal(g.normalWords('Fútbol: Lanes-blocks!'), 'futbol lanes blocks');
  assert.deepEqual([...g.localMatches(data, 'futbol')], [0]);
  assert.deepEqual([...g.localMatches(data, 'runbook')], [1]);
  assert.deepEqual([...g.localMatches(data, 'mini pc')], [1]);
  assert.deepEqual([...g.localMatches(data, 'restic')].sort(), [2, 3]);
  assert.deepEqual([...g.localMatches(data, 'wild')], [3]);
  assert.deepEqual([...g.localMatches(data, '  ')], []);
});

test('a stale Find reply is ignored and the earlier request is aborted', async () => {
  const calls: { url: string; signal: AbortSignal; resolve: (v: GraphFind) => void }[] = [];
  const f = g.createFinder((url, signal) => new Promise((resolve) => calls.push({ url, signal, resolve })));
  const first = f.ask('back');
  const second = f.ask('backups');
  assert.equal(calls[0]!.signal.aborted, true);
  assert.equal(calls[1]!.url, '/graph/find.json?q=backups');
  calls[1]!.resolve({ q: 'backups', projects: [{ name: 'brainai', hits: 3 }] });
  calls[0]!.resolve({ q: 'back', projects: [] });
  assert.equal(await first, null);
  assert.deepEqual((await second)!.projects.map((p) => p.name), ['brainai']);
  const failing = g.createFinder(() => Promise.reject(new DOMException('aborted', 'AbortError')));
  assert.equal(await failing.ask('x'), null);
});

test('← and → step through the projects, and do nothing when none are drawn', () => {
  assert.equal(g.stepIndex(-1, 'next', 3), 0);
  assert.equal(g.stepIndex(-1, 'prev', 3), 2);
  assert.equal(g.stepIndex(2, 'next', 3), 0);
  assert.equal(g.stepIndex(0, 'prev', 3), 2);
  assert.equal(g.stepIndex(-1, 'next', 0), -1, 'an empty brain: no step, no NaN');
  assert.equal(g.stepIndex(-1, 'prev', 0), -1);
});

test('Enter in Find flies to the first hit that is drawn: the server\'s order, then the local matches', () => {
  const drawn = new Set(['outline', 'brainai', 'wildlog']);
  assert.equal(g.findTarget(['old-archived', 'outline'], ['wildlog'], drawn), 'outline', 'an undrawn top hit is passed over');
  assert.equal(g.findTarget(['old-archived'], ['wildlog'], drawn), 'wildlog', 'no server hit drawn: the first local match');
  assert.equal(g.findTarget([], ['brainai', 'wildlog'], drawn), 'brainai');
  assert.equal(g.findTarget(['gone'], ['gone-too'], drawn), null);
});

test('an unpinned Personal project is named only on hover, when selected or found, never when a place lights it', () => {
  const none = { hover: false, focus: false, found: false };
  assert.equal(g.nameShown(false, none), true, 'other projects are always named');
  assert.equal(g.nameShown(true, none), false, 'lit by a place diamond: still unnamed');
  assert.equal(g.nameShown(true, { ...none, hover: true }), true);
  assert.equal(g.nameShown(true, { ...none, focus: true }), true);
  assert.equal(g.nameShown(true, { ...none, found: true }), true);
});

test('Find on a place label or a page title lights an unpinned Personal project but leaves it unnamed', () => {
  const data: GraphOverview = {
    projects: [proj({ name: 'garden-plot', area: 'personal', unlabelled: true, runsOn: ['mac'], pages: ['Seed list'] })],
    threads: [], profileFacts: 0, places: [{ id: 'mac', label: 'Mac' }],
  };
  assert.deepEqual([...g.localMatches(data, 'mac')], [0], 'still lit, with its brackets, as the Mac diamond lights it');
  const named = (q: string) => g.nameShown(true, { hover: false, focus: false, found: g.nameMatch('garden-plot', q) });
  assert.equal(named('mac'), false, 'a place label does not name it');
  assert.equal(named('seed'), false, 'nor does a page title');
  assert.equal(named('garden'), true, 'its own name does');
  assert.equal(named('Garden PLOT'), true);
  assert.equal(named('  '), false);
  // The page part asks the same of what Find typed, not of what it lit.
  assert.match(src, /const named = [^\n]*found: [^\n]*nameMatch\(n\.p\.name, findQ\)/);
});

test('a project\'s counts line leaves an empty part out, never shows 0', () => {
  assert.equal(g.statLine({ facts: 0, pages: [], days: 0 }), 'TODAY');
  assert.equal(g.statLine({ facts: 12, pages: [], days: 3 }), '12 FACTS · 3D AGO');
  assert.equal(g.statLine({ facts: 1, pages: ['Runbook'], days: 1 }), '1 FACT · 1 PAGE · 1D AGO');
  assert.equal(g.statLine({ facts: 0, pages: ['a', 'b'], days: 0 }), '2 PAGES · TODAY');
  assert.doesNotMatch(src, /\$\{p\.facts\} FACTS/);
});

test('while Find is on, the threads between the found projects are drawn bright, so they read as a group', () => {
  const [a, b, c] = ['a', 'b', 'c'];
  const none = { focus: null, hover: null, lit: null };
  assert.equal(g.threadLook(a, b, none), 'faint', 'overview: every thread faint');
  assert.equal(g.threadLook(a, b, { ...none, hover: a }), 'on');
  assert.equal(g.threadLook(a, b, { ...none, lit: new Set([a, b]) }), 'on', 'between two found projects');
  assert.equal(g.threadLook(a, c, { ...none, lit: new Set([a, b]) }), null, 'to one outside the group: hidden');
  assert.equal(g.threadLook(a, c, { ...none, lit: new Set([a, b]), hover: c }), 'on');
  assert.equal(g.threadLook(a, b, { ...none, focus: c, lit: new Set([a, b]) }), null, 'flown in: only the project\'s own');
  assert.equal(g.threadLook(a, c, { ...none, focus: c }), 'on');
});

// ---- Source checks of the page part ----
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./static/graph3d.js', import.meta.url), 'utf8');
/** The body of `function name(` up to its matching closing brace. */
function body(name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `no function ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unclosed ${name}`);
}

test('the script stays one small file with no library', () => {
  // The spec's estimate is about 30–40 KB; everything section 15 draws came to about 45 KB, keeping every label off
  // every other label added about 4 KB, and the polish round (one placement pass for all text, the found group's
  // threads and lines, pages and decisions round the project) leaves room up to 64 KB, about 20 KB compressed; the
  // window's second palette (paper) and live re-theming add about 2 KB, so 68 KB.
  assert.ok(Buffer.byteLength(src) <= 68 * 1024, `${Buffer.byteLength(src)} bytes`);
  assert.doesNotMatch(src, /^\s*import\s/m);
  assert.doesNotMatch(src, /https?:/);
});

test('only wake() asks for frames', () => {
  assert.equal(src.split('requestAnimationFrame(').length - 1, 1);
  assert.match(body('wake'), /requestAnimationFrame\(/);
});

test('the window is unhidden and drawn in one go', () => {
  const show = body('show');
  const unhide = show.search(/\.hidden = false|removeAttribute\('hidden'\)/);
  const on = show.indexOf("classList.add('graph-on')");
  const draw = show.search(/\bdraw\(/);
  const hideList = show.search(/list\.hidden = true|list\.setAttribute\('hidden'/);
  assert.ok(unhide > 0 && on > 0 && draw > 0 && hideList > 0, show);
  assert.ok(on < draw && unhide < draw && draw < hideList);
  assert.doesNotMatch(show.slice(unhide, draw), /await|setTimeout|requestAnimationFrame/);
});

test('a step down in quality resizes the canvas before the frame is drawn, never after, so no frame is blank', () => {
  const frame = body('frame');
  const check = frame.indexOf('quality.level !== level');
  const draw = frame.search(/\bdraw\(now\)/);
  assert.ok(check >= 0 && draw > 0 && check < draw, frame);
  assert.doesNotMatch(frame.slice(draw), /measure\(\)/);
});

test('the boot is decided before the first frame, so the whole graph never flashes before it builds up', () => {
  const show = body('show');
  const boot = show.indexOf('bootStart = clock()');
  assert.ok(boot >= 0 && boot < show.search(/\bdraw\(/), show);
});

test('the canvas follows the window\'s size', () => {
  const at = src.indexOf('new ResizeObserver(');
  assert.ok(at > 0);
  assert.match(src, /addEventListener\('resize'/);
  assert.match(src.slice(at, at + 200), /wake\(\)/);
});

test('graph3d.js adds classes of its own to the page', () => {
  assert.ok([...src.matchAll(/classList\.(?:add|toggle|remove)\(\s*'([\w-]+)'/g)].length > 0);
});

test('the card is built from elements and text only', () => {
  assert.match(src, /createElement\(/);
  assert.match(src, /\.textContent = /);
  assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|setAttribute\(\s*['"]style|cssText/);
});

test('related buttons are labelled through relatedText', () => {
  const at = src.indexOf('Related:');
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 600), /relatedText\(/);
  assert.doesNotMatch(src, /textContent = [^;\n]*\brel\.name/);
});

test('selecting cancels the previous detail request', () => {
  assert.ok(src.split('new AbortController()').length - 1 >= 2);
  assert.match(src, /\.abort\(\)/);
  assert.match(src, /\/graph\/projects\//);
});

test('fact dust is round specks, each faded by its own depth, as in the mockup', () => {
  const dust = body('drawDust');
  assert.match(dust, /\.arc\(/);
  assert.doesNotMatch(dust, /fillRect/);
  assert.match(dust, /fog\(q\.z\)/, 'each speck by its own depth');
  assert.match(body('drawNode'), /drawDust\(/);
});

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const over = (fg: number[], bg: number[], a: number) => fg.map((v, i) => v * a + bg[i]! * (1 - a));
const lum = (c: number[]) => { const [r, gg, b] = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r! + 0.7152 * gg! + 0.0722 * b!; };
const ratio = (a: number[], b: number[]) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };

test('text on the window reaches 4.5:1 at 12 px in both themes, however far back and on the glow', () => {
  for (const [theme, ink] of Object.entries(g.WINDOW_INKS)) {
    const bgs = { bg: rgb(ink.bg), glow: over(rgb(ink.glow), rgb(ink.bg), ink.glowAlpha) };
    const fgs = { text: ink.text, muted: ink.muted, ...Object.fromEntries(Object.keys(g.AREA_STYLE).map((a) => [a, g.areaColour(a, theme === 'dark')])) };
    for (const [n, fg] of Object.entries(fgs)) for (const [w, bg] of Object.entries(bgs))
      assert.ok(ratio(over(rgb(fg), bg, ink.minAlpha), bg) >= 4.5, `${theme} ${n} on ${w}`);
  }
  assert.equal(g.textAlpha(0.16), g.WINDOW_INK.minAlpha, 'the farthest text is faded only down to the floor');
  assert.equal(g.textAlpha(1), 1);
  // Every text fill goes through the window's own text colours, never a faint ink.
  assert.doesNotMatch(src, /fillStyle = ink\(/);
  assert.doesNotMatch(src, /globalAlpha = max\(0\.[0-6]/);
});

test('the dark window is the approved blue-black, the light one warm paper', () => {
  assert.equal(g.WINDOW_INKS.dark.bg, '#02050a'); assert.equal(g.WINDOW_INKS.paper.bg, '#f6f3ec');
  assert.equal(g.areaColour('apps', true), '#5ee0a0'); assert.equal(g.areaColour('apps', false), '#245a3f');
});

test('the graph re-themes when the colour scheme changes', () => {
  const start = body('start');
  assert.match(start, /matchMedia\('\(prefers-color-scheme: dark\)'\)/);
  assert.match(start, /addEventListener\('change'/);
  assert.match(body('applyTheme'), /setWindowTheme\(/); assert.match(body('applyTheme'), /sprites\.clear\(\)/);
  assert.doesNotMatch(src, /rgba\((222,222,228|220,220,228|232,232,238)/, 'no fixed Graphite greys left in the drawing');
  // No colour frozen at load or at build: text and muted are read from WINDOW_INK when drawn, area colours go
  // through areaColour(a, dark) (its own body excepted), node colours are not cached.
  const noAreaColour = src.replace(body('areaColour'), '');
  assert.doesNotMatch(noAreaColour, /const (TEXT|MUTED)\b[^;\n]*WINDOW_INK|AREA_STYLE\[[^\]]+\]\.colour|\bo\.colour\b/);
});

test('graph3d.js draws only theme colours', () => {
  // Every colour literal in start() lives in WINDOW_INKS / AREA_STYLE / AREA_PAPER (outside start); '#fff' sparks
  // and the hover stroke read ink.spark / ink.text.
  assert.doesNotMatch(body('start'), /'#[0-9a-f]{3,8}'|rgba?\(\s*\d/i);
});

// ---- Text never lands on other text ----
const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
/** Monospace-ish widths, so the tests need no canvas. */
const width = (t: string, font: string) => t.length * (font === 'next' ? 6.2 : font === 'callout' ? 7.8 : 7.3);
const blank = (sc: Partial<Scene>): Scene => ({ W: 1280, H: 800, small: false, cx: 640, taken: [], marks: [], you: null, nodes: [], places: [], callouts: [], rings: [], ...sc });
/** Segment A→B passes through box b (sampled finely enough for label boxes). */
const through = (A: { x: number; y: number }, B: { x: number; y: number }, b: Box) => Array.from({ length: 201 }, (_, i) => i / 200).some((t) => { const x = A.x + (B.x - A.x) * t, y = A.y + (B.y - A.y) * t; return x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h; });
function noOverlap(shown: Shown[], taken: Box[], W: number, H: number) {
  for (const a of shown) {
    assert.ok(a.x >= 4 && a.y >= 4 && a.x + a.w <= W - 4 && a.y + a.h <= H - 4, `${a.id} inside the window`);
    for (const t of taken) if (!(t.id && t.id === a.id)) assert.ok(!hit(a, t), `${a.id} clear of a taken box`);
    for (const b of shown) {
      if (a === b) continue;
      assert.ok(!hit(a, b), `${a.kind} ${a.id} overlaps ${b.kind} ${b.id}`);
      if (a.from) assert.ok(!through(a.from, a.to!, b), `${a.id}'s leader crosses ${b.id}`);
    }
  }
}

test('a box is free only inside the window and clear of every other box, its own bracket aside', () => {
  const taken: Box[] = [{ x: 100, y: 100, w: 50, h: 14 }, { x: 300, y: 100, w: 30, h: 30, id: 'brainai' }];
  assert.equal(g.boxFree({ x: 10, y: 10, w: 40, h: 14 }, taken, 390, 600), true);
  assert.equal(g.boxFree({ x: 120, y: 105, w: 40, h: 14 }, taken, 390, 600), false, 'overlaps');
  assert.equal(g.boxFree({ x: 152, y: 100, w: 40, h: 14 }, taken, 390, 600), false, 'touching counts as a collision');
  assert.equal(g.boxFree({ x: 360, y: 10, w: 40, h: 14 }, taken, 390, 600), false, 'runs off the right edge');
  assert.equal(g.boxFree({ x: 2, y: 10, w: 40, h: 14 }, taken, 390, 600), false, 'runs off the left edge');
  assert.equal(g.boxFree({ x: 310, y: 110, w: 20, h: 14, id: 'brainai' }, taken, 390, 600), true, 'a project\'s label may sit on its own brackets');
  assert.equal(g.boxFree({ x: 310, y: 110, w: 20, h: 14, id: 'outline' }, taken, 390, 600), false);
});

test('the flown-in project\'s lines go under its sphere when they fit beside it on neither side, never over it', () => {
  assert.deepEqual(g.focusBlock(200, 300, 10, 100, 1280), { x: 216, y: 300 }, 'beside it, on its own line');
  assert.deepEqual(g.focusBlock(330, 300, 10, 100, 390), { x: 214, y: 300 }, 'flipped left at the right edge');
  const under = g.focusBlock(195, 300, 30, 200, 390);
  assert.ok(under.y >= 300 + 30 + 9, `under the sphere: ${under.y}`);
  assert.ok(under.x >= 6 && under.x + 200 <= 384, 'inside the window');
});

test('a name moves to the nearest free line, flips at the edge, stays inside the window, or is left out', () => {
  const node = (id: string, x: number, y: number, want: Want = 'hover') => ({ id, x, y, z: 2, rad: 6, want, a: 1, name: id.toUpperCase(), stat: '' });
  const taken: Box[] = [{ x: 100, y: 90, w: 220, h: 14 }];
  const [b] = g.sceneLabels(blank({ taken, nodes: [node('alpha', 150, 100)] }), width);
  assert.equal(b!.x, 169, 'beside its sphere, clear of its brackets');
  assert.ok(!hit(b!, taken[0]!) && Math.abs(b!.y - 93) <= 26, `the nearest free line: ${b!.y}`);
  const [e] = g.sceneLabels(blank({ W: 390, nodes: [node('beside-the-edge', 360, 300)] }), width);
  assert.ok(e!.x + e!.w <= 386 && e!.x + e!.w <= 360, 'flipped left of its sphere at the right edge');
  const wall: Box[] = Array.from({ length: 30 }, (_, i) => ({ x: 0, y: i * 20, w: 390, h: 20 }));
  assert.equal(g.sceneLabels(blank({ W: 390, taken: wall, nodes: [node('alpha', 50, 300)] }), width).length, 0, 'no room: left out, never drawn over');
  const personal = { ...node('finances', 150, 300, 'found'), name: null };
  assert.equal(g.sceneLabels(blank({ nodes: [personal] }), width).length, 0, 'an unnamed project gets no label');
});
test('area names each sit on their own ring where it is clearest, apart from each other and all other text', () => {
  const W = 1280, H = 700;
  // Six rings whose highest points all fall at the top centre, the way they do at the start camera.
  const ring = (k: number) => ({ id: `a${k}`, text: `AREA-${k}`, col: '#ffffff', pts: Array.from({ length: 25 }, (_, i) => { const t = (i / 24) * Math.PI; return { x: 640 - Math.cos(t) * (300 + k * 20), y: 100 + k * 6 + (1 - Math.sin(t)) * 150, z: 2, front: true }; }) });
  const rings = Array.from({ length: 6 }, (_, k) => ring(k));
  const taken: Box[] = [{ x: 560, y: 90, w: 200, h: 40 }];
  const shown = g.sceneLabels(blank({ W, H, taken, rings }), width);
  assert.equal(shown.length, 6, 'every area is named');
  noOverlap(shown, taken, W, H);
  for (const b of shown) {
    const r = rings.find((x) => `area:${x.id}` === b.id)!;
    assert.ok(r.pts.some((p) => Math.abs(p.x - (b.x + b.w / 2)) < 0.01 && Math.abs(p.y - 20 - b.y) < 0.01), `${b.id} sits on its own ring`);
  }
  assert.ok(new Set(shown.map((b) => Math.round(b.x / 100))).size >= 4, 'spread round the rings, not bunched at the top');
  assert.equal(g.sceneLabels(blank({ W, H, taken: [{ x: 0, y: 0, w: W, h: H }], rings }), width).length, 0, 'no free spot: left out');
});
test('names when zoomed in: at most 24, nearest first, none overlapping', () => {
  const nodes = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, x: 20 + (i % 10) * 120, y: 40 + Math.floor(i / 10) * 60, z: 40 - i, rad: 4, want: 'zoom' as const, a: 1, name: `P${i}`, stat: '' }));
  nodes.push({ id: 'near', x: 20 + 9 * 120 - 30, y: 40 + 3 * 60, z: 0.5, rad: 4, want: 'zoom', a: 1, name: 'NEAR-AND-LONG', stat: '' });
  const shown = g.sceneLabels(blank({ nodes }), width);
  assert.equal(shown.length, 24);
  assert.ok(shown.some((l) => l.id === 'near'), 'the nearest comes first');
  assert.ok(!shown.some((l) => l.id === 'p39'), 'p39 has no free line by the nearer label');
  assert.ok(shown.some((l) => l.id === 'p38') && !shown.some((l) => l.id === 'p0'), 'then the nearer ones');
  noOverlap(shown, [], 1280, 800);
});


test('no two shown labels overlap, nor any leader cross one, for 30 and 200 projects, on the Mac and the phone', () => {
  const AREAS = ['apps', 'home', 'tools', 'work', 'personal', 'unsorted'] as const;
  for (const n of [30, 200]) for (const [W, H] of [[1280, 800], [390, 844]] as const) for (const mode of ['overview', 'zoomed', 'found'] as const) {
    const cam = { ...g.START_CAMERA, dist: mode === 'zoomed' ? 2 : g.START_CAMERA.dist };
    const { small, C, F } = g.viewFrame(W, H);
    const P = (p: { x: number; y: number; z: number }) => g.project(p, cam, C, F);
    const names = Array.from({ length: n }, (_, i) => `project-${i}${'x'.repeat(i % 9)}`);
    const placed: { id: string; x: number; y: number; z: number; rad: number; facts: number }[] = [];
    AREAS.forEach((a, k) => {
      const mine = names.filter((_, i) => i % AREAS.length === k);
      for (const l of g.layoutOrbit(mine)) {
        const facts = (names.indexOf(l.name) * 7) % 40, s = P(g.orbitPoint(g.AREA_STYLE[a], l.angle, l.lane ? 1.1 : 1));
        placed.push({ id: l.name, x: s.x, y: s.y, z: s.z, rad: Math.max(2, g.nodeRadius({ facts, state: 'open' }) * s.s), facts });
      }
    });
    const taken: Box[] = small
      ? [{ x: 12, y: 12, w: W - 24, h: 36 }, { x: 12, y: H - 46, w: W - 24, h: 34 }]
      : [{ x: W - 368, y: 16, w: 352, h: 36 }, { x: 16, y: H - 50, w: 320, h: 34 }, { x: W - 470, y: H - 30, w: 454, h: 16 }];
    const core = P({ x: 0, y: 0, z: 0 });
    // Six projects on the go, spread through the areas as pinned ones are.
    const onTheGo = mode === 'overview' ? [0, 1, 2, 3, 4, 5].map((i) => placed[Math.floor((i * placed.length) / 6) + 2]!) : [];
    const sc = blank({
      // While Find is on, the spheres outside the result are faded, as the page marks them.
      W, H, small, cx: C.x, taken, marks: placed.map((p, i) => ({ id: p.id, x: p.x, y: p.y, r: p.rad + 2, ...(mode === 'found' && i % 5 !== 0 ? { dim: 1 } : {}) })),
      you: { x: core.x, y: core.y + core.s * 0.04 },
      callouts: onTheGo.map((p, i) => ({ id: p.id, x: p.x, y: p.y, rad: p.rad, col: '#ffffff', a: 1, label: `${p.id.toUpperCase()}  ·${i + 1}`, next: 'Device checks at the top of the checklist' })),
      nodes: placed.filter((p) => !onTheGo.includes(p)).flatMap((p, i) => {
        const want: Want | null = i === 7 ? 'hover' : mode === 'found' && i % 5 === 0 ? 'found' : mode === 'zoomed' && p.z < cam.dist + 0.15 ? 'zoom' : null;
        return want ? [{ id: p.id, x: p.x, y: p.y, z: p.z, rad: p.rad, want, a: 1, name: p.id.toUpperCase(), stat: `${p.facts} FACTS · 3D AGO` }] : [];
      }),
      places: [{ id: 'place:mac', x: core.x + 40, y: core.y + 10, d: 4, label: 'MAC', want: true, a: 1 }],
      rings: mode === 'zoomed' ? [] : AREAS.map((a) => ({ id: a, text: a.toUpperCase(), col: '#ffffff', pts: Array.from({ length: 48 }, (_, i) => { const q = P(g.orbitPoint(g.AREA_STYLE[a], (i / 48) * 2 * Math.PI)); return { x: q.x, y: q.y, z: q.z, front: q.z < cam.dist }; }) })),
    });
    const shown = g.sceneLabels(sc, width);
    const where = `${n} projects, ${W} px, ${mode}`;
    if (process.env.SHOW_LABELS) console.log(where, Object.entries(shown.reduce((m, l) => ({ ...m, [l.kind]: ((m as Record<string, number>)[l.kind] ?? 0) + 1 }), {})));
    noOverlap(shown, taken, W, H);
    assert.ok(shown.some((l) => l.kind === 'you'), `${where}: YOU`);
    assert.ok(shown.some((l) => l.kind === 'name'), `${where}: the hovered name`);
    if (mode === 'overview') {
      assert.ok(shown.filter((l) => l.kind === 'area').length >= (W > 720 ? 6 : 5), `${where}: area names ${shown.filter((l) => l.kind === 'area').map((l) => l.text)}`);
      assert.ok(shown.filter((l) => l.kind === 'callout').length >= (W > 720 ? 5 : 4), `${where}: callouts`);
    }
    if (mode === 'found') assert.ok(shown.filter((l) => l.stat).length >= 3, `${where}: found names with their counts`);
  }
});

test('a found name reads as its own sphere\'s: off every bracket, nearer its own sphere than any other, led when moved off its line', () => {
  // The desktop Find for "backup": eight lit projects, three of them close together above the core.
  const lit = [['ferngrid', 670, 208, 9], ['meshnet', 725, 250, 6], ['learning-path', 662, 320, 6], ['wordsmith-cli', 453, 413, 7],
    ['quillbox', 663, 485, 6], ['lanternfish', 838, 395, 10], ['pebble-notes', 790, 300, 5], ['photobarn', 663, 633, 5]] as const;
  const core = { x: 640, y: 440 };
  const brackets: Box[] = lit.map(([, x, y, r]) => ({ x: x - r - 9, y: y - r - 9, w: 2 * (r + 9), h: 2 * (r + 9), body: 1 }));
  const taken: Box[] = [...brackets, { x: 896, y: 86, w: 352, h: 34 }, { x: 32, y: 738, w: 320, h: 34 }];
  const marks = [...lit.map(([id, x, y, r]) => ({ id, x, y, r: r + 2 })), { id: 'you', ...core, r: 45 }];
  const nodes = lit.map(([id, x, y, rad]) => ({ id, x, y, z: 2, rad, want: 'found' as const, a: 1, name: id.toUpperCase(), stat: '30 FACTS · 2 PAGES · 1D AGO' }));
  const shown = g.sceneLabels(blank({ taken, marks, nodes, you: { x: core.x, y: core.y + 40, top: core.y - 40 } }), width);
  noOverlap(shown, taken, 1280, 800);
  const names = shown.filter((l) => l.kind === 'name');
  assert.ok(names.length >= 7, `named: ${names.map((l) => l.id)}`);
  const gap = (m: { x: number; y: number }, b: Box) => Math.hypot(Math.max(b.x - m.x, 0, m.x - b.x - b.w), Math.max(b.y - m.y, 0, m.y - b.y - b.h));
  for (const l of names) {
    const [, x, y, rad] = lit.find(([id]) => id === l.id)!;
    const nw = width(l.text!, 'name'), line = { x: (l as Shown & { right?: number }).right ? l.x + l.w - nw : l.x, y: l.y, w: nw, h: 14 };
    const own = gap({ x, y }, line) - rad;
    for (const m of marks) if (m.id !== l.id && m.id !== 'you') assert.ok(gap(m, line) - m.r > own, `${l.id}'s name reads as ${m.id}'s`);
    // Off its sphere's line, and not right over or under it, it is led from its own bracket.
    if (Math.abs(l.y + 7 - y) > 14 && !(l.x < x && x < l.x + l.w)) {
      assert.ok(l.from && l.to, `${l.id} moved off its line with no leader`);
      assert.ok(Math.hypot(l.from.x - x, l.from.y - y) < rad + 16, `${l.id}'s leader starts at its own sphere`);
    }
  }
  assert.ok(!shown.some((l) => l.kind === 'name' && hit(l, { x: core.x - 45, y: core.y - 45, w: 90, h: 90 })), 'no counts line across the core\'s rings');
  // The page part draws those leaders, counts the core's rings as a sphere and its brackets as a body no name sits on.
  assert.match(body('drawLabels'), /if \(l\.from\) \{[^}]*lineTo\(l\.to\.x/);
  assert.match(body('draw'), /\{ id: 'you', x: core\.x, y: core\.y, r: base \* 0\.25 \}/);
  assert.match(body('draw'), /const b = rad \+ 9; taken\.push\(\{ x: s\.x - b, y: s\.y - b, w: 2 \* b, h: 2 \* b, body: 1 \}\)/);
});

test('while Find is on, the faded spheres outside the result neither push a found name off its line nor claim it', () => {
  const node = { id: 'learning-path', x: 647, y: 251, z: 2, rad: 7, want: 'found' as const, a: 1, name: 'LEARNING-PATH', stat: '5 FACTS · 1 PAGE · 4D AGO' };
  const faded = [['old-sketchpad', 697, 284, 6], ['rainbarrel', 742, 242, 9], ['shiftboard', 730, 270, 11], ['garden-plans', 662, 259, 9]] as const;
  const marks = [{ id: node.id, x: node.x, y: node.y, r: 9 }, ...faded.map(([id, x, y, r]) => ({ id, x, y, r, dim: 1 }))];
  const [l] = g.sceneLabels(blank({ marks, nodes: [node] }), width);
  assert.equal(l!.y, node.y - 7, 'on its own line, beside its sphere');
  assert.equal(l!.x, node.x + node.rad + 13);
  assert.match(body('draw'), /marks\.push\(\{ id: p\.name, x: s\.x, y: s\.y, r: rad \+ 2, \.\.\.\(vis\(n\) \? \{\} : \{ dim: 1 \}\) \}\)/);
});

test('a name flipped to the left of its sphere is set flush right, so the name ends by its own brackets', () => {
  const node = { id: 'lanternfish', x: 330, y: 300, z: 2, rad: 10, want: 'found' as const, a: 1, name: 'LANTERNFISH', stat: '24 FACTS · 2 PAGES · 1D AGO' };
  const [l] = g.sceneLabels(blank({ W: 390, small: true, cx: 195, nodes: [node] }), width);
  assert.ok(l!.x + l!.w <= node.x - node.rad - 13 + 0.01, 'flipped left at the edge');
  assert.equal((l as Shown & { right?: number }).right, 1);
  const right = g.sceneLabels(blank({ nodes: [{ ...node, x: 200 }] }), width)[0] as Shown & { right?: number };
  assert.ok(!right.right, 'beside it on the right: flush left');
  assert.match(body('drawLabels'), /l\.right \? 'right'/);
});

test('a found name with no spot nearer its own sphere than a neighbour\'s is left out, not shown by the wrong one', () => {
  const node = (want: Want) => ({ id: 'marble-run', x: 300, y: 300, z: 2, rad: 6, want, a: 1, name: 'MARBLE-RUN', stat: '' });
  // Its own line and everything under it are taken; above it sits agent-relay.
  const sc = { W: 390, small: true, cx: 195, taken: [{ x: 0, y: 285, w: 390, h: 200 }], marks: [{ id: 'marble-run', x: 300, y: 300, r: 8 }, { id: 'agent-relay', x: 300, y: 250, r: 8 }] };
  assert.equal(g.sceneLabels(blank({ ...sc, nodes: [node('found')] }), width).length, 0);
  assert.equal(g.sceneLabels(blank({ ...sc, nodes: [node('zoom')] }), width).length, 0);
  assert.equal(g.sceneLabels(blank({ ...sc, nodes: [node('hover')] }), width).length, 1, 'the name under the pointer is always shown');
});

test('YOU moves above the core when a bracket sits under it, rather than being dropped', () => {
  const you = { x: 640, y: 450, top: 380 };
  const [y1] = g.sceneLabels(blank({ you }), width);
  assert.equal(y1!.y, 450);
  const [y2] = g.sceneLabels(blank({ you, taken: [{ x: 600, y: 440, w: 80, h: 60, id: 'garden-plot' }] }), width);
  assert.equal(y2!.y, 350, 'above the core');
});

test('a flown-in project\'s pages and decisions spread round it, each decision led from its own speck of dust', () => {
  const s = { x: 640, y: 400 };
  const round = (k: number, n: number, r: number) => ({ x: s.x + Math.cos((k / n) * 2 * Math.PI) * r, y: s.y + Math.sin((k / n) * 2 * Math.PI) * r * 0.6 });
  const f = {
    x: s.x, own: 'hivemind',
    pages: ['Architecture', 'Runbook', 'Sign-in'].map((text, k) => ({ text, q: round(k + 0.25, 3, 150) })),
    decisions: Array.from({ length: 5 }, (_, k) => ({ text: `Decision ${k}: nightly backups, weekly off-site`, q: round(k + 0.5, 5, 55) })),
  };
  const taken: Box[] = [{ x: 700, y: 391, w: 190, h: 32 }];
  const shown = g.sceneLabels(blank({ taken, marks: [{ id: 'hivemind', x: s.x, y: s.y, r: 30 }], extra: g.focusRequests(f, 1280, width) }), width);
  noOverlap(shown, taken, 1280, 800);
  const pages = shown.filter((l) => l.kind === 'page'), decisions = shown.filter((l) => l.kind === 'decision');
  assert.equal(pages.length, 3);
  assert.equal(decisions.length, 5);
  for (const d of decisions) {
    const k = Number(d.id.split(':')[1]);
    assert.deepEqual(d.from, f.decisions[k]!.q, 'led from its own speck');
  }
  assert.ok(decisions.some((d) => d.x > s.x) && decisions.some((d) => d.x + d.w < s.x), 'decisions on both sides, not one column');
  assert.ok(new Set(pages.map((p) => Math.round(p.x / 40))).size >= 2 && new Set(pages.map((p) => Math.round(p.y / 30))).size >= 2, 'pages round the project, not a list');
});

test('on the phone a flown-in project\'s pages and decisions go round its sphere, never across it, each led away from it', () => {
  const W = 390, H = 740, s = { x: 195, y: 246 }, rad = 19;
  const round = (k: number, n: number, r: number) => ({ x: s.x + Math.cos((k / n) * 2 * Math.PI + 0.6) * r, y: s.y + Math.sin((k / n) * 2 * Math.PI + 0.6) * r * 0.55 + k * 19 - 20 });
  const f = {
    x: s.x, own: 'lanternfish',
    pages: ['Architecture · lanternfish', 'Release notes · lanternfish'].map((text, k) => ({ text, q: round(k, 2, 100) })),
    decisions: Array.from({ length: 4 }, (_, k) => ({ text: `lanternfish detail lanternfishk${19 + k} lanternfish star overlay`, q: round(k + 0.5, 4, 42) })),
  };
  const block = g.focusBlock(s.x, s.y, rad, 200, W);
  // The sheet takes the bottom 40 %, Find the top; the project's own lines and its body are claimed first.
  const taken: Box[] = [{ x: 12, y: 12, w: 366, h: 36 }, { x: 0, y: H * 0.6, w: W, h: H * 0.4 }, { x: block.x, y: block.y - 9, w: 200, h: 32 }, g.focusBody(s.x, s.y, rad, 'lanternfish')];
  const shown = g.sceneLabels(blank({ W, H, small: true, cx: W / 2, taken, marks: [{ id: 'lanternfish', ...s, r: rad + 2 }], extra: g.focusRequests(f, W, width) }), width);
  noOverlap(shown, taken, W, H);
  const sphere = { x: s.x - rad - 4, y: s.y - rad - 4, w: 2 * rad + 8, h: 2 * rad + 8 };
  for (const l of shown) assert.ok(!hit(l, sphere), `${l.id} lies across the sphere`);
  const pages = shown.filter((l) => l.kind === 'page'), decisions = shown.filter((l) => l.kind === 'decision');
  assert.ok(pages.length === 2 && decisions.length >= 2, `pages ${pages.length}, decisions ${decisions.length}`);
  for (const d of decisions) assert.ok(Math.sign(d.to!.x - d.from!.x) === Math.sign(d.from!.x - s.x), `${d.id} is led inward, onto the body`);
  for (const p of pages) assert.ok(p.text!.length >= 12, `${p.id} clipped to "${p.text}"`);
  assert.match(body('claimFocus'), /taken\.push\(focusBody\(s\.x, s\.y, rad, p\.name\)\)/);
});

test('window text has a thin edge of the background, so a label over a sphere or a thread still reads', () => {
  const t = body('text');
  assert.ok(t.indexOf('strokeText(') > 0 && t.indexOf('strokeText(') < t.indexOf('fillText('), t);
  assert.match(t, /WINDOW_INK\.bg/);
});

test('every line of window text sits on a plate of the background, so a thread or a ring never runs through its letters', () => {
  const t = body('text');
  const plate = t.indexOf('fillRect(');
  assert.ok(plate > 0 && plate < t.indexOf('strokeText(') && plate < t.indexOf('fillText('), 'the plate goes under the letters');
  assert.match(t, /measureText\(s\)/, 'as wide as the line itself');
  assert.match(t.slice(0, plate), /hexA\(WINDOW_INK\.bg, 0\.[6-9]/);
  assert.match(t.slice(plate), /fillStyle = ink0/, 'the text keeps its own colour');
});

test('all the window\'s text is placed in one pass after everything fixed claims its space, then drawn over the scene', () => {
  const draw = body('draw');
  const place = draw.indexOf('sceneLabels(');
  assert.ok(place > 0 && draw.split('sceneLabels(').length === 2, 'one placement pass a frame');
  // The flown-in project's block, brackets and the buttons are claimed before it; the text is drawn after the scene.
  assert.ok(draw.indexOf('overlays()') < draw.indexOf('claimFocus(') && draw.indexOf('claimFocus(') < place);
  assert.match(draw.slice(0, place), /taken\.push\(\{[^}]*id: p\.name/);
  assert.ok(place < draw.indexOf('items.sort(') && draw.indexOf('items.sort(') < draw.indexOf('drawLabels('));
  // No name is drawn anywhere else: drawNode draws shapes only, and every label is drawn where it was placed.
  assert.doesNotMatch(body('drawNode'), /toUpperCase|FONTS\.name/);
  assert.match(body('drawLabels'), /const tx = l\.right \? l\.x \+ l\.w : l\.x;[^]*text\(l\.text, tx, l\.y \+ 11\)/);
  const focus = body('claimFocus');
  assert.match(focus, /focusBlock\(/);
  assert.match(focus, /taken\.push\(|put\(/);
  assert.doesNotMatch(src, /PAGES · [^\n]*s\.x \+ rad \+ 6/);
  // The buttons, Find, the key line, the card and the sheet over the window count as taken too.
  assert.match(body('overlays'), /getBoundingClientRect\(\)/);
  assert.match(body('overlays'), /graph-bar.*graph-find.*graph-keys/s);
});

// ---- D34: the desktop docks the card on the right; the scene centres left of it ----
test('focusX keeps today\'s centre when nothing is docked, and centres left of a docked card', () => {
  assert.equal(g.focusX(1200, { sheet: false, insetRight: 0 }), 780);
  assert.equal(g.focusX(390, { sheet: true, insetRight: 0 }), 195);
  assert.equal(g.focusX(1200, { sheet: false, insetRight: 460 }), 370);
  assert.equal(g.focusX(1600, { sheet: false, insetRight: 500 }), 550);
});
test('hoverReplaces: a docked, selected card stays while hovering others', () => {
  assert.equal(g.hoverReplaces(true, true), false);
  assert.equal(g.hoverReplaces(true, false), true);
  assert.equal(g.hoverReplaces(false, true), true);
});
