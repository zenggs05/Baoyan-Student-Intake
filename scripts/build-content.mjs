// 内容构建（docs/ARCHITECTURE.md §5.2–5.3）：md → HTML 片段 + 清单 + 公开页 + 报告。
//   node scripts/build-content.mjs            构建到 .content/
//   CONTENT_ROOT=… SOP_ROOT=… 可覆盖资料源目录（只读，绝不修改源文件）
// 产物：
//   .content/kv/manifest.json、.content/kv/c__<p>__<doc>.html        （只进 KV，不进静态资源）
//   .content/public/catalog.json、library/<p>/sale.html|preview.html、services/<code>.html、services/index.json
//   .content/report.md                                                （给作者看的检查报告）
// 发布前检查：公开页与锁定正文逐句比对，重复过多的公开页不写进 .content/public/（见 lib-content/leak-gate.mjs）。
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as cfg from './catalog.config.mjs';
import { loadCatalog, makeResolver } from './lib-content/catalog.mjs';
import { cleanSource, findPlaceholders, findInternalTerms, countWords, findRiskyHtml } from './lib-content/clean.mjs';
import { renderMarkdown } from './lib-content/render.mjs';
import { writeReport } from './lib-content/report.mjs';
import { checkPublicLeaks } from './lib-content/leak-gate.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.content');
const KV = join(OUT, 'kv');
const PUB = join(OUT, 'public');

const t0 = Date.now();
const catalog = loadCatalog(cfg);
const srcRel = (file) => {
  for (const [root, label] of [[catalog.contentRoot, ''], [catalog.sopRoot, '04_服务模板与SOP/']]) {
    const r = relative(root, file).replace(/\\/g, '/');
    if (!r.startsWith('..')) return label + r;
  }
  return file;
};

/** 清洗 + 渲染一个源文件，同时收集报告需要的检查结果。 */
function processFile(file, { resolveLink, options = {}, idPrefix = '' } = {}) {
  const raw = readFileSync(file, 'utf8');
  const { text, meta, comments } = cleanSource(raw, options);
  const r = renderMarkdown(text, { resolveLink, idPrefix, disclaimerPrefix: cfg.DISCLAIMER_PREFIX });
  return {
    ...r,
    rel: srcRel(file),
    meta,
    comments,
    placeholders: findPlaceholders(text),
    internal: findInternalTerms(text, cfg.INTERNAL_TERMS, cfg.DISCLAIMER_PREFIX),
    words: countWords(text, cfg.DISCLAIMER_PREFIX),
    risky: findRiskyHtml(text),
    trimmed: options.trim || null,
  };
}

// ---------------------------------------------------------------- 清理旧产物（保留 PDF：它由 build-pdf 生成）
mkdirSync(KV, { recursive: true });
for (const f of readdirSync(KV)) if (f.startsWith('c__') || f === 'manifest.json') rmSync(join(KV, f));
rmSync(PUB, { recursive: true, force: true });
mkdirSync(PUB, { recursive: true });

// ---------------------------------------------------------------- 正文
const webResolver = makeResolver(catalog, { mode: 'web' });
const reportProducts = [];
const manifestProducts = [];
const hash = createHash('sha256');
const lockedDocs = []; // 给发布前检查用
let kvFiles = 0;
for (const p of catalog.products) {
  const docs = [];
  const rdocs = [];
  for (const d of p.docs) {
    const r = processFile(d.file, { resolveLink: webResolver, options: d.options });
    const out = `c__${p.id}__${d.id}.html`;
    writeFileSync(join(KV, out), r.html);
    lockedDocs.push({ productId: p.id, docId: d.id, title: `${p.title} · ${d.title}`, html: r.html });
    hash.update(out).update(r.html);
    kvFiles++;
    docs.push({ id: d.id, title: d.title, toc: r.toc });
    rdocs.push({ id: d.id, title: d.title, ...r });
  }
  manifestProducts.push({
    id: p.id, title: p.title, subtitle: p.subtitle, price: p.price, priceNote: p.priceNote,
    sellingPoint: p.sellingPoint, forSale: p.forSale, studentOnly: p.studentOnly, includes: p.includes,
    docs, pdf: true,
  });
  reportProducts.push({ id: p.id, title: p.title, docs: rdocs, product: p });
}

const builtAt = Date.now();
hash.update(JSON.stringify(manifestProducts));
const d = new Date(builtAt);
const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
const version = `${ymd}-${hash.digest('hex').slice(0, 8)}`;
const manifest = { version, builtAt, products: manifestProducts };
writeFileSync(join(KV, 'manifest.json'), JSON.stringify(manifest));

