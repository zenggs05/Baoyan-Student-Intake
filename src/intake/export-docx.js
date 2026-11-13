// 学员信息采集 · Word 导出（docx@9）
// 本模块由 app.entry.js 通过 import() 按需加载，docx 库不会进入首屏脚本。
// 版式见 docs/ARCHITECTURE.md §7：A4、页边距 2cm、微软雅黑；页眉右对齐灰色小字；页脚「第 X 页 / 共 Y 页」。
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  LineRuleType,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from 'docx';
import { buildReport } from './model.js';

/* ---------- 版式常量（单位：twip，1cm ≈ 567） ---------- */
const PAGE_W = 11906; // A4
const PAGE_H = 16838;
const MARGIN = 1134; // 2cm
const CONTENT_W = PAGE_W - MARGIN * 2; // 9638
const LABEL_W = Math.round(CONTENT_W * 0.28); // 左列约 28%
const VALUE_W = CONTENT_W - LABEL_W;

const FONT_NAME = 'Microsoft YaHei';
const FONT = { ascii: FONT_NAME, eastAsia: FONT_NAME, hAnsi: FONT_NAME, cs: FONT_NAME };

const C = {
  navy: '172946',
  blue: '315EAA',
  text: '1F2D44',
  label: '4F5F76',
  muted: '718097',
  faint: '9AA5B5',
  empty: 'A3ADBC',
  border: 'E4E9F1',
  labelBg: 'F2F5FA',
  groupBg: 'EAF1FB',
  panelBg: 'F7F9FC',
  amberBg: 'FFF4DB',
  amber: '8A5A12',
  amberStrong: 'B07A1F',
  green: '3F7A5A',
  red: 'A24A48',
  white: 'FFFFFF',
};

/* ---------- 基础构件 ---------- */
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const SURROGATES = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g;

/**
 * 去掉 XML 不允许的字符：控制字符（校验已拦截，这里兜底）和孤立的代理项（导入的 JSON 里可能出现残缺 emoji），
 * 否则 Word 会提示文件损坏。不用正则后行断言，兼容较老的 Safari。
 */
function xmlSafe(text) {
  const s = String(text).replace(XML_INVALID, '');
  if (typeof s.toWellFormed === 'function') return s.toWellFormed();
  return s.replace(SURROGATES, (m) => (m.length === 2 ? m : '\uFFFD'));
}

const run = (text, o = {}) =>
  new TextRun({
    text: xmlSafe(text),
    font: FONT,
    size: o.size ?? 20,
    color: o.color ?? C.text,
    bold: o.bold,
    italics: o.italics,
    characterSpacing: o.spacing,
    shading: o.shade ? { type: ShadingType.CLEAR, color: 'auto', fill: o.shade } : undefined,
  });

const para = (children, o = {}) =>
  new Paragraph({
    children: Array.isArray(children) ? children : [children],
    alignment: o.align,
    spacing: { before: o.before ?? 0, after: o.after ?? 0, line: o.line ?? 288, lineRule: o.lineRule ?? LineRuleType.AUTO },
    keepNext: o.keepNext,
    keepLines: o.keepLines,
    border: o.border,
    shading: o.shading,
    indent: o.indent,
    run: o.markSize ? { size: o.markSize } : undefined,
  });

const line = (style = BorderStyle.SINGLE, size = 4, color = C.border) => ({ style, size, color });
const allBorders = (b) => ({ top: b, bottom: b, left: b, right: b, insideHorizontal: b, insideVertical: b });
const cellBorders = (b) => ({ top: b, bottom: b, left: b, right: b });
const fill = (color) => ({ type: ShadingType.CLEAR, color: 'auto', fill: color });

/** 一小段垂直留白（独立段落，不受左边框影响） */
const gap = (after = 120, extra = {}) => para([], { after, line: 120, lineRule: LineRuleType.EXACT, markSize: 4, ...extra });

