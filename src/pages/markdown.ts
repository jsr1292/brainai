import { Marked, type Tokens } from 'marked';
import { raw, type SafeHtml } from '../web/html.js';
import type { StoredImage } from '../images/store.js';

/**
 * A page split at its ## and ### headings (# counts as ##). The lead is the text before the first heading.
 * `start` and `end` are line offsets into the body (heading line included, end exclusive).
 */
export interface ParsedSection { anchor: string; heading: string; level: 1 | 2 | 3; text: string; start: number; end: number }
/**
 * `replacedHref`: the link is to a replaced fact (section 16); a small "replaced" marker links there (the current fact).
 * `replacedLabel` words that marker instead, such as section 13's "replaced 2 Nov" on a page that may be out of date.
 */
/** The brain's pictures by id, for their real size and whether they still exist (round 2 section 12). */
export type PictureLookup = (id: string) => StoredImage | undefined;

export type LinkResolver = (target: string) => { href: string; label: string; replacedHref?: string; replacedLabel?: string } | null;

// A closing run of #s counts only after a space, so "C#" keeps its #.
const HEADING = /^(#{1,3})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;

/**
 * Lowercase, accents removed, letters and digits of any script kept (so a Cyrillic or CJK heading gets an anchor of its
 * own, not one by position), every other run of characters a single dash. Never an underscore (see NOTES_ID).
 */
function slug(heading: string): string {
  return heading.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '');
}

/**
 * Marks every line inside a fenced code block (the fence lines included). As in CommonMark, a fence closes only on a
 * plain fence of the same character at least as long as the opening one, so a ```` block can hold ``` examples.
 */
function fencedLines(lines: string[]): boolean[] {
  const inside: boolean[] = [];
  let open: { char: string; length: number } | null = null;
  for (const line of lines) {
    if (open === null) {
      const m = FENCE_OPEN.exec(line);
      if (m) open = { char: m[1]![0]!, length: m[1]!.length };
      inside.push(m !== null);
      continue;
    }
    inside.push(true);
    const c = FENCE_CLOSE.exec(line);
    if (c && c[1]![0] === open.char && c[1]!.length >= open.length) open = null;
  }
  return inside;
}

/** The page's reference definitions ("[1]: https://…"), outside code, so a section rendered alone can use them. */
export function linkDefinitions(body: string): string {
  const lines = body.split('\n');
  const fenced = fencedLines(lines);
  return lines.filter((line, i) => !fenced[i] && /^\s{0,3}\[[^\]\n]+\]:\s*\S/.test(line)).join('\n');
}

export function splitSections(body: string): ParsedSection[] {
  const lines = body.split('\n');
  const fenced = fencedLines(lines);
  const heads: { line: number; level: 2 | 3; heading: string }[] = [];
  lines.forEach((line, i) => {
    const m = fenced[i] ? null : HEADING.exec(line);
    if (m) heads.push({ line: i, level: m[1]!.length === 3 ? 3 : 2, heading: m[2]! });
  });
  const out: ParsedSection[] = [];
  const firstHead = heads[0]?.line ?? lines.length;
  const lead = lines.slice(0, firstHead).join('\n');
  if (lead.trim() !== '') out.push({ anchor: 'top', heading: '', level: 1, text: lead, start: 0, end: firstHead });
  const used = new Set(['top']);
  heads.forEach((h, i) => {
    const base = slug(h.heading) || 'section';
    let anchor = base;
    for (let n = 2; used.has(anchor); n++) anchor = `${base}-${n}`;
    used.add(anchor);
    const end = heads[i + 1]?.line ?? lines.length;
    out.push({ anchor, heading: h.heading, level: h.level, text: lines.slice(h.line + 1, end).join('\n'), start: h.line, end });
  });
  return out;
}

export function replaceSection(body: string, anchor: string, newText: string): string | undefined {
  const sections = splitSections(body);
  const i = sections.findIndex((s) => s.anchor === anchor);
  if (i < 0) return undefined;
  const s = sections[i]!;
  const lines = body.split('\n');
  const text = newText.replace(/\s+$/, '');
  const replacement = text === '' ? [] : [...text.split('\n'), ...(i < sections.length - 1 ? [''] : [])];
  return [...lines.slice(0, s.start), ...replacement, ...lines.slice(s.end)].join('\n');
}

const WIKI = /\[\[([^[\]\n]{1,200})\]\]/g;
/** A code span as CommonMark reads one: a run of backticks closed by a run of the same length (``a ` b``). */
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

