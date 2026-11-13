// Student (陪跑学员) accounts: password hashing, login and admin management.
import {
  HttpError, json, now, DAY, HOUR, readJson, rateLimit, clientIp, randomBytes, randomString,
  bytesToBase64, base64ToBytes, timingSafeEqual,
} from './util.js';
import { createSession, destroySession, sessionToken, publicSession, readAuthJson } from './session.js';
import { loadManifest, findProduct, expandProducts } from './content.js';

export const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
// No look-alikes: drops 0/o, 1/l/i. Lowercase only so it is easy to type on a phone.
export const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const PASSWORD_LENGTH = 10;
export const PBKDF2_ITER = 10000;
const SESSION_MAX = 7 * DAY;

export function generatePassword() {
  return randomString(PASSWORD_ALPHABET, PASSWORD_LENGTH);
}

async function pbkdf2(password, saltBytes, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iter }, key, 256);
  return new Uint8Array(bits);
}

// Returns {pwHash, salt, iter} (base64 strings).
export async function hashPassword(password, { iter = PBKDF2_ITER, salt } = {}) {
  const saltBytes = salt ? base64ToBytes(salt) : randomBytes(16);
  const hash = await pbkdf2(password, saltBytes, iter);
  return { pwHash: bytesToBase64(hash), salt: bytesToBase64(saltBytes), iter };
}

export async function verifyPassword(password, { pwHash, salt, iter }) {
  if (typeof password !== 'string' || !pwHash || !salt) return false;
  let expected;
  let saltBytes;
  try {
    expected = base64ToBytes(pwHash);
    saltBytes = base64ToBytes(salt);
  } catch {
    return false;
  }
  const n = Number(iter) || PBKDF2_ITER;
  const actual = await pbkdf2(password, saltBytes, n);
  return timingSafeEqual(actual, expected);
}

// Fixed dummy record used to keep login timing similar for unknown usernames.
const DUMMY = { pwHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', salt: 'AAAAAAAAAAAAAAAAAAAAAA==', iter: PBKDF2_ITER };

export function normalizeUsername(u) {
  return typeof u === 'string' ? u.trim().toLowerCase() : '';
}

function userMetadata(u) {
  const meta = {
    displayName: u.displayName,
    expiresAt: u.expiresAt,
    disabled: Boolean(u.disabled),
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    products: u.products,
  };
  // KV metadata is capped at 1024 bytes; drop the product list if it is too long (list falls back to a read).
  if (JSON.stringify(meta).length > 900) delete meta.products;
  return meta;
}

async function getUser(env, username) {
  if (!USERNAME_RE.test(username)) return null;
  return readAuthJson(env, `user:${username}`);
}

// user:<u> is written only by the admin endpoints below. Login must never write it back: a login served from a
// stale edge copy would otherwise restore an old password hash / pwSetAt / disabled:false (KV is eventually
// consistent), silently undoing a reset or a disable.
async function putUser(env, u) {
  await env.KV.put(`user:${u.username}`, JSON.stringify(u), { metadata: userMetadata(u) });
}

// Last login time lives in its own key so that recording it never touches user:<u>.
const seenKey = (username) => `seen:${username}`;
async function markSeen(env, username, t) {
  try { await env.KV.put(seenKey(username), String(t), { metadata: { lastLoginAt: t } }); } catch { /* best effort */ }
}

function publicUser(u) {
  return {
    username: u.username,
    displayName: u.displayName,
    products: u.products,
    expiresAt: u.expiresAt,
    disabled: Boolean(u.disabled),
    createdAt: u.createdAt ?? null,
    lastLoginAt: u.lastLoginAt ?? null,
  };
}

// POST /api/login {username, password}
export async function handleLogin(request, env) {
  await rateLimit(env, `login:${clientIp(request)}`);
  const body = await readJson(request);
  const username = normalizeUsername(body.username);
  const password = typeof body.password === 'string' ? body.password.trim() : '';
  if (!username || !password) throw new HttpError(400, '请输入用户名和密码');
  const user = await getUser(env, username);
  const ok = await verifyPassword(password, user || DUMMY);
  if (!user || !ok) throw new HttpError(401, '用户名或密码不正确');
  const t = now();
  if (user.disabled) throw new HttpError(403, '账号已停用');
  if (!(user.expiresAt > t)) throw new HttpError(403, '账号已到期');

  await markSeen(env, username, t);

  const old = sessionToken(request);
  if (old) await destroySession(env, old);
  const exp = Math.min(t + SESSION_MAX, user.expiresAt);
  // pwv: which password this session was opened with (see resolveSession).
  const { cookie } = await createSession(
    env,
    { type: 'student', sub: username, products: user.products, displayName: user.displayName, pwv: user.pwSetAt ?? null },
    exp,
  );
  const manifest = await loadManifest(env);
  const session = {
    type: 'student',
    sub: username,
    username,
    label: user.displayName,
    displayName: user.displayName,
    products: expandProducts(manifest, user.products, { student: true }),
    expiresAt: exp,
    accountExpiresAt: user.expiresAt,
    canDownload: false,
  };
  return json({ session: publicSession(session) }, 200, { 'Set-Cookie': cookie });
}

// ---------- admin ----------

// Accepts ms timestamp, "YYYY-MM-DD" (end of that day, China time) or any Date-parsable string.
export function parseExpiresAt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim();
    if (/^\d+$/.test(s)) return Number(s);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999) - 8 * HOUR;
    const d = Date.parse(s);
    if (Number.isFinite(d)) return d;
  }
  return NaN;
}

