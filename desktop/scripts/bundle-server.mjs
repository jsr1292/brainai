// Bundles the server for the desktop app (docs/DESKTOP.md): the JavaScript of src/ and of every dependency except the
// native packages (EXTERNAL) goes into a handful of files, so the app ships hundreds of files instead of thousands.
// Usage: node desktop/scripts/bundle-server.mjs <out-dir>   (out-dir/dist/... and out-dir/package.json are written)
//
// Layout stays the one the compiled server has (dist/index.js, dist/cli.js, dist/hooks/*.js, dist/web/static,
// dist/skills/builtin), because the app, the uninstaller and the tools' hooks start those paths. Code that reads files
// next to itself (import.meta.url) is rewritten to the place its module has in that layout.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = resolve(process.argv[2] ?? '');
if (!process.argv[2]) { console.error('Usage: bundle-server.mjs <out-dir>'); process.exit(1); }
const NODE_TARGET = process.env.NODE_TARGET ?? 'node22';

// Native packages: they hold .node binaries (or load them by path), so they stay real packages in node_modules.
// Their own dependencies are installed with them. (sharp's @img/* platform packages are optionalDependencies of sharp.)
// onnxruntime-common stays one shared copy with onnxruntime-node's (transformers.js and the runtime exchange Tensor objects).
export const EXTERNAL = ['better-sqlite3', 'onnxruntime-node', 'onnxruntime-common', 'sharp', '@node-rs/argon2'];

const ENTRIES = [
  { entry: 'src/index.ts', out: 'dist/index.js' },
  { entry: 'src/cli.ts', out: 'dist/cli.js' },
  // The hooks are copied into the owner's tools and run on their own: each is a complete file of its own.
  { entry: 'src/hooks/memoryStart.ts', out: 'dist/hooks/memoryStart.js' },
  { entry: 'src/hooks/memoryNudge.ts', out: 'dist/hooks/memoryNudge.js' },
  { entry: 'src/hooks/memorySave.ts', out: 'dist/hooks/memorySave.js' },
];

// import.meta.url of a module that is not the entry: where the compiled file would have been (dist/<path>.js), so
// `new URL('./static/x', import.meta.url)` and the walk up to package.json find the same files as before.
const virtualUrl = (entryOut) => ({
  name: 'virtual-import-meta-url',
  setup(b) {
    b.onLoad({ filter: /\/src\/.*\.ts$/ }, (args) => {
      const rel = relative(join(ROOT, 'src'), args.path).split(sep).join('/').replace(/\.ts$/, '.js');
      const text = readFileSync(args.path, 'utf8');
      if (!text.includes('import.meta.')) return null;
      if (args.path === join(ROOT, entryOut.entry)) return null; // the entry keeps its real URL (the "am I the main file" checks)
      const root = `__DIST_ROOT_${entryOut.depth}`;
      return {
        contents: text.replaceAll('import.meta.url', `new URL(${JSON.stringify(rel)}, ${root}).href`)
          .replaceAll('import.meta.dirname', `__fileURLToPath(new URL(".", new URL(${JSON.stringify(rel)}, ${root})))`),
        loader: 'ts',
      };
    });
  },
});

const bundled = new Set(); // package folders whose code went into the bundles
rmSync(join(OUT, 'dist'), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const e of ENTRIES) {
  const depth = e.out.split('/').length - 2; // dist/index.js is 0 folders below dist/, dist/hooks/x.js is 1
  const rootExpr = `new URL(${JSON.stringify('../'.repeat(depth) || './')}, import.meta.url)`;
  const result = await build({
    absWorkingDir: ROOT, // metafile input paths are relative to this, whatever folder the script runs from
    entryPoints: [join(ROOT, e.entry)],
    outfile: join(OUT, e.out),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: NODE_TARGET,
    external: EXTERNAL,
    legalComments: 'none', // the licences are collected into THIRD_PARTY_LICENSES.txt
    metafile: true,
    logLevel: 'warning',
    // CommonJS packages inside an ES bundle call require(), and some use __dirname.
    banner: {
      js: [
        `import { createRequire as __createRequire } from 'node:module';`,
        `import { fileURLToPath as __fileURLToPath } from 'node:url';`,
        `import { dirname as __dirname_of } from 'node:path';`,
        `const require = __createRequire(import.meta.url);`,
        `const __filename = __fileURLToPath(import.meta.url);`,
        `const __dirname = __dirname_of(__filename);`,
        `const __DIST_ROOT_${depth} = ${rootExpr};`,
      ].join('\n'),
    },
    plugins: [virtualUrl({ ...e, depth })],
  });
  for (const f of Object.keys(result.metafile.inputs)) {
    // The LAST node_modules/ segment: a nested package (body-parser/node_modules/content-type) is its own package.
    const i = f.lastIndexOf('node_modules/');
    if (i < 0 || (i > 0 && f[i - 1] !== '/')) continue;
    const m = /^((?:@[^/]+\/)?[^/]+)\//.exec(f.slice(i + 13));
    if (m) bundled.add(f.slice(0, i) + 'node_modules/' + m[1]);
  }
}

