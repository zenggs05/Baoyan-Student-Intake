// Unit tests for Worker helpers: CODE normalisation/generation, password hashing, permission expansion,
// the server-side PDF licence stamp, and KV eventual-consistency races (stale edge copies).
// Run: node --test tests/worker.unit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import * as PDFLib from 'pdf-lib';
import { normalizeCode, generateCode, formatCode, CODE_ALPHABET } from '../src/worker/keys.js';
import {
  hashPassword, verifyPassword, generatePassword, PASSWORD_ALPHABET, PBKDF2_ITER, parseExpiresAt, USERNAME_RE,
} from '../src/worker/students.js';
import { expandProducts, _resetManifestCache } from '../src/worker/content.js';
import {
  timingSafeEqual, ttlUntil, checkOrigin, HttpError, base64ToBytes, sessionCookie, readCookie, cnDate,
} from '../src/worker/util.js';
import { handleRequest } from '../src/worker/router.js';
import { applyPdfStamp, stampText, STAMP_CODE_SLOT, STAMP_DAY_SLOT } from '../src/worker/pdf-stamp.js';
import { addStampPlaceholders, findStampSlots } from '../scripts/lib-content/pdf-stamp.mjs';

test('normalizeCode: case, spaces, dashes', () => {
  assert.equal(normalizeCode('abcd-efgh-jkmn'), 'ABCDEFGHJKMN');
  assert.equal(normalizeCode('  ABCD EFGH JKMN  '), 'ABCDEFGHJKMN');
  assert.equal(normalizeCode('ABCDEFGHJKMN'), 'ABCDEFGHJKMN');
  assert.equal(normalizeCode('a-b-c-d-e-f-g-h-j-k-m-n'), 'ABCDEFGHJKMN');
});

test('normalizeCode: O->0, I/L->1', () => {
  assert.equal(normalizeCode('OOOO-IIII-LLLL'), '000011111111');
  assert.equal(normalizeCode('o0o0-i1l1-2345'), '000011112345');
});

test('normalizeCode: full-width input from Chinese IME', () => {
  assert.equal(normalizeCode('ＡＢＣＤ－ＥＦＧＨ－ＪＫＭＮ'), 'ABCDEFGHJKMN');
  assert.equal(normalizeCode('ABCD　EFGH—JKMN'), 'ABCDEFGHJKMN');
});

test('normalizeCode: rejects malformed input', () => {
  assert.equal(normalizeCode(''), '');
  assert.equal(normalizeCode(null), '');
  assert.equal(normalizeCode(undefined), '');
  assert.equal(normalizeCode('ABCD-EFGH-JKM'), ''); // 11 chars
  assert.equal(normalizeCode('ABCD-EFGH-JKMNP'), ''); // 13 chars
  assert.equal(normalizeCode('ABCD-EFGH-JKMU'), ''); // U is not Crockford
  assert.equal(normalizeCode('ABCD-EFGH-JK!N'), '');
  assert.equal(normalizeCode('密钥ABCDEFGHJKMN'), '');
});

test('generateCode: 12 Crockford chars, round-trips through format + normalize, unique', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = generateCode();
    assert.match(c, /^[0-9A-HJKMNP-TV-Z]{12}$/);
    for (const ch of c) assert.ok(CODE_ALPHABET.includes(ch));
    const f = formatCode(c);
    assert.match(f, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
    assert.equal(normalizeCode(f), c);
    assert.equal(normalizeCode(f.toLowerCase()), c);
    seen.add(c);
  }
  assert.equal(seen.size, 2000);
  assert.equal(CODE_ALPHABET.length, 32);
});

test('hashPassword: PBKDF2-SHA256 matches RFC 7914 test vector (first 32 bytes)', async () => {
  const salt = Buffer.from('salt').toString('base64');
  const r = await hashPassword('passwd', { iter: 1, salt });
  assert.equal(Buffer.from(base64ToBytes(r.pwHash)).toString('hex'), '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc');
  assert.equal(r.iter, 1);
});

test('hashPassword: defaults (10000 iterations, 16-byte salt, 32-byte hash) and verify', async () => {
  const pw = generatePassword();
  const h = await hashPassword(pw);
  assert.equal(h.iter, PBKDF2_ITER);
  assert.equal(PBKDF2_ITER, 10000);
  assert.equal(base64ToBytes(h.salt).length, 16);
  assert.equal(base64ToBytes(h.pwHash).length, 32);
  assert.equal(await verifyPassword(pw, h), true);
  assert.equal(await verifyPassword(pw + 'x', h), false);
  assert.equal(await verifyPassword('', h), false);
  assert.equal(await verifyPassword(undefined, h), false);
  assert.equal(await verifyPassword(pw, { ...h, salt: 'not base64!!' }), false);
  const h2 = await hashPassword(pw);
  assert.notEqual(h.salt, h2.salt);
  assert.notEqual(h.pwHash, h2.pwHash);
  assert.equal(await verifyPassword(pw, h2), true);
});

