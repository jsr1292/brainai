import { createHash } from 'node:crypto';
import type { LearningService } from '../learning/service.js';
import { dirname, join } from 'node:path';
import { temporaryHomePort } from '../desktop/homePort.js';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ClientsStore } from '../auth/clientsStore.js';
import { exemptFromDailyCap } from '../auth/clientsStore.js';
import type { LoginLimiter } from '../auth/loginLimiter.js';
import type { OwnerAuth } from '../auth/owner.js';
import type { MemoryOAuthProvider } from '../auth/provider.js';
import type { DB } from '../db.js';
import type { RedirectAllowlist } from '../auth/redirects.js';
import { setOwnOrigins } from '../pages/markdown.js';
import { RefusedRedirects } from '../auth/refusedRedirects.js';
import { fetchMetadataGuard, hostGuard } from './hostGuard.js';
import { Reach } from '../desktop/reach.js';
import { BackupCopy } from '../desktop/backupCopy.js';
import { isAppPath, PublicDoor, viaDoor } from '../desktop/publicDoor.js';
import { movedTo } from '../desktop/move.js';
import { desktopRoutes } from './desktopRoutes.js';
import { weekNoteRoutes } from './weekNote.js';
import { reachRoutes } from './reachRoutes.js';
import { moveRoutes } from './moveRoutes.js';
import { savedRoutes } from './savedRoutes.js';
import { isRemoving } from '../desktop/removing.js';
import { removeRoutes } from './removeRoutes.js';
import type { SessionStore } from '../auth/sessions.js';
import type { Clock } from '../clock.js';
import type { GrowthService } from '../growth/service.js';
import type { DeviceService } from '../folders/devices.js';
import type { FolderService } from '../folders/match.js';
import type { ImportLog } from '../pages/importLog.js';
import type { NoteService } from '../pages/notes.js';
import type { ReviewService } from '../review/service.js';
import type { PageService } from '../pages/service.js';
import type { ImageStore } from '../images/store.js';
import type { DiagramChecks } from '../pages/diagramChecks.js';
import type { UploadLinks } from '../images/uploadLinks.js';
import { MAX_BODY } from '../pages/types.js';
import type { DiscussionService } from '../discussions/service.js';
import type { Access } from '../discussions/types.js';
import { servedToolNames } from '../mcp/server.js';
import { mcpServerFor } from './mcpFor.js';
import type { SkillService } from '../skills/service.js';
import type { TidyService } from '../memory/tidyService.js';
import type { SkillSync } from '../skills/sync.js';
import type { SetupOverlay } from '../setup/texts.js';
import { MAX_SKILL_BYTES, MAX_SKILL_DESCRIPTION } from '../skills/types.js';
import type { ProjectsService } from '../projects/service.js';
import { projectRoutes } from './projectRoutes.js';
import { mapRoutes } from './mapRoutes.js';
import { reviewRoutes } from './reviewRoutes.js';
import { growthRoutes } from './growthRoutes.js';
import { activityRoutes } from './activityRoutes.js';
import { deviceRoutes } from './deviceRoutes.js';
import { imageRoutes } from './imageRoutes.js';
import { diagramRoutes } from './diagramRoutes.js';
import { pictureReviewRoutes } from './pictureReviewRoutes.js';
import { setupRoutes } from './setupRoutes.js';
import { skillRoutes } from './skillRoutes.js';
import { tidyProposalRoutes } from './tidyProposalRoutes.js';
import { pageRoutes } from './pageRoutes.js';
import { linkRoutes } from './linkTargets.js';
import { importRoutes } from './importRoutes.js';
import { guidedImportRoutes, IMPORT_FORM_LIMIT, IMPORT_FORM_PARAMETERS, importFormTooLarge } from './guidedImportRoutes.js';
import { searchRoutes } from './searchRoutes.js';
import type { MemoryService } from '../memory/service.js';
import type { MemoryStore } from '../memory/store.js';
import type { ProjectStore } from '../projects/store.js';
import { authRoutes, readCookie, SESSION_COOKIE } from './authRoutes.js';
import { dashboardRoutes } from './dashboardRoutes.js';
import { discussionRoutes } from './discussionRoutes.js';
import { DOOR_VIA_SETTING, rateLimitKey, TRUST_CF_SETTING } from './clientIp.js';
import { html, page, setConsentPoller, setGoTo, setMovedBanner, setPausedBanner, setServerMode } from './html.js';
import { coachingShown, createSideStatus, invalidateSideStatus, runWithDoorFlag, setSideStatus } from './sideStatus.js';
import { setViewClock } from './when.js';
import { storedChoice, UI_LANGUAGE_SWITCH, writeUiLanguageFile } from '../i18n/uiLanguage.js';
import { t } from '../i18n/core.js';
import { CLIENT_ENDPOINTS, localeMiddleware } from './locale.js';
import { themeMiddleware } from './theme.js';
import { fmt } from '../i18n/fmt.js';
import type { GraphService } from '../graph/data.js';
import { graphRoutes } from './graphRoutes.js';
import { computerName, setComputer } from '../desktop/computer.js';
import type { ModelManager } from '../models/manager.js';
import type { Hardware } from '../models/hardware.js';

