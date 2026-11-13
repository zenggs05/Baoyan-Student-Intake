// 为每个产品生成排版好的 PDF（docs/ARCHITECTURE.md §5.4）→ .content/kv/pdf__<p>.pdf + pdfstamp__<p>.json
//   node scripts/build-pdf.mjs                 全部产品
//   node scripts/build-pdf.mjs --only P2,P4    只生成部分产品
//   node scripts/build-pdf.mjs --keep-html     把中间 HTML 留在 .content/tmp/ 便于排查
// 环境变量：CHROME_PATH（默认本机 Chrome）、CONTENT_ROOT / SOP_ROOT（同 build-content）
//
// 流程（每个产品）：
//   1. 拼出「目录 + 正文」HTML，套 lib-content/print.css，打印前在页面里做版式转换（宽表 → 卡片等）
//   2. 第一遍打印只为拿页码：读 PDF 里的命名目标（目录链接指向各篇），得到每篇起始页
//   3. 第二遍带页眉页脚、目录页码、书签（outline）正式打印
//   4. 封面单独打印（无页眉页脚），用 pdf-lib 插到最前面，并写入页码标签和文档属性
//   5. 每页叠加授权标识占位符（lib-content/pdf-stamp.mjs），占位符的字节位置写进 pdfstamp__<p>.json；
//      下载时 Worker 把占位符换成买家的密钥和日期（src/worker/pdf-stamp.js）
// 页脚「第 X 页 / 共 Y 页」从目录页开始计数（封面不计），目录里的页码与页脚一致。
import puppeteer from 'puppeteer-core';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFHexString } from 'pdf-lib';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as cfg from './catalog.config.mjs';
import { loadCatalog, makeResolver } from './lib-content/catalog.mjs';
import { cleanSource, countWords } from './lib-content/clean.mjs';
import { renderMarkdown, escapeHtml as esc } from './lib-content/render.mjs';
import { appendPdfSection } from './lib-content/report.mjs';
import { addStampPlaceholders, findStampSlots } from './lib-content/pdf-stamp.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KV = join(ROOT, '.content', 'kv');
const TMP = join(ROOT, '.content', 'tmp');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PRINT_CSS = readFileSync(join(ROOT, 'scripts', 'lib-content', 'print.css'), 'utf8');
const argVal = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const ONLY = argVal('--only')?.split(',').map((s) => s.trim()).filter(Boolean);
const KEEP_HTML = process.argv.includes('--keep-html');
const MAX_BYTES = 25 * 1024 * 1024; // KV 单个值上限

