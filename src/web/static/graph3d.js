// The Graph tab's 3D window (round 2 spec section 15): projects as spheres on area orbits, drawn on one Canvas 2D,
// only while something moves. The pure helpers are exported for the tests; the page part runs only when a .graph
// element exists. AI-written text reaches the page only through textContent and canvas fillText, never as markup.

const { sin, cos, min, max, hypot, sqrt, round, floor, atan2, abs, exp, PI } = Math;
const TAU = PI * 2;
const clock = () => performance.now();

/** Each area's colour and orbit: radius, tilt and node (the mockup's ORB, plus Tools & AI and a grey Unsorted ring). */
export const AREA_STYLE = {
  apps: { colour: '#5ee0a0', radius: 1.0, tilt: 0.28, node: 0 },
  home: { colour: '#d0c8b8', radius: 1.16, tilt: 1.05, node: 1.7 },
  tools: { colour: '#6fd3f5', radius: 0.92, tilt: -0.18, node: 2.6 },
  work: { colour: '#ad94ff', radius: 0.84, tilt: -0.55, node: 0.4 },
  personal: { colour: '#f38cc0', radius: 0.66, tilt: 0.78, node: 3.6 },
  unsorted: { colour: '#8a94a6', radius: 1.32, tilt: 0.12, node: 5.0 },
};

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** A project's own place on its orbit, from its name alone. */
export function nameAngle(name) {
  return (fnv1a(name) / 2 ** 32) * TAU;
}

const LANE_LIMIT = 24;

/** Places on one orbit: each name's own angle, nudged apart only where too close; over 24 use two lanes. */
export function layoutOrbit(names) {
  const unique = [...new Set(names)].sort();
  const twoLanes = unique.length > LANE_LIMIT;
  const out = [];
  for (const lane of ([0, 1])) {
    const items = unique
      .filter((n) => (twoLanes ? (fnv1a(n) >>> 16) & 1 : 0) === lane)
      .map((name) => ({ name, angle: nameAngle(name), lane }))
      .sort((a, b) => a.angle - b.angle || (a.name < b.name ? -1 : 1));
    if (items.length === 0) continue;
    spread(items, min(TAU / 48, TAU / (2 * items.length)));
    out.push(...items);
  }
  return out;
}

/** Pushes apart only neighbours closer than `gap`, a little at a time, until none are: far-apart items never move. */
function spread(items, gap) {
  const n = items.length;
  for (let pass = 0; pass < 2000 && n > 1; pass++) {
    let moved = false;
    items.sort((x, y) => x.angle - y.angle);
    for (let i = 0; i < n; i++) {
      const a = items[i], b = items[(i + 1) % n], d = (b.angle - a.angle + TAU) % TAU;
      if (d < gap - 1e-12) { const k = (gap - d) / 2 + 1e-12; a.angle = (a.angle - k + TAU) % TAU; b.angle = (b.angle + k) % TAU; moved = true; }
    }
    if (!moved) break;
  }
}

const MAX_TICKS = 8;

/** Waiting ticks: the real count up to 8, late ones first, the rest as "+n". */
export function waitTicks(waiting, late) {
  const shown = min(waiting, MAX_TICKS);
  const l = min(late, shown);
  return { late: l, amber: shown - l, more: max(0, waiting - MAX_TICKS) };
}

/** Inside the window and at least 3 px from every taken box but its own (a project's label may sit on its "+n"). */
export function boxFree(b, taken, W, H) {
  if (b.x < 4 || b.y < 4 || b.x + b.w > W - 4 || b.y + b.h > H - 4) return false;
  return !taken.some((t) => !(b.id && t.id === b.id) && b.x < t.x + t.w + 3 && t.x < b.x + b.w + 3 && b.y < t.y + t.h + 3 && t.y < b.y + b.h + 3);
}

/** The flown-in project's lines (their middle line at y): beside it on either side, else under it, never over it. */
export function focusBlock(sx, sy, rad, w, W) {
  const right = sx + rad + 6, left = sx - rad - 6 - w;
  if (right + w <= W - 6) return { x: right, y: sy };
  if (left >= 6) return { x: left, y: sy };
  return { x: max(6, min(sx - w / 2, W - 6 - w)), y: sy + rad + 22 };
}

/** The flown-in project's sphere as a box no page or decision may cover; a leader may start on it, never cross it. */
export function focusBody(sx, sy, rad, id) {
  const R = rad * 1.3 + 6;
  return { x: sx - R, y: sy - R, w: 2 * R, h: 2 * R, id, body: 1 };
}

