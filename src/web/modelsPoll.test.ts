import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/** A tiny DOM: enough for the models progress line in static/app.js. */
class El {
  textContent = ''; className = ''; hidden = false; href = ''; method = ''; action = ''; type = ''; max = 0; value: number | undefined;
  dataset: Record<string, string> = {}; attrs: Record<string, string> = {};
  children: El[] = []; parent: El | null = null;
  constructor(readonly tag: string) {}
  hasAttribute(n: string) { return n in this.attrs; }
  setAttribute(n: string, v: string) { this.attrs[n] = v; }
  removeAttribute(n: string) { delete this.attrs[n]; }
  #adopt(els: (El | string)[]) { return els.filter((e): e is El => typeof e !== 'string').map((e) => { e.parent = this; return e; }); }
  append(...els: (El | string)[]) { this.children.push(...this.#adopt(els)); }
  appendChild(e: El) { this.append(e); return e; }
  prepend(...els: (El | string)[]) { this.children.unshift(...this.#adopt(els)); }
  after(...els: (El | string)[]) { const p = this.parent!; const i = p.children.indexOf(this); const add = this.#adoptFor(p, els); p.children.splice(i + 1, 0, ...add); }
  #adoptFor(p: El, els: (El | string)[]) { return els.filter((e): e is El => typeof e !== 'string').map((e) => { e.parent = p; return e; }); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; }
  querySelector(sel: string): El | null {
    const match = (e: El) => (sel.startsWith('.') ? e.className.split(' ').includes(sel.slice(1)) : e.tag === sel);
    for (const c of this.children) { if (match(c)) return c; const d = c.querySelector(sel); if (d) return d; }
    return null;
  }
}

type Reply = { ok: boolean; status: number; type?: string; json?: () => Promise<unknown> } | Error;

function run(replies: Reply[]) {
  const line = new El('div'); line.dataset.modelsProgress = '/models/progress'; line.setAttribute('data-busy', '');
  const delays: number[] = []; const timers: (() => void)[] = []; let calls = 0;
  const document = {
    body: new El('body'),
    querySelectorAll: (s: string) => (s === '[data-models-progress]' ? [line] : []),
    querySelector: () => null, getElementById: () => null,
    createElement: (tag: string) => new El(tag), addEventListener: () => {},
  };
  const fetch = async () => { const r = replies[Math.min(calls++, replies.length - 1)]!; if (r instanceof Error) throw r; return { redirected: false, type: 'basic', ...r }; };
  runInNewContext(readFileSync(new URL('./static/app.js', import.meta.url), 'utf8'), {
    document, fetch, navigator: {}, Element: El, Intl, Date, Number, String, Math, location: { href: 'http://x/' },
    setTimeout: (fn: () => void, ms: number) => { timers.push(fn); delays.push(ms); return timers.length; }, clearTimeout: () => {},
    addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
  });
  const next = async () => { const fn = timers.shift(); assert.ok(fn, 'a next poll is scheduled'); fn(); await new Promise((r) => setImmediate(r)); };
  return { line, delays, next, calls: () => calls };
}

const answer = (a: object) => ({ ok: true, status: 200, json: async () => a });

test('the poll does not give up after 10 errors: it backs off to 30 s, and the line catches up when the server answers', async () => {
  const down = new Error('offline');
  const { line, delays, next } = run([...Array.from({ length: 14 }, () => down), answer({ line: 'Downloading… 63%', busy: true, failed: false, bar: { value: 63 }, ready: false })]);
  await next(); // the first poll fires from the 2 s timer
  for (let i = 0; i < 14; i++) { await next(); }
  assert.ok(delays.length >= 14, 'still scheduling after more than 10 errors');
  assert.equal(Math.max(...delays), 30_000);
  assert.equal(delays.at(-1), 2000, 'back to the normal pace once it answered');
  assert.equal(line.querySelector('.models-text')!.textContent, 'Downloading… 63%');
  assert.equal(line.querySelector('.models-bar')!.value, 63);
});

test('a failed line gets a Try again form that posts to /models/retry', async () => {
  const { line, next } = run([answer({ line: 'The search models could not be set up: x', busy: false, failed: true, bar: null, ready: false, retry: true })]);
  await next();
  const form = line.querySelector('form')!;
  assert.equal(form.method, 'post');
  assert.equal(form.action, '/models/retry');
  assert.equal(form.querySelector('button')!.textContent, 'Try again');
  assert.equal(line.children.filter((c) => c.tag === 'form').length, 1);
});

test('no Try again without a choice to run again', async () => {
  const { line, next } = run([answer({ line: 'failed', busy: false, failed: true, bar: null, ready: false, retry: false })]);
  await next();
  assert.equal(line.querySelector('form'), null);
});