const MARGIN = { top: '21mm', bottom: '18mm', left: '19mm', right: '19mm' };
const FONT = `"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif`;
const now = new Date();
const DATE_CN = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日`;
const DATE_ISO = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

if (!existsSync(CHROME)) {
  console.error(`[build-pdf] 找不到 Chrome：${CHROME}。请安装 Chrome，或用环境变量 CHROME_PATH 指定 chrome.exe 的位置。`);
  process.exit(1);
}
mkdirSync(KV, { recursive: true });

const catalog = loadCatalog(cfg);
const products = catalog.products.filter((p) => !ONLY || ONLY.includes(p.id));
if (ONLY) {
  const unknown = ONLY.filter((id) => !catalog.products.some((p) => p.id === id));
  if (unknown.length) { console.error(`[build-pdf] 没有这些产品：${unknown.join('、')}。可选：${catalog.products.map((p) => p.id).join('、')}`); process.exit(1); }
}

// ------------------------------------------------------------------ HTML 拼装
const shell = (title, body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body>${body}</body></html>`;
const fmtWords = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1).replace(/\.0$/, '')} 万` : `${Math.round(n / 100) * 100 || n}`);
const pad2 = (n) => String(n).padStart(2, '0');

/** 组装目录条目与正文；返回 {sections, entries, words, disclaimer, docCount} */
function buildBody(product) {
  const all = product.pdfParts.flatMap((part) => part.items.map((it) => ({ ...it, part })));
  const pdfDocs = new Map(all.map((it) => [`${it.productId}/${it.doc.id}`, `doc-${it.productId}-${it.doc.id}`]));
  const resolver = makeResolver(catalog, { mode: 'pdf', pdfDocs });
  let words = 0;
  let disclaimer = '';
  const sections = [];
  const docEntries = [];
  all.forEach((it, i) => {
    const anchor = pdfDocs.get(`${it.productId}/${it.doc.id}`);
    const { text } = cleanSource(readFileSync(it.doc.file, 'utf8'), it.doc.options);
    const r = renderMarkdown(text, { idPrefix: `${anchor}-`, resolveLink: resolver, disclaimerPrefix: cfg.DISCLAIMER_PREFIX });
    words += countWords(text, cfg.DISCLAIMER_PREFIX);
    if (!disclaimer) disclaimer = (/<aside class="disclaimer">([\s\S]*?)<\/aside>/.exec(r.html) || [])[1] || '';
    const kicker = it.part.label || (it.productId === product.id ? product.title : it.productId);
    sections.push(`<section class="doc" id="${anchor}"><header class="doc-head"><div class="doc-kicker"><span class="k-no">${pad2(i + 1)}</span><span>${esc(kicker)}</span></div><h1>${esc(it.doc.title)}</h1></header><div class="doc-body">${r.html}</div></section>`);
    docEntries.push({ anchor, title: it.doc.title, no: pad2(i + 1), group: it.part.label, toc: r.toc });
  });
  // 只有一篇时，目录列出这一篇的二级标题
  const entries = docEntries.length === 1
    ? [{ ...docEntries[0], group: '' }, ...docEntries[0].toc.filter((t) => t.level === 2).map((t) => ({ anchor: t.id, title: t.text, no: '', sub: true, group: '' }))]
    : docEntries;
  return { sections: sections.join('\n'), entries, words, disclaimer, docCount: all.length };
}

function tocHtml(product, body, pages) {
  const li = [];
  let lastGroup = null;
  for (const e of body.entries) {
    if (e.group && e.group !== lastGroup) li.push(`<li class="toc-group">${esc(e.group)}</li>`);
    lastGroup = e.group;
    const pg = pages?.get(e.anchor) ?? '';
    li.push(`<li${e.sub ? ' class="sub"' : ''}><a href="#${e.anchor}"><span class="no">${e.no}</span><span class="t">${esc(e.title)}</span><span class="dots"></span><span class="pg">${pg}</span></a></li>`);
  }
  const note = `<div class="toc-note"><p><b>使用说明</b>　${usage(product)}，禁止转发、转售或上传到任何公开平台。</p>${body.disclaimer ? `<p>${body.disclaimer}</p>` : ''}</div>`;
  const count = body.docCount > 1 ? `<small>共 ${body.docCount} 篇</small>` : '';
  return `<nav class="toc-page"><h1>目录${count}</h1><ol class="toc">${li.join('')}</ol>${note}</nav>`;
}

function coverHtml(product, body) {
  const isSingle = product.family !== product.id; // P3 单校
  const series = isSingle ? (cfg.PRODUCTS.find((d) => d.id === product.family)?.titlePrefix || '').replace(/[·・]\s*$/, '') : '';
  const title = isSingle ? product.title.replace(/^.*?[·・]/, '') : product.title;
  const facts = [
    body.docCount > 1 ? ['篇数', `${body.docCount}`] : ['章节', `${body.entries.filter((e) => e.sub).length}`],
    ['字数（约）', fmtWords(body.words)],
  ];
  if (product.includes?.length) facts.push(['含单校复盘', `${product.includes.length} 份`]);
  return `<div class="cover">
  <div class="cover-band">
    <div class="cover-brand">保研全程陪跑 · 资料库</div>
    ${series ? `<div class="cover-series">${esc(series)}</div>` : '<div class="cover-series">&nbsp;</div>'}
    <h1 class="${title.length > 12 ? 'long' : ''}">${esc(title)}</h1>
    <div class="cover-accent"></div>
    <div class="cover-subtitle">${esc(product.subtitle || '')}</div>
    <div class="cover-facts">${facts.map(([k, v]) => `<div><b>${esc(v)}</b>${esc(k)}</div>`).join('')}</div>
  </div>
  <div class="cover-lower">
    ${product.sellingPoint ? `<div class="cover-tagline">${esc(product.sellingPoint)}</div>` : ''}
    <div class="cover-meta"><span>版本<b>${esc(cfg.EDITION_LABEL)}</b></span><span>更新日期<b>${DATE_CN}</b></span></div>
    <div class="cover-license">${usage(product)}，禁止转发、转售。<small>${product.forSale ? '下载的 PDF 带有购买者专属标识，可追溯来源。' : ''}资料基于亲历回忆、已获授权的往年整理与公开信息，各校政策逐年变化，请以当年官方通知为准。</small></div>
  </div>
  <div class="cover-foot"><span>保研全程陪跑</span><span>生成于 ${DATE_ISO}</span></div>
