// Test-only wrapper around scripts/build-site.mjs (the shared script is not owned by the front-end agent).
//
// It runs a temporary copy of build-site.mjs with two work-arounds; everything else is identical:
//  1. esbuild target 'safari14' -> 'safari14.1'. esbuild 0.28 treats destructuring as unsupported for
//     Safari 14.0 and refuses to build any file that destructures (including src/shared/ui.js / api.js).
//  2. fs.cpSync(...) -> a small recursive copy. On this machine Node 22.22.2's cpSync terminates the
//     process (exit code 127, no error) when the path contains non-ASCII characters
//     (F:\personal\保研辅导\...), so .content/public is never copied to dist/data.
// Both should be fixed in scripts/build-site.mjs; once they are, the copy is byte-identical.
//
// Usage (same flags as build-site.mjs):
//   node tests/frontend-build.mjs --only site,library,login,admin --out test-artifacts/frontend-dist
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'scripts', 'build-site.mjs'), 'utf8');
let patched = src.replace(/'safari14'(?=\s*[\],])/g, "'safari14.1'");
if (/\bcpSync\(/.test(patched)) {
  patched = patched.replace(/\bcpSync\((.+?),\s*\{\s*recursive:\s*true\s*\}\)/g, '__copyDir($1)') + `
function __copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, e.name), b = join(to, e.name);
    if (e.isDirectory()) __copyDir(a, b); else copyFileSync(a, b);
  }
}
`;
}
if (patched !== src) console.warn('[frontend-build] applied test-only work-arounds to build-site.mjs (see tests/frontend-build.mjs header)');
// Same directory depth as scripts/, so ROOT (= dirname/..) still resolves to the project root.
const tmp = join(here, `frontend-build.tmp-${process.pid}.mjs`);
writeFileSync(tmp, patched);
try {
  await import(pathToFileURL(tmp).href);
} finally {
  rmSync(tmp, { force: true });
}