/** 把多行文本拆成多个段落，保留换行 */
function textParagraphs(text, runOpts, paraOpts = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  return lines.map((l) => para(run(l.replace(/\t/g, '    ') || ' ', runOpts), paraOpts));
}

function cell(children, o = {}) {
  return new TableCell({
    children,
    width: { size: o.width, type: WidthType.DXA },
    columnSpan: o.span,
    shading: o.fill ? fill(o.fill) : undefined,
    verticalAlign: o.valign ?? VerticalAlign.TOP,
    margins: o.margins ?? { top: 72, bottom: 72, left: 150, right: 150 },
    borders: o.borders,
  });
}

function table(rows, columnWidths, o = {}) {
  return new Table({
    rows,
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths,
    layout: TableLayoutType.FIXED,
    borders: o.borders ?? allBorders(line()),
  });
}

/* ---------- 文档开头：标题 + 信息卡 ---------- */
function titleBlock(r) {
  return [
    para(run(r.brand, { size: 19, color: C.blue, bold: true, spacing: 30 }), { after: 40 }),
    para(run(r.heading, { size: 44, color: C.navy, bold: true }), {
      after: 240,
      line: 320,
      border: { bottom: { style: BorderStyle.SINGLE, size: 18, color: C.navy, space: 6 } },
    }),
  ];
}

function valueRun(item, size = 20) {
  if (item.state === 'empty') return run(item.value, { size, color: C.empty, italics: true });
  if (item.state === 'pending') return run(item.value, { size, color: C.amber, bold: true });
  return run(item.value, { size, color: C.text, bold: true });
}

function infoCard(r) {
  const LW = 1250;
  const VW = (CONTENT_W - LW * 2) / 2;
  const pad = { top: 90, bottom: 90, left: 150, right: 150 };
  const label = (t) => cell([para(run(t, { size: 18, color: C.muted }))], { width: LW, fill: C.labelBg, valign: VerticalAlign.CENTER, margins: pad });
  const value = (item, span, width) =>
    cell([para(valueRun(item))], { width, span, fill: item.state === 'pending' ? C.amberBg : undefined, valign: VerticalAlign.CENTER, margins: pad });
  const byLabel = Object.fromEntries(r.info.map((i) => [i.label, i]));
  const pairRow = (a, b) =>
    new TableRow({ cantSplit: true, children: [label(a), value(byLabel[a], undefined, VW), label(b), value(byLabel[b], undefined, VW)] });
  return [
    table(
      [
        pairRow('称呼', '学校'),
        pairRow('学院', '专业'),
        pairRow('年级', '填表日期'),
        new TableRow({ cantSplit: true, children: [label('最后更新'), value(byLabel['最后更新'], 3, CONTENT_W - LW)] }),
      ],
      [LW, VW, LW, VW],
    ),
    para(run(r.notice, { size: 16, color: C.faint }), { before: 100, after: 280, line: 276 }),
  ];
}

