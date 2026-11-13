// License keys: generation, normalisation, redemption and admin management.
import {
  HttpError, json, now, MINUTE, ttlUntil, randomBytes, readJson, rateLimit, clientIp, formatCode,
} from './util.js';
import {
  createSession, destroySession, resolveSession, publicSession, readAuthJson, isKeyRevoked, revokedKeyName,
} from './session.js';
import { loadManifest, findProduct, expandProducts } from './content.js';

export { formatCode };

// Crockford Base32 (no I, L, O, U).
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/;

// 12 symbols x 5 bits = 60 bits. 256 is a multiple of 32, so `byte & 31` is unbiased.
export function generateCode() {
  const b = randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[b[i] & 31];
  return s;
}

/**
 * Normalise what a buyer typed into the canonical 12-char CODE.
 * Full-width characters (Chinese IME) are folded to ASCII, then: uppercase, drop spaces and dashes,
 * O -> 0, I / L -> 1. Returns '' when the result is not a well-formed code.
 */
export function normalizeCode(input) {
  if (input === null || input === undefined) return '';
  let s = String(input).normalize('NFKC').toUpperCase();
  s = s.replace(/[\s 　\-‐-―−－_·.]/g, '');
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE_RE.test(s) ? s : '';
}

function keyMetadata(rec) {
  return {
    products: rec.products,
    label: rec.label,
    expiresAt: rec.expiresAt,
    uses: rec.uses,
    maxUses: rec.maxUses,
    createdAt: rec.createdAt,
    revoked: Boolean(rec.revoked),
  };
}

async function putKey(env, rec, ttlSec) {
  await env.KV.put(`key:${rec.code}`, JSON.stringify(rec), {
    expirationTtl: Math.max(60, ttlSec ?? ttlUntil(rec.expiresAt)),
    metadata: keyMetadata(rec),
  });
}

async function getKey(env, code) {
  if (!code) return null;
  return readAuthJson(env, `key:${code}`);
}

// POST /api/redeem {code}
export async function handleRedeem(request, env) {
  await rateLimit(env, `redeem:${clientIp(request)}`);
  const body = await readJson(request);
  const rawCode = typeof body.code === 'string' ? body.code.trim() : '';
  if (!rawCode) throw new HttpError(400, '请输入密钥');
  const code = normalizeCode(rawCode);
  const t = now();
  const [rec, revoked] = code ? await Promise.all([getKey(env, code), isKeyRevoked(env, code)]) : [null, false];
  // The tombstone wins over whatever (possibly stale) copy of key:<CODE> this edge has cached.
  if (revoked) throw new HttpError(403, '该密钥已被撤销');
  if (!rec || !(rec.expiresAt > t)) {
    throw new HttpError(404, '密钥无效或已过期');
  }
  if (rec.revoked) throw new HttpError(403, '该密钥已被撤销');

  // Re-entering the code that this browser is already unlocked with should not burn another use.
  const current = await resolveSession(request, env);
  if (current.session && current.session.type === 'key' && current.session.sub === code) {
    return json({ session: publicSession(current.session) });
  }

  const uses = Number(rec.uses) || 0;
  const maxUses = Number(rec.maxUses) || 1;
  if (uses >= maxUses) throw new HttpError(403, '该密钥已达到使用次数上限');

  // Only the use counter changes here. If this edge served a stale copy, the rewrite may resurrect an old
  // `revoked:false` in key:<CODE>, but revocation is decided by the revoked:<CODE> tombstone, which this path
  // never writes — so a stale redeem cannot undo a revoke. (The counter itself is not atomic across edges; see
  // docs/ARCHITECTURE.md §3.)
  rec.uses = uses + 1;
  rec.lastUsedAt = t;
  await putKey(env, rec);

  if (current.token) await destroySession(env, current.token);
  // The buyer note (rec.label) is admin-only: it is not copied into the session record.
  const { cookie } = await createSession(env, { type: 'key', sub: code, products: rec.products }, rec.expiresAt);
  const resolved = await resolveAfterCreate(env, rec, code);
  return json({ session: publicSession(resolved) }, 200, { 'Set-Cookie': cookie });
}

