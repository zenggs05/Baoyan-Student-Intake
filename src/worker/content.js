// Content: manifest loading, product-permission expansion, public catalog, /api/doc and /api/download.
import { HttpError, json, cnDate, SAFE_ID } from './util.js';
import { requireReader, formatSessionCode } from './session.js';
import { applyPdfStamp } from './pdf-stamp.js';

// Small per-isolate cache so a burst of requests doesn't re-parse the manifest every time.
let manifestCache = { at: 0, data: null };
const MANIFEST_CACHE_MS = 15 * 1000;

export async function loadManifest(env) {
  const t = Date.now();
  if (manifestCache.data && t - manifestCache.at < MANIFEST_CACHE_MS) return manifestCache.data;
  let data = null;
  try {
    data = await env.KV.get('manifest', 'json');
  } catch {
    data = null;
  }
  if (!data || !Array.isArray(data.products)) data = { version: 0, products: [] };
  manifestCache = { at: t, data };
  return data;
}

export function _resetManifestCache() {
  manifestCache = { at: 0, data: null };
}

export function findProduct(manifest, id) {
  return manifest.products.find((p) => p.id === id) || null;
}

const isSellable = (p) => p.forSale !== false && !p.studentOnly;

function matchesPattern(pattern, id) {
  if (pattern.endsWith('*')) return id.startsWith(pattern.slice(0, -1));
  return pattern === id;
}

/**
 * Expand a raw product grant into concrete product ids (manifest order).
 * - "all" (string, or inside the array) => every sellable product
 * - `includes` patterns (e.g. P4 -> ["P3-*"]) are followed transitively
 * - student / admin grants additionally include student-only products (KIT)
 */
export function expandProducts(manifest, grant, { student = false, admin = false } = {}) {
  const products = manifest.products || [];
  const list = grant === 'all' ? ['all'] : Array.isArray(grant) ? grant : [];
  const set = new Set();
  for (const id of list) {
    if (id === 'all') products.filter(isSellable).forEach((p) => set.add(p.id));
    else if (findProduct(manifest, id)) set.add(id);
  }
  if (admin) products.forEach((p) => set.add(p.id));
  if (student || admin) products.filter((p) => p.studentOnly).forEach((p) => set.add(p.id));
  // transitive includes
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of products) {
      if (!set.has(p.id) || !Array.isArray(p.includes)) continue;
      for (const pat of p.includes) {
        for (const q of products) {
          if (!set.has(q.id) && matchesPattern(String(pat), q.id)) {
            set.add(q.id);
            changed = true;
          }
        }
      }
    }
  }
  if (!products.length) {
    // No manifest uploaded yet: fall back to the literal ids so the session is still meaningful.
    return list.filter((id) => id !== 'all');
  }
  return products.filter((p) => set.has(p.id)).map((p) => p.id);
}

function publicProduct(p) {
  const docs = Array.isArray(p.docs) ? p.docs : [];
  const out = {
    id: p.id,
    title: p.title || p.id,
    subtitle: p.subtitle || '',
    price: p.price ?? null,
    priceNote: p.priceNote || '',
    sellingPoint: p.sellingPoint || '',
    docCount: docs.length,
    docs: docs.map((d) => ({ id: d.id, title: d.title || d.id })),
    preview: p.preview !== undefined ? Boolean(p.preview) : isSellable(p),
    includes: Array.isArray(p.includes) ? p.includes : [],
    // Same field as .content/public/catalog.json: the front end hides studentOnly products from buyers.
    studentOnly: Boolean(p.studentOnly),
  };
  return out;
}

// GET /api/catalog — sellable products for everyone; student-only products (KIT) only for sessions that can read them.
export async function handleCatalog(env, session) {
  const manifest = await loadManifest(env);
  const allowed = session ? new Set(session.products || []) : new Set();
  const products = manifest.products
    .filter((p) => isSellable(p) || (p.studentOnly && allowed.has(p.id)))
    .map(publicProduct);
  return json({ products });
}

