// Builds the one-install plugins (plugins/ and .claude-plugin/marketplace.json) from the real sources: src/hooks,
// src/skills/builtin and src/setup/texts.ts. Everything written is committed, because Claude Code installs straight
// from the repository: run this again after changing one of those sources (src/plugins/plugins.test.ts fails on drift).
// Usage: npm run build:plugins [-- <root>]   (root defaults to the repository)
import { join, resolve } from 'node:path';
import { buildPlugins, repo } from '../src/plugins/buildPlugins.js';

const root = resolve(process.argv[2] ?? repo);
buildPlugins(root);
console.log(`Built the plugins into ${join(root, 'plugins')} and ${join(root, '.claude-plugin', 'marketplace.json')}`);
