// 采集页端到端测试（puppeteer-core + 本机 Chrome，静态服务器端口 8791）。
// 流程：构建 → 用原版页面导入示例数据并保存草稿 → 新版读取老草稿并逐步渲染 → JSON 导出 / 导入 / 文本备份往返
//      → 新版保存的草稿原版能读 → 浏览器内导出 Word → 打印报告（page.pdf 生成 test-artifacts/intake-report.pdf）
//      → 手机 / 微信界面截图。截图保存在 test-artifacts/screens/intake-*.png。
// 运行：node --test tests/intake-e2e.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { unzipSync, strFromU8 } from 'fflate';
import { startServer } from './intake-serve.mjs';
import { sampleJson } from './intake-fixtures.mjs';
import { STEPS } from '../src/intake/schema.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const ART = join(ROOT, 'test-artifacts');
const SHOTS = join(ART, 'screens');
const DL = join(ART, 'intake-downloads');
const KEY = 'baoyan-student-intake:v1';
const DESKTOP = { width: 1366, height: 900 };
const MOBILE = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const WECHAT_UA = `${IPHONE_UA} MicroMessenger/8.0.50(0x1800322c) NetType/WIFI Language/zh_CN`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = !existsSync(CHROME) && '本机未安装 Chrome';

let server;
let browser;
let page; // 新版主页面（桌面）
const dialogs = [];
const problems = []; // 页面错误、CSP 违规、外部请求
const requests = [];
let legacyDraft = '';
let exportedJsonPath = '';

function watch(p, label) {
  p.on('dialog', async (d) => {
    dialogs.push(d.message());
    await d.accept();
  });
  p.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/favicon/.test(m.text())) problems.push(`${label} console: ${m.text()}`);
  });
  p.on('request', (r) => {
    requests.push({ label, url: r.url(), t: Date.now() });
    if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) problems.push(`${label} 外部请求: ${r.url()}`);
  });
  return p.evaluateOnNewDocument(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`);
    });
  });
}

async function newPage(label, { viewport = DESKTOP, ua } = {}) {
  const p = await browser.newPage();
  await p.setViewport(viewport);
  if (ua) await p.setUserAgent(ua);
  await watch(p, label);
  return p;
}

/** 点击包含指定文字的可见按钮；real=true 时用真实鼠标点击（文件选择框需要用户手势） */
async function clickText(p, text, { selector = 'button', real = false } = {}) {
  const handle = await p.evaluateHandle((sel, t) =>
    [...document.querySelectorAll(sel)].find((e) => e.textContent.replace(/\s+/g, ' ').trim().includes(t) && !e.disabled && e.getClientRects().length) || null,
  selector, text);
  const el = handle.asElement();
  assert.ok(el, `找不到按钮「${text}」`);
  if (real) {
    await p.evaluate(() => document.querySelector('.toast')?.remove());
    await el.click();
  } else {
    await el.evaluate((e) => e.click());
  }
  await sleep(120);
}

const val = (p, id) => p.$eval(`#${id}`, (e) => e.value);
const shot = (p, name, opts = {}) => p.screenshot({ path: join(SHOTS, `intake-${name}.png`), ...opts });

function clearDownloads() {
  rmSync(DL, { recursive: true, force: true });
  mkdirSync(DL, { recursive: true });
}
async function waitForDownload(ext, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const f = readdirSync(DL).find((x) => x.endsWith(ext));
    if (f) {
      await sleep(200);
      return join(DL, f);
    }
    await sleep(150);
  }
  throw new Error(`等待下载 ${ext} 超时`);
}

before(async () => {
  if (skip) return;
  mkdirSync(SHOTS, { recursive: true });
  const b = spawnSync(process.execPath, ['tests/intake-build.mjs', '--only', 'intake', '--out', 'test-artifacts/intake-dist'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(b.status, 0, `构建失败：\n${b.stdout}\n${b.stderr}`);
  server = await startServer({ port: PORT });
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--lang=zh-CN'] });
  clearDownloads();
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r()));
});

