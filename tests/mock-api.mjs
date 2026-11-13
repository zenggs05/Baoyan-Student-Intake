// Front-end mock server (test only). Serves a built front end plus fake /data/* and /api/* that follow
// docs/ARCHITECTURE.md §4 (shapes, status codes, cookie, Origin check), with in-memory state.
//
//   node tests/frontend-build.mjs --only site,library,login,admin --out test-artifacts/frontend-dist
//   node tests/mock-api.mjs            # http://localhost:8790  (admin password: env MOCK_ADMIN_PASSWORD or "mock-admin")
//
// /data/* comes from <dist>/data when the build copied .content/public, otherwise from small synthetic
// fixtures. Document bodies are always synthetic placeholder text (no real content lives in this file).
// Test-only hooks (no Origin check): POST /__mock/expire-in?ms=N (shorten the caller's key session),
// POST /__mock/reset.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { addStampPlaceholders, findStampSlots, applyPdfStamp } from '../scripts/lib-content/pdf-stamp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
};
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
const DAY = 86400e3;

/* ---------------- synthetic fixtures ---------------- */
const FILLER = [
  '先用一句话写清这一节要解决的问题，再列出判断依据和需要核对的官方来源。',
  '准备时把“事实”“推断”“待确认”分开记录，避免把个人经验当成普遍规则。',
  '每完成一步就在清单上标记版本和日期，方便之后回看和对照修改。',
  '遇到不确定的信息，先查当年官方通知，再与同学或老师交叉核对。',
  '练习时控制在规定时间内作答，结束后对照要点补充遗漏，并记录下一次的改进动作。',
  '表达时优先说明自己做了什么、为什么这样做、结果如何验证以及还有哪些局限。',
  '把长期目标拆成每周可以完成的小任务，并为每个任务写下可检查的完成标准。',
];
const filler = (n, seed) => Array.from({ length: n }, (_, i) => FILLER[(seed + i * 3) % FILLER.length]).join('');

function fakeCatalog() {
  const docs = (prefix, n, titles) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}_${String(i).padStart(2, '0')}`, title: titles?.[i] || `示例章节 ${i}` }));
  const p3 = [['seu', '示例大学·甲学院'], ['pku', '示例大学·乙学院'], ['ion', '示例研究所·夏令营']].map(([s, n]) => ({
    id: `P3-${s}`, title: `单校面经复盘·${n}`, subtitle: '示例副标题', price: 59.9, priceNote: '', sellingPoint: '示例卖点', docCount: 1,
    docs: [{ id: `P3_${s}`, title: n }], preview: s === 'seu', includes: [],
  }));
  return {
    products: [
      { id: 'P1', title: '保研经验指南', subtitle: '示例副标题', price: 29.9, priceNote: '', sellingPoint: '示例卖点：把申请任务拆成可执行步骤', docCount: 6, docs: docs('P1', 6), preview: true, includes: [] },
      { id: 'P2', title: '理工科面试题库', subtitle: '示例副标题', price: 49.9, priceNote: '', sellingPoint: '示例卖点', docCount: 4, docs: docs('P2', 4), preview: true, includes: [] },
      ...p3,
      { id: 'P4', title: '多校面经合集', subtitle: '示例副标题', price: 169, priceNote: '含 30 分钟答疑版 199 元', sellingPoint: '示例卖点', docCount: 3, docs: docs('P4', 3), preview: true, includes: p3.map((p) => p.id) },
      { id: 'P5', title: 'DFT 一周入门笔记', subtitle: '示例副标题', price: 199, priceNote: '含一周答疑版 249 元', sellingPoint: '示例卖点', docCount: 8, docs: docs('P5', 8), preview: true, includes: [] },
      { id: 'KIT', title: '陪跑学员工具包', subtitle: '仅陪跑学员可见', price: null, priceNote: '', sellingPoint: '示例卖点', docCount: 3, docs: docs('KIT', 3), preview: false, includes: [] },
    ],
  };
}

function fakeFragment(kind, id) {
  return `<h1>${kind}示例：${id}</h1>
