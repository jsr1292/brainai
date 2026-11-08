/**
 * A throwaway HOME with fake `claude`, `codex` and `opencode` commands for the Connect tests (D3): they keep their
 * servers in a JSON file in that HOME, print what the real CLIs print (claude mcp get's "URL:" line, codex's --json),
 * and log every call. The real HOME and the real tools are never touched.
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = (tool: 'claude' | 'codex' | 'opencode') => `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const home = process.env.HOME; const args = process.argv.slice(2);
fs.appendFileSync(path.join(home, 'calls.log'), ${JSON.stringify(tool)} + ' ' + args.join(' ') + '\\n');
if (process.env.FAKE_FAIL === ${JSON.stringify(tool)}) { console.error('it failed'); process.exit(3); }
const db = path.join(home, '.fake-${tool}.json');
const servers = fs.existsSync(db) ? JSON.parse(fs.readFileSync(db, 'utf8')) : {};
const save = () => fs.writeFileSync(db, JSON.stringify(servers));
const [mcp, cmd, ...rest] = args;
if (mcp !== 'mcp') process.exit(2);
if (${JSON.stringify(tool)} === 'claude') {
  if (cmd === 'get') { const n = rest[0]; if (!servers[n]) { console.log('No MCP server named "' + n + '".'); process.exit(1); }
    console.log(n + ':\\n  Scope: User config\\n  Status: ✔ Connected\\n  Type: http\\n  URL: ' + servers[n] + '\\n'); process.exit(0); }
  if (cmd === 'add') { const url = rest[rest.length - 1]; const n = rest[rest.length - 2]; servers[n] = url; save(); process.exit(0); }
  if (cmd === 'remove') { delete servers[rest[0]]; save(); process.exit(0); }
}
if (${JSON.stringify(tool)} === 'codex') {
  if (cmd === 'get') { const n = rest[0]; if (!servers[n]) { console.error("Error: No MCP server named '" + n + "' found."); process.exit(1); }
    console.log(JSON.stringify({ name: n, enabled: true, transport: { type: 'streamable_http', url: servers[n] } })); process.exit(0); }
  if (cmd === 'add') { const n = rest[0]; const url = rest[rest.indexOf('--url') + 1]; servers[n] = url; save();
    const cfg = path.join(home, '.codex', 'config.toml'); fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.appendFileSync(cfg, '\\n[mcp_servers.' + n + ']\\nurl = "' + url + '"\\n'); process.exit(0); }
  if (cmd === 'remove') { delete servers[rest[0]]; save(); process.exit(0); }
  if (cmd === 'login') process.exit(0);
}
process.exit(0);
`;

export interface FakeHome { home: string; bin: string; apps: string; calls(): string[]; read(rel: string): string | null; write(rel: string, text: string): void; servers(tool: 'claude' | 'codex'): Record<string, string>; cleanup(): void }

export function fakeHome(tools: ('claude' | 'codex' | 'opencode')[] = ['claude', 'codex', 'opencode']): FakeHome {
  const root = mkdtempSync(join(tmpdir(), 'brainai-tools-'));
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const apps = join(root, 'Applications');
  for (const d of [home, bin, apps]) mkdirSync(d, { recursive: true });
  for (const t of tools) { writeFileSync(join(bin, t), SCRIPT(t)); chmodSync(join(bin, t), 0o755); }
  return {
    home, bin, apps,
    calls: () => (existsSync(join(home, 'calls.log')) ? readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean) : []),
    read: (rel) => (existsSync(join(home, rel)) ? readFileSync(join(home, rel), 'utf8') : null),
    write: (rel, text) => { mkdirSync(join(home, rel, '..'), { recursive: true }); writeFileSync(join(home, rel), text); },
    servers: (tool) => (existsSync(join(home, `.fake-${tool}.json`)) ? JSON.parse(readFileSync(join(home, `.fake-${tool}.json`), 'utf8')) : {}),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
