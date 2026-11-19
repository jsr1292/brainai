/**
 * Add a file as a page (C4): checks one uploaded file in memory and works out its title. Nothing is written to disk.
 */
import { SayableError, type Say } from '../i18n/errors.js';
import { looksLikeSecret } from '../memory/secrets.js';
import { MAX_BODY, MAX_TITLE } from '../pages/types.js';

/** Largest file taken, in bytes. */
export const MAX_FILE_BYTES = 1024 * 1024;

export class FileRefused extends SayableError {
  constructor(message: string, say?: Say) { super(message, say); }
}

export interface CheckedFile { name: string; text: string; title: string }

const KINDS = /\.(md|markdown|txt)$/i;

/** Longest stretch of a line looked at for a heading: a heading is short, and a huge line must not cost time. */
const HEADING_SCAN = 300;

/** The first Markdown heading: its text, and the line it is on (so the body can drop it). Null when there is none. */
function firstHeading(text: string): { text: string; line: number } | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(#{1,6})[ \t]+(.*)$/.exec(lines[i]!.slice(0, HEADING_SCAN));
    if (!m) continue;
    const t = m[2]!.replace(/[ \t#]+$/, '').replace(/[*_`]/g, '').trim();
    if (t) return { text: t, line: i };
  }
  return null;
}

/** The first Markdown heading's text, else the file name without its extension (dashes and underscores as spaces). */
export function titleFor(name: string, text: string): string {
  const fromHeading = firstHeading(text)?.text;
  const base = name.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (fromHeading || base || 'Imported file').slice(0, MAX_TITLE);
}

/** The text without its first H1 when that heading is the title (so the page does not show the title twice). */
export function bodyWithoutTitle(text: string, title: string): string {
  const h = firstHeading(text);
  if (!h || h.text !== title || !/^ {0,3}#[ \t]/.test(text.split('\n')[h.line]!)) return text;
  const lines = text.split('\n');
  lines.splice(h.line, 1);
  const rest = lines.join('\n').replace(/^\s*\n/, '');
  return rest.trim() === '' ? text : rest;
}

/** Throws FileRefused with a sentence for the owner when the file is not one plain text file of a size a page can hold. */
export function checkFile(name: string, bytes: Buffer): CheckedFile {
  const safeName = name.replace(/^.*[\\/]/, '').replace(/[\u0000-\u001f]/g, '').slice(0, 200);
  if (!KINDS.test(safeName)) {
    if (/\.pdf$/i.test(safeName)) throw new FileRefused('PDF files are not supported yet. Save it as .txt or .md for now.', { key: 'err.file.pdf' });
    throw new FileRefused('Only .md and .txt files can be added.', { key: 'err.file.kind' });
  }
  if (bytes.length === 0) throw new FileRefused('That file is empty.', { key: 'err.file.empty' });
  if (bytes.length > MAX_FILE_BYTES) throw new FileRefused('That file is larger than 1 MB.', { key: 'err.file.big' });
  if (bytes.includes(0)) throw new FileRefused('That file is not plain text.', { key: 'err.file.binary' });
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FileRefused('That file is not plain text (it is not valid UTF-8).', { key: 'err.file.utf8' });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n');
  // Control characters other than tab, line breaks and form feed mean a binary file saved under a text name.
  if (/[\u0001-\u0008\u000b\u000e-\u001f]/.test(text)) throw new FileRefused('That file is not plain text.', { key: 'err.file.binary' });
  if (text.trim() === '') throw new FileRefused('That file is empty.', { key: 'err.file.empty' });
  if (text.length > MAX_BODY) throw new FileRefused(`That file is longer than a page can hold (${MAX_BODY.toLocaleString('en-US')} characters).`, { key: 'err.file.long', params: { max: MAX_BODY } });
  if (looksLikeSecret(text) !== null) throw new FileRefused('That file looks like it contains a password, key or token, so it was not added. Remove it from the file and try again.', { key: 'err.file.secret' });
  return { name: safeName, text, title: titleFor(safeName, text) };
}
