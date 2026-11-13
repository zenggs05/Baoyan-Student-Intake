// Shared API client. Throws Error(message) with the server's Chinese `error` text on failure.
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const ct = res.headers.get('Content-Type') || '';
  if (ct.includes('application/json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || `请求失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const getMe = () => api('/api/me').then((d) => d?.session || null).catch(() => null);
