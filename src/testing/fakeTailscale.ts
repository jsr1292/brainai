/**
 * A fake `tailscale` for the Reach tests (D4): it answers `status --json` and `funnel …` the way the real CLI does
 * (BackendState, Self.DNSName with a trailing dot), from a JSON file in a throwaway HOME, and logs every call.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeTailscaleState {
  backend?: 'Running' | 'Stopped' | 'NeedsLogin'; dns?: string; needsApproval?: boolean; hang?: boolean;
  /** `status` also prints a warning on stderr (as a client/daemon version mismatch does). */
  warn?: boolean;
  /** `funnel … <target>` fails after applying (exit 1), or never answers; `off` still works. */
  funnelFails?: boolean; hangFunnel?: boolean;
  /** A successful `funnel` answer that mentions a login.tailscale.com page anyway. */
  linkOnSuccess?: boolean;
}

const SCRIPT = `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const home = process.env.HOME; const args = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'tailscale.log'), args.join(' ') + '\\n');
const s = JSON.parse(fs.readFileSync(path.join(home, 'tailscale.json'), 'utf8'));
if (s.hang) { setInterval(() => {}, 1000); return; }
if (args[0] === 'status') {
  if (s.warn) console.error('Warning: client version "1.104.2" != tailscaled server version "1.104.0"');
  console.log(JSON.stringify({ BackendState: s.backend || 'Running', Self: { DNSName: s.backend === 'Running' || !s.backend ? (s.dns || 'brainai-mac.tail1234.ts.net.') : '' } }));
  process.exit(0);
}
if (args[0] === 'funnel') {
  if (args.includes('off')) { s.funnel = false; fs.writeFileSync(path.join(home, 'tailscale.json'), JSON.stringify(s)); process.exit(0); }
  if (s.hangFunnel) { s.funnel = true; fs.writeFileSync(path.join(home, 'tailscale.json'), JSON.stringify(s)); setInterval(() => {}, 1000); return; }
  if (s.funnelFails) { s.funnel = true; fs.writeFileSync(path.join(home, 'tailscale.json'), JSON.stringify(s)); console.error('error: could not apply the whole config'); process.exit(1); }
  if (s.needsApproval) { console.log('Funnel is not enabled on your tailnet.\\nTo enable, visit:\\n\\n         https://login.tailscale.com/f/funnel?node=abc123\\n'); process.exit(1); }
  s.funnel = true; fs.writeFileSync(path.join(home, 'tailscale.json'), JSON.stringify(s));
  console.log('Available on the internet:\\n\\nhttps://' + (s.dns || 'brainai-mac.tail1234.ts.net.').replace(/\\.$/, '') + '/\\n|-- proxy ' + args[args.length - 1] + '\\n' + (s.linkOnSuccess ? 'Manage it at https://login.tailscale.com/admin/machines\\n' : ''));
  process.exit(0);
}
process.exit(2);
`;

export function fakeTailscale(state: FakeTailscaleState | null): { home: string; bin: string; calls(): string[]; state(): Record<string, unknown>; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'brainai-ts-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin, { recursive: true });
  if (state !== null) {
    writeFileSync(join(bin, 'tailscale'), SCRIPT);
    chmodSync(join(bin, 'tailscale'), 0o755);
    writeFileSync(join(home, 'tailscale.json'), JSON.stringify(state));
  }
  return {
    home, bin,
    calls: () => (existsSync(join(home, 'tailscale.log')) ? readFileSync(join(home, 'tailscale.log'), 'utf8').trim().split('\n').filter(Boolean) : []),
    state: () => JSON.parse(readFileSync(join(home, 'tailscale.json'), 'utf8')) as Record<string, unknown>,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
