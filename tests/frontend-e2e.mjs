// Front-end end-to-end walkthrough + screenshots against tests/mock-api.mjs (test only).
//
//   node tests/frontend-build.mjs --only site,library,login,admin --out test-artifacts/frontend-dist
//   node tests/frontend-e2e.mjs            # starts the mock on :8790, runs, stops it
//
// Screenshots: test-artifacts/screens/frontend-*.png   Summary: test-artifacts/frontend-e2e.json
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startMock } from './mock-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8790;
const BASE = `http://localhost:${PORT}`;
const SHOTS = join(ROOT, 'test-artifacts', 'screens');
const DL = join(ROOT, 'test-artifacts', 'frontend-downloads');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ADMIN_PW = process.env.MOCK_ADMIN_PASSWORD || 'mock-admin';
mkdirSync(SHOTS, { recursive: true });
mkdirSync(DL, { recursive: true });

const DESKTOP = { viewport: { width: 1366, height: 900, deviceScaleFactor: 1 }, userAgent: '' };
const MOBILE = {
  viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
const WECHAT_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x1800322c) NetType/WIFI Language/zh_CN';

const results = [];
const problems = [];
function check(name, ok, note = '') {
  results.push({ name, ok: !!ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage(ctx, profile = DESKTOP, label = '') {
  const page = await ctx.newPage();
  await page.setViewport(profile.viewport);
  if (profile.userAgent) await page.setUserAgent(profile.userAgent);
  await page.evaluateOnNewDocument(() => {
    window.__clip = null;
    window.__blobs = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { window.__blobs.push(b); return orig(b); };
    if (navigator.clipboard) navigator.clipboard.writeText = async (t) => { window.__clip = t; };
  });
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (401|403|404)/.test(m.text())) {
      problems.push(`[${label}] console.error: ${m.text()}`);
    }
  });
  return page;
}
async function shot(page, name, fullPage = false) {
  await sleep(250);
  await page.screenshot({ path: join(SHOTS, `frontend-${name}.png`), fullPage });
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim()).catch(() => null);
const exists = (page, sel) => page.$(sel).then((e) => !!e);
async function clickText(page, sel, label) {
  const handles = await page.$$(sel);
  for (const h of handles) {
    const t = await h.evaluate((e) => e.textContent.trim());
    if (t.includes(label)) { await h.click(); return true; }
  }
  throw new Error(`no ${sel} containing "${label}"`);
}

const mock = process.env.NO_MOCK ? null : await startMock({ port: PORT });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--lang=zh-CN', '--font-render-hinting=none'] });

