import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ClientsStore } from '../auth/clientsStore.js';
import type { LoginLimiter } from '../auth/loginLimiter.js';
import type { OwnerAuth } from '../auth/owner.js';
import type { MemoryOAuthProvider } from '../auth/provider.js';
import type { RedirectAllowlist } from '../auth/redirects.js';
import { RefusedRedirects } from '../auth/refusedRedirects.js';
import type { SessionStore } from '../auth/sessions.js';
import type { Clock } from '../clock.js';
import type { Mode } from '../config.js';
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
import type { SkillSync } from '../skills/sync.js';
import type { SetupOverlay } from '../setup/texts.js';
import { MAX_SKILL_BYTES, MAX_SKILL_DESCRIPTION } from '../skills/types.js';
import type { ProjectsService } from '../projects/service.js';
import { projectRoutes } from './projectRoutes.js';
import { reviewRoutes } from './reviewRoutes.js';
import { growthRoutes } from './growthRoutes.js';
import { deviceRoutes } from './deviceRoutes.js';
import { imageRoutes } from './imageRoutes.js';
import { diagramRoutes } from './diagramRoutes.js';
import { pictureReviewRoutes } from './pictureReviewRoutes.js';
import { setupRoutes } from './setupRoutes.js';
import { skillRoutes } from './skillRoutes.js';
import { pageRoutes } from './pageRoutes.js';
import { importRoutes } from './importRoutes.js';
import { searchRoutes } from './searchRoutes.js';
import type { MemoryService } from '../memory/service.js';
import type { MemoryStore } from '../memory/store.js';
import type { ProjectStore } from '../projects/store.js';
import { authRoutes, readCookie, SESSION_COOKIE } from './authRoutes.js';
import { dashboardRoutes } from './dashboardRoutes.js';
import { discussionRoutes } from './discussionRoutes.js';
import { rateLimitKey, TRUST_CF_SETTING } from './clientIp.js';
import { html, page, setPageMode } from './html.js';
import { createSideStatus, setSideStatus } from './sideStatus.js';
import { setViewClock } from './when.js';
import type { GraphService } from '../graph/data.js';
import { graphRoutes } from './graphRoutes.js';

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
  /** Default 'personal'. 'work' renames the dashboard and uses the work instructions. */
  mode?: Mode;
  /** Commands the opener of a discussion runs to ask the other assistants itself (see Config.askCommands). */
  askCommands?: Record<string, string>;
  /** Default true (the Cloudflare tunnel is the only way in). False makes rate limits ignore cf-connecting-ip. */
  trustCfConnectingIp?: boolean;
  /** Where the backup runs record their outcome (the data folder); the home page shows it. None: no backup panel. */
  statusDir?: string;
}

