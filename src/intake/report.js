// 学员信息采集 · 打印报告视图（导出 PDF 用）
// 与 Word 导出共用 buildReport() 模型，版式一一对应：标题 → 信息卡 → 档案概览 → 各模块两列表格。
// 用浏览器「打印 → 另存为 PDF」生成文件，页眉 / 页码由 app.entry.css 中的 @page 规则提供。
import { h } from '../shared/ui.js';

const stateClass = (state) => (state === 'empty' ? 'is-empty' : state === 'pending' ? 'is-pending' : '');

/** 多行文本：按换行拆分，保留空行 */
const lines = (text) => String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => h('span', { class: 'rp-line' }, l || ' '));

function infoCard(r) {
  const byLabel = Object.fromEntries(r.info.map((i) => [i.label, i]));
  const td = (label, span) => h('td', { class: stateClass(byLabel[label].state), colspan: span }, byLabel[label].value);
  const pairRow = (a, b) => h('tr', {}, h('th', { scope: 'row' }, a), td(a), h('th', { scope: 'row' }, b), td(b));
  return h('table', { class: 'rp-info' },
    h('colgroup', {}, h('col', { class: 'rp-info-l' }), h('col'), h('col', { class: 'rp-info-l' }), h('col')),
    h('tbody', {},
      pairRow('称呼', '学校'),
      pairRow('学院', '专业'),
      pairRow('年级', '填表日期'),
      h('tr', {}, h('th', { scope: 'row' }, '最后更新'), td('最后更新', 3)),
    ),
  );
}

function overview(r) {
  const o = r.overview;
  const stat = (num, unit, label, tone) =>
    h('div', { class: `rp-stat ${tone}` }, h('strong', {}, String(num), h('small', {}, unit)), h('span', {}, label));
  const MAX = 12;
  const pendingText = o.pendingItems.slice(0, MAX).join('；') + (o.pendingItems.length > MAX ? `；等共 ${o.pendingItems.length} 项` : '');
  return h('section', { class: 'rp-overview', 'aria-label': '档案概览' },
    h('div', { class: 'rp-ov-head' }, h('strong', {}, '档案概览'), h('span', {}, '关键信息一览')),
    h('div', { class: 'rp-stats' },
      stat(o.percent, '%', '必填项完成度', o.percent >= 100 ? 'tone-green' : ''),
      stat(o.pendingCount, '项', '待确认信息', o.pendingCount ? 'tone-amber' : ''),
      stat(o.errorCount, '项', '需补充或修正', o.errorCount ? 'tone-red' : 'tone-green'),
    ),
    h('div', { class: 'rp-metrics' },
      o.metrics.map((m) => h('div', { class: `rp-metric ${stateClass(m.state)}` }, h('span', {}, m.label), h('strong', {}, m.value))),
    ),
    o.pendingCount ? h('p', { class: 'rp-pending' }, h('strong', {}, '待确认清单'), pendingText) : null,
  );
}

function groupTable(group) {
  return h('table', { class: 'rp-table' },
    h('colgroup', {}, h('col', { class: 'rp-col-label' }), h('col')),
    group.title ? h('thead', {}, h('tr', {}, h('th', { colspan: 2, class: 'rp-group' }, group.title))) : null,
    h('tbody', {},
      group.rows.map((row) =>
        h('tr', { class: row.value.length > 600 ? 'rp-long' : null },
          h('th', { scope: 'row' }, row.label),
          h('td', { class: stateClass(row.state) }, row.multiline ? lines(row.value) : row.value),
        ),
      ),
    ),
  );
}

function section(s) {
  return h('section', { class: 'rp-section' },
    h('div', { class: 'rp-section-head' },
      h('h2', {}, h('span', { class: 'rp-no' }, s.no), s.title),
      h('p', {}, s.description),
    ),
    s.empty ? h('p', { class: `rp-empty ${stateClass(s.emptyState)}` }, s.empty) : null,
    s.groups.map(groupTable),
  );
}

/** 生成报告 DOM（<article class="report">） */
export function renderReport(r, { now = new Date() } = {}) {
  const stamp = now.toLocaleString('zh-CN', { hour12: false });
  return h('article', { class: 'report', 'aria-label': r.title },
    h('header', { class: 'rp-title' }, h('div', { class: 'rp-brand' }, r.brand), h('h1', {}, r.heading)),
    infoCard(r),
    h('p', { class: 'rp-notice' }, r.notice),
    overview(r),
    h('p', { class: 'rp-legend' },
      '图例：', h('mark', {}, '待确认'), ' 琥珀色底纹表示内容含「待确认」，沟通时可优先核实；',
      h('em', {}, '未填写'), ' 灰色斜体表示学员暂未填写。',
    ),
    r.sections.map(section),
    h('p', { class: 'rp-end' }, `— 档案结束 · 由学员在本机生成于 ${stamp} —`),
  );
}