export function findLinks(body: string): { kind: 'title' | 'fact'; target: string }[] {
  const lines = body.split('\n');
  const fenced = fencedLines(lines);
  const seen = new Set<string>();
  const out: { kind: 'title' | 'fact'; target: string }[] = [];
  lines.forEach((line, i) => {
    if (fenced[i]) return;
    for (const m of line.replace(CODE_SPAN, '').matchAll(WIKI)) {
      const t = m[1]!.trim();
      const link = t.startsWith('fact:') ? { kind: 'fact' as const, target: t.slice(5).trim() } : { kind: 'title' as const, target: t };
      const key = `${link.kind}:${link.target}`;
      if (link.target === '' || seen.has(key)) continue;
      seen.add(key);
      out.push(link);
    }
  });
  return out;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);
const NAMED: Record<string, string> = { colon: ':', tab: '\t', newline: '\n', sol: '/', bsol: '\\', amp: '&', period: '.', lpar: '(', rpar: ')' };

/** Character references decoded, so a check sees what a browser would. */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Decoded, percent-decoded where possible: a link is kept only when what the browser would follow is clearly safe. */
function unsafeChars(s: string): boolean {
  let d = s;
  try { d = decodeURIComponent(s); } catch { /* keep as is */ }
  return /[\x00-\x20\x7f\\]/.test(s) || /[\x00-\x20\x7f\\]/.test(d);
}
const sameSite = (u: string) => u.startsWith('/') && !u.startsWith('//');

function safeHref(href: string): string | null {
  const u = decodeEntities(href);
  if (unsafeChars(u)) return null;
  if (/^https?:\/\//i.test(u) || u.startsWith('#') || sameSite(u)) return u;
  return null;
}
/** Images only from the brain's pictures (/images/<24 hex>.<ext>) and its own static files. */
function safeSrc(src: string): string | null {
  const u = decodeEntities(src);
  if (unsafeChars(u)) return null;
  // Only as written: an address that becomes a picture only once entities are decoded would be drawn but not counted
  // in page_images (imageIdsIn reads the raw address), so a picture still shown could look unused.
  if (PICTURE_PATH.test(u)) return u === src ? u : null;
  return /^\/static\/[A-Za-z0-9._/-]+$/.test(u) && !u.includes('..') ? u : null;
}

const DELETED_DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const sizeText = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

/** The picture an image URL names, when it is one of the brain's and the extension matches its stored type. */
function pictureOf(href: string): { url: string; img: StoredImage | undefined } | null {
  const url = safeSrc(href);
  const m = url === null ? null : PICTURE_PATH.exec(url);
  if (!m) return null;
  const img = picturing?.(m[1]!);
  return { url: url!, img: img && img.ext === m[2] ? img : undefined };
}

/** The picture itself, linked to its file (with script, the link opens the viewer). */
const pictureTag = (url: string, img: StoredImage, alt: string, title: string | null | undefined) =>
  `<a class="pic" href="${esc(url)}"><img src="${esc(url)}" alt="${esc(alt)}"${title ? ` title="${esc(title)}"` : ''} width="${img.width}" height="${img.height}" loading="lazy" decoding="async"></a>`;

/** In place of a picture that isn't there: never a broken image. */
const pictureNotice = (img: StoredImage | undefined, alt: string) => (img === undefined
  ? `<span class="pic-missing">Missing picture: ${esc(alt)}</span>`
  : `<span class="pic-gone">This picture was deleted on ${DELETED_DAY.format(new Date(img.removedAt!))}</span>`);

// marked parses synchronously, so the resolver for the current call is held here.
let resolving: LinkResolver = () => null;
let picturing: PictureLookup | undefined;

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  extensions: [{
    name: 'wikilink',
    level: 'inline',
    start: (src: string) => { const i = src.indexOf('[['); return i < 0 ? undefined : i; },
    tokenizer(src: string) {
      const m = /^\[\[([^[\]\n]{1,200})\]\]/.exec(src);
      return m ? { type: 'wikilink', raw: m[0], target: m[1]!.trim() } : undefined;
    },
    renderer(token) {
      const t = (token as unknown as { target: string }).target;
      const r = resolving(t);
      if (!r) return `<span class="wikilink missing">${esc(t)}</span>`;
      const marker = r.replacedHref === undefined ? '' : ` <a class="fact-replaced" href="${esc(r.replacedHref)}">${esc(r.replacedLabel ?? 'replaced')}</a>`;
      return `<a class="wikilink" href="${esc(r.href)}">${esc(r.label)}</a>${marker}`;
    },
  }],
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      // Shown as text, never as markup; a block of it reads as its own paragraph.
      return 'block' in token && token.block ? `<p>${esc(token.text.trim())}</p>\n` : esc(token.text);
    },
    heading({ tokens, depth }: Tokens.Heading) {
      const level = Math.min(depth + 1, 4);
      return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
    },
    link({ href, title, tokens }: Tokens.Link) {
      const inner = this.parser.parseInline(tokens);
      const safe = safeHref(href);
      if (!safe) return inner;
      return `<a href="${esc(safe)}"${title ? ` title="${esc(title)}"` : ''}>${inner}</a>`;
    },
    image({ href, title, text }: Tokens.Image) {
      const safe = safeSrc(href);
      if (!safe) return esc(text);
      const pic = pictureOf(href);
      if (!pic) return `<img src="${esc(safe)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ''}>`;
      return pic.img && pic.img.removedAt === null ? pictureTag(pic.url, pic.img, text, title) : pictureNotice(pic.img, text);
    },
    paragraph({ tokens }: Tokens.Paragraph) {
      // A paragraph holding only one of the brain's pictures is a figure; its title (never its description) is the caption.
      const own = tokens.filter((t) => !(t.type === 'text' && t.raw.trim() === ''));
      const only = own.length === 1 && own[0]!.type === 'image' ? own[0] as Tokens.Image : null;
      const pic = only ? pictureOf(only.href) : null;
      if (!only || !pic?.img || pic.img.removedAt !== null) return `<p>${this.parser.parseInline(tokens)}</p>\n`;
      const img = pic.img;
      const caption = only.title
        ? `<figcaption><b>${esc(only.title)}</b><span class="pic-meta">Added by ${esc(img.createdBy === 'owner' ? 'you' : img.createdBy)} · ${img.width} × ${img.height} · ${sizeText(img.bytes)}</span></figcaption>`
        : '';
      return `<figure id="pic-${img.id}"><div class="frame">${pictureTag(pic.url, img, only.text, null)}</div>${caption}</figure>\n`;
    },
    code({ text, lang }: Tokens.Code) {
      // A diagram is its text until diagrams.js draws it (batch I3); without script the text is what shows.
      if ((lang ?? '').trim().split(/\s+/)[0] !== 'mermaid') return false;
      return `<div class="diagram"><pre class="diagram-src"><code>${esc(text)}\n</code></pre></div>\n`;
    },
    checkbox({ checked }: Tokens.Checkbox) {
      return checked ? '☑ ' : '☐ ';
    },
    tablecell(token: Tokens.TableCell) {
      const tag = token.header ? 'th' : 'td';
      return `<${tag}${token.align ? ` class="align-${token.align}"` : ''}>${this.parser.parseInline(token.tokens)}</${tag}>\n`;
    },
  },
});

