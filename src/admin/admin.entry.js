// /admin/ — author dashboard: quick key issuing, active keys, student accounts (ARCHITECTURE §4.2, §6).
import { h, toast, fmtCountdown, copyText } from '../shared/ui.js';
import { api } from '../shared/api.js';
import { icon } from '../site/lib/icons.js';
import { fmtDateTime, fmtDay, logout } from '../site/lib/session.js';
import { isP3, shortTitle, fmtPrice } from '../site/lib/catalog.js';
import { put } from '../site/lib/dom.js';

const app = document.getElementById('app');
const A = {
  products: [], keys: [], students: [], issued: [], revoked: new Set(), selected: new Set(),
  tab: 'issue', minutes: 30, maxUses: 3, label: '', loadedStudents: false,
};
const els = {};
const BRAND_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14 20h14l4 5 4-5h14v29H36l-4 4-4-4H14z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>';
const USER_RE = /^[a-z0-9_]{3,32}$/;
const MINUTE_OPTS = [[10, '10 分钟'], [30, '30 分钟'], [60, '1 小时'], [120, '2 小时'], [1440, '24 小时'], [1, '1 分钟（测试用）']];
const USE_OPTS = [1, 2, 3, 5, 10];

/* ---------------- helpers ---------------- */
const listOf = (d, key) => (Array.isArray(d) ? d : Array.isArray(d?.[key]) ? d[key] : []);
const fmtCode = (c) => {
  const raw = String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  return raw.length === 12 ? raw.replace(/(.{4})(?=.)/g, '$1-') : String(c || '');
};
const productTitle = (id) => {
  const p = A.products.find((x) => x.id === id);
  if (!p) return id;
  return isP3(id) ? `单校复盘·${shortTitle(p)}` : p.title;
};
const remainingText = (ts) => {
  const ms = ts - Date.now();
  if (ms <= 0) return '已过期';
  if (ms > 24 * 3600e3) return `${Math.floor(ms / 86400e3)} 天`;
  return fmtCountdown(ms);
};
function defaultExpiry() {
  const now = new Date();
  let y = now.getFullYear();
  if (now > new Date(y, 9, 31, 23, 59, 59)) y += 1; // past Oct 31 -> next season
  return `${y}-10-31`;
}
function normKey(k) {
  const m = k?.metadata || {};
  const code = k?.code || String(k?.name || '').replace(/^key:/, '');
  return {
    code,
    products: k?.products || m.products || [],
    label: k?.label ?? m.label ?? '',
    expiresAt: Number(k?.expiresAt ?? m.expiresAt ?? 0),
    uses: Number(k?.uses ?? m.uses ?? 0),
    maxUses: Number(k?.maxUses ?? m.maxUses ?? 0),
    revoked: !!(k?.revoked ?? m.revoked) || A.revoked.has(code),
  };
}
function normStudent(u) {
  const m = u?.metadata || {};
  return {
    username: u?.username || String(u?.name || '').replace(/^user:/, ''),
    displayName: u?.displayName ?? m.displayName ?? '',
    expiresAt: Number(u?.expiresAt ?? m.expiresAt ?? 0),
    disabled: !!(u?.disabled ?? m.disabled),
    products: u?.products ?? 'all',
    createdAt: u?.createdAt,
    lastLoginAt: u?.lastLoginAt,
  };
}
async function call(path, opts) {
  try {
    return await api(path, opts);
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      showLogin('登录已过期或没有权限，请重新输入后台密码。');
      e.handled = true;
    }
    throw e;
  }
}
const errMsg = (e, what) => (e?.status ? `${what}失败：${e.message}` : `${what}失败：网络连接不稳定，请检查网络后重试。`);
function busy(btn, on, text) {
  if (!btn) return;
  if (on) { btn.dataset.html = btn.innerHTML; btn.disabled = true; if (text) btn.textContent = text; }
  else { btn.disabled = false; if (btn.dataset.html) btn.innerHTML = btn.dataset.html; }
}
async function copy(btn, text, okMsg) {
  const ok = await copyText(text);
  toast(ok ? okMsg : '复制没有成功，请长按文字手动复制。', !ok);
  // Inline feedback too: toasts sit underneath an open dialog's backdrop
  if (btn && ok && !btn.dataset.flash) {
    btn.dataset.flash = btn.innerHTML;
    btn.classList.add('copied');
    btn.replaceChildren(icon('check', 16), btn.classList.contains('icon-btn') ? '' : '已复制');
    setTimeout(() => { btn.innerHTML = btn.dataset.flash; delete btn.dataset.flash; btn.classList.remove('copied'); }, 1800);
  }
}

