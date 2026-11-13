// 读取 catalog.config.mjs，扫描源目录，得到完整的产品 / 文档 / 公开页面清单。
// build-content 与 build-pdf 共用这一份结果，保证两边 docId、顺序、标题一致。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import * as defaultConfig from '../catalog.config.mjs';
import { cleanSource, firstH1, normalizeSource, splitFences } from './clean.mjs';

const sha = (s, n = 6) => createHash('sha1').update(s).digest('hex').slice(0, n);

/** 把「学校_学院」拼成 ASCII slug：学校缩写 + 学院缩写。学校查不到时返回 null。 */
export function autoSlug(key, cfg = defaultConfig) {
  let rest = key.replace(/\.md$/i, '');
  const schools = [];
  const names = Object.keys(cfg.SCHOOL_ABBR).sort((a, b) => b.length - a.length);
  // 按出现位置收集学校（一个文件可能写两个单位，如「中科院金属所与苏州纳米所」）
  const found = [];
  for (const name of names) {
    let idx = rest.indexOf(name);
    while (idx >= 0) {
      found.push({ idx, name });
      rest = rest.slice(0, idx) + ' '.repeat(name.length) + rest.slice(idx + name.length);
      idx = rest.indexOf(name);
    }
  }
  found.sort((a, b) => a.idx - b.idx).forEach((f) => {
    const ab = cfg.SCHOOL_ABBR[f.name];
    if (!schools.includes(ab)) schools.push(ab);
  });
  if (!schools.length) return null;
  const depts = [];
  for (const [word, ab] of cfg.DEPT_ABBR) {
    const idx = rest.indexOf(word);
    if (idx < 0) continue;
    rest = rest.slice(0, idx) + ' '.repeat(word.length) + rest.slice(idx + word.length);
    if (ab && !depts.includes(ab) && !schools.includes(ab)) depts.push(ab);
  }
  return [...schools, ...depts].join('-');
}

/** P3 单校文件名 → slug。返回 {slug, rule:'map'|'auto'|'hash'} */
export function p3Slug(fileName, cfg = defaultConfig) {
  const key = fileName.replace(/\.md$/i, '').replace(/^P3_/, '');
  if (cfg.P3_SLUGS[key]) return { slug: cfg.P3_SLUGS[key], rule: 'map' };
  const auto = autoSlug(key, cfg);
  if (auto) return { slug: auto, rule: 'auto' };
  return { slug: `x-${sha(key)}`, rule: 'hash' };
}

/** 公开汇编文件名 → docId。 */
export function publicSlug(fileName, cfg = defaultConfig) {
  const key = fileName.replace(/\.md$/i, '').replace(/^P3公开_/, '');
  if (cfg.PUBLIC_SLUGS[key]) return { slug: cfg.PUBLIC_SLUGS[key], rule: 'map' };
  const auto = autoSlug(key, cfg);
  if (auto) return { slug: `pub-${auto}`, rule: 'auto' };
  return { slug: `pub-x-${sha(key)}`, rule: 'hash' };
}

/** 普通文件名 → docId：P5_D1_xxx → D1；P2_03_xxx → P2_03；其余取 ASCII 部分。 */
export function plainDocId(fileName) {
  const base = fileName.replace(/\.md$/i, '');
  let m;
  if ((m = /^P\d+_(D\d+)(?:_|$)/.exec(base))) return m[1];
  if ((m = /^(P\d+_\d+)(?:_|$)/.exec(base))) return m[1];
  if ((m = /^([A-Z]+(?:_[A-Z0-9]+)*)(?:_|$)/.exec(base))) return m[1];
  const ascii = base.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return ascii || `doc-${sha(base)}`;
}