test('原版页面导入示例数据并保存草稿（构造老格式草稿）', { skip, timeout: 120000 }, async () => {
  const p = await newPage('legacy');
  await p.goto(`${BASE}/legacy/index.html`, { waitUntil: 'load' });
  await p.waitForSelector('.site-header');
  await clickText(p, '备份文本 / 粘贴恢复');
  await p.waitForSelector('dialog.transfer-dialog textarea');
  await p.$eval('dialog.transfer-dialog textarea', (e, v) => { e.value = v; }, sampleJson());
  await clickText(p, '从文本恢复');
  await p.waitForFunction(() => !document.querySelector('dialog.transfer-dialog'));
  await p.type('#field-student-single-notes', '旧版填写的补充说明');
  await clickText(p, '保存本地草稿');
  legacyDraft = await p.evaluate((k) => localStorage.getItem(k), KEY);
  const d = JSON.parse(legacyDraft);
  assert.equal(d.student.displayName, '林同学');
  assert.equal(d.student.notes, '旧版填写的补充说明');
  assert.equal(d.researchProjects.length, 3);
  await p.close();
});

test('新版读取老草稿并逐步渲染 6 个步骤与预览', { skip, timeout: 120000 }, async () => {
  page = await newPage('intake');
  await page.goto(`${BASE}/intake/`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.draft-banner');

  // 首屏 JS 体积（docx 必须按需加载）
  const initialJs = requests.filter((r) => r.label === 'intake' && r.url.endsWith('.js')).map((r) => r.url);
  assert.ok(!initialJs.some((u) => u.includes('export-docx')), '首屏不应加载 Word 导出组件');
  const bytes = initialJs.reduce((n, u) => n + statSync(join(ART, 'intake-dist', new URL(u).pathname)).size, 0);
  assert.ok(bytes < 300 * 1024, `首屏 JS ${bytes} 字节，超过 300KB`);
  console.log(`首屏 JS：${initialJs.length} 个文件，共 ${(bytes / 1024).toFixed(1)} KB`);

  assert.equal(await val(page, 'field-student-single-displayName'), '', '恢复前不应自动载入个人资料');
  await shot(page, 'desktop-draft-banner');
  await clickText(page, '恢复本地草稿');
  assert.equal(await val(page, 'field-student-single-displayName'), '林同学');
  assert.equal(await val(page, 'field-student-single-notes'), '旧版填写的补充说明');
  assert.equal(await page.$eval('[data-progress-text]', (e) => e.textContent), '100%');
  await shot(page, 'desktop-step1');

  const checks = [
    async () => assert.equal(await val(page, 'field-student-single-university'), '华东示例理工大学'),
    async () => {
      assert.equal(await val(page, 'field-academics-single-gpa'), '3.82');
      assert.equal(await page.$eval('#field-academics-single-comprehensiveRank', (e) => [e.disabled, e.placeholder].join()), 'true,不适用');
      assert.equal(await val(page, 'field-recommendationEligibility-single-likelihood'), '有竞争');
    },
    async () => {
      assert.equal(await page.$eval('#field-english-single-cet6', (e) => e.disabled), true);
      assert.equal(await page.$$eval('#section-researchProjects .record-card', (l) => l.length), 3);
      assert.equal(await val(page, 'field-researchProjects-proj-dft-2025-name'), '钙钛矿氧化物表面氧空位的第一性原理研究');
    },
    async () => {
      assert.equal(await page.$$eval('#section-publications .record-card', (l) => l.length), 1);
      assert.equal(await page.$$eval('#section-competitions .record-card', (l) => l.length), 2);
    },
    async () => {
      assert.equal(await val(page, 'field-careerGoals-single-degree'), '直博');
      assert.equal(await page.$$eval('#section-targetPrograms .record-card', (l) => l.length), 2);
    },
    async () => {
      assert.equal(await page.$eval('#field-confirmation-single-truthful', (e) => e.checked), true);
      assert.equal(await page.$$eval('#section-supportNeeds input[type=checkbox]:checked', (l) => l.length), 3);
    },
  ];
  for (let i = 0; i < 6; i++) {
    const steps = await page.$$('.step');
    await steps[i].evaluate((e) => e.click());
    await page.waitForFunction((t) => document.querySelector('#page-title')?.textContent === t, {}, STEPS[i].title);
    await checks[i]();
  }
  const statuses = await page.$$eval('[data-step-status]', (l) => l.map((e) => e.textContent));
  assert.equal(statuses.length, 6);
  assert.ok(statuses.every((s) => /^(\d+)\/\1 项必填$/.test(s)), statuses.join(' | '));
  await shot(page, 'desktop-step3', { fullPage: false });

  await clickText(page, '查看完整预览');
  await page.waitForSelector('#validation-summary');
  assert.match(await page.$eval('#validation-summary', (e) => e.textContent), /必填信息已完成，可以导出/);
  await shot(page, 'desktop-review');
});

test('JSON 导出 → 清除 → 导入 → 文本备份，数据往返一致', { skip, timeout: 120000 }, async () => {
  clearDownloads();
  await clickText(page, '导出 JSON 备份');
  exportedJsonPath = await waitForDownload('.json');
  assert.ok(exportedJsonPath.endsWith('2026_华东示例理工大学_林同学_保研基本信息表.json'), exportedJsonPath);
  const exported = JSON.parse(readFileSync(exportedJsonPath, 'utf8'));
  assert.deepEqual(exported, JSON.parse(legacyDraft), '导出的 JSON 应与原版草稿完全一致');

  await clickText(page, '清除本地数据');
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), KEY), null);
  assert.equal(await val(page, 'field-student-single-displayName'), '');

  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10000 }), clickText(page, '导入 JSON 恢复', { real: true })]);
  await chooser.accept([exportedJsonPath]);
  await page.waitForFunction(() => document.querySelector('#field-student-single-displayName')?.value === '林同学');

  await clickText(page, '备份文本 / 粘贴恢复');
  await page.waitForSelector('dialog.transfer-dialog textarea');
  await clickText(page, '生成备份文本');
  const text = await page.$eval('dialog.transfer-dialog textarea', (e) => e.value);
  assert.deepEqual(JSON.parse(text), exported, '导入后再导出的内容应与原文件一致');

  await page.$eval('dialog.transfer-dialog textarea', (e) => { e.value = '{ 不是 JSON'; });
  await clickText(page, '从文本恢复');
  assert.match(await page.$eval('.toast', (e) => e.textContent), /文件不是有效的 JSON/);
  await page.$eval('dialog.transfer-dialog textarea', (e, v) => { e.value = v; }, text);
  await clickText(page, '从文本恢复');
  await page.waitForFunction(() => !document.querySelector('dialog.transfer-dialog'));
  assert.equal(await val(page, 'field-student-single-displayName'), '林同学');
});

