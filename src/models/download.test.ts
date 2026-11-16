import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { Writable } from 'node:stream';
import { writeFileSync as wf } from 'node:fs';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { downloadModel, copyNotice, DEFAULT_SOURCES, type Progress } from './download.js';
import { modelDirOf, type CatalogueModel } from './catalogue.js';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const A = Buffer.from('alpha-file-contents '.repeat(100));
const B = Buffer.from('beta file in a subfolder '.repeat(50));

function model(over: Partial<CatalogueModel> = {}): CatalogueModel {
  return {
    id: 'e5', kind: 'search', label: 'Light', repo: 'org/tiny',
    files: { 'a.bin': sha(A), 'sub/b.bin': sha(B) }, bytes: A.length + B.length, licence: 'MIT', measured: 'x', ...over,
  };
}

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; base: string; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => { hits.push(req.url ?? ''); (handler as any)(req, res); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}
const good = (req: any, res: any) => {
  const body = req.url.endsWith('a.bin') ? A : B;
  res.writeHead(200, { 'content-length': body.length }); res.end(body);
};
const tmp = () => mkdtempSync(join(tmpdir(), 'dl-'));
const src = (base: string) => (m: CatalogueModel, f: string) => `${base}/${m.repo}/${f}`;
const noPartials = (dir: string) => {
  const all = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? all(join(d, e.name)) : [e.name]);
  return all(dir).filter((n) => n.endsWith('.partial'));
};
const plenty = async () => 1e12;

test('a good download lands in the model folder with no partial', async () => {
  const { server, base } = await serve(good); const dir = tmp(); const m = model();
  try {
    await downloadModel(m, dir, { sources: [src(base)], freeBytes: plenty });
    assert.deepEqual(readFileSync(join(modelDirOf(dir, m), 'a.bin')), A);
    assert.deepEqual(readFileSync(join(modelDirOf(dir, m), 'sub/b.bin')), B);
    assert.deepEqual(noPartials(dir), []);
  } finally { server.close(); }
});

test('wrong bytes: no file, "did not match"', async () => {
  const { server, base } = await serve((_q, res) => { res.writeHead(200); res.end('garbage'); }); const dir = tmp(); const m = model();
  try {
    await assert.rejects(downloadModel(m, dir, { sources: [src(base)], freeBytes: plenty }), /did not match/);
    assert.equal(existsSync(join(modelDirOf(dir, m), 'a.bin')), false);
    assert.deepEqual(noPartials(dir), []);
  } finally { server.close(); }
});

test('first source 404, second good', async () => {
  const bad = await serve((_q, res) => { res.writeHead(404); res.end(); });
  const ok = await serve(good); const dir = tmp(); const m = model();
  try {
    await downloadModel(m, dir, { sources: [src(bad.base), src(ok.base)], freeBytes: plenty });
    assert.deepEqual(readFileSync(join(modelDirOf(dir, m), 'a.bin')), A);
  } finally { bad.server.close(); ok.server.close(); }
});

test('all sources unreachable: plain reason', async () => {
  const bad = await serve((_q, res) => { res.writeHead(404); res.end(); }); const dir = tmp();
  try {
    await assert.rejects(downloadModel(model(), dir, { sources: [src(bad.base)], freeBytes: plenty }), /could not reach Hugging Face or GitHub/);
  } finally { bad.server.close(); }
});

test('connection cut mid-body: no partial, error', async () => {
  const { server, base } = await serve((_q, res) => { res.writeHead(200, { 'content-length': 100000 }); res.write('abc'); setTimeout(() => res.destroy(), 20); });
  const dir = tmp();
  try {
    await assert.rejects(downloadModel(model(), dir, { sources: [src(base)], freeBytes: plenty }));
    assert.deepEqual(noPartials(dir), []);
  } finally { server.close(); }
});

test('a present good file is not downloaded again', async () => {
  const { server, base, hits } = await serve(good); const dir = tmp(); const m = model();
  try {
    mkdirSync(join(modelDirOf(dir, m), 'sub'), { recursive: true });
    writeFileSync(join(modelDirOf(dir, m), 'a.bin'), A);
    await downloadModel(m, dir, { sources: [src(base)], freeBytes: plenty });
    assert.equal(hits.length, 1);
    assert.match(hits[0]!, /sub\/b\.bin$/);
  } finally { server.close(); }
});

test('progress increases and ends done', async () => {
  const { server, base } = await serve(good); const dir = tmp(); const seen: Progress[] = [];
  try {
    await downloadModel(model(), dir, { sources: [src(base)], freeBytes: plenty, onProgress: (p) => seen.push({ ...p }) });
    const done = seen.map((p) => p.doneBytes);
    assert.deepEqual(done, [...done].sort((x, y) => x - y));
    assert.ok(seen.some((p) => p.state === 'downloading'));
    assert.ok(seen.some((p) => p.state === 'checking'));
    const last = seen.at(-1)!;
    assert.equal(last.state, 'done'); assert.equal(last.doneBytes, last.totalBytes); assert.equal(last.model, 'e5');
  } finally { server.close(); }
});

