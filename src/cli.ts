import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { openDb, type DB } from './db.js';
import { OwnerAuth } from './auth/owner.js';
import { RedirectAllowlist } from './auth/redirects.js';
import { ClientsStore } from './auth/clientsStore.js';
import { MemoryOAuthProvider } from './auth/provider.js';
import { generateTotpSecret, otpauthUri } from './auth/totp.js';
import { createLocalEmbedder } from './memory/embedder.js';
import { startReranker, type Reranker } from './memory/reranker.js';
import { exportMarkdown } from './memory/exportMarkdown.js';
import { comparePaired, formatReport, parseCases, runRecallTest } from './memory/recallTest.js';
import { DEFAULT_LIMIT, MemoryService } from './memory/service.js';
import { MemoryStore } from './memory/store.js';
import { exportTree, writeTree } from './pages/exportTree.js';
import type { Embedder } from './memory/embedder.js';
import { SkillService } from './skills/service.js';
import { PageService } from './pages/service.js';
import { MeaningIndex, THREAD_FLOOR, THREAD_KINDS } from './graph/threads.js';
import { PageStore } from './pages/store.js';
import { freshnessReport } from './pages/freshnessReport.js';
import { pageView, pagesHomeView, type NavEntry } from './web/pageViews.js';
import { ProjectStore } from './projects/store.js';

// One readline for the whole process: piped stdin delivers all lines at once, so a
// per-prompt interface would lose the lines after the first.
let muted = false;
let reader: { rl: Interface; lines: string[]; waiting: ((l: string | null) => void)[]; closed: boolean } | undefined;

function getReader() {
  if (reader) return reader;
  const output = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
  const r = { rl, lines: [] as string[], waiting: [] as ((l: string | null) => void)[], closed: false };
  rl.on('line', (l) => { const w = r.waiting.shift(); if (w) w(l); else r.lines.push(l); });
  rl.on('close', () => { r.closed = true; for (const w of r.waiting.splice(0)) w(null); });
  return (reader = r);
}

/** Reads one line. On a TTY, hidden input is not echoed; otherwise plain line reading. */
export async function prompt(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  const r = getReader();
  process.stdout.write(question);
  const hide = !!opts.hidden && !!process.stdin.isTTY;
  muted = hide;
  const line = await new Promise<string | null>((resolve) => {
    const queued = r.lines.shift();
    if (queued !== undefined) resolve(queued);
    else if (r.closed) resolve(null);
    else r.waiting.push(resolve);
  });
  muted = false;
  if (hide) process.stdout.write('\n');
  if (line === null) throw new Error('Input closed before a value was entered');
  return line;
}

export interface CliContext { db: DB; owner: OwnerAuth; args?: string[]; embedder?: Embedder; reranker?: Reranker }

async function setPassword({ owner }: CliContext): Promise<void> {
  const pw = await prompt('New password (min 12 characters): ', { hidden: true });
  const again = await prompt('Repeat password: ', { hidden: true });
  if (pw !== again) throw new Error('Passwords do not match');
  await owner.setPassword(pw);
  console.log('Password saved. Every browser is signed out: log in again with the new password.');
}

async function setupTotp({ owner }: CliContext): Promise<void> {
  const secret = generateTotpSecret();
  console.log(await QRCode.toString(otpauthUri(secret, 'owner', process.env.MEMORY_MODE === 'work' ? 'Work memory' : 'BrainAI'), { type: 'terminal', small: true }));
  console.log(`Scan the QR code, or enter this secret manually: ${secret}`);
  const code = (await prompt('Current 6-digit code: ')).trim();
  // Verify against a scratch DB so a wrong code never replaces a working secret.
  const scratch = new OwnerAuth(openDb(':memory:'), systemClock);
  scratch.setTotpSecret(secret);
  if (!scratch.verifyTotp(code)) throw new Error('Code did not match. Nothing was saved.');
  owner.setTotpSecret(secret);
  console.log('Authenticator saved. Every browser is signed out: log in again with a code from the new entry.');
}

async function redirects({ db, args = [] }: CliContext): Promise<void> {
  const list = new RedirectAllowlist(db);
  const [sub, entry] = args;
  if (sub === 'list') for (const e of list.list()) console.log(e);
  else if (sub === 'add' && entry) { list.add(entry); console.log(`Added ${entry}`); }
  else if (sub === 'remove' && entry) { list.remove(entry); console.log(`Removed ${entry}`); }
  else throw new Error('Usage: redirects list | add <entry> | remove <entry>');
}