export interface AppDeps {
  publicUrl: URL;
  store: MemoryStore;
  service: MemoryService;
  /** The projects registry (area, one-liner, owner-set state and pins). */
  registry: ProjectStore;
  /** The projects home: cards, the pick-up-here panel and the owner's actions on projects. */
  projects: ProjectsService;
  discussions: DiscussionService;
  /** What assistants notice about how the owner works (note_observation, Week › Growth). */
  growth: GrowthService;
  /** Weekly reviews: built once per finished week from history, shown filtered (spec section 14). */
  reviews: ReviewService;
  /** The owner's pages: long documents with every version kept. */
  pages: PageService;
  /** Picture files and rows (round 2 section 12). */
  images: ImageStore;
  /** What the owner's browser saw when it drew each diagram (round 2 section 12). */
  diagramChecks: DiagramChecks;
  /** Assistants' one-use picture upload links (round 2 section 12). */
  uploadLinks: UploadLinks;
  /** Shared skills (round 2 §17c). */
  skills: SkillService;
  /** B2: assistant-run tidy sessions: the proposals that wait in the Inbox. */
  tidy: TidyService;
  /** The skills sync with devices (round 2 §17c). */
  skillSync: SkillSync;
  /** The owner's setup lines and setup number (overlay/setup.json), when there is one. */
  setupOverlay?: SetupOverlay;
  /** The owner's notes on pages, resolved by assistants. */
  notes: NoteService;
  /** The Mac's device tokens and folder reports. */
  devices: DeviceService;
  /** The latest folder report matched to projects. */
  folders: FolderService;
  /** The record of the move from Outline (Pages › Moved from Outline). */
  imports: ImportLog;
  /** How close another project's decision must be by meaning to show as related to a page (index.ts: RELATED_SIMILARITY). */
  relatedSimilarity: number;
  /** The five areas and the owner's handbook (src/learning/). */
  learning: LearningService;
  /** How closely two projects' facts must match to be offered as one project (the embedding model's profile). */
  sameProjectFloor: number;
  /** The app's models: the choice, downloads and switches (local mode only; a server's are in its image). */
  models?: ModelManager;
  /** This computer's chip, memory and free space, for the welcome's suggestion (default: read from the data folder). */
  hardware?: () => Promise<Hardware>;
  /** The Graph tab's data: project cards from the home, threads from the stored meaning links (spec section 15). */
  graph: GraphService;
  provider: MemoryOAuthProvider;
  /** The sign-in addresses apps may use; the setup pages can add an app's known one or a refused one (R1). */
  allowlist: RedirectAllowlist;
  owner: OwnerAuth;
  sessions: SessionStore;
  limiter: LoginLimiter;
  clients: ClientsStore;
  now: Clock;
  /** Commands the opener of a discussion runs to ask the other assistants itself (see Config.askCommands). */
  askCommands?: () => Record<string, string>;
  /** Looks at the tools again now (after Connect or Disconnect in the app), so the next session sees the change. */
  refreshAskCommands?: () => Promise<void>;
  /** Default true (the Cloudflare tunnel is the only way in). False makes rate limits ignore cf-connecting-ip. */
  trustCfConnectingIp?: boolean;
  /** Where the backup runs record their outcome (the data folder); the home page shows it. None: no backup panel. */
  statusDir?: string;
  /** Server mode's Check for updates: the release address and fetch, which tests replace (default: GitHub's latest release, global fetch). */
  releaseApiUrl?: string;
  releaseFetch?: typeof fetch;
  /** The desktop app's local mode (Config.localMode): answers only to localhost; signed in until a password exists. */
  localMode?: boolean;
  /** The desktop app's key (Config.appSecret): GET /app/open?key=… opens a session for the app's window. */
  appSecret?: string | null;
  /** Local mode: the public address (Reach from phone and web, D4). Created by createApp when not given. */
  reach?: Reach;
  /** Local mode: the second backup folder. Created by createApp when not given. */
  backupCopy?: BackupCopy;
  /** How many daily backups are kept (Config.backupKeep), also in the second folder; the Settings text says so. Defaults to DEFAULT_BACKUP_KEEP. */
  backupKeep?: number;
  /** Where the in-app backups go (Config.backupDir); POST /app/backup-now writes there before an update. */
  backupDir?: string | null;
  /** Local mode: where the models are and where the running program is, for Settings' space breakdown (tests point them at temp folders). */
  space?: { modelDir?: string; execPath?: string; platform?: NodeJS.Platform };
  /** Local mode: the public door Tailscale Funnel forwards to, open only while Reach is in use. Created by createApp. */
  door?: PublicDoor;
  /** Local mode: shows a file in Finder (Move to a server). Tests replace it. */
  reveal?: (path: string) => void;
  /** Whether BrainAI answers at a public address (Reach through Cloudflare checks before saying On). Tests replace it. */
  reachCheck?: (url: URL) => Promise<boolean>;
  /** How often Reach asks Tailscale again at start when it was not ready: every `everyMs` for the first `max` tries, then every `laterMs`, for as long as it lasts (tests shorten it). */
  reachRetry?: { everyMs: number; max: number; laterMs: number };
  /** The database itself, for the moving file's copy (local mode). */
  db?: DB;
  /** Local mode: where the owner's coding tools are (their HOME and the PATH to find their commands), for Connect (D3). */
  tools?: { home: string; path: string; apps?: string; extraEnv?: Record<string, string>; /** Tailscale's app command (tests point it nowhere). */ tailscaleApp?: string; /** Tests: the time limit of the status check the Reach page shows (default 5 s). */ tailscaleStatusMs?: number; /** The computer's platform (tests pass win32); default process.platform. */ platform?: NodeJS.Platform; /** Where Claude's bridge program is (default: this server's own cli.js). */ bridgeCli?: string; /** Tests: Claude's settings file and the system variables, so nothing reads the real ones. */ claudeConfig?: string; system?: Record<string, string | undefined> };
}

