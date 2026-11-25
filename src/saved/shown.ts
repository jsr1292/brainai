/** Controls a terminal acts on: C0 and DEL, C1 (such as CSI, U+009B), and the bidi controls that reorder text. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const escape = (ch: string): string => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** A value from a saved file we do not trust, quoted and cut so it can go into a message (or a terminal) safely. */
export function shown(value: unknown, max = 80): string {
  let out = '';
  for (const ch of String(value)) {
    // JSON.stringify writes C0 controls as visible text; the rest of the controls it leaves raw, so they are escaped here.
    let q = JSON.stringify(ch).slice(1, -1);
    if (CONTROL.test(q)) q = escape(ch);
    if (out.length + q.length > max) return `"${out}…"`;
    out += q;
  }
  return `"${out}"`;
}

/** A whole error message that may carry text from a saved file: controls escaped, cut near `max` characters. */
export function plain(value: unknown, max = 300): string {
  let out = '';
  for (const ch of String(value)) {
    const q = CONTROL.test(ch) ? escape(ch) : ch;
    if (out.length + q.length > max) return `${out}…`;
    out += q;
  }
  return out;
}
