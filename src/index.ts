import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClientsStore } from './auth/clientsStore.js';
import { forgetAutoSessions } from './auth/sessionReset.js';
import { LoginLimiter } from './auth/loginLimiter.js';
import { OwnerAuth } from './auth/owner.js';
import { MemoryOAuthProvider } from './auth/provider.js';
import { RedirectAllowlist } from './auth/redirects.js';
import { SessionStore } from './auth/sessions.js';
import { scheduleBackups } from './backup.js';
import { BackupCopy } from './desktop/backupCopy.js';
import { systemClock } from './clock.js';
import { loadConfig } from './config.js';
import { DiscussionService } from './discussions/service.js';
import { GrowthService } from './growth/service.js';
import { GrowthStore } from './growth/store.js';
import { DeviceService } from './folders/devices.js';
import { FolderService } from './folders/match.js';
import { ImportLog } from './pages/importLog.js';
import { NoteService } from './pages/notes.js';
import { ImageStore } from './images/store.js';
import { DiagramChecks } from './pages/diagramChecks.js';
import { UploadLinks } from './images/uploadLinks.js';
import { SkillService } from './skills/service.js';
import { loadSetupOverlay } from './setup/texts.js';
import { SkillSync } from './skills/sync.js';
import { PageService } from './pages/service.js';
import { PageStore } from './pages/store.js';
import { DiscussionStore } from './discussions/store.js';
import { openDb, purgeExpired } from './db.js';
import { applyPendingRestore } from './saved/restore.js';
import { createLocalEmbedder } from './memory/embedder.js';
import { embedPending, ensureEmbeddings, staleOverrides } from './memory/reembed.js';
import { activeCutOffs, memoryCutOffs } from './models/cutOffs.js';
import { ModelManager } from './models/manager.js';
import { SwitchableEmbedder, SwitchableReranker } from './models/switchable.js';
import { LearningService } from './learning/service.js';
import { startReranker } from './memory/reranker.js';
import { MemoryService } from './memory/service.js';
import { MemoryStore } from './memory/store.js';
import { ProjectsService } from './projects/service.js';
import { ReviewService } from './review/service.js';
import { ReviewStore } from './review/store.js';
import { ProjectStore } from './projects/store.js';
import { installShutdown } from './shutdown.js';
import { listenLocal } from './web/listenLocal.js';
import { watchParent } from './watchParent.js';
import { createApp, type AppDeps } from './web/app.js';
import { makeTidyItems, tidySummary } from './web/tidyItems.js';
import { GraphService } from './graph/data.js';
import { MeaningIndex, THREAD_KINDS } from './graph/threads.js';
import { toolEnv } from './web/desktopRoutes.js';
import { cachedAskCommands } from './desktop/askCommands.js';

const CLEANUP_INTERVAL_MS = 60 * 60_000;

const config = loadConfig(process.env);
// Started by the desktop app: stop when the app is gone, however it went, from the very first moment. Before the
// shutdown below exists there is nothing to close, so it simply exits (D2 review).
let stopWhenGone: (() => void) | null = null;
watchParent(process.env, process.stdin, () => (stopWhenGone ? stopWhenGone() : process.exit(0)));
mkdirSync(config.dataDir, { recursive: true });
// A restore the app staged is swapped in while the database is still closed (src/saved/restore.ts); it never throws.
applyPendingRestore(config.dataDir);
const dbPath = join(config.dataDir, 'memory.db');
const db = openDb(dbPath);
// The search model. A server needs it on disk and loads it before it listens (re-embedding everything first if it
// changed). The app (local mode) starts on keywords and its model manager loads, downloads and switches models in the
// background once it listens (src/models/manager.ts), without a restart.
const embedder = new SwitchableEmbedder(db, config.embedModel);
if (!config.localMode) {
  const model = await createLocalEmbedder({ modelDir: config.modelDir, allowRemote: false, model: config.embedModel });
  // A changed search model re-embeds everything once, before anything can read or save (src/memory/reembed.ts).
  const embedded = await ensureEmbeddings(db, dbPath, model, config.embedModel);
  if (embedded.reembedded) for (const line of staleOverrides(process.env, embedded.from)) console.warn(line);
  // Rows saved while the app had no search model (a brain brought over from it) are embedded before serving too.
  await embedPending(db, model, config.embedModel, { log: console.log });
  embedder.use(model, config.embedModel);
}
// No reranker (RERANK=off, or its model missing) keeps the search's own order; in the app the model manager sets it.
const reranker = new SwitchableReranker(config.localMode ? null : (await startReranker(config)) ?? null);

