// The plugin builder (scripts/build-plugins.ts runs it; src/plugins/plugins.test.ts checks it). Builds the one-install
// plugins from the real sources, so hooks and skill text never drift:
//   plugins/claude-code/brainai/       the Claude Code plugin (docs/CLIENTS.md, "Install as a plugin")
//   .claude-plugin/marketplace.json    lets `claude plugin marketplace add <owner>/<repo>` install it from this repository
// Dev-only (esbuild is a devDependency): excluded from the production build.
import { transformSync } from 'esbuild';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupText } from '../setup/texts.js';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLUGIN_NAME = 'brainai';
export const MARKETPLACE_NAME = 'brainai-plugins';
export const PLUGIN_DIR = 'plugins/claude-code/brainai';
/** The one setting the user gives at install: their own BrainAI address. */
export const URL_KEY = 'brainai_url';
const URL_REF = '${user_config.' + URL_KEY + '}';
const REPO_URL = 'https://github.com/jsr1292/brainai';

/** The built form of a hook source: plain ES2022 JavaScript, Node built-ins only, as the old install script copies. */
export function compileHook(source: string): string {
  return transformSync(source, { loader: 'ts', format: 'esm', target: 'node22', platform: 'node' }).code;
}

function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** The always-on instructions: the setup text for Claude Code, with the user's own address filled in at load. */
export function memorySkill(): string {
  const placeholder = 'brain.example.test';
  const text = setupText('claude-code', `https://${placeholder}/mcp`)
    .replace(/^<!-- brain setup \d+ -->\n/, '').replace(/\n<!-- \/brain setup -->\s*$/, '')
    .replace(`(${placeholder})`, `(${URL_REF})`);
  return `---
name: brainai-memory
description: Use at the start of every conversation and whenever the work touches past work, the owner's projects or setup, or a decision worth saving. Says how to use the owner's shared memory (the brain, MCP server "brainai") in this session.
---

# Use the shared memory

${text.trim()}
`;
}

function readme(version: string): string {
  return `# BrainAI plugin for Claude Code (${version})

One install gives Claude Code the connection to your own BrainAI server, the save reminders and the harvest skill.
It is generated from BrainAI's sources (\`npm run build:plugins\`); do not edit it by hand.

## Install

\`\`\`
claude plugin marketplace add jsr1292/brainai
claude plugin install brainai@${MARKETPLACE_NAME}
\`\`\`

Claude Code then asks for **brainai_url**: your BrainAI address, the one ending in \`/mcp\` (for example
\`https://memory.example.com/mcp\`, or the address the desktop app shows under Tools on this computer). It is stored in
your own settings; the plugin contains no address. Change it later in \`/config\` or \`/plugin\`. Then run \`/mcp\`, pick
\`brainai\` > \`brainai\` and log in once (OAuth, in the browser).

## What it carries

- **MCP server \`brainai\`**: \`${URL_REF}\`, over HTTP with OAuth.
- **Hooks** (no network calls, Node built-ins only): SessionStart tells the session to load your profile and the project
  briefing; Stop and PreCompact remind it to save decisions and status after real work.
- **Skills**: \`brainai-memory\` (how to use the memory) and \`harvest-session\` (send a session's lasting facts to your
  Inbox for approval).

Before installing, remove any MCP server you added by hand (\`claude mcp remove memory\`, or \`brainai\` if the desktop
app's Connect added it), or you would have two connections to the same server. Use either this plugin or the desktop app's
Connect for Claude Code (or scripts/install-claude-code-hooks.sh), not both: the reminders would fire twice. With the
plugin installed, the desktop Connect for Claude Code adds nothing of its own. Source and docs: ${REPO_URL}
`;
}

/** Writes the plugins and the marketplace file under root (the plugin folder is replaced, never merged). */
export function buildPlugins(root: string): void {
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { version: string };
  const out = join(root, PLUGIN_DIR);
  rmSync(out, { recursive: true, force: true });

  write(join(out, '.claude-plugin', 'plugin.json'), json({
    name: PLUGIN_NAME,
    displayName: 'BrainAI',
    version: pkg.version,
    description: 'Connects Claude Code to your own BrainAI shared memory: MCP server, save reminders and the harvest-session skill.',
    author: { name: 'BrainAI' },
    homepage: REPO_URL,
    repository: REPO_URL,
    license: 'MIT',
    keywords: ['memory', 'mcp', 'brainai'],
    userConfig: {
      [URL_KEY]: {
        type: 'string',
        title: 'Your BrainAI address',
        description: 'The address of your own BrainAI server, ending in /mcp (for example https://memory.example.com/mcp).',
        required: true,
      },
    },
  }));
  write(join(out, '.mcp.json'), json({ mcpServers: { brainai: { type: 'http', url: URL_REF } } }));

  const node = (script: string) => ({ type: 'command', command: 'node', args: [`\${CLAUDE_PLUGIN_ROOT}/hooks/${script}`], timeout: 10 });
  write(join(out, 'hooks', 'hooks.json'), json({
    description: 'BrainAI save reminders: load the profile at session start, remind to save after real work.',
    hooks: {
      SessionStart: [{ matcher: 'startup|clear|compact', hooks: [node('memory-start.mjs')] }],
      Stop: [{ hooks: [node('memory-save.mjs')] }],
      PreCompact: [{ hooks: [node('memory-save.mjs')] }],
    },
  }));
  write(join(out, 'hooks', 'memory-start.mjs'), compileHook(readFileSync(join(repo, 'src/hooks/memoryStart.ts'), 'utf8')));
  write(join(out, 'hooks', 'memory-save.mjs'), compileHook(readFileSync(join(repo, 'src/hooks/memorySave.ts'), 'utf8')));

  write(join(out, 'skills', 'harvest-session', 'SKILL.md'), readFileSync(join(repo, 'src/skills/builtin/harvest-session.md'), 'utf8'));
  write(join(out, 'skills', 'brainai-memory', 'SKILL.md'), memorySkill());
  write(join(out, 'README.md'), readme(pkg.version));

  write(join(root, '.claude-plugin', 'marketplace.json'), json({
    name: MARKETPLACE_NAME,
    description: 'BrainAI plugins: connect your coding tools to your own BrainAI shared memory.',
    owner: { name: 'BrainAI' },
    plugins: [{
      name: PLUGIN_NAME,
      source: `./${PLUGIN_DIR}`,
      description: 'MCP server entry, save-reminder hooks and the harvest-session skill for Claude Code.',
      version: pkg.version,
    }],
  }));
}

