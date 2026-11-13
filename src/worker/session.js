// Sessions: `sess:<token>` in KV, referenced by the `bys` cookie.
// Every read re-validates the backing key / student record so revocation, disabling and expiry apply on the next
// request (KV is eventually consistent: a change made elsewhere can take up to about a minute to be seen here).
//
// Read paths never write auth state back: revocation lives in a separate `revoked:<CODE>` tombstone that only the
// admin endpoint writes, and student login does not rewrite `user:<u>`. So a stale read on some edge can delay a
// revoke / disable / reset by up to ~1 minute, but can never undo it.
import {
  HttpError, now, ttlUntil, randomBytes, base64url, readCookie, sessionCookie, clearCookie, formatCode, AUTH_CACHE_TTL,
} from './util.js';
import { loadManifest, expandProducts } from './content.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newToken() {
  return base64url(randomBytes(32));
}

/**
 * Create a session record and return the Set-Cookie value.
 * data: {type, sub, products, label?, displayName?}  (key sessions carry no label: the buyer note stays on key:<CODE>)
 */
export async function createSession(env, data, exp) {
  const t = now();
  const token = newToken();
  const record = { ...data, iat: t, exp };
  await env.KV.put(`sess:${token}`, JSON.stringify(record), { expirationTtl: ttlUntil(exp, t) });
  return { token, record, cookie: sessionCookie(token, (exp - t) / 1000) };
}

export async function destroySession(env, token) {
  if (token && TOKEN_RE.test(token)) {
    try { await env.KV.delete(`sess:${token}`); } catch { /* ignore */ }
  }
}

export function sessionToken(request) {
  const tok = readCookie(request);
  return tok && TOKEN_RE.test(tok) ? tok : null;
}

async function loadRawSession(env, token) {
  if (!token) return null;
  let rec = null;
  try { rec = await env.KV.get(`sess:${token}`, 'json'); } catch { rec = null; }
  if (!rec || typeof rec !== 'object') return null;
  return rec;
}

/** KV key of the revocation tombstone for a key CODE (12 chars, no dashes). */
export const revokedKeyName = (code) => `revoked:${code}`;

/** Read a KV JSON value with the short auth cache time; read errors count as "not found". */
export async function readAuthJson(env, name) {
  try { return await env.KV.get(name, { type: 'json', cacheTtl: AUTH_CACHE_TTL }); } catch { return null; }
}

/**
 * Has this key been revoked? Read errors propagate (-> 500) instead of being treated as "not revoked".
 * The tombstone is written only by POST /api/admin/keys/:code/revoke and lives until the key's original expiry.
 */
export async function isKeyRevoked(env, code) {
  if (!code) return false;
  return (await env.KV.get(revokedKeyName(code), { cacheTtl: AUTH_CACHE_TTL })) !== null;
}

export function formatSessionCode(session) {
  return session && session.type === 'key' ? formatCode(session.sub) : '';
}

const MSG_NEED_LOGIN = '请先输入密钥，或用陪跑学员账号登录后再阅读。';
const MSG_SESSION_EXPIRED = '解锁状态已过期，资料已重新锁定。请重新输入密钥或登录。';
const MSG_KEY_EXPIRED = '密钥已过期，资料已重新锁定。如需继续阅读，请联系作者获取新的密钥。';
const MSG_KEY_REVOKED = '该密钥已被撤销，资料已重新锁定。如有疑问，请联系作者。';
const MSG_USER_GONE = '账号不存在或已被删除，请联系作者确认。';
const MSG_USER_DISABLED = '账号已停用，请联系作者。';
const MSG_USER_EXPIRED = '账号已到期，请联系作者续期。';
const MSG_PW_RESET = '密码已被重置，请用新密码重新登录。';

/**
 * Resolve the request's session against KV.
 * Returns {session, manifest, token} on success, or {session:null, status, message, clear} on failure.
 * `clear` means the session is gone for good: the KV record was deleted and the cookie should be cleared.
 */