/* ---------------- boot ---------------- */
async function init() {
  try {
    const d = await api('/api/admin/products');
    A.products = listOf(d, 'products');
    showMain();
  } catch (e) {
    if (e.status === 401 || e.status === 403) showLogin();
    else showFatal();
  }
}

function showFatal() {
  put(app, h('div', { class: 'adm-login' }, h('section', { class: 'card adm-login-card' },
    h('h1', {}, '后台暂时没有加载出来'),
    h('p', { class: 'muted' }, '可能是网络不稳定或服务暂时不可用，请稍后刷新重试。'),
    h('button', { class: 'btn primary block', type: 'button', onClick: () => location.reload() }, icon('refresh', 16), '刷新'))));
}

function showLogin(message) {
  clearInterval(els.timer);
  document.querySelector('dialog[open]')?.close();
  const pw = h('input', { class: 'input', type: 'password', id: 'adm-pw', autocomplete: 'current-password', placeholder: '后台密码' });
  const err = h('p', { class: 'form-error', role: 'alert' }, message || '');
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, '登录');
  const form = h('form', { class: 'auth-form', novalidate: true },
    h('label', { class: 'field-label', for: 'adm-pw' }, '后台密码'), pw, err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pw.value) { err.textContent = '请输入后台密码。'; pw.focus(); return; }
    busy(btn, true, '登录中…');
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: pw.value } });
      const d = await api('/api/admin/products');
      A.products = listOf(d, 'products');
      A.loadedStudents = false;
      showMain();
      toast('已登录管理后台');
    } catch (ex) {
      err.textContent = ex.status === 429 ? '尝试次数太多了，请等 1 分钟后再试。'
        : ex.status === 401 || ex.status === 403 ? '密码不正确，请重新输入。'
          : ex.status ? `${ex.message}，请稍后重试。` : '网络连接不稳定，请检查网络后重试。';
      pw.select();
    } finally { busy(btn, false); }
  });
  put(app, h('div', { class: 'adm-login' },
    h('section', { class: 'card adm-login-card' },
      h('span', { class: 'adm-login-icon' }, icon('shield', 26)),
      h('h1', {}, '管理后台'),
      h('p', { class: 'muted' }, '仅限作者使用。登录后可以发放阅读密钥、管理学员账号。'),
      form),
    h('a', { class: 'adm-back', href: '/' }, '‹ 返回网站首页')));
  queueMicrotask(() => pw.focus());
}

/* ---------------- main layout ---------------- */
function showMain() {
  const out = h('button', { class: 'btn small adm-ghost', type: 'button' }, icon('logout', 16), '退出');
  out.addEventListener('click', async () => { await logout(); toast('已退出管理后台'); showLogin(); });
  const top = h('header', { class: 'adm-top' }, h('div', { class: 'adm-wrap adm-top-in' },
    h('a', { class: 'brand', href: '/admin/' }, h('span', { class: 'brand-icon', html: BRAND_SVG }),
      h('span', { class: 'brand-text' }, h('strong', {}, '管理后台'), h('small', {}, '保研全程陪跑'))),
    h('div', { class: 'adm-top-actions' },
      h('a', { class: 'btn small adm-ghost', href: '/library/', target: '_blank', rel: 'noopener' }, '查看资料库'), out)));

  els.tabs = {};
  const bar = h('div', { class: 'seg adm-tabs', role: 'tablist' });
  for (const [k, label, ic] of [['issue', '快速发码', 'key'], ['keys', '有效密钥', 'clock'], ['students', '学员账号', 'user']]) {
    const count = h('span', { class: 'tab-count' });
    const b = h('button', { class: 'seg-btn', type: 'button', role: 'tab', 'aria-selected': 'false' }, icon(ic, 16), label, count);
    b.addEventListener('click', () => selectTab(k));
    els.tabs[k] = { b, count };
    bar.append(b);
  }
  els.panels = { issue: issuePanel(), keys: keysPanel(), students: studentsPanel() };
  put(app, top, h('main', { class: 'adm-wrap adm-main', id: 'main' }, bar, ...Object.values(els.panels)));
  selectTab(A.tab);
  refreshKeys();
  clearInterval(els.timer);
  els.timer = setInterval(tick, 1000);
}

