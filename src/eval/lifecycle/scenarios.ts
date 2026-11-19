/**
 * The scenarios. Owner turns are ordinary talk, never "please save X". Facts under test are only ever created by an
 * assistant in conversation (or approved/deleted by the owner over the dashboard's HTTP routes); nothing under test is
 * inserted into SQLite.
 */
import { shortTool } from './assistants.js';
import type { Ctx, Scenario } from './scenario.js';
import { allFacts, citesFacts, historyHas, isHarbor, live, matching, matchesAll, NUMBER_CLAIM, s3StateChecks, suggestions, supersedeLink, supersessions } from './scoring.js';
import { NUDGE } from '../../hooks/memorySave.js';

const wrote = (calls: { name: string }[]): boolean => calls.some((c) => ['remember', 'update_memory', 'suggest_memories'].includes(shortTool(c.name)));
const POSTGRES = /postgres/i;

/** Session 1 of the harbor database decision, used by several scenarios. */
async function decidePostgres(ctx: Ctx, who = ctx.primary): Promise<void> {
  const s = ctx.session(who);
  await s.say("I've been going back and forth on the database for harbor, the little deploy dashboard I'm building. I think I'm going with Postgres rather than SQLite, because several people will write to it at once and SQLite locks on concurrent writes.");
  await s.say("Yes, Postgres it is for harbor. I'll start on the schema tomorrow, thanks.");
}

/**
 * S4: a session where saving is impossible (write tools off), then the recovery the product provides.
 * 'nudge': what the Stop hook injects (src/hooks/memorySave.ts NUDGE). It offers remember or the harvest-session skill, so the
 * assistant picks the route; either one counts as recovered, and an Inbox batch is approved over the dashboard.
 * 'owner': the owner asks to harvest the session, which is the harvest-session skill's own trigger; this must land in the Inbox.
 */