<h2 id="s1">这是什么</h2><p>${filler(3, 1)}</p>
<h2 id="s2">适合谁</h2><ul><li>${FILLER[0]}</li><li>${FILLER[2]}</li></ul>
<h3 id="s2-1">示例表格</h3><table><thead><tr><th>项目</th><th>说明</th></tr></thead><tbody><tr><td>示例</td><td>${FILLER[4]}</td></tr></tbody></table>
<aside class="disclaimer"><p>示例免责声明：不承诺任何结果。</p></aside>`;
}

function synthDoc(title, seed) {
  const longRow = Array.from({ length: 7 }, (_, i) => `<td>${['准备阶段', '材料版本 v2', '每周两次', '本人完成', '对照官方通知', '记录在清单', '下周复查'][i]}</td>`).join('');
  return `<h1>${title}</h1>
<p>${filler(4, seed)}</p>
<p>${filler(3, seed + 2)}这里有一处<span class="todo" title="示例待补充项">待补充</span>需要作者确认。</p>
<h2 id="d1">一、目标与边界</h2>
<p>${filler(5, seed + 1)}</p>
<ul><li>${FILLER[(seed + 1) % 7]}</li><li>${FILLER[(seed + 3) % 7]}</li><li>${FILLER[(seed + 5) % 7]}</li></ul>
<h3 id="d1-1">1.1 需要准备的材料</h3>
<p>${filler(4, seed + 4)}</p>
<ol><li>${FILLER[0]}</li><li>${FILLER[1]}<ul><li>${FILLER[2]}</li></ul></li><li>${FILLER[3]}</li></ol>
<h3 id="d1-2">1.2 时间安排</h3>
<table><thead><tr><th>阶段</th><th>材料</th><th>频率</th><th>负责人</th><th>依据</th><th>记录方式</th><th>复查</th></tr></thead>
<tbody>${Array.from({ length: 4 }, () => `<tr>${longRow}</tr>`).join('')}</tbody></table>
<h2 id="d2">二、方法与示例</h2>
<p>${filler(6, seed + 2)}行内代码示例：<code>python check.py --input data.csv</code>。</p>
<blockquote><p>${FILLER[(seed + 6) % 7]}</p></blockquote>
<pre><code># 示例：整理清单的脚本（占位）
for item in checklist:
    if item.status != "done":
        print(item.name, item.deadline)
</code></pre>
<h3 id="d2-1">2.1 常见问题</h3>
<p>${filler(5, seed + 3)}</p>
<h2 id="d3">三、复盘与下一步</h2>
<p>${filler(6, seed + 5)}</p>
<p>${filler(4, seed + 6)}</p>
<aside class="disclaimer"><p>本资料由作者本人及合作同学的亲历回忆、已获授权的往年整理资料和公开信息整理而成（此为测试用占位文本）。不承诺推免资格、录取或任何结果。</p></aside>`;
}

async function makePdf(title) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= 3; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Mock PDF - ${title}`, { x: 56, y: 770, size: 18, font: bold, color: rgb(0.09, 0.16, 0.27) });
    page.drawText(`Page ${i} of 3 - placeholder body text for front-end watermark tests.`, { x: 56, y: 740, size: 11, font });
    for (let l = 0; l < 30; l++) page.drawText('Lorem ipsum placeholder line for layout only.', { x: 56, y: 700 - l * 20, size: 10, font, color: rgb(0.35, 0.4, 0.48) });
  }
  await addStampPlaceholders(doc, { title }); // like build-pdf: placeholders that the server fills in per download
  return doc.save();
}

const cnDay = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

