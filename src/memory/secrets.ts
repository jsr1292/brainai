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
const CREDENTIAL = /(password|passphrase|passwd|contraseña|contrasena|api[_-]?key|secret|token)["']?\s*[:=]\s*((?:Bearer|Basic|Token|Digest)\s+)?(\S{6,})/gi;

/**
 * A label and then a long bare string: "Weather service API key is 7f3a9c2e41b84d06a5e1c9f27d3b6a80", "clave: Zk3…". The
 * label (key, token, secret, password, api key, clave, contraseña, ...) must come within 30 characters before the value.
 */
const LABEL = '(?:api[ _-]?key|access[ _-]?key|secret[ _-]?key|private[ _-]?key|keys?|tokens?|secrets?|passwords?|passwd|passphrase|claves?|contrasenas?|contraseñas?|secretos?)';
// The gap may not hold another label, so the label nearest the value is the one that counts ("public anon key fine, service key is X").
const LABELLED_BARE = new RegExp(`(?<![A-Za-z0-9])(${LABEL})(?![A-Za-z0-9])((?:(?!(?<![A-Za-z0-9])${LABEL}(?![A-Za-z0-9]))[^\\n.]){0,30}?)(?<![A-Za-z0-9+/_=-])([A-Za-z0-9+/_-]{24,}={0,2})(?![A-Za-z0-9+/_=-])`, 'gi');
/** Words between the label and the value that say it is an id, hash or the like, not a secret. */
const NOT_SECRET_WORDS = /\b(commits?|sha\d*|hash(es)?|checksums?|digests?|uuids?|guids?|ids?|fact|page|project|image|picture|build|etag|version)\b/i;
/** Kinds of key that are public or only identify something: SSH and minisign public keys, GPG fingerprints. Checked in the words around the label too. */
const PUBLIC_KEY_WORDS = /\b(public|pub|fingerprints?|ssh-\w+|ecdsa|minisign|gpg|pgp)\b/i;
/** A pure-hex value only counts right after the label: "key is 7f3a...", "token: 7f3a..." (a hash in a sentence is not a secret). */
const BARE_SEPARATOR = /^\s*(?:\([^)\n]{1,30}\)\s*|(?:api\s+)?(?:de|del|of|for|para)\s+(?:la\s+|el\s+|the\s+)?[\w-]{1,20}\s*)?(is|es|=|:)?\s*["'`]?$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a long string looks randomly generated (hex, or base64 / url-safe mixing cases and digits), not a slug or a word. */
function randomLooking(v: string): boolean {
  if (UUID.test(v) || !/\d/.test(v) || !/[A-Za-z]/.test(v)) return false;
  if (/^[0-9a-f]+$/i.test(v)) return v.length >= 24;
  return /[a-z]/.test(v) && /[A-Z]/.test(v);
}

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
  for (const m of text.matchAll(LABELLED_BARE)) {
    const label = m[1]!;
    const gap = m[2]!;
    const value = m[3]!;
    const valueStart = m.index + m[0].length - value.length;
    // Inside a link to a fact or page ([[fact:…]]) or a URL path it is an address, not a value.
    const before = text.slice(Math.max(0, valueStart - 8), valueStart);
    // A public key only when the label is "key" and the word sits in the gap or just before it ("SSH public key AAAA...").
    const near = text.slice(Math.max(0, m.index - 12), m.index) + gap;
    const publicKey = /^keys?$/i.test(label) && PUBLIC_KEY_WORDS.test(near) && !/secret|private|passphrase|password|contrase/i.test(near);
    if (NOT_SECRET_WORDS.test(gap) || publicKey || (/^[0-9a-f]+$/i.test(value) && !BARE_SEPARATOR.test(gap)) || /\[\[[^\]]*$/.test(text.slice(0, valueStart)) || /[/]$/.test(before)) continue;
    if (!randomLooking(value)) continue;
    return { reason: 'labelled key', line: lineAt(text, m.index), excerpt: `${m[0].slice(0, m[0].length - value.length)}${value.slice(0, 2)}…` };
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
