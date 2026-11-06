import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ClientsStore } from './auth/clientsStore.js';
import { LoginLimiter } from './auth/loginLimiter.js';
import { OwnerAuth } from './auth/owner.js';
import { MemoryOAuthProvider } from './auth/provider.js';
import { RedirectAllowlist } from './auth/redirects.js';
import { SessionStore } from './auth/sessions.js';
import { scheduleBackups } from './backup.js';
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
import { createLocalEmbedder } from './memory/embedder.js';
import { MemoryService } from './memory/service.js';
import { MemoryStore } from './memory/store.js';
import { ProjectsService } from './projects/service.js';
import { ReviewService } from './review/service.js';
import { ReviewStore } from './review/store.js';
import { ProjectStore } from './projects/store.js';
import { installShutdown } from './shutdown.js';
import { createApp } from './web/app.js';
import { makeTidyItems, tidySummary } from './web/tidyItems.js';
import { GraphService } from './graph/data.js';
import { MeaningIndex, THREAD_FLOOR, THREAD_KINDS } from './graph/threads.js';

const CLEANUP_INTERVAL_MS = 60 * 60_000;

const config = loadConfig(process.env);
mkdirSync(config.dataDir, { recursive: true });
const db = openDb(join(config.dataDir, 'memory.db'));
const embedder = await createLocalEmbedder({ modelDir: config.modelDir, allowRemote: false });

const now = systemClock;
/**
 * How close by meaning another project's decision must be to show as related to a page. Measured on the real model
 * (2026-11-03): a project's own decisions scored 0.89–0.93 against its page, unrelated projects' up to 0.863, so
 * recall's 0.75 floor let them all in.
 */
const RELATED_SIMILARITY = 0.88;
const store = new MemoryStore(db, now);
const service = new MemoryService(store, embedder, {
  duplicateThreshold: config.duplicateThreshold,
  minRecallSimilarity: config.minRecallSimilarity,
  recallConfidentSimilarity: config.recallConfidentSimilarity,
  recallWindow: config.recallWindow,
});
const registry = new ProjectStore(db, now);
const allowlist = new RedirectAllowlist(db);
const clients = new ClientsStore(db, allowlist, now);
const provider = new MemoryOAuthProvider(db, clients, allowlist, now, new URL('/mcp', config.publicUrl));
const discussions = new DiscussionService(new DiscussionStore(db, now), service, () => provider.activeConnections(), now);
const devices = new DeviceService(db, now);
const folders = new FolderService(devices, registry, service, now);
const pages = new PageService(new PageStore(db, now), embedder, service, registry, store, now);
pages.realignAnchors();
// The graph's meaning links: every save updates them right after it commits; the catch-up after listen is the safety net.
const meaning = new MeaningIndex(db, { floor: THREAD_FLOOR, kinds: THREAD_KINDS, now });
service.setMeaningHook(meaning);
pages.setMeaningHook(meaning);
const notes = new NoteService(db, pages, now);
const images = new ImageStore(db, config.dataDir, now);
const diagramChecks = new DiagramChecks(db, now);
const skills = new SkillService(db, now);
const uploadLinks = new UploadLinks(db, now);
pages.setPictureStore(images);
const projects = new ProjectsService(registry, service, store, discussions, pages, folders);
const graph = new GraphService({ db, projects, registry, service, pages, meaning, now });
const growth = new GrowthService(new GrowthStore(db, now), embedder, service, registry, store, { duplicateThreshold: config.duplicateThreshold }, now);
// Work mode has no Growth, so its weekly reviews have no growth part.
const tidyItems = makeTidyItems({ store, service, now });
const reviews = new ReviewService({
  store: new ReviewStore(db), memories: store, service, registry, folders, pages, growth: config.mode === 'work' ? null : growth, grants: () => provider.listGrants(),
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
if (config.backupDir) scheduleBackups(db, config.backupDir, config.backupKeep, now, config.dataDir);

const server = createApp({
  statusDir: config.dataDir,
  publicUrl: config.publicUrl, allowlist, store, service, registry, projects, discussions, growth, reviews, pages, images, diagramChecks, uploadLinks, setupOverlay: loadSetupOverlay(config.overlayDir), skills, skillSync: new SkillSync(db, now, skills), notes, devices, folders, imports: new ImportLog(db, now), relatedSimilarity: RELATED_SIMILARITY, graph, provider, owner, sessions, limiter, clients, now,
  mode: config.mode, trustCfConnectingIp: config.trustCfConnectingIp, askCommands: config.askCommands,
}).listen(config.port, config.host, () => {
  const name = config.mode === 'work' ? 'Work memory' : 'Cairn';
  console.log(`${name} listening on ${config.host}:${config.port}, public URL ${config.publicUrl.origin}`);
  void meaning.catchUp()
    .then((r) => console.log(`meaning index: checked ${r.checked}, indexed ${r.indexed} in ${r.ms} ms`))
    .catch((e) => console.error('meaning index catch-up failed:', e));
});
installShutdown({ server, timer, db });
