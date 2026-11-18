/**
 * The Import page (C1, C4): pasted built-in memories reviewed line by line, and one file added as a page. Owner only;
 * the app's Origin check covers every POST. Uploads and pasted text are held in memory for the request: no file is written.
 */
import express, { Router, type ErrorRequestHandler, type Request, type Response } from 'express';
import { bodyWithoutTitle, checkFile, FileRefused, MAX_FILE_BYTES } from '../import/fileUpload.js';
import { guessKind, MAX_IMPORT_ROWS, MAX_PASTE_LINES, splitCandidates } from '../import/lines.js';
import { parseMultipart } from '../import/multipart.js';
import { vendorById, type Vendor } from '../import/vendors.js';
import { looksLikeInstruction } from '../memory/instructionLike.js';
import { MemoryError } from '../memory/service.js';
import { FileImports } from '../pages/fileImports.js';
import { renderMarkdown } from '../pages/markdown.js';
import { PageError } from '../pages/types.js';
import { localDay } from '../timezone.js';
import type { AppDeps } from './app.js';
import { requireOwner } from './authRoutes.js';
import { page, type SafeHtml } from './html.js';
import { filePreviewView, importView, reviewView, type ImportPageInput, type ReviewRow } from './importPageViews.js';
import { plural } from './dashboardViews.js';

const OWNER = { type: 'owner' } as const;
/** A pasted memory: 200 lines of up to 1000 characters, with room for the form's own fields. */
export const IMPORT_FORM_LIMIT = 4 * 1024 * 1024;
/** A reviewed paste posts up to 6 fields for each of 200 rows (text, tick, kind, project, flagged, confirm). */
export const IMPORT_FORM_PARAMETERS = 2000;

/** The same words in different case, spacing or end punctuation. */
const normal = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?;:]+$/, '').trim();

/** A friendly page for a form that is too big for /import (too much text, or too many fields), instead of a bare error. */
export function importFormTooLarge(d: AppDeps): ErrorRequestHandler {
  return (err, _req, res, next) => {
    if ((err?.type !== 'entity.too.large' && err?.type !== 'parameters.too.many') || res.headersSent) return next(err);
    const projects = d.registry.list().map((p) => p.name).sort();
    res.status(413).type('html').send(page('Import', importView({ projects, said: { kind: 'error', text: `That was too much to take in one go (a paste is read up to ${MAX_PASTE_LINES} lines, and one import saves up to ${MAX_IMPORT_ROWS} facts). Nothing was saved. Paste fewer lines and try again; your text stays in the chat or file you copied it from.` } }), { nav: true, tab: 'settings', back: { href: '/settings', label: 'Settings' } }));
  };
}

const str = (req: Request, k: string): string => {
  const v = (req.body as Record<string, unknown> | undefined)?.[k];
  return typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
};

function savedSentence(c: { saved: number; duplicates: number; over: number; refused: number; held: number }): string {
  return [`Saved ${plural(c.saved, 'fact', 'facts')}.`, c.duplicates > 0 ? `${plural(c.duplicates, 'duplicate', 'duplicates')} skipped.` : null,
    c.over > 0 ? `${plural(c.over, 'row', 'rows')} not saved: one import saves up to ${MAX_IMPORT_ROWS}; paste the rest again.` : null,
    c.held > 0 ? `${plural(c.held, 'row', 'rows')} not saved: a line that reads like an instruction to assistants needs its confirm box ticked to go into your profile.` : null,
    c.refused > 0 ? `${plural(c.refused, 'row', 'rows')} refused (a secret or a line that is too long).` : null].filter((x): x is string => x !== null).join(' ');
}