try {
  /* ================= admin ================= */
  const admin = await browser.createBrowserContext();
  let ap = await newPage(admin, DESKTOP, 'admin');
  await ap.goto(`${BASE}/admin/`, { waitUntil: 'networkidle0' });
  check('admin: login form shown without session', await exists(ap, '#adm-pw'));
  await shot(ap, 'admin-login-desktop');
  await ap.type('#adm-pw', 'wrong-password');
  await ap.click('.adm-login-card button[type=submit]');
  await ap.waitForFunction(() => document.querySelector('.form-error')?.textContent.includes('密码不正确'));
  check('admin: wrong password shows friendly error', true);
  await ap.$eval('#adm-pw', (e) => { e.value = ''; });
  await ap.type('#adm-pw', ADMIN_PW);
  await ap.click('.adm-login-card button[type=submit]');
  await ap.waitForSelector('.issue-form');
  check('admin: login succeeds', true);
  await shot(ap, 'admin-issue-empty-desktop');

  const issued = async (page) => {
    await page.waitForFunction((n) => document.querySelectorAll('.code-big').length && window.__lastCode !== document.querySelector('.code-big').textContent, {}, null);
    const c = await text(page, '.code-big');
    await page.evaluate((v) => { window.__lastCode = v; }, c);
    return c;
  };
  await ap.type('#iss-label', '测试买家A');
  await ap.click('.ptile[data-id="P1"] .btn');
  const code1 = await issued(ap);
  check('admin: single-product key issued', /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code1), code1);
  await ap.click('.result-acts .btn.blue');
  const script = await ap.evaluate(() => window.__clip);
  check('admin: send script contains origin, code and steps', script?.includes(`${BASE}/library/`) && script.includes(code1) && script.includes('下载 PDF'), script?.split('\n').slice(0, 5).join(' / '));
  await ap.click('.result-acts .btn.primary');
  check('admin: copy key copies formatted code', (await ap.evaluate(() => window.__clip)) === code1);

  await ap.$eval('#iss-label', (e) => { e.value = ''; e.dispatchEvent(new Event('input')); });
  await ap.click('.ptile[data-id="P2"] input');
  await ap.click('.ptile[data-id="P5"] input');
  check('admin: combo bar appears for multi-select', await ap.$eval('.combo-bar', (e) => !e.hidden));
  await ap.click('.combo-bar .btn.primary');
  const code2 = await issued(ap);
  const meta2 = await text(ap, '.result-meta');
  check('admin: combined key for P2+P5', meta2.includes('理工科面试题库') && meta2.includes('DFT'), meta2);
  await ap.select('#iss-min', '60');
  await ap.click('.ptile[data-id="P4"] .btn');
  const code3 = await issued(ap);
  check('admin: 60-minute P4 key', (await text(ap, '.result-meta')).includes('多校面经合集'));
  await shot(ap, 'admin-issued-desktop');

  await clickText(ap, '.adm-tabs .seg-btn', '有效密钥');
  await ap.waitForFunction(() => document.querySelectorAll('.krow').length >= 3);
  check('admin: active key list shows 3 keys', (await ap.$$('.krow')).length === 3);
  await shot(ap, 'admin-keys-desktop');

  await clickText(ap, '.adm-tabs .seg-btn', '学员账号');
  await ap.waitForSelector('.stu-list .empty, .stu-list .srow');
  check('admin: student expiry defaults to Oct 31', /-10-31$/.test(await ap.$eval('#st-exp', (e) => e.value)), await ap.$eval('#st-exp', (e) => e.value));
  await ap.type('#st-user', 'Stu_Test');
  await ap.type('#st-name', '测试同学');
  await ap.click('.stu-grid form button[type=submit]');
  await ap.waitForSelector('dialog.cred[open]');
  const stuPw = await text(ap, 'dialog.cred code.pw');
  check('admin: student created, password shown once', /^[A-Za-z0-9]{10}$/.test(stuPw), stuPw);
  await shot(ap, 'admin-cred-desktop');
  await ap.click('dialog.cred .sheet-foot .btn.primary');
  const cred = await ap.evaluate(() => window.__clip);
  check('admin: copy account info has login URL + password', cred?.includes(`${BASE}/login/`) && cred.includes(stuPw) && cred.includes('stu_test'));
  await ap.click('dialog.cred .sheet-close');
  await ap.waitForFunction(() => !document.querySelector('dialog.cred'));
  await ap.waitForFunction(() => document.querySelectorAll('.srow').length === 1);

  await ap.type('#st-user', 'stu_tmp');
  await ap.click('.stu-grid .pick:nth-child(2) input'); // 指定资料
  await ap.click('.st-picks .pick input[value="P1"]');
  await ap.click('.stu-grid form button[type=submit]');
  await ap.waitForSelector('dialog.cred[open]');
  await ap.click('dialog.cred .sheet-close');
  await ap.waitForFunction(() => document.querySelectorAll('.srow').length === 2);
  const rowBtn = async (user, label) => {
    const rows = await ap.$$('.srow');
    for (const r of rows) {
      if ((await r.evaluate((e) => e.textContent)).includes(user)) {
        for (const b of await r.$$('button')) if ((await b.evaluate((e) => e.textContent)).includes(label)) return b;
      }
    }
    throw new Error(`no ${label} for ${user}`);
  };
  await (await rowBtn('stu_tmp', '重置密码')).click();
  await ap.waitForSelector('dialog.cred[open]');
  check('admin: reset password shows new password', /^[A-Za-z0-9]{10}$/.test(await text(ap, 'dialog.cred code.pw')));
  await ap.click('dialog.cred .sheet-close');
  await ap.waitForFunction(() => !document.querySelector('dialog.cred'));
  await (await rowBtn('stu_tmp', '停用')).click();
  await ap.waitForFunction(() => [...document.querySelectorAll('.srow')].some((r) => r.textContent.includes('stu_tmp') && r.textContent.includes('已停用')));
  check('admin: disable student', true);
  await (await rowBtn('stu_tmp', '启用')).click();
  await ap.waitForFunction(() => [...document.querySelectorAll('.srow')].some((r) => r.textContent.includes('stu_tmp') && r.textContent.includes('正常')));
  check('admin: enable student', true);
  await shot(ap, 'admin-students-desktop');
  await (await rowBtn('stu_tmp', '删除')).click();
  await ap.waitForFunction(() => document.querySelectorAll('.srow').length === 1);
  check('admin: delete student', true);

  // admin on mobile (same login)
  const apm = await newPage(admin, MOBILE, 'admin-m');
  await apm.goto(`${BASE}/admin/`, { waitUntil: 'networkidle0' });
  await apm.waitForSelector('.issue-form');
  await shot(apm, 'admin-issue-mobile');
  await apm.click('.ptile[data-id="P1"] .btn');
  await apm.waitForSelector('.code-big');
  await sleep(600);
  await apm.evaluate(() => document.querySelector('.issue-result').scrollIntoView());
  await shot(apm, 'admin-issued-mobile');
  await clickText(apm, '.adm-tabs .seg-btn', '有效密钥');
  await apm.waitForSelector('.krow');
  await shot(apm, 'admin-keys-mobile', true);
  await clickText(apm, '.adm-tabs .seg-btn', '学员账号');
  await apm.waitForSelector('.srow');
  await shot(apm, 'admin-students-mobile', true);
  await apm.close();

  // admin previewing the library / reader
  const apv = await newPage(admin, DESKTOP, 'admin-preview');
  await apv.goto(`${BASE}/library/`, { waitUntil: 'networkidle0' });
  await apv.waitForSelector('.unlock');
  check('library(admin): shows admin status card', (await text(apv, '.unlock h2')).includes('管理员'));
  await apv.goto(`${BASE}/library/read.html?p=P2`, { waitUntil: 'networkidle0' });
  await apv.waitForSelector('.rd-doc h1');
  check('reader(admin): labelled as admin preview, no download', (await text(apv, '.rd-chip')).includes('管理员预览') && !(await apv.evaluate(() => document.body.innerText.includes('下载 PDF'))));
  await shot(apv, 'reader-admin-desktop');
  await apv.close();

  /* ================= public pages ================= */
  const pub = await browser.createBrowserContext();
  for (const [prof, tag] of [[DESKTOP, 'desktop'], [MOBILE, 'mobile']]) {
    const p = await newPage(pub, prof, `public-${tag}`);
    await p.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await shot(p, `home-${tag}`, true);
    if (tag === 'desktop') {
      const author = await text(p, '.author-text');
      check('home: author sentence exact', author === '作者本科就读于末流211电子科学与技术专业，推免至北京大学人工智能方向；推免期间获得清北及华五高校offer；有西湖大学、KAUST、香港大学、北京大学等科研实践经历。');
      const body = await p.evaluate(() => document.body.innerText);
      for (const price of ['¥99', '¥199', '¥159', '¥299', '¥269', '¥249', '¥999', '¥1999', '¥29.9', '¥49.9', '¥59.9', '¥169', '按需评估']) {
        if (!body.includes(price)) check(`home: price ${price} present`, false);
      }
      check('home: all listed prices present', ['¥99', '¥1999', '¥29.9', '¥59.9', '¥169', '按需评估'].every((x) => body.includes(x)));
      check('home: no internal terms', !/KV|会话|token|sale_ready|Codex/i.test(body));
    }
    await p.click('[data-svc="T_RUNALL"]');
    await p.waitForFunction(() => document.querySelector('#svc-sheet-body')?.textContent.length > 50);
    check(`home(${tag}): service sheet loads fragment`, true);
    await shot(p, `home-sheet-${tag}`);
    await p.keyboard.press('Escape');

    await p.goto(`${BASE}/library/`, { waitUntil: 'networkidle0' });
    await p.waitForSelector('.pcard');
    if (tag === 'desktop') {
      check('library: KIT hidden without student session', !(await p.evaluate(() => document.body.innerText.includes('陪跑学员工具包'))));
      check('library: P3 grouped into one card', (await p.$$('#group-P3')).length === 1);
    }
    const groupOpen = await p.$eval('#group-P3 details', (d) => d.open);
    check(`library(${tag}): single-school group ${tag === 'desktop' ? 'expanded' : 'collapsed'} by default`, groupOpen === (tag === 'desktop'));
    if (!groupOpen) await p.click('#group-P3 summary');
    await shot(p, `library-locked-${tag}`, true);

    await p.goto(`${BASE}/library/item.html?p=P1#preview`, { waitUntil: 'networkidle0' });
    await p.waitForFunction(() => document.querySelector('#pane-preview .prose')?.textContent.length > 20);
    check(`item(${tag}): preview tab opens from #preview`, await p.$eval('#pane-preview', (e) => !e.hidden));
    await shot(p, `item-preview-${tag}`);
    await p.click('.tab[data-tab="intro"]');
    await shot(p, `item-locked-${tag}`, true);

    await p.goto(`${BASE}/library/read.html?p=P1`, { waitUntil: 'networkidle0' });
    await p.waitForSelector('.rd-lock');
    check(`reader(${tag}): locked without session`, (await text(p, '.rd-lock h1')).includes('需要解锁'));
    await shot(p, `reader-locked-${tag}`);

    await p.goto(`${BASE}/login/`, { waitUntil: 'networkidle0' });
    await p.waitForSelector('.login-form');
    await shot(p, `login-${tag}`);
    await p.close();
  }

  /* ================= buyer with key ================= */
  const buyer = await browser.createBrowserContext();
  const bp = await newPage(buyer, DESKTOP, 'buyer');
  await bp.goto(`${BASE}/library/`, { waitUntil: 'networkidle0' });
  await bp.type('.unlock .key-input', 'AAAA-BBBB-CCCC');
  await bp.click('.unlock .key-form button[type=submit]');
  await bp.waitForFunction(() => document.querySelector('.unlock .form-error')?.textContent.includes('密钥无效'));
  check('buyer: wrong key -> friendly error with next step', (await text(bp, '.unlock .form-error')).includes('联系作者'));
  await bp.$eval('.unlock .key-input', (e) => { e.value = ''; });
  await bp.type('.unlock .key-input', code1.toLowerCase().replace(/-/g, ' '));
  check('buyer: key input auto-formats', /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(await bp.$eval('.unlock .key-input', (e) => e.value)));
  await bp.click('.unlock .key-form button[type=submit]');
  await bp.waitForSelector('.unlock.on');
  await sleep(1100);
  const cd = await text(bp, '.unlock [data-cd]');
  check('buyer: unlocked card shows countdown', /^(2\d|1\d|\d):\d\d$|^\d\d:\d\d$/.test(cd), cd);
  check('buyer: P1 card marked unlocked', await bp.evaluate(() => [...document.querySelectorAll('.pcard.on h3')].some((h) => h.textContent.includes('保研经验指南'))));
  await shot(bp, 'library-unlocked-desktop', true);

  await bp.goto(`${BASE}/library/item.html?p=P1`, { waitUntil: 'networkidle0' });
  await bp.waitForSelector('#buy .btn.blue');
  check('buyer: item page shows 在线阅读 + 下载 PDF', (await text(bp, '#buy')).includes('在线阅读') && (await text(bp, '#buy')).includes('下载 PDF'));
  await shot(bp, 'item-unlocked-desktop');

  await bp.goto(`${BASE}/library/read.html?p=P1`, { waitUntil: 'networkidle0' });
  await bp.waitForSelector('.rd-doc h1');
  await sleep(1100);
  check('reader(key): countdown banner', /\d\d:\d\d/.test(await text(bp, '.rd-banner [data-cd]')));
  const wm = await bp.$eval('.wm-layer', (e) => ({ bg: getComputedStyle(e).backgroundImage, pe: getComputedStyle(e).pointerEvents }));
  check('reader(key): watermark layer tiled, pointer-events none', wm.bg.startsWith('url(') && wm.pe === 'none');
  check('reader(key): watermark contains code', decodeURIComponent(wm.bg).includes(code1));
  check('reader(key): table wrapped for scrolling', await exists(bp, '.rd-doc .table-wrap table'));
  check('reader(key): TOC lists sections', (await bp.$$('.rd-toc a')).length >= 4);
  check('reader: screenshot notice present', (await bp.evaluate(() => document.body.innerText)).includes('只读保护无法阻止截图，请勿外传'));
  await shot(bp, 'reader-key-desktop');
  await bp.evaluate(() => document.querySelector('.rd-doc table').scrollIntoView({ block: 'center' }));
  await shot(bp, 'reader-key-table-desktop');
  // SPA navigation to the next document
  const firstTitle = await text(bp, '.rd-doc h1');
  await bp.click('.rd-pager a.next');
  await bp.waitForFunction((t) => document.querySelector('.rd-doc h1')?.textContent !== t, {}, firstTitle);
  check('reader(key): next-doc navigation updates URL', bp.url().includes('d=P1_01') || bp.url().includes('&d='), bp.url());

  // download + watermark
  check('reader(key): switching documents jumps to top', (await bp.evaluate(() => scrollY)) === 0, `scrollY=${await bp.evaluate(() => scrollY)}`);
  const hit = await bp.evaluate(() => {
    const b = document.querySelector('.rd-banner .btn');
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { onTop: b.contains(el), el: el?.className || el?.tagName, y: r.y, scrollY };
  });
  check('reader(key): download button is not covered by another element', hit.onTop, JSON.stringify(hit));
  await clickText(bp, '.rd-banner .btn', '下载 PDF');
  await bp.waitForFunction(() => window.__blobs.length > 0 || document.querySelector('.toast.error'), { timeout: 20000 });
  const dlErr = await text(bp, '.toast.error');
  if (dlErr) throw new Error(`download failed: ${dlErr}`);
  const b64 = await bp.evaluate(async () => {
    const b = window.__blobs.at(-1);
    const buf = new Uint8Array(await b.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const pdfPath = join(DL, 'P1-watermarked.pdf');
  writeFileSync(pdfPath, Buffer.from(b64, 'base64'));
  const py = `import sys, pymupdf
d = pymupdf.open(sys.argv[1])
texts = [p.get_text() for p in d]
print(len(d))
print(all('LICENSED' in t for t in texts))
print(texts[0].split('LICENSED')[1].splitlines()[0].strip() if 'LICENSED' in texts[0] else '')
d[0].get_pixmap(dpi=70).save(sys.argv[2])`;
  const out = execFileSync('python', ['-I', '-c', py, pdfPath, join(SHOTS, 'frontend-pdf-watermark-page1.png')], { encoding: 'utf8' }).trim().split(/\r?\n/);
  check('download: PDF has watermark on every page', out[1] === 'True', `pages=${out[0]} text="LICENSED ${out[2]}"`);
  check('download: watermark carries the key code + date', out[2]?.includes(code1) && /\d{4}-\d{2}-\d{2}/.test(out[2]), out[2]);

  // mobile reader + drawer
  const bm = await newPage(buyer, MOBILE, 'buyer-m');
  await bm.goto(`${BASE}/library/read.html?p=P1&d=P1_01`, { waitUntil: 'networkidle0' });
  await bm.waitForSelector('.rd-doc h1');
  await shot(bm, 'reader-key-mobile');
  await bm.click('.rd-menu');
  await sleep(400);
  check('reader(mobile): drawer opens', await bm.$eval('.rd-side', (e) => e.classList.contains('open')));
  await shot(bm, 'reader-drawer-mobile');
  await bm.goto(`${BASE}/library/`, { waitUntil: 'networkidle0' });
  await bm.waitForSelector('.unlock.on');
  await shot(bm, 'library-unlocked-mobile', true);
  await bm.goto(`${BASE}/library/item.html?p=P1`, { waitUntil: 'networkidle0' });
  await bm.waitForSelector('#buy .btn.blue');
  await shot(bm, 'item-unlocked-mobile');
  await bm.close();

  // WeChat download tip
  const wx = await newPage(buyer, { ...MOBILE, userAgent: WECHAT_UA }, 'buyer-wx');
  await wx.goto(`${BASE}/library/read.html?p=P1`, { waitUntil: 'networkidle0' });
  await wx.waitForSelector('.rd-doc h1');
  await clickText(wx, '.rd-banner .btn', '下载 PDF');
  await wx.waitForSelector('dialog.wx-tip[open]');
  check('download(WeChat): shows open-in-browser tip', (await text(wx, 'dialog.wx-tip')).includes('在浏览器中打开'));
  await shot(wx, 'reader-wechat-tip-mobile');
  await wx.close();

  // expiry -> auto lock
  await bp.evaluate(() => fetch('/__mock/expire-in?ms=4000', { method: 'POST' }));
  await bp.reload({ waitUntil: 'networkidle0' });
  await bp.waitForSelector('.rd-doc h1');
  await bp.waitForSelector('.rd-lock', { timeout: 12000 });
  check('reader(key): auto-locks at expiry', (await text(bp, '.rd-lock h1')).includes('阅读时间已到'));
  check('reader(key): document text removed after lock', !(await exists(bp, '.rd-doc')));
  await shot(bp, 'reader-expired-desktop');
  await bp.goto(`${BASE}/library/`, { waitUntil: 'networkidle0' });
  check('library: locked again after expiry', !(await exists(bp, '.unlock.on')));

  /* ================= second buyer: scope + revoke ================= */
  const buyer2 = await browser.createBrowserContext();
  const b2 = await newPage(buyer2, DESKTOP, 'buyer2');
  await b2.goto(`${BASE}/library/item.html?p=P5`, { waitUntil: 'networkidle0' });
  await b2.type('#buy .key-input', code2);
  await b2.click('#buy .key-form button[type=submit]');
  await b2.waitForFunction(() => document.querySelector('#buy')?.textContent.includes('在线阅读'));
  check('buyer2: unlock from item page', true);
  await b2.goto(`${BASE}/library/read.html?p=P1`, { waitUntil: 'networkidle0' });
  await b2.waitForSelector('.rd-lock');
  check('buyer2: other product stays locked', (await text(b2, '.rd-lock h1')).includes('不包含'));
  await b2.goto(`${BASE}/library/read.html?p=P5`, { waitUntil: 'networkidle0' });
  await b2.waitForSelector('.rd-doc h1');
  // admin revokes code2
  await clickText(ap, '.adm-tabs .seg-btn', '有效密钥');
  await ap.waitForNetworkIdle({ idleTime: 300 });
  await ap.waitForSelector('.krow');
  const rows = await ap.$$('.krow');
  for (const r of rows) {
    if ((await r.evaluate((e) => e.textContent)).includes(code2)) { await (await r.$('.btn.danger')).click(); break; }
  }
  await ap.waitForFunction((c) => [...document.querySelectorAll('.krow')].some((r) => r.textContent.includes(c) && r.textContent.includes('已撤销')), {}, code2);
  check('admin: revoke key', true);
  await b2.click('.rd-pager a.next');
  await b2.waitForSelector('.rd-lock', { timeout: 8000 });
  check('buyer2: revoked key locks on next request', (await text(b2, '.rd-lock h1')).includes('锁定'));
  await shot(b2, 'reader-revoked-desktop');

  /* ================= P4 key includes P3 ================= */
  const buyer3 = await browser.createBrowserContext();
  const b3 = await newPage(buyer3, DESKTOP, 'buyer3');
  await b3.goto(`${BASE}/library/`, { waitUntil: 'networkidle0' });
  await b3.type('.unlock .key-input', code3);
  await b3.click('.unlock .key-form button[type=submit]');
  await b3.waitForSelector('.unlock.on');
  const p3id = await b3.$eval('#group-P3 li a.gname', (a) => new URL(a.href).searchParams.get('p'));
  check('buyer3: P4 key unlocks P3 group', await b3.$eval('#group-P3', (e) => e.classList.contains('on')));
  await b3.goto(`${BASE}/library/read.html?p=${p3id}`, { waitUntil: 'networkidle0' });
  await b3.waitForSelector('.rd-doc h1');
  check('buyer3: can read a P3 item', true);
  await b3.goto(`${BASE}/library/read.html?p=P4`, { waitUntil: 'networkidle0' });
  await b3.waitForSelector('.rd-doc h1');
  check('buyer3: P4 reader lists included single-school items', await exists(b3, '.rd-inc'));

  /* ================= student ================= */
  const stu = await browser.createBrowserContext();
  const sp = await newPage(stu, DESKTOP, 'student');
  await sp.goto(`${BASE}/login/`, { waitUntil: 'networkidle0' });
  await sp.type('.login-form input[name=username]', 'stu_test');
  await sp.type('.login-form input[name=password]', 'wrongpass00');
  await sp.click('.login-form button[type=submit]');
  await sp.waitForFunction(() => document.querySelector('.login-form .form-error')?.textContent.length > 0);
  check('student: wrong password message', (await text(sp, '.login-form .form-error')).includes('联系作者'));
  await sp.$eval('.login-form input[name=password]', (e) => { e.value = ''; });
  await sp.type('.login-form input[name=password]', stuPw);
  await Promise.all([sp.waitForNavigation({ waitUntil: 'networkidle0' }), sp.click('.login-form button[type=submit]')]);
  check('student: redirected to /library/', new URL(sp.url()).pathname === '/library/', sp.url());
  await sp.waitForSelector('.unlock.on.student');
  check('student: KIT visible after login', await sp.evaluate(() => document.body.innerText.includes('陪跑学员工具包')));
  await shot(sp, 'library-student-desktop', true);
  await sp.goto(`${BASE}/library/item.html?p=P2`, { waitUntil: 'networkidle0' });
  await sp.waitForSelector('#buy .btn.blue');
  check('student: no download button on item page', !(await text(sp, '#buy')).includes('下载 PDF'));
  await sp.goto(`${BASE}/library/read.html?p=KIT`, { waitUntil: 'networkidle0' });
  await sp.waitForSelector('.rd-doc h1');
  check('student: reader has no download button', !(await sp.evaluate(() => document.body.innerText.includes('下载 PDF'))));
  check('student: read-only class', await sp.$eval('body', (b) => b.classList.contains('ro')));
  check('student: user-select none on text', (await sp.$eval('.rd-doc p', (e) => getComputedStyle(e).userSelect)) === 'none');
  const blocked = await sp.evaluate(() => {
    const p = document.querySelector('.rd-doc p');
    const ev = (type) => { const e = new Event(type, { bubbles: true, cancelable: true }); p.dispatchEvent(e); return e.defaultPrevented; };
    return { copy: ev('copy'), cut: ev('cut'), contextmenu: ev('contextmenu'), selectstart: ev('selectstart') };
  });
  check('student: copy/cut/contextmenu/selectstart blocked', Object.values(blocked).every(Boolean), JSON.stringify(blocked));
  const ctrlC = await sp.evaluate(() => { const e = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }); document.querySelector('.rd-doc').dispatchEvent(e); return e.defaultPrevented; });
  check('student: Ctrl+C blocked', ctrlC);
  const dl = await sp.evaluate(() => fetch('/api/download/P1').then(async (r) => ({ s: r.status, e: (await r.json()).error })));
  check('student: /api/download returns 403', dl.s === 403, dl.e);
  await shot(sp, 'reader-student-desktop');
  await sp.emulateMediaType('print');
  const pr = await sp.evaluate(() => ({ app: getComputedStyle(document.getElementById('app')).display, block: getComputedStyle(document.querySelector('.print-block')).display }));
  check('student: print hides the document', pr.app === 'none' && pr.block === 'block', JSON.stringify(pr));
  await shot(sp, 'reader-student-print');
  await sp.emulateMediaType('screen');
  const sm = await newPage(stu, MOBILE, 'student-m');
  await sm.goto(`${BASE}/library/read.html?p=P2`, { waitUntil: 'networkidle0' });
  await sm.waitForSelector('.rd-doc h1');
  await shot(sm, 'reader-student-mobile');
  await sm.goto(`${BASE}/library/`, { waitUntil: 'networkidle0' });
  await sm.waitForSelector('.unlock.on');
  await shot(sm, 'library-student-mobile');
  await sm.goto(`${BASE}/login/`, { waitUntil: 'networkidle0' });
  await sm.waitForSelector('.login-card');
  await shot(sm, 'login-loggedin-mobile');
  await sm.close();

  // admin disables the student -> next request is refused
  await clickText(ap, '.adm-tabs .seg-btn', '学员账号');
  await ap.waitForNetworkIdle({ idleTime: 300 });
  await ap.waitForSelector('.srow');
  for (const b of await ap.$$('.srow button')) if ((await b.evaluate((e) => e.textContent)).includes('停用')) { await b.click(); break; }
  await ap.waitForFunction(() => document.querySelector('.srow')?.textContent.includes('已停用'));
  await sp.click('.rd-pager a.next');
  await sp.waitForSelector('.rd-lock', { timeout: 8000 });
  check('student: disabled account is locked out', (await text(sp, '.rd-lock')).includes('停用'));
  await shot(sp, 'reader-student-disabled-desktop');
} catch (e) {
  check('e2e run completed without exception', false, e.stack?.split('\n').slice(0, 3).join(' | '));
  let i = 0;
  for (const ctx of browser.browserContexts()) {
    for (const pg of await ctx.pages()) {
      try { await pg.screenshot({ path: join(SHOTS, `frontend-zz-failure-${++i}.png`) }); console.log('failure shot', i, pg.url()); } catch { /* ignore */ }
    }
  }
} finally {
  await browser.close();
  await mock?.close();
}

const failed = results.filter((r) => !r.ok);
writeFileSync(join(ROOT, 'test-artifacts', 'frontend-e2e.json'), JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results, problems }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (problems.length) console.log('Console/page problems:\n  ' + [...new Set(problems)].join('\n  '));
process.exitCode = failed.length ? 1 : 0;