/** Whether segment A→B passes through box b (Liang–Barsky clipping). */
function crosses(A, B, b) {
  let t0 = 0, t1 = 1;
  const dx = B.x - A.x, dy = B.y - A.y;
  for (const [p, q] of [[-dx, A.x - b.x], [dx, b.x + b.w - A.x], [-dy, A.y - b.y], [dy, b.y + b.h - A.y]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

/** Spheres a box covers (its own too) or a leader passes over (not the one it starts from): soft, they only cost.
 *  A sphere faded out of the result (`dim`) costs nothing. */
function onMarks(b, c, marks) {
  let n = 0;
  const L = c.from && { x0: min(c.from.x, c.to.x), x1: max(c.from.x, c.to.x), y0: min(c.from.y, c.to.y), y1: max(c.from.y, c.to.y) };
  for (const m of marks) {
    if (m.dim) continue;
    if (m.x + m.r > b.x && m.x - m.r < b.x + b.w && m.y + m.r > b.y && m.y - m.r < b.y + b.h) n++;
    else if (m.id === b.id || m.id === b.own) continue;
    else if (L && m.x + m.r > L.x0 && m.x - m.r < L.x1 && m.y + m.r > L.y0 && m.y - m.r < L.y1
      && crosses(c.from, c.to, { x: m.x - m.r, y: m.y - m.r, w: 2 * m.r, h: 2 * m.r })) n += 0.5;
  }
  return n;
}

/**
 * Every label in one pass, highest priority first: each takes its cheapest candidate that is inside the window, clear
 * of every taken box and every label placed before it, with a leader that crosses none of them (nor they it). A label
 * with no such candidate is hidden, never drawn over another. Spheres only cost, and a kind with `apart` spreads out.
 */
export function placeLabels(reqs, taken, marks, W, H) {
  const placed = [], all = [...taken], count = new Map();
  for (const r of [...reqs].sort((a, b) => b.prio - a.prio)) {
    if (r.limit && (count.get(r.kind) ?? 0) >= r.limit) continue;
    let best = null, bc = Infinity;
    // Cheapest first: what is added on top only costs more, so the search stops at the first that cannot beat the best.
    for (const c of [...r.cands].sort((x, y) => (x.cost ?? 0) - (y.cost ?? 0))) {
      if ((c.cost ?? 0) >= bc) break;
      const b = { id: r.id, own: r.own, x: c.x, y: c.y, w: c.w ?? r.w, h: c.h ?? r.h };
      if (!boxFree(b, all, W, H)) continue;
      // A leader may start inside a sphere's body or brackets, never pass through any other box.
      if (c.from && all.some((t) => !(t.id && t.id === r.id) && crosses(c.from, c.to, t) && !(t.body && inBox(c.from, t)))) continue;
      if (placed.some((p) => p.from && p.id !== r.id && crosses(p.from, p.to, b))) continue;
      let cost = (c.cost ?? 0) + onMarks(b, c, marks) * 40;
      if (r.apart) for (const p of placed) if (p.kind === r.kind) cost += max(0, r.apart - hypot(p.x + p.w / 2 - b.x - b.w / 2, p.y + p.h / 2 - b.y - b.h / 2)) / 3;
      if (cost < bc) { bc = cost; best = { ...r, ...c, ...b, cands: undefined }; }
    }
    if (best) { placed.push(best); all.push(best); count.set(r.kind, (count.get(r.kind) ?? 0) + 1); }
  }
  return placed;
}

const inBox = (p, b) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h;
/** How far point m is from box b. */
const boxGap = (m, b) => hypot(max(b.x - m.x, 0, m.x - b.x - b.w), max(b.y - m.y, 0, m.y - b.y - b.h));

/** Cuts `t` with an ellipsis to fit `room` px. */
function clip(t, room, font, measure) {
  if (measure(t, font) <= room) return t;
  while (t.length > 4 && measure(`${t}…`, font) > room) t = t.slice(0, -1);
  return `${t}…`;
}
const nudges = (n) => Array.from({ length: n }, (_, i) => (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 13);

/**
 * The flown-in project's pages and newest decisions, spread round it as in the mockup: each page a small panel by its
 * own place on a ring round the project, each decision led from its own speck of dust on the side that speck is on.
 */
export function focusRequests(f, W, measure) {
  const reqs = [];
  f.pages.forEach((p, k) => {
    // Away from the project first, cut to the room on that side, so on the phone it is not pushed across the sphere.
    const pref = p.q.x >= f.x ? 1 : -1, cands = [];
    for (const side of [pref, -pref]) {
      const room = min(300, side > 0 ? W - 24 - p.q.x : p.q.x - 14);
      if (room < 60) continue;
      const text = clip(p.text, room, 'page', measure), w = 15 + measure(text, 'page');
      for (const dy of nudges(9)) cands.push({ x: side > 0 ? p.q.x - 5 : p.q.x + 5 - w, y: p.q.y - 8 + dy, w, h: 16, text, flip: side < 0, cost: abs(dy) + (side === pref ? 0 : 30) });
    }
    reqs.push({ id: `page:${k}`, kind: 'page', own: f.own, prio: 96 - k / 10, cands });
  });
  f.decisions.forEach((d, k) => {
    const pref = d.q.x >= f.x ? 1 : -1, cands = [];
    for (const side of [pref, -pref]) {
      const room = min(340, side > 0 ? W - 10 - (d.q.x + 42) : d.q.x - 52);
      if (room < 60) continue;
      const text = clip(d.text, room, 'decision', measure), tw = measure(text, 'decision');
      for (const dy of nudges(13)) {
        const ey = d.q.y - 16 + dy, ex = d.q.x + side * 28;
        cands.push({ x: side > 0 ? ex + 14 : ex - 14 - tw, y: ey - 9, w: tw, h: 15, text, side, ex, ey, from: d.q, to: { x: ex, y: ey }, cost: abs(dy) + (side === pref ? 0 : 40) });
      }
    }
    reqs.push({ id: `decision:${k}`, kind: 'decision', own: f.own, prio: 95 - k / 10, cands });
  });
  return reqs;
}

/**
 * The window's text for one frame, as label requests for placeLabels, in priority order: YOU; the hovered name; the
 * places; found and related names (with a counts line when found); the On the go callouts; each area's name on its own
 * ring where the ring is clearest; then names when zoomed in (nearest first, at most 24).
 */
export function sceneLabels(sc, measure) {
  const { W } = sc, reqs = [];
  // YOU under the core, a line lower, or above it when a bracket or the card is in the way.
  const u = sc.you;
  if (u) reqs.push({ id: 'you', kind: 'you', prio: 100, w: 130, h: 30, cands: [{ x: u.x - 65, y: u.y }, { x: u.x - 65, y: u.y + 13, cost: 13 }, ...(u.top ? [{ x: u.x - 65, y: u.top - 30, cost: 20 }] : [])] });
  for (const n of sc.nodes) {
    if (!n.want || n.name === null) continue;
    const stat = n.want === 'found' && n.stat ? n.stat : '';
    const text = clip(n.name, W - 16, 'name', measure);
    const nw = measure(text, 'name'), w = max(nw, stat ? measure(stat, 'stat') : 0), h = stat ? 28 : 14;
    // Beside its sphere (clear of its brackets when it has them), else flipped left, over or under it, else pulled in
    // from the edge; led from its sphere once moved off its line. Nearer another sphere than its own it is left out,
    // unless it is under the pointer, where it only costs.
    const zoom = n.want === 'zoom', gap = n.rad + (n.want === 'hover' || n.want === 'found' ? 13 : 6), cands = [];
    const near = sc.marks.filter((m) => !m.dim && m.id !== n.id && m.id !== 'you' && abs(m.x - n.x) < w + gap + 80 && abs(m.y - n.y) < gap + 120);
    const add = (x, y, cost) => {
      // Flipped left of its sphere, the lines are set flush right, so the name ends by its brackets.
      const side = x >= n.x + gap - 3 ? 1 : x + w <= n.x - gap + 3 ? -1 : 0, line = { x: side < 0 ? x + w - nw : x, y, w: nw, h: 14 }, own = boxGap(n, line) - n.rad;
      const lead = side && abs(y + 7 - n.y) > 14, k = (gap - 3) * 0.8, wrong = near.some((m) => boxGap(m, line) - m.r <= own);
      if (wrong && n.want !== 'hover') return;
      cands.push({ x, y, right: side < 0 ? 1 : 0, cost: cost + (wrong ? 30 : 0), ...(lead ? { from: { x: n.x + side * k, y: n.y + (y + 7 > n.y ? k : -k) }, to: { x: side > 0 ? x - 2 : x + w + 2, y: y + 7 } } : {}) });
    };
    for (const dy of nudges(zoom ? 3 : 9)) for (const [x, extra] of [[n.x + gap, 0], [n.x - gap - w, 6], [max(4, min(n.x + gap, W - 4 - w)), 20]]) add(x, n.y - 7 + dy, abs(dy) + extra);
    if (!zoom) { const x = max(4, min(n.x - w / 2, W - 4 - w)); add(x, n.y + gap - 3, 30); add(x, n.y - gap - h + 3, 32); }
    const prio = (n.want === 'hover' ? 90 : zoom ? 40 : 80) - n.z / 100;
    reqs.push({ id: n.id, kind: zoom ? 'zoom' : 'name', prio, w, h, text, stat, a: n.a, cands, limit: zoom ? 24 : 0 });
  }
  for (const m of sc.places) {
    if (!m.want) continue;
    const w = measure(m.label, 'place');
    reqs.push({ id: m.id, kind: 'place', prio: 85, w, h: 14, text: m.label, a: m.a, cands: [{ x: m.x - w / 2, y: m.y + m.d + 3 }, { x: m.x - w / 2, y: m.y - m.d - 17, cost: 8 }] });
  }
  sc.callouts.forEach((c, k) => {
    const side = c.x >= sc.cx ? 1 : -1, tw = measure(c.label, 'callout') + 6, cands = [];
    const from = { x: c.x + side * c.rad * 0.75, y: c.y - c.rad * 0.6 };
    // The shelf a little out from the sphere, or further out when that is crowded; the name always inside the window.
    for (const [reach, extra] of [[30, 0], [70, 30], [120, 60]]) {
      const lx = side > 0 ? min(c.x + c.rad + reach, W - 8 - tw) : max(c.x - c.rad - reach, 8 + tw);
      const L2 = side > 0 ? min(W - 4, lx + (sc.small ? 64 : 140)) : max(4, lx - (sc.small ? 64 : 140));
      for (const next of c.next && !sc.small ? [clip(c.next, side > 0 ? W - 10 - lx : lx - 10, 'next', measure), ''] : ['']) {
        const far = lx + side * (2 + max(tw, next ? measure(next, 'next') : 0)), x0 = min(lx, L2, far), w = max(lx, L2, far) - x0;
        for (const dy of nudges(25)) {
          const ly = max(24, c.y - c.rad - 16) + dy;
          cands.push({ x: x0, y: ly - 19, w, h: next ? 38 : 21, ly, lx, L2, side, next, from, to: { x: lx, y: ly }, cost: abs(dy) + extra + (dy < 0 ? 4 : 0) + (next ? 0 : 80) });
        }
      }
    }
    reqs.push({ id: c.id, kind: 'callout', prio: 70 - k / 10, text: c.label, col: c.col, a: c.a, cands });
  });
  for (const ring of sc.rings) {
    const w = measure(ring.text, 'area') + 8, cands = [];
    for (const p of ring.pts) {
      if (!p.front) continue;
      const b = { x: p.x - w / 2, y: p.y - 20, w, h: 16 };
      // Clearest: few points of other rings (and of its own, where it runs steeply) inside or near the name.
      let crowd = 0;
      for (const o of sc.rings) for (const q of o.pts) if (q.x > b.x - 8 && q.x < b.x + b.w + 8 && q.y > b.y - 8 && q.y < b.y + b.h + 8) crowd += o === ring ? 1 : 3;
      cands.push({ ...b, z: p.z, cost: crowd * 4 });
    }
    reqs.push({ id: `area:${ring.id}`, kind: 'area', prio: 60, w, h: 16, text: ring.text, col: ring.col, apart: 170, cands });
  }
  return placeLabels([...reqs, ...(sc.extra ?? [])], sc.taken, sc.marks, W, sc.H);
}

const SLOW_MS = 12;
const WINDOW = 30;

/** Adaptive quality: a slow window of 30 drawn frames steps down once (pixel ratio, then dust, then floor ticks). */
export function createQuality() {
  let samples = [];
  const q = {
    level: (0),
    record(workMs) {
      samples.push(workMs);
      if (samples.length > WINDOW) samples.shift();
      if (samples.length < WINDOW || q.level >= 3) return;
      const sorted = [...samples].sort((a, b) => a - b);
      const median = (sorted[WINDOW / 2 - 1] + sorted[WINDOW / 2]) / 2;
      if (median > SLOW_MS) {
        q.level = (q.level + 1);
        samples = [];
      }
    },
    dpr(base) { return min(base, q.level >= 1 ? 1.5 : 2); },
    get dust() { return q.level >= 2 ? 0.5 : 1; },
    get floorTicks() { return q.level < 3; },
  };
  return q;
}

/** Time-based easing toward a target: the same motion at 30, 60 or 120 frames a second. */
export function approach(current, target, dt, halfLife = 0.13) {
  return target + (current - target) * 2 ** (-dt / halfLife);
}

const CAM_KEYS = (['yaw', 'pitch', 'dist', 'fx', 'fy', 'fz']);

/** Another frame only while something moves (pulses and thread dots are not inputs). */
export function needsFrame(s, cam, tgt) {
  if (s.dragging || s.pinching || s.flying || s.booting || s.turning) return true;
  return CAM_KEYS.some((k) => abs(cam[k] - tgt[k]) > 1e-3);
}

const TURN_STOP_MS = 30_000;

/** Turn slowly: on by default on the Mac, off on the phone until asked; stops 30 s after input; never reduced. */
export function turnAllowed(s) {
  if (s.reducedMotion || !s.userOn) return false;
  if (s.mobile && !s.touched) return false;
  return s.sinceInputMs < TURN_STOP_MS;
}

export const BOOT_MS = 1200;
const BOOT_KEY = 'graph-booted';

/** The short boot plays once per browser session, never under reduced motion. */
export function bootWanted(storage, reducedMotion) {
  if (reducedMotion || !storage) return false;
  try {
    return storage.getItem(BOOT_KEY) === null;
  } catch {
    return false;
  }
}

const KEYS = ({
  ArrowLeft: 'prev', ArrowRight: 'next', ArrowUp: 'tiltUp', ArrowDown: 'tiltDown',
  '+': 'zoomIn', '=': 'zoomIn', '-': 'zoomOut', '−': 'zoomOut', Enter: 'select', Escape: 'back', r: 'related', R: 'related',
});
const FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A']);

/**
 * The window's keys, only while the window itself has focus; never in a field or on a button or link.
 */
export function keyAction(key, target, onWindow) {
  if (!onWindow || FIELDS.has(target.tagName) || target.isContentEditable) return null;
  return KEYS[key] ?? null;
}

/** ← and → from `at` (-1 before the first step) among `n` drawn projects; -1 when there are none. */
export function stepIndex(at, dir, n) {
  if (n <= 0) return -1;
  if (at < 0) return dir === 'next' ? 0 : n - 1;
  return (at + (dir === 'next' ? 1 : n - 1)) % n;
}

const touched = (days) => (days <= 0 ? 'touched today' : days === 1 ? 'touched yesterday' : `touched ${days} days ago`);

/**
 * What the live card says: "wildlog, Apps, 1 waiting, late, touched 9 days ago".
 */
export function announce(p, areaLabel) {
  const parts = [p.name, areaLabel];
  if (p.onTheGo) parts.push('on the go');
  else if (p.state === 'idea' || p.state === 'parked') parts.push(p.state);
  if (p.waiting > 0) parts.push(`${p.waiting} waiting`);
  if (p.late === 1) parts.push('late');
  else if (p.late > 1) parts.push(`${p.late} late`);
  parts.push(touched(p.days));
  return parts.join(', ');
}

/** Lowercase, no accents, words of any script with single spaces: the server's rule. */
export function normalWords(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Projects whose name, one-liner, page titles, place labels or thread words hold every word of `q`.
 */
export function localMatches(data, q) {
  const wanted = normalWords(q).split(' ').filter(Boolean);
  const out = new Set();
  if (wanted.length === 0) return out;
  const label = new Map(data.places.map((p) => [p.id, p.label]));
  data.projects.forEach((p, i) => {
    const words = data.threads.filter((t) => t.a === i || t.b === i).flatMap((t) => t.words);
    const hay = normalWords([p.name, p.oneLiner ?? '', ...p.pages, ...p.runsOn.map((r) => label.get(r) ?? r), ...words].join(' '));
    if (wanted.every((w) => hay.includes(w))) out.add(i);
  });
  return out;
}

/** Whether every word Find typed is in a project's own name: only that names an unpinned Personal project. */
export function nameMatch(name, q) {
  const w = normalWords(q).split(' ').filter(Boolean), n = normalWords(name);
  return w.length > 0 && w.every((x) => n.includes(x));
}

/** An unpinned Personal project is named only on hover, when selected or found by its name, as on the home; never by
 *  a place, nor by Find matching its pages, place labels or threads. */
export function nameShown(unlabelled, why) {
  return !unlabelled || why.hover || why.focus || why.found;
}

/** "12 FACTS · 3 PAGES · 6D AGO", with an empty part left out rather than shown as 0. */
export function statLine(p) {
  const n = p.pages.length, parts = [];
  if (p.facts > 0) parts.push(`${p.facts} ${p.facts === 1 ? 'FACT' : 'FACTS'}`);
  if (n > 0) parts.push(`${n} ${n === 1 ? 'PAGE' : 'PAGES'}`);
  parts.push(p.days ? `${p.days}D AGO` : 'TODAY');
  return parts.join(' · ');
}

/** A Related entry's text: never the name or words of an unpinned Personal project. */
export function relatedText(r) {
  if (r.unlabelled) return 'A Personal project';
  return r.words.length > 0 ? `${r.name}: ${r.words.join(', ')}` : r.name;
}

export function matchLine(n, q) {
  if (n === 0) return `No project matches “${q}”`;
  return n === 1 ? `1 project matches “${q}”` : `${n} projects match “${q}”`;
}

export function placeLine(n, label) {
  return n === 1 ? `1 project runs on ${label}` : `${n} projects run on ${label}`;
}

/**
 * How a thread is drawn: bright ('on') for the project flown in, the one under the pointer, or between two found
 * projects, so a Find result reads as a group; faint at overview; null hides it.
 */
export function threadLook(a, b, s) {
  if (s.focus) return a === s.focus || b === s.focus ? 'on' : null;
  if (s.hover && (a === s.hover || b === s.hover)) return 'on';
  if (s.lit) return s.lit.has(a) && s.lit.has(b) ? 'on' : null;
  return 'faint';
}

/** Where Enter in Find flies: the first server hit that is drawn, else the first drawn local match; null if none. */
export function findTarget(server, local, drawn) {
  return server.find((n) => drawn.has(n)) ?? local.find((n) => drawn.has(n)) ?? null;
}

/** Find's server part: each question cancels the one before; a reply to anything but the latest is ignored. */
export function createFinder(fetchJson) {
  let current = null;
  let latest = '';
  return {
    async ask(raw) {
      const q = raw.trim().slice(0, 200);
      current?.abort();
      const ctl = new AbortController();
      current = ctl;
      latest = q;
      try {
        const reply = await fetchJson(`/graph/find.json?q=${encodeURIComponent(q)}`, ctl.signal);
        return reply.q === latest && !ctl.signal.aborted ? reply : null;
      } catch {
        return null;
      }
    },
    cancel() {
      current?.abort();
      current = null;
      latest = '';
    },
  };
}

/** The window's two palettes, following the app: blue-black at night (the approved 3D mockup), warm paper by day.
 *  Text colours reach 4.5:1 for 12 px text on the background and on the glow at its centre. `line`, `star` and `hot`
 *  are r,g,b parts for lines drawn at many fades; `shine` is the highlight on a sphere. */
export const WINDOW_INKS = {
  dark: {
    bg: '#02050a', glow: '#244068', glowAlpha: 0.22, text: '#d7e3f4', muted: '#8ea2bf', faint: '#6f86a8',
    line: '205,222,245', star: '180,205,255', starAlpha: 0.3, hot: '195,228,255', spark: '#ffffff', shine: '#ffffff',
    late: 'rgba(255,110,80,.95)', soon: 'rgba(255,170,90,.85)', core: ['rgba(255,150,90,.95)', 'rgba(255,138,76,.35)'], minAlpha: 0.85,
  },
  paper: {
    bg: '#f6f3ec', glow: '#ead9bd', glowAlpha: 0.45, text: '#1c1b19', muted: '#524e47', faint: '#6b675f',
    line: '28,27,25', star: '28,27,25', starAlpha: 0.075, hot: '28,27,25', spark: '#3a3833', shine: '#ffffff',
    late: 'rgba(176,55,27,.95)', soon: 'rgba(138,90,0,.9)', core: ['rgba(234,110,50,.95)', 'rgba(194,65,12,.35)'], minAlpha: 0.85,
  },
};
/** The palette in use: a live binding, read each time something is drawn, so a change of scheme shows at once. */
export let WINDOW_INK = WINDOW_INKS.dark;
/** Area colours on paper: darker inks of the same hues, each 4.5:1 or better at 0.85 on the paper and its glow. */
export const AREA_PAPER = { apps: '#245a3f', home: '#5a4e3b', tools: '#274e74', work: '#4c3e80', personal: '#743858', unsorted: '#4a5260' };
/** An area's colour in the window's current theme. */
export function areaColour(area, dark) {
  const a = area in AREA_STYLE ? area : 'unsorted';
  return dark ? AREA_STYLE[a].colour : AREA_PAPER[a];
}
/** Picks the window's palette: dark (blue-black) or paper. */
export function setWindowTheme(dark) {
  WINDOW_INK = dark ? WINDOW_INKS.dark : WINDOW_INKS.paper;
}

/** Text fades with depth only down to the floor that keeps it readable. */
export function textAlpha(a) {
  return max(WINDOW_INK.minAlpha, min(1, a));
}

// ---------------------------------------------------------------- the page part

const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const AREA_LABEL = { apps: 'Apps', home: 'Home & infrastructure', tools: 'Tools & AI', work: 'Work', personal: 'Personal', unsorted: 'Unsorted' };
const FLOOR_Y = 1.28;
const START = { yaw: 0.5, pitch: -0.58, dist: 3.6, fx: 0, fy: 0, fz: 0 };

const hexA = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

const ink = (a) => `rgba(${WINDOW_INK.line},${a})`;
const ease = (t) => (t < 0 ? 0 : t > 1 ? 1 : 1 - (1 - t) ** 3);
const rotY = (p, a) => { const c = cos(a), s = sin(a); return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c }; };
const rotX = (p, a) => { const c = cos(a), s = sin(a); return { x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c }; };

/** @param {{ radius: number; tilt: number; node: number }} o @param {number} t @param {number} [k] */
const orbitPt = (o, t, k = 1) => rotY(rotX({ x: cos(t) * o.radius * k, y: 0, z: sin(t) * o.radius * k }, o.tilt), o.node);
/** A point on an area's orbit, for the tests. */
export const orbitPoint = orbitPt;
export const START_CAMERA = START;

/** Where the window centres the scene and how far it magnifies, for a W × H window. */
export function viewFrame(W, H) {
  const small = W < 720;
  return { small, C: { x: W / 2, y: small ? H * 0.44 : H / 2 + 10 }, F: min(small ? W * 1.05 : W * 0.72, H - 120) * 1.18 };
}

/**
 * Where a selected project sits across a W-wide window: centred on the phone (the sheet rises below it); left of a card
 * docked on the right (the desktop, `insetRight` px of the window taken by it); else today's shift right, clear of the
 * floating card.
 */
export function focusX(W, o) {
  if (o.insetRight > 0) return (W - o.insetRight) / 2;
  if (o.sheet) return W / 2;
  return W / 2 + min(190, W * 0.15);
}

/** Does hovering another project replace the card? Not while a selected project's card is docked. */
export function hoverReplaces(focused, docked) {
  return !(focused && docked);
}

/** A point of the scene on the screen: x, y, its distance z from the camera, and the scale s there. */
export function project(p, cam, C, F) {
  const q = rotX(rotY({ x: p.x - cam.fx, y: p.y - cam.fy, z: p.z - cam.fz }, cam.yaw), cam.pitch);
  const z = q.z + cam.dist, s = F / max(0.05, z);
  return { x: C.x + q.x * s, y: C.y + q.y * s, z, s };
}

/** A project's sphere radius in scene units: bigger with more facts, smaller for parked ones and ideas. */
export function nodeRadius(p) {
  return (0.022 + sqrt(p.facts) * 0.0055) * (p.state === 'parked' ? 0.7 : p.state === 'idea' ? 0.75 : 1);
}

/** Points on a unit sphere, spread evenly (a Fibonacci sphere), for a project's dust. */
function shell(n) {
  const out = [];
  for (let k = 0; k < n; k++) { const y = 1 - ((k + 0.5) / n) * 2, r = sqrt(1 - y * y), th = k * 2.39996; out.push({ x: cos(th) * r, y, z: sin(th) * r }); }
  return out;
}

function start(root) {
  const $ = (s) => (root.querySelector(s));
  const canvas = ($('.graph-canvas'));
  const cx = (canvas.getContext('2d'));
  const list = (document.querySelector('.graph-list'));
  const hint = $('.graph-hint');
  const reducedQ = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = reducedQ.matches;
  const mobile = matchMedia('(pointer: coarse)').matches;
  const session = (() => { try { return sessionStorage; } catch { return null; } })();
  const quality = createQuality();
  const cam = { ...START };
  const tgt = { ...START };
  let W = 0, H = 0, DPR = 1, F = 1, level = 0, small = false;
  let C = { x: 0, y: 0 }, C0 = 0;
  let data = null;
  let nodes = [];
  let places = [];
  let areas = [];
  const sprites = new Map();
  const ui = { showThreads: true, userTurn: !mobile, touched: false, lastInput: clock(), dragging: false, pinching: false };
  let bootStart = -1e9, raf = 0, last = 0, labels = 0;
  const taken = [];
  let focus = null;
  let hover = null;
  let lit = null;
  /** What lit the projects: 'find' or 'place'. Only Find names an unpinned Personal project. */
  let litBy = null;
  let expand = 0;
  let vignette = null;
  let dark = true;
  /** A node's colour, read at draw time from the current theme (never cached at build). */
  const colOf = (n) => areaColour(n.area, dark);
  const stars = Array.from({ length: 220 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.2 + 0.3, d: Math.random() }));

  /** The part of the window's right edge a docked card covers (desk.css's --g-inset-right; 0 on the phone). */
  let insetRight = 0;
  const readInset = () => { insetRight = parseFloat(getComputedStyle(root).getPropertyValue('--g-inset-right')) || 0; };
  function measure() {
    readInset();
    const r = canvas.getBoundingClientRect();
    W = max(1, r.width); H = max(1, r.height);
    DPR = quality.dpr(devicePixelRatio || 1); level = quality.level;
    canvas.width = round(W * DPR); canvas.height = round(H * DPR);
    ({ small, C, F } = viewFrame(W, H));
    C0 = C.y;
    vignette = cx.createRadialGradient(C.x, C.y, 0, C.x, C.y, max(W, H) * 0.7);
    vignette.addColorStop(0, hexA(WINDOW_INK.glow, WINDOW_INK.glowAlpha)); vignette.addColorStop(1, hexA(WINDOW_INK.glow, 0));
  }

  const P3 = (p) => project(p, cam, C, F);
  /** The buttons, Find, the key line, the card and the sheet lie over the window: no text is drawn under them. */
  function overlays() {
    const c = canvas.getBoundingClientRect();
    for (const q of ['.graph-bar', '.graph-find', '.graph-keys', '.graph-hint', '.graph-card', '.graph-sheet']) {
      const e = $(q); if (!e || e.hidden) continue; const r = e.getBoundingClientRect(); if (r.width) taken.push({ x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height, ov: 1 }); }
  }
  const fog = (z) => max(0.16, min(1, 1 - ((z - (cam.dist - 1.1)) / 2.2) * 0.85));

  function build(d) {
    data = d;
    const byArea = new Map();
    d.projects.forEach((p, i) => { const a = p.area ?? 'unsorted'; if (!byArea.has(a)) byArea.set(a, []); byArea.get(a).push(i); });
    areas = Object.keys(AREA_STYLE).filter((a) => byArea.has(a));
    const total = d.projects.reduce((n, p) => n + min(48, p.facts), 0);
    const scale = total > 2500 ? 2500 / total : 1;
    nodes = d.projects.map((p, i) => ({ i, p, area: p.area ?? 'unsorted', r: nodeRadius(p), dust: shell(floor(min(48, p.facts) * scale)), scr: null }));
    for (const a of areas) {
      const lay = layoutOrbit(byArea.get(a).map((i) => d.projects[i].name));
      for (const l of lay) {
        const n = nodes.find((x) => x.p.name === l.name && x.area === a);
        n.t = l.angle; n.pos = orbitPt(AREA_STYLE[a], l.angle, l.lane ? 1.1 : 1);
      }
    }
    places = d.places.map((pl, i, all) => ({ ...pl, place: true, pos: { x: cos((i / all.length) * TAU) * 0.36, y: sin(i * 2.1) * 0.05, z: sin((i / all.length) * TAU) * 0.36 }, scr: null }));
  }

  /** A sphere and its halo, drawn once per colour and size into a small canvas, then stamped. */
  function sprite(col, rad) {
    const big = rad > 10, key = `${col}${big}${DPR}`;
    let sp = sprites.get(key);
    if (!sp) {
      const R = (big ? 32 : 10) * DPR, size = Math.ceil(R * 6.4);
      const c = document.createElement('canvas'); c.width = c.height = size;
      const g = (c.getContext('2d')), m = size / 2;
      const halo = g.createRadialGradient(m, m, R, m, m, R * 3.2); halo.addColorStop(0, hexA(col, 0.22)); halo.addColorStop(1, hexA(col, 0));
      g.fillStyle = halo; g.beginPath(); g.arc(m, m, R * 3.2, 0, TAU); g.fill();
      const body = g.createRadialGradient(m - R * 0.35, m - R * 0.4, R * 0.1, m, m, R); body.addColorStop(0, WINDOW_INK.shine); body.addColorStop(0.25, col); body.addColorStop(1, hexA(col, 0.25));
      g.fillStyle = body; g.beginPath(); g.arc(m, m, R, 0, TAU); g.fill();
      sp = { c, R: R / DPR }; sprites.set(key, sp);
    }
    return sp;
  }

  /** Line segments gathered by colour and fade, stroked as a few paths. */
  const batch = new Map();
  function seg(col, a, A, B, w = 1) {
    if (a < 0.004) return;
    const k = `${col}|${round(a * 50) / 50}|${w}`;
    let s = batch.get(k); if (!s) { s = []; batch.set(k, s); }
    s.push(A.x, A.y, B.x, B.y);
  }
  function flush() {
    for (const [k, s] of batch) {
      const [col, a, w] = k.split('|');
      cx.strokeStyle = col === 'ink' ? ink(+a) : hexA(col, +a); cx.lineWidth = +w; cx.beginPath();
      for (let i = 0; i < s.length; i += 4) { cx.moveTo(s[i], s[i + 1]); cx.lineTo(s[i + 2], s[i + 3]); }
      cx.stroke();
    }
    batch.clear();
  }
  function ring(at, n, upto, col, a, w = 1) {
    let prev = P3(at(0));
    for (let i = 1; i <= round(n * upto); i++) { const p = P3(at((i / n) * TAU)); seg(col, a * fog((p.z + prev.z) / 2), prev, p, w); prev = p; }
  }
  /** Text on a plate of the background, with a thin edge of it, so no thread or ring runs through its letters. */
  function text(s, x, y) {
    if (labels >= 80) return; labels++;
    const m = cx.measureText(s), a = m.fontBoundingBoxAscent ?? 10, d = m.fontBoundingBoxDescent ?? 3, al = cx.textAlign;
    const ink0 = cx.fillStyle, x0 = al === 'center' ? x - m.width / 2 : al === 'right' ? x - m.width : x;
    cx.fillStyle = hexA(WINDOW_INK.bg, 0.72); cx.fillRect(x0 - 3, y - a, m.width + 6, a + d);
    cx.fillStyle = ink0;
    cx.strokeStyle = hexA(WINDOW_INK.bg, 0.85); cx.lineWidth = 3; cx.lineJoin = 'round';
    cx.strokeText(s, x, y); cx.fillText(s, x, y);
  }
  const fit = (t, w) => { if (cx.measureText(t).width <= w) return t; while (t.length > 4 && cx.measureText(`${t}…`).width > w) t = t.slice(0, -1); return `${t}…`; };

  function draw(now) {
    const boot = min(1.25, (now - bootStart) / BOOT_MS);
    const phase = (a, b) => ease((boot - a) / (b - a));
    const spin = now / 1000;
    labels = 0; taken.length = 0; fb = null; overlays();
    cx.setTransform(DPR, 0, 0, DPR, 0, 0);
    cx.fillStyle = WINDOW_INK.bg; cx.fillRect(0, 0, W, H);
    if (vignette) { cx.fillStyle = vignette; cx.fillRect(0, 0, W, H); }
    cx.fillStyle = `rgba(${WINDOW_INK.star},${WINDOW_INK.starAlpha})`;
    for (const s of stars) cx.fillRect((((s.x * W - cam.yaw * 30 * s.d) % W) + W) % W, s.y * H, s.r, s.r);
    if (!data) return;
    const fl = focus ? new Set([focus, ...related(focus)]) : null;
    const vis = (n) => !(lit && !lit.has(n)) && !(fl && !fl.has(n));
    const dim = fl ? 0.4 : 1;

    // The floor: rings, spokes and degree ticks under everything.
    const pF = phase(0.05, 0.45);
    [0.4, 0.7, 1.0, 1.3].forEach((r, i) => ring((t) => ({ x: cos(t) * r, y: FLOOR_Y, z: sin(t) * r }), 90, pF, 'ink', (i === 3 ? 0.13 : 0.07) * dim));
    for (let i = 0; i < 24; i++) { const a = (i / 24) * TAU, A = P3({ x: cos(a) * 0.4, y: FLOOR_Y, z: sin(a) * 0.4 }), B = P3({ x: cos(a) * 1.3, y: FLOOR_Y, z: sin(a) * 1.3 }); seg('ink', 0.05 * pF * fog((A.z + B.z) / 2) * dim, A, B); }
    if (quality.floorTicks) for (let i = 0; i < 120; i++) { const a = (i / 120) * TAU - (reduced ? 0 : spin * 0.03), long = i % 10 === 0, A = P3({ x: cos(a) * 1.3, y: FLOOR_Y, z: sin(a) * 1.3 }), r2 = long ? 1.39 : 1.34, B = P3({ x: cos(a) * r2, y: FLOOR_Y, z: sin(a) * r2 }); seg('ink', (long ? 0.3 : 0.13) * pF * fog(A.z) * dim, A, B); }
    // Hologram stands under the projects on the go.
    if (!fl) for (const n of nodes) if (n.p.onTheGo && n.pos) {
      const col = colOf(n), foot = { x: n.pos.x, y: FLOOR_Y, z: n.pos.z };
      ring((t) => ({ x: foot.x + cos(t) * 0.05, y: FLOOR_Y, z: foot.z + sin(t) * 0.05 }), 24, phase(0.45, 0.9), col, 0.35);
      const A = P3(n.pos), B = P3(foot); cx.setLineDash([2, 4]); cx.strokeStyle = hexA(col, 0.22 * fog(A.z) * phase(0.45, 0.9)); cx.beginPath(); cx.moveTo(A.x, A.y); cx.lineTo(B.x, B.y); cx.stroke(); cx.setLineDash([]);
    }
    // The core: you, with the profile facts.
    const pC = phase(0, 0.3), CR = 0.13 * pC, rot = reduced ? 0 : spin * 0.4;
    for (let l = -2; l <= 2; l++) { const y = (l / 3) * CR, rr = sqrt(max(0, CR * CR - y * y)); ring((t) => ({ x: cos(t + rot) * rr, y, z: sin(t + rot) * rr }), 48, 1, 'ink', 0.32); }
    for (let m = 0; m < 6; m++) { const a0 = (m / 6) * PI + rot; ring((b) => ({ x: cos(b) * CR * cos(a0), y: sin(b) * CR, z: cos(b) * CR * sin(a0) }), 32, 1, 'ink', 0.22); }
    flush();
    const core = P3({ x: 0, y: 0, z: 0 });
    const cg = cx.createRadialGradient(core.x, core.y, 0, core.x, core.y, core.s * 0.09);
    const [core0, core1] = WINDOW_INK.core;
    cg.addColorStop(0, core0); cg.addColorStop(0.35, core1); cg.addColorStop(1, core1.replace(/[\d.]+\)$/, '0)'));
    cx.fillStyle = cg; cx.beginPath(); cx.arc(core.x, core.y, core.s * 0.09, 0, TAU); cx.fill();
    const base = core.s * pC;
    cx.save(); cx.translate(core.x, core.y);
    for (const [r, n, sp, al] of [[0.17, 3, 0.3, 0.45], [0.205, 5, -0.22, 0.3], [0.24, 8, 0.12, 0.2]]) {
      cx.save(); cx.rotate(reduced ? 0 : spin * sp); cx.strokeStyle = ink(al * dim); cx.lineWidth = 1.2; cx.beginPath();
      for (let k = 0; k < n; k++) { const a = (k / n) * TAU; cx.moveTo(cos(a) * base * r, sin(a) * base * r); cx.arc(0, 0, base * r, a, a + (TAU / n) * 0.6); }
      cx.stroke(); cx.restore();
    }
    cx.restore();
    const you = !fl && pC > 0.9 ? { x: core.x, y: core.y + base * 0.33, top: core.y - base * 0.33 } : null;
    coreScr = core;

    // One orbit per area that has projects, with its name at the top of its front half.
    const pR = phase(0.15, 0.55);
    for (const a of areas) {
      const o = AREA_STYLE[a];
      ring((t) => orbitPt(o, t), 140, pR, areaColour(a, dark), fl ? 0.08 : 0.42, 1.1);
      ring((t) => orbitPt(o, t, 0.985), 140, pR, 'ink', fl ? 0.02 : 0.06);
    }
    flush();
    // Threads: one curve each, faint at overview, bright for the project in view.
    const pT = phase(0.9, 1.15);
    if (ui.showThreads && pT > 0) for (const th of data.threads) {
      const A0 = nodes[th.a], B0 = nodes[th.b];
      const look = threadLook(A0, B0, { focus, hover, lit }), on = look === 'on';
      if (!look) continue;
      const mid = { x: (A0.pos.x + B0.pos.x) * 0.34, y: (A0.pos.y + B0.pos.y) * 0.34, z: (A0.pos.z + B0.pos.z) * 0.34 };
      const A = P3(A0.pos), B = P3(B0.pos), M = P3(mid);
      const qx = 2 * M.x - (A.x + B.x) / 2, qy = 2 * M.y - (A.y + B.y) / 2;
      cx.strokeStyle = on ? `rgba(${WINDOW_INK.hot},${0.85 * fog(M.z)})` : ink((0.04 + 0.06 * th.strength) * pT * fog(M.z));
      cx.lineWidth = on ? 1.3 : 1; cx.beginPath(); cx.moveTo(A.x, A.y); cx.quadraticCurveTo(qx, qy, B.x, B.y); cx.stroke();
      if (on && !reduced && raf) for (let d = 0; d < 3; d++) {
        const t = ((now / 1100 + d / 3) % 1), u = 1 - t;
        cx.fillStyle = hexA(WINDOW_INK.spark, 0.9); cx.beginPath(); cx.arc(u * u * A.x + 2 * u * t * qx + t * t * B.x, u * u * A.y + 2 * u * t * qy + t * t * B.y, 1.8, 0, TAU); cx.fill();
      }
    }

    // Places and projects, back to front. Their text is laid out in one pass (sceneLabels), then drawn over them.
    // The core's rings count as a sphere: text goes round them.
    const items = [], marks = pC > 0.5 ? [{ id: 'you', x: core.x, y: core.y, r: base * 0.25 }] : [], named0 = [], callouts = [], spots = [], rings = [];
    const pM = phase(0.3, 0.5);
    if (pM > 0.5) for (const m of places) {
      const s = P3(m.pos), d = max(3, s.s * 0.016); m.scr = s;
      spots.push({ id: `place:${m.id}`, x: s.x, y: s.y, d, label: m.label.toUpperCase(), want: (lit && lit.has(m)) || hover === m, a: fog(s.z) });
      items.push({ z: s.z, f: () => {
        cx.globalAlpha = fog(s.z) * (vis(m) ? 1 : 0.2);
        cx.strokeStyle = ink(0.85); cx.lineWidth = 1.2; cx.beginPath(); cx.moveTo(s.x, s.y - d); cx.lineTo(s.x + d, s.y); cx.lineTo(s.x, s.y + d); cx.lineTo(s.x - d, s.y); cx.closePath(); cx.stroke();
        cx.globalAlpha = 1;
      } });
    }
    const zoomed = cam.dist < 2.4;
    nodes.forEach((n, k) => {
      const t0 = 0.45 + (k / max(1, nodes.length)) * 0.42, pp = phase(t0, t0 + 0.12);
      if (pp <= 0 || !n.pos) { n.scr = null; return; }
      const s = P3(n.pos), rad = max(2, n.r * s.s) * pp, p = n.p, a = alphaOf(n, s, vis(n), fl); n.scr = s;
      // What must not move claims its space first: the flown-in project's block, brackets and the "+n" of waiting.
      if (n === focus) claimFocus(n, s, rad);
      if (n === hover || (lit && lit.has(n))) { const b = rad + 9; taken.push({ x: s.x - b, y: s.y - b, w: 2 * b, h: 2 * b, body: 1 }); }
      if (p.state !== 'parked' && vis(n) && p.waiting > 8) taken.push({ x: s.x + rad + 7, y: s.y - rad - 13, w: 22, h: 12, id: p.name });
      marks.push({ id: p.name, x: s.x, y: s.y, r: rad + 2, ...(vis(n) ? {} : { dim: 1 }) });
      if (!fl && !lit && p.onTheGo) callouts.push({ id: p.name, x: s.x, y: s.y, rad, col: colOf(n), a: max(0.45, fog(s.z)), label: p.name.toUpperCase() + (p.waiting ? `  ·${p.waiting}` : ''), next: p.next ? (p.next.length > 42 ? `${p.next.slice(0, 41)}…` : p.next) : '' });
      else if (n !== focus) {
        const want = n === hover ? 'hover' : lit && lit.has(n) ? 'found' : fl && fl.has(n) ? 'related' : zoomed && !fl && s.z < cam.dist + 0.15 ? 'zoom' : null;
        if (want) named0.push({ id: p.name, x: s.x, y: s.y, z: s.z, rad, want, a, name: named(n) ? p.name.toUpperCase() : null, stat: named(n) ? statLine(p) : '' });
      }
      items.push({ z: s.z, f: () => drawNode(n, s, pp, vis(n), fl, now, a) });
    });
    // Each area's name on its own ring, where the ring is clearest.
    if (pR > 0.95 && !fl) for (const a of areas) {
      const o = AREA_STYLE[a], pts = [];
      for (let i = 0; i < 48; i++) { const q = P3(orbitPt(o, (i / 48) * TAU)); pts.push({ x: q.x, y: q.y, z: q.z, front: q.z < cam.dist }); }
      rings.push({ id: a, text: AREA_LABEL[a].replace(' & infrastructure', '').toUpperCase(), col: areaColour(a, dark), pts });
    }
    const extra = focus && focus.scr && expand > 0.2 ? focusRequests(focusAnchors(focus, focus.scr), W, width) : [];
    const shown = sceneLabels({ W, H, small, cx: C.x, taken, marks, you, nodes: named0, places: spots, callouts: callouts.slice(0, 6), rings, extra }, width);
    items.sort((a, b) => b.z - a.z).forEach((it) => it.f());
    if (focus && focus.scr && fb) drawFocus(focus, focus.scr);
    drawLabels(shown);
  }

  const FONTS = { name: `500 12px ${MONO}`, stat: `11.5px ${MONO}`, place: `600 11.5px ${MONO}`, callout: `600 12.5px ${MONO}`, next: `12px ${SANS}`, area: `600 12px ${MONO}`, page: `500 13px ${SANS}`, decision: `13px ${SANS}` };
  const widths = new Map();
  /** A text's width in one of the window's fonts, measured once. */
  function width(t, font) {
    const k = `${font}\n${t}`;
    let w = widths.get(k);
    if (w === undefined) { cx.font = FONTS[font]; w = cx.measureText(t).width; widths.set(k, w); }
    return w;
  }
  /** Draws the placed text, each exactly in the box it was placed in. */
  function drawLabels(shown) {
    for (const l of shown) {
      cx.globalAlpha = textAlpha(l.kind === 'area' ? fog(l.z) : l.a ?? 1);
      if (l.kind === 'callout') { drawCallout(l); continue; }
      if (l.kind === 'page' || l.kind === 'decision') { drawDetail(l); continue; }
      cx.textAlign = l.kind === 'name' || l.kind === 'zoom' ? (l.right ? 'right' : 'left') : 'center';
      if (l.kind === 'you') {
        cx.fillStyle = WINDOW_INK.text; cx.font = `600 12px ${MONO}`; text('YOU', l.x + l.w / 2, l.y + 12);
        cx.fillStyle = WINDOW_INK.muted; cx.font = `11px ${MONO}`; text(`${data.profileFacts} PROFILE FACTS`, l.x + l.w / 2, l.y + 26);
      } else if (l.kind === 'area') { cx.fillStyle = l.col; cx.font = FONTS.area; text(l.text, l.x + l.w / 2, l.y + 12); }
      else if (l.kind === 'place') { cx.fillStyle = WINDOW_INK.text; cx.font = FONTS.place; text(l.text, l.x + l.w / 2, l.y + 11); }
      else {
        if (l.from) { cx.strokeStyle = ink(0.5); cx.lineWidth = 1; cx.beginPath(); cx.moveTo(l.from.x, l.from.y); cx.lineTo(l.to.x, l.to.y); cx.stroke(); }
        const tx = l.right ? l.x + l.w : l.x;
        cx.fillStyle = WINDOW_INK.text; cx.font = FONTS.name; text(l.text, tx, l.y + 11);
        if (l.stat) { cx.fillStyle = WINDOW_INK.muted; cx.font = FONTS.stat; text(l.stat, tx, l.y + 25); }
      }
    }
    cx.globalAlpha = 1;
  }
  /** A page of the flown-in project as a small panel and its title; a decision led from its speck, as it opens up. */
  function drawDetail(l) {
    cx.textAlign = 'left';
    if (l.kind === 'page') {
      cx.globalAlpha = expand;
      const px = l.flip ? l.x + l.w - 9 : l.x, tx = l.flip ? l.x : l.x + 15;
      cx.strokeStyle = ink(0.7); cx.lineWidth = 1; cx.strokeRect(px, l.y + 3, 9, 11); cx.fillStyle = hexA(WINDOW_INK.text, 0.12); cx.fillRect(px, l.y + 3, 9, 11);
      cx.fillStyle = WINDOW_INK.text; cx.font = FONTS.page; text(l.text, tx, l.y + 13);
      return;
    }
    cx.globalAlpha = min(1, (expand - 0.5) * 2);
    cx.strokeStyle = ink(0.5); cx.lineWidth = 1; cx.beginPath(); cx.moveTo(l.from.x, l.from.y); cx.lineTo(l.ex, l.ey); cx.lineTo(l.ex + l.side * 10, l.ey); cx.stroke();
    cx.fillStyle = WINDOW_INK.spark; cx.beginPath(); cx.arc(l.from.x, l.from.y, 2.2, 0, TAU); cx.fill();
    cx.fillStyle = WINDOW_INK.text; cx.font = FONTS.decision; text(l.text, l.x, l.ey + 4);
  }
  /** An On the go callout: a leader from its sphere to a shelf, the name above it and the next step below. */
  function drawCallout(l) {
    const side = l.side;
    cx.globalAlpha = l.a; cx.strokeStyle = hexA(l.col, 0.75); cx.lineWidth = 1; cx.beginPath(); cx.moveTo(l.from.x, l.from.y); cx.lineTo(l.lx, l.ly); cx.lineTo(l.L2, l.ly); cx.stroke();
    cx.fillStyle = l.col; cx.fillRect(l.L2 - (side > 0 ? 2 : 0), l.ly - 2, 2, 4);
    cx.globalAlpha = textAlpha(l.a); cx.textAlign = side > 0 ? 'left' : 'right'; cx.fillStyle = WINDOW_INK.text; cx.font = FONTS.callout;
    text(l.text, l.lx + side * 2, l.ly - 6);
    if (l.next) { cx.fillStyle = WINDOW_INK.muted; cx.font = FONTS.next; text(l.next, l.lx + side * 2, l.ly + 15); }
  }
  let coreScr = (null);

  function related(n) {
    return data.threads.filter((t) => t.a === n.i || t.b === n.i).map((t) => nodes[t.a === n.i ? t.b : t.a]);
  }
  const named = (n) => nameShown(n.p.unlabelled, { hover: n === hover, focus: n === focus, found: litBy === 'find' && !!lit && lit.has(n) && nameMatch(n.p.name, findQ) });

  /** A project's fade: by depth, by how long since it was touched, dimmed when another is in view, faint when parked. */
  function alphaOf(n, s, v, fl) {
    const p = n.p, act = p.days <= 1 ? 1 : p.days <= 7 ? 0.85 : p.days <= 20 ? 0.6 : 0.42;
    return fog(s.z) * (v ? 1 : 0.12) * (fl && n !== focus ? 1 : act) * (p.state === 'parked' ? 0.45 : 1);
  }

  function drawNode(n, s, pp, v, fl, now, a) {
    const p = n.p, col = colOf(n), isF = n === focus, ex = isF ? expand : 0;
    const rad = max(2, n.r * s.s) * pp;
    if (rad >= 3) drawDust(n, s, a, ex, now);
    cx.globalAlpha = a;
    if (p.state === 'idea') { cx.strokeStyle = col; cx.lineWidth = 1.3; cx.beginPath(); cx.arc(s.x, s.y, rad * 0.8, 0, TAU); cx.stroke(); }
    else { const sp = sprite(col, rad), k = rad / sp.R, size = sp.c.width / DPR * k; cx.drawImage(sp.c, s.x - size / 2, s.y - size / 2, size, size); }
    if (p.days === 0 && v && !reduced && raf) { const t = (now / 2400 + n.t) % 1; cx.strokeStyle = hexA(col, 0.5 * (1 - t) * fog(s.z)); cx.lineWidth = 1; cx.beginPath(); cx.arc(s.x, s.y, rad + 3 + t * rad * 2.2, 0, TAU); cx.stroke(); }
    if (p.state !== 'parked' && v && p.waiting > 0) {
      const w = waitTicks(p.waiting, p.late), wr = rad + 4.5;
      cx.lineWidth = 2;
      for (let i = 0; i < w.late + w.amber; i++) { const a0 = -PI / 2 + i * 0.42; cx.strokeStyle = i < w.late ? WINDOW_INK.late : WINDOW_INK.soon; cx.beginPath(); cx.arc(s.x, s.y, wr, a0, a0 + 0.3); cx.stroke(); }
      if (w.more > 0) { cx.fillStyle = WINDOW_INK.soon; cx.font = `10px ${MONO}`; cx.textAlign = 'left'; text(`+${w.more}`, s.x + wr + 3, s.y - wr + 4); }
    }
    cx.globalAlpha = 1;
    if (n === hover || (lit && lit.has(n))) {
      const b = rad + 7 + (reduced ? 0 : sin(now / 220) * 1.2), L = b * 0.5;
      cx.strokeStyle = n === hover ? WINDOW_INK.text : col; cx.lineWidth = 1.2; cx.beginPath();
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const x = s.x + dx * b, y = s.y + dy * b; cx.moveTo(x, y - dy * L); cx.lineTo(x, y); cx.lineTo(x - dx * L, y); }
      cx.stroke();
    }
  }

  /** A speck of dust's place: the project's current facts on a shell round it, turning, spread out after a fly-in. */
  function speck(n, u, ex, now) {
    const sr = n.r * 2.2 + ex * 0.16, turn = (reduced ? 0 : (now / 1000) * 0.35) + n.t, c = cos(turn), sn = sin(turn);
    return P3({ x: n.pos.x + (u.x * c + u.z * sn) * sr, y: n.pos.y + u.y * sr, z: n.pos.z + (-u.x * sn + u.z * c) * sr });
  }
  /** Round specks, each faded by its own depth as in the mockup; gathered into a few paths by fade, so it stays cheap. */
  function drawDust(n, s, a, ex, now) {
    const count = floor(n.dust.length * quality.dust);
    if (count === 0) return;
    const paths = new Map();
    for (let i = 0; i < count; i++) {
      const q = speck(n, n.dust[i], ex, now), k = round(fog(q.z) * 8) / 8, r = max(0.7, q.s * (0.0028 + ex * 0.003));
      let p = paths.get(k); if (!p) { p = new Path2D(); paths.set(k, p); }
      p.moveTo(q.x + r, q.y); p.arc(q.x, q.y, r, 0, TAU);
    }
    cx.fillStyle = hexA(colOf(n), min(1, (a / fog(s.z)) * (0.5 + ex * 0.4)));
    for (const [k, p] of paths) { cx.globalAlpha = k; cx.fill(p); }
    cx.globalAlpha = 1;
  }

  /** The flown-in project's block: name and counts beside it, pages under them, decisions on the other side.
   *  Claimed before any other name is drawn, so related names go round it. */
  let fb = null;
  function claimFocus(n, s, rad) {
    const p = n.p, put = (x, y, w, h) => taken.push({ x, y, w, h });
    cx.font = `600 15px ${MONO}`; const nm = fit(p.name.toUpperCase(), W - 12), w1 = cx.measureText(nm).width;
    cx.font = `11.5px ${MONO}`; const st = fit(statLine(p), W - 12);
    const bw = max(w1, cx.measureText(st).width), { x, y } = focusBlock(s.x, s.y, rad, bw, W);
    fb = { nm, st, x, dy: y - s.y };
    put(x, y - 9, bw, 32);
    taken.push(focusBody(s.x, s.y, rad, p.name));
  }

  /** Where the flown-in project's pages and decisions start from: pages on a ring round it, decisions on its specks. */
  function focusAnchors(n, s) {
    const p = n.p, ex = expand, rot = reduced ? 0 : (clock() / 1000) * 0.06;
    const pages = p.pages.slice(0, 6).map((text, k, all) => {
      const ang = (k / all.length) * TAU + rot + 0.6;
      return { text, q: P3({ x: n.pos.x + cos(ang) * 0.26 * ex, y: n.pos.y - 0.06 + k * 0.05, z: n.pos.z + sin(ang) * 0.26 * ex }) };
    });
    const dec = detail && detail.name === p.name && ex > 0.5 ? detail.decisions : [];
    const dust = n.dust.length >= dec.length && n.dust.length > 0 ? n.dust : shell(max(1, dec.length));
    const decisions = dec.map((d, k) => ({ text: d.text, q: speck(n, dust[floor(((k + 0.5) / dec.length) * dust.length)], ex, clock()) }));
    return { x: s.x, own: p.name, pages, decisions };
  }

  /** The flown-in project's own lines, then its pages and decisions as it opens up. */
  function drawFocus(n, s) {
    cx.globalAlpha = 1; cx.textAlign = 'left'; cx.fillStyle = WINDOW_INK.text; cx.font = `600 15px ${MONO}`; text(fb.nm, fb.x, s.y + fb.dy + 4);
    cx.fillStyle = WINDOW_INK.muted; cx.font = `11.5px ${MONO}`; text(fb.st, fb.x, s.y + fb.dy + 19);
  }

  let detail = null;

  // ---- The quiet loop: frames only while something moves.
  const flags = () => ({ dragging: ui.dragging, pinching: ui.pinching, flying: false, booting: clock() - bootStart < BOOT_MS * 1.25, turning: turning() });
  const turning = () => turnAllowed({ userOn: ui.userTurn, mobile, reducedMotion: reduced, sinceInputMs: clock() - ui.lastInput, touched: ui.touched });
  function wake() {
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
  }
  function frame(now) {
    const dt = min(0.05, max(0, (now - last) / 1000)); last = now;
    if (turning() && now - ui.lastInput > 2500 && !ui.dragging) tgt.yaw += dt * 0.09;
    for (const k of CAM_KEYS) cam[k] = reduced ? tgt[k] : approach(cam[k], tgt[k], dt);
    expand = reduced ? (focus ? 1 : 0) : approach(expand, focus ? 1 : 0, dt, 0.2);
    // On the phone the selected project rises into the part of the window the sheet leaves free.
    // On the desktop it moves right, clear of the floating card, or centres left of the card docked on the right.
    const cy = focus && sheetMode() ? H * 0.3 + 24 : C0, cxT = focus ? focusX(W, { sheet: sheetMode(), insetRight }) : W / 2;
    C.y = reduced ? cy : approach(C.y, cy, dt);
    C.x = reduced ? cxT : approach(C.x, cxT, dt);
    // A step down in quality resizes the canvas, which clears it: always before a frame is drawn, never after.
    if (quality.level !== level) measure();
    const t0 = clock();
    draw(now);
    quality.record(clock() - t0);
    const more = needsFrame(flags(), cam, tgt) || abs(expand - (focus ? 1 : 0)) > 1e-3 || abs(C.y - cy) > 0.5 || abs(C.x - cxT) > 0.5;
    raf = 0;
    if (more) wake();
  }
  /** After input stops, Turn slowly starts again 2.5 s later: one timer, not a running loop. */
  let turnTimer = 0;
  function input() {
    ui.lastInput = clock();
    if (bootStart > 0 && clock() - bootStart < BOOT_MS * 1.25) bootStart = -1e9;
    clearTimeout(turnTimer);
    if (ui.userTurn && !reduced) turnTimer = setTimeout(wake, 2600);
    wake();
  }

  function show(d) {
    build(d);
    // The boot is decided first: the first frame is then its empty start, not the finished graph for one frame.
    if (bootWanted(session, reduced)) { bootStart = clock(); try { session?.setItem('graph-booted', '1'); } catch { /* private mode */ } }
    document.body.classList.add('graph-on');
    root.hidden = false;
    measure();
    draw(clock());
    if (list) list.hidden = true;
    last = clock();
    restore();
    wake();
    if (mobile && session && !session.getItem('graph-hint')) {
      try { session.setItem('graph-hint', '1'); } catch { /* private mode */ }
      hint.hidden = false;
      setTimeout(fadeHint, 4000);
    }
  }
  function fadeHint() {
    if (hint.hidden) return;
    hint.classList.add('graph-fade');
    setTimeout(() => { hint.hidden = true; }, reduced ? 0 : 700);
  }

  // ---- Turning, pinching and zooming.
  const ptrs = new Map();
  let down = null, pinch0 = (null);
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); fadeHint();
    if (ptrs.size === 1) down = { x: e.clientX, y: e.clientY, yaw: tgt.yaw, pitch: tgt.pitch, t: clock() };
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = { d: hypot(a.x - b.x, a.y - b.y), dist: tgt.dist }; ui.pinching = true; ui.dragging = false; }
    input();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2 && pinch0) { const [a, b] = [...ptrs.values()]; tgt.dist = max(0.8, min(6, (pinch0.dist * pinch0.d) / max(1, hypot(a.x - b.x, a.y - b.y)))); cam.dist = tgt.dist; input(); return; }
    if (ptrs.size === 1 && down) {
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!ui.dragging && hypot(dx, dy) > 5) ui.dragging = true;
      if (ui.dragging) { tgt.yaw = down.yaw + dx * 0.006; tgt.pitch = max(-1.35, min(1.35, down.pitch + dy * 0.006)); cam.yaw = tgt.yaw; cam.pitch = tgt.pitch; input(); }
      return;
    }
    if (e.pointerType === 'mouse') onHover(e);
  });
  function up(e) {
    const tap = down && !ui.dragging && !ui.pinching && clock() - down.t < 450;
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) { pinch0 = null; ui.pinching = false; }
    if (ptrs.size === 0) { down = null; ui.dragging = false; }
    if (tap) onTap(e);
    input();
  }
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); tgt.dist = max(0.8, min(6, tgt.dist * exp(e.deltaY * 0.0012))); input(); }, { passive: false });

  // ---- Picking, the card and the sheet.
  const card = $('.graph-card'), sheet = $('.graph-sheet'), sheetBody = $('.graph-sheet-body'), count = $('.graph-count');
  const field = ($('#graph-q'));
  const canHover = matchMedia('(hover: hover) and (pointer: fine)').matches;
  const sheetMode = () => small || mobile;
  const areaLabel = (n) => AREA_LABEL[n.area];
  let place = null, stepAt = -1, detailCtl = null;
  function pick(e, within) {
    const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    let best = null, bd = within;
    for (const n of [...nodes, ...places]) if (n.scr) { const d = hypot(n.scr.x - x, n.scr.y - y); if (d < bd) { bd = d; best = n; } }
    if (!best && coreScr && hypot(coreScr.x - x, coreScr.y - y) < max(14, coreScr.s * 0.06)) return 'core';
    return best;
  }
  function onHover(e) {
    if (!canHover) return;
    const n = pick(e, 18), h = n && n !== 'core' && !n.place ? n : null;
    canvas.style.cursor = n ? 'pointer' : '';
    if (h === hover) return;
    hover = h;
    // A selected project's docked card stays while the pointer passes over others.
    if (!hoverReplaces(!!focus, insetRight > 0)) { wake(); return; }
    if (h) fill(h, false); else if (focus) fill(focus, true); else card.hidden = true;
    wake();
  }
  function onTap(e) {
    const n = pick(e, e.pointerType === 'mouse' ? 18 : 30);
    if (n === 'core') { location.href = '/facts?kind=profile'; return; }
    if (n && n.place) { light(place === n ? null : n); return; }
    if (n) select(n);
    // Empty space does nothing: the card stays until Back, Escape or another selection.
  }
  function el(box, tag, text, cls) {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (cls) e.className = cls;
    box.append(e);
    return e;
  }
  /** The card: built from elements and text only. `full` adds the links, once the project is selected. */
  function fill(n, full) {
    const p = n.p, box = full && sheetMode() ? sheetBody : card;
    box.replaceChildren(); box.scrollTop = 0;
    card.classList.toggle('graph-peek', !full);
    el(box, 'p', announce(p, areaLabel(n)), 'visually-hidden');
    const state = p.onTheGo ? 'On the go' : p.state === 'idea' ? 'Idea' : p.state === 'parked' ? 'Parked' : 'Open';
    const head = el(box, 'div', '', 'graph-card-head');
    head.setAttribute('aria-hidden', 'true');
    el(head, 'p', `${areaLabel(n)} · ${state}`, 'graph-card-meta');
    el(head, 'h2', p.name);
    if (p.oneLiner) el(head, 'p', p.oneLiner);
    if (p.next) el(head, 'p', `Next: ${p.next}`, 'graph-card-next');
    const line = el(head, 'p', '', 'graph-card-meta');
    if (p.waiting > 0) { el(line, 'span', `${p.waiting} waiting`); if (p.late > 0) { el(line, 'span', ' · '); el(line, 'span', `${p.late} late`, 'graph-late'); } el(line, 'span', ' · '); }
    el(line, 'span', `Touched ${p.days === 0 ? 'today' : p.days === 1 ? 'yesterday' : `${p.days} days ago`}`);
    if (full) {
      const label = new Map(data.places.map((x) => [x.id, x.label]));
      if (p.runsOn.length) el(box, 'p', `Runs on ${p.runsOn.map((r) => label.get(r) ?? r).join(', ')}`, 'graph-card-meta');
      if (detail && detail.name === p.name) {
        if (detail.related.length) {
          // One inline line, as the spec shows it: "Related: cairn: backups, nas · outline: backups".
          const rel0 = el(box, 'p', '', 'graph-related');
          el(rel0, 'span', 'Related: ');
          for (const [k, rel] of detail.related.entries()) {
            if (k > 0) el(rel0, 'span', ' · ');
            const b = el(rel0, 'button', relatedText(rel), 'graph-rel');
            b.type = 'button';
            b.addEventListener('click', () => { const m = nodes.find((x) => x.p.name === rel.name); if (m) select(m); });
          }
          if (detail.related.every((r) => r.words.length === 0)) el(rel0, 'span', ' (related by meaning)', 'graph-card-meta');
        }
        if (detail.pages.length) {
          const ul = el(box, 'ul', '', 'graph-pages');
          for (const pg of detail.pages) { const a = el(el(ul, 'li'), 'a', pg.title); a.href = `/pages/${encodeURIComponent(pg.id)}?from=` + encodeURIComponent(`/graph?project=${p.name}`); }
        }
      }
      const open = el(box, 'a', 'Open project', 'graph-open');
      open.href = `/?project=${encodeURIComponent(p.name)}#panel`;
    }
    if (full && sheetMode()) { sheet.hidden = false; card.hidden = true; } else card.hidden = false;
  }

  /** Flies in to a project: the camera moves there, its card fills in, then its details arrive. */
  function select(n) {
    if (!n || !n.pos) return;
    focus = n; hover = null; stepAt = nodes.indexOf(n);
    tgt.fx = n.pos.x; tgt.fy = n.pos.y; tgt.fz = n.pos.z; tgt.dist = 1.25;
    if (reduced) Object.assign(cam, tgt);
    btn('back').hidden = false;
    detail = null;
    fill(n, true);
    readInset();
    detailCtl?.abort();
    detailCtl = new AbortController();
    fetch(`/graph/projects/${encodeURIComponent(n.p.name)}.json`, { signal: detailCtl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && focus === n) { detail = d; fill(n, true); wake(); } })
      .catch(() => {});
    input();
  }
  function back() {
    detailCtl?.abort();
    focus = null; detail = null;
    Object.assign(tgt, { fx: 0, fy: 0, fz: 0, dist: START.dist });
    if (reduced) Object.assign(cam, tgt);
    btn('back').hidden = true; card.hidden = true; sheet.hidden = true;
    readInset();
    input();
  }
  /** A place lights its projects, the way Find does, with one line; again (or Escape) clears it. */
  function light(m) {
    place = m;
    lit = m ? new Set([m, ...nodes.filter((n) => n.p.runsOn.includes(m.id))]) : null;
    litBy = m ? 'place' : null;
    count.textContent = m ? placeLine(lit.size - 1, m.label) : '';
    input();
  }

  // ---- Find in the graph: instant local matches, then a meaning search after a pause.
  const finder = createFinder((url, signal) => fetch(url, { signal }).then((r) => r.json()));
  let findTimer = 0, server = [], findQ = '';
  function find(ask) {
    const q = field.value.trim();
    findQ = q;
    if (focus) back();
    hover = null; card.hidden = true;
    place = null;
    clearTimeout(findTimer);
    if (!q) { finder.cancel(); lit = null; litBy = null; count.textContent = ''; wake(); return; }
    const local = localMatches(data, q);
    const show = (extra) => {
      lit = new Set([...local].map((i) => nodes[i])); litBy = 'find';
      for (const name of extra) { const n = nodes.find((x) => x.p.name === name); if (n) lit.add(n); }
      count.textContent = matchLine(lit.size, q);
      wake();
    };
    server = [];
    show([]);
    const go = () => finder.ask(q).then((r) => { if (r) { server = r.projects.map((x) => x.name); show(server); } return r; });
    if (ask) return go();
    if (q.length >= 3) findTimer = setTimeout(go, 400);
  }
  field.addEventListener('input', () => find(false));
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { field.value = ''; find(false); e.stopPropagation(); }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    Promise.resolve(find(true)).then(() => {
      const local = lit ? [...lit].filter((x) => !x.place).map((x) => x.p.name) : [];
      const name = findTarget(server, local, new Set(nodes.filter((x) => x.pos).map((x) => x.p.name)));
      if (name) select(nodes.find((x) => x.p.name === name));
    });
  });
  $('.graph-find').addEventListener('submit', (e) => e.preventDefault());

  // ---- The keyboard, only while the window itself has focus.
  root.addEventListener('keydown', (e) => {
    const act = keyAction(e.key, (e.target), e.target === root);
    if (!act || !data) return;
    e.preventDefault();
    if (act === 'prev' || act === 'next') {
      stepAt = stepIndex(stepAt, act, nodes.length);
      const n = nodes[stepAt];
      if (!n) return;
      if (n.pos) { const a = atan2(n.pos.x, -n.pos.z); tgt.yaw = a + TAU * round((tgt.yaw - a) / TAU); }
      hover = n; fill(n, false);
    }
    if (act === 'tiltUp' || act === 'tiltDown') tgt.pitch = max(-1.35, min(1.35, tgt.pitch + (act === 'tiltUp' ? -0.15 : 0.15)));
    if (act === 'zoomIn' || act === 'zoomOut') tgt.dist = max(0.8, min(6, tgt.dist * (act === 'zoomIn' ? 1 / 1.15 : 1.15)));
    if (act === 'select' && stepAt >= 0) select(nodes[stepAt]);
    if (act === 'back') { if (lit) { field.value = ''; light(null); find(false); } else back(); }
    if (act === 'related') { ui.showThreads = !ui.showThreads; btn('related').setAttribute('aria-pressed', String(ui.showThreads)); }
    if (reduced) Object.assign(cam, tgt);
    input();
  });

  // ---- The sheet: its close button and a drag down on its handle go back.
  $('.graph-close').addEventListener('click', back);
  const grab = $('.graph-grab');
  let grabY = null;
  grab.addEventListener('click', back);
  grab.addEventListener('pointerdown', (e) => { grabY = e.clientY; grab.setPointerCapture(e.pointerId); });
  grab.addEventListener('pointerup', (e) => { if (grabY !== null && e.clientY - grabY > 60) back(); grabY = null; });

  // ---- The camera is kept while you browse: leaving for a panel and coming back puts the view where it was.
  const remember = () => { try { session?.setItem('graph-camera', JSON.stringify({ yaw: tgt.yaw, pitch: tgt.pitch, dist: tgt.dist, focus: focus?.p.name ?? null })); } catch { /* full or private */ } };
  addEventListener('pagehide', remember);
  root.addEventListener('click', (e) => { if ((e.target).closest('a')) remember(); });
  // The desktop's ⌘K palette picks a project by name ("In the graph"): the same as clicking its node.
  root.addEventListener('graph:select', (e) => select(nodes.find((x) => x.p.name === e.detail?.name)));
  function restore() {
    const asked = root.getAttribute('data-project');
    const byName = (name) => nodes.find((x) => x.p.name === name);
    if (asked) return select(byName(asked));
    try {
      const c = JSON.parse(session?.getItem('graph-camera') ?? 'null');
      if (!c) return;
      Object.assign(tgt, { yaw: +c.yaw || START.yaw, pitch: +c.pitch || START.pitch, dist: +c.dist || START.dist });
      Object.assign(cam, tgt);
      if (c.focus && byName(c.focus)) select(byName(c.focus));
    } catch { /* a broken copy is ignored */ }
  }

  // ---- The bottom bar.
  const btn = (act) => ($(`[data-act="${act}"]`));
  btn('turn').setAttribute('aria-pressed', String(ui.userTurn));
  root.addEventListener('click', (e) => {
    const b = (e.target).closest('[data-act]');
    if (!b) return;
    const act = b.getAttribute('data-act');
    if (act === 'related') { ui.showThreads = !ui.showThreads; b.setAttribute('aria-pressed', String(ui.showThreads)); }
    if (act === 'turn') { ui.userTurn = !ui.userTurn; ui.touched = true; b.setAttribute('aria-pressed', String(ui.userTurn)); }
    if (act === 'back') back();
    input();
  });

  // ---- The theme follows the app: blue-black in dark mode, paper in light, switched live (a phone turns dark at sunset).
  const darkQ = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    dark = darkQ.matches;
    setWindowTheme(dark);
    sprites.clear();
    if (data) { measure(); draw(clock()); }
    wake();
  }
  applyTheme();
  darkQ.addEventListener('change', applyTheme);

  // ---- Size, visibility, reduced motion.
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { measure(); draw(clock()); wake(); }).observe(root);
  else addEventListener('resize', () => { measure(); wake(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else wake(); });
  reducedQ.addEventListener('change', () => { reduced = reducedQ.matches; if (reduced) bootStart = -1e9; wake(); });

  fetch('/graph.json', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then(show)
    .catch(() => { /* The list stays: the page is still whole without the window. */ });
}

if (typeof document !== 'undefined') {
  const root = document.querySelector('.graph');
  if (root) start(root);
}
