// 集成端到端测试：真实内容 + 真实 Worker（wrangler dev）+ 真实前端，用 puppeteer-core 驱动本机 Chrome 点击界面。
// 对应 docs/ARCHITECTURE.md §8。
//
// 先准备（项目根目录）：
//   node scripts/build-content.mjs && node scripts/build-pdf.mjs
//   node scripts/upload-content.mjs --local --persist-to test-artifacts/integ-state
//   node scripts/build-site.mjs
//   npx wrangler dev --port 8787 --persist-to test-artifacts/integ-state      （另开一个终端，保持运行）
// 再运行：
//   node scripts/e2e.mjs                 # BASE 默认 http://localhost:8787，可用环境变量 BASE 覆盖
//   SKIP_EXPIRY=1 node scripts/e2e.mjs   # 跳过需要等 70 秒的 1 分钟密钥用例
//   ONLY_SHOTS=1 node scripts/e2e.mjs    # 只截公开页面（调样式时用）
//
// 产物：test-artifacts/screens/integ-*.png、test-artifacts/integ-download.pdf、test-artifacts/integ-e2e.json
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { sampleJson } from '../tests/intake-fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.BASE || 'http://localhost:8787').replace(/\/$/, '');
const ART = join(ROOT, 'test-artifacts');
const SHOTS = join(ART, 'screens');
const DL = join(ART, 'integ-downloads');
const PDF_OUT = join(ART, 'integ-download.pdf');
const CHROME = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const INTAKE_KEY = 'baoyan-student-intake:v1';
const ONLY_SHOTS = !!process.env.ONLY_SHOTS;
const SKIP_EXPIRY = !!process.env.SKIP_EXPIRY;

function adminPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const f = join(ROOT, '.dev.vars');
  if (!existsSync(f)) throw new Error('找不到 .dev.vars，无法读取 ADMIN_PASSWORD');
  const m = /^\s*ADMIN_PASSWORD\s*=\s*"?([^"\r\n]*)"?\s*$/m.exec(readFileSync(f, 'utf8'));
  if (!m) throw new Error('.dev.vars 里没有 ADMIN_PASSWORD');
  return m[1];
}
const ADMIN_PW = adminPassword();

mkdirSync(SHOTS, { recursive: true });
rmSync(DL, { recursive: true, force: true });
mkdirSync(DL, { recursive: true });

const DESKTOP = { viewport: { width: 1366, height: 900, deviceScaleFactor: 1 }, userAgent: '' };
const MOBILE = {
  viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};

