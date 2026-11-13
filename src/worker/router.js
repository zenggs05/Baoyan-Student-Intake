// Request routing: /api/* handled here, everything else goes to static assets with security headers.
import { HttpError, errorResponse, checkOrigin } from './util.js';
import { resolveSession, requireAdmin } from './session.js';
import { handleCatalog, handleAdminProducts, handleDoc, handleDownload } from './content.js';
import { handleRedeem, handleCreateKey, handleListKeys, handleRevokeKey } from './keys.js';
import {
  handleLogin, handleListStudents, handleCreateStudent, handleResetStudent, handleSetDisabled, handleDeleteStudent,
} from './students.js';
import { handleAdminLogin, handleMe, handleLogout } from './auth.js';

function segments(pathname) {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    });
}

const notFound = () => new HttpError(404, '接口不存在，请刷新页面后重试。');
const badMethod = () => new HttpError(405, '不支持这种请求方式。');

async function routeApi(request, env, url) {
  checkOrigin(request, url);
  const m = request.method;
  const seg = segments(url.pathname).slice(1); // drop "api"
  const [a, b, c] = seg;

  switch (a) {
    case 'catalog': {
      if (seg.length !== 1) throw notFound();
      if (m !== 'GET') throw badMethod();
      const r = await resolveSession(request, env);
      return handleCatalog(env, r.session);
    }
    case 'me':
      if (seg.length !== 1) throw notFound();
      if (m !== 'GET') throw badMethod();
      return handleMe(request, env);
    case 'redeem':
      if (seg.length !== 1) throw notFound();
      if (m !== 'POST') throw badMethod();
      return handleRedeem(request, env);
    case 'login':
      if (seg.length !== 1) throw notFound();
      if (m !== 'POST') throw badMethod();
      return handleLogin(request, env);
    case 'logout':
      if (seg.length !== 1) throw notFound();
      if (m !== 'POST') throw badMethod();
      return handleLogout(request, env);
    case 'doc':
      if (seg.length !== 3) throw notFound();
      if (m !== 'GET') throw badMethod();
      return handleDoc(request, env, b, c);
    case 'download':
      if (seg.length !== 2) throw notFound();
      if (m !== 'GET') throw badMethod();
      return handleDownload(request, env, b);
    case 'admin':
      return routeAdmin(request, env, m, seg.slice(1));
    default:
      throw notFound();
  }
}

async function routeAdmin(request, env, m, seg) {
  const [a, b, c] = seg;
  if (a === 'login' && seg.length === 1) {
    if (m !== 'POST') throw badMethod();
    return handleAdminLogin(request, env);
  }
  // Everything below needs an admin session.
  await requireAdmin(request, env);
  if (a === 'products' && seg.length === 1) {
    if (m !== 'GET') throw badMethod();
    return handleAdminProducts(env);
  }
  if (a === 'keys') {
    if (seg.length === 1) {
      if (m === 'GET') return handleListKeys(env);
      if (m === 'POST') return handleCreateKey(request, env);
      throw badMethod();
    }
    if (seg.length === 3 && c === 'revoke') {
      if (m !== 'POST') throw badMethod();
      return handleRevokeKey(env, b);
    }
    throw notFound();
  }
  if (a === 'students') {
    if (seg.length === 1) {
      if (m === 'GET') return handleListStudents(env);
      if (m === 'POST') return handleCreateStudent(request, env);
      throw badMethod();
    }
    if (seg.length === 2) {
      if (m === 'DELETE') return handleDeleteStudent(env, b);
      throw badMethod();
    }
    if (seg.length === 3) {
      if (m !== 'POST') throw badMethod();
      if (c === 'reset') return handleResetStudent(env, b);
      if (c === 'disable') return handleSetDisabled(env, b, true);
      if (c === 'enable') return handleSetDisabled(env, b, false);
    }
    throw notFound();
  }
  throw notFound();
}

const ASSET_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

async function serveAsset(request, env) {
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') {
    return new Response('Not found', { status: 404, headers: ASSET_SECURITY_HEADERS });
  }
  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(ASSET_SECURITY_HEADERS)) out.headers.set(k, v);
  return out;
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    try {
      return await routeApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return errorResponse(err.status, err.message, err.extraHeaders);
      console.error('worker error', err && err.stack ? err.stack : err);
      return errorResponse(500, '服务器暂时出了点问题，请稍后再试。如果一直不行，请联系作者。');
    }
  }
  return serveAsset(request, env);
}
