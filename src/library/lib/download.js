// "下载 PDF": fetch /api/download/<p> and save it. The server has already written the licence stamp
// (key code + date) into every page, so there is nothing to do in the browser.
import { h, toast, isWeChat } from '../../shared/ui.js';
import { icon } from '../../site/lib/icons.js';

function parseFilename(cd) {
  if (!cd) return '';
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')); } catch { /* fall through */ } }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(cd);
  return plain ? plain[1].trim() : '';
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60_000);
}

export function wechatTip() {
  const dlg = h('dialog', { class: 'sheet wx-tip', 'aria-labelledby': 'wx-tip-title' },
    h('div', { class: 'sheet-head' }, h('h2', { id: 'wx-tip-title' }, '请在浏览器中打开后下载'),
      h('button', { class: 'sheet-close', type: 'button', 'aria-label': '关闭', onClick: () => dlg.close() }, icon('close', 20))),
    h('div', { class: 'sheet-body' },
      h('p', {}, '微信内置浏览器无法保存文件。请点右上角的「…」，选择「在浏览器中打开」，然后在浏览器里重新输入密钥（如已解锁可直接进入）并点「下载 PDF」。'),
      h('p', { class: 'muted small', style: { marginTop: '10px' } }, '提示：换到浏览器后需要重新输入一次密钥；同一密钥可输入的次数有限，请不要分享给他人。')),
    h('div', { class: 'sheet-foot' }, h('button', { class: 'btn primary', type: 'button', onClick: () => dlg.close() }, '知道了')));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
}

/**
 * Download the product PDF (stamped by the server with the buyer's key code on every page).
 * @param {{id:string,title:string}} product
 * @param {object} [_session]  current /api/me session (kept for call-site compatibility; not needed any more)
 * @param {HTMLButtonElement} [btn]  button to show progress on
 */
export async function downloadPdf(product, _session, btn) {
  if (isWeChat()) { wechatTip(); return false; }
  const label = btn?.innerHTML;
  const busy = (text) => { if (btn) { btn.disabled = true; btn.textContent = text; } };
  try {
    busy('正在获取 PDF…');
    const res = await fetch(`/api/download/${encodeURIComponent(product.id)}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json())?.error || ''; } catch { /* not JSON */ }
      const err = new Error(msg || `下载失败（${res.status}）`);
      err.status = res.status;
      throw err;
    }
    const blob = await res.blob();
    const name = parseFilename(res.headers.get('Content-Disposition')) || `${product.title || product.id}.pdf`;
    saveBlob(new Blob([blob], { type: 'application/pdf' }), name);
    toast('PDF 已开始下载，文件带有你的授权标识，请勿外传');
    return true;
  } catch (e) {
    const st = e?.status;
    let msg;
    if (st === 401) msg = '阅读时间已到或密钥已失效，资料已重新锁定。如需下载，请联系作者重新获取密钥。';
    else if (st === 403) msg = `${(e.message || '没有下载权限').replace(/[。.]$/, '')}。如有疑问请联系作者。`;
    else if (st === 404) msg = '这份资料的 PDF 还在准备中，请先在线阅读，稍后再试。';
    else if (st) msg = `${(e.message || '下载失败').replace(/[。.]$/, '')}。请稍后重试。`;
    else msg = 'PDF 下载没有完成，请检查网络后重试。';
    toast(msg, true, 9000);
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = label; }
  }
}