/* ---------------- server ---------------- */
export async function startMock({ port = Number(process.env.PORT) || 8790, dist = process.env.MOCK_DIST || join(ROOT, 'test-artifacts', 'frontend-dist'), adminPassword = process.env.MOCK_ADMIN_PASSWORD || 'mock-admin', log = !!process.env.MOCK_LOG } = {}) {
  let catalog;
  try { catalog = JSON.parse(await readFile(join(dist, 'data', 'catalog.json'), 'utf8')); } catch { catalog = fakeCatalog(); }
  // The static catalog has no student-only products (like the real build); the session-aware API still needs KIT.
  if (!catalog.products.some((p) => p.id === 'KIT' || p.studentOnly === true)) {
    catalog = { ...catalog, products: [...catalog.products, fakeCatalog().products.find((p) => p.id === 'KIT')] };
  }
  const products = catalog.products;
  const byId = new Map(products.map((p) => [p.id, p]));
  const isStudentOnly = (p) => p.id === 'KIT' || p.studentOnly === true || p.price == null;

  const S = { keys: new Map(), users: new Map(), sessions: new Map(), rl: new Map() };
  const now = () => Date.now();
  const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  const formatCode = (c) => c.replace(/(.{4})(?=.)/g, '$1-');
  const genCode = () => Array.from({ length: 12 }, () => CROCKFORD[randomInt(32)]).join('');
  const genPw = () => Array.from({ length: 10 }, () => PW_CHARS[randomInt(PW_CHARS.length)]).join('');

  function expand(list, { student = false } = {}) {
    const set = new Set();
    const add = (id) => {
      const p = byId.get(id);
      if (!p || set.has(id)) return;
      set.add(id);
      for (const inc of p.includes || []) {
        if (inc.endsWith('*')) products.filter((q) => q.id.startsWith(inc.slice(0, -1))).forEach((q) => add(q.id));
        else add(inc);
      }
    };
    if (list === 'all') products.filter((p) => !isStudentOnly(p)).forEach((p) => add(p.id));
    else (list || []).forEach(add);
    if (student && list === 'all') products.filter(isStudentOnly).forEach((p) => add(p.id));
    return products.filter((p) => set.has(p.id)).map((p) => p.id);
  }

  const cookieOf = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
  const setCookie = (token, exp) => `bys=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.max(1, Math.ceil((exp - now()) / 1000))}`;
  const clearCookie = 'bys=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

  function currentSession(req) {
    const t = cookieOf(req).bys;
    if (!t) return null;
    const s = S.sessions.get(t);
    if (!s) return null;
    if (s.exp <= now()) { S.sessions.delete(t); return null; }
    return { token: t, ...s };
  }
  function publicSession(s) {
    if (!s) return null;
    const out = { type: s.type, label: s.label || '', displayName: s.displayName || '', products: s.products, expiresAt: s.exp, canDownload: s.type === 'key' };
    if (s.type === 'key') out.code = s.code;
    if (s.type === 'student') out.username = s.sub;
    return out;
  }
  function newSession(sess) {
    const token = randomBytes(32).toString('base64url');
    S.sessions.set(token, sess);
    return token;
  }

  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const send = (res, status, body, headers = {}) => {
    const buf = typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(buf);
  };
  async function readJson(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, '请求格式不正确'); }
  }
  function rateLimit(req, bucket, limit) {
    const k = `${bucket}:${req.socket.remoteAddress}`;
    const t = now();
    const arr = (S.rl.get(k) || []).filter((x) => t - x < 60e3);
    arr.push(t);
    S.rl.set(k, arr);
    if (arr.length > limit) throw new HttpError(429, '尝试次数过多，请稍后再试');
  }

  // Reader check, re-validating the key record / user record on every request (§4.1)
  function requireReader(req) {
    const s = currentSession(req);
    if (!s) throw new HttpError(401, '请先解锁或登录');
    if (s.type === 'key') {
      const rec = S.keys.get(s.sub);
      if (!rec || rec.expiresAt <= now()) { S.sessions.delete(s.token); throw new HttpError(401, '密钥已过期，资料已重新锁定'); }
      if (rec.revoked) { S.sessions.delete(s.token); throw new HttpError(401, '密钥已被撤销'); }
    } else if (s.type === 'student') {
      const u = S.users.get(s.sub);
      if (!u) throw new HttpError(401, '账号不存在，请重新登录');
      if (u.disabled) throw new HttpError(403, '账号已停用');
      if (u.expiresAt <= now()) throw new HttpError(403, '账号已到期');
    }
    return s;
  }
  function requireAdmin(req) {
    const s = currentSession(req);
    if (!s || s.type !== 'admin') throw new HttpError(401, '请先登录管理后台');
    return s;
  }

  async function api(req, res, url) {
    const method = req.method;
    const path = url.pathname;
    if ((method === 'POST' || method === 'DELETE') && !path.startsWith('/__mock/')) {
      const origin = req.headers.origin;
      if (!origin || origin !== `http://${req.headers.host}`) throw new HttpError(403, '请求来源不正确');
    }
    const seg = path.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // drop "api"

    if (path === '/api/catalog' && method === 'GET') {
      const s = currentSession(req);
      const allowed = new Set(s?.products || []);
      return send(res, 200, { products: products.filter((p) => !isStudentOnly(p) || allowed.has(p.id)) });
    }
    if (path === '/api/me' && method === 'GET') return send(res, 200, { session: publicSession(currentSession(req)) });
    if (path === '/api/redeem' && method === 'POST') {
      rateLimit(req, 'auth', 10);
      const { code } = await readJson(req);
      const c = normalizeCode(code);
      const rec = S.keys.get(c);
      if (!rec || rec.expiresAt <= now()) throw new HttpError(404, '密钥无效或已过期');
      if (rec.revoked) throw new HttpError(403, '该密钥已被撤销');
      if (rec.uses >= rec.maxUses) throw new HttpError(403, '该密钥已达到使用次数上限');
      rec.uses += 1;
      const sess = { type: 'key', sub: c, code: formatCode(c), label: rec.label, products: expand(rec.products), exp: rec.expiresAt };
      const token = newSession(sess);
      return send(res, 200, { session: publicSession(sess) }, { 'Set-Cookie': setCookie(token, sess.exp) });
    }
    if (path === '/api/login' && method === 'POST') {
      rateLimit(req, 'auth', 10);
      const { username, password } = await readJson(req);
      const u = S.users.get(String(username || '').toLowerCase());
      if (!u || u.password !== password) throw new HttpError(401, '用户名或密码不正确');
      if (u.disabled) throw new HttpError(403, '账号已停用');
      if (u.expiresAt <= now()) throw new HttpError(403, '账号已到期');
      u.lastLoginAt = now();
      const sess = { type: 'student', sub: u.username, displayName: u.displayName, products: expand(u.products, { student: true }), exp: Math.min(now() + 7 * DAY, u.expiresAt) };
      const token = newSession(sess);
      return send(res, 200, { session: publicSession(sess) }, { 'Set-Cookie': setCookie(token, sess.exp) });
    }
    if (path === '/api/logout' && method === 'POST') {
      const t = cookieOf(req).bys;
      if (t) S.sessions.delete(t);
      return send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
    }
    if (seg[0] === 'doc' && seg.length === 3 && method === 'GET') {
      const s = requireReader(req);
      const [, pid, did] = seg;
      if (!s.products.includes(pid)) throw new HttpError(403, '当前密钥或账号不包含这份资料');
      const p = byId.get(pid);
      const docIndex = p?.docs?.findIndex((d) => d.id === did) ?? -1;
      if (!p || docIndex < 0) throw new HttpError(404, '没有找到这篇文档');
      const doc = p.docs[docIndex];
      const watermark = s.type === 'key'
        ? { line1: `授权 ${s.code}`, line2: `${s.label || '购买者'} · 仅限本人学习` }
        : s.type === 'admin' ? { line1: '管理员预览', line2: '请勿外传' }
          : { line1: `${s.displayName}（${s.sub}）`, line2: '陪跑学员 · 仅限在线查看' };
      return send(res, 200, { html: synthDoc(doc.title, docIndex), title: doc.title, productId: pid, docId: did, watermark }, { 'X-Robots-Tag': 'noindex' });
    }
    if (seg[0] === 'download' && seg.length === 2 && method === 'GET') {
      const s = requireReader(req);
      if (s.type !== 'key') throw new HttpError(403, s.type === 'student' ? '陪跑账号仅支持在线查看' : '下载仅限密钥解锁后使用');
      const pid = seg[1];
      if (!s.products.includes(pid)) throw new HttpError(403, '当前密钥不包含这份资料');
      const p = byId.get(pid);
      // Like the worker: the licence stamp (key code + date) is written on the server, not in the browser.
      const bytes = new Uint8Array(await makePdf(pid));
      if (!applyPdfStamp(bytes, findStampSlots(bytes), { code: s.code, day: cnDay() })) throw new HttpError(404, 'PDF 正在更新');
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${p?.title || pid}.pdf`)}`,
        'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex',
      });
      return res.end(Buffer.from(bytes));
    }

    // ---- admin ----
    if (path === '/api/admin/login' && method === 'POST') {
      rateLimit(req, 'admin', 5);
      const { password } = await readJson(req);
      const a = Buffer.from(String(password || '')), b = Buffer.from(adminPassword);
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new HttpError(401, '密码不正确');
      // Like the worker: an admin may preview everything (read-only, no download)
      const sess = { type: 'admin', sub: 'admin', label: '管理员', products: expand('all', { student: true }), exp: now() + 12 * 3600e3 };
      const token = newSession(sess);
      return send(res, 200, { ok: true }, { 'Set-Cookie': setCookie(token, sess.exp) });
    }
    if (seg[0] === 'admin') {
      requireAdmin(req);
      const a = seg.slice(1);
      if (a[0] === 'products' && method === 'GET') {
        return send(res, 200, { products: products.map((p) => ({ id: p.id, title: p.title, subtitle: p.subtitle, price: p.price ?? null, priceNote: p.priceNote || '', forSale: !isStudentOnly(p), studentOnly: isStudentOnly(p), includes: p.includes || [], docCount: p.docs?.length || 0, pdf: true })) });
      }
      if (a[0] === 'keys' && a.length === 1 && method === 'POST') {
        const body = await readJson(req);
        const ids = Array.isArray(body.products) ? body.products.filter((id) => byId.has(id) && !isStudentOnly(byId.get(id))) : [];
        if (!ids.length) throw new HttpError(400, '请至少选择一个产品');
        const minutes = body.minutes == null ? 30 : Number(body.minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new HttpError(400, '有效期需在 1–1440 分钟之间');
        const maxUses = body.maxUses == null ? 3 : Number(body.maxUses);
        const code = genCode();
        const rec = { code, products: ids, label: String(body.label || '').slice(0, 60), createdAt: now(), expiresAt: now() + minutes * 60e3, maxUses, uses: 0, revoked: false };
        S.keys.set(code, rec);
        return send(res, 200, { code: formatCode(code), expiresAt: rec.expiresAt, products: ids, label: rec.label });
      }
      if (a[0] === 'keys' && a.length === 1 && method === 'GET') {
        const keys = [...S.keys.values()].filter((k) => !k.revoked && k.expiresAt > now())
          .sort((x, y) => y.createdAt - x.createdAt)
          .map((k) => ({ code: formatCode(k.code), products: k.products, label: k.label, expiresAt: k.expiresAt, uses: k.uses, maxUses: k.maxUses, createdAt: k.createdAt }));
        return send(res, 200, { keys });
      }
      if (a[0] === 'keys' && a[2] === 'revoke' && method === 'POST') {
        const rec = S.keys.get(normalizeCode(a[1]));
        if (!rec) throw new HttpError(404, '没有找到这个密钥，它可能已经过期');
        rec.revoked = true;
        return send(res, 200, { ok: true });
      }
      if (a[0] === 'students' && a.length === 1 && method === 'GET') {
        const students = [...S.users.values()].sort((x, y) => y.createdAt - x.createdAt)
          .map(({ password, ...u }) => u);
        return send(res, 200, { students });
      }
      if (a[0] === 'students' && a.length === 1 && method === 'POST') {
        const b = await readJson(req);
        const username = String(b.username || '');
        if (!/^[a-z0-9_]{3,32}$/.test(username)) throw new HttpError(400, '用户名需为 3–32 位小写字母、数字或下划线');
        if (S.users.has(username)) throw new HttpError(400, '这个用户名已经存在');
        if (!(Number(b.expiresAt) > now())) throw new HttpError(400, '到期日需要晚于今天');
        const password = genPw();
        S.users.set(username, { username, displayName: b.displayName || username, products: b.products === 'all' ? 'all' : (b.products || []), expiresAt: Number(b.expiresAt), disabled: false, createdAt: now(), lastLoginAt: null, password });
        return send(res, 200, { username, password });
      }
      const u = a[0] === 'students' && a[1] ? S.users.get(a[1]) : null;
      if (a[0] === 'students' && a[1]) {
        if (!u) throw new HttpError(404, '没有找到这个学员');
        if (a[2] === 'reset' && method === 'POST') { u.password = genPw(); return send(res, 200, { password: u.password }); }
        if (a[2] === 'disable' && method === 'POST') { u.disabled = true; return send(res, 200, { ok: true }); }
        if (a[2] === 'enable' && method === 'POST') { u.disabled = false; return send(res, 200, { ok: true }); }
        if (a.length === 2 && method === 'DELETE') { S.users.delete(u.username); return send(res, 200, { ok: true }); }
      }
    }

    // ---- test hooks ----
    if (path === '/__mock/expire-in' && method === 'POST') {
      const s = currentSession(req);
      if (!s || s.type !== 'key') throw new HttpError(400, 'no key session');
      const ms = Number(url.searchParams.get('ms') || 5000);
      const exp = now() + ms;
      S.sessions.get(s.token).exp = exp;
      S.keys.get(s.sub).expiresAt = exp;
      return send(res, 200, { ok: true, expiresAt: exp });
    }
    if (path === '/__mock/reset' && method === 'POST') {
      S.keys.clear(); S.users.clear(); S.sessions.clear(); S.rl.clear();
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, '接口不存在');
  }

  async function serveFile(res, file) {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  }
  const isFile = (p) => stat(p).then((s) => s.isFile(), () => false);

  async function staticFile(req, res, url) {
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const abs = normalize(join(dist, p));
    if (!abs.startsWith(normalize(dist) + sep) && abs !== normalize(dist)) return send(res, 403, 'forbidden', { 'Content-Type': 'text/plain' });
    if (await isFile(abs)) return serveFile(res, abs);
    if (!extname(abs) && (await isFile(`${abs}.html`))) return serveFile(res, `${abs}.html`);
    if (!extname(abs) && (await isFile(join(abs, 'index.html')))) { res.writeHead(307, { Location: `${url.pathname}/` }); return res.end(); }
    // Synthetic public data when the build has no data/ directory
    let m;
    if (p === '/data/catalog.json') return send(res, 200, { ...catalog, products: products.filter((x) => !isStudentOnly(x)) });
    if ((m = /^\/data\/library\/([^/]+)\/(sale|preview)\.html$/.exec(p)) && byId.has(m[1])) {
      return send(res, 200, fakeFragment(m[2] === 'sale' ? '介绍' : '试读', byId.get(m[1]).title), { 'Content-Type': MIME['.html'] });
    }
    if ((m = /^\/data\/services\/([A-Z_]+)\.html$/.exec(p))) return send(res, 200, fakeFragment('服务', m[1]), { 'Content-Type': MIME['.html'] });
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const t0 = Date.now();
    try {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__mock/')) await api(req, res, url);
      else await staticFile(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.message });
      else { console.error(e); send(res, 500, { error: '服务器内部错误' }); }
    }
    if (log) console.log(`${req.method} ${url.pathname}${url.search} -> ${res.statusCode} (${Date.now() - t0}ms)`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { server, port, state: S, close: () => new Promise((r) => server.close(r)) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const m = await startMock();
  console.log(`[mock-api] http://localhost:${m.port}  (pid ${process.pid})`);
}