test('新版保存的草稿，原版页面可以恢复', { skip, timeout: 120000 }, async () => {
  await page.click('#field-student-single-notes');
  await page.keyboard.press('End');
  await page.type('#field-student-single-notes', ' / 新版追加');
  assert.equal(await page.$eval('#save-status', (e) => e.textContent), '有未保存的更改');
  await clickText(page, '保存本地草稿');
  assert.match(await page.$eval('#save-status', (e) => e.textContent), /^草稿保存于 /);
  const saved = JSON.parse(await page.evaluate((k) => localStorage.getItem(k), KEY));
  assert.equal(saved.student.notes, '旧版填写的补充说明 / 新版追加');

  const p = await newPage('legacy2');
  await p.goto(`${BASE}/legacy/index.html`, { waitUntil: 'load' });
  await p.waitForSelector('.draft-banner');
  await clickText(p, '恢复本地草稿');
  assert.equal(await val(p, 'field-student-single-notes'), '旧版填写的补充说明 / 新版追加');
  assert.equal(await val(p, 'field-student-single-displayName'), '林同学');
  await p.close();
});

test('浏览器内导出 Word（按需加载 docx）', { skip, timeout: 120000 }, async () => {
  await clickText(page, '查看完整预览');
  await page.waitForSelector('#validation-summary');
  const before = requests.length;
  clearDownloads();
  dialogs.length = 0;
  await clickText(page, '导出 Word');
  const file = await waitForDownload('.docx');
  assert.ok(dialogs.some((m) => /项待确认信息/.test(m)), '导出前应提醒待确认信息');
  assert.ok(requests.slice(before).some((r) => r.url.includes('export-docx')), '点击导出后才加载 Word 组件');
  assert.ok(file.endsWith('2026_华东示例理工大学_林同学_保研基本信息表.docx'), file);
  const buf = readFileSync(file);
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const xml = strFromU8(unzipSync(new Uint8Array(buf))['word/document.xml']);
  for (const s of ['档案概览', '林同学', '科研项目 1 · 钙钛矿氧化物表面氧空位的第一性原理研究', '旧版填写的补充说明 / 新版追加']) assert.ok(xml.includes(s), s);
});