</div>`;
}

/** 使用范围说明：售卖品写「购买者」，学员工具包写「陪跑学员」 */
const usage = (product) => (product.forSale ? '仅供购买者个人学习使用' : '仅供陪跑学员个人学习使用');
const headerTemplate = (title, product) => `<div style="box-sizing:border-box;width:100%;padding:0 ${MARGIN.left};font-family:${FONT.replace(/"/g, "'")};font-size:7.5pt;color:#8792a8;-webkit-print-color-adjust:exact;">
  <div style="display:flex;justify-content:space-between;border-bottom:0.3mm solid #e4e9f1;padding-bottom:1.6mm;"><span>${esc(title)}</span><span>${usage(product)}</span></div></div>`;
const footerTemplate = `<div style="box-sizing:border-box;width:100%;text-align:center;font-family:${FONT.replace(/"/g, "'")};font-size:7.5pt;color:#8792a8;">第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>`;

// ------------------------------------------------------------------ 打印前的版式转换（在页面里执行）
function transformInPage(cardCols) {
  const html = (el) => el.innerHTML.trim();
  // 1) 列数很多的表格 → 逐条卡片
  for (const wrap of document.querySelectorAll('.doc-body .table-wrap')) {
    const table = wrap.querySelector('table');
    const ths = table ? [...table.querySelectorAll('thead th')] : [];
    if (ths.length < cardCols) continue;
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.children]);
    const secondShort = rows.every((cells) => (cells[1]?.textContent || '').trim().length <= 20);
    const titleCols = secondShort ? 2 : 1;
    const box = document.createElement('div');
    box.className = 'rcards';
    for (const cells of rows) {
      const card = document.createElement('div');
      card.className = 'rcard';
      const h = document.createElement('div');
      h.className = 'rcard-h';
      h.innerHTML = cells.slice(0, titleCols).map((c) => `<span>${html(c)}</span>`).join('');
      const dl = document.createElement('dl');
      const missing = []; // 值为「未查到」的字段合并成一行，信息不丢、卡片更紧凑
      cells.slice(titleCols).forEach((c, i) => {
        if (!html(c)) return;
        const name = ths[i + titleCols];
        if (c.textContent.trim() === '未查到') { missing.push(name.textContent.trim()); return; }
        dl.insertAdjacentHTML('beforeend', `<dt>${html(name)}</dt><dd>${html(c)}</dd>`);
      });
      if (missing.length === 1) dl.insertAdjacentHTML('beforeend', `<dt>${missing[0]}</dt><dd>未查到</dd>`);
      else if (missing.length > 1) dl.insertAdjacentHTML('beforeend', `<dt class="miss">未查到</dt><dd class="miss">${missing.join('、')}</dd>`);
      card.append(h, dl);
      box.append(card);
    }
    wrap.replaceWith(box);
  }
  // 1b) 剩下的表格：很短的单元格（「未查到」「5分钟」「PPT」）不折行，避免窄列一字一行
  for (const c of document.querySelectorAll('.doc-body td, .doc-body th')) {
    if (c.textContent.trim().length <= 5) c.classList.add('nw');
  }
  // 2) 只有加粗文字的段落当作小标题；「答题要点：」这类开头的短标签加粗
  for (const p of document.querySelectorAll('.doc-body p')) {
    if (p.childNodes.length === 1 && p.firstChild.nodeName === 'STRONG') p.classList.add('label');
  }
  for (const el of document.querySelectorAll('.doc-body p, .doc-body li')) {
    const t = el.firstChild;
    if (!t || t.nodeType !== 3) continue;
    const m = /^([^：:，。、；\s[\]（）()]{2,6})([：:])/u.exec(t.textContent);
    if (!m || !/\p{Script=Han}/u.test(m[1])) continue;
    if (el.tagName === 'P' && el.textContent.trim() === m[0]) { el.classList.add('label'); continue; }
    t.textContent = t.textContent.slice(m[0].length);
    const s = document.createElement('span');
    s.className = 'lead';
    s.textContent = m[0];
    el.insertBefore(s, t);
  }
  // 2b) 紧跟标题、全是「考察点：…」这类短条目的列表 → 一行元信息
  for (const ul of document.querySelectorAll('.doc-body ul')) {
    const prev = ul.previousElementSibling;
    const items = [...ul.children];
    if (!prev || !/^H[2-4]$/.test(prev.tagName) || items.length < 2) continue;
    if (items.every((li) => li.firstElementChild?.classList.contains('lead') && li.textContent.length <= 32 && !li.querySelector('ul,ol'))) ul.classList.add('meta');
  }
  // 3) 题号（P2-02-001 / I07-Q01）做成小标签
  for (const h of document.querySelectorAll('.doc-body h2, .doc-body h3')) {
    const t = h.firstChild;
    if (!t || t.nodeType !== 3) continue;
    const m = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s+/.exec(t.textContent);
    if (!m) continue;
    t.textContent = t.textContent.slice(m[0].length);
    const s = document.createElement('span');
    s.className = 'qno';
    s.textContent = m[1];
    h.insertBefore(s, t);
  }
  // 4) 每个标题和它后面的内容包成一块；短块整体不跨页（题库类内容不会被拆到两页）
  for (const body of document.querySelectorAll('.doc-body')) {
    const blocks = [];
    let cur = null;
    for (const el of [...body.children]) {
      if (/^H[1-3]$/.test(el.tagName)) {
        cur = document.createElement('div');
        cur.className = 'blk';
        body.insertBefore(cur, el);
        blocks.push(cur);
      }
      if (cur) cur.appendChild(el);
    }
    for (let i = 0; i < blocks.length - 1; i++) {
      if (blocks[i].children.length === 1) { // 标题后面紧跟下一个标题：并到一起，避免标题孤零零留在页底
        const next = blocks[i + 1];
        while (next.firstChild) blocks[i].appendChild(next.firstChild);
        next.remove();
        blocks.splice(i + 1, 1);
        i--;
      }
    }
    for (const b of blocks) if (b.textContent.length < 650 && !b.querySelector('.rcards')) b.classList.add('keep');
  }
  // 5) 短列表项、短代码块不跨页
  for (const li of document.querySelectorAll('.doc-body li')) if (li.textContent.length < 420) li.classList.add('keep');
  for (const pre of document.querySelectorAll('.doc-body pre')) if (pre.textContent.split('\n').length < 30) pre.classList.add('short');
}

