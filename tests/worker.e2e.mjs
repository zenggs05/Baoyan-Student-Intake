// End-to-end API test for the Worker (docs/ARCHITECTURE.md §4, §8) — plain fetch + a hand-rolled cookie jar.
//
//   node tests/worker.e2e.mjs            # uses http://127.0.0.1:8787; if nothing is listening there it seeds an
//                                        # isolated local KV and starts `wrangler dev` itself, then stops it.
//   WORKER_BASE=http://127.0.0.1:8787 node tests/worker.e2e.mjs
//
// The server must contain the fake catalogue from scripts/dev-seed.mjs (P2, P5, P4, P3-demo, KIT, pdf:P2).
// Takes ~80 s because a 1-minute key has to expire. Every simulated browser gets its own CF-Connecting-IP so the
// rate limiter (10/min/IP) only trips where the test wants it to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.WORKER_BASE || 'http://127.0.0.1:8787').replace(/\/$/, '');
const SHORT_KEY_WAIT_MS = 70_000;

function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const f = join(ROOT, '.dev.vars');
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(/^\s*ADMIN_PASSWORD\s*=\s*"?([^"\r\n]*)"?/m);
    if (m) return m[1];
  }
  throw new Error('ADMIN_PASSWORD not found (.dev.vars or env)');
}
const ADMIN_PW = adminPassword();

