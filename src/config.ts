import { nameKey } from './discussions/types.js';

// Calibrated with multilingual-e5-small q8 (npm run test:model): lowest duplicate pair 0.9377, minus 0.01.
// Known false positive (NAS vs second SSD, 0.9325) is listed in KNOWN_FALSE_POSITIVES in
// src/memory/embedder.model.test.ts. Accepted: a false "similar exists" only costs a retry with allowDuplicate.
export const DEFAULT_DUPLICATE_THRESHOLD = 0.93;

// Recall thresholds, calibrated with multilingual-e5-small q8. e5 query→passage cosines sit high and related and
// unrelated queries overlap (npm run test:model), and on a real brain a question in one language against memories in
// another scores about 0.79 even for the right memory. So the floor is relative:
// - WINDOW (0.015): a vector-only match is returned when it is within this of the query's best match, and
// - MIN (0.75): never below this, so a query unlike everything returns only keyword hits.
//   Tuned on 52 real questions (found first 79% → 85%, in the top 8 94% → 100%) and confirmed on 20 held-out ones.
// - CONFIDENT (0.86, just above the highest unrelated query): only keyword hits and vector matches at or above it
//   are marked recalled, so filler never keeps an outdated memory off the stale list.
// Override with RECALL_WINDOW, MIN_RECALL_SIMILARITY and RECALL_CONFIDENT_SIMILARITY.
export const DEFAULT_RECALL_WINDOW = 0.015;
export const DEFAULT_MIN_RECALL_SIMILARITY = 0.75;
export const DEFAULT_RECALL_CONFIDENT_SIMILARITY = 0.86;

/** 'personal' is the shared memory at home; 'work' is a separate copy on a work laptop (see docs/WORK.md). */
export type Mode = 'personal' | 'work';

export const DEFAULT_BACKUP_KEEP = 14;

export interface Config {
  publicUrl: URL; dataDir: string; modelDir: string; port: number; duplicateThreshold: number;
  /** The owner's own texts and settings (setup.json); a missing folder or file means the defaults. */
  overlayDir: string;
  minRecallSimilarity: number; recallConfidentSimilarity: number; recallWindow: number;
  mode: Mode;
  /** Address to listen on. Work mode defaults to 127.0.0.1 so nothing else on the network can reach it. */
  host: string;
  /** Trust cf-connecting-ip for rate limiting: only safe when the Cloudflare tunnel is the only way in. */
  trustCfConnectingIp: boolean;
  /**
   * The desktop app: this computer only (127.0.0.1, http://localhost:<port>), answering only to localhost, and the
   * owner signed in without a password until one is set (spec 2026-11-06-desktop-app-design).
   */
  localMode: boolean;
  /** The desktop app's key: GET /app/open?key=… opens a session for the app's window (D1). At least 32 characters. */
  appSecret: string | null;
  /** The desktop app: the owner's login-shell PATH, where Connect finds claude, codex and opencode (D3). */
  toolPath: string | null;
  /** When set, a dated copy of the database is written here daily and the newest `backupKeep` are kept. */
  backupDir: string | null;
  backupKeep: number;
  /**
   * How the assistant that opened a discussion can ask the others itself, without the owner relaying: assistant
   * (connection) name → a shell command with {prompt} where the request goes, e.g. `codex exec "{prompt}"`.
   */
  askCommands: Record<string, string>;
}

