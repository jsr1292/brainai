/**
 * Checks that update signatures (.sig files from `tauri build`) were made by the key whose public half the apps
 * trust, so a release signed with the wrong updater key is never published (no installed app would accept it):
 *   node --import tsx src/scripts/updaterKey.ts <tauri.conf.json | public key file> <file.sig>...
 * A .json argument is read for plugins.updater.pubkey; any other file holds the base64 public key, as
 * `tauri signer generate` writes it. Both are base64 minisign text; the key id is bytes 2..10 of the key or signature
 * blob (the line after the "untrusted comment"). Prints no key. Exit 0: every signature matches; 2: a mismatch, or wrong use.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The minisign key id (hex) of a base64 public key or signature, or null when it is not one. */
export function keyId(base64: string): string | null {
  const text = Buffer.from(base64.trim(), 'base64').toString('utf8');
  const lines = text.split('\n').map((l) => l.trim());
  if (!lines[0]?.startsWith('untrusted comment:') || !lines[1]) return null;
  const blob = Buffer.from(lines[1], 'base64');
  if (blob.length < 10 || !/^E[dD]$/.test(blob.subarray(0, 2).toString('latin1'))) return null;
  return blob.subarray(2, 10).toString('hex');
}

/** The trusted public key: plugins.updater.pubkey of a tauri.conf.json, or the content of a public key file. */
export function trustedKey(path: string): string {
  const text = readFileSync(path, 'utf8');
  if (!path.endsWith('.json')) return text.trim();
  const conf = JSON.parse(text) as { plugins?: { updater?: { pubkey?: string } } };
  return conf.plugins?.updater?.pubkey ?? '';
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [keyPath, ...sigs] = process.argv.slice(2);
  if (!keyPath || sigs.length === 0) {
    console.error('Usage: updaterKey.ts <tauri.conf.json | public key file> <file.sig>...');
    process.exit(2);
  }
  let want: string | null;
  try {
    want = keyId(trustedKey(keyPath));
  } catch {
    want = null;
  }
  if (!want) {
    console.error('The trusted updater public key could not be read');
    process.exit(2);
  }
  let bad = 0;
  for (const sig of sigs) {
    let got: string | null = null;
    try {
      got = keyId(readFileSync(sig, 'utf8'));
    } catch {
      got = null;
    }
    if (got !== want) {
      console.error(`${sig.split('/').pop()} was not signed with the updater key the apps trust: installed apps would refuse this update.`);
      bad++;
    }
  }
  process.exit(bad > 0 ? 2 : 0);
}