// GET /api/admin/products
export async function handleAdminProducts(env) {
  const manifest = await loadManifest(env);
  const products = manifest.products.map((p) => ({
    id: p.id,
    title: p.title || p.id,
    subtitle: p.subtitle || '',
    price: p.price ?? null,
    priceNote: p.priceNote || '',
    forSale: p.forSale !== false,
    studentOnly: Boolean(p.studentOnly),
    includes: Array.isArray(p.includes) ? p.includes : [],
    docCount: Array.isArray(p.docs) ? p.docs.length : 0,
    pdf: Boolean(p.pdf),
  }));
  return json({ products, builtAt: manifest.builtAt || null, version: manifest.version ?? null });
}

const DOC_HEADERS = { 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' };

function checkId(id) {
  if (!id || !SAFE_ID.test(id)) throw new HttpError(404, '没有找到这份资料，请返回目录重新选择。');
}

function watermarkFor(session) {
  const date = cnDate();
  if (session.type === 'key') {
    return { line1: `LICENSED ${formatSessionCode(session)}`, line2: `${date} · 仅限购买者本人学习使用` };
  }
  if (session.type === 'student') {
    return { line1: `${session.displayName || session.sub} @${session.sub}`, line2: `${date} · 陪跑学员专用 · 请勿转发` };
  }
  return { line1: '管理员预览', line2: date };
}

// GET /api/doc/:productId/:docId
export async function handleDoc(request, env, productId, docId) {
  checkId(productId);
  checkId(docId);
  const { session, manifest } = await requireReader(request, env);
  const product = findProduct(manifest, productId);
  if (!product) throw new HttpError(404, '没有找到这份资料，请返回目录重新选择。');
  if (!session.products.includes(productId)) {
    throw new HttpError(403, '当前的密钥或账号不包含这份资料。如需阅读，请联系作者开通。');
  }
  const doc = (product.docs || []).find((d) => d.id === docId);
  if (!doc) throw new HttpError(404, '没有找到这篇文档，请返回目录重新选择。');
  const html = await env.KV.get(`c:${productId}:${docId}`);
  if (html === null) throw new HttpError(404, '这篇文档暂时无法打开，请稍后再试或联系作者。');
  return json(
    {
      html,
      title: doc.title || docId,
      productId,
      docId,
      productTitle: product.title || productId,
      toc: Array.isArray(doc.toc) ? doc.toc : [],
      watermark: watermarkFor(session),
    },
    200,
    DOC_HEADERS,
  );
}

function contentDisposition(title, fallback) {
  const clean = String(title || fallback).replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').trim() || fallback;
  const encoded = encodeURIComponent(`${clean}.pdf`).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const ascii = String(fallback).replace(/[^A-Za-z0-9_.-]/g, '_');
  return `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encoded}`;
}

// GET /api/download/:productId — key sessions only.
// The licence stamp (key CODE + date, on every page and in the XMP metadata) is written here on the server, so
// every way of fetching the file — the button, typing the URL, saving the response in dev tools — gets the same
// stamped PDF. If the stamp cannot be applied the download is refused rather than serving an unmarked file.
export async function handleDownload(request, env, productId) {
  checkId(productId);
  const { session, manifest } = await requireReader(request, env);
  if (session.type === 'student') throw new HttpError(403, '陪跑账号仅支持在线查看');
  if (session.type !== 'key') throw new HttpError(403, '下载功能仅对密钥用户开放，请用购买时收到的密钥解锁后再下载。');
  const product = findProduct(manifest, productId);
  if (!product) throw new HttpError(404, '没有找到这份资料，请返回目录重新选择。');
  if (!session.products.includes(productId)) {
    throw new HttpError(403, '当前的密钥不包含这份资料，无法下载。如需购买，请联系作者。');
  }
  const [pdf, stamp] = await Promise.all([
    env.KV.get(`pdf:${productId}`, 'arrayBuffer'),
    env.KV.get(`pdfstamp:${productId}`, 'json').catch(() => null),
  ]);
  if (!pdf) throw new HttpError(404, '这份资料的 PDF 暂未上线，请先在线阅读，或联系作者获取。');
  const bytes = new Uint8Array(pdf);
  if (!applyPdfStamp(bytes, stamp, { code: formatSessionCode(session), day: cnDate() })) {
    console.error(`download ${productId}: licence stamp map missing or out of date — re-run build-pdf and upload-content`);
    throw new HttpError(404, '这份资料的 PDF 正在更新，请先在线阅读，稍后再试。');
  }
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDisposition(product.title, productId),
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
      'X-License-Code': formatSessionCode(session),
    },
  });
}
