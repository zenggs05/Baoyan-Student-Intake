// Build all front-end apps into dist/ (Worker static assets).
// Convention (see docs/ARCHITECTURE.md §6):
//   src/<app>/*.html        -> dist/<route>/<name>.html
//   src/<app>/*.entry.js    -> dist/<route>/<name>.js   (esm, splitting, minify)
//   src/<app>/*.entry.css   -> dist/<route>/<name>.css
//   .content/public/**      -> dist/data/**             (PUBLIC content only)
import { build } from 'esbuild';
import { readdirSync, existsSync, mkdirSync, rmSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const argVal = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
// --out <dir>   build somewhere other than dist/ (use this for isolated testing so parallel builds don't clobber dist/)
// --only a,b    build only these apps (e.g. --only intake)
const DIST = argVal('--out') ? join(ROOT, argVal('--out')) : join(ROOT, 'dist');
const ALL_ROUTES = { site: '', intake: 'intake', library: 'library', login: 'login', admin: 'admin' };
const only = argVal('--only')?.split(',');
const ROUTES = Object.fromEntries(Object.entries(ALL_ROUTES).filter(([k]) => !only || only.includes(k)));
const watch = process.argv.includes('--watch');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const jsEntries = {};
const cssEntries = {};
for (const [app, route] of Object.entries(ROUTES)) {
  const dir = join(SRC, app);
  if (!existsSync(dir)) continue;
  const outDir = join(DIST, route);
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (!statSync(p).isFile()) continue;
    if (f.endsWith('.html')) copyFileSync(p, join(outDir, f));
    else if (f.endsWith('.entry.js')) jsEntries[join(route, f.replace('.entry.js', ''))] = p;
    else if (f.endsWith('.entry.css')) cssEntries[join(route, f.replace('.entry.css', ''))] = p;
  }
}

const common = { bundle: true, minify: !watch, sourcemap: false, logLevel: 'info', charset: 'utf8', legalComments: 'none' };
if (Object.keys(jsEntries).length) {
  await build({ ...common, entryPoints: jsEntries, outdir: DIST, format: 'esm', splitting: true,
    chunkNames: '_chunks/[name]-[hash]', target: ['es2020', 'chrome90', 'safari15'] });
}
if (Object.keys(cssEntries).length) {
  await build({ ...common, entryPoints: cssEntries, outdir: DIST, loader: { '.css': 'css' } });
}

const pub = join(ROOT, '.content', 'public');
if (existsSync(pub)) copyDir(pub, join(DIST, 'data'));
else console.warn('[build-site] .content/public not found — run `npm run content` first (catalog/preview pages will be missing).');

// NOTE: fs.cpSync silently exits (code 127) on this machine for paths containing Chinese characters; use a manual copy.
function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name), d = join(dst, name);
    if (statSync(s).isDirectory()) copyDir(s, d); else copyFileSync(s, d);
  }
}

console.log('[build-site] done ->', DIST);