/** 文件名里的序号（用于排序）：P1_03 → 3，P5_D2 → 2，P5_08 → 8。 */
export function docOrder(fileName) {
  const m = /^P\d+_D?(\d+)/.exec(fileName);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

const listMd = (dir, pattern) => (existsSync(dir) ? readdirSync(dir) : [])
  .filter((f) => pattern.test(f) && statSync(join(dir, f)).isFile())
  .sort((a, b) => a.localeCompare(b, 'zh-CN'));

function readTitle(file, options = {}) {
  const raw = readFileSync(file, 'utf8');
  const { text } = cleanSource(raw, options);
  return firstH1(text) || basename(file).replace(/\.md$/i, '');
}

/** 从售卖页提取一句话卖点：优先「一句话卖点：…」，否则第一个二级标题。 */
export function extractSellingPoint(src) {
  const text = normalizeSource(src);
  for (const p of splitFences(text)) {
    if (p.code) continue;
    let m = /^\s*[-*]?\s*\**一句话卖点\**\s*[:：]\s*(.+?)\s*$/m.exec(p.text);
    if (m) return m[1].replace(/\*\*/g, '').trim();
  }
  for (const p of splitFences(text)) {
    if (p.code) continue;
    const m = /^## +(.+?)\s*#*\s*$/m.exec(p.text);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * 读取全部产品定义。返回：
 * {
 *   products: [{ id, title, subtitle, price, priceNote, sellingPoint, forSale, studentOnly, includes, pdfParts,
 *                saleFile, previewFile, family, docs:[{id, file, name, title, options}] }],
 *   services: [{ code, file, title }],
 *   files: Map<绝对路径, {productId, docId}>,   // 每个正文文件属于哪个产品（第一个声明者）
 *   notes: [字符串]                               // 给 report 的说明（slug 规则、重复文件等）
 * }
 */
export function loadCatalog(cfg = defaultConfig) {
  const CONTENT = cfg.CONTENT_ROOT;
  const SOP = cfg.SOP_ROOT;
  if (!existsSync(CONTENT)) throw new Error(`找不到资料源目录 ${CONTENT}（可用环境变量 CONTENT_ROOT 指定）`);
  const notes = [];
  const products = [];
  const abs = (rel, root = CONTENT) => (rel ? join(root, rel).replace(/\\/g, '/') : null);
  const exists = (p) => (p && existsSync(p) ? p : null);

  for (const def of cfg.PRODUCTS) {
    const base = {
      price: def.price ?? null,
      priceNote: def.priceNote || '',
      forSale: def.forSale !== false,
      studentOnly: !!def.studentOnly,
      includesPatterns: def.includes || [],
      pdfPartsDef: def.pdfParts || null,
      family: def.id,
    };
    const saleFile = exists(abs(def.sale));
    const sellingPoint = def.sellingPoint || (saleFile ? extractSellingPoint(readFileSync(saleFile, 'utf8')) : '');
    if (def.sale && !saleFile) notes.push(`${def.id}：售卖页 ${def.sale} 不存在`);

    if (def.kind === 'dir' || def.kind === 'codes') {
      let docs = [];
      if (def.kind === 'dir') {
        const dir = abs(def.dir);
        docs = listMd(dir, def.pattern)
          .sort((a, b) => docOrder(a) - docOrder(b) || a.localeCompare(b))
          .map((name) => {
            const options = def.docOptions?.[name] || {};
            return { id: plainDocId(name), name, file: `${dir}/${name}`, options };
          });
        for (const extra of def.extraDirs || []) {
          const edir = abs(extra.dir);
          const files = listMd(edir, extra.pattern);
          const order = cfg.PUBLIC_ORDER || [];
          const keyOf = (f) => f.replace(/\.md$/i, '').replace(/^P3公开_/, '');
          files.sort((a, b) => {
            const ia = order.indexOf(keyOf(a)), ib = order.indexOf(keyOf(b));
            return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.localeCompare(b, 'zh-CN');
          });
          for (const name of files) {
            const s = extra.slug === 'public' ? publicSlug(name, cfg) : { slug: plainDocId(name), rule: 'plain' };
            if (s.rule !== 'map') notes.push(`${def.id}：新文件 ${name} 自动生成 docId「${s.slug}」（${s.rule === 'hash' ? '学校不在字典里，用了哈希；建议在 catalog.config.mjs 的 PUBLIC_SLUGS 补一条' : '按学校/学院字典拼写'}）`);
            docs.push({ id: s.slug, name, file: `${edir}/${name}`, options: {} });
          }
        }
      } else {
        const dir = SOP;
        const all = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')) : [];
        for (const code of def.codes) {
          const name = all.find((f) => f.startsWith(`${code}_`));
          if (!name) { notes.push(`${def.id}：找不到代号 ${code} 对应的文件`); continue; }
          docs.push({ id: code, name, file: `${dir}/${name}`.replace(/\\/g, '/'), options: {} });
        }
      }
      // 去重 docId
      const seen = new Set();
      for (const d of docs) {
        let id = d.id, k = 2;
        while (seen.has(id)) id = `${d.id}-${k++}`;
        if (id !== d.id) notes.push(`${def.id}：docId「${d.id}」重复，${d.name} 改用「${id}」`);
        d.id = id;
        seen.add(id);
        d.title = readTitle(d.file, d.options);
      }
      products.push({
        ...base, id: def.id, title: def.title, subtitle: def.subtitle || '', sellingPoint, // 函数形式在展开 includes 后再求值
        saleFile, previewFile: exists(abs(def.preview)), docs,
      });
    } else if (def.kind === 'perFile') {
      const dir = abs(def.dir);
      const files = listMd(dir, def.pattern);
      // 按售卖页「完整目录」的顺序排列，没列出的放最后
      const saleOrder = saleFile ? [...normalizeSource(readFileSync(saleFile, 'utf8')).matchAll(/\]\(([^)]+\.md)\)/g)].map((m) => decodeURIComponent(m[1]).split('/').pop()) : [];
      files.sort((a, b) => {
        const ia = saleOrder.indexOf(a), ib = saleOrder.indexOf(b);
        return (ia < 0 ? 1e9 : ia) - (ib < 0 ? 1e9 : ib) || a.localeCompare(b, 'zh-CN');
      });
      const used = new Set(products.map((p) => p.id));
      for (const name of files) {
        const s = p3Slug(name, cfg);
        let id = `${def.idPrefix}-${s.slug}`;
        let k = 2;
        while (used.has(id)) id = `${def.idPrefix}-${s.slug}-${k++}`;
        used.add(id);
        if (s.rule !== 'map') notes.push(`${def.id}：新文件 ${name} 自动生成产品 id「${id}」（${s.rule === 'hash' ? '学校不在字典里，用了哈希；建议在 P3_SLUGS 补一条' : '按学校/学院字典拼写'}）`);
        const school = name.replace(/\.md$/i, '').replace(/^P3_/, '').split('_').join('');
        const slug = id.slice(def.idPrefix.length + 1);
        const file = `${dir}/${name}`;
        products.push({
          ...base, id, slug, title: `${def.titlePrefix || ''}${school}`,
          subtitle: typeof def.subtitle === 'function' ? def.subtitle(school) : (def.subtitle || ''),
          sellingPoint, saleFile,
          previewFile: exists(abs(def.previewBySlug?.[slug] || def.preview)),
          docs: [{ id: slug, name, file, options: {}, title: readTitle(file) }],
        });
      }
    } else {
      throw new Error(`未知的产品类型 ${def.kind}（${def.id}）`);
    }
  }

  // 展开 includes 里的通配；解析 PDF 分部
  const expand = (patterns, selfId) => [...new Set(patterns.flatMap((pat) => (pat.endsWith('*')
    ? products.filter((p) => p.id.startsWith(pat.slice(0, -1))).map((p) => p.id)
    : products.some((p) => p.id === pat) ? [pat] : [])))].filter((id) => id !== selfId);
  for (const p of products) {
    p.includes = expand(p.includesPatterns, p.id);
    delete p.includesPatterns;
  }
  for (const p of products) if (typeof p.subtitle === 'function') p.subtitle = String(p.subtitle(p));
  // PDF 分部：[{label, items:[{productId, doc}]}]
  const matchId = (pat, id) => (pat.endsWith('*') ? id.startsWith(pat.slice(0, -1)) : id === pat);
  for (const p of products) {
    const parts = [];
    const used = new Set();
    for (const part of p.pdfPartsDef || []) {
      const items = [];
      for (const pat of part.docs || []) {
        for (const d of p.docs) if (matchId(pat, d.id) && !used.has(d.id)) { used.add(d.id); items.push({ productId: p.id, doc: d }); }
      }
      for (const pid of expand(part.products || [], p.id)) {
        const other = products.find((x) => x.id === pid);
        for (const d of other.docs) items.push({ productId: other.id, doc: d });
      }
      if (items.length) parts.push({ label: part.label || '', items });
    }
    const rest = p.docs.filter((d) => !used.has(d.id)).map((d) => ({ productId: p.id, doc: d }));
    if (rest.length) parts.push({ label: parts.length ? '其他' : '', items: rest });
    p.pdfParts = parts;
    delete p.pdfPartsDef;
  }

  // 正文文件 → 所属产品（第一个声明者）
  const files = new Map();
  for (const p of products) for (const d of p.docs) if (!files.has(d.file)) files.set(d.file, { productId: p.id, docId: d.id, title: d.title });

  // 服务介绍页
  const services = [];
  const sdir = `${SOP}/${cfg.SERVICES_DIR}`;
  if (existsSync(sdir)) {
    for (const name of readdirSync(sdir).filter((f) => f.endsWith('.md')).sort()) {
      const m = /^([A-Z]+(?:_[A-Z0-9]+)*)_/.exec(name);
      const code = m ? m[1] : plainDocId(name);
      const file = `${sdir}/${name}`;
      services.push({ code, name, file, title: readTitle(file) });
    }
  } else notes.push(`服务介绍页目录 ${sdir} 不存在`);

  return { products, services, files, notes, contentRoot: CONTENT, sopRoot: SOP };
}

/**
 * 链接解析器。
 * mode 'web'   —— 正文（KV）与公开页：文档 → /library/read.html?p=&d=，售卖页 → item.html，试读 → item.html#preview
 * mode 'public'—— 公开页：单篇即一个产品的文档（P3）→ item.html；其余同 web
 * mode 'pdf'   —— 只保留同一份 PDF 内部的跳转（#doc-…），其他链接去掉
 */
export function makeResolver(catalog, { mode = 'web', productId = null, pdfDocs = null } = {}) {
  const byName = new Map();
  for (const p of catalog.products) {
    for (const d of p.docs) if (!byName.has(d.name)) byName.set(d.name, { kind: 'doc', productId: p.id, docId: d.id, title: d.title, single: p.docs.length === 1 && p.family !== p.id });
  }
  const pageBy = (field, kind) => {
    for (const p of catalog.products) {
      const f = p[field];
      if (!f) continue;
      const name = f.split('/').pop();
      const list = byName.get(name);
      if (list && list.kind !== kind) continue;
      if (!byName.has(name)) byName.set(name, { kind, products: [] });
      byName.get(name).products.push(p.id);
    }
  };
  pageBy('saleFile', 'sale');
  pageBy('previewFile', 'preview');

  return ({ file }) => {
    const hit = byName.get(file);
    if (!hit) return null;
    if (mode === 'pdf') {
      if (hit.kind !== 'doc' || !pdfDocs) return null;
      const anchor = pdfDocs.get(`${hit.productId}/${hit.docId}`);
      return anchor ? { href: `#${anchor}`, title: hit.title } : { href: null, title: hit.title };
    }
    const q = (s) => encodeURIComponent(s);
    if (hit.kind === 'doc') {
      if (mode === 'public' && hit.single) return { href: `/library/item.html?p=${q(hit.productId)}`, title: hit.title };
      return { href: `/library/read.html?p=${q(hit.productId)}&d=${q(hit.docId)}`, title: hit.title };
    }
    const pid = hit.products.includes(productId) ? productId : hit.products[0];
    if (hit.kind === 'sale') return { href: `/library/item.html?p=${q(pid)}` };
    if (hit.kind === 'preview') return { href: `/library/item.html?p=${q(pid)}#preview` };
    return null;
  };
}