// ---------- fake browser ----------
const ipPrefix = `10.${Math.floor(Math.random() * 250) + 1}`;
let ipCounter = 0;
const nextIp = () => {
  ipCounter++;
  return `${ipPrefix}.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
};

class Client {
  constructor(name) {
    this.name = name;
    this.ip = nextIp();
    this.cookies = new Map();
  }

  async req(method, path, { body, origin = BASE, headers = {} } = {}) {
    const h = { 'CF-Connecting-IP': this.ip, ...headers };
    if (origin !== null && method !== 'GET') h.Origin = origin;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) h.Cookie = cookie;
    const res = await fetch(BASE + path, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const setCookies = res.headers.getSetCookie();
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';').map((s) => s.trim());
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      const maxAge = attrs.find((a) => /^max-age=/i.test(a));
      if (!value || (maxAge && Number(maxAge.split('=')[1]) <= 0)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const ct = res.headers.get('content-type') || '';
    let data = null;
    let buf = null;
    if (ct.includes('application/json')) data = await res.json();
    else buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, data, buf, setCookies };
  }

  get(path, o) { return this.req('GET', path, o); }
  post(path, body, o) { return this.req('POST', path, { ...o, body }); }
  del(path, o) { return this.req('DELETE', path, o); }
}

const isErr = (r, status, re) => {
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${JSON.stringify(r.data)}`);
  assert.equal(typeof r.data?.error, 'string', 'error body must be {error}');
  assert.match(r.data.error, /[一-龥]/, 'error must be human-readable Chinese');
  if (re) assert.match(r.data.error, re);
};
const ok = (r, status = 200) => assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${JSON.stringify(r.data)}`);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// ---------- optional self-hosted server ----------
let devProc = null;
async function reachable() {
  try { await fetch(BASE + '/api/me'); return true; } catch { return false; }
}
async function ensureServer() {
  if (await reachable()) return;
  console.log(`[e2e] ${BASE} not reachable — seeding isolated KV and starting wrangler dev`);
  const state = 'test-artifacts/worker-e2e-state';
  const assets = join(ROOT, 'test-artifacts', 'worker-dist');
  mkdirSync(assets, { recursive: true });
  if (!existsSync(join(assets, 'index.html'))) {
    writeFileSync(join(assets, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>test</title></head><body>test</body></html>');
  }
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'dev-seed.mjs'), '--persist-to', state], { cwd: ROOT, stdio: 'inherit' });
  const port = new URL(BASE).port || '8787';
  devProc = spawn(process.execPath, [
    join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js'), 'dev', '--port', port, '--ip', '127.0.0.1',
    '--persist-to', state, '--assets', assets, '--show-interactive-dev-session=false',
  ], { cwd: ROOT, stdio: 'ignore' });
  process.on('exit', stopServer);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await reachable()) return;
  }
  throw new Error('wrangler dev did not start');
}
function stopServer() {
  if (!devProc) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(devProc.pid), '/T', '/F'], { stdio: 'ignore' });
    else devProc.kill('SIGTERM');
  } catch { /* already gone */ }
  devProc = null;
}

// ---------- the test ----------
test('worker API end-to-end', { timeout: 10 * 60_000 }, async (t) => {
  await ensureServer();
  t.after(stopServer);

  const admin = new Client('admin');
  const anon = new Client('anon');
  const uniq = Date.now().toString(36);
  let shortKey = null; // {code, createdAt}
  let shortReader = null;
  let p2Key = null;
  let readerA = null;

  await t.test('public: /api/me without cookie, /api/catalog hides student-only products and content', async () => {
    const me = await anon.get('/api/me');
    ok(me);
    assert.deepEqual(me.data, { session: null });
    assert.equal(me.headers.get('cache-control'), 'no-store');
    const cat = await anon.get('/api/catalog');
    ok(cat);
    const ids = cat.data.products.map((p) => p.id);
    for (const id of ['P2', 'P5', 'P4', 'P3-demo']) assert.ok(ids.includes(id), `catalog missing ${id} — did you run scripts/dev-seed.mjs?`);
    assert.ok(!ids.includes('KIT'), 'KIT must not be public');
    const p2 = cat.data.products.find((p) => p.id === 'P2');
    for (const f of ['id', 'title', 'subtitle', 'price', 'priceNote', 'sellingPoint', 'docCount', 'docs', 'preview', 'includes']) {
      assert.ok(f in p2, `catalog product missing ${f}`);
    }
    assert.equal(p2.docCount, p2.docs.length);
    assert.deepEqual(Object.keys(p2.docs[0]).sort(), ['id', 'title']);
    assert.deepEqual(cat.data.products.find((p) => p.id === 'P4').includes, ['P3-*']);
    assert.ok(!JSON.stringify(cat.data).includes('示例段落'), 'catalog must not contain document bodies');
  });

  await t.test('static pages carry security headers; unknown API route is a JSON 404', async () => {
    const r = await anon.get('/');
    ok(r);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(r.headers.get('referrer-policy'));
    isErr(await anon.get('/api/nope'), 404);
  });

  await t.test('admin endpoints require an admin session (401)', async () => {
    isErr(await anon.get('/api/admin/products'), 401);
    isErr(await anon.get('/api/admin/keys'), 401);
    isErr(await anon.get('/api/admin/students'), 401);
    isErr(await anon.post('/api/admin/keys', { products: ['P2'] }), 401);
    isErr(await anon.post('/api/admin/keys/ABCD-EFGH-JKMN/revoke', {}), 401);
    isErr(await anon.post('/api/admin/students', { username: 'x_y_z' }), 401);
    isErr(await anon.post('/api/admin/students/x_y_z/reset', {}), 401);
    isErr(await anon.del('/api/admin/students/x_y_z'), 401);
  });

  await t.test('Origin check: wrong or missing Origin on POST/DELETE is 403', async () => {
    isErr(await anon.post('/api/admin/login', { password: ADMIN_PW }, { origin: 'https://evil.example' }), 403);
    isErr(await anon.post('/api/admin/login', { password: ADMIN_PW }, { origin: null }), 403);
    isErr(await anon.post('/api/redeem', { code: 'ABCD-EFGH-JKMN' }, { origin: 'http://127.0.0.1:9999' }), 403);
    isErr(await anon.post('/api/login', { username: 'abc', password: 'x' }, { origin: 'https://127.0.0.1.evil.example' }), 403);
    assert.equal(anon.cookies.size, 0);
  });

  await t.test('admin login: wrong password 401, right password sets a 12h session cookie', async () => {
    isErr(await admin.post('/api/admin/login', { password: 'wrong-password' }), 401);
    isErr(await admin.post('/api/admin/login', {}), 400);
    const r = await admin.post('/api/admin/login', { password: ADMIN_PW });
    ok(r);
    assert.equal(r.data.session.type, 'admin');
    const sc = r.setCookies.find((c) => c.startsWith('bys='));
    assert.ok(sc, 'Set-Cookie bys missing');
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(sc.includes(attr), `cookie lacks ${attr}`);
    const maxAge = Number(sc.match(/Max-Age=(\d+)/)[1]);
    assert.ok(maxAge > 12 * 3600 - 60 && maxAge <= 12 * 3600, `admin Max-Age ${maxAge}`);
    assert.match(sc, /^bys=[A-Za-z0-9_-]{43};/, 'token must be 32 random bytes in base64url');
    const me = await admin.get('/api/me');
    assert.equal(me.data.session.type, 'admin');
  });

  await t.test('CSRF: admin cookie + foreign Origin cannot create keys', async () => {
    isErr(await admin.post('/api/admin/keys', { products: ['P2'] }, { origin: 'https://evil.example' }), 403);
  });

  await t.test('admin: product list', async () => {
    const r = await admin.get('/api/admin/products');
    ok(r);
    const ids = r.data.products.map((p) => p.id);
    for (const id of ['P2', 'P5', 'P4', 'P3-demo', 'KIT']) assert.ok(ids.includes(id), id);
    assert.equal(r.data.products.find((p) => p.id === 'KIT').studentOnly, true);
  });

  await t.test('short key (minutes=1) is created and redeemed early', async () => {
    const r = await admin.post('/api/admin/keys', { products: ['P2'], minutes: 1, maxUses: 1, label: 'e2e 短时' });
    ok(r);
    const ttl = r.data.expiresAt - Date.now();
    assert.ok(ttl > 50_000 && ttl <= 60_000, `minutes=1 expiresAt off: ${ttl}`);
    shortKey = { code: r.data.code, createdAt: Date.now() };
    shortReader = new Client('short');
    const red = await shortReader.post('/api/redeem', { code: shortKey.code });
    ok(red);
    const sc = red.setCookies.find((c) => c.startsWith('bys='));
    const maxAge = Number(sc.match(/Max-Age=(\d+)/)[1]);
    assert.ok(maxAge <= 60 && maxAge > 40, `cookie Max-Age should follow the key (${maxAge})`);
    ok(await shortReader.get('/api/doc/P2/P2_00'));
  });

  await t.test('admin: key validation', async () => {
    isErr(await admin.post('/api/admin/keys', { products: [] }), 400);
    isErr(await admin.post('/api/admin/keys', { products: ['NOPE'] }), 400);
    isErr(await admin.post('/api/admin/keys', { products: ['KIT'] }), 400);
    isErr(await admin.post('/api/admin/keys', { products: ['P2'], minutes: 0 }), 400);
    isErr(await admin.post('/api/admin/keys', { products: ['P2'], minutes: 1441 }), 400);
    isErr(await admin.post('/api/admin/keys', { products: ['P2'], minutes: 2.5 }), 400);
    isErr(await admin.post('/api/admin/keys', { products: ['P2'], maxUses: 0 }), 400);
  });

  await t.test('admin: issue a P2 key with defaults (30 min, 3 uses)', async () => {
    const r = await admin.post('/api/admin/keys', { products: ['P2'], label: `e2e 买家 ${uniq}` });
    ok(r);
    assert.match(r.data.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.deepEqual(r.data.products, ['P2']);
    assert.equal(r.data.label, `e2e 买家 ${uniq}`);
    const ttl = r.data.expiresAt - Date.now();
    assert.ok(ttl > 29 * 60_000 && ttl <= 30 * 60_000, `default expiry off: ${ttl}`);
    p2Key = r.data;
    const list = await admin.get('/api/admin/keys');
    ok(list);
    const item = list.data.keys.find((k) => k.code === p2Key.code);
    assert.ok(item, 'new key should be listed');
    assert.equal(item.uses, 0);
    assert.equal(item.maxUses, 3);
    assert.deepEqual(item.products, ['P2']);
  });

  await t.test('redeem: errors (empty / malformed / unknown)', async () => {
    const c = new Client('bad');
    isErr(await c.post('/api/redeem', { code: '' }), 400);
    isErr(await c.post('/api/redeem', { code: 'hello' }), 404, /密钥无效或已过期/);
    isErr(await c.post('/api/redeem', { code: 'ZZZZ-ZZZZ-ZZZZ' }), 404, /密钥无效或已过期/);
    isErr(await c.post('/api/redeem', 'not-an-object'), 400);
    assert.equal(c.cookies.size, 0);
  });

  await t.test('redeem a P2 key typed sloppily (lowercase, spaces, O for 0, l for 1) in a new browser', async () => {
    readerA = new Client('readerA');
    const sloppy = ` ${p2Key.code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')} `;
    const r = await readerA.post('/api/redeem', { code: sloppy });
    ok(r);
    const s = r.data.session;
    assert.equal(s.type, 'key');
    assert.deepEqual(s.products, ['P2']);
    assert.equal(s.canDownload, true);
    assert.equal(s.expiresAt, p2Key.expiresAt);
    assert.equal(s.code, p2Key.code);
    const sc = r.setCookies.find((c) => c.startsWith('bys='));
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=']) assert.ok(sc.includes(attr), attr);
    const me = await readerA.get('/api/me');
    ok(me);
    for (const f of ['type', 'label', 'displayName', 'products', 'expiresAt', 'canDownload']) assert.ok(f in me.data.session, f);
    assert.equal(me.data.session.type, 'key');
  });

  await t.test('key session: read P2, P5 is 403, missing doc 404', async () => {
    const r = await readerA.get('/api/doc/P2/P2_00');
    ok(r);
    assert.equal(r.data.productId, 'P2');
    assert.equal(r.data.docId, 'P2_00');
    assert.ok(r.data.title);
    assert.match(r.data.html, /<h2 id="s1">/);
    assert.ok(r.data.watermark.line1.includes(p2Key.code), 'watermark should carry the CODE');
    assert.ok(r.data.watermark.line2);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    ok(await readerA.get('/api/doc/P2/P2_01'));
    isErr(await readerA.get('/api/doc/P5/D1'), 403);
    isErr(await readerA.get('/api/doc/P4/P4_00'), 403);
    isErr(await readerA.get('/api/doc/KIT/T_MAIL'), 403);
    isErr(await readerA.get('/api/doc/P2/NOPE'), 404);
    isErr(await readerA.get('/api/doc/NOPE/x'), 404);
  });

  await t.test('key session: download P2 PDF; P5 is 403', async () => {
    const r = await readerA.get('/api/download/P2');
    ok(r);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.match(r.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''[^;]+\.pdf$/);
    assert.ok(decodeURIComponent(r.headers.get('content-disposition').split("''")[1]).startsWith('理工科面试题库'));
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex');
    assert.equal(r.buf.subarray(0, 5).toString('latin1'), '%PDF-');
    // The licence stamp is written by the server: the raw response (no browser involved) already carries the code.
    const pdfText = r.buf.toString('latin1');
    assert.ok(pdfText.includes(`LICENSED ${p2Key.code}`), 'downloaded PDF must carry the key code');
    assert.ok(!pdfText.includes('####-####-####'), 'no unfilled placeholder');
    assert.equal(r.headers.get('x-license-code'), p2Key.code);
    isErr(await readerA.get('/api/download/P5'), 403);
    isErr(await anon.get('/api/download/P2'), 401);
    isErr(await anon.get('/api/doc/P2/P2_00'), 401);
  });

  await t.test('re-entering the same key in the same browser does not use up another redemption', async () => {
    ok(await readerA.post('/api/redeem', { code: p2Key.code }));
    const list = await admin.get('/api/admin/keys');
    assert.equal(list.data.keys.find((k) => k.code === p2Key.code).uses, 1);
  });

  await t.test('maxUses: third browser on a 2-use key gets 403', async () => {
    const r = await admin.post('/api/admin/keys', { products: ['P5'], maxUses: 2 });
    ok(r);
    ok(await new Client('m1').post('/api/redeem', { code: r.data.code }));
    const c2 = new Client('m2');
    ok(await c2.post('/api/redeem', { code: r.data.code }));
    ok(await c2.get('/api/doc/P5/D1'));
    const c3 = new Client('m3');
    isErr(await c3.post('/api/redeem', { code: r.data.code }), 403, /该密钥已达到使用次数上限/);
    assert.equal(c3.cookies.size, 0);
    const list = await admin.get('/api/admin/keys');
    const item = list.data.keys.find((k) => k.code === r.data.code);
    assert.equal(item.uses, 2);
  });

  await t.test('P4 key includes every P3-* product; multi-product key', async () => {
    const r = await admin.post('/api/admin/keys', { products: ['P4'] });
    ok(r);
    const c = new Client('p4');
    const red = await c.post('/api/redeem', { code: r.data.code });
    ok(red);
    assert.ok(red.data.session.products.includes('P4'));
    assert.ok(red.data.session.products.includes('P3-demo'));
    ok(await c.get('/api/doc/P4/P4_01'));
    ok(await c.get('/api/doc/P3-demo/demo'));
    isErr(await c.get('/api/doc/P2/P2_00'), 403);
    isErr(await c.get('/api/download/P4'), 404); // seed has no P4 PDF
    const multi = await admin.post('/api/admin/keys', { products: ['P2', 'P5'] });
    ok(multi);
    const m = new Client('multi');
    ok(await m.post('/api/redeem', { code: multi.data.code }));
    ok(await m.get('/api/doc/P2/P2_00'));
    ok(await m.get('/api/doc/P5/D1'));
  });

  await t.test('revoke: reader is locked out (401/403), code can no longer be redeemed, list hides it', async () => {
    isErr(await admin.post('/api/admin/keys/ZZZZ-ZZZZ-ZZZZ/revoke', {}), 404);
    const r = await admin.post(`/api/admin/keys/${p2Key.code.toLowerCase()}/revoke`, {});
    ok(r);
    assert.equal(r.data.ok, true);
    const doc = await readerA.get('/api/doc/P2/P2_00');
    assert.ok([401, 403].includes(doc.status), `revoked doc status ${doc.status}`);
    isErr(doc, doc.status, /撤销|过期/);
    const dl = await readerA.get('/api/download/P2');
    assert.ok([401, 403].includes(dl.status));
    const me = await readerA.get('/api/me');
    assert.equal(me.data.session, null);
    assert.ok(me.data.notice);
    isErr(await new Client('late').post('/api/redeem', { code: p2Key.code }), 403);
    const list = await admin.get('/api/admin/keys');
    assert.ok(!list.data.keys.some((k) => k.code === p2Key.code));
  });

  // ---------- students ----------
  const username = `e2e_${uniq}`;
  let password = null;
  const student = new Client('student');

  await t.test('admin: create student account (validation, duplicate, list without hashes)', async () => {
    isErr(await admin.post('/api/admin/students', { username: 'AB', displayName: 'x' }), 400);
    isErr(await admin.post('/api/admin/students', { username: 'bad-name', displayName: 'x' }), 400);
    isErr(await admin.post('/api/admin/students', { username: `${username}x`, expiresAt: '2001-01-01' }), 400);
    isErr(await admin.post('/api/admin/students', { username: `${username}x`, expiresAt: 'soon' }), 400);
    const year = new Date().getFullYear() + 1;
    const r = await admin.post('/api/admin/students', { username, displayName: '测试同学', expiresAt: `${year}-10-31`, products: 'all' });
    ok(r);
    assert.equal(r.data.username, username);
    assert.match(r.data.password, /^[a-z2-9]{10}$/);
    password = r.data.password;
    isErr(await admin.post('/api/admin/students', { username, displayName: '重复', products: 'all' }), 400);
    const list = await admin.get('/api/admin/students');
    ok(list);
    const u = list.data.students.find((s) => s.username === username);
    assert.ok(u);
    assert.equal(u.displayName, '测试同学');
    assert.equal(u.disabled, false);
    assert.equal(u.products, 'all');
    const raw = JSON.stringify(list.data);
    assert.ok(!/pwHash|salt|"iter"/.test(raw), 'student list must not expose password hashes');
  });

  await t.test('student login: wrong password 401, unknown user 401, success', async () => {
    isErr(await student.post('/api/login', { username, password: 'wrongpass12' }), 401);
    isErr(await student.post('/api/login', { username: 'nobody_here', password: 'whatever12' }), 401);
    isErr(await student.post('/api/login', { username: '', password: '' }), 400);
    const r = await student.post('/api/login', { username: username.toUpperCase(), password });
    ok(r);
    const s = r.data.session;
    assert.equal(s.type, 'student');
    assert.equal(s.displayName, '测试同学');
    assert.equal(s.canDownload, false);
    for (const id of ['P2', 'P4', 'P3-demo', 'P5', 'KIT']) assert.ok(s.products.includes(id), id);
    assert.ok(s.expiresAt <= Date.now() + 7 * 86400_000 + 1000, 'student session must be at most 7 days');
    assert.ok(s.expiresAt > Date.now() + 7 * 86400_000 - 60_000);
    const sc = r.setCookies.find((c) => c.startsWith('bys='));
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.ok(sc.includes(attr), attr);
  });

  await t.test('student: reads KIT and P4 (+P3), download is 403, catalog shows KIT', async () => {
    const kit = await student.get('/api/doc/KIT/T_MAIL');
    ok(kit);
    assert.ok(kit.data.watermark.line1.includes(username));
    ok(await student.get('/api/doc/P4/P4_00'));
    ok(await student.get('/api/doc/P3-demo/demo'));
    isErr(await student.get('/api/download/P2'), 403, /陪跑账号仅支持在线查看/);
    isErr(await student.get('/api/download/P4'), 403, /陪跑账号仅支持在线查看/);
    const cat = await student.get('/api/catalog');
    assert.ok(cat.data.products.some((p) => p.id === 'KIT'), 'student catalog should include KIT');
    const me = await student.get('/api/me');
    assert.equal(me.data.session.canDownload, false);
  });

  await t.test('student: disable -> 403 everywhere, enable -> works again', async () => {
    ok(await admin.post(`/api/admin/students/${username}/disable`, {}));
    isErr(await student.get('/api/doc/KIT/T_MAIL'), 403, /停用/);
    isErr(await student.get('/api/doc/P4/P4_00'), 403);
    const me = await student.get('/api/me');
    assert.equal(me.data.session, null);
    assert.match(me.data.notice, /停用/);
    isErr(await new Client('s2').post('/api/login', { username, password }), 403, /停用/);
    const list = await admin.get('/api/admin/students');
    assert.equal(list.data.students.find((s) => s.username === username).disabled, true);
    ok(await admin.post(`/api/admin/students/${username}/enable`, {}));
    ok(await student.get('/api/doc/KIT/T_MAIL'));
  });

  await t.test('student: reset password logs out old sessions; only the new password works', async () => {
    const r = await admin.post(`/api/admin/students/${username}/reset`, {});
    ok(r);
    assert.match(r.data.password, /^[a-z2-9]{10}$/);
    assert.notEqual(r.data.password, password);
    isErr(await student.get('/api/doc/KIT/T_MAIL'), 401);
    isErr(await student.post('/api/login', { username, password }), 401);
    password = r.data.password;
    ok(await student.post('/api/login', { username, password }));
    ok(await student.get('/api/doc/KIT/T_MAIL'));
  });

  await t.test('student with a limited product list still gets KIT', async () => {
    const name = `e2e_lim_${uniq}`;
    const r = await admin.post('/api/admin/students', { username: name, displayName: '限定同学', expiresAt: Date.now() + 86400_000, products: ['P2'] });
    ok(r);
    const c = new Client('limited');
    const login = await c.post('/api/login', { username: name, password: r.data.password });
    ok(login);
    assert.deepEqual(login.data.session.products.sort(), ['KIT', 'P2']);
    assert.ok(login.data.session.expiresAt <= Date.now() + 86400_000, 'session capped at account expiry');
    ok(await c.get('/api/doc/KIT/T_CV'));
    isErr(await c.get('/api/doc/P5/D1'), 403);
    ok(await admin.del(`/api/admin/students/${name}`));
  });

  await t.test('student: delete -> session dead, login fails, gone from list', async () => {
    isErr(await admin.del('/api/admin/students/nobody_here'), 404);
    isErr(await admin.post('/api/admin/students/nobody_here/disable', {}), 404);
    ok(await admin.del(`/api/admin/students/${username}`));
    isErr(await student.get('/api/doc/KIT/T_MAIL'), 401);
    isErr(await new Client('s3').post('/api/login', { username, password }), 401);
    const list = await admin.get('/api/admin/students');
    assert.ok(!list.data.students.some((s) => s.username === username));
  });

  await t.test('logout clears the cookie and deletes the session', async () => {
    const r = await admin.post('/api/admin/keys', { products: ['P2'] });
    const c = new Client('logout');
    ok(await c.post('/api/redeem', { code: r.data.code }));
    const token = c.cookies.get('bys');
    const out = await c.post('/api/logout', {});
    ok(out);
    assert.ok(out.setCookies.some((s) => /^bys=;.*Max-Age=0/.test(s)));
    assert.equal((await c.get('/api/me')).data.session, null);
    // the old token is dead server-side too
    c.cookies.set('bys', token);
    isErr(await c.get('/api/doc/P2/P2_00'), 401);
  });

  await t.test('rate limits: redeem 10/min, login 10/min, admin login 5/min per IP -> 429', async () => {
    const r = new Client('rl-redeem');
    for (let i = 0; i < 10; i++) isErr(await r.post('/api/redeem', { code: 'ZZZZ-ZZZZ-ZZZZ' }), 404);
    isErr(await r.post('/api/redeem', { code: 'ZZZZ-ZZZZ-ZZZZ' }), 429);
    const l = new Client('rl-login');
    for (let i = 0; i < 10; i++) isErr(await l.post('/api/login', { username: 'nobody_here', password: 'x1x2x3x4x5' }), 401);
    isErr(await l.post('/api/login', { username: 'nobody_here', password: 'x1x2x3x4x5' }), 429);
    const a = new Client('rl-admin');
    for (let i = 0; i < 5; i++) isErr(await a.post('/api/admin/login', { password: 'nope' }), 401);
    const blocked = await a.post('/api/admin/login', { password: ADMIN_PW });
    isErr(blocked, 429);
    assert.equal(a.cookies.size, 0, 'a rate-limited correct password must not log in');
    // other IPs are unaffected
    ok(await new Client('rl-other').post('/api/admin/login', { password: ADMIN_PW }));
  });

  await t.test('minutes=1 key locks after ~70 s', async () => {
    const waitMs = shortKey.createdAt + SHORT_KEY_WAIT_MS - Date.now();
    if (waitMs > 0) {
      console.log(`[e2e] waiting ${Math.ceil(waitMs / 1000)} s for the 1-minute key to expire…`);
      await sleep(waitMs);
    }
    const doc = await shortReader.get('/api/doc/P2/P2_00');
    assert.ok([401, 403].includes(doc.status), `expired key doc status ${doc.status}`);
    isErr(doc, doc.status);
    const dl = await shortReader.get('/api/download/P2');
    assert.ok([401, 403].includes(dl.status));
    assert.equal((await shortReader.get('/api/me')).data.session, null);
    isErr(await new Client('short2').post('/api/redeem', { code: shortKey.code }), 404, /密钥无效或已过期/);
    const list = await admin.get('/api/admin/keys');
    assert.ok(!list.data.keys.some((k) => k.code === shortKey.code));
  });
});
