// Admin login, /api/me and /api/logout.
import { HttpError, json, now, HOUR, readJson, rateLimit, clientIp, secretEquals, clearCookie } from './util.js';
import { createSession, destroySession, resolveSession, publicSession, sessionToken } from './session.js';

const ADMIN_SESSION = 12 * HOUR;

// POST /api/admin/login {password}. Limit: 5 attempts / minute / IP (each attempt costs 2 of RL_AUTH's 10).
export async function handleAdminLogin(request, env) {
  await rateLimit(env, `admin:${clientIp(request)}`, 2);
  const body = await readJson(request);
  const password = typeof body.password === 'string' ? body.password : '';
  const expected = typeof env.ADMIN_PASSWORD === 'string' ? env.ADMIN_PASSWORD : '';
  if (!expected) throw new HttpError(403, '后台还没有设置管理员密码。请先在服务器上配置 ADMIN_PASSWORD 后再登录。');
  if (!password) throw new HttpError(400, '请输入管理员密码。');
  const ok = await secretEquals(password, expected);
  if (!ok) throw new HttpError(401, '密码不正确，请重新输入。');

  const old = sessionToken(request);
  if (old) await destroySession(env, old);
  const exp = now() + ADMIN_SESSION;
  const { cookie } = await createSession(env, { type: 'admin', sub: 'admin', products: [], label: '管理员' }, exp);
  return json(
    { session: { type: 'admin', label: '管理员', displayName: '管理员', products: [], expiresAt: exp, canDownload: false } },
    200,
    { 'Set-Cookie': cookie },
  );
}

// GET /api/me
export async function handleMe(request, env) {
  const r = await resolveSession(request, env);
  if (r.session) return json({ session: publicSession(r.session) });
  const out = { session: null };
  // Explain why a previously unlocked browser is locked again (revoked key, disabled account, ...).
  if (r.token) out.notice = r.message;
  return json(out, 200, r.clear ? { 'Set-Cookie': clearCookie() } : null);
}

// POST /api/logout
export async function handleLogout(request, env) {
  const token = sessionToken(request);
  if (token) await destroySession(env, token);
  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie() });
}