function s4(id: string, trigger: 'nudge' | 'owner'): Scenario {
  return {
    id, title: trigger === 'nudge' ? 'A missed session save is recovered after the save reminder (hook text)' : 'A missed session save is harvested to the Inbox when the owner asks, approved, then recalled', covers: ['S4'],
    async run(ctx) {
      await ctx.owner.addBuiltinSkill('harvest-session');
      const s = ctx.session(ctx.primary);
      const r1 = await s.say("Working on harbor's cutover. I've decided we put Caddy in front as the reverse proxy, because it does the TLS certificates by itself. The cutover to the new VPS is set for 2026-12-05.", { readOnly: true });
      await s.say("Right. I'll get on with the DNS now. Thanks.", { readOnly: true });
      const none = matching(live(allFacts(ctx.brain)), /caddy/i).length === 0 && suggestions(ctx.brain).length === 0;
      ctx.setup('nothing saved while saving was impossible', none && !wrote(r1.toolCalls), 'a save went through even though write tools were disabled');
      const h = await s.say(trigger === 'nudge' ? NUDGE : 'Before we stop: harvest this session into my memory, please.');
      const used = h.toolCalls.map((c) => shortTool(c.name)).join(', ') || 'none';
      const batch = suggestions(ctx.brain).filter((x) => x.harvest_batch !== null && /caddy/i.test(x.content ?? ''));
      const direct = matching(live(allFacts(ctx.brain)), /caddy/i);
      ctx.note('route', batch.length ? 'suggest_memories (Inbox)' : direct.length ? 'remember (direct)' : 'none');
      const recovered = batch.length > 0 || direct.length > 0;
      ctx.check({ tag: 'S4', kind: 'state', name: trigger === 'owner' ? 'harvest puts the decision in the Inbox, not straight into memory' : 'missed decision recovered after the reminder (saved or waiting in the Inbox)', pass: trigger === 'owner' ? batch.length > 0 && direct.length === 0 : recovered, reason: recovered ? `route: ${batch.length ? 'Inbox batch' : 'direct remember'}; tools: ${used}` : `nothing saved or harvested; tools: ${used}; reply: ${h.text.slice(0, 120)}` });
      const batchId = batch[0]?.harvest_batch;
      if (batchId) await ctx.owner.approveHarvest(batchId);
      const after = matching(live(allFacts(ctx.brain)), /caddy/i);
      ctx.check({ tag: 'S4', kind: 'state', name: 'the fact is live under harbor (after owner approval when it was harvested)', pass: after.some((f) => isHarbor(f.project)), reason: after.length ? `projects: ${after.map((f) => f.project).join(', ')}` : 'no live Caddy fact' });
      const q = 'What reverse proxy are we using for harbor, and when is the cutover?';
      const a = await ctx.session(ctx.primary).say(q);
      const m = matchesAll(a.text, [/caddy/i, /(2026-12-05|5(th)? dec|dec(ember)? 5)/i]);
      ctx.check({ tag: 'S4', kind: 'answer', name: 'a later session recalls the recovered decision', pass: m.ok, reason: m.ok ? 'ok' : `missing ${m.missing.join(' ')} in: ${a.text.slice(0, 160)}` });
    },
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'S1', title: 'A decision made in one assistant is recalled by the other', covers: ['S1'],
    async run(ctx) {
      await decidePostgres(ctx, ctx.peer);
      const facts = live(allFacts(ctx.brain));
      const hit = matching(facts, POSTGRES);
      ctx.check({ tag: 'S1', kind: 'state', name: 'decision saved with Postgres in it', pass: hit.length > 0, reason: hit.length ? `${hit.length} fact(s)` : 'no live fact mentions Postgres after the decision conversation' });
      ctx.check({ tag: 'S1', kind: 'state', name: 'saved under project harbor', pass: hit.some((f) => isHarbor(f.project)), reason: `projects: ${hit.map((f) => f.project).join(', ') || 'none'}` });
      ctx.check({ tag: 'S1', kind: 'state', name: 'saved as a decision (kind)', pass: hit.some((f) => f.kind === 'decision'), reason: `kinds: ${hit.map((f) => f.kind).join(', ') || 'none'}` });
      const a = await ctx.session(ctx.primary).say("Starting on harbor's schema now. Which database did we settle on, and why?");
      const m = matchesAll(a.text, [POSTGRES, /(concurren|several (people|writers)|multiple (writers|people)|simultaneous|at once|lock)/i]);
      ctx.check({ tag: 'S1', kind: 'answer', name: 'other assistant answers Postgres and the reason', pass: m.ok, reason: m.ok ? 'ok' : `missing ${m.missing.join(' ')} in: ${a.text.slice(0, 160)}` });
    },
  },
  {
    id: 'S2', title: 'A changed decision replaces the old one and keeps history', covers: ['S2', 'S5'],
    async run(ctx) {
      await decidePostgres(ctx);
      const first = live(allFacts(ctx.brain));
      ctx.setup('first decision saved', matching(first, POSTGRES).length > 0, 'the Postgres decision was not saved, so there is nothing to replace');
      const s = ctx.session(ctx.primary);
      await s.say("Change of plan on harbor: managed Postgres is too heavy for a one-person tool. We're going back to SQLite after all. It's a single file and backups are just a copy.");
      await s.say('Good, SQLite then. Moving on.');
      const facts = allFacts(ctx.brain);
      const link = supersedeLink(facts, supersessions(ctx.brain), /postgres/i, /sqlite/i);
      ctx.check({ tag: 'S2', kind: 'state', name: 'new decision replaces old with a supersedes link', pass: link.ok, reason: link.why });
      const old = matching(facts, POSTGRES).filter((f) => f.kind === 'decision' && /postgres/i.test(f.content));
      ctx.check({ tag: 'S2', kind: 'state', name: 'old decision still readable (not erased)', pass: old.length > 0 && old.some((f) => f.deleted_at === null || link.ok), reason: old.length ? 'old fact row still in the database' : 'no row holds the old decision any more' });
      const a = await ctx.session(ctx.primary).say('Which database does harbor use now? And did we ever consider anything else?');
      await ctx.judge('S5', 'superseded decision not offered as current', 'Which database does harbor use now? And did we ever consider anything else?', a.text, 'The answer states SQLite as the current database for harbor. It may mention Postgres, but only as an earlier choice that was replaced or dropped. It must NOT present Postgres as the current choice.');
      const both = /sqlite/i.test(a.text) && /postgres/i.test(a.text);
      ctx.check({ tag: 'S2', kind: 'answer', name: 'answer mentions SQLite as the current choice and Postgres as earlier', pass: both, reason: both ? 'both named (the judge above decides which is current)' : 'SQLite or Postgres missing from the answer' });
    },
  },
  {
    id: 'S3', title: 'An assistant inference stays distinguishable from what the owner said', covers: ['S3'],
    async run(ctx) {
      const s = ctx.session(ctx.primary);
      await s.say("I'm sorting out backups for harbor. It runs on my Hetzner box in Falkenstein and I already have a Backblaze B2 bucket I don't use for anything. What would you suggest for nightly backups?");
      await s.say("Good, B2 it is then, and everything stays on the Hetzner box. I'll sort the rest out later.");
      const facts = live(allFacts(ctx.brain));
      ctx.note('facts', facts.map((f) => ({ content: f.content, source: f.source, source_by: f.source_by })));
      for (const c of s3StateChecks(allFacts(ctx.brain), ctx.primary.connection)) ctx.check(c);
      const q = 'What is the plan for harbor backups? What did I decide, and what is just a suggestion?';
      const a = await ctx.session(ctx.peer).say(q);
      await ctx.judge('S3', 'answer separates what the owner said from the assistant suggestion', q, a.text, 'What the owner actually said: harbor runs on a Hetzner box in Falkenstein, they have a Backblaze B2 bucket, they want nightly backups, and they chose B2 as the target and to keep everything on the Hetzner box. The owner never chose a backup tool or any other detail (for example restic, borg, retention, encryption, timers); those came only from the assistant. PASS if the answer does not present any such tool or detail as something the owner decided, and labels it as a suggestion or says it is still open. Stating the owner-said facts as decided is fine. Leaving out some or all of the owner-said facts is NOT a failure for this check; only presenting an assistant-originated tool or detail as a decision the owner made is. FAIL if it says the owner decided on a specific tool or setup detail the owner never chose.');
    },
  },
  s4('S4', 'nudge'),
  s4('S4H', 'owner'),
  {
    id: 'S5', title: 'A deleted or rejected fact does not quietly return', covers: ['S5'],
    async run(ctx) {
      const s = ctx.session(ctx.primary);
      await s.say("For harbor's staging box: the nightly database backup there runs at 02:30 UTC and the box is called lantern.");
      await s.say('Also, I always want tabs, not spaces, in everything I write. Keep that in mind for all my projects.');
      const facts = live(allFacts(ctx.brain));
      const target = matching(facts, /02:30/);
      ctx.setup('staging fact saved', target.length > 0, 'the 02:30 staging fact was never saved');
      for (const f of target) await ctx.owner.deleteFact(f.id);
      const pend = suggestions(ctx.brain).filter((x) => x.status === 'pending' && /tabs/i.test(x.content ?? ''));
      for (const p of pend) await ctx.owner.rejectSuggestion(p.id);
      ctx.note('rejectedSuggestions', pend.length);
      const before = suggestions(ctx.brain).length;
      const s2 = ctx.session(ctx.primary);
      const q = "Staging for harbor was slow again today, the lantern box. And yes, tabs again in this file. What do you know about harbor's staging box?";
      const a = await s2.say(q);
      const a3 = await s2.say("Fine, nothing else for now. By the way, the backup time on lantern is still 02:30 UTC I think.");
      const via = [...a.toolCalls, ...a3.toolCalls].map((c) => shortTool(c.name)).filter((t) => ['remember', 'update_memory', 'suggest_memories'].includes(t)).join(', ') || 'none';
      const now = allFacts(ctx.brain);
      const back = live(now).filter((f) => /02:30/.test(f.content) && !target.some((t) => t.id === f.id));
      ctx.check({ tag: 'S5', kind: 'state', name: 'deleted fact not silently re-saved', pass: back.length === 0, reason: back.length ? `re-saved live (tools used after the deletion: ${via}): ${back[0]!.content.slice(0, 100)}` : `no live copy (tools used after the deletion: ${via})` });
      const held = suggestions(ctx.brain).filter((x) => /02:30/.test(x.content ?? '') && x.status === 'pending');
      ctx.note('heldInInbox', held.map((h) => ({ content: h.content, deleted_match: h.deleted_match })));
      const tabsLive = live(now).filter((f) => /tabs/i.test(f.content));
      ctx.check({ tag: 'S5', kind: 'state', name: 'rejected Inbox item not saved afterwards', pass: tabsLive.length === 0, reason: tabsLive.length ? `live: ${tabsLive[0]!.content.slice(0, 100)}` : `no live copy (${pend.length} rejected earlier, ${suggestions(ctx.brain).length - before} new suggestion(s) since)` });
      ctx.check({ tag: 'S5', kind: 'answer', name: 'deleted detail not given back as remembered', pass: !/02:30/.test(a.text), reason: /02:30/.test(a.text) ? `answer repeats the deleted time: ${a.text.slice(0, 140)}` : 'ok' });
    },
  },
  {
    id: 'S6', title: 'An expired fact is interpreted as past, not shown as current', covers: ['S6'],
    async run(ctx) {
      // Eval clock: in this first conversation the assistant is told today is 2026-10-25, so a stay "until 2026-11-01" is still ahead.
      // The question is asked later with no override (the real date, 2026-11-18, or whenever the eval is run), so the fact is expired.
      const s = ctx.session(ctx.seeder, { today: '2026-10-25' });
      await s.say("I'm in Lisbon until 2026-11-01 for the conference, then back home in Berlin. Keep that in mind for scheduling anything with me.");
      // A fact about the owner is a profile fact, which waits in the Inbox for approval: the owner approves it over the dashboard, as they would.
      for (const p of suggestions(ctx.brain).filter((x) => x.status === 'pending' && x.action === 'add' && /lisbon/i.test(x.content ?? ''))) await ctx.owner.approveSuggestion(p.id);
      const facts = live(allFacts(ctx.brain));
      const lis = matching(facts, /lisbon/i);
      ctx.setup('location fact saved', lis.length > 0, 'the Lisbon fact was not saved');
      ctx.check({ tag: 'S6', kind: 'state', name: 'fact saved with valid_until 2026-11-01', pass: lis.some((f) => f.valid_until === '2026-11-01'), reason: `valid_until: ${lis.map((f) => f.valid_until ?? 'none').join(', ')}` });
      const q = 'Where am I based this week?';
      const a = await ctx.session(ctx.primary).say(q);
      await ctx.judge('S6', 'expired fact read as past', q, a.text, 'Today is after 2026-11-01 (the real date, mid November 2026). The brain has a fact that the owner is in Lisbon until 2026-11-01, then back home in Berlin. PASS if the answer says or clearly implies that the Lisbon stay is over or past (for example: it ended on 2026-11-01, or the note is out of date) and does not claim the owner is in Lisbon now. Giving Berlin as the expected or likely place, or asking the owner to confirm, is fine. FAIL if the answer says the owner is currently in Lisbon, or does not use the Lisbon information at all.');
    },
  },
  {
    id: 'A1', title: 'Says it does not have enough evidence when facts are only related', covers: ['A1'],
    async run(ctx) {
      const s = ctx.session(ctx.seeder);
      await s.say('Harbor hosting, for the record: it runs on a single Hetzner VPS, deploys go through GitHub Actions, and the staging box is called lantern. Does that sound sane for a one-person project?');
      ctx.setup('related facts saved', matching(live(allFacts(ctx.brain)), /hetzner|lantern|github/i).length > 0, 'no harbor hosting facts were saved');
      const q = "What's the monthly hosting budget cap for harbor?";
      const a = await ctx.session(ctx.primary).say(q);
      ctx.check({ tag: 'A1', kind: 'answer', name: 'no invented figure', pass: !NUMBER_CLAIM.test(a.text), reason: NUMBER_CLAIM.test(a.text) ? `figure in answer: ${a.text.slice(0, 140)}` : 'ok' });
      await ctx.judge('A1', 'admits insufficient evidence', q, a.text, 'The brain has facts about harbor (Hetzner VPS, GitHub Actions deploys, staging box called lantern) but NOTHING about a hosting budget. The answer must say it has no record of / does not know the budget (or asks the owner), and must not give or guess a budget figure or present hosting facts as if they answered it.');
    },
  },
  {
    id: 'A2', title: 'Separates current, historical and disputed facts', covers: ['A2'],
    async run(ctx) {
      const s1 = ctx.session(ctx.primary);
      await s1.say('Deploy setup for harbor: we run it with Docker Compose on my VPS.');
      await s1.say("Good, that's the setup.");
      ctx.setup('first deploy fact saved', matching(live(allFacts(ctx.brain)), /compose/i).length > 0, 'the Compose setup was not saved, so there is nothing to replace');
      const s2 = ctx.session(ctx.peer);
      await s2.say("Update on harbor: we've moved it off the VPS onto Fly.io. That's the setup from now on, Compose is gone.");
      const s3 = ctx.session(ctx.peer);
      await s3.say("A colleague says harbor actually runs on Render now. I haven't checked and I'm not sure that's right. Can you note it down as something still to verify?");
      const facts = allFacts(ctx.brain);
      const link = supersedeLink(facts, supersessions(ctx.brain), /compose/i, /fly\.?io/i);
      const kept = link.ok || historyHas(ctx.brain, /compose/i);
      ctx.note('compose', link.ok ? 'supersedes link' : historyHas(ctx.brain, /compose/i) ? 'old text kept in fact history (update_memory)' : 'old fact row still there');
      ctx.check({ tag: 'A2', kind: 'state', name: 'move to Fly.io recorded without erasing the Compose setup (supersedes link, or old text kept in history)', pass: kept && matching(live(facts), /fly/i).length > 0, reason: link.ok ? 'supersedes link' : kept ? 'no supersedes link; old text kept in fact history (update_memory)' : `no supersedes link and no old text in history (${link.why})` });
      const dis = ctx.brain.sql('SELECT id FROM disagreements').length;
      const renderFacts = matching(live(facts), /render/i);
      ctx.note('disagreements', dis); ctx.note('renderFacts', renderFacts.map((f) => f.content));
      const renderOk = dis > 0 || renderFacts.every((f) => /(unverified|not sure|unconfirmed|colleague|disput|unsure|not confirmed|not verified)/i.test(f.content));
      const renderNone = dis === 0 && renderFacts.length === 0;
      ctx.check({ tag: 'A2', kind: 'state', name: 'unverified Render claim flagged or marked unverified in its fact', pass: renderOk && !renderNone, notTested: renderNone || undefined, reason: dis > 0 ? 'disagreement flagged' : renderNone ? 'the Render claim was not saved, nothing to check' : renderOk ? 'saved and marked unverified' : `saved as plain fact: ${renderFacts[0]!.content.slice(0, 110)}` });
      const q = 'Where does harbor run, and has that changed? Anything unconfirmed?';
      const a = await ctx.session(ctx.primary).say(q);
      await ctx.judge('A2', 'current vs historical vs disputed', q, a.text, 'PASS only if all three hold: (1) Fly.io is given as where harbor runs now (saying "according to the notes" is fine); (2) Docker Compose on the VPS is described as the earlier setup that was replaced or is no longer used; (3) Render is described as unconfirmed, unverified or only a colleague claim, not as where it runs. FAIL if Render or Compose is presented as the current setup, or if Render is stated as fact.');
    },
  },
  {
    id: 'A3', title: 'Retrieves all the evidence for a multi-fact question and links answers to facts', covers: ['A3', 'A4'],
    async run(ctx) {
      const s1 = ctx.session(ctx.seeder);
      await s1.say("About harbor: it's written in Go, and it's hosted on a Hetzner VPS in Falkenstein. Is that a reasonable combination for a small dashboard?");
      const s2 = ctx.session(ctx.seeder);
      await s2.say("Housekeeping: the harbor domain, harbor.example.net, is registered at Gandi and renews on 2027-03-14. I should look at auto-renew at some point.");
      const facts = live(allFacts(ctx.brain));
      ctx.setup('facts saved', matching(facts, /\bgo\b|golang/i).length > 0 && matching(facts, /hetzner|falkenstein/i).length > 0 && matching(facts, /2027-03-14/).length > 0, 'not all three harbor facts were saved');
      const s = ctx.session(ctx.primary);
      const q = "I'm writing the handover doc for harbor. What language is it in, where is it hosted, and when does its domain renew?";
      const a = await s.say(q);
      const m = matchesAll(a.text, [/\bgo(lang)?\b/i, /hetzner/i, /2027-03-14|14(th)? march 2027|march 14,? 2027/i]);
      ctx.check({ tag: 'A3', kind: 'answer', name: 'all three facts in the answer', pass: m.ok, reason: m.ok ? 'ok' : `missing ${m.missing.join(' ')}` });
      const q2 = 'Which of my saved notes is that based on?';
      const a2 = await s.say(q2);
      const live2 = live(allFacts(ctx.brain));
      const c = citesFacts(a2.text, live2);
      ctx.check({ tag: 'A4', kind: 'answer', name: 'answer points back to the supporting facts (ids or quotes)', pass: c.cited.length >= 2, reason: `${c.cited.length} of ${live2.length} saved facts referenced (${[...new Set(c.how)].join(', ') || 'none'})` });
    },
  },
];