test('abort leaves no partial', async () => {
  const { server, base } = await serve((_q, res) => { res.writeHead(200, { 'content-length': 100000 }); res.write('abc'); });
  const dir = tmp(); const ac = new AbortController();
  try {
    const p = downloadModel(model(), dir, { sources: [src(base)], freeBytes: plenty, signal: ac.signal });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p);
    assert.deepEqual(noPartials(dir), []);
  } finally { server.closeAllConnections(); server.close(); }
});

test('not enough disk space fails early, with the amount', async () => {
  const { server, base, hits } = await serve(good); const dir = tmp(); const m = model({ bytes: 210_000_000 });
  try {
    await assert.rejects(downloadModel(m, dir, { sources: [src(base)], freeBytes: async () => 1000 }), /not enough disk space: \d+ MB needed/);
    assert.equal(hits.length, 0);
  } finally { server.close(); }
});

test('default sources', () => {
  const m = model({ repo: 'org/tiny' });
  assert.equal(DEFAULT_SOURCES[0]!(m, 'sub/b.bin'), 'https://huggingface.co/org/tiny/resolve/main/sub/b.bin');
  assert.equal(DEFAULT_SOURCES[1]!(m, 'sub/b.bin'), 'https://github.com/jsr1292/brainai/releases/download/models-v1/org__tiny__sub__b.bin');
});

test('copyNotice copies the notice and terms next to the model', () => {
  const lic = tmp(); const dir = tmp(); const root = join(lic, 'licenses'); mkdirSync(root);
  writeFileSync(join(root, 'GEMMA-NOTICE.txt'), 'notice'); writeFileSync(join(root, 'GEMMA-TERMS.md'), 'terms');
  const m = model({ notice: 'licenses/GEMMA-NOTICE.txt' });
  copyNotice(m, dir, { licensesRoot: lic });
  assert.equal(readFileSync(join(modelDirOf(dir, m), 'NOTICE'), 'utf8'), 'notice');
  assert.equal(readFileSync(join(modelDirOf(dir, m), 'GEMMA-TERMS.md'), 'utf8'), 'terms');
  assert.equal(existsSync(join(modelDirOf(dir, m), 'GEMMA-PROHIBITED-USE-POLICY.md')), false);
  const plain = model(); copyNotice(plain, dir, { licensesRoot: lic });
  rmSync(lic, { recursive: true });
});

test('ENOSPC mid-write: plain disk reason, one source tried, no partial', async () => {
  const one = await serve(good); const two = await serve(good); const dir = tmp(); const m = model();
  const createWriter = (path: string) => { wf(path, 'x'); return new Writable({ write(_c, _e, cb) { cb(Object.assign(new Error('full'), { code: 'ENOSPC' })); } }); };
  try {
    await assert.rejects(downloadModel(m, dir, { sources: [src(one.base), src(two.base)], freeBytes: plenty, createWriter }), /^Error: not enough disk space: \d+ MB needed$/);
    assert.equal(one.hits.length, 1); assert.equal(two.hits.length, 0);
    assert.deepEqual(noPartials(dir), []);
  } finally { one.server.close(); two.server.close(); }
});

test('a stale partial from a killed run is overwritten', async () => {
  const { server, base } = await serve(good); const dir = tmp(); const m = model();
  try {
    mkdirSync(modelDirOf(dir, m), { recursive: true });
    writeFileSync(join(modelDirOf(dir, m), 'a.bin.partial'), 'junk'.repeat(5000));
    await downloadModel(m, dir, { sources: [src(base)], freeBytes: plenty });
    assert.deepEqual(readFileSync(join(modelDirOf(dir, m), 'a.bin')), A);
    assert.deepEqual(noPartials(dir), []);
  } finally { server.close(); }
});

test('a model with a notice gets it copied after download; a missing notice is an error', async () => {
  const { server, base } = await serve(good); const dir = tmp(); const lic = tmp();
  mkdirSync(join(lic, 'licenses')); writeFileSync(join(lic, 'licenses', 'GEMMA-NOTICE.txt'), 'notice');
  const m = model({ notice: 'licenses/GEMMA-NOTICE.txt' });
  try {
    await downloadModel(m, dir, { sources: [src(base)], freeBytes: plenty, licensesRoot: lic });
    assert.equal(readFileSync(join(modelDirOf(dir, m), 'NOTICE'), 'utf8'), 'notice');
    await assert.rejects(downloadModel(m, tmp(), { sources: [src(base)], freeBytes: plenty, licensesRoot: tmp() }), /notice/i);
  } finally { server.close(); }
});

test('file paths that leave the models folder are refused', async () => {
  const { server, base, hits } = await serve(good); const dir = tmp();
  try {
    for (const bad of ['../evil.bin', '/etc/evil.bin']) {
      await assert.rejects(downloadModel(model({ files: { [bad]: sha(A) } }), dir, { sources: [src(base)], freeBytes: plenty }), /outside/);
    }
    assert.equal(hits.length, 0);
  } finally { server.close(); }
});

test('mixed failures prefer the specific reason', async () => {
  const wrong = await serve((_q, res) => { res.writeHead(200); res.end('garbage'); });
  const gone = await serve((_q, res) => { res.writeHead(404); res.end(); }); const dir = tmp();
  try {
    await assert.rejects(downloadModel(model(), dir, { sources: [src(wrong.base), src(gone.base)], freeBytes: plenty }), /did not match/);
  } finally { wrong.server.close(); gone.server.close(); }
});
