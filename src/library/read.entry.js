// /library/read.html?p=<id>&d=<docId> — online reader with watermark, countdown and read-only mode.
import { h, toast, qs, isWeChat } from '../shared/ui.js';
import { api } from '../shared/api.js';
import { icon } from '../site/lib/icons.js';
import { loadCatalog, ensureProducts, itemUrl, readUrl, shortTitle, includedProducts } from '../site/lib/catalog.js';
import { loadSession, hasProduct, isKey, isStudent, canDownload, remaining, sessionNotice } from '../site/lib/session.js';
import { keyForm, loginForm, unlockTabs } from '../site/lib/auth-forms.js';
import { enhanceProse, collectToc } from '../site/lib/prose.js';
import { countdownEl, startTicker } from './lib/unlock-card.js';
import { downloadPdf } from './lib/download.js';
import { enableReadOnly } from './lib/protect.js';
import { put } from '../site/lib/dom.js';

const app = document.getElementById('app');
const S = { pid: qs('p'), did: qs('d'), catalog: null, session: null, product: null, locked: false, loading: 0 };
const els = {};
let timer = null, recheck = null;

const BRAND_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M14 20h14l4 5 4-5h14v29H36l-4 4-4-4H14z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg>';
const brand = () => h('a', { class: 'brand', href: '/', 'aria-label': '保研全程陪跑 首页' }, h('span', { class: 'brand-icon', html: BRAND_SVG }));

async function init() {
  if (!S.pid) { location.replace('/library/'); return; }
  [S.catalog, S.session] = await Promise.all([loadCatalog().catch(() => null), loadSession()]);
  if (S.session) await ensureProducts(S.catalog, S.session.products);
  S.product = S.catalog?.get(S.pid) || { id: S.pid, title: '资料', docs: [] };
  if (!hasProduct(S.session, S.pid)) return !S.session && sessionNotice() ? showLock('notice', sessionNotice()) : showLock('need');
  if (!S.did) S.did = S.product.docs[0]?.id;
  if (!S.did) return showLock('empty');
  if (isStudent(S.session)) enableReadOnly();
  buildShell();
  const ok = await loadDoc(S.did, { replace: true });
  if (ok) startTimers();
}

/* ---------------- shell ---------------- */
function buildShell() {
  const p = S.product, s = S.session;
  els.menu = h('button', { class: 'rd-menu', type: 'button', 'aria-label': '打开目录', 'aria-controls': 'rd-side', 'aria-expanded': 'false' }, icon('menu', 20));
  els.menu.addEventListener('click', () => toggleDrawer(true));
  const chip = isKey(s)
    ? h('span', { class: 'rd-chip', title: '剩余阅读时间' }, icon('clock', 15), countdownEl('cd-inline'))
    : h('span', { class: 'rd-chip student' }, icon('shield', 15), isStudent(s) ? '只读' : '管理员预览');
  const topDl = canDownload(s) && p.pdf !== false ? dlButton('btn small') : null;
  const top = h('header', { class: 'rd-top' }, els.menu, brand(),
    h('a', { class: 'rd-back', href: itemUrl(p.id) }, icon('back', 18), h('span', {}, p.title)),
    h('div', { class: 'rd-top-right' }, chip, topDl));

  els.banner = isKey(s)
    ? h('div', { class: 'rd-banner', role: 'status' }, icon('clock', 16),
      h('span', {}, '限时阅读，剩余 ', h('b', { 'data-cd': '' }, ''), '，到期后自动锁定。', canDownload(s) ? '建议在有效期内下载 PDF 保存。' : ''),
      canDownload(s) && p.pdf !== false ? dlButton('btn small blue') : null)
    : h('div', { class: 'rd-banner student' }, icon('shield', 16),
      h('span', {}, isStudent(s)
        ? '陪跑学员只读模式：可在线查看，不提供下载、复制和打印。只读保护无法阻止截图，请勿外传。'
        : '管理员预览：版式与买家、学员看到的一致。只读保护无法阻止截图，请勿外传。'));

  els.docs = h('ol', { class: 'rd-docs' });
  els.side = h('aside', { class: 'rd-side', id: 'rd-side', 'aria-label': '文档目录' },
    h('div', { class: 'rd-side-head' }, h('h2', {}, '目录'),
      h('button', { class: 'rd-side-close', type: 'button', 'aria-label': '关闭目录', onClick: () => toggleDrawer(false) }, icon('close', 18))),
    h('nav', { 'aria-label': '文档列表' }, els.docs),
    includedBlock(),
    h('p', { class: 'rd-side-note' }, h('strong', {}, '只读保护无法阻止截图，请勿外传。'), h('br'), '页面水印包含你的授权信息，可追溯到具体密钥或账号。'));
  els.backdrop = h('div', { class: 'rd-backdrop', onClick: () => toggleDrawer(false) });
  els.head = h('div', { class: 'rd-doc-head' });
  els.article = h('article', { class: 'prose rd-doc', 'aria-live': 'polite' });
  els.pager = h('nav', { class: 'rd-pager', 'aria-label': '翻页' });
  els.main = h('main', { class: 'rd-main', id: 'main' }, els.head, els.article, els.pager,
    h('p', { class: 'rd-foot-note' }, '本资料仅供授权用户个人学习使用，请勿转发、转售或上传。只读保护无法阻止截图，请勿外传。'));
  els.wm = h('div', { class: 'wm-layer', 'aria-hidden': 'true' });
  put(app, top, els.banner, h('div', { class: 'rd-layout' }, els.side, els.main), els.backdrop, els.wm);
  renderDocList();

  app.addEventListener('click', onNavClick);
  window.addEventListener('popstate', () => {
    const d = qs('d') || S.product.docs[0]?.id;
    if (d && d !== S.did && !S.locked) loadDoc(d, { push: false });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleDrawer(false); });
  window.addEventListener('scroll', onScroll, { passive: true });
}

