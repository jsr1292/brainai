/**
 * Does the reranker work as a second opinion for "forgetting sticks"? For a labelled set of (deleted fact, new save)
 * pairs it prints the embedding cosine of both models, the reranker's score in both directions, and tests candidate
 * rules (reranker alone, with an embedding floor, with keepsNumbers, min of both directions) for zero false holds.
 * Run: node --import tsx src/scripts/calibrateDeletedRerank.ts   (models from ./models, offline)
 */
import { cosine, createLocalEmbedder } from '../memory/embedder.js';
import { E5_PROFILE, GEMMA_PROFILE } from '../memory/embeddingProfile.js';
import { createLocalReranker } from '../memory/reranker.js';

type Label = 'pos' | 'neg';
interface Pair { label: Label; group: string; deleted: string; next: string }
const P = (group: string, deleted: string, next: string): Pair => ({ label: 'pos', group, deleted, next });
const N = (group: string, deleted: string, next: string): Pair => ({ label: 'neg', group, deleted, next });

const S5 = 'Harbor staging box is called lantern. Its nightly database backup runs at 02:30 UTC.';
const pairs: Pair[] = [
  // Positives from the lifecycle eval (S5, 2026-11-19): re-saves of the deleted fact; the deleted text differs per run.
  P('eval', 'Harbor staging box is called lantern. Its nightly database backup runs at 02:30 UTC.', 'Harbor: the staging box is called "lantern". Its backup is believed to run at 02:30 UTC (owner unsure, "I think", as of 2026-11-19; not verified). Lantern staging was reported slow on 2026-11-19 and the cause is not known yet.'),
  P('eval', 'Harbor staging box is called lantern. Its nightly database backup runs at 02:30 UTC (as of 2026-11-19).', 'harbor: the staging box is called "lantern". Its backup is scheduled at 02:30 UTC (owner is fairly sure but unverified, as of 2026-11-19). Staging on lantern was slow again on 2026-11-19, cause not yet known.'),
  P('eval', 'Harbor staging box is called lantern. The nightly database backup on lantern runs at 02:30 UTC (as of 2026-11-19).', "Harbor's staging box is nicknamed \"lantern\". As of 2026-11-19 the owner says its backup runs at 02:30 UTC (owner is not fully sure; verify on the box before relying on it)."),
  // The eval's 0.691 save: a status about slowness that only mentions the backup window; arguably a different claim (borderline).
  { label: 'pos', group: 'eval-0.691 (borderline)', deleted: 'Harbor staging box is called lantern. The nightly database backup on lantern runs at 02:30 UTC (as of 2026-11-19).', next: 'Harbor status 2026-11-19: staging box ("lantern") was slow again today; cause not investigated yet. No host or service details recorded. Open: find why staging is slow (check CPU, memory, disk I/O, and whether it overlaps the 02:30 UTC backup window).' },
  P('eval-0.559', "Harbor's staging box is called lantern, and its nightly database backup runs at 02:30 UTC.", "The owner thinks lantern's backup is still scheduled for 02:30 UTC (mentioned 2026-11-19; not independently verified)."),
  P('eval', 'Harbor staging runs its nightly database backup at 02:30 UTC; the staging box is named lantern.', 'The harbor staging box, nicknamed the lantern box, is believed to run backups at 02:30 UTC; this time is unconfirmed (owner said 2026-11-19).'),
  P('eval', S5, "Harbor's staging box is called lantern, and its nightly database backup runs at 02:30 UTC."),
  P('eval', S5, 'Harbor staging box is called lantern. The nightly database backup on lantern runs at 02:30 UTC (as of 2026-11-19).'),
  // Hand-written rewordings.
  P('hand', 'Lantern staging backup runs at 02:30 UTC.', 'The backup job on the Lantern staging box is scheduled for 02:30 UTC every night.'),
  P('hand', 'Harbor uses Postgres 16.', 'The Harbor database is PostgreSQL 16.'),
  P('hand', 'Decision: we deploy Atlas on Fridays only, never after 15:00.', 'Atlas deployments happen on Fridays, and not later than 15:00.'),
  P('hand', 'The office wifi password rotates on the first of each month.', 'Every month on the 1st the office wifi password gets rotated.'),
  P('hand', 'Standup is at 09:45 on Zoom, Monday to Thursday.', 'The team standup happens on Zoom at 09:45 from Monday through Thursday.'),
  P('hand', 'Nimbus API rate limit is 600 requests per minute.', 'Requests to the Nimbus API are limited to 600 per minute.'),
  P('hand', 'The mini PC runs Ubuntu 24.04 and sits in the hallway closet.', 'Ubuntu 24.04 is installed on the mini PC, which lives in the hallway closet.'),
  P('hand', 'Redis cache on the production host expires keys after 3600 seconds.', 'On the production host, Redis keys expire after one hour (3600 s).'),
  P('hand', 'Jordan approves all invoices above 5000 EUR.', 'Any invoice over 5000 EUR needs Jordan to approve it.'),
  P('hand', 'Weekly review happens on Sunday at 18:00 in the living room.', 'The weekly review is held Sundays at 18:00, in the living room.'),
  P('hand', 'Orchid uses Node 22 and pnpm 9.', 'Orchid is built with Node 22 together with pnpm 9.'),
  P('hand', 'The VPN endpoint is vpn.example.com on port 51820.', 'For the VPN, connect to vpn.example.com, port 51820.'),
  P('hand', 'Release train leaves every second Tuesday at 14:00 CET.', 'Releases ship every other Tuesday, 14:00 CET.'),
  P('hand', 'Nightly backups of the NAS are kept for 30 days.', 'The NAS nightly backups have a retention of 30 days.'),
  P('es', 'El backup de la base de datos de staging corre a las 02:30 UTC.', 'La copia de seguridad nocturna de la base de datos de staging se ejecuta a las 02:30 UTC.'),
  P('es', 'Decidimos usar Postgres 16 para el proyecto Harbor.', 'Para Harbor hemos decidido usar PostgreSQL 16.'),
  P('es', 'La reunión semanal es los lunes a las 10:00 en Zoom.', 'Cada lunes a las 10:00 hay reunión semanal por Zoom.'),
  P('es', 'El mini PC tiene 16 GB de RAM y corre Ubuntu 24.04.', 'Ubuntu 24.04 corre en el mini PC, que tiene 16 GB de RAM.'),
  P('es', 'El servidor de producción está en Frankfurt, puerto 8443.', 'Producción está alojado en Frankfurt y escucha en el puerto 8443.'),
  P('es', 'Jordan aprueba las facturas de más de 5000 EUR.', 'Toda factura superior a 5000 EUR la aprueba Jordan.'),
  P('hand-heavy', S5, 'The owner believes the box named lantern gets its DB dumped around 02:30 UTC each night; not confirmed.'),
  P('hand-heavy', 'Harbor uses Postgres 16.', 'Heads up: harbor is on Postgres version 16 (as far as the owner remembers).'),
  P('hand-heavy', 'Standup is at 09:45 on Zoom, Monday to Thursday.', 'Per the owner, the daily sync is at 09:45, over Zoom, but not on Fridays.'),
  // Negatives: the model test's related facts, sharing the deleted fact's topic/numbers.
  N('model-test', S5, 'Harbor staging box lantern has 4 GB of RAM and runs Ubuntu Server.'),
  N('model-test', S5, 'Harbor production backups run at 04:00 UTC to a Backblaze B2 bucket.'),
  N('model-test', S5, 'Harbor production database is hosted on Fly.io in the Frankfurt region.'),
  N('model-test', S5, 'Harbor status 2026-11-19: staging was slow today; cause not investigated yet.'),
  N('model-test', 'staging runs on port 8080', 'production runs on port 443'),
  // Hard negatives: same project and numbers, different claim.
  N('hard', "Lantern's staging backup runs at 02:30 UTC.", "Lantern's production backup runs at 02:30 UTC."),
  N('hard', "Lantern's staging backup runs at 02:30 UTC.", "Lantern's staging backup moved from 02:30 to 04:00 UTC."),
  N('hard', "Lantern's staging backup runs at 02:30 UTC.", "Lantern's staging backup no longer runs at 02:30 UTC."),
  N('hard', "Lantern's staging backup runs at 02:30 UTC.", "Lantern's staging backup takes about 40 minutes and starts at 02:30 UTC."),
  N('hard', "Lantern's staging backup runs at 02:30 UTC.", "Lantern's staging backup log is rotated at 02:30 UTC."),
  N('hard', 'Harbor uses Postgres 16.', 'Harbor dropped Postgres 16.'),
  N('hard', 'Harbor uses Postgres 16.', 'Harbor uses Postgres 16 on staging and Postgres 14 on production.'),
  N('hard', 'Harbor uses Postgres 16.', 'Atlas uses Postgres 16.'),
  N('hard', 'Harbor uses Postgres 16.', 'Harbor will migrate to Postgres 17 after Postgres 16 reaches the end of life.'),
  N('hard', 'Standup is at 09:45 on Zoom, Monday to Thursday.', 'Standup is at 09:45 in the office on Fridays.'),
  N('hard', 'Standup is at 09:45 on Zoom, Monday to Thursday.', 'Standup at 09:45 was cancelled this week.'),
  N('hard', 'Standup is at 09:45 on Zoom, Monday to Thursday.', 'Retro is at 09:45 on Zoom on Fridays.'),
  N('hard', 'Nimbus API rate limit is 600 requests per minute.', 'Nimbus API rate limit is 600 requests per minute for free accounts; paid accounts get 6000.'),
  N('hard', 'Nimbus API rate limit is 600 requests per minute.', 'Nimbus API rate limit is not 600 requests per minute; it was raised.'),
  N('hard', 'Nimbus API rate limit is 600 requests per minute.', 'Orchid API rate limit is 600 requests per minute.'),
  N('hard', 'The mini PC runs Ubuntu 24.04 and sits in the hallway closet.', 'The NAS runs Ubuntu 24.04 and sits in the hallway closet.'),
  N('hard', 'The mini PC runs Ubuntu 24.04 and sits in the hallway closet.', 'The mini PC runs Ubuntu 24.04 and its fan is loud.'),
  N('hard', 'The mini PC runs Ubuntu 24.04 and sits in the hallway closet.', 'The mini PC was moved from the hallway closet to the office.'),
  N('hard', 'Redis cache on the production host expires keys after 3600 seconds.', 'Redis cache on the staging host expires keys after 60 seconds.'),
  N('hard', 'Redis cache on the production host expires keys after 3600 seconds.', 'Redis on the production host is limited to 3600 connections.'),
  N('hard', 'Jordan approves all invoices above 5000 EUR.', 'Jordan approves all invoices above 500 EUR.'),
  N('hard', 'Jordan approves all invoices above 5000 EUR.', 'Sam approves all invoices above 5000 EUR.'),
  N('hard', 'Jordan approves all invoices above 5000 EUR.', 'Jordan no longer approves invoices above 5000 EUR; Sam does.'),
  N('hard', 'Orchid uses Node 22 and pnpm 9.', 'Orchid uses Node 22 and npm 10.'),
  N('hard', 'Orchid uses Node 22 and pnpm 9.', 'Orchid upgraded to Node 24; pnpm 9 stays.'),
  N('hard', 'The VPN endpoint is vpn.example.com on port 51820.', 'The SSH endpoint is ssh.example.com on port 51820.'),
  N('hard', 'The VPN endpoint is vpn.example.com on port 51820.', 'The VPN endpoint vpn.example.com is down for maintenance until 2026-12-01.'),
  N('hard', 'Release train leaves every second Tuesday at 14:00 CET.', 'Hotfixes can leave any day at 14:00 CET.'),
  N('hard', 'Nightly backups of the NAS are kept for 30 days.', 'Nightly backups of the laptop are kept for 30 days.'),
  N('hard', 'Nightly backups of the NAS are kept for 30 days.', 'Weekly backups of the NAS are kept for 12 weeks; nightly ones for 7 days.'),
  N('hard', 'Weekly review happens on Sunday at 18:00 in the living room.', 'Weekly review notes are filed on Sunday at 18:00 by the assistant.'),
  N('hard', 'Weekly review happens on Sunday at 18:00 in the living room.', 'Monthly review happens on the first Sunday at 18:00 in the living room.'),
  N('es-hard', 'El backup de la base de datos de staging corre a las 02:30 UTC.', 'El backup de la base de datos de producción corre a las 02:30 UTC.'),
  N('es-hard', 'El backup de la base de datos de staging corre a las 02:30 UTC.', 'El backup de staging se movió de las 02:30 a las 04:00 UTC.'),
  N('es-hard', 'Decidimos usar Postgres 16 para el proyecto Harbor.', 'Decidimos abandonar Postgres 16 en el proyecto Harbor.'),
  N('es-hard', 'La reunión semanal es los lunes a las 10:00 en Zoom.', 'La reunión semanal de los lunes a las 10:00 se canceló esta semana.'),
  N('es-hard', 'El servidor de producción está en Frankfurt, puerto 8443.', 'El servidor de staging está en Frankfurt, puerto 8443.'),
];

