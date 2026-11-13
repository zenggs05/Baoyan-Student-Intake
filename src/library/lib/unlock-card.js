// Unlock / status card shown at the top of /library/ (and reused by the reader's lock screen).
import { h, toast, fmtCountdown } from '../../shared/ui.js';
import { icon } from '../../site/lib/icons.js';
import { unlockTabs } from '../../site/lib/auth-forms.js';
import { remaining, isKey, isStudent, logout, fmtDateTime } from '../../site/lib/session.js';
import { shortTitle } from '../../site/lib/catalog.js';
import { BUY_CHANNEL } from '../../site/lib/contact.js';

/** Element whose text is refreshed by startTicker(). */
export function countdownEl(cls = 'cd-big') {
  return h('span', { class: cls, 'data-cd': '' }, '--:--');
}

/** Refresh every [data-cd] once a second; calls onExpire() once when the key session runs out. */
export function startTicker(getSession, onExpire, onTick) {
  let fired = false;
  const tick = () => {
    const s = getSession();
    if (!s || !isKey(s)) return;
    const ms = remaining(s);
    for (const el of document.querySelectorAll('[data-cd]')) {
      el.textContent = fmtCountdown(ms);
      el.classList.toggle('warn', ms < 5 * 60 * 1000);
    }
    onTick?.(ms);
    if (ms <= 0 && !fired) { fired = true; onExpire?.(); }
    if (ms > 0) fired = false;
  };
  tick();
  return setInterval(tick, 1000);
}

function productNames(session, catalog) {
  const ids = (session.products || []).filter((id) => catalog?.get(id));
  // P3 items included by P4 are summarised as one chip
  const p3 = ids.filter((id) => id.startsWith('P3-'));
  const others = ids.filter((id) => !id.startsWith('P3-'));
  const names = others.map((id) => catalog.get(id).title);
  if (p3.length > 1) names.push(`单校面经复盘 ${p3.length} 份`);
  else if (p3.length === 1) names.push(`单校复盘·${shortTitle(catalog.get(p3[0]))}`);
  return names;
}

export function unlockCard({ session, catalog, onChange, notice = '' }) {
  if (session && (isKey(session) || isStudent(session)) && remaining(session) > 0) {
    const student = isStudent(session);
    const names = productNames(session, catalog);
    const out = h('button', { class: 'btn small', type: 'button' }, icon('logout', 16), '退出');
    out.addEventListener('click', async () => {
      out.disabled = true;
      await logout();
      toast(student ? '已退出登录' : '已退出，资料已重新锁定');
      onChange?.(null);
    });
    return h('section', { class: `unlock card on${student ? ' student' : ''}`, id: 'unlock', 'aria-label': '解锁状态' },
      h('div', {},
        h('h2', {}, icon(student ? 'user' : 'unlock', 20), student ? `欢迎回来，${session.displayName || session.username || '同学'}` : '已解锁，可以开始阅读了'),
        h('p', { class: 'muted small' }, student
          ? '陪跑学员账号：可在线查看下列资料，不提供下载。'
          : '有效期内可在线阅读并下载 PDF；到期后资料会自动重新锁定，建议尽快下载保存。'),
        names.length ? h('div', { class: 'unlock-chips' }, names.map((n) => h('span', { class: 'chip' }, icon('check', 14), n))) : null),
      h('div', { class: 'unlock-side' },
        student
          ? h('div', { class: 'cd-box' }, h('small', {}, '本次登录有效至'), h('span', { class: 'cd-until' }, fmtDateTime(session.expiresAt)))
          : h('div', { class: 'cd-box' }, h('small', {}, '剩余阅读时间'), countdownEl()),
        out));
  }
  if (session?.type === 'admin') {
    const out = h('button', { class: 'btn small', type: 'button' }, icon('logout', 16), '退出');
    out.addEventListener('click', async () => { out.disabled = true; await logout(); toast('已退出管理员身份'); onChange?.(null); });
    const canPreview = (session.products || []).length > 0;
    return h('section', { class: 'unlock card on student', id: 'unlock' },
      h('div', {},
        h('h2', {}, icon('shield', 20), '当前是管理员身份'),
        h('p', { class: 'muted small' }, canPreview
          ? '可以在线预览全部资料，用来检查排版。如需体验买家流程（含下载 PDF），请在后台给自己发一个测试密钥。'
          : '需要预览资料时，请在后台给自己发一个测试密钥。')),
      h('div', { class: 'unlock-side' }, h('a', { class: 'btn primary small', href: '/admin/' }, '进入管理后台'), out));
  }
  return h('section', { class: 'unlock card', id: 'unlock', 'aria-labelledby': 'unlock-title' },
    h('div', { class: 'unlock-intro' },
      notice ? h('div', { class: 'notice amber unlock-notice', role: 'status' }, icon('info', 18), h('span', {}, notice)) : null,
      h('h2', { id: 'unlock-title' }, icon('lock', 20), '解锁资料'),
      h('p', {}, '目录和试读公开可看。购买后输入作者发给你的密钥，就能在线阅读全文。'),
      h('ol', { class: 'unlock-steps' },
        h('li', {}, h('b', {}, '1'), h('span', {}, '先看目录和试读，确认资料适合自己')),
        h('li', {}, h('b', {}, '2'), h('span', {}, '在公众号后台留言购买，付款后会收到 12 位阅读密钥')),
        h('li', {}, h('b', {}, '3'), h('span', {}, '30 分钟内输入密钥，在线阅读并下载 PDF'))),
      h('p', { class: 'unlock-buy' }, '如何购买：', BUY_CHANNEL, '，说明想要的资料即可。')),
    unlockTabs({ onSuccess: (s) => onChange?.(s, true) }));
}