/**
 * Code blocks and tables scroll sideways on a page, so each is a tab stop and a keyboard can scroll it (Safari does not
 * focus a scroll box by itself). Raw HTML and code text come out escaped, so these tags are only marked's own.
 */
const focusable = (out: string) => out.replace(/<pre>/g, '<pre tabindex="0">').replace(/<table>/g, '<table tabindex="0">');

/** A picture stored in the brain, as a Markdown image URL: `/images/<24 hex>.<ext>`. */
export const PICTURE_PATH = /^\/images\/([0-9a-f]{24})\.(jpg|png|webp|gif)$/;

/** The ids of the brain's pictures a body shows, distinct and in body order (Markdown's own rules: code is not). */
export function imageIdsIn(md: string): string[] {
  return pictureRefs(md).map((r) => r.id);
}

/** Each of the brain's pictures a body shows, once, as first written: its id, extension, description and title. */
export function pictureRefs(md: string): { id: string; ext: string; alt: string; title: string | null }[] {
  const refs: { id: string; ext: string; alt: string; title: string | null }[] = [];
  marked.walkTokens(marked.lexer(md), (t) => {
    if (t.type !== 'image') return;
    const img = t as Tokens.Image;
    const m = PICTURE_PATH.exec(img.href);
    if (m && !refs.some((r) => r.id === m[1])) refs.push({ id: m[1]!, ext: m[2]!, alt: img.text, title: img.title || null });
  });
  return refs;
}

/** Markdown as safe HTML: raw HTML is shown as text, links and images only where safe, [[links]] through `resolve`. */
export function renderMarkdown(md: string, resolve: LinkResolver, pictures?: PictureLookup): SafeHtml {
  resolving = resolve;
  picturing = pictures;
  try {
    return raw(focusable(marked.parse(md, { async: false }) as string));
  } finally {
    resolving = () => null;
    picturing = undefined;
  }
}

export function renderInline(md: string, resolve: LinkResolver, pictures?: PictureLookup): SafeHtml {
  resolving = resolve;
  picturing = pictures;
  try {
    return raw(marked.parseInline(md, { async: false }) as string);
  } finally {
    resolving = () => null;
    picturing = undefined;
  }
}