test('generatePassword: 10 chars, no look-alike characters', () => {
  for (let i = 0; i < 500; i++) {
    const p = generatePassword();
    assert.equal(p.length, 10);
    for (const ch of p) assert.ok(PASSWORD_ALPHABET.includes(ch), ch);
    assert.doesNotMatch(p, /[0o1li]/);
  }
});

test('username rule', () => {
  assert.ok(USERNAME_RE.test('zhang_san'));
  assert.ok(USERNAME_RE.test('abc'));
  assert.ok(!USERNAME_RE.test('ab'));
  assert.ok(!USERNAME_RE.test('Zhang'));
  assert.ok(!USERNAME_RE.test('zhang-san'));
  assert.ok(!USERNAME_RE.test('a'.repeat(33)));
});

test('parseExpiresAt: date string means end of that day in China time', () => {
  const ms = parseExpiresAt('2026-10-31');
  assert.equal(new Date(ms).toISOString(), '2026-10-31T15:59:59.999Z');
  assert.equal(cnDate(ms), '2026-10-31');
  assert.equal(parseExpiresAt(1700000000000), 1700000000000);
  assert.ok(Number.isNaN(parseExpiresAt('not a date')));
});

const manifest = {
  products: [
    { id: 'P2', forSale: true },
    { id: 'P4', forSale: true, includes: ['P3-*'] },
    { id: 'P3-a', forSale: true },
    { id: 'P3-b', forSale: true },
    { id: 'P5', forSale: true },
    { id: 'KIT', forSale: false, studentOnly: true },
  ],
};

test('expandProducts: includes, all, student KIT', () => {
  assert.deepEqual(expandProducts(manifest, ['P2']), ['P2']);
  assert.deepEqual(expandProducts(manifest, ['P4']), ['P4', 'P3-a', 'P3-b']);
  assert.deepEqual(expandProducts(manifest, ['P3-a']), ['P3-a']);
  assert.deepEqual(expandProducts(manifest, 'all'), ['P2', 'P4', 'P3-a', 'P3-b', 'P5']);
  assert.deepEqual(expandProducts(manifest, 'all', { student: true }), ['P2', 'P4', 'P3-a', 'P3-b', 'P5', 'KIT']);
  assert.deepEqual(expandProducts(manifest, ['P2'], { student: true }), ['P2', 'KIT']);
  assert.deepEqual(expandProducts(manifest, ['NOPE']), []);
  assert.deepEqual(expandProducts({ products: [] }, ['P2', 'all']), ['P2']);
});

test('timingSafeEqual and ttlUntil', () => {
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])), true);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4])), false);
  assert.equal(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3])), false);
  const t = 1_000_000;
  assert.equal(ttlUntil(t + 5_000, t), 60); // never below KV's 60 s minimum
  assert.equal(ttlUntil(t - 5_000, t), 60);
  assert.equal(ttlUntil(t + 30 * 60_000, t), 1800);
  assert.equal(ttlUntil(t + 1800_001, t), 1801);
});

test('checkOrigin: only same-host Origin passes for mutating requests', () => {
  const url = new URL('https://example.com/api/redeem');
  const req = (method, origin) => new Request(url, { method, headers: origin ? { Origin: origin } : {} });
  assert.doesNotThrow(() => checkOrigin(req('POST', 'https://example.com'), url));
  assert.doesNotThrow(() => checkOrigin(req('GET'), url));
  for (const bad of [undefined, 'https://evil.com', 'null', 'https://example.com.evil.com', 'not a url']) {
    assert.throws(() => checkOrigin(req('POST', bad), url), (e) => e instanceof HttpError && e.status === 403);
  }
  assert.throws(() => checkOrigin(req('DELETE', 'https://evil.com'), url), (e) => e.status === 403);
});

test('session cookie attributes', () => {
  const c = sessionCookie('tok', 1799.6);
  assert.equal(c, 'bys=tok; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1799');
  const r = new Request('https://x/', { headers: { Cookie: 'a=1; bys=abc; c=3' } });
  assert.equal(readCookie(r), 'abc');
});