const CSP = "default-src 'self'; frame-ancestors 'none'; form-action 'self' https: http://localhost:* http://127.0.0.1:*";
const SCOPES = ['memory'];
/** Called by OAuth/MCP clients without browser cookies, so they carry no Origin to check. /app/hello, /app/bridge-hello, /app/ticket and
 * /app/removed/ready: the desktop app's own check, the Claude bridge's proof, ticket and removal check, called by the app itself, never by a page (D2). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), 'static');

/** Exists only so Android offers "Install". It must never cache anything: no caches API and no fetch handler. */
const SERVICE_WORKER = '// Intentionally empty: this service worker only makes the app installable.\n';

const securityHeaders: RequestHandler = (req, res, next) => {
  res.set('Content-Security-Policy', CSP);
  res.set('X-Content-Type-Options', 'nosniff');
  // Not no-referrer: with it, browsers send `Origin: null` on form POSTs and the Origin check would refuse them.
  res.set('Referrer-Policy', 'same-origin');
  if (req.path !== '/static' && !req.path.startsWith('/static/')) res.set('Cache-Control', 'no-store');
  next();
};

/**
 * A page that is not the plain 200 answer to a GET of its URL (a preview, a refused note, a conflict, a form error)
 * may hold a draft that only it has: its body says so, and app.js never refreshes it on return.
 */
const markUnrepeatable: RequestHandler = (req, res, next) => {
  const send = res.send.bind(res);
  res.send = (body?: unknown) => {
    const unrepeatable = !SAFE_METHODS.has(req.method) || res.statusCode !== 200;
    return send(unrepeatable && typeof body === 'string' ? body.replace('<body class=', '<body data-fresh="off" class=') : body);
  };
  next();
};

/** CSRF protection: state-changing browser requests must come from our own pages. */
function sameOrigin(expected: (req: express.Request) => URL): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (CLIENT_ENDPOINTS.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
    // Each address takes forms only from its own pages; a missing Origin is never a match.
    const origin = req.get('origin');
    if (origin !== undefined && origin === expected(req).origin) return next();
    res.status(403).type('html').send(page(t('common.forbidden'), html`<h1>${t('common.forbidden')}</h1><p>${t('common.forbiddenBody')}</p>`, { tab: null }));
  };
}

/** The SDK's OAuth endpoints (its routers match any letter case, so this does too). */
const OAUTH_PATH = /^\/(register|token|authorize|revoke)(\/|$)/i;
/** An Origin header naming this computer: http(s) on localhost, 127.0.0.1 or [::1] (any port). */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch { return false; }
}

/**
 * Limiter key on this computer's address for the endpoints a tool signs in and refreshes with: the hash of the refresh token or
 * code it presents (else its client_id), not the one shared 127.0.0.1 key, so one tool (or a program hammering) cannot starve the others.
 * Through the door, and with no client_id, the usual key.
 */