// ------------------------------------------------------------------ PDF 工具
/** 读取 PDF 的命名目标 → Map(name → 页码，从 1 开始) */
async function readDests(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const idx = new Map(doc.getPages().map((p, i) => [p.ref.toString(), i + 1]));
  const out = new Map();
  const put = (name, val) => {
    let arr = val instanceof PDFRef ? doc.context.lookup(val) : val;
    if (arr instanceof PDFDict) arr = arr.lookup(PDFName.of('D'));
    if (arr instanceof PDFArray && arr.size()) {
      const ref = arr.get(0);
      if (ref instanceof PDFRef && idx.has(ref.toString())) out.set(name, idx.get(ref.toString()));
    }
  };
  const dests = doc.catalog.lookup(PDFName.of('Dests'));
  if (dests instanceof PDFDict) for (const [k, v] of dests.entries()) put(decodeName(k.asString()), v);
  // 兼容 Names 树写法
  const names = doc.catalog.lookup(PDFName.of('Names'));
  const walk = (node) => {
    if (!(node instanceof PDFDict)) return;
    const arr = node.lookup(PDFName.of('Names'));
    if (arr instanceof PDFArray) for (let i = 0; i + 1 < arr.size(); i += 2) put(arr.lookup(i).decodeText?.() ?? String(arr.lookup(i)), arr.get(i + 1));
    const kids = node.lookup(PDFName.of('Kids'));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i));
  };
  if (names instanceof PDFDict) walk(names.lookup(PDFName.of('Dests')));
  return { dests: out, pages: doc.getPageCount() };
}
const decodeName = (s) => s.replace(/^\//, '').replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

async function printPage(browser, html, opts, transform) {
  const page = await browser.newPage();
  try {
    let file = null;
    if (html.length > 1.5e6 || KEEP_HTML) { // 大文档走文件，避免 setContent 过慢
      mkdirSync(TMP, { recursive: true });
      file = join(TMP, `${opts.name}.html`);
      writeFileSync(file, html);
      await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 0 });
    } else {
      await page.setContent(html, { waitUntil: 'load', timeout: 0 });
    }
    if (transform) await page.evaluate(transformInPage, cfg.TABLE_LIMITS.pdfCardCols);
    await page.emulateMediaType('print');
    const { name, ...pdfOpts } = opts;
    const buf = await page.pdf({ format: 'A4', printBackground: true, timeout: 0, ...pdfOpts });
    if (file && !KEEP_HTML) rmSync(file, { force: true });
    return Buffer.from(buf);
  } finally {
    await page.close();
  }
}