// ---------------------------------------------------------------- PDF licence stamp (server side)
async function stampedFixture() {
  const src = await PDFLib.PDFDocument.create();
  src.addPage([595.28, 841.89]);
  src.addPage([595.28, 841.89]).setRotation(PDFLib.degrees(90));
  src.addPage([841.89, 595.28]);
  await addStampPlaceholders(src, { title: '测试资料' });
  const bytes = await src.save({ useObjectStreams: true });
  return { bytes: new Uint8Array(bytes), map: findStampSlots(bytes) };
}

function pageText(doc, page) {
  const contents = page.node.Contents();
  const refs = contents instanceof PDFLib.PDFArray ? contents.asArray() : [contents];
  let out = '';
  for (const r of refs) {
    const s = doc.context.lookup(r);
    const filter = s.dict.get(PDFLib.PDFName.of('Filter'));
    out += Buffer.from(filter ? inflateSync(s.getContents()) : s.getContents()).toString('latin1');
  }
  return out;
}

const STAMP_OP = (code, day) => `(LICENSED ${code} ${String.fromCharCode(92)}267 ${day}) Tj`;

test('pdf stamp: build-time placeholders + server-side fill put the CODE and date on every page and in XMP', async () => {
  const { bytes, map } = await stampedFixture();
  assert.equal(map.size, bytes.length);
  assert.ok(map.code.length >= 2 && map.code.length === map.day.length, JSON.stringify(map)); // page stream(s) + XMP
  assert.equal(applyPdfStamp(bytes, map, { code: 'ABCD-EFGH-JKMN', day: '2026-11-13' }), true);
  const raw = Buffer.from(bytes).toString('latin1');
  assert.ok(!raw.includes(STAMP_CODE_SLOT) && !raw.includes(STAMP_DAY_SLOT), 'no placeholder left');
  const doc = await PDFLib.PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), 3);
  for (const page of doc.getPages()) {
    const t = pageText(doc, page);
    assert.ok(t.includes(STAMP_OP('ABCD-EFGH-JKMN', '2026-11-13')), 'stamp text on the page');
    assert.match(t, /\/BysLicGS gs/, 'faint (ExtGState opacity)');
  }
  assert.ok(raw.includes('<dc:rights>') && raw.includes('LICENSED ABCD-EFGH-JKMN'), 'XMP carries the code');
  assert.equal(stampText('ABCD-EFGH-JKMN', '2026-11-13'), 'LICENSED ABCD-EFGH-JKMN · 2026-11-13');
});

test('pdf stamp: refuses (and leaves the bytes untouched) when the map does not match', async () => {
  const { bytes, map } = await stampedFixture();
  const before = Buffer.from(bytes);
  const ok = (m, v = { code: 'ABCD-EFGH-JKMN', day: '2026-11-13' }) => applyPdfStamp(bytes, m, v);
  assert.equal(ok(null), false);
  assert.equal(ok({ ...map, v: 2 }), false);
  assert.equal(ok({ ...map, size: map.size + 1 }), false);
  assert.equal(ok({ ...map, code: [map.code[0] + 1] }), false); // offset not pointing at a placeholder
  assert.equal(ok({ ...map, day: [] }), false);
  assert.equal(ok(map, { code: 'abc', day: '2026-11-13' }), false);
  assert.equal(ok(map, { code: 'ABCD-EFGH-JKMN', day: '13/11/2026' }), false);
  assert.ok(Buffer.from(bytes).equals(before));
  assert.throws(() => findStampSlots(new TextEncoder().encode('%PDF-1.7 no placeholders')));
});

// ---------------------------------------------------------------- KV eventual consistency (stale edge copies)
/** In-memory KV. `view(stale)` is one edge location: keys in `stale` return that cached copy instead of the store. */
function makeKv() {
  const data = new Map();
  const live = (e) => e && !(e.exp && e.exp <= Date.now());
  const view = (stale = new Map()) => ({
    async get(key, opt) {
      const type = typeof opt === 'string' ? opt : opt?.type || 'text';
      if (opt && typeof opt === 'object' && opt.cacheTtl !== undefined) assert.ok(opt.cacheTtl >= 30, 'cacheTtl must be >= 30');
      const e = stale.has(key) ? stale.get(key) : data.get(key);
      if (!live(e)) return null;
      if (type === 'arrayBuffer') return e.bin ? e.bin.slice().buffer : new TextEncoder().encode(e.value).buffer;
      if (type === 'json') return JSON.parse(e.value);
      return e.value;
    },
    async put(key, value, o = {}) {
      data.set(key, { value: String(value), metadata: o.metadata ?? null, exp: o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0 });
    },
    async delete(key) { data.delete(key); },
    async list({ prefix = '' } = {}) {
      return { keys: [...data].filter(([k, e]) => k.startsWith(prefix) && live(e)).map(([name, e]) => ({ name, metadata: e.metadata })), list_complete: true };
    },
  });
  /** What an edge cached at this moment (null = it cached "not found"). */
  const snapshot = (...keys) => new Map(keys.map((k) => [k, data.has(k) ? { ...data.get(k) } : null]));
  return { data, view, snapshot };
}