function perClientKey(local: boolean): (req: express.Request) => string {
  return (req) => {
    if (!local || viaDoor(req)) return rateLimitKey(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    // What the caller presents (a refresh token, a code, a token to revoke): its hash, so each login or refresh of each tool has
    // its own count; then the client_id; then the usual key.
    const secret = [body.refresh_token, body.code, body.token].find((v): v is string => typeof v === 'string' && v !== '');
    if (secret) return `secret:${createHash('sha256').update(secret).digest('hex').slice(0, 32)}`;
    const id = typeof body.client_id === 'string' ? body.client_id : typeof req.query.client_id === 'string' ? req.query.client_id : '';
    return id ? `client:${id.slice(0, 300)}` : rateLimitKey(req);
  };
}

const methodNotAllowed: RequestHandler = (_req, res) => {
  res.set('Allow', 'POST').status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
};

const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  if (req.path === '/mcp') {
    res.status(status).json({ jsonrpc: '2.0', error: { code: status === 500 ? -32603 : -32700, message: status === 500 ? 'Internal error' : 'Bad request' }, id: null });
    return;
  }
  const title = status === 500 ? t('common.serverError') : t('common.badRequest');
  // A failed send (not a page view): say that nothing was saved, and give the way back to the text (app.js wires data-go-back).
  const lost = status === 500 && !SAFE_METHODS.has(req.method);
  res.status(status).type('html').send(page(title, lost
    ? html`<h1>${title}</h1><p>${t('common.serverErrorPost')}</p><p><a href="#" class="quiet-btn" data-go-back>${t('common.goBack')}</a></p>`
    : html`<h1>${title}</h1>`, { tab: null }));
};

/**
 * The page editor posts up to MAX_BODY characters, URL-encoded: one accented letter takes 6 bytes, any other non-ASCII
 * character up to 9, so the default 100 KB refused pages far under the limit. Only a signed-in owner gets the room.
 */
const PAGE_FORM_LIMIT = MAX_BODY * 9 + 64 * 1024;
/** A skill's form also carries its files (§17c): up to 256 KB more, URL-encoded the same way. */
const SKILL_FORM_LIMIT = (MAX_BODY + MAX_SKILL_BYTES + MAX_SKILL_DESCRIPTION) * 9 + 64 * 1024;

/** Past even that, the text is over MAX_BODY for sure: say so plainly instead of the bare "Bad request". */
const pageFormTooLarge: ErrorRequestHandler = (err, _req, res, next) => {
  if (err?.type !== 'entity.too.large' || res.headersSent) return next(err);
  res.status(413).type('html').send(page(t('common.tooLong'), html`<h1>${t('common.tooLong')}</h1>
<p>${t('common.tooLongBody', { max: fmt.number(MAX_BODY) })}</p>
<p><a href="#" class="quiet-btn" data-go-back>${t('common.goBack')}</a></p>`, { nav: true, tab: null }));
};

/** True when the request carries an Origin whose host is not the one it was sent to. */
function crossSiteOrigin(req: express.Request): boolean {
  const o = req.headers.origin;
  if (o === undefined) return false;
  try { return new URL(o).host !== req.headers.host; } catch { return true; }
}

const MAX_LOG_CHARS = 2000;
/** Rejected registrations logged per minute: enough to diagnose a failed hookup, too few to fill the disk. */
const LOG_BUDGET_PER_MINUTE = 10;

/**
 * Logs why a client registration was refused, with the redirect URIs it asked for, so a failed hookup (Grok, ChatGPT)
 * can be diagnosed from `docker compose logs` even when the client only shows the error code. JSON keeps it one line.
 * Rate-limited requests (429) are never logged, and at most LOG_BUDGET_PER_MINUTE lines are written a minute, so an
 * anonymous client looping on /register cannot grow the logs.
 */
function logRejectedRegistration(now: Clock, refused: RefusedRedirects, allowlist: RedirectAllowlist): express.RequestHandler {
  let windowStart = 0;
  let logged = 0;
  return (req, res, next) => {
    if (req.method !== 'POST') return next();
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429) {
        const asked0 = (req.body ?? {}) as Record<string, unknown>;
        // Every refusal goes on the setup pages' short list (bounded), even when the log budget is spent.
        // A browser page on another site (cross-site Origin) cannot plant an entry; apps register without an Origin.
        if (!crossSiteOrigin(req)) refused.record(asked0.client_name, asked0.redirect_uris, (u) => allowlist.isAllowed(u));
        const t = now().getTime();
        if (t - windowStart >= 60_000) { windowStart = t; logged = 0; }
        logged++;
        if (logged <= LOG_BUDGET_PER_MINUTE) {
          const asked = (req.body ?? {}) as Record<string, unknown>;
          const err = (body ?? {}) as Record<string, unknown>;
          const detail = JSON.stringify({
            status: res.statusCode, error: err.error, error_description: err.error_description,
            client_name: asked.client_name, redirect_uris: asked.redirect_uris,
          });
          console.warn(`Client registration rejected: ${detail.slice(0, MAX_LOG_CHARS)}`);
        } else if (logged === LOG_BUDGET_PER_MINUTE + 1) {
          console.warn('More rejected client registrations this minute are not logged.');
        }
      }
      return json(body);
    };
    next();
  };
}

/** The access level for a token's grant. Fails closed: a token with no grant id gets discussions only. */
export function accessOfToken(provider: Pick<MemoryOAuthProvider, 'grantAccess'>, extra: Record<string, unknown> | undefined): Access {
  const grantId = extra?.grantId;
  return typeof grantId === 'string' ? provider.grantAccess(grantId) : 'discussions';
}