test('导出 PDF：打印报告视图 + window.print()，并用 page.pdf 生成 PDF', { skip, timeout: 120000 }, async () => {
  await page.evaluate(() => {
    window.__printCalls = 0;
    window.print = () => { window.__printCalls++; };
  });
  await clickText(page, '导出 PDF');
  await page.waitForSelector('.report-overlay .report');
  await sleep(700);
  assert.equal(await page.evaluate(() => window.__printCalls), 1, '应自动调用 window.print()');
  const txt = await page.$eval('.report', (e) => e.textContent);
  for (const s of ['学员基本信息档案', '档案概览', '待确认清单', '科研项目 2 · 柔性透明导电薄膜的制备与表征', '— 档案结束']) assert.ok(txt.includes(s), s);
  await shot(page, 'desktop-report');

  await page.pdf({ path: join(ART, 'intake-report.pdf'), preferCSSPageSize: true, printBackground: true });
  const pdf = readFileSync(join(ART, 'intake-report.pdf'));
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.ok(pdf.length > 20000);

  await page.keyboard.press('Escape');
  assert.equal(await page.$('.report-overlay'), null);

  // 不经过「导出 PDF」按钮直接打印（Ctrl+P）：beforeprint 时临时挂载同一份报告
  await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
  assert.ok(await page.$('.report-overlay.print-only'));
  await page.pdf({ path: join(ART, 'intake-report-ctrlp.pdf'), preferCSSPageSize: true, printBackground: true });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  assert.equal(await page.$('.report-overlay'), null);
});

test('手机端与微信环境', { skip, timeout: 120000 }, async () => {
  const m = await newPage('mobile', { viewport: MOBILE, ua: IPHONE_UA });
  await m.goto(`${BASE}/intake/`, { waitUntil: 'networkidle0' });
  await shot(m, 'mobile-draft-banner');
  await clickText(m, '恢复本地草稿');
  await shot(m, 'mobile-step1');
  await (await m.$$('.step'))[2].evaluate((e) => e.click());
  await m.waitForSelector('#section-researchProjects');
  await m.$eval('#section-researchProjects', (e) => e.scrollIntoView());
  await shot(m, 'mobile-step3-records');
  await clickText(m, '查看完整预览');
  await m.evaluate(() => { window.print = () => {}; });
  await clickText(m, '导出 PDF');
  await m.waitForSelector('.report-overlay .report');
  await shot(m, 'mobile-report');
  await m.close();

  const w = await newPage('wechat', { viewport: MOBILE, ua: WECHAT_UA });
  await w.goto(`${BASE}/intake/`, { waitUntil: 'networkidle0' });
  assert.ok(await w.$('.wechat-notice'), '微信内应显示下载限制提示');
  await clickText(w, '恢复本地草稿');
  await shot(w, 'mobile-wechat');
  await clickText(w, '查看完整预览');
  await w.evaluate(() => { window.__printCalls = 0; window.print = () => { window.__printCalls++; }; });
  await clickText(w, '导出 PDF');
  await w.waitForSelector('.report-overlay');
  await sleep(600);
  assert.equal(await w.evaluate(() => window.__printCalls), 0, '微信内不调用打印');
  assert.equal(await w.$('[data-print]'), null, '微信内不显示打印按钮');
  assert.match(await w.$eval('.report-toolbar-text', (e) => e.textContent), /在浏览器中打开/);
  await w.close();
});

