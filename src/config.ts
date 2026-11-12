import { nameKey } from './discussions/types.js';
import { profileFor, type EmbeddingProfile } from './memory/embeddingProfile.js';

// The default model's cut-offs (each one's calibration is in src/memory/embeddingProfile.ts). The four recall settings
// can be overridden with DUPLICATE_THRESHOLD, RECALL_WINDOW, MIN_RECALL_SIMILARITY and RECALL_CONFIDENT_SIMILARITY.
const DEFAULT_PROFILE = profileFor(undefined);
export const DEFAULT_DUPLICATE_THRESHOLD = DEFAULT_PROFILE.duplicate;
export const DEFAULT_RECALL_WINDOW = DEFAULT_PROFILE.window;
export const DEFAULT_MIN_RECALL_SIMILARITY = DEFAULT_PROFILE.minRecall;
export const DEFAULT_RECALL_CONFIDENT_SIMILARITY = DEFAULT_PROFILE.confident;

/** 'personal' is the shared memory at home; 'work' is a separate copy on a work laptop (see docs/WORK.md). */
export type Mode = 'personal' | 'work';

export const DEFAULT_BACKUP_KEEP = 14;

export interface Config {
  publicUrl: URL; dataDir: string; modelDir: string; port: number; duplicateThreshold: number;
  /** The owner's own texts and settings (setup.json); a missing folder or file means the defaults. */
  overlayDir: string;
  minRecallSimilarity: number; recallConfidentSimilarity: number; recallWindow: number | undefined;
  /** EMBED_MODEL: the search model and every cut-off tuned for it. */
  embedModel: EmbeddingProfile;
  /** Recall's results reordered by the local reranker (B3); RERANK=off keeps the search's own order. */
  rerank: boolean;
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

/** An empty setting (an uncommented `NAME=` line) counts as not set. */
const given = (raw: string | undefined): string | undefined => (raw === undefined || raw.trim() === '' ? undefined : raw);

function unitInterval(name: string, raw: string | undefined, fallback: number): number {
  const value = given(raw) === undefined ? fallback : Number(raw);
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
  const embedModel = profileFor(env.EMBED_MODEL);
  const duplicateThreshold = unitInterval('DUPLICATE_THRESHOLD', env.DUPLICATE_THRESHOLD, embedModel.duplicate);
  const minRecallSimilarity = unitInterval('MIN_RECALL_SIMILARITY', env.MIN_RECALL_SIMILARITY, embedModel.minRecall);
  const recallConfidentSimilarity = unitInterval('RECALL_CONFIDENT_SIMILARITY', env.RECALL_CONFIDENT_SIMILARITY, embedModel.confident);
  const recallWindow = given(env.RECALL_WINDOW) === undefined ? embedModel.window : Number(env.RECALL_WINDOW);
  if (recallWindow !== undefined && (!Number.isFinite(recallWindow) || recallWindow < 0 || recallWindow >= 1)) throw new Error(`RECALL_WINDOW must be a number in [0, 1), got ${env.RECALL_WINDOW}`);
  if (recallConfidentSimilarity < minRecallSimilarity) {
    // The usual cause: settings tuned for e5 (its scores sit far higher) left in .env after the switch to Gemma.
    const e5Tuned = embedModel.id !== 'e5' && given(env.MIN_RECALL_SIMILARITY) !== undefined && given(env.RECALL_CONFIDENT_SIMILARITY) === undefined;
    throw new Error(e5Tuned
      ? `MIN_RECALL_SIMILARITY (${minRecallSimilarity}) is above the ${embedModel.id} search model's RECALL_CONFIDENT_SIMILARITY (${recallConfidentSimilarity}): it was most likely tuned for e5. Either remove MIN_RECALL_SIMILARITY (and RECALL_WINDOW, RECALL_CONFIDENT_SIMILARITY, DUPLICATE_THRESHOLD) from .env, or set EMBED_MODEL=e5 to keep the old search model.`
      : `RECALL_CONFIDENT_SIMILARITY (${recallConfidentSimilarity}) must not be below MIN_RECALL_SIMILARITY (${minRecallSimilarity})`);
  }
  const rerankSetting = env.RERANK ?? 'on';
  if (rerankSetting !== 'on' && rerankSetting !== 'off') throw new Error(`RERANK must be on or off, got ${env.RERANK}`);
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
    duplicateThreshold, minRecallSimilarity, recallConfidentSimilarity, recallWindow, embedModel, rerank: rerankSetting === 'on',
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
