// /library/item.html?p=<id> — sale page, document list, preview, unlock / read / download.
import { h, toast, qs } from '../shared/ui.js';
import { icon } from '../site/lib/icons.js';
import { loadCatalog, ensureProducts, fmtPrice, isP3, isStudentOnly, shortTitle, includedProducts, fetchSale, fetchPreview, itemUrl, readUrl } from '../site/lib/catalog.js';
import { loadSession, hasProduct, isKey, isStudent, canDownload } from '../site/lib/session.js';
import { keyForm } from '../site/lib/auth-forms.js';
import { enhanceProse } from '../site/lib/prose.js';
import { countdownEl, startTicker } from './lib/unlock-card.js';
import { downloadPdf } from './lib/download.js';
import { put } from '../site/lib/dom.js';
import { BUY_CHANNEL } from '../site/lib/contact.js';

const app = document.getElementById('app');
const id = qs('p');
let catalog = null, session = null, product = null, timer = null;
let saleHtml = null, previewHtml = null;

async function init() {
  [catalog, session] = await Promise.all([loadCatalog().catch(() => null), loadSession()]);
  if (session) await ensureProducts(catalog, session.products);
  product = catalog?.get(id) || null;
  if (!catalog || !product || (isStudentOnly(product) && !hasProduct(session, product.id))) return renderMissing(!catalog);
  document.title = `${product.title}｜资料库｜保研全程陪跑`;
  render();
  [saleHtml, previewHtml] = await Promise.all([fetchSale(product.id), product.preview ? fetchPreview(product.id) : Promise.resolve('')]);
  fillTabs();
  if (location.hash === '#preview' && product.preview) tabsEl.scrollIntoView({ block: 'start' });
}

function renderMissing(network) {
  put(app, h('div', { class: 'crumbs' }, h('a', { href: '/library/' }, icon('back', 16), '资料库')),
    h('div', { class: 'empty', style: { marginTop: '20px' } },
      h('strong', {}, network ? '页面暂时没有加载出来' : '没有找到这份资料'),
      network ? '可能是网络不稳定，请刷新页面重试。' : '链接可能已经更新，请回到资料库重新选择。',
      h('div', {}, h('a', { class: 'btn primary', href: '/library/' }, '返回资料库'))));
}

let tabsEl, introPane, previewPane;

function render() {
  clearInterval(timer);
  const p = product;
  const unlocked = hasProduct(session, p.id);
  const crumbs = h('nav', { class: 'crumbs', 'aria-label': '位置' },
    h('a', { href: '/library/' }, icon('back', 16), '资料库'),
    isP3(p.id) ? [h('span', {}, '/'), h('a', { href: '/library/#group-P3' }, '单校面经复盘')] : null);

  const hero = h('section', { class: 'item-hero card' },
    h('div', {},
      h('h1', {}, isP3(p.id) ? `单校面经复盘 · ${shortTitle(p)}` : p.title),
      p.subtitle ? h('p', { class: 'item-sub' }, p.subtitle) : null,
      p.sellingPoint ? h('p', { class: 'item-point' }, p.sellingPoint) : null,
      h('div', { class: 'item-meta' },
        h('span', { class: 'chip' }, icon('doc', 14), `${p.docCount} 篇文档`),
        p.preview ? h('span', { class: 'chip' }, '可试读') : null,
        includedProducts(catalog, p).length ? h('span', { class: 'chip' }, `含 ${includedProducts(catalog, p).length} 份单校复盘`) : null)),
    buyBox(unlocked));

  introPane = h('div', { class: 'prose', id: 'pane-intro', role: 'tabpanel' }, h('div', { class: 'skeleton', style: { height: '260px' } }));
  previewPane = h('div', { id: 'pane-preview', role: 'tabpanel', hidden: true });
  tabsEl = h('div', { class: 'tabs', role: 'tablist' },
    tabBtn('intro', '资料介绍'),
    p.preview ? tabBtn('preview', '免费试读') : null);
  const main = h('section', { class: 'item-main card' }, tabsEl, introPane, previewPane);

  put(app, crumbs, hero, h('div', { class: 'item-layout' }, main, sideBox(unlocked)));
  selectTab(location.hash === '#preview' && p.preview ? 'preview' : 'intro', false);
  if (saleHtml !== null) fillTabs();

  timer = startTicker(() => session, () => {
    session = null;
    toast('阅读时间已到，资料已重新锁定。如需继续阅读，请联系作者重新获取密钥。', true, 9000);
    render();
  });
}

function tabBtn(key, label) {
  const b = h('button', { class: 'tab', type: 'button', role: 'tab', 'data-tab': key, 'aria-controls': `pane-${key}` }, label);
  b.addEventListener('click', () => selectTab(key, true));
  return b;
}

function selectTab(key, push) {
  for (const b of tabsEl.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === key));
  introPane.hidden = key !== 'intro';
  previewPane.hidden = key !== 'preview';
  if (push) history.replaceState(null, '', key === 'preview' ? '#preview' : location.pathname + location.search);
}

