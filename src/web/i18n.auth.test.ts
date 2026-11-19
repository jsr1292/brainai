/** Login and consent pages: no English left under the pseudo-locale, and the real app in Spanish. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { appSession, loggedIn, startTestApp } from '../testing/helpers.js';
import { assertNoEnglishLeft } from '../testing/noEnglish.js';
import { enablePseudoLocale, runWithLocale } from '../i18n/core.js';
import { approvedView, deniedView, waitingView } from './consentViews.js';

process.env.OWNER_TIMEZONE ??= 'Europe/Berlin';
const ES = { 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' };
const CALLBACK = 'http://localhost:9999/callback';
const CLIENT = 'Zorbulator';

async function startConnection(baseUrl: string, name = CLIENT): Promise<string> {
  const reg = await fetch(baseUrl + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: name, token_endpoint_auth_method: 'none' }) });
  const { client_id: clientId } = await reg.json() as { client_id: string };
  const challenge = createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url');
  const auth = await fetch(baseUrl + '/authorize?' + new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 's', resource: `${baseUrl}/mcp` }), { redirect: 'manual' });
  assert.equal(auth.status, 302);
  return auth.headers.get('location')!;
}

async function start(t: TestContext, opts: Parameters<typeof startTestApp>[0] = {}) {
  const app = await startTestApp(opts);
  t.after(() => app.close());
  return app;
}
// `approve` and `deny` are the values the buttons send, not their words.
const allow = ['approve', 'deny', CLIENT, 'http://localhost:9999', 'localhost'];

test('login, wrong code and the open-the-window page have no English left', async (t) => {
  enablePseudoLocale(true);
  t.after(() => enablePseudoLocale(false));
  const app = await start(t);
  app.deps.store.setSwitch('ui_language', 'xx');
  assertNoEnglishLeft(await (await fetch(app.baseUrl + '/login')).text(), 'the login page');
  const wrong = await fetch(app.baseUrl + '/login', { method: 'POST', headers: { Origin: app.baseUrl }, body: new URLSearchParams({ password: 'nope', code: '000000' }) });
  assert.equal(wrong.status, 401);
  const wrongHtml = await wrong.text();
  assertNoEnglishLeft(wrongHtml, 'the wrong password page');
  assert.match(wrongHtml, /⟦Wrong password or code⟧/);

  const local = await start(t, { localMode: true, noPassword: true });
  local.deps.store.setSwitch('ui_language', 'xx');
  assertNoEnglishLeft(await (await fetch(local.baseUrl + '/login')).text(), 'the open-the-window page');
});

test('the consent page, its errors and the expired page have no English left', async (t) => {
  enablePseudoLocale(true);
  t.after(() => enablePseudoLocale(false));
  const app = await start(t);
  const f = await loggedIn(app);
  const consent = await startConnection(app.baseUrl);
  app.deps.store.setSwitch('ui_language', 'xx');
  const page = await (await f(consent)).text();
  assert.match(page, /⟦Allow access\?⟧/);
  assert.match(page, new RegExp(`⟦${CLIENT} wants access to your shared memory⟧`));
  assertNoEnglishLeft(page, 'the consent page', { allow: allow });
  const bad = await f(consent, { method: 'POST', body: new URLSearchParams({ decision: 'maybe' }) });
  assert.equal(bad.status, 400);
  assertNoEnglishLeft(await bad.text(), 'consent, bad decision', { allow });
  const noLevel = await f(consent, { method: 'POST', body: new URLSearchParams({ decision: 'approve' }) });
  assert.equal(noLevel.status, 302, 'a missing level keeps the suggested access');
  const expired = await f('/consent/00000000-0000-0000-0000-000000000000');
  assert.equal(expired.status, 404);
  assertNoEnglishLeft(await expired.text(), 'the expired page');
});

test('the waiting, approved and denied pages have no English left', async (t) => {
  enablePseudoLocale(true);
  t.after(() => enablePseudoLocale(false));
  runWithLocale('xx', () => {
    assertNoEnglishLeft(waitingView('abc', CLIENT, 'http://localhost:9999').value, 'the waiting page', { allow });
    assertNoEnglishLeft(approvedView(CLIENT).value, 'the approved page', { allow });
    assertNoEnglishLeft(deniedView(CLIENT).value, 'the denied page', { allow });
  });
  const app = await start(t, { localMode: true, noPassword: true });
  const cookie = await appSession(app);
  const consent = await startConnection(app.baseUrl);
  app.deps.store.setSwitch('ui_language', 'xx');
  assertNoEnglishLeft(await (await fetch(app.baseUrl + consent)).text(), 'the waiting page (real)', { allow });
  const approve = await fetch(app.baseUrl + consent, { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ decision: 'approve', from: 'window' }) });
  assert.equal(approve.status, 200);
  assertNoEnglishLeft(await approve.text(), 'approved (real)', { allow });
});

test('es: the login page and the wrong-code page, through the real app', async (t) => {
  const app = await start(t);
  const login = await (await fetch(app.baseUrl + '/login', { headers: ES })).text();
  assert.match(login, /<html lang="es">/);
  assert.match(login, /<title>Iniciar sesión<\/title>/);
  assert.match(login, /<label>Contraseña <input type="password"/);
  assert.match(login, /<label>Código de 6 dígitos <input/);
  assert.match(login, /class="primary">Iniciar sesión<\/button>/);
  const wrong = await fetch(app.baseUrl + '/login', { method: 'POST', headers: { ...ES, Origin: app.baseUrl }, body: new URLSearchParams({ password: 'nope', code: '000000' }) });
  assert.equal(wrong.status, 401);
  assert.match(await wrong.text(), /<p class="error" role="alert">Contraseña o código incorrectos<\/p>/);
});

test('es: the consent page and its answers, through the real app', async (t) => {
  const app = await start(t);
  const f = await loggedIn(app);
  const consent = await startConnection(app.baseUrl);
  const page = await (await f(consent, { headers: ES })).text();
  assert.match(page, /<title>¿Permitir el acceso\?<\/title>/);
  assert.match(page, new RegExp(`<h1>${CLIENT} quiere acceder a tu memoria compartida</h1>`));
  assert.match(page, /Te devolverá a: <strong>http:\/\/localhost:9999<\/strong>/);
  assert.match(page, /> Acceso completo: memoria y debates<\/label>/);
  assert.match(page, /name="decision" value="approve" class="primary">Aprobar<\/button>/);
  assert.match(page, /formnovalidate>Denegar<\/button>/);
  // The side bar is the signed-in owner's, so Settings is the same place as in English.
  assert.match(page, /<nav class="tabs" aria-label="Principal">/);
  const bad = await f(consent, { method: 'POST', headers: ES, body: new URLSearchParams({ decision: 'maybe' }) });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /<h1>Solicitud no válida<\/h1><p>Elige Aprobar o Denegar\.<\/p>/);
  const expired = await (await f('/consent/00000000-0000-0000-0000-000000000000', { headers: ES })).text();
  assert.match(expired, /<h1>Solicitud caducada<\/h1><p>Esta solicitud ha caducado\./);
});

test('es: the waiting and approved pages in the app window flow', async (t) => {
  const app = await start(t, { localMode: true, noPassword: true });
  const cookie = await appSession(app);
  const consent = await startConnection(app.baseUrl);
  const waiting = await (await fetch(app.baseUrl + consent, { headers: ES })).text();
  assert.match(waiting, new RegExp(`${CLIENT} quiere acceder a tu memoria`));
  assert.match(waiting, /Abre la ventana de BrainAI en este (Mac|ordenador) para aprobarlo o denegarlo\./);
  const approve = await fetch(app.baseUrl + consent, { method: 'POST', redirect: 'manual', headers: { ...ES, Cookie: cookie, Origin: app.baseUrl, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ decision: 'approve', from: 'window' }) });
  assert.match(await approve.text(), new RegExp(`Aprobado: ${CLIENT} termina de conectarse en tu navegador\\.`));
});