export async function resolveSession(request, env) {
  const token = sessionToken(request);
  const hadCookie = Boolean(readCookie(request));
  if (!token) return { session: null, status: 401, message: MSG_NEED_LOGIN, clear: hadCookie };
  const raw = await loadRawSession(env, token);
  const t = now();
  const fail = async (status, message, permanent) => {
    if (permanent) await destroySession(env, token);
    return { session: null, status, message, clear: permanent, token };
  };
  if (!raw) return fail(401, MSG_SESSION_EXPIRED, true);
  if (!(raw.exp > t)) return fail(401, MSG_SESSION_EXPIRED, true);

  const manifest = await loadManifest(env);

  if (raw.type === 'key') {
    const [key, revoked] = await Promise.all([readAuthJson(env, `key:${raw.sub}`), isKeyRevoked(env, raw.sub)]);
    // Revoked keys answer 403 until the key's original expiry (the tombstone's TTL), then 401 like any expired key.
    if (revoked) return fail(403, MSG_KEY_REVOKED, false);
    if (!key || !(key.expiresAt > t)) return fail(401, MSG_KEY_EXPIRED, true);
    if (key.revoked) return fail(403, MSG_KEY_REVOKED, false);
    const exp = Math.min(raw.exp, key.expiresAt);
    // key.label is the author's private buyer note: it never goes into the session or back to the buyer.
    return {
      token,
      manifest,
      session: {
        type: 'key',
        sub: raw.sub,
        code: formatCode(raw.sub),
        displayName: '',
        products: expandProducts(manifest, key.products),
        expiresAt: exp,
        canDownload: true,
      },
    };
  }

  if (raw.type === 'student') {
    const user = await readAuthJson(env, `user:${raw.sub}`);
    if (!user) return fail(401, MSG_USER_GONE, true);
    // `pwv` = the account's pwSetAt when this session logged in. Comparing against it (rather than only the login
    // time) also kills a session that logged in with the old password on an edge that had not yet seen a reset.
    // Older sessions without `pwv` fall back to the login time.
    const pwVersion = raw.pwv ?? raw.iat;
    if (user.pwSetAt && pwVersion && user.pwSetAt > pwVersion) return fail(401, MSG_PW_RESET, true);
    if (user.disabled) return fail(403, MSG_USER_DISABLED, false);
    if (!(user.expiresAt > t)) return fail(403, MSG_USER_EXPIRED, false);
    return {
      token,
      manifest,
      session: {
        type: 'student',
        sub: raw.sub,
        username: raw.sub,
        label: user.displayName || raw.sub,
        displayName: user.displayName || raw.sub,
        products: expandProducts(manifest, user.products, { student: true }),
        expiresAt: Math.min(raw.exp, user.expiresAt),
        accountExpiresAt: user.expiresAt,
        canDownload: false,
      },
    };
  }

  if (raw.type === 'admin') {
    return {
      token,
      manifest,
      session: {
        type: 'admin',
        sub: 'admin',
        label: '管理员',
        displayName: '管理员',
        products: expandProducts(manifest, [], { admin: true }),
        expiresAt: raw.exp,
        canDownload: false,
      },
    };
  }

  return fail(401, MSG_SESSION_EXPIRED, true);
}

// Shape returned to the browser (/api/me, /api/redeem, /api/login).
// Key sessions identify themselves by `code` only; their `label` is always '' (the buyer note stays admin-only).
export function publicSession(s) {
  if (!s) return null;
  const out = {
    type: s.type,
    label: s.type === 'key' ? '' : s.label || '',
    displayName: s.displayName || '',
    products: s.products || [],
    expiresAt: s.expiresAt,
    canDownload: Boolean(s.canDownload),
  };
  if (s.type === 'key') out.code = s.code;
  if (s.type === 'student') {
    out.username = s.username;
    out.accountExpiresAt = s.accountExpiresAt;
  }
  return out;
}

// For /api/doc and /api/download: throws 401/403 when there is no usable reading session.
export async function requireReader(request, env) {
  const r = await resolveSession(request, env);
  if (!r.session) {
    throw new HttpError(r.status, r.message, r.clear ? { 'Set-Cookie': clearCookie() } : null);
  }
  return r;
}

export async function requireAdmin(request, env) {
  const token = sessionToken(request);
  const raw = await loadRawSession(env, token);
  if (!raw || raw.type !== 'admin' || !(raw.exp > now())) {
    throw new HttpError(401, '请先登录管理后台。如果刚才已登录，可能是登录已超时，请重新登录。');
  }
  return raw;
}
