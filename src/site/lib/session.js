// Reader-side session helpers built on GET /api/me (ARCHITECTURE §4.1).
import { api } from '../../shared/api.js';

let skew = 0; // server clock minus local clock (ms), estimated from the Date header
let notice = ''; // why a previously unlocked browser is locked again (GET /api/me `notice`)

/** Reason from the last loadSession() call when it returned no session (e.g. key revoked, account disabled). */
export const sessionNotice = () => notice;

export async function loadSession() {
  notice = '';
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' });
    const d = Date.parse(res.headers.get('Date') || '');
    if (!Number.isNaN(d)) {
      const s = d - Date.now();
      // Date has 1 s resolution; ignore tiny differences so the countdown never jumps backwards visibly
      skew = Math.abs(s) > 1500 ? s : 0;
    }
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    if (!j?.session && typeof j?.notice === 'string') notice = j.notice.trim();
    return j?.session || null;
  } catch {
    return null;
  }
}

export const serverNow = () => Date.now() + skew;

export function remaining(session) {
  if (!session) return 0;
  if (!session.expiresAt) return Infinity;
  return session.expiresAt - serverNow();
}

export const isActive = (s) => !!s && remaining(s) > 0;

export function hasProduct(session, id) {
  return isActive(session) && Array.isArray(session.products) && session.products.includes(id);
}

export const isKey = (s) => s?.type === 'key';
export const isStudent = (s) => s?.type === 'student';
export const canDownload = (s) => isKey(s) && s.canDownload !== false;

export async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* the cookie is cleared server-side; ignore */ }
}

export function fmtDay(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fmtDateTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Friendly Chinese message for auth/unlock errors, always telling the user what to do next. */
export function friendlyError(err, kind = 'key') {
  const st = err?.status;
  if (st === 429) return '尝试次数太多了，请等 1 分钟后再试。';
  if (!st) return '网络连接不稳定，请检查网络后重试。';
  const msg = String(err?.message || '').replace(/[。.!！\s]+$/, '');
  if (kind === 'key') {
    if (st === 404) return `${msg || '密钥无效或已过期'}。请核对是否完整复制（12 位字母和数字）；如果已超过有效期，请联系作者重新获取。`;
    if (st === 403) return `${msg || '该密钥已不可用'}。如有疑问，请联系作者重新获取密钥。`;
    if (st === 400) return `${msg || '密钥格式不正确'}。请粘贴作者发给你的完整密钥后重试。`;
  }
  if (kind === 'login') {
    if (st === 401 || st === 404) return `${msg || '用户名或密码不正确'}。请检查大小写后重试；忘记密码请联系作者重置。`;
    if (st === 403) return `${msg || '账号已停用或已到期'}。如需继续使用，请联系作者。`;
    if (st === 400) return msg || '请填写用户名和密码。';
  }
  return msg ? `${msg}。请稍后重试。` : '出了点问题，请稍后重试。';
}