function defaultExpiry() {
  const t = now();
  const year = new Date(t + 8 * HOUR).getUTCFullYear();
  let exp = parseExpiresAt(`${year}-10-31`);
  if (exp <= t) exp = parseExpiresAt(`${year + 1}-10-31`);
  return exp;
}

function parseProducts(input, manifest) {
  if (input === undefined || input === null || input === '' || input === 'all') return 'all';
  const list = Array.isArray(input) ? input : [input];
  const ids = [...new Set(list.map((x) => String(x).trim()).filter(Boolean))];
  if (ids.includes('all')) return 'all';
  if (!ids.length) throw new HttpError(400, '请至少选择一个产品，或选择「全部资料」。');
  for (const id of ids) {
    if (manifest.products.length && !findProduct(manifest, id)) {
      throw new HttpError(400, `找不到产品「${id}」，请刷新页面后重试。`);
    }
  }
  return ids;
}

// GET /api/admin/students
export async function handleListStudents(env) {
  const students = [];
  const seen = new Map();
  let cursor;
  do {
    const page = await env.KV.list({ prefix: 'seen:', cursor });
    for (const k of page.keys) seen.set(k.name.slice(5), Number(k.metadata?.lastLoginAt) || null);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  // Older records carry lastLoginAt inside user:<u>; newer logins only update seen:<u>. Show the later one.
  const lastLogin = (username, fromUser) => Math.max(Number(fromUser) || 0, seen.get(username) || 0) || null;
  cursor = undefined;
  do {
    const page = await env.KV.list({ prefix: 'user:', cursor });
    for (const k of page.keys) {
      const username = k.name.slice(5);
      const m = k.metadata || {};
      if (m.products === undefined) {
        const u = await getUser(env, username);
        if (u) students.push({ ...publicUser(u), lastLoginAt: lastLogin(username, u.lastLoginAt) });
        continue;
      }
      students.push({
        username,
        displayName: m.displayName || username,
        products: m.products,
        expiresAt: m.expiresAt ?? null,
        disabled: Boolean(m.disabled),
        createdAt: m.createdAt ?? null,
        lastLoginAt: lastLogin(username, m.lastLoginAt),
      });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  students.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return json({ students });
}

// POST /api/admin/students {username, displayName, expiresAt, products}
export async function handleCreateStudent(request, env) {
  const body = await readJson(request);
  const username = normalizeUsername(body.username);
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, '用户名需为 3–32 位小写字母、数字或下划线，例如 zhang_san。');
  }
  const displayName = (typeof body.displayName === 'string' ? body.displayName.trim() : '').slice(0, 40) || username;
  const t = now();
  const expiresAt = body.expiresAt === undefined || body.expiresAt === '' ? defaultExpiry() : parseExpiresAt(body.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new HttpError(400, '到期日格式不正确，请重新选择日期。');
  if (expiresAt <= t) throw new HttpError(400, '到期日需要晚于今天，请重新选择。');
  const manifest = await loadManifest(env);
  const products = parseProducts(body.products, manifest);
  if (await getUser(env, username)) throw new HttpError(400, '这个用户名已经被使用了，请换一个。');

  const password = generatePassword();
  const hashed = await hashPassword(password);
  const user = {
    username,
    displayName,
    ...hashed,
    products,
    expiresAt,
    disabled: false,
    createdAt: t,
    lastLoginAt: null,
    pwSetAt: t,
  };
  await putUser(env, user);
  // A deleted account with the same name may have left its last-login time behind.
  try { await env.KV.delete(seenKey(username)); } catch { /* ignore */ }
  return json({ username, password, displayName, expiresAt, products });
}

async function mustGetUser(env, raw) {
  const username = normalizeUsername(decodeURIComponent(raw || ''));
  const u = await getUser(env, username);
  if (!u) throw new HttpError(404, '没有找到这个学员账号，请刷新列表后重试。');
  return u;
}

// POST /api/admin/students/:u/reset
export async function handleResetStudent(env, raw) {
  const u = await mustGetUser(env, raw);
  const password = generatePassword();
  Object.assign(u, await hashPassword(password), { pwSetAt: now() });
  await putUser(env, u);
  return json({ password, username: u.username });
}

// POST /api/admin/students/:u/disable | /enable
export async function handleSetDisabled(env, raw, disabled) {
  const u = await mustGetUser(env, raw);
  u.disabled = Boolean(disabled);
  await putUser(env, u);
  return json({ ok: true });
}

// DELETE /api/admin/students/:u
export async function handleDeleteStudent(env, raw) {
  const u = await mustGetUser(env, raw);
  await env.KV.delete(`user:${u.username}`);
  try { await env.KV.delete(seenKey(u.username)); } catch { /* ignore */ }
  return json({ ok: true });
}
