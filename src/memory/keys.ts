/*
 * B9: search words (keys) on a fact. The saving assistant adds the words someone might search for that the text does
 * not say (other names, the other language, an event's date). Recall matches them by meaning (they are embedded with
 * the content) and by keyword (they sit in the FTS tags column); nobody reads them in results.
 */
import { looksLikeSecret } from './secrets.js';
import { MemoryError } from './service.js';

export const MAX_KEY_WORDS = 15;
export const MAX_KEY_CHARS = 200;

/** One line of single-spaced words; '' for none. Too many words or characters is a clear error, not a silent cut. */
export function normalizeKeys(raw: string | undefined): string {
  const keys = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (keys === '') return '';
  const words = keys.split(' ').length;
  if (words > MAX_KEY_WORDS) throw new MemoryError('invalid', `keys: at most ${MAX_KEY_WORDS} words; you sent ${words}`);
  if (keys.length > MAX_KEY_CHARS) throw new MemoryError('invalid', `keys: at most ${MAX_KEY_CHARS} characters; you sent ${keys.length}`);
  const secret = looksLikeSecret(keys);
  if (secret) throw new MemoryError('secret_detected', `keys: this looks like a secret (${secret}). Secrets are never stored in memory.`);
  return keys;
}

/** The text a fact's vector is made from: its content, and its keys on a line of their own when it has any. */
export function embedText(content: string, keys: string): string {
  return keys === '' ? content : `${content}\n${keys}`;
}