/* ---------- 档案概览 ---------- */
function overviewBox(r) {
  const o = r.overview;
  const W3 = [3213, 3213, CONTENT_W - 3213 * 2];
  const outer = line(BorderStyle.SINGLE, 6, 'D5DEEA');
  const inner = line(BorderStyle.SINGLE, 4, C.border);
  const statColor = {
    percent: o.percent >= 100 ? C.green : C.navy,
    pending: o.pendingCount ? C.amberStrong : C.navy,
    errors: o.errorCount ? C.red : C.green,
  };
  const stat = (num, unit, label, color, width) =>
    cell(
      [
        para([run(String(num), { size: 40, bold: true, color }), run(unit ? ` ${unit}` : '', { size: 18, color })], { align: AlignmentType.CENTER, line: 300 }),
        para(run(label, { size: 17, color: C.muted }), { align: AlignmentType.CENTER, before: 20 }),
      ],
      { width, valign: VerticalAlign.CENTER, margins: { top: 150, bottom: 140, left: 120, right: 120 }, borders: cellBorders(inner) },
    );
  const metric = (m, width) =>
    cell(
      [
        para(run(m.label, { size: 16, color: C.muted }), { after: 30 }),
        para(valueRun(m, 20), { line: 276 }),
      ],
      { width, fill: m.state === 'pending' ? C.amberBg : C.panelBg, margins: { top: 110, bottom: 110, left: 170, right: 140 }, borders: cellBorders(inner) },
    );
  const pendingRow = (items) => {
    const MAX = 12;
    const shown = items.slice(0, MAX).join('；') + (items.length > MAX ? `；等共 ${items.length} 项` : '');
    return new TableRow({
      cantSplit: true,
      children: [
        cell([para([run('待确认清单　', { size: 17, bold: true, color: C.amber }), run(shown, { size: 17, color: C.label })], { line: 300 })], {
          width: CONTENT_W, span: 3, fill: 'FFFAEE', margins: { top: 110, bottom: 110, left: 170, right: 170 }, borders: cellBorders(inner),
        }),
      ],
    });
  };
  const ms = o.metrics;
  return [
    table(
      [
        new TableRow({
          cantSplit: true,
          keepNext: true,
          children: [
            cell([para([run('档案概览', { size: 21, bold: true, color: C.white }), run('　关键信息一览', { size: 16, color: 'B8C6DA' })])], {
              width: CONTENT_W, span: 3, fill: C.navy, margins: { top: 100, bottom: 100, left: 170, right: 170 }, valign: VerticalAlign.CENTER,
            }),
          ],
        }),
        new TableRow({
          cantSplit: true,
          keepNext: true,
          children: [
            stat(o.percent, '%', '必填项完成度', statColor.percent, W3[0]),
            stat(o.pendingCount, '项', '待确认信息', statColor.pending, W3[1]),
            stat(o.errorCount, '项', '需补充或修正', statColor.errors, W3[2]),
          ],
        }),
        new TableRow({ cantSplit: true, keepNext: true, children: [metric(ms[0], W3[0]), metric(ms[1], W3[1]), metric(ms[2], W3[2])] }),
        new TableRow({ cantSplit: true, keepNext: o.pendingCount > 0, children: [metric(ms[3], W3[0]), metric(ms[4], W3[1]), metric(ms[5], W3[2])] }),
        ...(o.pendingCount ? [pendingRow(o.pendingItems)] : []),
      ],
      W3,
      { borders: { top: outer, bottom: outer, left: outer, right: outer, insideHorizontal: inner, insideVertical: inner } },
    ),
    para(
      [
        run('图例：', { size: 16, color: C.faint }),
        run(' 待确认 ', { size: 16, color: C.amber, shade: C.amberBg }),
        run(' 琥珀色底纹表示内容含「待确认」，沟通时可优先核实；', { size: 16, color: C.faint }),
        run('未填写', { size: 16, color: C.empty, italics: true }),
        run(' 灰色斜体表示学员暂未填写。', { size: 16, color: C.faint }),
      ],
      { before: 100, after: 60, line: 276 },
    ),
  ];
}

/* ---------- 模块 ---------- */
function sectionHeading(s) {
  return [
    // 用独立的留白段落代替段前距：Word 的左边框会把段前距也画进去
    gap(0, { line: 380, keepNext: true }),
    para([run(s.no, { size: 22, bold: true, color: C.blue }), run('  '), run(s.title, { size: 26, bold: true, color: C.navy })], {
      after: 50,
      keepNext: true,
      keepLines: true,
      line: 300,
      // 左侧色条与页边距（表格左缘）对齐，标题文字在色条右侧
      border: { left: { style: BorderStyle.SINGLE, size: 30, color: C.navy, space: 7 } },
      indent: { left: 215 },
    }),
    para(run(s.description, { size: 17, color: C.muted }), { after: 140, keepNext: true, keepLines: true, indent: { left: 215 }, line: 276 }),
  ];
}