// What the server reads from beside its code.
mkdirSync(join(OUT, 'dist', 'web'), { recursive: true });
cpSync(join(ROOT, 'src/web/static'), join(OUT, 'dist/web/static'), { recursive: true });
mkdirSync(join(OUT, 'dist/skills'), { recursive: true });
cpSync(join(ROOT, 'src/skills/builtin'), join(OUT, 'dist/skills/builtin'), { recursive: true });

// package.json and package-lock.json of the staged server: its version (src/version.ts reads it) and the native
// packages only. The lock is the root lock cut down to what they need (same versions and hashes), so `npm ci` in
// the staged folder installs exactly those.
const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const pkgs = lock.packages;
const keep = new Set();
// Dependencies that only an install or build script uses (scripts do not run: --ignore-scripts), never the code that loads.
const BUILD_ONLY = { 'onnxruntime-node': ['adm-zip', 'global-agent'], 'better-sqlite3': ['node-addon-api'] };
const runtimeDeps = (p) => {
  const skip = BUILD_ONLY[p.replace(/^node_modules\//, '')] ?? [];
  return Object.keys({ ...pkgs[p].dependencies, ...pkgs[p].optionalDependencies }).filter((d) => !skip.includes(d));
};
const visit = (fromPath, name) => {
  // Node resolution inside the lock: nested node_modules first, then each parent's.
  let base = fromPath;
  for (;;) {
    const p = `${base ? base + '/' : ''}node_modules/${name}`;
    if (pkgs[p]) {
      if (keep.has(p)) return;
      keep.add(p);
      for (const d of runtimeDeps(p)) visit(p, d);
      return;
    }
    if (!base) return; // an optional dependency of another platform is not in the lock
    const k = base.lastIndexOf('/node_modules/');
    base = k < 0 ? '' : base.slice(0, k);
  }
};
for (const n of EXTERNAL) visit('', n);
const pin = (n) => { if (!pkgs[`node_modules/${n}`]) throw new Error(`${n} is not in package-lock.json`); return pkgs[`node_modules/${n}`].version; };
const deps = Object.fromEntries(EXTERNAL.map((n) => [n, pin(n)]));
const out = { name: root.name, version: root.version, private: true, type: 'module', dependencies: deps };
writeFileSync(join(OUT, 'package.json'), JSON.stringify(out, null, 2) + '\n');
const entries = {};
for (const p of [...keep].sort()) {
  const { dev, devOptional, dependencies, ...e } = pkgs[p];
  const live = runtimeDeps(p);
  entries[p] = { ...e, ...(live.length ? { dependencies: Object.fromEntries(live.filter((d) => dependencies?.[d]).map((d) => [d, dependencies[d]])) } : {}) };
}
writeFileSync(join(OUT, 'package-lock.json'), JSON.stringify({
  name: root.name, version: root.version, lockfileVersion: lock.lockfileVersion, requires: true,
  packages: { '': { name: root.name, version: root.version, dependencies: deps }, ...entries },
}, null, 2) + '\n');

// The licences of what was bundled (their LICENSE files are no longer shipped as files of their own).
const notices = [];
for (const dir of [...bundled].sort()) {
  const pkg = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
  const file = readdirSync(join(ROOT, dir)).find((f) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(f));
  const text = file ? readFileSync(join(ROOT, dir, file), 'utf8').trim() : `(no licence file in the package; declared licence: ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? 'unknown')})`;
  notices.push(`================================================================================\n${pkg.name}@${pkg.version} (${typeof pkg.license === 'string' ? pkg.license : 'see below'})\n${pkg.repository?.url ?? pkg.homepage ?? ''}\n--------------------------------------------------------------------------------\n${text}\n`);
}
writeFileSync(join(OUT, 'THIRD_PARTY_LICENSES.txt'), `BrainAI server: licences of the third-party packages bundled into dist/*.js.\nThe native packages in node_modules/ keep their own LICENSE files.\n\n${notices.join('\n')}`);

console.log(`Bundled ${ENTRIES.length} entries into ${OUT}/dist (external: ${EXTERNAL.join(', ')}).`);