// ---------------------------------------------------------------- 公开页面
// 先全部渲染到内存（pending），过了发布前检查再写盘。
const publicPages = [];
const catalogJson = { products: [] };
const pending = []; // {rel, html, kind, productId, family}
const writeFile = (rel, html) => {
  const f = join(PUB, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, html);
};
const writePublic = (rel, html, meta) => pending.push({ rel, html, ...meta });
const renderedOnce = new Map(); // 同一个源文件（P3 售卖页）只在报告里出现一次
for (const p of catalog.products) {
  const resolver = makeResolver(catalog, { mode: 'public', productId: p.id });
  for (const [kind, file] of [['sale', p.saleFile], ['preview', p.previewFile]]) {
    if (!file) continue;
    // 售卖页和试读可能出现在同一个页面里，标题 id 加前缀避免重复
    const r = processFile(file, { resolveLink: resolver, idPrefix: `${kind}-` });
    writePublic(`library/${p.id}/${kind}.html`, r.html, { kind, productId: p.id, family: p.family });
    const key = `${kind}:${file}`;
    if (renderedOnce.has(key)) renderedOnce.get(key).usedBy.push(p.id);
    else {
      const entry = { kind, id: p.id, usedBy: [p.id], title: r.title, ...r };
      if (kind === 'sale') entry.priceCheck = checkPrice(readFileSync(file, 'utf8'), p);
      renderedOnce.set(key, entry);
      publicPages.push(entry);
    }
  }
  // 学员专属产品（KIT）不进静态清单，和匿名访问 /api/catalog 一致；学员、管理员登录后前端从 /api/catalog 补齐
  if (p.studentOnly) continue;
  catalogJson.products.push({
    id: p.id, title: p.title, subtitle: p.subtitle, price: p.price, priceNote: p.priceNote,
    sellingPoint: p.sellingPoint, docCount: p.docs.length, docs: p.docs.map((x) => ({ id: x.id, title: x.title })),
    preview: !!p.previewFile, includes: p.includes, studentOnly: false,
  });
}
writeFile('catalog.json', JSON.stringify(catalogJson));

// 单校系列（P3）另外放一份系列级的售卖页 / 试读：library/P3/sale.html、preview.html（前端找不到单品页面时的兜底）
for (const def of cfg.PRODUCTS.filter((x) => x.kind === 'perFile')) {
  const resolver = makeResolver(catalog, { mode: 'public', productId: catalog.products.find((p) => p.family === def.id)?.id });
  for (const [kind, rel] of [['sale', def.sale], ['preview', def.preview]]) {
    const file = rel && join(catalog.contentRoot, rel);
    if (file && existsSync(file)) writePublic(`library/${def.id}/${kind}.html`, processFile(file, { resolveLink: resolver, idPrefix: `${kind}-` }).html, { kind, productId: null, family: def.id });
  }
}

const servicesIndex = [];
for (const s of catalog.services) {
  const r = processFile(s.file, { resolveLink: makeResolver(catalog, { mode: 'public' }), idPrefix: 'svc-' });
  writePublic(`services/${s.code}.html`, r.html, { kind: 'service', productId: null, family: null });
  servicesIndex.push({ code: s.code, title: s.title });
  publicPages.push({ kind: 'service', id: s.code, usedBy: [s.code], ...r });
}

// ---------------------------------------------------------------- 发布前检查：公开页 × 锁定正文
const leak = checkPublicLeaks({
  locked: lockedDocs,
  pages: pending.map((x) => ({ id: x.rel, kind: x.kind, productId: x.productId, family: x.family, html: x.html })),
  products: catalog.products,
  limits: cfg.LEAK_LIMITS,
  allow: cfg.LEAK_ALLOW,
});
for (const x of pending) if (!leak.withheld.has(x.rel)) writeFile(x.rel, x.html);
const withheldServices = new Set([...leak.withheld.keys()].filter((r) => r.startsWith('services/')).map((r) => r.slice(9, -5)));
writeFile('services/index.json', JSON.stringify({ services: servicesIndex.filter((s) => !withheldServices.has(s.code)) }));

/** 售卖页里的「价格：…」和配置是否一致。 */
function checkPrice(src, p) {
  const line = (src.match(/价格[:：][^\n]*/) || [''])[0];
  if (p.price == null) return null;
  const nums = (line.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  return { line: line.slice(0, 80), ok: nums.includes(p.price) };
}

// ---------------------------------------------------------------- 报告
writeReport(join(OUT, 'report.md'), {
  builtAt, version, contentRoot: catalog.contentRoot, sopRoot: catalog.sopRoot,
  products: reportProducts, publicPages, notes: catalog.notes, limits: cfg.TABLE_LIMITS, kvFiles,
  weakTerms: cfg.INTERNAL_TERMS_WEAK, leak,
});

const pubCount = pending.length - leak.withheld.size;
console.log(`[build-content] ${catalog.products.length} 个产品、${kvFiles} 篇正文、${pubCount} 个公开页面，版本 ${version}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (leak.withheld.size) {
  console.warn(`[build-content] 警告：${leak.withheld.size} 个公开页与锁定正文重复过多，本次没有发布（服务介绍会显示「详细说明正在整理中」）：`);
  for (const [rel, why] of leak.withheld) {
    console.warn(`  - ${rel}：${why.map((w) => (w.own ? `试读合计公开了「${w.title}」${w.hits}/${w.total} 句` : `与「${w.title}」重复 ${w.hits}/${w.total} 句`)).join('；')}`);
  }
  console.warn('[build-content] 请改写这些页面的源文件（只写服务范围、价格、流程，不要粘贴模板或正文），重新构建后会自动发布。确属有意公开的，可在 catalog.config.mjs 的 LEAK_ALLOW 里登记。');
}
console.log(`[build-content] 报告：${relative(ROOT, join(OUT, 'report.md'))}`);
