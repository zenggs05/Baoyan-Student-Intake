// Unit tests for front-end pure helpers (node --test tests/frontend.test.mjs).
// The PDF licence stamp is applied by the Worker now; its tests live in tests/worker.unit.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatKeyInput } from '../src/site/lib/auth-forms.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('formatKeyInput normalises case, separators and length', () => {
  assert.equal(formatKeyInput('abcd efgh-jkmn'), 'ABCD-EFGH-JKMN');
  assert.equal(formatKeyInput('abcdefghjkmnpqrs'), 'ABCD-EFGH-JKMN');
  assert.equal(formatKeyInput('ab'), 'AB');
  assert.equal(formatKeyInput('abcde'), 'ABCD-E');
});

test('the browser no longer stamps PDFs: no front-end code loads pdf-lib', () => {
  const walk = (d) => readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const front = ['site', 'library', 'login', 'admin', 'shared', 'intake'].flatMap((app) => walk(join(ROOT, 'src', app)))
    .filter((f) => f.endsWith('.js'));
  for (const f of front) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /from\s+['"]pdf-lib['"]|import\(\s*['"]pdf-lib['"]\s*\)/, `${f} imports pdf-lib`);
  }
  const dl = readFileSync(join(ROOT, 'src', 'library', 'lib', 'download.js'), 'utf8');
  assert.match(dl, /\/api\/download\//);
});