function selectTab(k) {
  A.tab = k;
  for (const [key, { b }] of Object.entries(els.tabs)) b.setAttribute('aria-selected', String(key === k));
  for (const [key, p] of Object.entries(els.panels)) p.hidden = key !== k;
  if (k === 'keys') refreshKeys();
  if (k === 'students' && !A.loadedStudents) refreshStudents();
}

function tick() {
  for (const el of document.querySelectorAll('[data-exp]')) {
    const ts = Number(el.dataset.exp);
    el.textContent = remainingText(ts);
    el.classList.toggle('expired', ts <= Date.now());
    el.classList.toggle('warn', ts > Date.now() && ts - Date.now() < 5 * 60e3);
  }
}

/* ---------------- quick issue ---------------- */
function issuePanel() {
  const label = h('input', { class: 'input', id: 'iss-label', maxlength: '40', placeholder: '买家昵称或订单号（选填）', value: A.label, 'aria-describedby': 'iss-label-hint' });
  label.addEventListener('input', () => { A.label = label.value; });
  const minutes = h('select', { class: 'input', id: 'iss-min' }, MINUTE_OPTS.map(([v, t]) => h('option', { value: String(v) }, t)));
  minutes.value = String(A.minutes);
  minutes.addEventListener('change', () => { A.minutes = Number(minutes.value); });
  const uses = h('select', { class: 'input', id: 'iss-uses' }, USE_OPTS.map((v) => h('option', { value: String(v) }, `${v} 次`)));
  uses.value = String(A.maxUses);
  uses.addEventListener('change', () => { A.maxUses = Number(uses.value); });

  const sellable = A.products.filter((p) => p.forSale !== false && !p.studentOnly && p.id !== 'KIT');
  const main = sellable.filter((p) => !isP3(p.id));
  const p3 = sellable.filter((p) => isP3(p.id));
  els.comboBar = h('div', { class: 'combo-bar', hidden: true });

  const form = h('section', { class: 'card adm-card issue-form', 'aria-labelledby': 'iss-title' },
    h('div', { class: 'panel-head' }, h('div', {},
      h('h2', { id: 'iss-title' }, '快速发码'),
      h('p', { class: 'muted small' }, '点产品上的「发码」立即生成；勾选多个产品可以合发一个密钥。'))),
    h('div', { class: 'opts' },
      h('div', { class: 'opt wide' }, h('label', { class: 'field-label', for: 'iss-label' }, '买家备注'), label,
        h('p', { class: 'hint tight', id: 'iss-label-hint' }, '仅自己可见，买家看不到，水印中也不显示。')),
      h('div', { class: 'opt' }, h('label', { class: 'field-label', for: 'iss-min' }, '有效期'), minutes),
      h('div', { class: 'opt' }, h('label', { class: 'field-label', for: 'iss-uses' }, '可兑换次数'), uses)),
    sellable.length ? null : h('div', { class: 'empty' }, h('strong', {}, '还没有可发码的产品'), '请先上传资料内容，再刷新本页。'),
    main.length ? h('div', { class: 'ptiles' }, main.map(tile)) : null,
    p3.length ? h('h3', { class: 'tiles-sub' }, `单校面经复盘（${p3.length}）`) : null,
    p3.length ? h('div', { class: 'ptiles compact' }, p3.map(tile)) : null,
    els.comboBar);
  els.result = h('section', { class: 'issue-result', 'aria-live': 'polite' });
  renderResult();
  renderCombo();
  return h('div', { class: 'tab-panel issue-grid', role: 'tabpanel' }, form, els.result);
}