const results = [];
const problems = [];
function check(name, ok, note = '') {
  results.push({ name, ok: !!ok, note: String(note || '') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  (${note})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- helpers ---------------- */
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
    document.addEventListener('securitypolicyviolation', (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`));
  });
  page.on('dialog', (d) => d.accept());
  page.on('pageerror', (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (401|403|404)/.test(m.text())) {
      problems.push(`[${label}] console.error: ${m.text()}`);
    }
  });
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith(BASE) && !u.startsWith('data:') && !u.startsWith('blob:')) problems.push(`[${label}] 外部请求: ${u}`);
  });
  return page;
}

/** 截图：name 不带前缀和设备后缀，例如 shot(p, 'home', 'desktop') -> integ-home-desktop.png */
async function shot(page, name, tag, { fullPage = false } = {}) {
  await sleep(300);
  await page.evaluate(() => document.querySelector('.toast')?.remove()).catch(() => {});
  const path = join(SHOTS, `integ-${name}-${tag}.png`);
  for (let i = 0; ; i++) {
    try {
      await page.bringToFront();
      let t;
      await Promise.race([
        page.screenshot({ path, fullPage }),
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`截图超时：${name}-${tag}`)), 20000); }),
      ]).finally(() => clearTimeout(t));
      return;
    } catch (e) {
      // Chrome 偶尔返回 "Unable to capture screenshot"，稍等重试
      if (i >= 3) throw e;
      await sleep(600);
    }
  }
}
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.replace(/\s+/g, ' ').trim()).catch(() => null);
const exists = (page, sel) => page.$(sel).then((e) => !!e);
const bodyText = (page) => page.evaluate(() => document.body.innerText);

/** 点击 sel 中文字包含 label 的第一个可见元素（真实鼠标点击） */
async function clickText(page, sel, label) {
  const handles = await page.$$(sel);
  for (const h of handles) {
    const ok = await h.evaluate((e, l) => e.textContent.includes(l) && e.getClientRects().length > 0 && !e.disabled, label);
    if (ok) { await h.click(); return h; }
  }
  throw new Error(`找不到包含「${label}」的 ${sel}`);
}
async function clickNav(page, sel) {
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click(sel)]);
}

/** 让某个浏览器上下文的下载落到 dir */
async function allowDownloads(browser, ctx, dir) {
  const cdp = await browser.target().createCDPSession();
  const params = { behavior: 'allow', downloadPath: dir, eventsEnabled: true };
  if (ctx?.id) params.browserContextId = ctx.id;
  await cdp.send('Browser.setDownloadBehavior', params);
  return cdp;
}
async function waitForFile(dir, ext, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const f = readdirSync(dir).find((x) => x.toLowerCase().endsWith(ext) && !x.endsWith('.crdownload'));
    if (f) { await sleep(300); return join(dir, f); }
    await sleep(200);
  }
  return null;
}

/** 从 .content/kv 里取某篇正文的若干段落文字，用来确认阅读器显示的是真实内容 */
function realSnippets(pid, did, n = 3) {
  const f = join(ROOT, '.content', 'kv', `c__${pid}__${did}.html`);
  if (!existsSync(f)) return [];
  const html = readFileSync(f, 'utf8');
  const out = [];
  for (const m of html.matchAll(/<(h2|h3|p)[^>]*>([\s\S]*?)<\/\1>/g)) {
    const t = m[2].replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
    if (t.length >= 8) out.push(t.slice(0, 18));
    if (out.length >= n) break;
  }
  return out;
}

/* ---------------- run ---------------- */
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true, protocolTimeout: 60000,
  args: ['--no-first-run', '--no-default-browser-check', '--lang=zh-CN', '--font-render-hinting=none'],
});
console.log(`[e2e] Chrome PID ${browser.process()?.pid}，目标 ${BASE}`);

const state = {};
try {
  /* ======================= 1. 公开页面：首页 → 资料库 → P2 详情 → 试读 ======================= */
  const pub = await browser.createBrowserContext();
  {
    const p = await newPage(pub, DESKTOP, 'public');
    await p.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    check('首页可以打开', (await p.title()).length > 0, await p.title());
    await shot(p, 'home', 'desktop');
    await shot(p, 'home-full', 'desktop', { fullPage: true });
    await clickNav(p, '.site-nav a[href="/library/"], header a[href="/library/"]');
    check('首页 → 资料库（点击导航）', new URL(p.url()).pathname.startsWith('/library'), p.url());
    await p.waitForSelector('.pcard');
    const cards = await p.$$eval('.pcard h3', (l) => l.map((e) => e.textContent.trim()));
    check('资料库列出真实产品', cards.some((t) => t.includes('理工科面试题库')) && cards.some((t) => t.includes('多校面经合集')), cards.join(' / '));
    check('资料库未登录不显示学员工具包', !(await bodyText(p)).includes('陪跑学员工具包'));
    await shot(p, 'library', 'desktop');
    await shot(p, 'library-full', 'desktop', { fullPage: true });
    // P3 组（桌面默认展开）
    const open = await p.$eval('#group-P3 details', (d) => d.open);
    check('单校面经复盘分组在桌面端默认展开', open);
    const n3 = await p.$$eval('#group-P3 li', (l) => l.length);
    check('单校面经复盘分组列出全部院校', n3 === 10, `${n3} 所`);
    await p.$eval('#group-P3', (e) => e.scrollIntoView({ block: 'start' }));
    await shot(p, 'p3group', 'desktop');
    // P2 详情
    const p2card = await p.evaluateHandle(() => [...document.querySelectorAll('.pcard')].find((c) => c.querySelector('h3')?.textContent.includes('理工科面试题库')));
    const detail = await p2card.asElement().$('a.btn.primary');
    await Promise.all([p.waitForNavigation({ waitUntil: 'networkidle0' }), detail.click()]);
    check('资料库 → P2 详情（点击「查看详情」）', new URL(p.url()).searchParams.get('p') === 'P2', p.url());
    await p.waitForFunction(() => document.querySelector('#pane-intro .prose, #pane-intro')?.textContent.length > 100);
    check('P2 详情页显示售卖页正文', (await text(p, '.item-hero h1')).includes('理工科面试题库'));
    check('P2 详情页显示完整目录 14 篇', (await p.$$('.item-side .doc-list li')).length === 14);
    check('P2 详情页未解锁时没有「在线阅读」', !(await text(p, '#buy')).includes('在线阅读'));
    await shot(p, 'item-P2', 'desktop');
    await shot(p, 'item-P2-full', 'desktop', { fullPage: true });
    // 试读
    await p.click('.tab[data-tab="preview"]');
    await p.waitForFunction(() => document.querySelector('#pane-preview .prose')?.textContent.length > 200);
    check('P2 试读：点击「免费试读」显示节选正文', !(await p.$eval('#pane-preview', (e) => e.hidden)));
    await p.$eval('.tabs', (e) => e.scrollIntoView({ block: 'start' }));
    await shot(p, 'preview', 'desktop');
    await shot(p, 'preview-full', 'desktop', { fullPage: true });
    // 登录页
    await p.goto(`${BASE}/login/`, { waitUntil: 'networkidle0' });
    await p.waitForSelector('.login-form');
    await shot(p, 'login', 'desktop');
    await p.close();

    const m = await newPage(pub, MOBILE, 'public-m');
    await m.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await shot(m, 'home', 'mobile');
    await shot(m, 'home-full', 'mobile', { fullPage: true });
    // 手机端从首页按钮进入资料库
    await clickNav(m, '.hero a[href="/library/"], main a.btn[href="/library/"]');
    await m.waitForSelector('.pcard');
    check('手机：首页 → 资料库', new URL(m.url()).pathname.startsWith('/library'));
    await shot(m, 'library', 'mobile');
    await shot(m, 'library-full', 'mobile', { fullPage: true });
    check('手机：单校分组默认收起', !(await m.$eval('#group-P3 details', (d) => d.open)));
    await m.$eval('#group-P3', (e) => e.scrollIntoView({ block: 'start' }));
    await m.click('#group-P3 summary');
    await sleep(300);
    check('手机：点击后单校分组展开', await m.$eval('#group-P3 details', (d) => d.open));
    await shot(m, 'p3group', 'mobile');
    await m.goto(`${BASE}/library/item.html?p=P2`, { waitUntil: 'networkidle0' });
    await m.waitForFunction(() => document.querySelector('#pane-intro')?.textContent.length > 100);
    await shot(m, 'item-P2', 'mobile');
    await shot(m, 'item-P2-full', 'mobile', { fullPage: true });
    await m.click('.tab[data-tab="preview"]');
    await m.waitForFunction(() => document.querySelector('#pane-preview .prose')?.textContent.length > 200);
    await m.$eval('.tabs', (e) => e.scrollIntoView({ block: 'start' }));
    await shot(m, 'preview', 'mobile');
    await m.goto(`${BASE}/login/`, { waitUntil: 'networkidle0' });
    await m.waitForSelector('.login-form');
    await shot(m, 'login', 'mobile');
    await m.close();
  }
  await pub.close();
  if (ONLY_SHOTS) throw Object.assign(new Error('ONLY_SHOTS'), { quiet: true });

  /* ======================= 2. 后台登录 → 快速发码（P2，30 分钟） ======================= */
  const admin = await browser.createBrowserContext();
  const ap = await newPage(admin, DESKTOP, 'admin');
  await ap.goto(`${BASE}/admin/`, { waitUntil: 'networkidle0' });
  await ap.waitForSelector('#adm-pw');
  await shot(ap, 'admin-login', 'desktop');
  await ap.type('#adm-pw', ADMIN_PW);
  await ap.click('.adm-login-card button[type=submit]');
  await ap.waitForSelector('.issue-form', { timeout: 15000 });
  check('后台：管理员登录成功', true);
  const tiles = await ap.$$eval('.ptile', (l) => l.map((e) => e.dataset.id));
  check('后台：发码面板列出可售产品（不含学员工具包）', tiles.includes('P2') && tiles.includes('P5') && !tiles.includes('KIT'), tiles.join(','));
  check('后台：默认有效期 30 分钟', (await ap.$eval('#iss-min', (e) => e.value)) === '30');

  const readIssued = async (page, prev) => {
    await page.waitForFunction((pv) => { const e = document.querySelector('.result.big .code-big, .code-big'); return e && e.textContent !== pv; }, { timeout: 15000 }, prev || '');
    return text(page, '.code-big');
  };
  await ap.type('#iss-label', '集成测试买家');
  await ap.click('.ptile[data-id="P2"] .btn');
  const codeP2 = await readIssued(ap);
  state.codeP2 = codeP2;
  check('后台：P2 密钥已生成（从页面读出）', /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(codeP2), codeP2);
  const meta = await text(ap, '.result-meta');
  check('后台：发码结果写明产品和 30 分钟', meta.includes('理工科面试题库'), meta);
  const rem = await text(ap, '.result-rem');
  check('后台：发码结果显示倒计时', /2\d:\d\d|30:00/.test(rem), rem);
  await ap.click('.result-acts .btn.blue');
  const script = await ap.evaluate(() => window.__clip);
  check('后台：发送话术含站点链接与密钥', !!script && script.includes(`${BASE}/library/`) && script.includes(codeP2), script?.split('\n').slice(0, 3).join(' / '));
  check('后台：发送话术不含买家备注', !script?.includes('集成测试买家'));
  await ap.evaluate(() => scrollTo(0, 0));
  await shot(ap, 'admin-issued', 'desktop');
  {
    const apm = await newPage(admin, MOBILE, 'admin-m');
    await apm.goto(`${BASE}/admin/`, { waitUntil: 'networkidle0' });
    await apm.waitForSelector('.issue-form');
    await apm.click('.ptile[data-id="P1"] .btn');
    await apm.waitForSelector('.code-big');
    await sleep(500);
    await apm.$eval('.issue-result', (e) => e.scrollIntoView({ block: 'start' }));
    await shot(apm, 'admin-issued', 'mobile');
    await apm.close();
  }
  {
    const lm = await browser.createBrowserContext();
    const lp = await newPage(lm, MOBILE, 'admin-login-m');
    await lp.goto(`${BASE}/admin/`, { waitUntil: 'networkidle0' });
    await lp.waitForSelector('#adm-pw');
    await shot(lp, 'admin-login', 'mobile');
    await lm.close();
  }

  /* ======================= 3. 买家：无痕上下文兑换 → 阅读 → 下载 → P5 锁定 ======================= */
  const buyer = await browser.createBrowserContext();
  await allowDownloads(browser, buyer, DL);
  const bp = await newPage(buyer, DESKTOP, 'buyer');
  await bp.goto(`${BASE}/library/`, { waitUntil: 'networkidle0' });
  await bp.waitForSelector('.unlock .key-input');
  await bp.type('.unlock .key-input', codeP2);
  await bp.click('.unlock .key-form button[type=submit]');
  await bp.waitForSelector('.unlock.on', { timeout: 15000 });
  await sleep(1200);
  const cd = await text(bp, '.unlock [data-cd]');
  check('买家：输入密钥后解锁，显示剩余时间', /^(2\d|30|1\d|\d{1,2}):\d\d$/.test(cd), cd);
  check('买家：P2 卡片显示已解锁', await bp.evaluate(() => [...document.querySelectorAll('.pcard.on h3')].some((h) => h.textContent.includes('理工科面试题库'))));
  check('买家：P5 卡片未解锁', !(await bp.evaluate(() => [...document.querySelectorAll('.pcard.on h3')].some((h) => h.textContent.includes('DFT')))));
  check('买家：界面不显示买家备注', !(await bodyText(bp)).includes('集成测试买家'));
  await shot(bp, 'library-unlocked', 'desktop');
  await shot(bp, 'library-unlocked-full', 'desktop', { fullPage: true });

  // 从 P2 卡片「在线阅读」进入，再从目录点开 P2_03
  const readBtn = await bp.evaluateHandle(() => [...document.querySelectorAll('.pcard.on')].find((c) => c.textContent.includes('理工科面试题库'))?.querySelector('a.btn.blue'));
  await Promise.all([bp.waitForNavigation({ waitUntil: 'networkidle0' }), readBtn.asElement().click()]);
  await bp.waitForSelector('.rd-doc h1');
  const docLink = await bp.evaluateHandle(() => [...document.querySelectorAll('.rd-docs a')].find((a) => a.textContent.includes('数字电路')));
  await docLink.asElement().click();
  await bp.waitForFunction(() => new URLSearchParams(location.search).get('d') === 'P2_03' && document.querySelector('.rd-doc h1')?.textContent.includes('数字电路'), { timeout: 15000 });
  await sleep(1200);
  const art = await bp.$eval('.rd-doc', (e) => ({ len: e.innerText.length, h2: e.querySelectorAll('h2').length, txt: e.innerText }));
  const snips = realSnippets('P2', 'P2_03');
  check('买家：P2_03 正文为真实内容', art.len > 2000 && snips.length > 0 && snips.every((s) => art.txt.replace(/\s+/g, ' ').includes(s)), `${art.len} 字，${art.h2} 个二级标题，对照：${snips.join(' | ')}`);
  check('买家：正文没有占位符外露', !/\{\{|待作者确认|待作者补充/.test(art.txt));
  const wm = await bp.$eval('.wm-layer', (e) => ({ bg: getComputedStyle(e).backgroundImage, pe: getComputedStyle(e).pointerEvents, pos: getComputedStyle(e).position }));
  check('买家：阅读器有平铺水印且含密钥', wm.bg.startsWith('url(') && decodeURIComponent(wm.bg).includes(`LICENSED ${codeP2}`) && wm.pe === 'none', wm.pos);
  check('买家：水印不含买家备注', !decodeURIComponent(wm.bg).includes('集成测试买家'));
  const banner = await text(bp, '.rd-banner');
  check('买家：阅读器顶部有倒计时', /\d\d:\d\d/.test(await text(bp, '.rd-banner [data-cd]')) && banner.includes('限时阅读'), banner);
  const cd1 = await text(bp, '.rd-chip [data-cd]');
  await sleep(2100);
  const cd2 = await text(bp, '.rd-chip [data-cd]');
  check('买家：倒计时在走', cd1 !== cd2, `${cd1} → ${cd2}`);
  check('买家：阅读器显示「下载 PDF」', (await bodyText(bp)).includes('下载 PDF'));
  const cover = await bp.evaluate(() => {
    const b = document.querySelector('.rd-banner .btn');
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { onTop: b.contains(el), el: el?.className || el?.tagName, scrollY };
  });
  check('买家：切换文档后倒计时横幅与下载按钮没有被顶栏遮住', cover.onTop && cover.scrollY === 0, JSON.stringify(cover));
  await shot(bp, 'reader-key', 'desktop');

  // 下载 PDF（真实点击，浏览器下载到 integ-downloads）
  await clickText(bp, '.rd-banner .btn', '下载 PDF');
  await bp.waitForFunction(() => window.__blobs.length > 0 || document.querySelector('.toast.error'), { timeout: 60000 });
  const dlErr = await text(bp, '.toast.error');
  if (dlErr) throw new Error(`下载失败：${dlErr}`);
  let pdfFile = await waitForFile(DL, '.pdf', 30000);
  if (!pdfFile) {
    // 退路：直接取页面生成的 Blob
    const b64 = await bp.evaluate(async () => {
      const b = window.__blobs.at(-1);
      const buf = new Uint8Array(await b.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    });
    pdfFile = join(DL, 'blob.pdf');
    writeFileSync(pdfFile, Buffer.from(b64, 'base64'));
  }
  copyFileSync(pdfFile, PDF_OUT);
  check('买家：PDF 已下载', readFileSync(PDF_OUT).subarray(0, 4).toString() === '%PDF', `${pdfFile.split(/[\\/]/).pop()}，${(readFileSync(PDF_OUT).length / 1048576).toFixed(2)} MB`);
  check('买家：下载文件名是中文产品名', /理工科面试题库\.pdf$/.test(pdfFile), pdfFile.split(/[\\/]/).pop());
  const py = `import sys, pymupdf
d = pymupdf.open(sys.argv[1])
miss = [i + 1 for i, p in enumerate(d) if 'LICENSED' not in p.get_text()]
t = d[0].get_text()
line = t.split('LICENSED')[1].splitlines()[0].strip() if 'LICENSED' in t else ''
print(len(d)); print(','.join(map(str, miss)) or 'none'); print(line)
d[0].get_pixmap(dpi=60).save(sys.argv[2])
d[len(d) // 2].get_pixmap(dpi=60).save(sys.argv[3])`;
  const out = execFileSync('python', ['-I', '-c', py, PDF_OUT, join(SHOTS, 'integ-pdf-page1.png'), join(SHOTS, 'integ-pdf-mid.png')], { encoding: 'utf8' }).trim().split(/\r?\n/);
  check('下载的 PDF 每一页都有 LICENSED 水印', out[1] === 'none' && Number(out[0]) > 50, `共 ${out[0]} 页，缺水印页：${out[1]}`);
  check('PDF 水印含密钥和日期', out[2].includes(codeP2) && /\d{4}-\d{2}-\d{2}/.test(out[2]), `LICENSED ${out[2]}`);

  // 手机端：解锁后的目录 + 阅读器
  {
    const bm = await newPage(buyer, MOBILE, 'buyer-m');
    await bm.goto(`${BASE}/library/`, { waitUntil: 'networkidle0' });
    await bm.waitForSelector('.unlock.on');
    await sleep(1100);
    await shot(bm, 'library-unlocked', 'mobile');
    await shot(bm, 'library-unlocked-full', 'mobile', { fullPage: true });
    await bm.goto(`${BASE}/library/read.html?p=P2&d=P2_03`, { waitUntil: 'networkidle0' });
    await bm.waitForSelector('.rd-doc h1');
    await sleep(1100);
    await shot(bm, 'reader-key', 'mobile');
    await bm.click('.rd-menu');
    await sleep(400);
    check('手机：阅读器目录抽屉可以打开', await bm.$eval('.rd-side', (e) => e.classList.contains('open')));
    await shot(bm, 'reader-key-drawer', 'mobile');
    // P5 锁定（手机）
    await bm.goto(`${BASE}/library/read.html?p=P5`, { waitUntil: 'networkidle0' });
    await bm.waitForSelector('.rd-lock');
    await shot(bm, 'locked', 'mobile');
    await bm.close();
  }

  // 打开 P5 → 锁定
  await bp.goto(`${BASE}/library/read.html?p=P5`, { waitUntil: 'networkidle0' });
  await bp.waitForSelector('.rd-lock');
  check('买家：打开 P5 显示锁定', (await text(bp, '.rd-lock h1')).includes('不包含'), await text(bp, '.rd-lock h1'));
  check('买家：锁定页不含 P5 正文', !(await exists(bp, '.rd-doc')));
  const p5doc = (await bp.evaluate(() => fetch('/data/catalog.json').then((r) => r.json()))).products.find((x) => x.id === 'P5').docs[1].id;
  const p5api = await bp.evaluate((d) => fetch(`/api/doc/P5/${d}`).then(async (r) => ({ s: r.status, e: (await r.json()).error })), p5doc);
  check('买家：直接请求 P5 正文返回 403', p5api.s === 403, p5api.e);
  await shot(bp, 'locked', 'desktop');

  // 再打开 P2 阅读器，准备被撤销
  await bp.goto(`${BASE}/library/read.html?p=P2&d=P2_05`, { waitUntil: 'networkidle0' });
  await bp.waitForSelector('.rd-doc h1');

  /* ======================= 4. 后台撤销 → 买家刷新后被锁定 ======================= */
  // 切换标签会重新拉取列表；等这次请求返回，否则读到的是发码时渲染的旧列表（兑换次数还是 0）
  const keysReloaded = ap.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/keys' && r.request().method() === 'GET', { timeout: 15000 });
  await clickText(ap, '.adm-tabs .seg-btn', '有效密钥');
  await keysReloaded;
  await sleep(100);
  await ap.waitForFunction((c) => [...document.querySelectorAll('.krow')].some((r) => r.textContent.includes(c)), { timeout: 15000 }, codeP2);
  check('后台：有效密钥列表里有刚发的 P2 密钥（含备注）', await ap.evaluate((c) => [...document.querySelectorAll('.krow')].some((r) => r.textContent.includes(c) && r.textContent.includes('集成测试买家')), codeP2));
  const usesTxt = await ap.evaluate((c) => [...document.querySelectorAll('.krow')].find((r) => r.textContent.includes(c))?.querySelector('.krow-meta')?.textContent, codeP2);
  check('后台：密钥列表显示已兑换次数', /1\s*\/\s*3/.test(usesTxt || ''), usesTxt);
  await shot(ap, 'admin-keys', 'desktop');
  for (const r of await ap.$$('.krow')) {
    if ((await r.evaluate((e) => e.textContent)).includes(codeP2)) { await (await r.$('.btn.danger')).click(); break; }
  }
  await ap.waitForFunction((c) => [...document.querySelectorAll('.krow')].some((r) => r.textContent.includes(c) && r.textContent.includes('已撤销')), { timeout: 15000 }, codeP2);
  check('后台：撤销密钥', true);
  await bp.reload({ waitUntil: 'networkidle0' });
  await bp.waitForSelector('.rd-lock', { timeout: 15000 });
  const revokedTxt = await text(bp, '.rd-lock');
  check('买家：撤销后刷新被锁定', !(await exists(bp, '.rd-doc')), await text(bp, '.rd-lock h1'));
  check('买家：锁定页说明密钥已被撤销', revokedTxt.includes('撤销'), revokedTxt.slice(0, 80));
  await shot(bp, 'locked-revoked', 'desktop');
  await bp.goto(`${BASE}/library/`, { waitUntil: 'networkidle0' });
  await bp.waitForSelector('.unlock');
  check('买家：撤销后资料库解锁区说明原因', !(await exists(bp, '.unlock.on')) && ((await text(bp, '.unlock')) || '').includes('撤销'), await text(bp, '.unlock-notice'));
  await shot(bp, 'library-revoked', 'desktop');
  const dlAfter = await bp.evaluate(() => fetch('/api/download/P2').then((r) => r.status));
  check('买家：撤销后下载接口拒绝', dlAfter === 401 || dlAfter === 403, dlAfter);
  await buyer.close();

  /* ======================= 5. 1 分钟密钥 → 兑换 → 等 70 秒 → 自动锁定 ======================= */
  let expiryPromise = null;
  if (!SKIP_EXPIRY) {
    await clickText(ap, '.adm-tabs .seg-btn', '快速发码');
    await ap.select('#iss-min', '1');
    const prev = await text(ap, '.code-big');
    await ap.click('.ptile[data-id="P1"] .btn');
    const code1m = await readIssued(ap, prev);
    check('后台：1 分钟测试密钥已生成', /^[0-9A-Z-]{14}$/.test(code1m), code1m);
    await ap.select('#iss-min', '30');
    const short = await browser.createBrowserContext();
    const sp = await newPage(short, DESKTOP, 'buyer-1min');
    await sp.goto(`${BASE}/library/item.html?p=P1`, { waitUntil: 'networkidle0' });
    await sp.type('#buy .key-input', code1m);
    await sp.click('#buy .key-form button[type=submit]');
    await sp.waitForFunction(() => document.querySelector('#buy')?.textContent.includes('在线阅读'), { timeout: 15000 });
    check('1 分钟密钥：在详情页兑换成功', true);
    await Promise.all([sp.waitForNavigation({ waitUntil: 'networkidle0' }), sp.click('#buy a.btn.blue')]);
    await sp.waitForSelector('.rd-doc h1');
    await sleep(1100);
    const left = await text(sp, '.rd-banner [data-cd]');
    check('1 分钟密钥：阅读器倒计时不超过 1 分钟', /^00:[0-5]\d$|^01:00$/.test(left), left);
    const t0 = Date.now();
    // 等待期间并行做学员流程；最后再检查自动锁定
    expiryPromise = (async () => {
      await sp.waitForSelector('.rd-lock', { timeout: 95000 });
      const waited = ((Date.now() - t0) / 1000).toFixed(0);
      const h1 = await text(sp, '.rd-lock h1');
      await sleep(Math.max(0, 70000 - (Date.now() - t0)));
      const still = await text(sp, '.rd-lock h1');
      const docGone = !(await exists(sp, '.rd-doc'));
      const api = await sp.evaluate(() => fetch('/api/doc/P1/P1_01').then((r) => r.status));
      check('1 分钟密钥：到期后阅读器自动锁定', h1?.includes('阅读时间已到') && docGone, `约 ${waited} 秒后锁定：${h1}`);
      check('1 分钟密钥：70 秒后仍保持锁定，接口返回 401', still?.includes('阅读时间已到') && api === 401, `api=${api}`);
      await shot(sp, 'locked-expired', 'desktop');
      await short.close();
    })();
  }

  /* ======================= 6. 学员：创建 → 登录 → 阅读 KIT / P4 → 不能下载 → 停用 ======================= */
  await clickText(ap, '.adm-tabs .seg-btn', '学员账号');
  await ap.waitForSelector('.stu-list .empty, .stu-list .srow');
  const uname = `integ_${Date.now().toString(36).slice(-5)}`;
  check('后台：学员到期日默认当年 10 月 31 日', /-10-31$/.test(await ap.$eval('#st-exp', (e) => e.value)));
  await ap.type('#st-user', uname);
  await ap.type('#st-name', '集成测试同学');
  await ap.click('.stu-grid form button[type=submit]');
  await ap.waitForSelector('dialog.cred[open]', { timeout: 15000 });
  const stuPw = await text(ap, 'dialog.cred code.pw');
  check('后台：创建学员，显示一次性密码', /^[a-z2-9]{10}$/.test(stuPw), `${uname} / ${stuPw}`);
  await ap.click('dialog.cred .sheet-close');
  await ap.waitForFunction((u) => [...document.querySelectorAll('.srow')].some((r) => r.textContent.includes(u)), {}, uname);
  await shot(ap, 'admin-students', 'desktop');
  {
    const apm = await newPage(admin, MOBILE, 'admin-m2');
    await apm.goto(`${BASE}/admin/`, { waitUntil: 'networkidle0' });
    await apm.waitForSelector('.issue-form');
    await clickText(apm, '.adm-tabs .seg-btn', '学员账号');
    await apm.waitForSelector('.srow');
    await shot(apm, 'admin-students', 'mobile');
    await apm.$eval('.stu-list', (e) => e.scrollIntoView({ block: 'start' }));
    await shot(apm, 'admin-students-list', 'mobile');
    await apm.close();
  }

  const stu = await browser.createBrowserContext();
  const st = await newPage(stu, DESKTOP, 'student');
  await st.goto(`${BASE}/login/`, { waitUntil: 'networkidle0' });
  await st.type('.login-form input[name=username]', uname);
  await st.type('.login-form input[name=password]', stuPw);
  await Promise.all([st.waitForNavigation({ waitUntil: 'networkidle0' }), st.click('.login-form button[type=submit]')]);
  check('学员：登录后进入资料库', new URL(st.url()).pathname === '/library/', st.url());
  await st.waitForSelector('.unlock.on.student');
  check('学员：资料库显示学员工具包', (await bodyText(st)).includes('陪跑学员工具包'));
  check('学员：欢迎语用称呼', (await text(st, '.unlock h2')).includes('集成测试同学'));
  // KIT
  const kitBtn = await st.evaluateHandle(() => [...document.querySelectorAll('.pcard.on')].find((c) => c.textContent.includes('陪跑学员工具包'))?.querySelector('a.btn.blue'));
  await Promise.all([st.waitForNavigation({ waitUntil: 'networkidle0' }), kitBtn.asElement().click()]);
  await st.waitForSelector('.rd-doc h1');
  const kitTxt = await st.$eval('.rd-doc', (e) => e.innerText);
  const kitDid = new URLSearchParams(new URL(st.url()).search).get('d');
  const kitSn = realSnippets('KIT', kitDid);
  check('学员：可以阅读 KIT 真实内容', kitTxt.length > 500 && kitSn.every((s) => kitTxt.replace(/\s+/g, ' ').includes(s)), `${kitDid}，${kitTxt.length} 字`);
  check('学员：阅读器没有下载按钮', !(await bodyText(st)).includes('下载 PDF'));
  check('学员：只读模式', await st.$eval('body', (b) => b.classList.contains('ro')));
  const swm = await st.$eval('.wm-layer', (e) => decodeURIComponent(getComputedStyle(e).backgroundImage));
  check('学员：水印为称呼 + 用户名', swm.includes('集成测试同学') && swm.includes(`@${uname}`));
  // P4：一篇公开汇编
  await st.goto(`${BASE}/library/read.html?p=P4`, { waitUntil: 'networkidle0' });
  await st.waitForSelector('.rd-doc h1');
  const pubLink = await st.evaluateHandle(() => [...document.querySelectorAll('.rd-docs:not(.inc) > li > a')].find((a) => /[?&]d=pub-/.test(a.getAttribute('href')) && /公开面经汇编/.test(a.textContent)));
  const pubTitle = await pubLink.asElement().evaluate((a) => a.textContent.trim());
  await pubLink.asElement().click();
  await st.waitForFunction((t) => document.querySelector('.rd-doc h1')?.textContent.trim().length && document.querySelector('.rd-docs li.current a')?.textContent.trim() === t, { timeout: 15000 }, pubTitle);
  const pubDid = new URLSearchParams(new URL(st.url()).search).get('d');
  const pubTxt = await st.$eval('.rd-doc', (e) => e.innerText);
  const pubSn = realSnippets('P4', pubDid);
  check('学员：可以阅读 P4 里的公开汇编', pubDid?.startsWith('pub-') && pubTxt.length > 500 && pubSn.every((s) => pubTxt.replace(/\s+/g, ' ').includes(s)), `${pubDid}「${pubTitle}」${pubTxt.length} 字`);
  await shot(st, 'reader-student', 'desktop');
  // P4 → 单校复盘（侧栏「单校面经复盘」）
  check('学员：P4 阅读器侧栏列出单校复盘', await exists(st, '.rd-inc a'));
  const incHref = await st.$eval('.rd-inc a', (a) => a.getAttribute('href'));
  await Promise.all([st.waitForNavigation({ waitUntil: 'networkidle0' }), st.click('.rd-inc a')]);
  await st.waitForSelector('.rd-doc h1');
  const p3id = new URLSearchParams(new URL(st.url()).search).get('p');
  const p3did = new URLSearchParams(new URL(st.url()).search).get('d');
  const p3Txt = await st.$eval('.rd-doc', (e) => e.innerText);
  const p3Sn = realSnippets(p3id, p3did);
  check('学员：可以阅读 P4 包含的单校复盘', p3id?.startsWith('P3-') && p3Txt.length > 500 && p3Sn.every((s) => p3Txt.replace(/\s+/g, ' ').includes(s)), `${incHref} → ${p3id}/${p3did}，${p3Txt.length} 字`);
  // 不能下载
  check('学员：单校复盘阅读器没有下载按钮', !(await bodyText(st)).includes('下载 PDF'));
  await st.goto(`${BASE}/library/item.html?p=P4`, { waitUntil: 'networkidle0' });
  await st.waitForSelector('#buy .btn.blue');
  check('学员：P4 详情页没有下载按钮', !(await text(st, '#buy')).includes('下载 PDF'), await text(st, '#buy'));
  for (const pid of ['P4', 'KIT', p3id]) {
    const r = await st.evaluate((id) => fetch(`/api/download/${id}`).then(async (x) => ({ s: x.status, e: (await x.json().catch(() => ({}))).error })), pid);
    check(`学员：直接请求下载接口 ${pid} 返回 403`, r.s === 403, r.e);
  }
  {
    const sm = await newPage(stu, MOBILE, 'student-m');
    await sm.goto(`${BASE}/library/read.html?p=P4&d=${encodeURIComponent(pubDid)}`, { waitUntil: 'networkidle0' });
    await sm.waitForSelector('.rd-doc h1');
    await shot(sm, 'reader-student', 'mobile');
    await sm.goto(`${BASE}/library/`, { waitUntil: 'networkidle0' });
    await sm.waitForSelector('.unlock.on');
    await shot(sm, 'library-student', 'mobile');
    await sm.close();
  }
  // 学员在阅读器里 → 后台停用 → 学员页面被锁定
  await st.goto(`${BASE}/library/read.html?p=KIT`, { waitUntil: 'networkidle0' });
  await st.waitForSelector('.rd-doc h1');
  await clickText(ap, '.adm-tabs .seg-btn', '学员账号');
  await ap.waitForFunction((u) => [...document.querySelectorAll('.srow')].some((r) => r.textContent.includes(u)), { timeout: 15000 }, uname);
  for (const r of await ap.$$('.srow')) {
    if (!(await r.evaluate((e, u) => e.textContent.includes(u), uname))) continue;
    for (const b of await r.$$('button')) if ((await b.evaluate((e) => e.textContent)).includes('停用')) { await b.click(); break; }
  }
  await ap.waitForFunction((u) => [...document.querySelectorAll('.srow')].some((r) => r.textContent.includes(u) && r.textContent.includes('已停用')), { timeout: 15000 }, uname);
  check('后台：停用学员', true);
  await st.click('.rd-pager a.next');
  await st.waitForSelector('.rd-lock', { timeout: 15000 });
  check('学员：停用后翻页即被锁定', (await text(st, '.rd-lock')).includes('停用'), await text(st, '.rd-lock h1'));
  await st.reload({ waitUntil: 'networkidle0' });
  await st.waitForSelector('.rd-lock', { timeout: 15000 });
  const disTxt = await text(st, '.rd-lock');
  check('学员：停用后刷新仍锁定且说明原因', !(await exists(st, '.rd-doc')) && disTxt.includes('停用'), disTxt.slice(0, 80));
  await shot(st, 'locked-disabled', 'desktop');
  await stu.close();

  if (expiryPromise) await expiryPromise;

  /* ======================= 7. 学员信息采集：注入草稿 → 导出 Word → 打印预览 ======================= */
  const intakeDl = join(DL, 'intake');
  mkdirSync(intakeDl, { recursive: true });
  const ic = await browser.createBrowserContext();
  await allowDownloads(browser, ic, intakeDl);
  for (const [prof, tag] of [[DESKTOP, 'desktop'], [MOBILE, 'mobile']]) {
    const ip = await newPage(ic, prof, `intake-${tag}`);
    await ip.goto(`${BASE}/intake/`, { waitUntil: 'networkidle0' });
    await ip.evaluate((k, v) => localStorage.setItem(k, v), INTAKE_KEY, sampleJson());
    await ip.reload({ waitUntil: 'networkidle0' });
    await ip.waitForSelector('.draft-banner');
    check(`采集页(${tag})：检测到注入的草稿`, (await text(ip, '.draft-banner')).includes('已保存的草稿'));
    await shot(ip, 'intake', tag);
    await clickText(ip, '.draft-banner button', '恢复本地草稿');
    await ip.waitForFunction(() => document.querySelector('#field-student-single-displayName')?.value === '林同学');
    check(`采集页(${tag})：恢复草稿`, true);
    await shot(ip, 'intake-restored', tag);
    await clickText(ip, 'button', '查看完整预览');
    await ip.waitForSelector('#validation-summary');
    check(`采集页(${tag})：预览显示可以导出`, (await text(ip, '#validation-summary')).includes('可以导出'), await text(ip, '#validation-summary strong'));
    if (tag === 'desktop') {
      await clickText(ip, '.export-actions button', '导出 Word');
      const docx = await waitForFile(intakeDl, '.docx', 60000);
      check('采集页：导出 Word 成功', !!docx, docx?.split(/[\\/]/).pop());
      if (docx) {
        const buf = readFileSync(docx);
        const xml = strFromU8(unzipSync(new Uint8Array(buf))['word/document.xml']);
        const want = ['档案概览', '林同学', '华东示例理工大学', '科研项目 1 ·'];
        check('采集页：Word 文件可解析且含档案内容', buf.subarray(0, 2).toString() === 'PK' && want.every((w) => xml.includes(w)), `${(buf.length / 1024).toFixed(0)} KB`);
        copyFileSync(docx, join(ART, 'integ-intake.docx'));
      }
    }
    await ip.evaluate(() => { window.__printCalls = 0; window.print = () => { window.__printCalls++; }; });
    await clickText(ip, '.export-actions button', '导出 PDF');
    await ip.waitForSelector('.report-overlay .report');
    await sleep(800);
    const rep = await ip.$eval('.report', (e) => e.textContent);
    check(`采集页(${tag})：打印预览渲染档案`, rep.includes('档案概览') && rep.includes('林同学') && rep.includes('档案结束'));
    check(`采集页(${tag})：打开打印预览后调用打印`, (await ip.evaluate(() => window.__printCalls)) === 1);
    await shot(ip, 'intake-print', tag);
    if (tag === 'desktop') {
      await ip.pdf({ path: join(ART, 'integ-intake-report.pdf'), preferCSSPageSize: true, printBackground: true });
      check('采集页：打印输出 PDF', readFileSync(join(ART, 'integ-intake-report.pdf')).subarray(0, 4).toString() === '%PDF');
    }
    await ip.close();
  }
  await ic.close();
  await admin.close();
} catch (e) {
  if (!e.quiet) {
    check('e2e 全程无异常', false, e.stack?.split('\n').slice(0, 4).join(' | '));
    let i = 0;
    for (const ctx of browser.browserContexts()) {
      for (const pg of await ctx.pages()) {
        try {
          await Promise.race([pg.screenshot({ path: join(SHOTS, `integ-zz-failure-${++i}.png`) }), sleep(10000)]);
          console.log('failure shot', i, pg.url());
        } catch { /* ignore */ }
      }
    }
  }
} finally {
  const proc = browser.process();
  await Promise.race([browser.close(), sleep(15000)]).catch(() => {});
  if (proc && proc.exitCode === null) proc.kill('SIGKILL');
}

const failed = results.filter((r) => !r.ok);
const uniqProblems = [...new Set(problems)];
writeFileSync(join(ART, 'integ-e2e.json'), JSON.stringify({ base: BASE, passed: results.length - failed.length, failed: failed.length, results, problems: uniqProblems }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (uniqProblems.length) console.log('Console/page problems:\n  ' + uniqProblems.join('\n  '));
process.exitCode = failed.length || uniqProblems.length ? 1 : 0;
