/** A small CSS reader for tests: rules with their @media chain, selectors and declarations. */

export type Rule = { media: string; selectors: string[]; decls: Record<string, string> };

/** Split on commas that are not inside brackets, so `:is(a, b)` stays one selector. */
export function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parse(text: string): Rule[] {
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  const stack: string[] = [];
  let buf = '';
  for (const ch of src) {
    if (ch === '{') { stack.push(buf.trim()); buf = ''; continue; }
    if (ch === '}') {
      const head = stack.pop() ?? '';
      if (!head.startsWith('@')) {
        const decls: Record<string, string> = {};
        for (const d of buf.split(';')) {
          const i = d.indexOf(':');
          if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
        }
        rules.push({ media: stack.filter((s) => s.startsWith('@')).join(' '), selectors: splitTop(head), decls });
      }
      buf = '';
      continue;
    }
    buf += ch;
  }
  return rules;
}

/** The value a selector gets for a property, outside any @media unless one is named; later rules win. */
export function propIn(rules: Rule[], selector: string, name: string, media = ''): string | undefined {
  let v: string | undefined;
  for (const r of rules) if (r.media === media && r.selectors.includes(selector) && name in r.decls) v = r.decls[name];
  return v;
}

/** The light palette (the first `:root`, before any @media) and the dark one (light overlaid with the dark block), as hex by name. */
export function palettes(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const light = Object.fromEntries([...css.slice(0, css.indexOf('@media')).matchAll(/--([\w-]+): (#[0-9a-f]{6});/g)].map((m) => [m[1]!, m[2]!]));
  const darkBlock = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  const dark = { ...light, ...Object.fromEntries([...darkBlock.slice(0, darkBlock.indexOf('\n}\n')).matchAll(/--([\w-]+): (#[0-9a-f]{6});/g)].map((m) => [m[1]!, m[2]!])) };
  return { light, dark };
}

export type Rgb = [number, number, number];
export const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
export function luminance(c: Rgb): number {
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x! + 0.05) / (y! + 0.05);
}