async function buildProduct(browser, product) {
  const t0 = Date.now();
  const body = buildBody(product);
  const bodyOpts = { margin: MARGIN, preferCSSPageSize: false };

  // 第 1 遍：只为拿到各篇起始页
  let pages = null;
  let pass = 0;
  let bodyPdf;
  for (;;) {
    pass++;
    const html = shell(product.title, tocHtml(product, body, pages) + body.sections);
    const final = pages != null;
    bodyPdf = await printPage(browser, html, {
      name: `${product.id}-body`, ...bodyOpts,
      displayHeaderFooter: final, headerTemplate: headerTemplate(product.title, product), footerTemplate,
      outline: final, tagged: final,
    }, true);
    const { dests } = await readDests(bodyPdf);
    const next = new Map(body.entries.map((e) => [e.anchor, dests.get(e.anchor) ?? '']));
    const same = pages && [...next].every(([k, v]) => pages.get(k) === v);
    if (final && same) break;
    if (pass >= 3) { console.warn(`[build-pdf] ${product.id}：目录页码两次排版不一致，已使用最后一次结果`); break; }
    pages = next;
  }

  // 封面
  const coverPdf = await printPage(browser, shell(product.title, coverHtml(product, body)), {
    name: `${product.id}-cover`, margin: { top: 0, bottom: 0, left: 0, right: 0 }, displayHeaderFooter: false, pageRanges: '1',
  }, false);

  // 合并 + 页码标签 + 文档属性
  const doc = await PDFDocument.load(bodyPdf, { updateMetadata: false });
  const cover = await PDFDocument.load(coverPdf);
  const [coverPage] = await doc.copyPages(cover, [0]);
  doc.insertPage(0, coverPage);
  const ctx = doc.context;
  doc.catalog.set(PDFName.of('PageLabels'), ctx.obj({
    Nums: [0, ctx.obj({ P: PDFHexString.fromText('封面') }), 1, ctx.obj({ S: 'D', St: 1 })],
  }));
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
  doc.setTitle(product.title, { showInWindowTitleBar: true });
  doc.setAuthor('保研全程陪跑');
  doc.setSubject(product.subtitle || product.title);
  doc.setKeywords(['保研', '推免', product.title]);
  doc.setCreator('保研全程陪跑 资料库');
  doc.setProducer('build-pdf (Chrome + pdf-lib)');
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  doc.setLanguage('zh-CN');
  // 学员工具包不提供下载，但也照样预留（文件格式统一，上传与校验逻辑不用区分）
  await addStampPlaceholders(doc, { title: product.title, usage: usage(product) });
  const bytes = await doc.save({ useObjectStreams: true });
  const out = join(KV, `pdf__${product.id}.pdf`);
  writeFileSync(out, bytes);
  writeFileSync(join(KV, `pdfstamp__${product.id}.json`), JSON.stringify(findStampSlots(bytes)));
  const size = statSync(out).size;
  const pageCount = doc.getPageCount();
  const secs = (Date.now() - t0) / 1000;
  const warn = size > MAX_BYTES ? '（超过 KV 单值 25MB 上限！）' : '';
  console.log(`[build-pdf] ${product.id.padEnd(13)} ${String(pageCount).padStart(4)} 页  ${(size / 1048576).toFixed(2).padStart(6)} MB  ${secs.toFixed(1).padStart(5)}s  ${product.title}${warn}`);
  return { id: product.id, title: product.title, pages: pageCount, size, secs, docs: body.docCount, passes: pass, file: relative(ROOT, out) };
}