function dlButton(cls) {
  const b = h('button', { class: cls, type: 'button' }, icon('download', 16), '下载 PDF');
  b.addEventListener('click', () => downloadPdf(S.product, S.session, b));
  return b;
}

function includedBlock() {
  if (!S.catalog || !S.product.includes?.length) return null;
  const inc = includedProducts(S.catalog, S.product).filter((q) => hasProduct(S.session, q.id));
  if (!inc.length) return null;
  return h('div', { class: 'rd-inc' },
    h('div', { class: 'rd-side-head', style: { marginTop: '14px' } }, h('h2', {}, '单校面经复盘')),
    h('ol', { class: 'rd-docs inc' }, inc.map((q) => h('li', {}, h('a', { href: readUrl(q.id, q.docs[0]?.id), 'data-external': '' }, shortTitle(q))))));
}

function toggleDrawer(open) {
  if (!els.side) return;
  els.side.classList.toggle('open', open);
  els.backdrop.classList.toggle('open', open);
  els.menu.setAttribute('aria-expanded', String(open));
  if (open) els.side.querySelector('.current a, a')?.focus({ preventScroll: true });
}

function onNavClick(e) {
  const a = e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
  const href = a.getAttribute('href');
  if (href.startsWith('#')) { toggleDrawer(false); return; } // in-page section link
  if (a.hasAttribute('data-external')) return;
  const url = new URL(a.href, location.href);
  if (url.pathname.endsWith('/read.html') || url.pathname.endsWith('/read')) {
    if (url.searchParams.get('p') === S.pid && url.searchParams.get('d')) {
      e.preventDefault();
      toggleDrawer(false);
      if (url.searchParams.get('d') !== S.did) loadDoc(url.searchParams.get('d'), { push: true });
    }
  }
}

/* ---------------- documents ---------------- */
function renderDocList(toc = []) {
  const docs = S.product.docs.length ? S.product.docs : [{ id: S.did, title: S.docTitle || '当前文档' }];
  put(els.docs, ...docs.map((d) => {
    const cur = d.id === S.did;
    return h('li', { class: cur ? 'current' : null },
      h('a', { href: readUrl(S.pid, d.id), 'aria-current': cur ? 'page' : null }, d.title),
      cur && toc.length ? h('ol', { class: 'rd-toc' }, toc.map((t) => h('li', {}, h('a', { href: `#${t.id}`, class: t.level === 3 ? 'l3' : null, 'data-sec': t.id }, t.text)))) : null);
  }));
}

function renderPager() {
  const docs = S.product.docs;
  const i = docs.findIndex((d) => d.id === S.did);
  const prev = i > 0 ? docs[i - 1] : null;
  const next = i >= 0 && i < docs.length - 1 ? docs[i + 1] : null;
  put(els.pager, 
    prev ? h('a', { class: 'prev', href: readUrl(S.pid, prev.id) }, h('small', {}, '‹ 上一篇'), h('span', {}, prev.title)) : null,
    next ? h('a', { class: 'next', href: readUrl(S.pid, next.id) }, h('small', {}, '下一篇 ›'), h('span', {}, next.title)) : null);
  put(els.head, h('span', {}, S.product.title), i >= 0 ? h('span', {}, `· 第 ${i + 1} / ${docs.length} 篇`) : null);
}