function tile(p) {
  const cb = h('input', { type: 'checkbox', 'aria-label': `选择 ${p.title}` });
  cb.checked = A.selected.has(p.id);
  const t = h('div', { class: `ptile${cb.checked ? ' sel' : ''}`, 'data-id': p.id });
  cb.addEventListener('change', () => {
    if (cb.checked) A.selected.add(p.id); else A.selected.delete(p.id);
    t.classList.toggle('sel', cb.checked);
    renderCombo();
  });
  const btn = h('button', { class: 'btn small blue', type: 'button' }, '发码');
  btn.addEventListener('click', () => issue([p.id], btn));
  t.append(
    h('label', { class: 'ptile-pick' }, cb, h('span', { class: 'ptile-text' },
      h('b', {}, isP3(p.id) ? shortTitle(p) : p.title),
      h('small', {}, [fmtPrice(p.price), (p.docCount ?? p.docs?.length) ? `${p.docCount ?? p.docs.length} 篇` : null].filter(Boolean).join(' · ')))),
    btn);
  return t;
}

function renderCombo() {
  const ids = [...A.selected];
  els.comboBar.hidden = ids.length === 0;
  if (!ids.length) return;
  const go = h('button', { class: 'btn primary', type: 'button' }, icon('key', 16), `合发一个密钥（${ids.length} 个产品）`);
  go.addEventListener('click', () => issue(ids, go));
  const clear = h('button', { class: 'btn ghost small', type: 'button' }, '清空');
  clear.addEventListener('click', () => {
    A.selected.clear();
    for (const t of document.querySelectorAll('.ptile.sel')) { t.classList.remove('sel'); t.querySelector('input').checked = false; }
    renderCombo();
  });
  put(els.comboBar, 
    h('div', { class: 'combo-names' }, h('strong', {}, `已选 ${ids.length} 个：`), ids.map(productTitle).join('、')),
    h('div', { class: 'combo-acts' }, clear, go));
}

async function issue(ids, btn) {
  busy(btn, true, '生成中…');
  try {
    const body = { products: ids, minutes: A.minutes, maxUses: A.maxUses };
    if (A.label.trim()) body.label = A.label.trim();
    const r = await call('/api/admin/keys', { method: 'POST', body });
    A.issued.unshift({ ...r, products: r?.products || ids, label: r?.label ?? body.label ?? '', maxUses: A.maxUses, minutes: A.minutes, uses: 0 });
    if (ids.length > 1) { A.selected.clear(); for (const t of document.querySelectorAll('.ptile.sel')) { t.classList.remove('sel'); t.querySelector('input').checked = false; } renderCombo(); }
    renderResult();
    toast(`密钥已生成：${fmtCode(r.code)}`);
    if (matchMedia('(max-width: 980px)').matches) els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
    refreshKeys();
  } catch (e) {
    if (!e.handled) toast(errMsg(e, '生成密钥'), true, 8000);
  } finally { busy(btn, false); }
}

function sendScript(k) {
  const names = k.products.map((id) => `《${productTitle(id).replace(/^单校复盘·/, '单校面经复盘·')}》`).join('');
  const until = fmtDateTime(k.expiresAt);
  const validity = k.minutes ? `${k.minutes >= 60 && k.minutes % 60 === 0 ? `${k.minutes / 60} 小时` : `${k.minutes} 分钟`}（${until} 前有效）` : `${until} 前有效`;
  return [
    '你好！你购买的资料已开通，阅读密钥如下：',
    '',
    `资料：${names}`,
    `密钥：${fmtCode(k.code)}`,
    `有效期：${validity}`,
    `可用次数：最多输入 ${k.maxUses || 1} 次（换设备或浏览器需要重新输入）`,
    '',
    '使用方法：',
    `1. 用浏览器打开 ${location.origin}/library/`,
    '2. 在页面顶部「我有密钥」处粘贴密钥，点「解锁」',
    '3. 解锁后可以在线阅读，也可以点「下载 PDF」保存到手机或电脑',
    '',
    '温馨提示：',
    '· 到期后资料会重新锁定，请在有效期内完成下载；',
    '· 微信里无法下载文件，请点右上角「…」选择「在浏览器中打开」；',
    '· PDF 带有你的授权标识，仅供本人学习使用，请勿转发或转售。',
  ].join('\n');
}