const now = systemClock;
// Every similarity cut-off comes from the profile of the search model in use (src/memory/embeddingProfile.ts), read
// each time: the app can switch models while it runs (src/models/cutOffs.ts).
const cut = activeCutOffs(config, () => embedder.profile());
const store = new MemoryStore(db, now);
const service = new MemoryService(store, embedder, memoryCutOffs(cut, { reranker }));
const registry = new ProjectStore(db, now);
const allowlist = new RedirectAllowlist(db);
const clients = new ClientsStore(db, allowlist, now);
const provider = new MemoryOAuthProvider(db, clients, allowlist, now, new URL('/mcp', config.publicUrl));
const discussions = new DiscussionService(new DiscussionStore(db, now), service, () => provider.activeConnections(), now);
const devices = new DeviceService(db, now);
const folders = new FolderService(devices, registry, service, now);
// The five areas and the owner's handbook (src/learning/); a merged project's rows follow it.
const learning = new LearningService(db, now, folders, { get: (n) => registry.get(n), named: (n) => service.projectNamed(n), list: () => registry.list() });
service.setProjectMoveHook((from, to) => learning.moveProject(from, to));
const pages = new PageService(new PageStore(db, now), embedder, service, registry, store, now, { keywordWeight: () => cut().keywordWeight });
pages.realignAnchors();
// The graph's meaning links: every save updates them right after it commits; the catch-up after listen is the safety net.
const meaning = new MeaningIndex(db, { floor: () => cut().threadFloor, kinds: THREAD_KINDS, now });
service.setMeaningHook(meaning);
pages.setMeaningHook(meaning);
// The app's models: its choice, the downloads, and the switch to them (the graph catches up after each switch).
const models = config.localMode
  ? new ModelManager({
    dataDir: config.dataDir, modelsDir: config.modelDir, embedder, reranker, db, dbPath, rerank: config.rerank,
    onSwitched: () => meaning.catchUp(),
  })
  : undefined;
const notes = new NoteService(db, pages, now);
const images = new ImageStore(db, config.dataDir, now);
const diagramChecks = new DiagramChecks(db, now);
const skills = new SkillService(db, now);
const uploadLinks = new UploadLinks(db, now);
pages.setPictureStore(images);
const projects = new ProjectsService(registry, service, store, discussions, pages, folders, learning);
const graph = new GraphService({ db, projects, registry, service, pages, meaning, now });
const growth = new GrowthService(new GrowthStore(db, now), embedder, service, registry, store, { get duplicateThreshold() { return cut().duplicate; } }, now);
const tidyItems = makeTidyItems({ store, service, now, get sameProjectFloor() { return cut().sameProject; } });
const reviews = new ReviewService({
  store: new ReviewStore(db), memories: store, service, registry, folders, pages, growth, grants: () => provider.listGrants(),
  tidy: () => tidySummary(tidyItems()),
}, now);
const owner = new OwnerAuth(db, now);
const sessions = new SessionStore(db, now);
const limiter = new LoginLimiter();

const cleanup = () => {
  try {
    purgeExpired(db, now());
  } catch (e) {
    console.error('Cleanup of expired rows failed:', e);
  }
};
cleanup();
const timer = setInterval(cleanup, CLEANUP_INTERVAL_MS).unref();
if (config.backupDir) scheduleBackups(db, config.backupDir, config.backupKeep, now, config.dataDir, config.localMode ? new BackupCopy(config.dataDir) : undefined);

const deps: AppDeps = {
  statusDir: config.dataDir, backupKeep: config.backupKeep, backupDir: config.backupDir, db,
  publicUrl: config.publicUrl, allowlist, store, service, registry, projects, discussions, growth, reviews, pages, images, diagramChecks, uploadLinks, setupOverlay: loadSetupOverlay(config.overlayDir), skills, skillSync: new SkillSync(db, now, skills), notes, devices, folders, imports: new ImportLog(db, now), learning, graph, provider, owner, sessions, limiter, clients, now,
  trustCfConnectingIp: config.trustCfConnectingIp, askCommands: () => config.askCommands, localMode: config.localMode, appSecret: config.appSecret,
  tools: config.localMode ? { home: homedir(), path: config.toolPath ?? `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homedir()}/.local/bin` } : undefined,
  // Read at each use: the search model in use decides them.
  get relatedSimilarity() { return cut().related; },
  get sameProjectFloor() { return cut().sameProject; },
  models,
};
// In the app, with ASK_COMMANDS unset, Claude Code and Codex ask each other when they are connected (looked at once a minute).
if (config.localMode && deps.tools && (process.env.ASK_COMMANDS ?? '').trim() === '') {
  const env = toolEnv(deps);
  if (env) {
    const reader = cachedAskCommands(env);
    deps.askCommands = reader;
    deps.refreshAskCommands = reader.refresh;
    void reader.refresh(); // primed at startup, so the first session already has its commands
  }
}
const app = createApp(deps);
// The Cloudflare tunnel process (Reach, D5) stops with the server; a saved Reach comes back at the next start.
process.once('exit', () => deps.reach?.shutdown());
const listening = (where: string) => {
  console.log(`BrainAI listening on ${where}, public URL ${config.publicUrl.origin}`);
  void meaning.catchUp()
    .then((r) => console.log(`meaning index: checked ${r.checked}, indexed ${r.indexed} in ${r.ms} ms`))
    .catch((e) => console.error('meaning index catch-up failed:', e));
  // Never before listening: a download or a re-read runs while the server answers (by keywords meanwhile). A failure is
  // logged by the manager and shown in its status; the server goes on by keywords.
  void models?.start().catch(() => {});
};
if (config.localMode) {
  // Sessions the old automatic sign-in made are forgotten once, before anything listens.
  forgetAutoSessions(db, config.dataDir);
  // The desktop app holds both loopback addresses, so no other account can take ::1 (D1 review).
  const [server, ...also] = await listenLocal(app, config.port);
  listening(`127.0.0.1 and ::1, port ${config.port}`);
  installShutdown({ server: server!, also, timer, db });
  stopWhenGone = () => process.kill(process.pid, 'SIGTERM');
} else {
  const server = app.listen(config.port, config.host, () => listening(`${config.host}:${config.port}`));
  installShutdown({ server, timer, db });
}
