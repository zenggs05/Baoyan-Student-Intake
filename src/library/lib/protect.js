// Read-only mode for student sessions: no context menu, selection, copy, save or print.
// This only deters casual forwarding; it cannot stop screenshots (the page says so).
import { toast } from '../../shared/ui.js';

let enabled = false;
let lastToast = 0;

function hint() {
  const now = Date.now();
  if (now - lastToast > 4000) {
    lastToast = now;
    toast('陪跑学员账号仅支持在线查看，已关闭复制、保存和打印。');
  }
}

const isFormField = (t) => !!t?.closest?.('input, textarea, [contenteditable="true"]');

function block(e) {
  if (!enabled || isFormField(e.target)) return;
  e.preventDefault();
  if (e.type === 'copy' || e.type === 'cut' || e.type === 'contextmenu') hint();
}

export function enableReadOnly() {
  if (enabled) return;
  enabled = true;
  document.body.classList.add('ro');
  for (const t of ['contextmenu', 'copy', 'cut', 'selectstart', 'dragstart']) document.addEventListener(t, block, true);
  document.addEventListener('keydown', (e) => {
    if (!enabled) return;
    const k = (e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && ['c', 'x', 'a', 's', 'p', 'u'].includes(k) && !isFormField(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      hint();
    }
  }, true);
  window.addEventListener('beforeprint', () => { if (enabled) hint(); });
}

export function disableReadOnly() {
  enabled = false;
  document.body.classList.remove('ro');
}