function renderResult() {
  if (!A.issued.length) {
    put(els.result, h('div', { class: 'card adm-card result-empty' },
      h('span', { class: 'result-empty-icon' }, icon('key', 26)),
      h('strong', {}, '生成的密钥会显示在这里'),
      h('p', { class: 'muted small' }, '默认 30 分钟有效、可兑换 3 次。生成后可以一键复制密钥或整段发送话术。')));
    return;
  }
  const [latest, ...older] = A.issued;
  put(els.result, resultCard(latest, true),
    older.length ? h('div', { class: 'card adm-card recent' },
      h('h3', {}, '本次登录生成的其他密钥'),
      h('ul', {}, older.slice(0, 8).map((k) => h('li', {},
        h('code', {}, fmtCode(k.code)),
        h('span', { class: 'muted small' }, k.products.map(productTitle).join('、')),
        h('span', { class: 'rem small', 'data-exp': String(k.expiresAt) }, remainingText(k.expiresAt)),
        h('button', { class: 'btn small', type: 'button', onClick: (e) => copy(e.currentTarget,sendScript(k), '发送话术已复制') }, '复制话术'))))) : null);
  tick();
}

function resultCard(k, big) {
  const text = sendScript(k);
  return h('div', { class: `card adm-card result${big ? ' big' : ''}` },
    h('div', { class: 'result-top' },
      h('span', { class: 'badge green' }, icon('check', 13), '密钥已生成'),
      h('span', { class: 'result-rem' }, '剩余 ', h('b', { 'data-exp': String(k.expiresAt) }, remainingText(k.expiresAt)))),
    h('div', { class: 'code-big', 'aria-label': '密钥' }, fmtCode(k.code)),
    h('dl', { class: 'result-meta' },
      h('div', {}, h('dt', {}, '资料'), h('dd', {}, k.products.map(productTitle).join('、'))),
      h('div', {}, h('dt', {}, '有效至'), h('dd', {}, fmtDateTime(k.expiresAt))),
      h('div', {}, h('dt', {}, '可兑换'), h('dd', {}, `${k.maxUses} 次`)),
      k.label ? h('div', {}, h('dt', {}, '备注'), h('dd', {}, k.label)) : null),
    h('div', { class: 'result-acts' },
      h('button', { class: 'btn primary', type: 'button', onClick: (e) => copy(e.currentTarget,fmtCode(k.code), '密钥已复制') }, icon('copy', 16), '复制密钥'),
      h('button', { class: 'btn blue', type: 'button', onClick: (e) => copy(e.currentTarget,text, '发送话术已复制，可以直接粘贴给买家') }, icon('chat', 16), '复制发送话术')),
    h('details', { class: 'script-preview' }, h('summary', {}, '预览发送话术'), h('pre', {}, text)));
}

/* ---------------- active keys ---------------- */
function keysPanel() {
  els.keyList = h('div', { class: 'key-list' }, h('div', { class: 'skeleton', style: { height: '120px' } }));
  const refresh = h('button', { class: 'btn small', type: 'button' }, icon('refresh', 16), '刷新');
  refresh.addEventListener('click', async () => { busy(refresh, true); await refreshKeys(); busy(refresh, false); });
  return h('div', { class: 'tab-panel', role: 'tabpanel', hidden: true },
    h('section', { class: 'card adm-card' },
      h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, '有效密钥'),
        h('p', { class: 'muted small' }, '未过期的密钥。撤销后最长约 1 分钟生效，买家会在之后的下一次翻页或刷新时被锁定。')), refresh),
      els.keyList));
}

async function refreshKeys() {
  try {
    const d = await call('/api/admin/keys');
    A.keys = listOf(d, 'keys').map(normKey).filter((k) => k.code && k.expiresAt > Date.now()).sort((a, b) => b.expiresAt - a.expiresAt);
    renderKeys();
  } catch (e) {
    if (!e.handled && els.keyList) put(els.keyList, h('div', { class: 'notice red' }, icon('info', 18), h('span', {}, errMsg(e, '读取密钥列表'))));
  }
}