// ------------------------------------------------------------------ 主流程
const t0 = Date.now();
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--font-render-hinting=none', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
});
const results = [];
try {
  for (const p of products) results.push(await buildProduct(browser, p));
} finally {
  await browser.close();
}
const total = (Date.now() - t0) / 1000;
console.log(`[build-pdf] 完成 ${results.length} 份，用时 ${total.toFixed(0)}s`);

// 报告：写进 .content/report.md 的 PDF 一节（只更新本次生成的产品，其他沿用已有文件信息）
const rows = catalog.products.map((p) => {
  const r = results.find((x) => x.id === p.id);
  if (r) return `| ${p.id} | ${p.title} | ${r.docs} | ${r.pages} | ${(r.size / 1048576).toFixed(2)} MB | ${r.secs.toFixed(1)}s |`;
  const f = join(KV, `pdf__${p.id}.pdf`);
  return existsSync(f) ? `| ${p.id} | ${p.title} | – | – | ${(statSync(f).size / 1048576).toFixed(2)} MB | （本次未重新生成） |` : `| ${p.id} | ${p.title} | – | – | 未生成 | – |`;
});
appendPdfSection(join(ROOT, '.content', 'report.md'), [
  '## 六、PDF', '',
  `生成时间：${DATE_ISO} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}；Chrome 打印 + pdf-lib 合并封面。页数含封面；页脚页码从目录页开始计。`, '',
  '| 产品 | 名称 | 篇数 | 页数 | 大小 | 用时 |', '|---|---|--:|--:|--:|--:|', ...rows, '',
]);
const over = results.filter((r) => r.size > MAX_BYTES);
if (over.length) {
  console.error(`[build-pdf] 以下 PDF 超过 KV 单值 25MB 上限，上传会失败：${over.map((r) => r.id).join('、')}`);
  process.exitCode = 1;
}
