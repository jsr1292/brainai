/**
 * Writes latest.json (the updater's manifest), release-notes.md and SHA256SUMS for a release folder:
 *   node --import tsx src/scripts/releaseManifest.ts <version> <dir> [--base-url <url>]
 * Exits 2 when a file is missing or CHANGELOG.md has no section for the version.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

class Usage extends Error {}

/** The body of the `## <version>` section of a changelog, without its heading and up to the next `## `. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
  if (start < 0) return null;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join('\n').trim();
}

/** Joins the wrapped lines of each list item into one line (a blank line ends the item). */
export function unwrapItems(md: string): string {
  const out: string[] = [];
  let inItem = false;
  for (const line of md.split('\n')) {
    if (line.startsWith('- ')) { out.push(line.trimEnd()); inItem = true; }
    else if (inItem && /^\s+\S/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
    else { out.push(line); inItem = false; }
  }
  return out.join('\n');
}

/** Markdown to plain text: no bold, links as their text. */
export function plainText(md: string): string {
  return md.replace(/\*\*(.+?)\*\*/gs, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

export function writeManifest(version: string, dir: string, baseUrl: string, changelogPath: string): void {
  const mac = `BrainAI_${version}_aarch64.app.tar.gz`;
  const win = `BrainAI_${version}_x64-setup.exe`;
  const dmg = `BrainAI_${version}_aarch64.dmg`;
  const ps1 = 'install-app.ps1';
  for (const f of [mac, `${mac}.sig`, win, `${win}.sig`, dmg, ps1]) {
    if (!existsSync(join(dir, f))) throw new Usage(`missing file: ${join(dir, f)}`);
  }
  if (!existsSync(changelogPath)) throw new Usage(`missing file: ${changelogPath}`);
  const notes = changelogSection(readFileSync(changelogPath, 'utf8'), version);
  if (notes === null) throw new Usage(`CHANGELOG.md has no section for ${version}`);
  const sig = (f: string) => readFileSync(join(dir, `${f}.sig`), 'utf8').trim();
  const latest = {
    version,
    notes: plainText(unwrapItems(notes)),
    pub_date: new Date().toISOString(),
    platforms: {
      'darwin-aarch64': { signature: sig(mac), url: `${baseUrl}/${mac}` },
      'windows-x86_64': { signature: sig(win), url: `${baseUrl}/${win}` },
    },
  };
  writeFileSync(join(dir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
  writeFileSync(join(dir, 'release-notes.md'), `${notes}\n`);
  const sums = [dmg, mac, win, ps1].sort().map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}`);
  writeFileSync(join(dir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = process.argv.slice(2);
    const take = (flag: string): string | undefined => {
      const i = args.indexOf(flag);
      if (i < 0) return undefined;
      const v = args[i + 1];
      if (!v) throw new Usage(`${flag} needs a value`);
      args.splice(i, 2);
      return v;
    };
    const baseUrl = take('--base-url');
    const changelog = take('--changelog');
    const [version, dir] = args;
    if (!version || !dir) throw new Usage('usage: releaseManifest.ts <version> <dir> [--base-url <url>] [--changelog <path>]');
    writeManifest(version, dir, (baseUrl ?? `https://github.com/jsr1292/brainai/releases/download/v${version}`).replace(/\/+$/, ''), changelog ?? join(HERE, '..', '..', 'CHANGELOG.md'));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }
}