function renderKeys() {
  els.tabs.keys.count.textContent = A.keys.filter((k) => !k.revoked).length ? String(A.keys.filter((k) => !k.revoked).length) : '';
  if (!A.keys.length) {
    put(els.keyList, h('div', { class: 'empty' }, h('strong', {}, '当前没有有效密钥'), '在「快速发码」里生成的密钥会出现在这里。'));
    return;
  }
  put(els.keyList, ...A.keys.map((k) => {
    const revoke = h('button', { class: 'btn small danger', type: 'button', disabled: k.revoked }, k.revoked ? '已撤销' : '撤销');
    revoke.addEventListener('click', () => revokeKey(k, revoke));
    return h('article', { class: `krow${k.revoked ? ' revoked' : ''}` },
      h('div', { class: 'krow-main' },
        h('div', { class: 'krow-code' },
          h('code', {}, fmtCode(k.code)),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': '复制密钥', title: '复制密钥', onClick: (e) => copy(e.currentTarget,fmtCode(k.code), '密钥已复制') }, icon('copy', 16)),
          k.revoked ? h('span', { class: 'badge red' }, '已撤销') : null),
        h('p', { class: 'krow-products' }, k.products.map(productTitle).join('、') || '—'),
        h('p', { class: 'krow-meta' },
          k.label ? h('span', {}, `备注：${k.label}`) : null,
          h('span', {}, `已兑换 ${k.uses}/${k.maxUses || '?'}`),
          h('span', {}, `至 ${fmtDateTime(k.expiresAt)}`))),
      h('div', { class: 'krow-side' },
        k.revoked ? null : h('span', { class: 'rem', 'data-exp': String(k.expiresAt) }, remainingText(k.expiresAt)),
        h('div', { class: 'krow-acts' },
          k.revoked ? null : h('button', { class: 'btn small', type: 'button', onClick: (e) => copy(e.currentTarget,sendScript(k), '发送话术已复制') }, '复制话术'),
          revoke)));
  }));
  tick();
}

async function revokeKey(k, btn) {
  if (!confirm(`确定撤销密钥 ${fmtCode(k.code)} 吗？\n撤销后最长约 1 分钟生效，买家将无法继续阅读和下载，此操作不能恢复。`)) return;
  busy(btn, true, '撤销中…');
  try {
    await call(`/api/admin/keys/${encodeURIComponent(k.code)}/revoke`, { method: 'POST' });
    A.revoked.add(k.code);
    k.revoked = true;
    toast(`已撤销 ${fmtCode(k.code)}`);
    renderKeys();
  } catch (e) {
    busy(btn, false);
    if (!e.handled) toast(errMsg(e, '撤销'), true, 8000);
  }
}

/* ---------------- students ---------------- */
function studentsPanel() {
  const u = h('input', { class: 'input', id: 'st-user', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '32', placeholder: '如 zhang_2027' });
  const n = h('input', { class: 'input', id: 'st-name', maxlength: '30', placeholder: '如 张同学（学员登录后看到的称呼）' });
  const exp = h('input', { class: 'input', id: 'st-exp', type: 'date', value: defaultExpiry() });
  u.addEventListener('input', () => { const v = u.value.toLowerCase().replace(/\s/g, ''); if (v !== u.value) u.value = v; err.textContent = ''; });
  const allR = h('input', { type: 'radio', name: 'st-scope', value: 'all' });
  allR.defaultChecked = true; // survives form.reset()
  const pickR = h('input', { type: 'radio', name: 'st-scope', value: 'pick' });
  const picks = h('div', { class: 'st-picks', hidden: true }, A.products.map((p) => h('label', { class: 'pick' },
    h('input', { type: 'checkbox', value: p.id }), h('span', {}, productTitle(p.id)))));
  for (const r of [allR, pickR]) r.addEventListener('change', () => { picks.hidden = !pickR.checked; });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, icon('plus', 16), '创建学员账号');
  const form = h('form', { class: 'auth-form', novalidate: true },
    h('label', { class: 'field-label', for: 'st-user' }, '用户名'), u,
    h('p', { class: 'hint tight' }, '3–32 位小写字母、数字或下划线，创建后不能修改。'),
    h('label', { class: 'field-label', for: 'st-name' }, '称呼'), n,
    h('label', { class: 'field-label', for: 'st-exp' }, '账号到期日'), exp,
    h('p', { class: 'field-label' }, '可查看的资料'),
    h('div', { class: 'scope' },
      h('label', { class: 'pick' }, allR, h('span', {}, '全部资料（含学员工具包）')),
      h('label', { class: 'pick' }, pickR, h('span', {}, '指定资料'))),
    picks, err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = u.value.trim();
    if (!USER_RE.test(username)) { err.textContent = '用户名需为 3–32 位小写字母、数字或下划线。'; u.focus(); return; }
    if (!exp.value) { err.textContent = '请选择账号到期日。'; exp.focus(); return; }
    const [y, m, d] = exp.value.split('-').map(Number);
    const expiresAt = new Date(y, m - 1, d, 23, 59, 59).getTime();
    if (expiresAt <= Date.now()) { err.textContent = '到期日需要晚于今天。'; exp.focus(); return; }
    let products = 'all';
    if (pickR.checked) {
      products = [...picks.querySelectorAll('input:checked')].map((c) => c.value);
      if (!products.length) { err.textContent = '请至少勾选一份资料，或选择「全部资料」。'; return; }
    }
    const displayName = n.value.trim() || username;
    busy(btn, true, '创建中…');
    try {
      const r = await call('/api/admin/students', { method: 'POST', body: { username, displayName, expiresAt, products } });
      showCredentials({ username: r?.username || username, password: r?.password, displayName, expiresAt }, '学员账号已创建');
      form.reset(); exp.value = defaultExpiry(); picks.hidden = true;
      refreshStudents();
    } catch (ex) {
      if (!ex.handled) err.textContent = errMsg(ex, '创建账号');
    } finally { busy(btn, false); }
  });

  els.stuList = h('div', { class: 'stu-list' }, h('div', { class: 'skeleton', style: { height: '120px' } }));
  els.stuCount = h('small', { class: 'muted' });
  return h('div', { class: 'tab-panel stu-grid', role: 'tabpanel', hidden: true },
    h('section', { class: 'card adm-card' },
      h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, '开通学员账号'),
        h('p', { class: 'muted small' }, '系统会自动生成密码，明文只显示一次。'))),
      form),
    h('section', { class: 'card adm-card' },
      h('div', { class: 'panel-head' }, h('div', {}, h('h2', {}, '学员账号 ', els.stuCount),
        h('p', { class: 'muted small' }, '停用、删除或重置密码后最长约 1 分钟生效，学员会在之后的下一次翻页或刷新时失去访问权限。'))),
      els.stuList));
}