/** Project aliases: another name a project is saved, briefed and searched under. Adding one moves its memories. */
async function aliases({ db, args = [] }: CliContext): Promise<void> {
  // Aliases never embed text, so no model is loaded.
  const noEmbedder = { embed: async (): Promise<Float32Array> => { throw new Error('not used'); } };
  const service = new MemoryService(new MemoryStore(db, systemClock), noEmbedder, { duplicateThreshold: 1, minRecallSimilarity: 1, recallConfidentSimilarity: 1 });
  const [sub, alias, project] = args;
  if (sub === 'list') for (const a of service.aliases()) console.log(`${a.alias} -> ${a.project}`);
  else if (sub === 'add' && alias && project) {
    const moved = service.addAlias(alias, project, { type: 'owner' });
    console.log(`${alias} is now another name of ${project} (${moved} ${moved === 1 ? 'memory' : 'memories'} moved).`);
  } else if (sub === 'remove' && alias) { service.removeAlias(alias); console.log(`Removed ${alias}`); }
  else throw new Error('Usage: aliases list | add <alias> <project> | remove <alias>');
}

const CLI_UNUSED_RESOURCE = new URL('http://localhost/mcp');

async function clients({ db, args = [] }: CliContext): Promise<void> {
  const allowlist = new RedirectAllowlist(db);
  // Only grant listing and revocation run here, which never use the resource URL.
  const provider = new MemoryOAuthProvider(db, new ClientsStore(db, allowlist, systemClock), allowlist, systemClock, CLI_UNUSED_RESOURCE);
  const [sub, grantId] = args;
  if (sub === 'list') {
    for (const g of provider.listGrants()) {
      const status = g.revokedAt ? `revoked ${g.revokedAt}` : 'active';
      console.log(`${g.id}\t${g.clientName}\tcreated ${g.createdAt}\tlast used ${g.lastUsedAt ?? 'never'}\t${status}`);
    }
  } else if (sub === 'revoke' && grantId) {
    provider.revokeGrant(grantId);
    console.log(`Revoked ${grantId}`);
  } else if (sub === 'purge-unused') {
    // The way out when anonymous registrations reached the daily cap and a real app can't register.
    // A registration whose sign-in is waiting on the consent page is kept.
    const n = db.prepare(`DELETE FROM oauth_clients WHERE is_cimd = 0
      AND NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = oauth_clients.client_id)
      AND NOT EXISTS (SELECT 1 FROM oauth_pending p WHERE p.client_id = oauth_clients.client_id AND p.expires_at > ?)`)
      .run(systemClock().toISOString()).changes;
    console.log(`Deleted ${n} unused ${n === 1 ? 'registration' : 'registrations'}.`);
  } else throw new Error('Usage: clients list | revoke <grantId> | purge-unused');
}

/**
 * Scores recall against a file of questions (default: recall-test.json in the data folder). Changes nothing.
 * `--json <file>` writes the scores and each question's rank; `--against <file>` (an earlier --json) lists the
 * questions gained and lost within the first result and within the limit. `--no-alt` leaves out each question's other
 * phrasings (`alt`), to measure what they add.
 */
async function recallTest({ db, args = [], embedder: given, reranker }: CliContext): Promise<void> {
  const config = loadConfig(process.env);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`Usage: cli recall-test [file] [--json <out>] [--against <earlier json>] [--no-alt]`);
    return v;
  };
  const jsonOut = flag('--json');
  const against = flag('--against');
  const file = args.find((a, i) => !a.startsWith('--') && !['--json', '--against'].includes(args[i - 1] ?? ''));
  const cases = parseCases(readFileSync(file ?? join(config.dataDir, 'recall-test.json'), 'utf8'));
  const embedder = given ?? await createLocalEmbedder({ modelDir: config.modelDir, allowRemote: false });
  const service = new MemoryService(new MemoryStore(db, systemClock), embedder, {
    duplicateThreshold: config.duplicateThreshold,
    minRecallSimilarity: config.minRecallSimilarity,
    recallConfidentSimilarity: config.recallConfidentSimilarity,
    recallWindow: config.recallWindow,
    // What assistants get: the server's reranker setting.
    reranker: reranker ?? await startReranker(config),
  });
  const report = await runRecallTest(service, cases, DEFAULT_LIMIT, { alt: !args.includes('--no-alt') });
  console.log(formatReport(report));
  const perQuestion = report.results.map((r) => ({ id: r.q, rank: r.rank }));
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ limit: report.limit, summary: report.summary, byTag: report.byTag, perQuestion }, null, 2));
  if (against) {
    const before = (JSON.parse(readFileSync(against, 'utf8')) as { perQuestion: { id: string; rank: number | null }[] }).perQuestion;
    for (const k of [1, report.limit]) {
      const { gained, lost } = comparePaired(before, perQuestion, k);
      console.log(`\nGained within ${k}: ${gained.length}${gained.map((q) => `\n  "${q}"`).join('')}`);
      console.log(`Lost within ${k}: ${lost.length}${lost.map((q) => `\n  "${q}"`).join('')}`);
    }
  }
}