window.addEventListener('hashchange', () => {
  if (!tabsEl) return;
  if (location.hash === '#preview' && product?.preview) { selectTab('preview', false); tabsEl.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
});

function fillTabs() {
  const p = product;
  if (saleHtml) {
    introPane.innerHTML = saleHtml; // trusted pre-rendered public fragment
    if (introPane.firstElementChild?.tagName === 'H1') introPane.firstElementChild.remove();
    enhanceProse(introPane, { previewHref: '#preview' });
  } else {
    put(introPane, 
      h('p', {}, p.sellingPoint || ''),
      h('div', { class: 'notice' }, icon('info', 18), h('span', {}, '详细介绍正在整理中，可以先查看右侧的完整目录和免费试读。')));
  }
  if (p.preview) {
    if (previewHtml) {
      const body = h('div', { class: 'prose' });
      body.innerHTML = previewHtml; // trusted pre-rendered public fragment
      enhanceProse(body);
      put(previewPane, 
        h('div', { class: 'notice preview-note' }, icon('book', 18), h('span', {}, '以下是正文节选，可免费阅读。完整内容购买后输入密钥即可解锁。')),
        body,
        hasProduct(session, p.id) ? null : h('div', { class: 'notice amber', style: { marginTop: '24px' } }, icon('lock', 18),
          h('span', {}, '试读到这里结束。想看全文？', h('a', { href: '#buy', onClick: focusBuy }, '输入密钥解锁'), ' 或联系作者购买。')));
    } else {
      put(previewPane, h('div', { class: 'notice' }, icon('info', 18), h('span', {}, '试读内容正在整理中，请稍后再来看看。')));
    }
  }
}

function focusBuy(e) {
  e?.preventDefault();
  const box = document.getElementById('buy');
  box?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  box?.querySelector('input')?.focus({ preventScroll: true });
}

async function onUnlocked() {
  session = await loadSession();
  if (hasProduct(session, product.id)) render();
  else {
    render();
    toast('密钥已生效，但不包含这份资料。请到资料库查看已解锁的资料，或联系作者核对。', true, 9000);
  }
}

function buyBox(unlocked) {
  const p = product;
  const first = p.docs[0]?.id;
  if (unlocked) {
    const kids = [
      isKey(session)
        ? h('div', { class: 'status-line' }, icon('unlock', 16), '已解锁 · 剩余 ', countdownEl('cd-inline'))
        : h('div', { class: 'status-line student' }, icon('user', 16), '陪跑学员 · 可在线查看'),
      h('a', { class: 'btn blue', href: readUrl(p.id, first) }, icon('book', 16), '在线阅读'),
    ];
    if (canDownload(session) && p.pdf !== false) {
      const dl = h('button', { class: 'btn', type: 'button' }, icon('download', 16), '下载 PDF');
      dl.addEventListener('click', () => downloadPdf(p, session, dl));
      kids.push(dl, h('p', { class: 'muted' }, 'PDF 每页带有你的授权标识。在微信里请先点右上角，在浏览器中打开后再下载。'));
    } else if (isStudent(session)) {
      kids.push(h('p', { class: 'muted' }, '陪跑学员账号仅支持在线查看，不提供下载。'));
    }
    return h('div', { class: 'item-buy', id: 'buy' }, kids);
  }
  const wrongKey = session && (isKey(session) || isStudent(session)) && session.products?.length;
  return h('div', { class: 'item-buy', id: 'buy' },
    isStudentOnly(p) ? h('div', { class: 'price' }, h('b', {}, '学员专享'))
      : h('div', { class: 'price' }, h('b', {}, fmtPrice(p.price)), p.priceNote ? h('small', {}, p.priceNote) : null),
    wrongKey ? h('p', { class: 'muted' }, '你当前解锁的资料不包含这一份。') : null,
    h('p', { class: 'field-label', style: { marginTop: '6px' } }, '已购买？输入密钥解锁'),
    keyForm({ onSuccess: onUnlocked, compact: true }),
    h('a', { class: 'btn ghost small', href: `/login/?next=${encodeURIComponent(location.pathname + location.search)}` }, icon('user', 16), '陪跑学员登录'),
    h('p', { class: 'muted' }, '如何购买：', BUY_CHANNEL, '，付款后会收到阅读密钥。'));
}

function sideBox(unlocked) {
  const p = product;
  const list = h('ol', { class: 'doc-list' }, p.docs.map((d) => h('li', {},
    unlocked
      ? h('a', { href: readUrl(p.id, d.id) }, h('span', {}, d.title), icon('chevron', 14))
      : h('span', { class: 'row' }, h('span', {}, d.title), icon('lock', 14)))));
  const inc = includedProducts(catalog, p);
  return h('aside', { class: 'item-side card', 'aria-label': '文档目录' },
    h('h2', {}, '完整目录', h('small', {}, `${p.docs.length} 篇`)),
    p.docs.length ? list : h('p', { class: 'muted small', style: { marginTop: '8px' } }, '目录整理中。'),
    inc.length ? h('div', { class: 'side-sub' },
      h('h3', {}, `另含 ${inc.length} 份单校面经复盘`),
      h('ul', {}, inc.map((q) => h('li', {}, h('a', { href: hasProduct(session, q.id) ? readUrl(q.id, q.docs[0]?.id) : itemUrl(q.id) }, shortTitle(q)))))) : null);
}

init();