async function refreshStudents() {
  try {
    const d = await call('/api/admin/students');
    A.students = listOf(d, 'students').map(normStudent).filter((s) => s.username).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    A.loadedStudents = true;
    renderStudents();
  } catch (e) {
    if (!e.handled && els.stuList) put(els.stuList, h('div', { class: 'notice red' }, icon('info', 18), h('span', {}, errMsg(e, '读取学员列表'))));
  }
}

function renderStudents() {
  els.stuCount.textContent = `（${A.students.length}）`;
  els.tabs.students.count.textContent = A.students.length ? String(A.students.length) : '';
  if (!A.students.length) {
    put(els.stuList, h('div', { class: 'empty' }, h('strong', {}, '还没有学员账号'), '在左侧填写信息即可开通。'));
    return;
  }
  put(els.stuList, ...A.students.map((s) => {
    const expired = s.expiresAt && s.expiresAt < Date.now();
    const status = s.disabled ? h('span', { class: 'badge red' }, '已停用') : expired ? h('span', { class: 'badge amber' }, '已到期') : h('span', { class: 'badge green' }, '正常');
    const scope = s.products === 'all' ? '全部资料' : Array.isArray(s.products) ? `${s.products.length} 份资料` : '—';
    const reset = h('button', { class: 'btn small', type: 'button' }, '重置密码');
    reset.addEventListener('click', () => resetPw(s, reset));
    const toggle = h('button', { class: 'btn small', type: 'button' }, s.disabled ? '启用' : '停用');
    toggle.addEventListener('click', () => toggleStudent(s, toggle));
    const del = h('button', { class: 'btn small danger', type: 'button' }, '删除');
    del.addEventListener('click', () => deleteStudent(s, del));
    return h('article', { class: `srow${s.disabled ? ' off' : ''}` },
      h('div', { class: 'srow-main' },
        h('div', { class: 'srow-name' }, h('strong', {}, s.displayName || s.username),
          s.displayName && s.displayName !== s.username ? h('code', {}, s.username) : null, status),
        h('p', { class: 'srow-meta' },
          h('span', {}, `到期 ${s.expiresAt ? fmtDay(s.expiresAt) : '—'}`),
          h('span', {}, scope),
          h('span', {}, s.lastLoginAt ? `最近登录 ${fmtDateTime(s.lastLoginAt)}` : '尚未登录'))),
      h('div', { class: 'srow-acts' }, reset, toggle, del));
  }));
}