async function loadDoc(did, { push = false, replace = false } = {}) {
  const ticket = ++S.loading;
  els.article.setAttribute('aria-busy', 'true');
  put(els.article, h('div', { class: 'skeleton', style: { height: '34px', width: '55%', marginBottom: '22px' } }),
    h('div', { class: 'skeleton', style: { height: '320px' } }));
  let d;
  try {
    d = await api(`/api/doc/${encodeURIComponent(S.pid)}/${encodeURIComponent(did)}`);
  } catch (e) {
    if (ticket !== S.loading) return false;
    if (e.status === 401) { await afterAuthLoss(); return false; }
    if (e.status === 403) { showLock('denied', e.message); return false; }
    els.article.removeAttribute('aria-busy');
    put(els.article, h('div', { class: 'empty' },
      h('strong', {}, e.status === 404 ? '没有找到这篇文档' : '文档没有加载出来'),
      e.status === 404 ? '目录可能已经更新，请从左侧目录重新选择。' : '可能是网络不稳定，请重试。',
      h('div', {}, h('button', { class: 'btn', type: 'button', onClick: () => loadDoc(did, { push: false }) }, icon('refresh', 16), '重试'))));
    return false;
  }
  if (ticket !== S.loading || S.locked) return false;
  S.did = did;
  S.docTitle = d.title;
  els.article.innerHTML = d.html || ''; // trusted HTML from our own content pipeline
  els.article.removeAttribute('aria-busy');
  if (!els.article.querySelector('h1') && d.title) els.article.prepend(h('h1', {}, d.title));
  enhanceProse(els.article);
  const toc = collectToc(els.article);
  renderDocList(toc);
  renderPager();
  setWatermark(d.watermark);
  document.title = `${d.title || '在线阅读'}｜${S.product.title}`;
  const url = readUrl(S.pid, did);
  if (push) history.pushState({ d: did }, '', url);
  else if (replace) history.replaceState({ d: did }, '', url + location.hash);
  const target = !push && location.hash ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null;
  // Jump (no smooth animation) when switching documents
  if (target) target.scrollIntoView({ behavior: 'instant' });
  else window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  if (push || replace) revealCurrentInSide();
  onScroll();
  return true;
}

// Scroll only the sidebar so the current document is visible. (scrollIntoView would also scroll the
// window when the current item + its section list is taller than the sidebar, hiding the countdown
// banner and its download button under the sticky top bar.)
function revealCurrentInSide() {
  const li = els.side?.querySelector('li.current');
  if (!li) return;
  const side = els.side;
  const top = li.getBoundingClientRect().top - side.getBoundingClientRect().top + side.scrollTop;
  if (top < side.scrollTop || top > side.scrollTop + side.clientHeight - 64) side.scrollTop = Math.max(0, top - 8);
}

/* ---------------- watermark ---------------- */
function textWidth(s, px) {
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e7f ? px : px * 0.58;
  return w;
}
function setWatermark(wm) {
  const l1 = String(wm?.line1 || '').slice(0, 60), l2 = String(wm?.line2 || '').slice(0, 80);
  if (!l1 && !l2) { els.wm.style.backgroundImage = ''; return; }
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const tw = Math.max(textWidth(l1, 15), textWidth(l2, 12));
  const W = Math.round(Math.min(Math.max(tw * 0.95 + 90, 340), 680));
  const H = Math.round(W * 0.56);
  // One 2W x 2H tile holding two staggered copies -> brick pattern
  const block = (cx, cy) => `<g transform="rotate(-22 ${cx} ${cy})"><text x="${cx}" y="${cy - 4}" font-size="15" font-weight="600">${esc(l1)}</text><text x="${cx}" y="${cy + 17}" font-size="12">${esc(l2)}</text></g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}"><g fill="#1d3156" fill-opacity="0.085" font-family="PingFang SC,Microsoft YaHei,Noto Sans CJK SC,sans-serif" text-anchor="middle">${block(W / 2, H / 2)}${block(W * 1.5, H * 1.5)}</g></svg>`;
  els.wm.style.backgroundImage = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

/* ---------------- toc highlight ---------------- */
let raf = 0;
function onScroll() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const links = els.docs?.querySelectorAll('.rd-toc a[data-sec]');
    if (!links?.length) return;
    let active = null;
    for (const a of links) {
      const el = document.getElementById(a.dataset.sec);
      if (el && el.getBoundingClientRect().top < 130) active = a;
    }
    for (const a of links) a.classList.toggle('active', a === active);
  });
}

