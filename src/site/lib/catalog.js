// Public catalog helpers. Source: /data/catalog.json (static), falling back to GET /api/catalog.
import { api } from '../../shared/api.js';

let cache = null;

export function loadCatalog() {
  if (!cache) {
    cache = fetch('/data/catalog.json', { credentials: 'same-origin', cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('catalog'))))
      .catch(() => api('/api/catalog'))
      .then((d) => normalize(d))
      .catch((e) => { cache = null; throw e; });
  }
  return cache;
}

/**
 * Make sure every product id the session can read is present. Student-only products (KIT) may be
 * missing from the static file; the session-aware GET /api/catalog includes them.
 */
export async function ensureProducts(catalog, ids) {
  if (!catalog || !Array.isArray(ids) || ids.every((id) => catalog.byId.has(id))) return catalog;
  try {
    const extra = normalize(await api('/api/catalog'));
    for (const p of extra.products) {
      if (!catalog.byId.has(p.id)) { catalog.products.push(p); catalog.byId.set(p.id, p); }
    }
  } catch { /* keep what we have */ }
  return catalog;
}

function normalize(d) {
  const products = (Array.isArray(d) ? d : d?.products || []).filter((p) => p && p.id);
  for (const p of products) {
    p.docs = Array.isArray(p.docs) ? p.docs : [];
    if (p.docCount == null) p.docCount = p.docs.length;
  }
  const byId = new Map(products.map((p) => [p.id, p]));
  return { products, byId, get: (id) => byId.get(id) };
}

export const isP3 = (id) => /^P3-/.test(id || '');
export const isStudentOnly = (p) => p?.id === 'KIT' || p?.studentOnly === true;

/** "单校面经复盘·东南大学集成电路学院" -> "东南大学集成电路学院" */
export function shortTitle(p) {
  const t = p?.title || '';
  return isP3(p?.id) ? t.replace(/^单校面经复盘\s*[·・:：\-—]\s*/, '') : t;
}

export function fmtPrice(price) {
  if (price == null || price === '') return '';
  const n = Number(price);
  return Number.isFinite(n) ? `¥${n}` : String(price);
}

/** Expand the products a product "includes" (e.g. P4 -> every P3-*) against the catalog. */
export function includedProducts(catalog, p) {
  const inc = Array.isArray(p?.includes) ? p.includes : [];
  if (!inc.length) return [];
  return catalog.products.filter((q) => q.id !== p.id && inc.some((pat) => (pat.endsWith('*') ? q.id.startsWith(pat.slice(0, -1)) : q.id === pat)));
}

/** Fetch a public HTML fragment; resolves to '' when missing. */
export async function fetchFragment(path) {
  try {
    const r = await fetch(path, { credentials: 'same-origin', cache: 'no-cache' });
    if (!r.ok) return '';
    const ct = r.headers.get('Content-Type') || '';
    if (ct && !ct.includes('html') && !ct.includes('text/plain')) return '';
    const text = await r.text();
    // Guard against an SPA-style fallback that serves a whole page instead of a 404
    if (/^\s*<!doctype|<html[\s>]/i.test(text.slice(0, 500))) return '';
    return text;
  } catch {
    return '';
  }
}

/** Sale page for a product; P3-* products fall back to the shared P3 sale page. */
export async function fetchSale(id) {
  const own = await fetchFragment(`/data/library/${encodeURIComponent(id)}/sale.html`);
  if (own || !isP3(id)) return own;
  return fetchFragment('/data/library/P3/sale.html');
}

export const fetchPreview = (id) => fetchFragment(`/data/library/${encodeURIComponent(id)}/preview.html`);

export const itemUrl = (id, hash = '') => `/library/item.html?p=${encodeURIComponent(id)}${hash}`;
export const readUrl = (id, docId) => `/library/read.html?p=${encodeURIComponent(id)}${docId ? `&d=${encodeURIComponent(docId)}` : ''}`;