const CSP = "default-src 'self'; frame-ancestors 'none'; form-action 'self' https: http://localhost:* http://127.0.0.1:*";
const SCOPES = ['memory'];
/** Called by OAuth/MCP clients without browser cookies, so they carry no Origin to check. */
const CLIENT_ENDPOINTS = ['/mcp', '/authorize', '/token', '/register', '/revoke', '/api/folder-report', '/api/image-upload', '/api/skills/report', '/api/skills/upload'];
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
function sameOrigin(publicUrl: URL): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (CLIENT_ENDPOINTS.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
    if (req.get('origin') === publicUrl.origin) return next();
    res.status(403).type('html').send(page('Forbidden', html`<h1>Forbidden</h1><p>This form was not sent from this site.</p>`, { tab: null }));
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
  const title = status === 500 ? 'Something went wrong' : 'Bad request';
  res.status(status).type('html').send(page(title, html`<h1>${title}</h1>`, { tab: null }));
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
  res.status(413).type('html').send(page('Too long to save', html`<h1>Too long to save</h1>
<p>This text is longer than a page can be (100,000 characters). Nothing was saved. Go back to get your text, then shorten it or split it into two pages.</p>`, { nav: true, tab: null }));
};

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
        refused.record(asked0.client_name, asked0.redirect_uris, (u) => allowlist.isAllowed(u));
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
  app.set(TRUST_CF_SETTING, d.trustCfConnectingIp ?? true);
  const mode = d.mode ?? 'personal';
  setPageMode(mode);
  setSideStatus(createSideStatus(d));
  setViewClock(d.now);
  const mcpUrl = new URL('/mcp', d.publicUrl);

  // 1. Security headers.
  app.use(securityHeaders);
  app.use(markUnrepeatable);

  // 2. Our authorization server metadata (adds CIMD support); registered first so it wins over the SDK's.
  // Callbacks carry RFC 9207 `iss`, but authorization_response_iss_parameter_supported is not advertised: Grok Build
  // (rmcp) then requires `iss` on every callback and its sign-in failed.
  const metadata = {
    ...createOAuthMetadata({ provider: d.provider, issuerUrl: d.publicUrl, scopesSupported: SCOPES }),
    client_id_metadata_document_supported: true,
  };
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.set('Access-Control-Allow-Origin', '*').json(metadata);
  });

  // 3. OAuth endpoints, each with its own per-IP rate limit; registration (it adds rows) gets a stricter one.
  const rateLimit = { windowMs: 15 * 60_000, limit: 100, keyGenerator: rateLimitKey };
  const registrationRateLimit = { windowMs: 60 * 60_000, limit: 20, keyGenerator: rateLimitKey };
  // Parsed here with a small limit (oversize → 413); the SDK's own JSON parser then skips the parsed body.
  const refused = new RefusedRedirects(d.now);
  app.use('/register', express.json({ limit: '8kb' }), logRejectedRegistration(d.now, refused, d.allowlist));
  app.use(mcpAuthRouter({
    provider: d.provider,
    issuerUrl: d.publicUrl,
    resourceServerUrl: mcpUrl,
    scopesSupported: SCOPES,
    resourceName: mode === 'work' ? 'Work memory' : 'Cairn',
    authorizationOptions: { rateLimit },
    tokenOptions: { rateLimit },
    // Secrets never expire: the SDK default (30 days) would silently disconnect confidential clients.
    clientRegistrationOptions: { rateLimit: registrationRateLimit, clientSecretExpirySeconds: 0 },
    revocationOptions: { rateLimit },
  }));

  // 4. The MCP endpoint: stateless, one server and transport per request, attributed to the token's client.
  const bearer = requireBearerAuth({
    verifier: d.provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
    expectedResource: mcpUrl,
  });
  // Room for a discussion's attachments (up to 1 MB of files, JSON-escaped); the token is checked before parsing.
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
  app.use(sameOrigin(d.publicUrl));

  // 5. Login, logout and consent.
  const pageForms = express.urlencoded({ extended: false, limit: PAGE_FORM_LIMIT });
  const ownersPageForms: RequestHandler = (req, res, next) => (d.sessions.isValid(readCookie(req, SESSION_COOKIE)) ? pageForms(req, res, next) : next());
  app.use('/pages', ownersPageForms, pageFormTooLarge);
  const skillForms = express.urlencoded({ extended: false, limit: SKILL_FORM_LIMIT });
  const ownersSkillForms: RequestHandler = (req, res, next) => (d.sessions.isValid(readCookie(req, SESSION_COOKIE)) ? skillForms(req, res, next) : next());
  app.use('/skills', ownersSkillForms, pageFormTooLarge);
  app.use(express.urlencoded({ extended: false }));
  app.use(authRoutes(d));

  // 7. Static assets.
  // Public on purpose (before the owner guard): the manifest, icons and service worker must load without a session or install fails.
  // Versioned vendor folders (mermaid-12.3.0, dompurify-3.4.17): the version in the name makes a year-long cache
  // safe, and these are public open-source files. Everything else in /static keeps express.static's default.
  app.use('/static/vendor', express.static(join(STATIC_DIR, 'vendor'), { index: false, immutable: true, maxAge: '365d' }));
  app.use('/static', express.static(STATIC_DIR, { index: false }));
  app.get('/sw.js', (_req, res) => {
    res.set('Cache-Control', 'no-cache').type('text/javascript').send(SERVICE_WORKER);
  });

  // 8. The dashboard; every route in it is guarded by requireOwner.
  app.use(projectRoutes(d));
  app.use(reviewRoutes(d));
  app.use(deviceRoutes(d));
  app.use(searchRoutes(d));
  app.use(importRoutes(d));
  app.use(imageRoutes(d));
  app.use(diagramRoutes(d));
  app.use(pictureReviewRoutes(d));
  app.use(setupRoutes(d, refused));
  app.use(skillRoutes(d));
  app.use(pageRoutes(d));
  // Growth is the personal brain's only (spec section 11): the work memory has no Growth list.
  if (mode !== 'work') app.use(growthRoutes(d));
  app.use(graphRoutes(d));
  app.use(dashboardRoutes(d));
  app.use(discussionRoutes(d));

  app.use((_req, res) => {
    res.status(404).type('html').send(page('Not found', html`<h1>Not found</h1>`, { tab: null }));
  });
  app.use(errorHandler);
  return app;
}
