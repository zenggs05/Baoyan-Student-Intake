// Shared DOM helpers (no framework).
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v; // only for trusted, pre-rendered content
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'checked' || k === 'disabled' || k === 'value') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function toast(msg, isError = false, ms = 6000) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: `toast${isError ? ' error' : ''}`, role: isError ? 'alert' : 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

export function fmtCountdown(ms) {
  if (ms <= 0) return '00:00';
  const s = Math.floor(ms / 1000), hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

export const isWeChat = () => /MicroMessenger/i.test(navigator.userAgent);

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallback());
  return Promise.resolve(fallback());
  function fallback() {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return ok;
  }
}

export const qs = (name) => new URLSearchParams(location.search).get(name);