// Build the public session shape for a freshly redeemed key without another round-trip.
async function resolveAfterCreate(env, rec, code) {
  const manifest = await loadManifest(env);
  return {
    type: 'key',
    sub: code,
    code: formatCode(code),
    displayName: '',
    products: expandProducts(manifest, rec.products),
    expiresAt: rec.expiresAt,
    canDownload: true,
  };
}

// ---------- admin ----------

function parseIntInRange(v, def, min, max, msg) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, msg);
  return n;
}

// POST /api/admin/keys {products:[id], label?, minutes?=30, maxUses?=3}
export async function handleCreateKey(request, env) {
  const body = await readJson(request);
  const manifest = await loadManifest(env);
  let products = Array.isArray(body.products) ? body.products : typeof body.products === 'string' ? [body.products] : [];
  products = [...new Set(products.map((x) => String(x).trim()).filter(Boolean))];
  if (!products.length) throw new HttpError(400, '请至少选择一个产品。');
  if (products.length > 50) throw new HttpError(400, '一次选择的产品太多了，请分开发码。');
  for (const id of products) {
    const p = findProduct(manifest, id);
    if (manifest.products.length && !p) throw new HttpError(400, `找不到产品「${id}」，请刷新页面后重试。`);
    if (p && p.studentOnly) throw new HttpError(400, `「${p.title || id}」仅对陪跑学员开放，不能生成密钥。`);
  }
  const minutes = parseIntInRange(body.minutes, 30, 1, 1440, '有效时长需要是 1 到 1440 之间的整数（分钟）。');
  const maxUses = parseIntInRange(body.maxUses, 3, 1, 100, '可用次数需要是 1 到 100 之间的整数。');
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';

  let code = '';
  for (let i = 0; i < 5 && !code; i++) {
    const c = generateCode();
    if (!(await getKey(env, c))) code = c;
  }
  if (!code) throw new HttpError(400, '生成密钥失败，请再试一次。');

  const t = now();
  const rec = { code, products, label, createdAt: t, expiresAt: t + minutes * MINUTE, maxUses, uses: 0, revoked: false };
  await putKey(env, rec);
  return json({ code: formatCode(code), expiresAt: rec.expiresAt, products, label, maxUses, minutes, createdAt: t });
}

async function listNames(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix, cursor });
    out.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// GET /api/admin/keys — active (unexpired, unrevoked) keys, from KV list metadata.
export async function handleListKeys(env) {
  const t = now();
  const keys = [];
  const revoked = new Set((await listNames(env, 'revoked:')).map((k) => k.name.slice('revoked:'.length)));
  let cursor;
  do {
    const page = await env.KV.list({ prefix: 'key:', cursor });
    for (const k of page.keys) {
      const m = k.metadata || {};
      if (m.revoked || revoked.has(k.name.slice(4)) || !(m.expiresAt > t)) continue;
      keys.push({
        code: formatCode(k.name.slice(4)),
        products: m.products || [],
        label: m.label || '',
        expiresAt: m.expiresAt,
        uses: m.uses ?? 0,
        maxUses: m.maxUses ?? 0,
        createdAt: m.createdAt ?? null,
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  keys.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json({ keys });
}

// POST /api/admin/keys/:code/revoke
// Writes the revoked:<CODE> tombstone (authoritative, kept until the key's original expiry) and marks the key record.
// Takes effect everywhere within about a minute (KV propagation); nothing on the read path can overwrite it.
export async function handleRevokeKey(env, rawCode) {
  const code = normalizeCode(decodeURIComponent(rawCode || ''));
  const rec = await getKey(env, code);
  if (!rec) throw new HttpError(404, '没有找到这个密钥，它可能已经过期。');
  const t = now();
  await env.KV.put(revokedKeyName(code), JSON.stringify({ code, revokedAt: rec.revokedAt || t }), {
    expirationTtl: ttlUntil(rec.expiresAt, t),
    metadata: { revokedAt: rec.revokedAt || t },
  });
  if (!rec.revoked) {
    rec.revoked = true;
    rec.revokedAt = t;
  }
  // The key record itself only needs to live briefly; the tombstone keeps answering "revoked" after it is gone.
  await putKey(env, rec, 60);
  return json({ ok: true, code: formatCode(code) });
}