/** Writes every active memory as Markdown to the given file, or prints it. Changes nothing. */
async function exportCommand({ db, args = [] }: CliContext): Promise<void> {
  const title = process.env.MEMORY_MODE === 'work' ? 'Work memory' : 'BrainAI';
  const markdown = exportMarkdown(new MemoryStore(db, systemClock), title, systemClock());
  if (args[0]) {
    writeFileSync(args[0], markdown);
    console.log(`Exported to ${args[0]}`);
  } else process.stdout.write(markdown);
}


/**
 * Writes every page and fact as Markdown into a folder (scripts/export-brain.sh commits it to git). It only reads, so it
 * needs no embedding model: the page service gets one that refuses to be used.
 */
async function exportBrain({ db, args = [] }: CliContext): Promise<void> {
  const dir = args[0];
  if (!dir) throw new Error('Usage: cli export-brain <folder>');
  const memoryStore = new MemoryStore(db, systemClock);
  const noModel: Embedder = { embed: async () => { throw new Error('export-brain never embeds'); } };
  const memories = new MemoryService(memoryStore, noModel, { duplicateThreshold: 1, minRecallSimilarity: 1, recallConfidentSimilarity: 1 });
  const pages = new PageService(new PageStore(db, systemClock), noModel, memories, new ProjectStore(db, systemClock), memoryStore, systemClock);
  const tree = exportTree({ pages, memoryStore, memories, skills: new SkillService(db, systemClock) }, systemClock());
  const r = writeTree(dir, tree);
  const pageFiles = [...tree.keys()].filter((k) => k.startsWith('pages/')).length;
  const factFiles = [...tree.keys()].filter((k) => k.startsWith('facts/')).length;
  console.log(`export-brain: ${pageFiles} pages, ${factFiles} fact files (written ${r.written}, removed ${r.removed})`);
  if (r.skipped.length > 0) console.log(`export-brain: left alone because of a link on the way: ${r.skipped.slice(0, 10).join(', ')}${r.skipped.length > 10 ? ` and ${r.skipped.length - 10} more` : ''}`);
}

/**
 * The "may be out of date" dry run: counts, ids and timings only (titles with --names, for the owner). It only reads,
 * so the page service gets an embedder that refuses to be used. Run it on a copy: opening a database migrates it.
 */
async function freshness({ db, args = [] }: CliContext): Promise<void> {
  const memoryStore = new MemoryStore(db, systemClock);
  const noModel: Embedder = { embed: async () => { throw new Error('freshness never embeds'); } };
  const memories = new MemoryService(memoryStore, noModel, { duplicateThreshold: 1, minRecallSimilarity: 1, recallConfidentSimilarity: 1 });
  const pages = new PageService(new PageStore(db, systemClock), noModel, memories, new ProjectStore(db, systemClock), memoryStore, systemClock);
  const nav = (): NavEntry[] => pages.headers().map((p) => ({ id: p.id, title: p.title, area: pages.areaOf(p) }));
  const lines = freshnessReport({ pages, memoryStore, memories }, {
    names: args.includes('--names'),
    time: args.includes('--time'),
    // What the reading view and the Pages tab render, without the parts that do not depend on the flag.
    render: {
      page: (p, flag) => pageView({
        page: p, nav: nav(), area: pages.areaOf(p), versions: p.version, sections: pages.sections(p.id), resolve: pages.resolver(),
        project: p.project === null ? null : memories.projectNamed(p.project), live: null, related: [], linkedFrom: [], notes: [], flag,
      }).value,
      home: (all, flags) => pagesHomeView({
        nav: nav(), recent: all.slice(0, 8).map((p) => ({ page: p, area: pages.areaOf(p), summary: '', stale: Boolean(flags.get(p.id)) })),
        start: all.filter((p) => p.project === null && p.area === 'start'), withoutPage: [], moved: null,
        stale: all.filter((p) => flags.get(p.id)).map((p) => ({ page: p, flag: flags.get(p.id)!, noteOpen: false })),
      }).value,
    },
  });
  for (const l of lines) console.log(l);
}

export const COMMANDS: Record<string, (ctx: CliContext) => Promise<void>> = {
  freshness,
  'export-brain': exportBrain,
  'set-password': setPassword,
  'setup-totp': setupTotp,
  redirects,
  aliases,
  clients,
  'recall-test': recallTest,
  export: exportCommand,
};

/** `deps.embedder` and `deps.reranker` replace the local models (tests). */
export async function main(argv: string[], deps: { embedder?: Embedder; reranker?: Reranker } = {}): Promise<number> {
  const handler = COMMANDS[argv[0] ?? ''];
  if (!handler) {
    console.error(`Usage: cli <${Object.keys(COMMANDS).join('|')}>`);
    return 2;
  }
  const dir = process.env.DATA_DIR ?? './data';
  mkdirSync(dir, { recursive: true });
  const db = openDb(`${dir}/memory.db`);
  try {
    await handler({ db, owner: new OwnerAuth(db, systemClock), args: argv.slice(1), embedder: deps.embedder, reranker: deps.reranker });
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    db.close();
    reader?.rl.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