/* ---------------- expiry / revocation ---------------- */
function startTimers() {
  if (isKey(S.session)) {
    timer = startTicker(() => S.session, () => showLock('expired'), (ms) => {
      els.banner?.classList.toggle('warn', ms < 5 * 60 * 1000);
    });
  }
  recheck = setInterval(verify, 90_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') verify(); });
}

async function verify() {
  if (S.locked) return;
  const s = await loadSession();
  if (hasProduct(s, S.pid)) { S.session = { ...S.session, ...s }; return; }
  await afterAuthLoss(s);
}

async function afterAuthLoss(fresh) {
  const before = S.session;
  const s = fresh === undefined ? await loadSession() : fresh;
  if (isKey(before) && remaining(before) <= 1000) return showLock('expired');
  const note = s ? '' : sessionNotice();
  if (isStudent(before)) return showLock(s ? 'denied' : note ? 'notice' : 'relogin', note);
  return showLock(note ? 'notice' : 'gone', note);
}

/* ---------------- lock screen ---------------- */
function showLock(kind, message) {
  S.locked = true;
  clearInterval(timer);
  clearInterval(recheck);
  if (els.article) put(els.article); // drop the document text from the page
  if (els.wm) els.wm.style.backgroundImage = '';
  const p = S.product || { id: S.pid, title: '资料' };
  const reload = () => location.reload();
  const keyOnly = isKey(S.session) && !hasProduct(S.session, p.id) && remaining(S.session) > 0;
  const cfg = {
    need: keyOnly
      ? ['当前密钥不包含这份资料', '你已解锁的资料里没有这一份。如需阅读，请联系作者购买，或核对密钥对应的资料。', unlockTabs({ onSuccess: reload })]
      : ['这份资料需要解锁后阅读', '购买后输入作者发给你的阅读密钥即可在线阅读；全程陪跑学员请用账号登录。', unlockTabs({ onSuccess: reload })],
    expired: ['阅读时间已到，资料已重新锁定', '这个密钥的有效期已经结束。如需继续阅读，请联系作者重新获取密钥，然后在下方输入。', keyForm({ onSuccess: reload, autofocus: false })],
    gone: ['资料已重新锁定', '密钥已到期或已失效。如需继续阅读，请联系作者重新获取密钥，然后在下方输入。', keyForm({ onSuccess: reload })],
    relogin: ['登录已过期，请重新登录', '为了保护资料，学员登录状态最长保留 7 天。请重新登录后继续阅读。', loginForm({ onSuccess: reload })],
    denied: ['暂时无法阅读这份资料', `${String(message || '没有阅读权限').replace(/[。.]$/, '')}。如有疑问，请联系作者处理。`, null],
    notice: ['资料已锁定', String(message || '请重新输入密钥或登录。'), isStudent(S.session) ? loginForm({ onSuccess: reload }) : unlockTabs({ onSuccess: reload, initial: /账号|密码/.test(message || '') ? 'student' : 'key' })],
    empty: ['这份资料暂时没有可阅读的内容', '资料正在整理中，请稍后再来，或回到资料库查看其他资料。', null],
  }[kind] || ['资料已锁定', '请回到资料库重新解锁。', null];
  const card = h('div', { class: 'card', role: 'alert' },
    h('div', { class: 'lock-icon' }, icon('lock', 26)),
    h('h1', {}, cfg[0]),
    h('p', { class: 'lead' }, cfg[1]),
    cfg[2],
    h('div', { class: 'actions' },
      h('a', { class: 'btn', href: itemUrl(p.id) }, icon('back', 16), '资料详情与试读'),
      h('a', { class: 'btn ghost', href: '/library/' }, '返回资料库')));
  const top = h('header', { class: 'rd-top' }, brand(),
    h('a', { class: 'rd-back', href: itemUrl(p.id) }, icon('back', 18), h('span', {}, p.title)));
  put(app, top, h('div', { class: 'rd-lock' }, card));
  document.title = `${cfg[0]}｜保研全程陪跑`;
  if (kind === 'expired' || kind === 'gone') toast('资料已重新锁定。如需继续阅读，请联系作者重新获取密钥。', true, 9000);
}

if (isWeChat()) document.documentElement.classList.add('wechat');
init();