const ORIGIN = 'https://site.test';
async function call(env, method, path, { body, cookie } = {}) {
  const headers = { 'CF-Connecting-IP': '10.0.0.1' };
  if (method !== 'GET') headers.Origin = ORIGIN;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = `bys=${cookie}`;
  const res = await handleRequest(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  const sc = res.headers.get('Set-Cookie') || '';
  const token = /^bys=([A-Za-z0-9_-]{43});/.exec(sc)?.[1];
  const isJson = (res.headers.get('Content-Type') || '').includes('json');
  const data = isJson ? await res.json() : null;
  const buf = isJson ? null : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, token, buf, headers: res.headers };
}

async function seededKv() {
  _resetManifestCache();
  const kv = makeKv();
  const manifest = { version: 1, products: [
    { id: 'P2', title: '题库', forSale: true, docs: [{ id: 'd1', title: 'd1' }], pdf: true },
    { id: 'KIT', title: '工具包', forSale: false, studentOnly: true, docs: [{ id: 'k1', title: 'k1' }] },
  ] };
  const w = kv.view();
  await w.put('manifest', JSON.stringify(manifest));
  await w.put('c:P2:d1', '<p>正文</p>');
  await w.put('c:KIT:k1', '<p>工具</p>');
  const fresh = { KV: kv.view(), ADMIN_PASSWORD: 'admin-pw' };
  const admin = (await call(fresh, 'POST', '/api/admin/login', { body: { password: 'admin-pw' } })).token;
  assert.ok(admin, 'admin login');
  return { kv, fresh, admin };
}

test('revoke cannot be undone by a redeem served from a stale edge copy', async () => {
  const { kv, fresh, admin } = await seededKv();
  const created = await call(fresh, 'POST', '/api/admin/keys', { body: { products: ['P2'], maxUses: 3 }, cookie: admin });
  assert.equal(created.status, 200);
  const code = created.data.code.replace(/-/g, '');
  const buyer = (await call(fresh, 'POST', '/api/redeem', { body: { code: created.data.code } })).token;
  assert.equal((await call(fresh, 'GET', '/api/doc/P2/d1', { cookie: buyer })).status, 200);

  // An edge where the buyer keeps reading has cached the pre-revoke record (and "no tombstone").
  const staleEdge = { KV: kv.view(kv.snapshot(`key:${code}`, `revoked:${code}`)) };
  assert.equal((await call(fresh, 'POST', `/api/admin/keys/${created.data.code}/revoke`, { cookie: admin })).status, 200);
  assert.equal((await call(fresh, 'GET', '/api/doc/P2/d1', { cookie: buyer })).status, 403);

  // A friend redeems the same code on the stale edge. It can still succeed there (that edge has not seen the
  // revoke yet), and it rewrites key:<CODE> with revoked:false …
  const friend = await call(staleEdge, 'POST', '/api/redeem', { body: { code: created.data.code } });
  assert.equal(friend.status, 200);
  assert.equal(JSON.parse(kv.data.get(`key:${code}`).value).revoked, false);
  // … but the tombstone is untouched, so once the edge catches up every session is locked out and the code stays dead.
  assert.ok(kv.data.has(`revoked:${code}`), 'tombstone survives');
  assert.equal((await call(fresh, 'GET', '/api/doc/P2/d1', { cookie: buyer })).status, 403);
  assert.equal((await call(fresh, 'GET', '/api/doc/P2/d1', { cookie: friend.token })).status, 403);
  assert.equal((await call(fresh, 'GET', '/api/download/P2', { cookie: buyer })).status, 403);
  assert.equal((await call(fresh, 'POST', '/api/redeem', { body: { code: created.data.code } })).status, 403);
  const list = await call(fresh, 'GET', '/api/admin/keys', { cookie: admin });
  assert.ok(!list.data.keys.some((k) => k.code === created.data.code), 'list keeps hiding the revoked key');
  // After the key record itself has gone, the tombstone still answers "revoked" until the original expiry.
  kv.data.delete(`key:${code}`);
  const gone = await call(fresh, 'GET', '/api/doc/P2/d1', { cookie: buyer });
  assert.equal(gone.status, 403);
  assert.match(gone.data.error, /撤销/);
});