test('填写交互：待确认 / 校验提示 / 经历条目 / 暂无 / 单条保存 / 错误跳转', { skip, timeout: 120000 }, async () => {
  const ctx = await browser.createBrowserContext(); // 全新的本地存储
  const p = await ctx.newPage();
  await p.setViewport(DESKTOP);
  await watch(p, 'fresh');
  await p.goto(`${BASE}/intake/`, { waitUntil: 'networkidle0' });
  assert.equal(await p.$('.draft-banner'), null, '没有草稿时不显示恢复提示');
  assert.equal(await p.$eval('#save-status', (e) => e.textContent), '仅保存在当前页面');

  await p.type('#field-student-single-displayName', '小周');
  assert.equal(await p.$eval('#save-status', (e) => e.textContent), '有未保存的更改');

  // 待确认：输入框禁用并显示标记，再点一次恢复填写
  const uni = '#field-student-single-university';
  await p.$eval(uni, (e) => e.closest('.field').querySelector('.uncertain-options button').click());
  assert.equal(await p.$eval(uni, (e) => [e.disabled, e.placeholder].join()), 'true,待确认');
  assert.match(await p.$eval(uni, (e) => e.closest('.field').querySelector('.uncertain-options').textContent), /待确认 · 改为填写/);
  await p.$eval(uni, (e) => e.closest('.field').querySelector('.uncertain-options button').click());
  assert.equal(await p.$eval(uni, (e) => e.disabled), false);

  // 失焦校验
  await p.type('#field-student-single-enrollmentYear', '1970');
  await p.$eval('#field-student-single-enrollmentYear', (e) => e.blur());
  assert.match(await p.$eval('#field-student-single-enrollmentYear-error', (e) => e.textContent), /^应在 1980–\d{4} 之间。$/);
  assert.equal(await p.$eval('#field-student-single-enrollmentYear', (e) => e.getAttribute('aria-invalid')), 'true');

  // 第 2 步：综合测评「不适用」
  await (await p.$$('.step'))[1].evaluate((e) => e.click());
  await p.$eval('#field-academics-single-comprehensiveRank', (e) => [...e.closest('.field').querySelectorAll('.uncertain-options button')].find((b) => b.textContent === '不适用').click());
  assert.equal(await p.$eval('#field-academics-single-comprehensiveRank', (e) => e.placeholder), '不适用');

  // 第 3 步：经历条目添加 / 上移 / 删除 / 单条保存 / 暂无
  await (await p.$$('.step'))[2].evaluate((e) => e.click());
  await clickText(p, '＋ 添加科研项目');
  await clickText(p, '＋ 添加科研项目');
  let cards = await p.$$('#section-researchProjects .record-card');
  assert.equal(cards.length, 2);
  await (await cards[1].$('input')).type('第二个项目');
  await cards[1].$eval('[aria-label="科研项目 2 上移"]', (e) => e.click());
  cards = await p.$$('#section-researchProjects .record-card');
  assert.equal(await (await cards[0].$('input')).evaluate((e) => e.value), '第二个项目');
  await cards[0].$eval('.record-card > .button', (e) => e.click()); // 保存本条到本地草稿
  const one = JSON.parse(await p.evaluate((k) => localStorage.getItem(k), KEY));
  assert.deepEqual(one.researchProjects.map((r) => r.name), ['第二个项目'], '只保存这一条');
  assert.equal(one.student.displayName, '', '其他未保存的修改不写入草稿');
  await cards[1].$eval('[aria-label="删除科研项目 2"]', (e) => e.click());
  assert.equal((await p.$$('#section-researchProjects .record-card')).length, 1);
  await clickText(p, '暂无科研经历');
  assert.equal((await p.$$('#section-researchProjects .record-card')).length, 0);
  assert.match(await p.$eval('#section-researchProjects .empty-records', (e) => e.textContent), /已记录：暂无科研经历/);

  // 第 6 步：多选
  await (await p.$$('.step'))[5].evaluate((e) => e.click());
  await p.$$eval('#section-supportNeeds .choice input', (l) => l[0].click());
  assert.equal(await p.$$eval('#section-supportNeeds .choice input:checked', (l) => l.length), 1);

  // 预览：列出问题，点击跳转到对应字段；有问题时不允许导出
  await clickText(p, '查看完整预览');
  assert.match(await p.$eval('#validation-summary', (e) => e.className), /has-errors/);
  await shot(p, 'desktop-review-errors');
  dialogs.length = 0;
  await clickText(p, '导出 Word');
  assert.match(await p.$eval('.toast', (e) => e.textContent), /^还有 \d+ 项必填或格式问题/);
  await p.$eval('#validation-summary li button', (e) => e.click());
  await sleep(200);
  const focused = await p.evaluate(() => document.activeElement?.id);
  assert.equal(focused, 'field-student-single-university', '点击问题后聚焦到对应字段');

  await clickText(p, '保存本地草稿');
  const all = JSON.parse(await p.evaluate((k) => localStorage.getItem(k), KEY));
  assert.equal(all.student.displayName, '小周');
  assert.equal(all.academics.comprehensiveRank, '不适用');
  assert.equal(all.experienceStatus.researchProjects, 'none');
  assert.deepEqual(all.supportNeeds.priorities, ['资格诊断']);
  await ctx.close();
});

test('无页面错误、无 CSP 违规、无外部请求', { skip }, () => {
  assert.deepEqual(problems.filter((p) => !p.startsWith('legacy')), []);
});
