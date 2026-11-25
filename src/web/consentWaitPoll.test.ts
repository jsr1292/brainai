import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

/** The tool sign-in waiting page (static/app.js): the poller must not stop silently when the app is unreachable. */
function run(replies: ({ ok: boolean; status?: number; json?: () => Promise<unknown> } | Error)[]) {
  const status = { textContent: '' };
  const wait = { dataset: { consentWait: '/consent/x/wait' }, querySelector: () => status };
  const delays: number[] = []; const timers: (() => void)[] = []; let calls = 0;
  const document = {
    body: { dataset: {} },
    querySelectorAll: (s: string) => (s === '[data-consent-wait]' ? [wait] : []),
    querySelector: () => null, getElementById: () => null, createElement: () => ({}), addEventListener: () => {},
  };
  const fetch = async () => { const r = replies[Math.min(calls++, replies.length - 1)]!; if (r instanceof Error) throw r; return r; };
  runInNewContext(readFileSync(new URL('./static/app.js', import.meta.url), 'utf8'), {
    document, fetch, navigator: {}, Element: class {}, Intl, Date, Number, String, Math, location: { href: 'http://x/', replace: () => {} },
    setTimeout: (fn: () => void, ms: number) => { timers.push(fn); delays.push(ms); return timers.length; }, clearTimeout: () => {},
    addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener() {} }),
  });
  const next = async () => { const fn = timers.shift(); assert.ok(fn, 'a next poll is scheduled'); fn(); await new Promise((r) => setImmediate(r)); };
  return { status, delays, next };
}

test('the sign-in waiting poller keeps asking after 20 errors, says it lost contact, and clears the line when the app answers', async () => {
  const down = new Error('offline');
  const { status, delays, next } = run([...Array.from({ length: 25 }, () => down), { ok: true, status: 200, json: async () => ({ state: 'waiting' }) }]);
  for (let i = 0; i < 25; i++) await next();
  assert.match(status.textContent, /Lost contact/);
  assert.ok(Math.max(...delays) > 1500 && Math.max(...delays) <= 15_000, 'it backs off');
  await next();
  assert.equal(status.textContent, '', 'the line goes away once the app answers');
  assert.equal(delays.at(-1), 1500);
});