function rowFor(item) {
  const isEmpty = item.state === 'empty';
  const isPending = item.state === 'pending';
  const valueOpts = isEmpty
    ? { size: 19, color: C.empty, italics: true }
    : isPending
      ? { size: 20, color: C.amber }
      : { size: 20, color: C.text };
  return new TableRow({
    cantSplit: item.value.length < 700,
    children: [
      cell([para(run(item.label, { size: 18, color: C.label }), { line: 276 })], { width: LABEL_W, fill: C.labelBg }),
      cell(textParagraphs(item.value, valueOpts, { line: 288 }), { width: VALUE_W, fill: isPending ? C.amberBg : undefined }),
    ],
  });
}

function groupTable(group) {
  const rows = [];
  if (group.title) {
    rows.push(
      new TableRow({
        tableHeader: true, // 条目跨页时在新页顶部重复标题
        cantSplit: true,
        keepNext: true,
        children: [
          cell([para(run(group.title, { size: 20, bold: true, color: C.navy }))], {
            width: CONTENT_W, span: 2, fill: C.groupBg, margins: { top: 90, bottom: 90, left: 150, right: 150 },
          }),
        ],
      }),
    );
  }
  rows.push(...group.rows.map(rowFor));
  return table(rows, [LABEL_W, VALUE_W]);
}

function emptyNote(s) {
  const pending = s.emptyState === 'pending';
  return table(
    [
      new TableRow({
        cantSplit: true,
        children: [
          cell([para(run(s.empty, { size: 19, color: pending ? C.amber : C.muted, italics: !pending, bold: pending }))], {
            width: CONTENT_W, fill: pending ? C.amberBg : C.panelBg, margins: { top: 130, bottom: 130, left: 170, right: 170 },
          }),
        ],
      }),
    ],
    [CONTENT_W],
    { borders: allBorders(line(BorderStyle.DASHED, 4, 'CFD9E6')) },
  );
}

function sectionBlock(s) {
  const out = sectionHeading(s);
  if (s.empty) out.push(emptyNote(s));
  s.groups.forEach((g, i) => {
    if (i > 0) out.push(gap(160));
    out.push(groupTable(g));
  });
  return out;
}

/* ---------- 组装 ---------- */
/** 生成 docx Document 对象（Node 测试也直接调用） */
export function buildDocx(form, { now = new Date() } = {}) {
  const r = buildReport(form);
  const stamp = now.toLocaleString('zh-CN', { hour12: false });
  const children = [
    ...titleBlock(r),
    ...infoCard(r),
    ...overviewBox(r),
    ...r.sections.flatMap(sectionBlock),
    para(run(`— 档案结束 · 由学员在本机生成于 ${stamp} —`, { size: 16, color: C.faint }), { align: AlignmentType.CENTER, before: 480 }),
  ];

  return new Document({
    creator: '保研全程陪跑',
    title: r.title,
    description: '学员基本信息档案',
    styles: {
      default: {
        document: {
          // 西文语言设为 en-US：若设为 zh-CN，Word 会把英文单词当作中文逐字断行
          run: { font: FONT, size: 20, color: C.text, language: { value: 'en-US', eastAsia: 'zh-CN' } },
          paragraph: { spacing: { line: 288 } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_W, height: PAGE_H },
            margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 560, footer: 560 },
          },
        },
        headers: {
          default: new Header({
            children: [
              para(run(r.header, { size: 16, color: C.faint }), {
                align: AlignmentType.RIGHT,
                border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: C.border, space: 4 } },
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ font: FONT, size: 16, color: C.faint, children: ['第 ', PageNumber.CURRENT, ' 页 / 共 ', PageNumber.TOTAL_PAGES, ' 页'] }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });
}

/** 浏览器端：生成 Word 文件 Blob */
export async function exportDocx(form) {
  return Packer.toBlob(buildDocx(form));
}

export { Packer };