export function createApp(d: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // The desktop app: its public address (D4), only in use with a password and an authenticator.
  if (d.localMode && d.statusDir && !d.backupCopy) d.backupCopy = new BackupCopy(d.statusDir);
  if (d.localMode && !d.reach) d.reach = new Reach(d.statusDir, () => d.owner.isConfigured());
  const reachUrl = () => d.reach?.url() ?? null;
  // Links in stored text to the brain's own addresses count as the app (markdown.ts drops the ones that act on it).
  setOwnOrigins(() => [d.publicUrl.origin, ...(reachUrl() ? [reachUrl()!.origin] : [])]);
  d.provider.setExtraResource(() => { const r = reachUrl(); return r ? new URL('/mcp', r) : null; });
  if (d.localMode && !d.door) d.door = new PublicDoor(app);
  // Reach turned off (or forgotten): the public door shuts at once.
  d.reach?.onChange((url) => { if (!url) d.door?.close(); });
  if (d.localMode) {
    // The desktop app: the localhost listener answers only to localhost (D1). The public door is the internet,
    // whatever Host it names: nothing there while Reach is not in use, and never the app window's endpoints (D4).
    const localOnly = hostGuard(d.publicUrl, CLIENT_ENDPOINTS);
    app.use((req, res, next) => {
      if (!viaDoor(req)) return localOnly(req, res, next);
      if (!reachUrl()) return res.status(421).type('text/plain').send('BrainAI is not reachable from the internet right now.');
      if (isAppPath(req.path)) return res.status(404).type('text/plain').send('Not found');
      next();
    });
    // The sign-in endpoints answer any web page (the SDK sends Access-Control-Allow-Origin: *), and a page can reach localhost.
    // Programs (Claude Code, Codex...) send no Origin; a browser always does on a cross-site fetch or form post. So on this
    // address one with an Origin that is not this computer's is refused here, before any limiter counts it: a page cannot
    // register clients, use up the limits or starve the tools' refreshes (security review 2026-11-23, finding 3).
    app.use((req, res, next) => {
      if (viaDoor(req) || !OAUTH_PATH.test(req.path)) return next();
      const origin = req.get('origin');
      // A browser also says what it is doing: a cross-site request that is not a page navigation is a page's script or form.
      const crossScript = req.get('sec-fetch-site') === 'cross-site' && req.get('sec-fetch-mode') !== 'navigate';
      if (!crossScript && (origin === undefined || isLoopbackOrigin(origin))) return next();
      res.status(403).json({ error: 'access_denied', error_description: 'Web pages cannot use the sign-in endpoints of the BrainAI app.' });
    });
  }
  app.set(TRUST_CF_SETTING, d.trustCfConnectingIp ?? true);
  app.set(DOOR_VIA_SETTING, () => (d.reach?.saved() ? d.reach.via() : null));
  setSideStatus(createSideStatus(d));
  setViewClock(d.now);
  setPausedBanner(() => d.service.savesPausedSince());
  setMovedBanner(() => (d.localMode && d.statusDir ? movedTo(d.statusDir) : null));
  setConsentPoller(d.localMode === true);
  setServerMode(d.localMode !== true);
  setComputer(d.tools?.platform ?? process.platform);
  // The palette's "Go to" rows beyond the sidebar's places: only the pages this mode has.
  {
    const app = d.localMode === true;
    const files = !!d.db && !!d.statusDir;
    // A function, so each row's label is worked out in the request's language when the page renders (keys, never text).
    setGoTo(() => [
      { key: 'shell.goto.skills', href: '/skills' }, { key: 'shell.goto.import', href: '/import', alias: 'Bring in memory' }, ...(coachingShown() ? [{ key: 'shell.goto.map' as const, href: '/map', alias: 'Map' }] : []), { key: 'shell.goto.discussions', href: '/discussions' },
      { key: 'shell.goto.disagree', href: '/disagreements', alias: 'disagreements' }, { key: 'shell.goto.tidy', href: '/facts/tidy' },
      ...(app && d.tools ? [{ key: 'shell.goto.tools' as const, params: { computer: computerName() }, href: '/settings/tools' }] : []),
      ...(app ? [{ key: 'shell.goto.reach' as const, href: '/settings/reach', alias: 'Reach' }] : []),
      ...(app && d.models ? [{ key: 'shell.goto.search' as const, href: '/settings#search' }] : []),
      { key: 'lang.goto', href: '/settings#language', alias: 'Language Idioma' },
      { key: 'theme.goto', href: '/settings#appearance', alias: 'Appearance Apariencia Theme Dark mode Light Tema Modo oscuro claro Notification Notificación' },
      { key: 'coaching.goto', href: '/settings#coaching', alias: 'Developer coaching Aprendizaje' },
      { key: 'shell.goto.backups', href: '/settings#health' },
      { key: 'shell.goto.version', href: '/settings#version', alias: 'Check for updates' },
      ...(files ? [{ key: 'shell.goto.save' as const, href: '/settings/save' }] : []),
      ...(app && files ? [{ key: 'shell.goto.move' as const, href: '/settings/move' }, { key: 'shell.goto.remove' as const, href: '/settings/remove' }] : []),
    ]);
  }
  const mcpUrl = new URL('/mcp', d.publicUrl);

  // 1. Security headers.
  app.use(securityHeaders);
  app.use((req, _res, next) => runWithDoorFlag(viaDoor(req), next));
  app.use(themeMiddleware());
  app.use(localeMiddleware((name) => d.store.switchValue(name), { localMode: d.localMode === true, systemLocale: () => process.env.BRAINAI_SYSTEM_LOCALE }));
  // Local mode: the desktop shell reads the choice at start, so write it once now (a change in Settings rewrites it).
  if (d.localMode && d.statusDir) {
    try { writeUiLanguageFile(d.statusDir, storedChoice(d.store.switchValue(UI_LANGUAGE_SWITCH)), d.now()); } catch (e) { console.error('writing ui-language.json failed:', e); }
  }
  app.use(markUnrepeatable);

  // 2. Our authorization server metadata (adds CIMD support); registered first so it wins over the SDK's.
  // Callbacks carry RFC 9207 `iss`, but authorization_response_iss_parameter_supported is not advertised: Grok Build
  // (rmcp) then requires `iss` on every callback and its sign-in failed.
  // CIMD (client_id_metadata_document_supported) makes Claude Code and Codex name themselves with documents on
  // claude.ai / chatgpt.com, which this server must fetch: sign-in then needs internet (offline or behind a proxy it
  // fails with "Invalid client_id"). On the desktop app's own localhost address it is not advertised, so those tools
  // register dynamically (POST /register), which needs nothing outside this computer. The public address and a
  // server keep it. Clients already signed in with a CIMD id are unaffected: getClient still resolves them.
  const metadataFor = (origin: URL, cimd: boolean) => ({
    ...createOAuthMetadata({ provider: d.provider, issuerUrl: origin, scopesSupported: SCOPES }),
    ...(cimd ? { client_id_metadata_document_supported: true } : {}),
  });
  const metadata = metadataFor(d.publicUrl, d.localMode !== true);
  // The address a request came in at: the public one for everything through the public door (D4), never by Host.
  const onPublic = (req: express.Request) => viaDoor(req) && reachUrl() !== null;
  app.get(['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp'], (req, res) => {
    res.set('Access-Control-Allow-Origin', '*').json(onPublic(req) ? metadataFor(reachUrl()!, true) : metadata);
  });

  // 3. OAuth endpoints, each with its own per-IP rate limit; registration (it adds rows) gets a stricter one.
  const rateLimit = { windowMs: 15 * 60_000, limit: 100, keyGenerator: perClientKey(d.localMode === true) };
  const registrationRateLimit = { windowMs: 60 * 60_000, limit: 20, keyGenerator: rateLimitKey };
  // Parsed here with a small limit (oversize → 413); the SDK's own JSON parser then skips the parsed body.
  const refused = new RefusedRedirects(d.now);
  app.use('/register', (req, _res, next) => (d.localMode && !viaDoor(req) ? exemptFromDailyCap(next) : next()), express.json({ limit: '8kb' }), logRejectedRegistration(d.now, refused, d.allowlist));
  // One auth router and one token check per address: each answers with its own issuer and resource, and a token
  // is accepted only at the address it was issued for.
  const authFor = (origin: URL, verifier: Pick<typeof d.provider, 'verifyAccessToken'> = d.provider) => {
    const resource = new URL('/mcp', origin);
    // An app that names no resource gets this address's (the provider alone would give it localhost's).
    const provider = new Proxy(d.provider, {
      get(target, key) {
        // A refresh is bound to the address it arrives at: a token made for another address (the usual one, seen on a temporary
        // port through a relay) is refused, and an app that names no resource gets this address's.
        if (key === 'exchangeRefreshToken') {
          return (client: Parameters<MemoryOAuthProvider['exchangeRefreshToken']>[0], token: string, scopes?: string[], res?: URL) =>
            target.exchangeRefreshToken(client, token, scopes, res ?? resource);
        }
        if (key === 'authorize') {
          return (client: Parameters<MemoryOAuthProvider['authorize']>[0], params: Parameters<MemoryOAuthProvider['authorize']>[1], res: Parameters<MemoryOAuthProvider['authorize']>[2]) =>
            target.authorize(client, { ...params, resource: params.resource ?? resource }, res);
        }
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    return {
      router: mcpAuthRouter({
        provider,
        issuerUrl: origin,
        resourceServerUrl: resource,
        scopesSupported: SCOPES,
        resourceName: 'BrainAI',
        authorizationOptions: { rateLimit },
        tokenOptions: { rateLimit },
        // Secrets never expire: the SDK default (30 days) would silently disconnect confidential clients.
        clientRegistrationOptions: { rateLimit: registrationRateLimit, clientSecretExpirySeconds: 0 },
        revocationOptions: { rateLimit },
      }),
      bearer: requireBearerAuth({ verifier, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource), expectedResource: resource }),
    };
  };
  // On this computer only (never through the public door): while the app runs on a temporary port, a key made at the usual
  // address (Claude desktop's) is accepted too, as a key for this one. Read from brainai.json, kept for a few seconds.
  let homeAt = 0;
  let homeUrl: string | null = null;
  const usualResource = (): string | null => {
    if (!d.localMode || !d.statusDir) return null;
    if (Date.now() - homeAt > 3_000) {
      homeAt = Date.now();
      const home = temporaryHomePort(join(dirname(d.statusDir), 'brainai.json'), Number(d.publicUrl.port));
      if (home === null) homeUrl = null;
      else { const u = new URL('/mcp', d.publicUrl); u.port = String(home); homeUrl = u.href; }
    }
    return homeUrl;
  };
  const localVerifier = {
    verifyAccessToken: async (token: string) => {
      const info = await d.provider.verifyAccessToken(token);
      const home = usualResource();
      // Only the Claude bridge's own key (a local grant: no redirect URIs, proves this server per socket before it sends it).
      // A tool's token made for the usual address can reach a temporary port only through something relaying for it.
      const grant = info.extra?.grantId;
      return home && info.resource?.href === home && typeof grant === 'string' && d.provider.isLocalGrant(grant) ? { ...info, resource: new URL('/mcp', d.publicUrl) } : info;
    },
  };
  const localAuth = authFor(d.publicUrl, localVerifier);
  // The public address's pieces are built when the address is saved (at start, or when Reach is switched on), never
  // while answering a request.
  let publicAuth: { href: string; auth: ReturnType<typeof authFor> } | null = null;
  const buildPublic = (url: URL | null) => { publicAuth = url ? { href: url.href, auth: authFor(url) } : null; };
  buildPublic(d.reach?.saved() ?? null);
  d.reach?.onChange(buildPublic);
  const pick = (req: express.Request) => (onPublic(req) && publicAuth ? publicAuth.auth : localAuth);
  app.use((req, res, next) => pick(req).router(req, res, next));

  // 4. The MCP endpoint: stateless, one server and transport per request, attributed to the token's client.
  const bearer: RequestHandler = (req, res, next) => pick(req).bearer(req, res, next);
  // Room for a discussion's attachments (up to 1 MB of files, JSON-escaped); the token is checked before parsing.
  // A brain moved to a server (D5): assistants still pointed here are told where it lives now.
  if (d.localMode && d.statusDir) {
    const dir = d.statusDir;
    app.use('/mcp', (_req, res, next) => {
      const to = movedTo(dir);
      if (!to) return next();
      res.status(410).json({ jsonrpc: '2.0', error: { code: -32000, message: `This brain moved to ${to.origin}. Connect this app there (its Settings has each app's page).` }, id: null });
    });
  }
  app.route('/mcp')
    .post(bearer, express.json({ limit: '3mb' }), async (req, res) => {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      // The grant alone decides the access level (connection names are not unique).
      const access = accessOfToken(d.provider, req.auth!.extra);
      // Saves are signed with the connection's own name (two installs of one app share a client).
      const grantId = req.auth!.extra?.grantId;
      const server = mcpServerFor(d, {
        actorName: typeof grantId === 'string' ? d.provider.grantName(grantId) : d.clients.clientName(req.auth!.clientId),
        access,
        clientId: req.auth!.clientId,
        grantId: typeof grantId === 'string' ? grantId : undefined,
        // Read at every request, so a change in Settings › Connections applies to the very next call.
        projects: access === 'projects' ? d.provider.grantProjects(req.auth!.extra!.grantId as string) : undefined,
        onSetup: typeof grantId === 'string' ? (n) => d.provider.setGrantSetup(grantId, n) : undefined,
      });
      // Guided setup (§17b): what this connection now holds as its tool list, so Settings can tell when it is stale.
      const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
      if (typeof grantId === 'string' && messages.some((m) => (m as { method?: unknown } | null)?.method === 'tools/list')) {
        // A note for Settings: losing it (a busy database) must never fail the assistant's request.
        try { d.provider.recordTools(grantId, servedToolNames(server)); } catch (e) { console.error('recording the tool list failed:', e); }
      }
      // An assistant's save may hold a suggestion or flag a disagreement: the sidebar's number follows.
      res.on('finish', invalidateSideStatus);
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    })
    .get(methodNotAllowed)
    .delete(methodNotAllowed);

  // 6. Origin check, placed before the browser routes it protects (it has to run before them to have any effect).
  app.use(sameOrigin((req) => (onPublic(req) ? reachUrl()! : d.publicUrl)));
  // The desktop app's local mode: no automatic sign-in. A session comes from the app window's ticket, or from the
  // password once one exists. The browser guard stays: another site cannot use the local server.
  if (d.localMode) app.use(fetchMetadataGuard(CLIENT_ENDPOINTS));

  // 5. Login, logout and consent.
  const pageForms = express.urlencoded({ extended: false, limit: PAGE_FORM_LIMIT });
  const ownersPageForms: RequestHandler = (req, res, next) => (d.sessions.isValid(readCookie(req, SESSION_COOKIE)) ? pageForms(req, res, next) : next());
  app.use('/pages', ownersPageForms, pageFormTooLarge);
  const skillForms = express.urlencoded({ extended: false, limit: SKILL_FORM_LIMIT });
  const ownersSkillForms: RequestHandler = (req, res, next) => (d.sessions.isValid(readCookie(req, SESSION_COOKIE)) ? skillForms(req, res, next) : next());
  app.use('/skills', ownersSkillForms, pageFormTooLarge);
  const importForms = express.urlencoded({ extended: false, limit: IMPORT_FORM_LIMIT, parameterLimit: IMPORT_FORM_PARAMETERS });
  const ownersImportForms: RequestHandler = (req, res, next) => (d.sessions.isValid(readCookie(req, SESSION_COOKIE)) ? importForms(req, res, next) : next());
  app.use('/import', ownersImportForms, importFormTooLarge(d));
  app.use(express.urlencoded({ extended: false }));
  // What the removal itself and the app's own window still call (the app's ticket for its window, its cancel).
  const REMOVAL_FLOW = new Set(['/settings/remove', '/settings/remove/show', '/app/removed/cancel', '/app/ticket']);
  app.use(authRoutes(d));
  // A desktop removal in progress: nothing is saved from here on (the copy is already taken or being taken), except the
  // removal's own steps and the app's own calls. Reads keep working.
  app.use((req, res, next) => {
    if (!isRemoving() || ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || REMOVAL_FLOW.has(req.path)) return next();
    res.status(503).type('html').send(page(t('data.removing.title'), html`<div class="narrow"><h1>${t('data.removing.title')}</h1><p>${t('data.removing.text')}</p></div>`, { tab: null, plain: true }));
  });

  // 7. Static assets.
  // Public on purpose (before the owner guard): the manifest, icons and service worker must load without a session or install fails.
  // Versioned vendor folders (mermaid-12.3.0, dompurify-3.4.17): the version in the name makes a year-long cache
  // safe, and these are public open-source files. Everything else in /static keeps express.static's default.
  app.use('/static/vendor', express.static(join(STATIC_DIR, 'vendor'), { index: false, immutable: true, maxAge: '365d' }));
  app.use('/static', express.static(STATIC_DIR, { index: false }));
  app.get('/favicon.ico', (_req, res) => res.redirect(302, '/static/icon.svg'));
  app.get('/sw.js', (_req, res) => {
    res.set('Cache-Control', 'no-cache').type('text/javascript').send(SERVICE_WORKER);
  });

  // 8. The dashboard; every route in it is guarded by requireOwner.
  // Any owner answer changes what the Inbox holds: the sidebar's number is worked out again for the next page.
  app.use((req, res, next) => { if (req.method === 'POST') res.on('finish', invalidateSideStatus); next(); });
  app.use(projectRoutes(d));
  app.use(mapRoutes(d));
  app.use(reviewRoutes(d));
  app.use(activityRoutes(d));
  app.use(deviceRoutes(d));
  app.use(searchRoutes(d));
  app.use(importRoutes(d));
  app.use(guidedImportRoutes(d));
  app.use(imageRoutes(d));
  app.use(diagramRoutes(d));
  app.use(pictureReviewRoutes(d));
  app.use(setupRoutes(d, refused));
  app.use(desktopRoutes(d));
  app.use(weekNoteRoutes(d));
  app.use(reachRoutes(d));
  app.use(moveRoutes(d));
  app.use(savedRoutes(d));
  app.use(removeRoutes(d));
  app.use(skillRoutes(d));
  app.use(tidyProposalRoutes(d));
  // Before the pages: /pages/:id would otherwise catch the picker's own address.
  app.use(linkRoutes(d));
  app.use(pageRoutes(d));
  app.use(growthRoutes(d));
  app.use(graphRoutes(d));
  app.use(dashboardRoutes(d));
  app.use(discussionRoutes(d));

  app.use((_req, res) => {
    res.status(404).type('html').send(page(t('common.notFound'), html`<h1>${t('common.notFound')}</h1>`, { tab: null }));
  });
  app.use(errorHandler);
  return app;
}
