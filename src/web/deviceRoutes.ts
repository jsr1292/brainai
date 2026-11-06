import express, { Router, type ErrorRequestHandler, type Request, type RequestHandler, type Response } from 'express';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { parseReport, ReportError } from '../folders/report.js';
import type { Device } from '../folders/devices.js';
import type { AppDeps } from './app.js';
import { SkillError } from '../skills/service.js';
import type { ReportItem } from '../skills/sync.js';
import type { SkillFile } from '../skills/types.js';

const REPORT_LIMIT = '256kb';
/** Reports per device per hour: the reporter sends 4 (every 15 minutes), so this leaves room for runs by hand. */
const REPORTS_PER_HOUR = 30;

/**
 * POST /api/folder-report: the Mac's folder report, with a device token (Authorization: Bearer). The token is checked
 * before the body is read, and it opens nothing else: not /mcp, not the owner's pages.
 */
export function deviceRoutes(d: AppDeps): Router {
  const router = Router();
  const auth: RequestHandler = (req, res, next) => {
    const m = /^Bearer (\S+)$/.exec(req.get('authorization') ?? '');
    const device = m ? d.devices.authenticate(m[1]!) : undefined;
    if (!device) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.locals.device = device;
    next();
  };
  // Per device, checked before the body is read: a leaked or looping device token can't keep the server busy.
  const perDevice = new RateLimiterMemory({ points: REPORTS_PER_HOUR, duration: 60 * 60 });
  const limit: RequestHandler = async (_req, res, next) => {
    try {
      await perDevice.consume((res.locals.device as Device).id);
      next();
    } catch (e) {
      if (!(e instanceof RateLimiterRes)) throw e;
      res.set('Retry-After', String(Math.ceil(e.msBeforeNext / 1000)));
      res.status(429).json({ error: `At most ${REPORTS_PER_HOUR} reports an hour from one device` });
    }
  };
  // Only the body parser's own errors (bad JSON, too large); anything else is a server error for the app's handler.
  const bodyErrors: ErrorRequestHandler = (err, _req, res, next) => {
    if (res.headersSent || !String((err as { type?: string }).type ?? '').startsWith('entity.')) return next(err);
    const status = (err as { status?: number }).status === 413 ? 413 : 400;
    res.status(status).json({ error: status === 413 ? 'The report is too large' : 'The report is not valid JSON' });
  };
  router.post('/api/folder-report', auth, limit, express.json({ limit: REPORT_LIMIT, type: () => true }), (req: Request, res: Response) => {
    try {
      const folders = parseReport(req.body);
      d.devices.storeReport((res.locals.device as Device).id, folders);
      res.status(204).end();
    } catch (e) {
      if (!(e instanceof ReportError)) throw e;
      res.status(400).json({ error: e.message });
    }
  }, bodyErrors);

  // ---- The Mac skills sync (round 2 §17c): a report, then the content the brain asked for. Own limits each. ----
  const limiter = (points: number) => {
    const rl = new RateLimiterMemory({ points, duration: 60 * 60 });
    const h: RequestHandler = async (_req, res, next) => {
      try {
        await rl.consume((res.locals.device as Device).id);
        next();
      } catch (e) {
        if (!(e instanceof RateLimiterRes)) throw e;
        res.set('Retry-After', String(Math.ceil(e.msBeforeNext / 1000)));
        res.status(429).json({ error: `At most ${points} of these an hour from one device` });
      }
    };
    return h;
  };
  const skillError = (res: Response, e: unknown) => {
    if (!(e instanceof SkillError)) throw e;
    res.status(400).json({ error: e.message });
  };
  router.post('/api/skills/report', auth, limiter(SKILL_SYNCS_PER_HOUR), express.json({ limit: '256kb', type: () => true }), (req: Request, res: Response) => {
    try {
      res.json(d.skillSync.report((res.locals.device as Device).id, parseSkillReport(req.body)));
    } catch (e) { skillError(res, e); }
  }, bodyErrors);
  router.post('/api/skills/upload', auth, limiter(SKILL_SYNCS_PER_HOUR), express.json({ limit: '4mb', type: () => true }), (req: Request, res: Response) => {
    try {
      d.skillSync.upload((res.locals.device as Device).id, parseSkillUpload(req.body));
      res.status(204).end();
    } catch (e) { skillError(res, e); }
  }, bodyErrors);
  return router;
}

/** Skill syncs per device per hour, each endpoint: the Mac sends one of each every 15 minutes. */
const SKILL_SYNCS_PER_HOUR = 20;
const MAX_REPORTED_SKILLS = 200;

function parseSkillReport(body: unknown): ReportItem[] {
  const list = (body as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(list) || list.length > MAX_REPORTED_SKILLS) throw new SkillError('invalid', 'Expected {skills: [...]}, at most 200.');
  return list.map((x) => {
    const o = x as Record<string, unknown>;
    if (typeof o.name !== 'string' || typeof o.hash !== 'string' || typeof o.description !== 'string' || typeof o.files !== 'number' || typeof o.bytes !== 'number'
      || !(o.shareable === null || typeof o.shareable === 'string')) throw new SkillError('invalid', 'Each skill needs name, description, hash, files, bytes and shareable.');
    return { name: o.name, description: o.description, hash: o.hash, files: o.files, bytes: o.bytes, shareable: o.shareable === null ? null : String(o.shareable).slice(0, 200) };
  });
}

function parseSkillUpload(body: unknown): { name: string; hash: string; files: SkillFile[] }[] {
  const list = (body as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(list) || list.length > MAX_REPORTED_SKILLS) throw new SkillError('invalid', 'Expected {skills: [...]}.');
  return list.map((x) => {
    const o = x as Record<string, unknown>;
    if (typeof o.name !== 'string' || typeof o.hash !== 'string' || !Array.isArray(o.files)) throw new SkillError('invalid', 'Each skill needs name, hash and files.');
    const files = o.files.map((f) => {
      const ff = f as Record<string, unknown>;
      if (typeof ff.path !== 'string' || typeof ff.text !== 'string') throw new SkillError('invalid', 'Each file needs path and text.');
      return { path: ff.path, text: ff.text };
    });
    return { name: o.name, hash: o.hash, files };
  });
}
