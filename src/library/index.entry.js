// /library/ — catalog with unlock card.
import { h, toast } from '../shared/ui.js';
import { icon } from '../site/lib/icons.js';
import { loadCatalog, ensureProducts, fmtPrice, isP3, isStudentOnly, shortTitle, itemUrl, readUrl } from '../site/lib/catalog.js';
import { loadSession, hasProduct, isKey, sessionNotice } from '../site/lib/session.js';
import { unlockCard, startTicker } from './lib/unlock-card.js';
import { put } from '../site/lib/dom.js';

const app = document.getElementById('app');
let session = null;
let catalog = null;
let timer = null;

async function init() {
  [catalog, session] = await Promise.all([loadCatalog().catch(() => null), loadSession()]);
  if (session) await ensureProducts(catalog, session.products);
  render();
  if (location.hash === '#group-P3') {
    const g = document.getElementById('group-P3');
    g?.querySelector('details')?.setAttribute('open', '');
    g?.scrollIntoView({ block: 'start' });
  }
}

async function refresh(focusUnlock) {
  session = await loadSession();
  if (session) await ensureProducts(catalog, session.products);
  render();
  if (focusUnlock) document.getElementById('unlock')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function render() {
  clearInterval(timer);
  const head = h('div', { class: 'page-head' },
    h('p', { class: 'eyebrow' }, '资料库'),
    h('h1', {}, '资料与面经'),
    h('p', {}, '按申请阶段整理的经验指南、面试题库、院校面经与科研入门笔记。每份资料都标明来源：亲历回忆、已获授权的往年整理或公开信息。'));

  if (!catalog) {
    put(app, head, h('div', { class: 'empty' },
      h('strong', {}, '资料目录暂时没有加载出来'),
      '可能是网络不稳定，请刷新页面重试。',
      h('div', {}, h('button', { class: 'btn', type: 'button', onClick: () => location.reload() }, icon('refresh', 16), '刷新'))));
    return;
  }

  const card = unlockCard({ session, catalog, notice: session ? '' : sessionNotice(), onChange: (_s, justUnlocked) => refresh(justUnlocked) });
  // Order: single products, then bundles (P4) next to the single-school group (spans two columns),
  // then student-only items (only when the session can read them).
  const all = catalog.products;
  const p3 = all.filter((p) => isP3(p.id));
  const singles = all.filter((p) => !isP3(p.id) && !isStudentOnly(p) && !p.includes?.length);
  const bundles = all.filter((p) => !isP3(p.id) && !isStudentOnly(p) && p.includes?.length);
  const kits = all.filter((p) => isStudentOnly(p) && hasProduct(session, p.id));
  const grid = h('div', { class: 'lib-grid' },
    singles.map(productCard), bundles.map(productCard), p3.length ? p3Group(p3) : null, kits.map(productCard));
  put(app, head, card,
    h('div', { class: 'section-title' }, h('h2', {}, '全部资料'), h('p', {}, '点“试读”先看正文节选，点“详情”查看完整目录')),
    grid,
    h('div', { class: 'notice lib-help' }, icon('info', 18),
      h('span', {}, '资料仅供购买者本人学习使用。解锁后页面和 PDF 会带有你的授权标识，请勿转发或转售。资料不承诺推免资格、录取或任何结果。')));
  timer = startTicker(() => session, () => {
    session = null;
    toast('阅读时间已到，资料已重新锁定。如需继续阅读，请联系作者重新获取密钥。', true, 9000);
    render();
  });
}

function statusBadge(p) {
  if (!hasProduct(session, p.id)) return null;
  return h('span', { class: 'badge green' }, icon('unlock', 13), '已解锁',
    isKey(session) ? [' · ', h('span', { class: 'cd-inline', 'data-cd': '' }, '')] : null);
}

function actions(p) {
  if (hasProduct(session, p.id)) {
    const first = p.docs[0]?.id;
    return [
      h('a', { class: 'btn blue', href: readUrl(p.id, first) }, icon('book', 16), '在线阅读'),
      h('a', { class: 'btn', href: itemUrl(p.id) }, '详情'),
    ];
  }
  return [
    p.preview ? h('a', { class: 'btn', href: itemUrl(p.id, '#preview') }, '试读') : null,
    h('a', { class: 'btn primary', href: itemUrl(p.id) }, '查看详情'),
  ];
}

function priceEl(p) {
  if (isStudentOnly(p)) return h('div', { class: 'price' }, h('b', { style: { fontSize: '16px' } }, '学员专享'), h('small', {}, '仅陪跑学员可见'));
  return h('div', { class: 'price' }, h('b', {}, fmtPrice(p.price)), p.priceNote ? h('small', {}, p.priceNote) : null);
}

function productCard(p) {
  const on = hasProduct(session, p.id);
  return h('article', { class: `pcard card${on ? ' on' : ''}${p.includes?.length ? ' bundle' : ''}`, 'aria-labelledby': `t-${p.id}` },
    h('div', { class: 'pcard-top' },
      h('h3', { id: `t-${p.id}` }, h('a', { href: itemUrl(p.id) }, p.title)),
      statusBadge(p)),
    p.subtitle ? h('p', { class: 'pcard-sub' }, p.subtitle) : null,
    h('p', { class: 'pcard-point' }, p.sellingPoint || ''),
    h('div', { class: 'pcard-meta' },
      h('span', { class: 'chip' }, icon('doc', 14), `${p.docCount} 篇`),
      p.preview ? h('span', { class: 'chip' }, '可试读') : null,
      p.includes?.length ? h('span', { class: 'chip' }, '含全部单校复盘') : null),
    h('div', { class: 'pcard-foot' }, priceEl(p), h('div', { class: 'pcard-actions' }, actions(p))));
}

function p3Group(items) {
  const anyOn = items.some((p) => hasProduct(session, p.id));
  const prices = [...new Set(items.map((p) => fmtPrice(p.price)).filter(Boolean))];
  const list = h('ul', {}, items.map((p) => {
    const on = hasProduct(session, p.id);
    return h('li', { class: on ? 'on' : null },
      h('a', { class: 'gname', href: on ? readUrl(p.id, p.docs[0]?.id) : itemUrl(p.id) }, on ? icon('unlock', 13) : null, shortTitle(p)),
      h('span', { class: 'gacts' },
        on ? h('a', { href: itemUrl(p.id) }, '详情')
          : p.preview ? h('a', { href: itemUrl(p.id, '#preview') }, '试读') : null));
  }));
  const details = h('details', { class: 'group-list' },
    h('summary', {}, `${items.length} 所院校`, h('span', { class: 'sum-hint' }, '点校名查看详情'), icon('chevron', 16)), list);
  // Expanded on wider screens (compact chips); collapsed on phones unless something is unlocked
  details.open = anyOn || matchMedia('(min-width: 641px)').matches;
  return h('article', { class: `pcard card group${anyOn ? ' on' : ''}`, id: 'group-P3', 'aria-labelledby': 't-group-P3' },
    h('div', { class: 'pcard-top' },
      h('h3', { id: 't-group-P3' }, '单校面经复盘'),
      anyOn ? h('span', { class: 'badge green' }, icon('unlock', 13), '已解锁') : null),
    h('p', { class: 'pcard-sub' }, `${items.length} 所院校 · 每份单独购买 · 多校面经合集已包含全部单校复盘`),
    h('p', { class: 'pcard-point' }, '按学校学院梳理考核流程与回忆，区分亲历回忆与公开规则，适合已锁定目标院校的同学。'),
    details,
    h('div', { class: 'pcard-foot' },
      h('div', { class: 'price' }, h('b', {}, prices.length === 1 ? prices[0] : prices.join(' / ')), h('small', {}, '每份'))));
}

init();