test('student login never writes user:<u> back, so a stale-edge login cannot undo a reset or a disable', async () => {
  const { kv, fresh, admin } = await seededKv();
  const created = await call(fresh, 'POST', '/api/admin/students', { body: { username: 'stu_a', displayName: '甲' }, cookie: admin });
  assert.equal(created.status, 200);
  const oldPw = created.data.password;
  const userBefore = kv.data.get('user:stu_a').value;
  const s1 = await call(fresh, 'POST', '/api/login', { body: { username: 'stu_a', password: oldPw } });
  assert.equal(s1.status, 200);
  assert.equal(kv.data.get('user:stu_a').value, userBefore, 'login did not rewrite the user record');
  assert.ok(kv.data.has('seen:stu_a'), 'last login is kept in its own key');
  const listed = await call(fresh, 'GET', '/api/admin/students', { cookie: admin });
  assert.ok(listed.data.students.find((s) => s.username === 'stu_a').lastLoginAt > 0);

  // Some edge still has the pre-reset, pre-disable record cached.
  const staleEdge = { KV: kv.view(kv.snapshot('user:stu_a')) };
  const reset = await call(fresh, 'POST', '/api/admin/students/stu_a/reset', { cookie: admin });
  assert.equal(reset.status, 200);
  assert.equal((await call(fresh, 'POST', '/api/admin/students/stu_a/disable', { cookie: admin })).status, 200);
  const afterAdmin = kv.data.get('user:stu_a').value;

  // Login with the OLD password on the stale edge: allowed there for now, but it must not touch the store.
  const stale = await call(staleEdge, 'POST', '/api/login', { body: { username: 'stu_a', password: oldPw } });
  assert.equal(stale.status, 200);
  assert.equal(kv.data.get('user:stu_a').value, afterAdmin, 'reset + disable are still in the store');
  // Fresh edges: old password is rejected, and the session opened on the stale edge is dead for good — it was
  // opened with the old password (password version mismatch), so it does not come back when the account is re-enabled.
  assert.equal((await call(fresh, 'POST', '/api/login', { body: { username: 'stu_a', password: oldPw } })).status, 401);
  const dead = await call(fresh, 'GET', '/api/doc/KIT/k1', { cookie: stale.token });
  assert.equal(dead.status, 401);
  assert.match(dead.data.error, /重置/);
  assert.equal((await call(fresh, 'POST', '/api/admin/students/stu_a/enable', { cookie: admin })).status, 200);
  assert.equal((await call(fresh, 'GET', '/api/doc/KIT/k1', { cookie: stale.token })).status, 401);
  assert.equal((await call(fresh, 'GET', '/api/doc/KIT/k1', { cookie: s1.token })).status, 401);
  const s2 = await call(fresh, 'POST', '/api/login', { body: { username: 'stu_a', password: reset.data.password } });
  assert.equal(s2.status, 200);
  assert.equal((await call(fresh, 'GET', '/api/doc/KIT/k1', { cookie: s2.token })).status, 200);
});

test('download: the Worker stamps the PDF and refuses to serve one it cannot stamp', async () => {
  const { kv, fresh, admin } = await seededKv();
  const { bytes, map } = await stampedFixture();
  kv.data.set('pdf:P2', { value: '', bin: bytes, metadata: null, exp: 0 });
  const created = await call(fresh, 'POST', '/api/admin/keys', { body: { products: ['P2'] }, cookie: admin });
  const buyer = (await call(fresh, 'POST', '/api/redeem', { body: { code: created.data.code } })).token;
  const noMap = await call(fresh, 'GET', '/api/download/P2', { cookie: buyer });
  assert.equal(noMap.status, 404, 'no stamp map -> no unstamped download');
  await fresh.KV.put('pdfstamp:P2', JSON.stringify(map));
  const res = await call(fresh, 'GET', '/api/download/P2', { cookie: buyer });
  assert.equal(res.status, 200);
  const text = res.buf.toString('latin1');
  assert.ok(text.includes(STAMP_OP(created.data.code, cnDate())), 'every page stream carries the buyer code');
  assert.ok(!text.includes(STAMP_CODE_SLOT) && !text.includes(STAMP_DAY_SLOT));
  assert.equal(res.headers.get('X-License-Code'), created.data.code);
  assert.ok(Buffer.from(kv.data.get('pdf:P2').bin).toString('latin1').includes(STAMP_CODE_SLOT), 'stored PDF is not modified');
});