export function guidedImportRoutes(d: AppDeps): Router {
  const router = Router();
  const owner = requireOwner(d.sessions);
  const back = { href: '/settings', label: 'Settings' };
  const send = (res: Response, status: number, title: string, body: SafeHtml) =>
    res.status(status).type('html').send(page(title, body, { nav: true, tab: 'settings', back }));
  const projects = () => d.registry.list().map((p) => p.name).sort();
  const fileImports = () => (d.db ? new FileImports(d.db, d.now) : undefined);
  const main = (res: Response, status = 200, extra: Partial<ImportPageInput> = {}) => send(res, status, 'Import', importView({ projects: projects(), ...extra }));

  router.get('/import', owner, (req, res) => {
    const n = (k: string): number => { const v = req.query[k]; return typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : 0; };
    if (typeof req.query.saved !== 'string') return main(res);
    const [saved, duplicates, over, refused, held] = [n('saved'), n('dup'), n('over'), n('refused'), n('held')];
    main(res, 200, { said: { kind: 'notice', text: savedSentence({ saved, duplicates, over, refused, held }) } });
  });

  router.post('/import/paste', owner, async (req, res) => {
    const source = vendorById(str(req, 'source'));
    const text = str(req, 'text');
    if (!source || text.trim() === '') return main(res, 400, { said: { kind: 'error', text: 'Choose where it came from and paste some text.' }, pasteText: text });
    const c = splitCandidates(text);
    const rows: ReviewRow[] = [];
    let checked = true;
    const everything = d.store.list({ limit: -1 }).map((m) => ({ id: m.id, content: m.content, key: normal(m.content) }));
    for (const line of c.lines) {
      const kind = guessKind(line);
      const dup = await d.service.duplicatesOf(line, kind, null);
      if (!dup.checked) checked = false;
      // An exact (or same-words) match of any saved fact, a profile fact included, is a duplicate with or without a search model.
      const key = normal(line);
      const matches = [...everything.filter((m) => m.key === key), ...(dup.checked ? dup.matches.map((m) => ({ id: m.memory.id, content: m.memory.content })) : [])];
      const seen = new Set<string>();
      const unique = matches.filter((m) => !seen.has(m.id) && seen.add(m.id)).slice(0, 3).map((m) => ({ id: m.id, content: m.content }));
      rows.push({ text: line, kind, project: '', instruction: looksLikeInstruction(line), duplicates: unique.length > 0 ? unique : dup.checked ? [] : null });
    }
    send(res, 200, 'Review import', reviewView({ source, rows, projects: projects(), secrets: c.secrets, skipped: c.skipped, overCap: c.overCap, checked: checked || rows.length === 0 }));
  });

  router.post('/import/save', owner, async (req, res) => {
    const source: Vendor | undefined = vendorById(str(req, 'source'));
    const n = Math.min(Number.parseInt(str(req, 'n'), 10) || 0, 200);
    if (!source) return main(res, 400, { said: { kind: 'error', text: 'Start again from the paste box.' } });
    const note = `Imported from ${source.name} memory, ${localDay(d.now())}`;
    let saved = 0, duplicates = 0, over = 0, refused = 0, held = 0;
    for (let i = 0; i < n; i++) {
      const text = str(req, `text_${i}`).trim();
      const flagged = str(req, `dup_${i}`) === '1';
      if (str(req, `on_${i}`) !== '1') { if (flagged) duplicates++; continue; }
      if (saved >= MAX_IMPORT_ROWS) { over++; continue; }
      const kind = str(req, `kind_${i}`) === 'profile' ? 'profile' : 'decision';
      const project = kind === 'profile' ? '' : str(req, `project_${i}`).trim();
      // A line that reads like an instruction to assistants goes into the profile only when the owner confirmed that row.
      if (kind === 'profile' && looksLikeInstruction(text) !== null && str(req, `confirm_${i}`) !== '1') { held++; continue; }
      try {
        // The owner chose this row, so it is saved directly. A match that appeared since the review (an earlier row of this batch) is still skipped.
        if (!flagged) {
          const dup = await d.service.duplicatesOf(text, kind, project || null);
          if (dup.matches.length > 0 || d.store.list({ limit: -1 }).some((m) => normal(m.content) === normal(text))) { duplicates++; continue; }
        }
        await d.service.remember({ kind, content: text, project: project || undefined, meta: { source: 'imported', sourceNote: note } }, OWNER);
        saved++;
      } catch (e) {
        if (!(e instanceof MemoryError) && !(e instanceof Error && e.name === 'MetaError')) throw e;
        refused++;
      }
    }
    // Post, redirect, get: reloading the result does not save the batch again.
    res.redirect(303, `/import?${new URLSearchParams({ saved: String(saved), dup: String(duplicates), over: String(over), refused: String(refused), held: String(held) })}`);
  });

  // ---- Add a file as a page ----

  /** One multipart body, held in memory (1 MB and a little for the form's framing). */
  const upload = express.raw({ type: () => true, limit: MAX_FILE_BYTES + 16 * 1024 });
  router.post('/import/file', owner, (req, res) => {
    upload(req, res, (err?: unknown) => {
      if (err) return main(res, 413, { fileError: 'That file is larger than 1 MB.' });
      const parts = parseMultipart(req.get('content-type'), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      const file = parts?.find((p) => p.name === 'file' && p.filename !== undefined && p.filename !== '');
      if (!file) return main(res, 400, { fileError: 'Choose a file to add.' });
      try {
        const f = checkFile(file.filename!, file.data);
        send(res, 200, 'Add a file as a page', filePreviewView({ name: f.name, title: f.title, project: '', area: 'start', body: bodyWithoutTitle(f.text, f.title), rendered: renderMarkdown(bodyWithoutTitle(f.text, f.title), d.pages.resolver()), projects: projects() }));
      } catch (e) {
        if (!(e instanceof FileRefused)) throw e;
        main(res, 400, { fileError: e.message });
      }
    });
  });

  router.post('/import/file/create', owner, async (req, res) => {
    const rawName = str(req, 'file_name').replace(/^.*[\\/]/, '').slice(0, 200);
    const body = str(req, 'body').replace(/\r\n?/g, '\n');
    const form = { name: rawName, title: str(req, 'title').trim(), project: str(req, 'project'), area: str(req, 'area') || 'start', body, projects: projects() };
    const again = (status: number, error: string) => send(res, status, 'Add a file as a page', filePreviewView({ ...form, rendered: renderMarkdown(body, d.pages.resolver()), error }));
    try {
      // The same checks as the upload: the form could have been edited by hand.
      const checked = checkFile(rawName, Buffer.from(body, 'utf8'));
      const p = await d.pages.create({ title: form.title, project: form.project || undefined, area: form.area, body }, 'owner');
      fileImports()?.mark(p.id, checked.name);
      res.redirect(303, `/pages/${p.id}`);
    } catch (e) {
      if (e instanceof FileRefused) return main(res, 400, { fileError: e.message });
      if (e instanceof PageError) return again(400, e.message);
      throw e;
    }
  });

  return router;
}
