// /login/ — student login; on success go to /library/ (or a safe same-site ?next=).
import { h, toast, qs } from '../shared/ui.js';
import { icon } from '../site/lib/icons.js';
import { loginForm } from '../site/lib/auth-forms.js';
import { loadSession, isStudent, isKey, remaining, logout, fmtDateTime } from '../site/lib/session.js';
import { put } from '../site/lib/dom.js';

const app = document.getElementById('app');

function nextUrl() {
  const n = qs('next') || '';
  // Only same-site paths; never protocol-relative or absolute URLs
  return /^\/(?!\/)[^\\\s]*$/.test(n) && !n.startsWith('/login') ? n : '/library/';
}

async function init() {
  const s = await loadSession();
  render(s);
}

function render(s) {
  const head = h('div', { class: 'login-head' },
    h('span', { class: 'login-icon' }, icon('user', 26)),
    h('h1', {}, '陪跑学员登录'),
    h('p', {}, '使用作者为你开通的账号登录，可在线查看全部学员资料。'));

  if (isStudent(s) && remaining(s) > 0) {
    const out = h('button', { class: 'btn block', type: 'button' }, icon('logout', 16), '退出登录');
    out.addEventListener('click', async () => { out.disabled = true; await logout(); toast('已退出登录'); render(null); });
    put(app, h('section', { class: 'login-card card' }, head,
      h('div', { class: 'notice green' }, icon('check', 18),
        h('span', {}, `你已登录为「${s.displayName || s.username || '陪跑学员'}」，本次登录有效至 ${fmtDateTime(s.expiresAt)}。`)),
      h('a', { class: 'btn primary block', href: nextUrl(), style: { marginTop: '16px' } }, icon('book', 16), '进入资料库'),
      h('div', { style: { marginTop: '10px' } }, out)));
    return;
  }

  const form = loginForm({
    autofocus: !matchMedia('(pointer:coarse)').matches,
    onSuccess: () => {
      toast('登录成功，正在进入资料库…');
      location.href = nextUrl();
    },
  });
  put(app, 
    h('section', { class: 'login-card card' }, head,
      isKey(s) && remaining(s) > 0 ? h('div', { class: 'notice', style: { marginBottom: '16px' } }, icon('info', 18),
        h('span', {}, '你当前正在用密钥阅读。登录学员账号后，密钥的阅读状态会被替换。')) : null,
      form,
      h('ul', { class: 'login-tips' },
        h('li', {}, '账号由作者为全程陪跑学员开通，用户名为小写字母、数字或下划线。'),
        h('li', {}, '学员账号仅支持在线查看，不提供下载。'),
        h('li', {}, '忘记密码或账号到期，请联系作者重置或续期。'))),
    h('p', { class: 'login-alt' }, '购买了单份资料？', h('a', { href: '/library/#unlock' }, '去资料库输入密钥解锁 ›')));
}

init();