function flag(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be true or false, got ${raw}`);
}

function unitInterval(name: string, raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error(`${name} must be a number in (0, 1], got ${raw}`);
  return value;
}

const MAX_ASK_COMMAND = 1000;

function askCommands(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('ASK_COMMANDS must be JSON: an object of assistant name to command, for example {"Codex":"codex exec \\"{prompt}\\""}');
  }
  const out: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const [name, command] of Object.entries(parsed)) {
    if (name.trim() === '' || name.length > 100) throw new Error('ASK_COMMANDS: each assistant name must be 1 to 100 characters');
    // Names are matched as discussions match them (nameKey), so each must have a letter or digit and be distinct.
    if (!/[\p{L}\p{N}]/u.test(name)) throw new Error(`ASK_COMMANDS: the name ${name} needs a letter or digit`);
    const key = nameKey(name);
    if (seen.has(key)) throw new Error(`ASK_COMMANDS: ${name} and ${seen.get(key)} name the same assistant`);
    seen.set(key, name);
    if (typeof command !== 'string' || !command.includes('{prompt}') || command.length > MAX_ASK_COMMAND) {
      throw new Error(`ASK_COMMANDS: the command for ${name} must contain {prompt} and be at most ${MAX_ASK_COMMAND} characters`);
    }
    out[name] = command;
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  if (!env.PUBLIC_URL) throw new Error('PUBLIC_URL is required (for example https://memory.example.com)');
  let publicUrl: URL;
  try {
    publicUrl = new URL(env.PUBLIC_URL);
  } catch {
    throw new Error(`PUBLIC_URL is not a valid URL: ${env.PUBLIC_URL}`);
  }
  const isLocalhost = publicUrl.protocol === 'http:' && publicUrl.hostname === 'localhost';
  if (publicUrl.protocol !== 'https:' && !isLocalhost) throw new Error('PUBLIC_URL must use https (only http://localhost is allowed for development)');

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be an integer from 1 to 65535, got ${env.PORT}`);
  const duplicateThreshold = unitInterval('DUPLICATE_THRESHOLD', env.DUPLICATE_THRESHOLD, DEFAULT_DUPLICATE_THRESHOLD);
  const minRecallSimilarity = unitInterval('MIN_RECALL_SIMILARITY', env.MIN_RECALL_SIMILARITY, DEFAULT_MIN_RECALL_SIMILARITY);
  const recallConfidentSimilarity = unitInterval('RECALL_CONFIDENT_SIMILARITY', env.RECALL_CONFIDENT_SIMILARITY, DEFAULT_RECALL_CONFIDENT_SIMILARITY);
  const recallWindow = env.RECALL_WINDOW === undefined ? DEFAULT_RECALL_WINDOW : Number(env.RECALL_WINDOW);
  if (!Number.isFinite(recallWindow) || recallWindow < 0 || recallWindow >= 1) throw new Error(`RECALL_WINDOW must be a number in [0, 1), got ${env.RECALL_WINDOW}`);
  if (recallConfidentSimilarity < minRecallSimilarity) {
    throw new Error(`RECALL_CONFIDENT_SIMILARITY (${recallConfidentSimilarity}) must not be below MIN_RECALL_SIMILARITY (${minRecallSimilarity})`);
  }
  const mode = env.MEMORY_MODE ?? 'personal';
  if (mode !== 'personal' && mode !== 'work') throw new Error(`MEMORY_MODE must be personal or work, got ${env.MEMORY_MODE}`);
  const work = mode === 'work';
  const host = env.HOST ?? '127.0.0.1';
  const trustCfConnectingIp = flag('TRUST_CF_CONNECTING_IP', env.TRUST_CF_CONNECTING_IP, false);
  const localMode = flag('LOCAL_MODE', env.LOCAL_MODE, false);
  if (localMode) {
    // A local install has no password: it must never be reachable from anywhere but this computer.
    if (host !== '127.0.0.1') throw new Error(`LOCAL_MODE listens on 127.0.0.1 only, not HOST=${host}`);
    if (publicUrl.origin !== `http://localhost:${port}`) throw new Error(`LOCAL_MODE needs PUBLIC_URL=http://localhost:${port}, not ${env.PUBLIC_URL}`);
    if (trustCfConnectingIp) throw new Error('LOCAL_MODE never trusts cf-connecting-ip: set TRUST_CF_CONNECTING_IP=false');
  }
  const appSecret = env.APP_SECRET || null;
  if (appSecret !== null && appSecret.length < 32) throw new Error('APP_SECRET must be at least 32 characters');
  const backupKeep = Number(env.BACKUP_KEEP ?? DEFAULT_BACKUP_KEEP);
  if (!Number.isInteger(backupKeep) || backupKeep < 1) throw new Error(`BACKUP_KEEP must be a whole number of at least 1, got ${env.BACKUP_KEEP}`);
  return {
    publicUrl, dataDir: env.DATA_DIR ?? './data', modelDir: env.MODEL_DIR ?? './models', port,
    duplicateThreshold, minRecallSimilarity, recallConfidentSimilarity, recallWindow,
    mode,
    // This machine only, and no proxy header trusted, unless set: the Docker image sets HOST=0.0.0.0, and a deployment
    // behind a Cloudflare Tunnel (whose origin nothing else can reach) sets TRUST_CF_CONNECTING_IP=true.
    overlayDir: env.OVERLAY_DIR ?? 'overlay',
    host,
    trustCfConnectingIp,
    localMode,
    appSecret,
    toolPath: env.TOOL_PATH || null,
    backupDir: env.BACKUP_DIR || null,
    backupKeep,
    askCommands: askCommands(env.ASK_COMMANDS),
  };
}
