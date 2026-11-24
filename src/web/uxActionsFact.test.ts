import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { loggedIn, startTestApp } from '../testing/helpers.js';
import { MemoryError } from '../memory/service.js';
import { errorText } from './errorText.js';

const ES = { 'Accept-Language': 'es-ES,es;q=0.9' };
const EN = { 'Accept-Language': 'en-US,en;q=0.9' };
const form = (fields: Record<string, string>, headers: Record<string, string> = EN): RequestInit => ({ method: 'POST', body: new URLSearchParams(fields), headers });

async function start(t: TestContext) {
  const app = await startTestApp({ startAt: new Date('2026-09-20T09:00:00Z') });
  t.after(() => app.close());
  return app;
}

test('a blank new fact shows its error under the memory field, in English, with aria and focus', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const r = await f('/memories', form({ kind: 'decision', content: '   ', project: 'wildlog', tags: 'a b' }));
  assert.equal(r.status, 400);
  const body = await r.text();
  assert.match(body, /<textarea[^>]*aria-invalid="true"[^>]*aria-describedby="fact-content-error"[^>]*autofocus/);
  assert.match(body, /<p class="error" id="fact-content-error">Write the memory: 1 to 1000 characters\.<\/p>/);
  assert.doesNotMatch(body, /content must be/);
  assert.equal((body.match(/id="fact-[a-z]+-error"/g) ?? []).length, 1, 'shown once, by its field');
  assert.match(body, /name="project" value="wildlog"/, 'other values are kept');
  assert.match(body, /name="tags" value="a b"/);
});

test('the same error is Spanish when the screen is Spanish', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const body = await (await f('/memories', form({ kind: 'decision', content: '', project: '', tags: '' }, ES))).text();
  assert.match(body, /id="fact-content-error">Escribe el dato: de 1 a 1000 caracteres\.<\/p>/);
  assert.match(body, /aria-describedby="fact-content-error"/);
});

test('a tag the rules refuse, an over-long text and bad search words each sit under their own field', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  let body = await (await f('/memories', form({ kind: 'decision', content: 'Fine.', project: '', tags: 'Bad_Tag' }))).text();
  assert.match(body, /name="tags"[^>]*aria-invalid="true"[^>]*aria-describedby="fact-tags-error"/);
  assert.match(body, /id="fact-tags-error">Tags: &quot;Bad_Tag&quot; is not allowed|id="fact-tags-error">Tags: "Bad_Tag" is not allowed/);
  body = await (await f('/memories', form({ kind: 'decision', content: 'x'.repeat(1200), project: '', tags: '' }, ES))).text();
  assert.match(body, /id="fact-content-error">El dato tiene 1200 caracteres; el límite es 1000\./);
  body = await (await f('/memories', form({ kind: 'decision', content: 'Fine.', project: '', tags: '', keys: Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ') }))).text();
  assert.match(body, /name="keys"[^>]*aria-describedby="fact-keys-error"/);
  assert.match(body, /Search words: use at most 15 words \(you wrote 20\)\./);
});

test('the edit form of a fact does the same', async (t) => {
  const app = await start(t);
  const r = await app.deps.service.remember({ kind: 'decision', content: 'Original.', project: 'wildlog', newProject: true } as any, { type: 'owner' }) as any;
  const f = await loggedIn(app);
  const body = await (await f(`/memories/${r.memory.id}`, form({ content: '  ', project: 'wildlog', tags: '' }, ES))).text();
  assert.match(body, /<details class="pfold" id="edit" open>/);
  assert.match(body, /<textarea[^>]*aria-invalid="true"[^>]*aria-describedby="fact-content-error"/);
  assert.match(body, /id="fact-content-error">Escribe el dato: de 1 a 1000 caracteres\./);
});

test('assistants still get the English text of the error', async (t) => {
  const app = await start(t);
  await assert.rejects(
    () => app.deps.service.remember({ kind: 'decision', content: '  ', project: 'wildlog', newProject: true } as any, { type: 'ai', name: 'Claude' }),
    (e: unknown) => e instanceof MemoryError && /^content must be 1 to 1000 characters \(got 0\)$/.test(e.message) && e.key === 'err.fact.contentLength' && errorText(e) === 'Write the memory: 1 to 1000 characters.',
  );
});

test('a bad project name is shown under the project field', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const body = await (await f('/memories', form({ kind: 'decision', content: 'Fine.', project: 'Not Valid!', tags: '' }, ES))).text();
  assert.match(body, /name="project"[^>]*aria-invalid="true"[^>]*aria-describedby="fact-project-error"/);
  assert.match(body, /id="fact-project-error">Proyecto: usa minúsculas, números y guiones, hasta 63 caracteres\./);
});

test('a source note with no source is refused in Spanish, at the top of the edit form', async (t) => {
  const app = await start(t);
  const r = await app.deps.service.remember({ kind: 'decision', content: 'Original.', project: 'wildlog', newProject: true } as any, { type: 'owner' }) as any;
  const f = await loggedIn(app);
  const res = await f(`/memories/${r.memory.id}`, form({ content: 'Original.', project: 'wildlog', tags: '', source_note: 'said on a call', orig_source_note: '' }, ES));
  assert.equal(res.status, 400);
  assert.match(await res.text(), /Nota de la fuente: elige también una fuente\./);
});
