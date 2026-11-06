const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{20,}/, 'API key'],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/, 'GitHub token'],
  [/\bgithub_pat_\w{20,}/, 'GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/, 'JWT'],
];
/** "token: <value>", or "token: Bearer <value>" with an auth scheme word before the value (group 2). */
const CREDENTIAL = /(password|passwd|contraseña|contrasena|api[_-]?key|secret|token)\s*[:=]\s*((?:Bearer|Basic|Token|Digest)\s+)?(\S{6,})/gi;

/** A whole placeholder: <token>, $API_KEY, ${TOKEN}, %DB_PASSWORD%, [redacted], {{ secrets.X }}. Only the whole shape counts. */
const PLACEHOLDER = /^(<[A-Za-z_-]+>|\$[A-Z_][A-Z0-9_]*|\$\{[A-Za-z_][\w.]*\}|%[A-Za-z_]+%|\[[A-Za-z _-]+\]|\{\{[^{}]*\}\})$/;
/** The start of a dotted name that is code, not a passphrase: process.env.X, config.auth.token, req.body.token. */
const CODE_ROOT = /^(process|env|config|settings|secrets|options|opts|req|request|ctx|context|this|self|os|import)\./;
/** An auth scheme word on its own, when what follows it is too short to be a value ("token: Bearer {{ x }}"). */
const AUTH_SCHEME = /^(Bearer|Basic|Token|Digest)$/i;

/** Words that follow "token:" or "secret =" in prose about auth, never a password. */
const PROSE_WORDS = new Set(['disconnect', 'disconnected', 'expired', 'expires', 'rotated', 'revoked', 'refreshed', 'renewed', 'missing',
  'invalid', 'valid', 'required', 'optional', 'none', 'unknown', 'empty', 'unset', 'changed', 'reset', 'removed', 'deleted', 'stored', 'hashed',
  'encrypted', 'redacted', 'hidden', 'needed', 'enabled', 'disabled', 'ignored', 'used', 'unused', 'sent', 'kept', 'lost', 'leaked', 'new', 'old']);

/**
 * A value after "token:" or "secret =" that is not one: a placeholder (<token>, $VAR, {{ }}, [redacted], ****), code
 * (randomBytes(32), z.string(), process.env.X) or a known prose word ending a sentence ("disconnect.").
 */
function notAValue(raw: string): boolean {
  const v = raw.replace(/^["'`]+/, '').replace(/[.,;:!?*`'")]+$/, '');
  return v === '' || /^\*+$/.test(v) || PLACEHOLDER.test(v)
    || /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\(/.test(v)
    || (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(v) && (CODE_ROOT.test(v) || /\.[A-Z][A-Z0-9_]+$/.test(v)))
    // A bare lowercase word passes only when it is one of the words prose uses there ("token = disconnect."): any
    // other lowercase run could be a password, even at the end of a sentence.
    || (PROSE_WORDS.has(v) && /^[a-z]+[.,;:!?]/.test(raw));
}

export interface SecretFound {
  reason: string;
  /** 1-based line of the text the secret is on. */
  line: number;
  /** The start of what matched, cut short so the secret itself is not repeated. */
  excerpt: string;
}

const lineAt = (text: string, index: number): number => text.slice(0, index).split('\n').length;

function find(text: string, credentials: boolean): SecretFound | null {
  for (const [re, reason] of PATTERNS) {
    const m = re.exec(text);
    if (m) return { reason, line: lineAt(text, m.index), excerpt: reason === 'private key' ? m[0] : `${m[0].slice(0, 4)}…` };
  }
  if (!credentials) return null;
  for (const m of text.matchAll(CREDENTIAL)) {
    const value = m[3]!;
    if (notAValue(value) || (m[2] === undefined && AUTH_SCHEME.test(value))) continue;
    return { reason: 'credential assignment', line: lineAt(text, m.index), excerpt: `${m[0].slice(0, m[0].length - value.length)}${value.slice(0, 2)}…` };
  }
  return null;
}

/** What looks like a secret in the text and where, otherwise null. */
export function findSecret(text: string): SecretFound | null {
  return find(text, true);
}

/** Returns a short reason when the text looks like a secret, otherwise null. */
export function looksLikeSecret(text: string): string | null {
  return find(text, true)?.reason ?? null;
}

/** Like looksLikeSecret but ignores "password = value" style assignments, which are normal in code files. */
export function looksLikeKey(text: string): string | null {
  return find(text, false)?.reason ?? null;
}
