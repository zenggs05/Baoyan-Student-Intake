// Shared helpers for the Worker: responses, errors, cookies, crypto, time, request guards.

export class HttpError extends Error {
  constructor(status, message, extraHeaders) {
    super(message);
    this.status = status;
    this.extraHeaders = extraHeaders || null;
  }
}

const API_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex',
};

export function json(data, status = 200, extraHeaders) {
  const headers = new Headers(API_HEADERS);
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) appendHeader(headers, k, v);
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(status, message, extraHeaders) {
  return json({ error: message }, status, extraHeaders);
}

function appendHeader(headers, k, v) {
  if (Array.isArray(v)) for (const item of v) headers.append(k, item);
  else if (v !== undefined && v !== null) headers.set(k, v);
}

// ---------- time ----------
export const now = () => Date.now();
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

// Edge-cache time for KV reads on the auth path (key:, revoked:, user:). 30 s is the minimum KV accepts; the shorter
// it is, the sooner a revoke / disable / password reset made elsewhere is seen here (KV is eventually consistent).
export const AUTH_CACHE_TTL = 30;

// KV refuses expirationTtl < 60 seconds; always clamp.
export function ttlUntil(expMs, at = now()) {
  return Math.max(60, Math.ceil((expMs - at) / 1000));
}

// YYYY-MM-DD in China Standard Time (UTC+8, no DST).
export function cnDate(ms = now()) {
  return new Date(ms + 8 * HOUR).toISOString().slice(0, 10);
}

// ---------- encoding / crypto ----------
export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function base64url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

// Uniform random string over `alphabet` (rejection sampling, no modulo bias).
export function randomString(alphabet, length) {
  const n = alphabet.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < length) {
    const buf = randomBytes(length * 2);
    for (let i = 0; i < buf.length && out.length < length; i++) {
      if (buf[i] < limit) out += alphabet[buf[i] % n];
    }
  }
  return out;
}

// Constant-time comparison of two byte arrays (length is not secret here: callers compare fixed-size digests).
export function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function sha256(str) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
  return new Uint8Array(d);
}

// Compare two secrets in constant time by hashing both to fixed-length digests first.
export async function secretEquals(a, b) {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return timingSafeEqual(ha, hb);
}

// ---------- cookies ----------
export const COOKIE_NAME = 'bys';

export function readCookie(request, name = COOKIE_NAME) {
  const raw = request.headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionCookie(token, maxAgeSec) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

// ---------- request guards ----------
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// CSRF defence: state-changing requests must carry an Origin whose host equals the request host.
export function checkOrigin(request, url) {
  if (!MUTATING.has(request.method)) return;
  const origin = request.headers.get('Origin');
  let host = null;
  if (origin && origin !== 'null') {
    try { host = new URL(origin).host; } catch { host = null; }
  }
  if (!host || host !== url.host) {
    throw new HttpError(403, '请求来源校验未通过。请直接在本站页面里操作，或刷新页面后重试。');
  }
}

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// Workers Rate Limiting binding (RL_AUTH). Skipped silently when the binding is missing or fails.
// `cost` lets one binding (limit 10/min) express a stricter budget, e.g. cost 2 => 5 attempts/min.
export async function rateLimit(env, key, cost = 1) {
  const rl = env && env.RL_AUTH;
  if (!rl || typeof rl.limit !== 'function') return;
  for (let i = 0; i < cost; i++) {
    let res;
    try { res = await rl.limit({ key }); } catch { return; }
    if (res && res.success === false) {
      throw new HttpError(429, '尝试次数太多了，请等 1 分钟后再试。', { 'Retry-After': '60' });
    }
  }
}

const MAX_BODY = 16 * 1024;

export async function readJson(request) {
  const len = Number(request.headers.get('Content-Length') || 0);
  if (len > MAX_BODY) throw new HttpError(400, '提交的内容过大，请检查后重试。');
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(400, '提交的内容过大，请检查后重试。');
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new HttpError(400, '提交的数据格式不正确，请刷新页面后重试。');
  }
}

export const SAFE_ID = /^[A-Za-z0-9_.-]{1,100}$/;

// "ABCDEFGHJKMN" -> "ABCD-EFGH-JKMN"
export function formatCode(code) {
  const c = String(code || '');
  return c.length === 12 ? `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}` : c;
}
