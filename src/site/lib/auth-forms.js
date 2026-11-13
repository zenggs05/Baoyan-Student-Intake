// Key redeem form + student login form, shared by /library/, item page, reader and /login/.
import { h, toast } from '../../shared/ui.js';
import { api } from '../../shared/api.js';
import { icon } from './icons.js';
import { friendlyError } from './session.js';

/** Upper-case and group into XXXX-XXXX-XXXX while typing (server normalises again). */
export function formatKeyInput(v) {
  const raw = String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 12);
  return raw.replace(/(.{4})(?=.)/g, '$1-');
}

let uid = 0;
const nextId = (p) => `${p}-${++uid}`;

function setBusy(btn, busy, busyText) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.disabled = busy;
  btn.textContent = busy ? busyText : btn.dataset.label;
}

export function keyForm({ onSuccess, autofocus = false, compact = false } = {}) {
  const id = nextId('key');
  const input = h('input', {
    class: 'input key-input', id, name: 'code', placeholder: 'XXXX-XXXX-XXXX', autocomplete: 'off',
    autocapitalize: 'characters', spellcheck: 'false', inputmode: 'text', maxlength: '20', 'aria-describedby': `${id}-err`,
  });
  const err = h('p', { class: 'form-error', id: `${id}-err`, role: 'alert' });
  const btn = h('button', { class: 'btn blue', type: 'submit' }, '解锁');
  input.addEventListener('input', () => {
    const pos = input.selectionStart === input.value.length;
    const f = formatKeyInput(input.value);
    if (f !== input.value) { input.value = f; if (pos) input.setSelectionRange(f.length, f.length); }
    err.textContent = '';
  });
  const form = h('form', { class: `auth-form key-form${compact ? ' compact' : ''}`, novalidate: true },
    h('label', { for: id, class: compact ? 'sr-only' : 'field-label' }, '阅读密钥'),
    h('div', { class: 'inline-field' }, input, btn),
    err);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = input.value.trim();
    if (code.replace(/[^0-9A-Z]/gi, '').length < 12) {
      err.textContent = '请输入完整的 12 位密钥（字母和数字，横线可省略）。';
      input.focus();
      return;
    }
    setBusy(btn, true, '解锁中…');
    try {
      const d = await api('/api/redeem', { method: 'POST', body: { code } });
      toast('解锁成功，可以开始阅读了');
      onSuccess?.(d?.session || null);
    } catch (ex) {
      err.textContent = friendlyError(ex, 'key');
      input.focus();
    } finally {
      setBusy(btn, false);
    }
  });
  if (autofocus) queueMicrotask(() => input.focus());
  return form;
}

export function loginForm({ onSuccess, autofocus = false } = {}) {
  const uId = nextId('user'), pId = nextId('pw');
  const user = h('input', { class: 'input', id: uId, name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', placeholder: '作者为你开通的用户名' });
  const pw = h('input', { class: 'input', id: pId, name: 'password', type: 'password', autocomplete: 'current-password', placeholder: '密码' });
  const toggle = h('button', { type: 'button', class: 'pw-toggle', 'aria-label': '显示密码', 'aria-pressed': 'false' }, icon('eye', 18));
  toggle.addEventListener('click', () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const btn = h('button', { class: 'btn primary block', type: 'submit' }, '登录');
  const form = h('form', { class: 'auth-form login-form', novalidate: true },
    h('label', { for: uId, class: 'field-label' }, '用户名'), user,
    h('label', { for: pId, class: 'field-label' }, '密码'), h('div', { class: 'pw-wrap' }, pw, toggle),
    err, btn);
  for (const el of [user, pw]) el.addEventListener('input', () => { err.textContent = ''; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = user.value.trim().toLowerCase();
    const password = pw.value;
    if (!username || !password) { err.textContent = '请填写用户名和密码。'; (username ? pw : user).focus(); return; }
    setBusy(btn, true, '登录中…');
    try {
      const d = await api('/api/login', { method: 'POST', body: { username, password } });
      onSuccess?.(d?.session || null);
    } catch (ex) {
      err.textContent = friendlyError(ex, 'login');
      pw.select();
    } finally {
      setBusy(btn, false);
    }
  });
  if (autofocus) queueMicrotask(() => user.focus());
  return form;
}

/** Tabbed "密钥 / 陪跑学员" unlock box. */
export function unlockTabs({ onSuccess, initial = 'key' } = {}) {
  const panes = {
    key: h('div', { class: 'tab-pane' },
      keyForm({ onSuccess }),
      h('p', { class: 'hint' }, '密钥由作者在你购买后发送，自生成起 30 分钟内有效。有效期内可在线阅读并下载 PDF，到期后资料自动重新锁定。')),
    student: h('div', { class: 'tab-pane' },
      loginForm({ onSuccess }),
      h('p', { class: 'hint' }, '账号由作者为全程陪跑学员开通，可在线查看全部资料（不提供下载）。忘记密码请联系作者重置。')),
  };
  const tabs = {};
  const bar = h('div', { class: 'seg', role: 'tablist' });
  const wrap = h('div', { class: 'unlock-tabs' }, bar);
  for (const [k, label, ic] of [['key', '我有密钥', 'key'], ['student', '陪跑学员登录', 'user']]) {
    const t = h('button', { type: 'button', role: 'tab', class: 'seg-btn', 'aria-selected': 'false' }, icon(ic, 16), label);
    t.addEventListener('click', () => select(k));
    tabs[k] = t;
    bar.append(t);
    wrap.append(panes[k]);
  }
  function select(k) {
    for (const key of Object.keys(tabs)) {
      tabs[key].setAttribute('aria-selected', String(key === k));
      panes[key].hidden = key !== k;
    }
  }
  select(initial);
  return wrap;
}