const modelDir = process.env.MODEL_DIR ?? './models';
const gemma = await createLocalEmbedder({ modelDir, allowRemote: false, model: GEMMA_PROFILE });
const e5 = await createLocalEmbedder({ modelDir, allowRemote: false, model: E5_PROFILE });
const reranker = await createLocalReranker({ modelDir, allowRemote: false });

const numberWords = (text: string): string[] => text.toLowerCase().match(/[a-z]*\d[a-z0-9:.,/-]*/g)?.map((w) => w.replace(/[.,:/-]+$/, '')) ?? [];
const keepsNumbers = (deleted: string, next: string): boolean => {
  const want = new Set(numberWords(deleted));
  if (want.size === 0) return false;
  const have = new Set(numberWords(next));
  return [...want].every((w) => have.has(w));
};

interface Row extends Pair { g: number; e: number; fwd: number; rev: number; min: number; kn: boolean }
const rows: Row[] = [];
for (const p of pairs) {
  const g = cosine(await gemma.embed(p.deleted, 'passage'), await gemma.embed(p.next, 'passage'));
  const e = cosine(await e5.embed(p.deleted, 'passage'), await e5.embed(p.next, 'passage'));
  const fwd = (await reranker.score(p.next, [p.deleted]))[0]!; // query = new save, passage = deleted fact
  const rev = (await reranker.score(p.deleted, [p.next]))[0]!;
  rows.push({ ...p, g, e, fwd, rev, min: Math.min(fwd, rev), kn: keepsNumbers(p.deleted, p.next) });
}
const f = (n: number) => n.toFixed(3).padStart(7);
for (const r of rows) console.log(`${r.label} ${r.group.padEnd(22)} gemma${f(r.g)} e5${f(r.e)} fwd${f(r.fwd)} rev${f(r.rev)} min${f(r.min)} nums=${r.kn ? 'y' : 'n'}  ${r.next.slice(0, 60).replace(/\n/g, ' ')}`);