async function resetPw(s, btn) {
  if (!confirm(`确定为「${s.displayName || s.username}」重置密码吗？\n旧密码和已有的登录最长约 1 分钟内全部失效。`)) return;
  busy(btn, true, '重置中…');
  try {
    const r = await call(`/api/admin/students/${encodeURIComponent(s.username)}/reset`, { method: 'POST' });
    showCredentials({ ...s, password: r?.password }, '密码已重置');
  } catch (e) { if (!e.handled) toast(errMsg(e, '重置密码'), true, 8000); } finally { busy(btn, false); }
}

async function toggleStudent(s, btn) {
  const action = s.disabled ? 'enable' : 'disable';
  if (action === 'disable' && !confirm(`确定停用「${s.displayName || s.username}」吗？\n停用后最长约 1 分钟生效，该学员将无法登录和查看资料，之后可以重新启用。`)) return;
  busy(btn, true, '处理中…');
  try {
    await call(`/api/admin/students/${encodeURIComponent(s.username)}/${action}`, { method: 'POST' });
    toast(action === 'disable' ? '已停用该账号' : '已重新启用该账号');
    await refreshStudents();
  } catch (e) { busy(btn, false); if (!e.handled) toast(errMsg(e, action === 'disable' ? '停用' : '启用'), true, 8000); }
}

async function deleteStudent(s, btn) {
  if (!confirm(`确定删除「${s.displayName || s.username}」的账号吗？\n删除后不能恢复；如只是暂时不用，建议选择「停用」。`)) return;
  busy(btn, true, '删除中…');
  try {
    await call(`/api/admin/students/${encodeURIComponent(s.username)}`, { method: 'DELETE' });
    toast('账号已删除');
    await refreshStudents();
  } catch (e) { busy(btn, false); if (!e.handled) toast(errMsg(e, '删除'), true, 8000); }
}

function showCredentials(c, title) {
  const text = [
    '你的陪跑学员账号已开通：',
    `登录地址：${location.origin}/login/`,
    `用户名：${c.username}`,
    `密码：${c.password || '（未返回，请重新重置）'}`,
    c.expiresAt ? `有效期至：${fmtDay(c.expiresAt)}` : null,
    '',
    '登录后可以在线查看学员资料（仅支持在线查看，不提供下载）。请妥善保管账号，不要转借他人。',
  ].filter((x) => x !== null).join('\n');
  const dlg = h('dialog', { class: 'sheet cred', 'aria-labelledby': 'cred-title' },
    h('div', { class: 'sheet-head' }, h('h2', { id: 'cred-title' }, title),
      h('button', { class: 'sheet-close', type: 'button', 'aria-label': '关闭', onClick: () => dlg.close() }, icon('close', 20))),
    h('div', { class: 'sheet-body' },
      h('div', { class: 'notice amber' }, icon('info', 18), h('span', {}, '密码只显示这一次，关闭后无法再次查看。请现在复制并发给学员。')),
      h('dl', { class: 'cred-list' },
        h('div', {}, h('dt', {}, '称呼'), h('dd', {}, c.displayName || c.username)),
        h('div', {}, h('dt', {}, '用户名'), h('dd', {}, h('code', {}, c.username))),
        h('div', {}, h('dt', {}, '密码'), h('dd', {}, h('code', { class: 'pw' }, c.password || '—'))),
        c.expiresAt ? h('div', {}, h('dt', {}, '有效期至'), h('dd', {}, fmtDay(c.expiresAt))) : null),
      h('details', { class: 'script-preview' }, h('summary', {}, '预览账号信息'), h('pre', {}, text))),
    h('div', { class: 'sheet-foot' },
      h('button', { class: 'btn', type: 'button', onClick: (e) => copy(e.currentTarget,c.password || '', '密码已复制') }, '只复制密码'),
      h('button', { class: 'btn primary', type: 'button', onClick: (e) => copy(e.currentTarget,text, '账号信息已复制，可以直接发给学员') }, icon('copy', 16), '复制账号信息')));
  dlg.addEventListener('cancel', (e) => { if (!confirm('关闭后将无法再次查看密码，确定已经复制了吗？')) e.preventDefault(); });
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}

init();