/** The page's diagrams in body order: their index, kind (the first word, after any front-matter) and line count. */
export function diagramBlocks(md: string): { index: number; kind: string; text: string; lines: number }[] {
  const out: { index: number; kind: string; text: string; lines: number }[] = [];
  marked.walkTokens(marked.lexer(md), (t) => {
    if (t.type !== 'code' || ((t as Tokens.Code).lang ?? '').trim().split(/\s+/)[0] !== 'mermaid') return;
    const text = (t as Tokens.Code).text;
    const lines = text.split('\n');
    let i = 0;
    while (i < lines.length && lines[i]!.trim() === '') i++;
    if (lines[i]?.trim() === '---') {
      i++;
      while (i < lines.length && lines[i]!.trim() !== '---') i++;
      i++;
    }
    while (i < lines.length && (lines[i]!.trim() === '' || lines[i]!.trim().startsWith('%%'))) i++;
    out.push({ index: out.length, kind: (lines[i] ?? '').trim().split(/\s+/)[0] ?? '', text, lines: lines.length });
  });
  return out;
}

const DATED = /^(\d{4}-\d{2}-\d{2})\s+([\s\S]*)$/;
/** Outline's form: the date inside the bold title, "**2026-11-03 (morning) — Title.** text". */
const BOLD_DATED = /^\*\*(\d{4}-\d{2}-\d{2})(?:\s*\(([^)]*)\))?(?:\s*[—–]\s*|\s+-\s+)([\s\S]*)$/;
/** Another common form: the bold title, then the date in brackets, "**OAuth only** (2026-10-18). text". */
const TITLE_DATED = /^(\*\*[^*]+\*\*)\s*\((\d{4}-\d{2}-\d{2})\)([\s\S]*)$/;

/** Whether a section heading is the page's Key decisions (any case, spaces around ignored). */
export const isKeyDecisions = (heading: string): boolean => /^key decisions$/i.test(heading.trim());

/** The items of a "Key decisions" list, when every item starts with a date; null otherwise. */
export function decisionItems(text: string, resolve: LinkResolver = () => null): { date: string; html: SafeHtml; factLinked: boolean; factIds: string[] }[] | null {
  const items: string[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (m) items.push(m[1]!);
    else if (line.trim() === '') continue;
    else if (items.length > 0 && /^\s+/.test(line)) items[items.length - 1] += ` ${line.trim()}`;
    else return null;
  }
  if (items.length === 0) return null;
  const out: { date: string; html: SafeHtml; factLinked: boolean; factIds: string[] }[] = [];
  for (const item of items) {
    const bold = BOLD_DATED.exec(item);
    const titled = bold ? null : TITLE_DATED.exec(item);
    const m = bold || titled ? null : DATED.exec(item);
    if (!bold && !titled && !m) return null;
    const date = bold ? bold[1]! : titled ? titled[2]! : m![1]!;
    // The bold title is reopened after the date; a note such as "(morning)" goes before it.
    const rest = bold ? `${bold[2] ? `(${bold[2]}) ` : ''}**${bold[3]!}` : titled ? `${titled[1]!}${titled[3]!}` : m![2]!;
    out.push({ date, html: renderInline(rest, resolve), factLinked: /\[\[\s*fact:/.test(rest), factIds: findLinks(rest).filter((l) => l.kind === 'fact').map((l) => l.target) });
  }
  return out;
}

/** The text of some Markdown without its markup, cut at a word boundary for search snippets. */
export function plainText(md: string, max: number): string {
  // Only Markdown markers go: code spans are kept as written (set aside first), and a _, ~, * or > inside a word, a
  // path or an expression stays, so a snippet quotes ~/Projects/x or MEMORY_MODE correctly.
  const code: string[] = [];
  // Only the start can reach a snippet of `max` characters. Scanning a bounded prefix keeps the marker patterns below
  // fast however a page is written (an unclosed _ or ` in a 100,000-character page made them quadratic).
  const text = md.slice(0, max * 16)
    // A diagram's text says nothing to a reader of a snippet (and must not make two projects look related).
    .replace(/^ {0,3}(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*\n[\s\S]*?(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm, '(diagram)')
    .replace(/^\s{0,3}(`{3,}|~{3,}).*$/gm, '')
    .replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, inner: string) => `\u0000${code.push(inner.replace(/^ (.*) $/s, '$1')) - 1}\u0000`)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-+*]\s+/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\[(?:fact:)?([^[\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\p{L}\p{N}*_])([*_])(?=\S)([\s\S]*?\S)\2(?![\p{L}\p{N}*_])/gu, '$1$3')
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => code[Number(i)]!)
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 0 ? cut.slice(0, space) : cut).replace(/[,.;:]$/, '')}…`;
}