const range = (label: Label, k: 'g' | 'e' | 'fwd' | 'rev' | 'min') => {
  const v = rows.filter((r) => r.label === label).map((r) => r[k]).sort((a, b) => a - b);
  return `n=${v.length} min ${v[0]!.toFixed(3)} median ${v[v.length >> 1]!.toFixed(3)} max ${v[v.length - 1]!.toFixed(3)}`;
};
console.log('\nDISTRIBUTIONS');
for (const k of ['g', 'e', 'fwd', 'rev', 'min'] as const) console.log(`  ${k.padEnd(3)} pos: ${range('pos', k)}\n  ${k.padEnd(3)} neg: ${range('neg', k)}`);

// Rules: hold when score >= t (and optional extra condition), considering only near misses (gemma below duplicate).
console.log('\nRULES (near misses only: gemma < 0.78 and >= floor). For each, the best threshold: max positives held with false holds <= 1.');
const near = (floor: number) => rows.filter((r) => r.g < GEMMA_PROFILE.duplicate && r.g >= floor);
const rules: Record<string, (r: Row) => number> = { fwd: (r) => r.fwd, rev: (r) => r.rev, min: (r) => r.min, max: (r) => Math.max(r.fwd, r.rev) };
for (const floor of [0.5, 0.55, 0.6]) for (const [name, fn] of Object.entries(rules)) for (const needNums of [false, true]) {
  const set = near(floor).filter((r) => !needNums || r.kn);
  const pos = set.filter((r) => r.label === 'pos'), neg = set.filter((r) => r.label === 'neg');
  const ts = [...new Set(set.map(fn))].sort((a, b) => a - b);
  let best: { t: number; tp: number; fp: number } | null = null;
  for (const t of ts) {
    const tp = pos.filter((r) => fn(r) >= t).length, fp = neg.filter((r) => fn(r) >= t).length;
    if (fp <= 1 && (!best || tp > best.tp || (tp === best.tp && fp < best.fp))) best = { t, tp, fp };
  }
  const totalPos = rows.filter((r) => r.label === 'pos' && r.g < GEMMA_PROFILE.duplicate).length;
  const zero = ts.map((t) => ({ t, tp: pos.filter((r) => fn(r) >= t).length, fp: neg.filter((r) => fn(r) >= t).length })).filter((x) => x.fp === 0).sort((a, b) => b.tp - a.tp)[0];
  console.log(`  floor ${floor} ${name.padEnd(3)} nums=${needNums ? 'y' : 'n'}: near-miss pos ${pos.length}/${totalPos} neg ${neg.length}; best(fp<=1) ${best ? `t=${best.t.toFixed(2)} tp=${best.tp} fp=${best.fp}` : 'none'}; best(fp=0) ${zero ? `t=${zero.t.toFixed(2)} tp=${zero.tp}` : 'none'}`);
}
