// Home page: static HTML; this script only powers the service-detail sheet.
import { h } from '../shared/ui.js';
import { fetchFragment } from './lib/catalog.js';
import { enhanceProse } from './lib/prose.js';
import { put } from './lib/dom.js';

const sheet = document.getElementById('svc-sheet');
const sheetTitle = document.getElementById('svc-sheet-title');
const sheetBody = document.getElementById('svc-sheet-body');
const cache = new Map();
let opener = null;

function openSheet() {
  if (typeof sheet.showModal === 'function') sheet.showModal();
  else sheet.setAttribute('open', '');
  document.documentElement.style.overflow = 'hidden';
}
function closeSheet() {
  if (sheet.open) (typeof sheet.close === 'function' ? sheet.close() : sheet.removeAttribute('open'));
}
sheet.addEventListener('close', () => {
  document.documentElement.style.overflow = '';
  opener?.focus?.({ preventScroll: true });
});

async function showService(code, title, btn) {
  opener = btn;
  sheetTitle.textContent = title || '服务详情';
  put(sheetBody, 
    h('div', { class: 'skeleton', style: { height: '22px', width: '60%', marginBottom: '14px' } }),
    h('div', { class: 'skeleton', style: { height: '120px' } }));
  openSheet();
  sheetBody.scrollTop = 0;
  if (!cache.has(code)) cache.set(code, fetchFragment(`/data/services/${encodeURIComponent(code)}.html`));
  const html = await cache.get(code);
  if (sheetTitle.textContent !== (title || '服务详情')) return; // another sheet was opened meanwhile
  if (!html) {
    cache.delete(code);
    put(sheetBody, h('div', { class: 'notice' },
      '这项服务的详细说明正在整理中。你可以先关注微信公众号「飞鸟想要飞」，在后台留言说明想了解的服务和你的情况，作者会告诉你具体安排。'));
    return;
  }
  sheetBody.innerHTML = html; // trusted, pre-rendered public fragment
  const first = sheetBody.firstElementChild;
  if (first?.tagName === 'H1') first.remove();
  enhanceProse(sheetBody);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-svc]');
  if (btn) { e.preventDefault(); showService(btn.dataset.svc, btn.dataset.title, btn); return; }
  if (e.target.closest('[data-close]')) closeSheet();
});
// Click on the backdrop closes the sheet
sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
