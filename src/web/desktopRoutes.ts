/** The Mac app's pages (D3), in local mode only: Settings › Tools on this Mac. */
import { Router } from 'express';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, disconnect, toolStates, type ToolEnv, type ToolId } from '../desktop/tools.js';
import { setupText } from '../setup/texts.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { page } from './html.js';
import { firstLine, toolsPage, welcomePage } from './desktopViews.js';
import { thisComputer } from '../desktop/computer.js';

const OWNER = { type: 'owner' } as const;
const DONE_FILE = 'welcome-done';
let doneInMemory = false;

function welcomeDone(d: AppDeps): boolean {
  return d.statusDir ? existsSync(join(d.statusDir, DONE_FILE)) : doneInMemory;
}

/** A new Mac install opens on the welcome: nothing saved, nothing suggested, nothing connected, and not dismissed. */
export function needsWelcome(d: AppDeps): boolean {
  return toolEnv(d) !== null && !welcomeDone(d) && d.store.countCurrent() === 0 && d.service.pendingSuggestions().length === 0
    && d.provider.listGrants().length === 0;
}

const IDS: readonly ToolId[] = ['claude-code', 'codex', 'opencode', 'cursor'];
const isId = (s: string): s is ToolId => (IDS as readonly string[]).includes(s);

export function toolEnv(d: AppDeps): ToolEnv | null {
  if (!d.localMode || !d.tools) return null;
  const mcpUrl = new URL('/mcp', d.publicUrl).href;
  return { ...d.tools, mcpUrl, rules: (slug) => setupText(slug, 'personal', mcpUrl, d.setupOverlay) };
}

export function desktopRoutes(d: AppDeps): Router {
  const router = Router();
  const env = toolEnv(d);
  if (!env) return router;
  const owner = requireOwner(d.sessions);
  // The last result for each tool, shown once on the page it returns to. Kept here, never taken from the URL, so a
  // link from another site cannot make the page say anything (D3 review).
  const results = new Map<ToolId, { text: string; at: number }>();
  const resultFor = (q: unknown): string | null => {
    if (typeof q !== 'string' || !isId(q)) return null;
    const r = results.get(q);
    results.delete(q);
    return r && Date.now() - r.at < 120_000 ? r.text : null;
  };

  router.get('/settings/tools', owner, async (req, res) => {
    const said = resultFor(req.query.tool);
    res.type('html').send(page(`Tools on ${thisComputer()}`, toolsPage({ tools: await toolStates(env), said, cursorRules: env.rules('claude-code') }),
      { nav: true, tab: null, back: { href: '/settings#connections', label: 'Settings' } }));
  });

  for (const what of ['connect', 'disconnect'] as const) {
    router.post(`/settings/tools/:id/${what}`, owner, async (req, res, next) => {
      const id = req.params.id as string;
      if (!isId(id)) return next();
      const replace = (req.body as Record<string, unknown> | undefined)?.replace === '1';
      const r = what === 'connect' ? await connect(id, env, { replace }) : await disconnect(id, env);
      const said = r.ok ? (what === 'connect' ? `Connected. Next: ${r.signIn}` : 'Disconnected.') : r.reason;
      results.set(id, { text: said, at: Date.now() });
      const back = (req.body as Record<string, unknown> | undefined)?.back === 'welcome' ? '/welcome?step=2&tool=' : '/settings/tools?tool=';
      res.redirect(303, back + id);
    });
  }
  router.get('/welcome', owner, async (req, res) => {
    const step = req.query.step === '2' ? 2 : req.query.step === '3' ? 3 : 1;
    const said = resultFor(req.query.tool);
    res.type('html').send(page('Welcome to BrainAI', welcomePage({ step, tools: step === 2 ? await toolStates(env) : [], said, cursorRules: env.rules('claude-code') }),
      { nav: false, tab: null }));
  });

  router.post('/welcome/name', owner, async (req, res) => {
    const raw = (req.body as Record<string, unknown> | undefined)?.name;
    const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    if (name !== '') await d.service.remember({ kind: 'profile', content: `The owner is called ${name}.` }, OWNER);
    res.redirect(303, '/welcome?step=2');
  });

  router.get('/welcome/first', owner, (_req, res) => {
    const mine = d.store.list({ limit: 50 }).filter((m) => m.createdBy !== 'owner').sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const held = d.service.pendingSuggestions().filter((s) => s.content !== null)[0];
    res.set('Cache-Control', 'no-store').type('html').send(firstLine({
      memory: mine ? { by: mine.createdBy, content: mine.content } : null,
      suggestion: held ? { by: held.suggestedBy, content: held.content! } : null,
    }).value);
  });

  router.post('/welcome/done', owner, (_req, res) => {
    if (d.statusDir) writeFileSync(join(d.statusDir, DONE_FILE), '');
    doneInMemory = true;
    res.redirect(303, '/');
  });
  return router;
}
