/**
 * A fake `cloudflared` for the Cloudflare route of Reach (D5): `tunnel login`, `tunnel create`, `tunnel route dns` and
 * `tunnel run` answer as the real CLI does (2026.9.3), from a JSON file in a throwaway HOME, and every call is logged.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeCloudflaredState {
  /** `tunnel login` writes cert.pem after this long (default 100 ms); `hang` never finishes. */
  loginDelayMs?: number; hang?: boolean;
  /** `route dns`: the name is taken, or the signed-in domain is another one (Cloudflare appends it). */
  recordExists?: boolean; otherZone?: string;
  /** `tunnel run` stops by itself after 200 ms. */
  dies?: boolean;
}

const SCRIPT = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const home = process.env.HOME; const args = process.argv.slice(2);
// The test's own records: where FAKE_CLOUDFLARED_STATE says (BrainAI gives cloudflared a HOME of its own), else HOME.
const records = process.env.FAKE_CLOUDFLARED_STATE || home;
fs.appendFileSync(path.join(records, 'cloudflared.log'), args.join(' ') + '\\n');
const stateFile = path.join(records, 'cloudflared.json');
const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(s));
const cert = path.join(home, '.cloudflared', 'cert.pem');
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const rest = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--credentials-file', '--url', '--config', '--origincert'].includes(args[i - 1])));
// As the real one: with no --config, the owner's own ~/.cloudflared/config.yml is read.
const ownConfig = path.join(home, '.cloudflared', 'config.yml');
const config = opt('--config') ?? (fs.existsSync(ownConfig) ? ownConfig : undefined);
const ingress = config !== undefined && fs.existsSync(config) && /^ingress:/m.test(fs.readFileSync(config, 'utf8'));
if (rest[0] !== 'tunnel') process.exit(2);
const cmd = rest[1];
if (cmd === 'login') {
  console.error('Please open the following URL and log in with your Cloudflare account:\\n\\nhttps://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.cloudflareaccess.org%2Fx\\n\\nLeave cloudflared running to download the cert automatically.');
  if (s.hang) { setInterval(() => {}, 1000); return; }
  setTimeout(() => { fs.mkdirSync(path.dirname(cert), { recursive: true }); fs.writeFileSync(cert, 'FAKE CERT'); console.error('You have successfully logged in.'); process.exit(0); }, s.loginDelayMs ?? 100);
  return;
}
if (cmd === 'create') {
  if (!fs.existsSync(cert)) { console.error('Cannot determine default origin certificate path.'); process.exit(1); }
  const id = crypto.randomUUID();
  fs.writeFileSync(opt('--credentials-file'), JSON.stringify({ AccountTag: 'acc', TunnelSecret: 'FAKESECRET', TunnelID: id }));
  s.created = (s.created || 0) + 1; save();
  console.log('Tunnel credentials written to ' + opt('--credentials-file') + '. cloudflared chose this file based on where your origin certificate was found. Keep this file secret.\\n\\nCreated tunnel ' + rest[2] + ' with id ' + id);
  process.exit(0);
}
if (cmd === 'route' && rest[2] === 'dns') {
  const host = rest[4];
  if (s.recordExists) { console.error('Failed to add route: code: 1003, reason: Failed to create record ' + host + ' with err An A, AAAA, or CNAME record with that host already exists.'); process.exit(1); }
  const name = s.otherZone ? host + '.' + s.otherZone : host;
  s.records = Object.assign(s.records || {}, { [name]: rest[3] }); save();
  console.error('2026-11-06T18:00:00Z INF Added CNAME ' + name + ' which will route to this tunnel tunnelID=' + rest[3]);
  process.exit(0);
}
if (cmd === 'run') {
  if (ingress && opt('--url')) { console.error("can't set the --url flag (as well as other origin service flags) when using multiple-origin ingress rules"); process.exit(1); }
  s.running = { url: opt('--url'), id: rest[2], pid: process.pid }; save();
  console.error('2026-11-06T18:00:00Z INF Registered tunnel connection connIndex=0');
  process.on('SIGTERM', () => { s.running = null; save(); process.exit(0); });
  if (s.dies) { setTimeout(() => { console.error('ERR lost the connection'); process.exit(1); }, 200); return; }
  setInterval(() => {}, 1000);
  return;
}
process.exit(2);
`;

export function fakeCloudflared(state: FakeCloudflaredState | null): { home: string; bin: string; extraEnv: Record<string, string>; calls(): string[]; state(): Record<string, unknown>; setState(next: FakeCloudflaredState): void; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'brainai-cf-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (state !== null) {
    writeFileSync(join(bin, 'cloudflared'), SCRIPT);
    chmodSync(join(bin, 'cloudflared'), 0o755);
    writeFileSync(join(home, 'cloudflared.json'), JSON.stringify(state));
  }
  return {
    home, bin, extraEnv: { FAKE_CLOUDFLARED_STATE: home },
    calls: () => (existsSync(join(home, 'cloudflared.log')) ? readFileSync(join(home, 'cloudflared.log'), 'utf8').trim().split('\n').filter(Boolean) : []),
    state: () => JSON.parse(readFileSync(join(home, 'cloudflared.json'), 'utf8')) as Record<string, unknown>,
    setState: (next) => writeFileSync(join(home, 'cloudflared.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(home, 'cloudflared.json'), 'utf8')), ...next })),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
