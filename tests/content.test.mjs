// 内容管线单元测试：node --test tests/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripMetaLine, parseMeta, stripComments, cleanSource, findPlaceholders, findInternalTerms,
  countWords, trimBeforeSecondH1, firstH1, splitFences,
} from '../scripts/lib-content/clean.mjs';
import { renderMarkdown } from '../scripts/lib-content/render.mjs';
import { p3Slug, publicSlug, plainDocId, docOrder, extractSellingPoint, autoSlug } from '../scripts/lib-content/catalog.mjs';
import { checkValueSize, splitBatches, MAX_VALUE_BYTES } from '../scripts/upload-content.mjs';
import { checkPublicLeaks, htmlSentences } from '../scripts/lib-content/leak-gate.mjs';
import * as cfg from '../scripts/catalog.config.mjs';

const BOM = String.fromCharCode(0xfeff);
const DISC = cfg.DISCLAIMER_PREFIX;
const DISC_TEXT = `${DISC}、已获授权的往年整理资料和公开信息整理而成，不是官方题库、内部信息或保密试题。`;
const render = (src, opts = {}) => renderMarkdown(src, { disclaimerPrefix: DISC, ...opts });

describe('规则 1：元信息行', () => {
  const META = '产品：P1 第3章 作者时间线复盘 ｜ 版本 v0.1 ｜ 状态：待作者补充 ｜ 字数：1037（正文中文字符） ｜ 来源构成：self 10% / generic 90%';

  test('删除第一行「产品：」并保留行号（换成空行）', () => {
    const { text, meta } = stripMetaLine(`${META}\n\n# 标题\n正文`);
    assert.equal(text, '\n\n# 标题\n正文');
    assert.equal(text.split('\n').length, 4);
    assert.equal(meta.version, 'v0.1');
    assert.equal(meta.status, '待作者补充');
    assert.equal(meta.words, 1037);
  });

  test('带 BOM、CRLF 也能识别', () => {
    const { text, meta } = stripMetaLine(`${BOM}${META}\r\n# 标题\r\n`);
    assert.ok(meta);
    assert.equal(text, '\n# 标题\n');
  });

  test('第一行不是元信息时不动；正文中间的「产品：」不删', () => {
    const src = '# 理工科面试题库目录\n\n产品：这里是正文\n';
    const { text, meta } = stripMetaLine(src);
    assert.equal(meta, null);
    assert.equal(text, src);
  });

  test('parseMeta 解析题数、来源构成；全角冒号和半角竖线都可', () => {
    const m = parseMeta('产品：P4 合集 | 版本 v0.2 | 状态: 待审校 | 题数：435 | 来源构成：public 100%');
    assert.equal(m.product, 'P4 合集');
    assert.equal(m.version, 'v0.2');
    assert.equal(m.status, '待审校');
    assert.equal(m.questions, 435);
    assert.equal(m.sources, 'public 100%');
  });
});

describe('规则 2：HTML 注释', () => {
  test('单行与多行注释都删除，行数不变，记录位置', () => {
    const src = 'a\n<!-- 公开面经补充 BEGIN（2026-11-12，待核对） -->\n## 5b 标题\n<!--\n多行\n-->\nb';
    const { text, removed } = stripComments(src);
    assert.ok(!text.includes('<!--'));
    assert.ok(!text.includes('BEGIN'));
    assert.equal(text.split('\n').length, src.split('\n').length);
    assert.deepEqual(removed.map((r) => r.line), [2, 4]);
    assert.match(render(text).html, /<h2 id="sec-1">5b 标题<\/h2>/);
  });

  test('代码块里的注释保持原样', () => {
    const src = '```html\n<!-- keep -->\n```\n<!-- drop -->\n';
    const { text } = stripComments(src);
    assert.ok(text.includes('<!-- keep -->'));
    assert.ok(!text.includes('drop'));
  });

  test('splitFences 拼回去等于原文', () => {
    const src = 'x\n```\ncode\n```\ny\n~~~\nz';
    assert.equal(splitFences(src).map((p) => p.text).join(''), src);
  });
});

describe('规则 3：占位符', () => {
  test('{{待作者确认:xxx}} → <span class="todo" title="xxx">待补充</span>', () => {
    const r = render('|节点|结果|\n|---|---|\n|东南|{{待作者确认:月份与结果}}|\n');
    assert.match(r.html, /<td><span class="todo" title="月份与结果">待补充<\/span><\/td>/);
    assert.deepEqual(r.todos.map((t) => t.text), ['月份与结果']);
  });

  test('全角冒号也识别；title 里的特殊字符被转义', () => {
    const r = render('月份：{{待作者确认：年"月<b>}}。');
    assert.match(r.html, /<span class="todo" title="年&quot;月&lt;b&gt;">待补充<\/span>/);
    assert.ok(!r.html.includes('<b>'));
  });

  test('其他 {{xxx}} 渲染为模板填写位 [xxx]', () => {
    const r = render('主题：{{申请类别}}—{{一级方向}}');
    assert.match(r.html, /<span class="slot">\[申请类别\]<\/span>—<span class="slot">\[一级方向\]<\/span>/);
    assert.equal(r.slots.length, 2);
    assert.equal(r.todos.length, 0);
  });

  test('代码里的 {{…}} 不处理', () => {
    const r = render('```\n{{待作者确认:x}}\n```\n\n`{{y}}`');
    assert.ok(!r.html.includes('class="todo"'));
    assert.ok(!r.html.includes('class="slot"'));
    assert.match(r.html, /\{\{待作者确认:x\}\}/);
  });

  test('findPlaceholders 给出源文件行号与类型', () => {
    const src = '\n# t\n月份：{{待作者确认:年月}}，{{学校与专业}}\n```\n{{不算}}\n```\n';
    assert.deepEqual(findPlaceholders(src), [
      { line: 3, kind: 'todo', text: '年月' },
      { line: 3, kind: 'slot', text: '学校与专业' },
    ]);
  });
});

describe('规则 4：免责声明', () => {
  test('以固定句开头的段落改成 <aside class="disclaimer">', () => {
    const r = render(`正文。\n\n${DISC_TEXT}\n`);
    assert.match(r.html, /<aside class="disclaimer">本资料由作者本人及合作同学的亲历回忆/);
    assert.match(r.html, /<\/aside>\s*$/);
    assert.equal(r.disclaimers, 1);
  });

  test('段落中间提到这句话不算免责声明', () => {
    const r = render(`如上所述，${DISC_TEXT}`);
    assert.ok(!r.html.includes('<aside'));
  });

  test('同一篇里重复的免责声明只保留一段', () => {
    const r = render(`### 使用限制\n\n${DISC_TEXT}\n\n${DISC_TEXT}\n`);
    assert.equal((r.html.match(/<aside/g) || []).length, 1);
    assert.equal(r.dedupedDisclaimers, 1);
  });
});

describe('规则 5：标题 id、目录、表格', () => {
  test('第一个 h1 作为标题并从片段中去掉；h2/h3 加 id 并进目录', () => {
    const r = render('# 第1章 推免全流程\n\n## 时间线\n\n### 九月 {{待作者确认:日期}}\n\n#### 不进目录\n');
    assert.equal(r.title, '第1章 推免全流程');
    assert.ok(!r.html.includes('<h1'));
    assert.deepEqual(r.toc, [
      { id: 'sec-1', text: '时间线', level: 2 },
      { id: 'sec-2', text: '九月 待补充', level: 3 },
    ]);
    assert.match(r.html, /<h2 id="sec-1">时间线<\/h2>/);
    assert.match(r.html, /<h4>不进目录<\/h4>/);
  });

  test('stripTitle:false 时保留 h1；idPrefix 用于合并文档时避免重复', () => {
    const r = render('# T\n\n## A\n', { stripTitle: false, idPrefix: 'doc-P2-' });
    assert.match(r.html, /<h1 id="doc-P2-title">T<\/h1>/);
    assert.match(r.html, /<h2 id="doc-P2-sec-1">A<\/h2>/);
  });

  test('表格外包 <div class="table-wrap">，并记录行列数', () => {
    const r = render('\n|a|b|c|\n|---|---|---|\n|1|2|3|\n|4|5|6|\n');
    assert.match(r.html, /^<div class="table-wrap" data-cols="3">\n<table>/);
    assert.match(r.html, /<\/table>\n<\/div>\n$/);
    assert.deepEqual(r.tables, [{ line: 2, cols: 3, rows: 2, maxCell: 1 }]);
  });

  test('原始 HTML（如 <small>）保留；关闭模糊链接（run.py、x.md 不变成网址）', () => {
    const r = render('题目 <small>2024｜夏令营</small>\n\n运行 run.py 和 job.sh，见 P4_试读.md；官网 https://example.com/a');
    assert.match(r.html, /<small>2024｜夏令营<\/small>/);
    assert.ok(!/href="http:\/\/run\.py"/.test(r.html));
    assert.ok(!r.html.includes('href="http://job.sh"'));
    assert.match(r.html, /<a href="https:\/\/example\.com\/a" target="_blank" rel="noopener noreferrer">/);
  });
});

describe('站内链接改写', () => {
  const resolveLink = ({ file }) => (file === 'P1_01_推免全流程.md'
    ? { href: '/library/read.html?p=P1&d=P1_01', title: '第1章 推免全流程' }
    : null);

  test('能解析的 .md 链接改成站内地址', () => {
    const r = render('- [1. 推免全流程](P1_01_推免全流程.md)', { resolveLink });
    assert.match(r.html, /<a href="\/library\/read\.html\?p=P1&amp;d=P1_01">1\. 推免全流程<\/a>/);
  });

  test('链接文字就是文件名时换成文档标题；../ 和中文百分号编码都能处理', () => {
    const r = render('[P1_01_推免全流程.md](../P1_保研经验指南/P1_01_推免全流程.md)', { resolveLink });
    assert.match(r.html, />第1章 推免全流程<\/a>/);
  });

  test('找不到目标的链接去掉 <a>、保留文字，并记入 links', () => {
    const r = render('院校覆盖以[宣传院校覆盖表](宣传院校覆盖表.md)为准。', { resolveLink });
    assert.match(r.html, /<p>院校覆盖以宣传院校覆盖表为准。<\/p>/);
    assert.equal(r.links[0].resolved, false);
  });
});

describe('规则 6：内部用语检测', () => {
  test('检测出内部用语和行号，跳过免责声明里的「内部信息」', () => {
    const src = `\n# 标题\n本篇状态为待作者补充。\n${DISC_TEXT}\n来源链接见内部来源表。\n`;
    const hits = findInternalTerms(src, cfg.INTERNAL_TERMS, DISC);
    assert.deepEqual(hits.map((h) => [h.line, h.term]), [[3, '待作者补充'], [5, '内部来源表']]);
  });

  test('英文词按单词边界匹配', () => {
    const hits = findInternalTerms('Claude 写的\nClaudette\nsale_ready', ['Claude', 'sale_ready'], DISC);
    assert.deepEqual(hits.map((h) => h.line), [1, 3]);
  });

  test('只报告不修改：渲染结果仍包含原文', () => {
    assert.match(render('当前为待定稿服务介绍。').html, /待定稿/);
  });
});

describe('其他清洗工具', () => {
  test('cleanSource 组合规则 1、2', () => {
    const { text, meta, comments } = cleanSource('产品：P3 x ｜ 版本 v0.1\n# T\n<!-- c -->\n正文');
    assert.equal(meta.version, 'v0.1');
    assert.equal(comments.length, 1);
    assert.equal(text, '\n# T\n\n正文');
  });

  test('trimBeforeSecondH1 只保留开头总览', () => {
    const src = '\n# 公开面经汇编卷\n\n## 覆盖总览\n\n|a|\n|---|\n|1|\n\n# 北京大学\n\n## x\n';
    const out = trimBeforeSecondH1(src);
    assert.ok(out.includes('覆盖总览'));
    assert.ok(!out.includes('北京大学'));
    assert.equal(firstH1(out), '公开面经汇编卷');
  });

  test('countWords：中文字符 + 英文单词，不计代码块、免责声明和 URL', () => {
    const src = `中文字 two words\n\`\`\`\n不计 code\n\`\`\`\n${DISC_TEXT}\nhttps://example.com/abc`;
    assert.equal(countWords(src, DISC), 5);
  });
});

describe('docId 与 slug', () => {
  test('普通文件名 → docId', () => {
    assert.equal(plainDocId('P2_03_数字电路.md'), 'P2_03');
    assert.equal(plainDocId('P5_D1_原理与名词.md'), 'D1');
    assert.equal(plainDocId('P5_08_路线与进阶书单.md'), 'P5_08');
    assert.equal(plainDocId('T_MAIL_套磁写作SOP.md'), 'T_MAIL');
    assert.ok(/^[A-Za-z0-9_-]+$/.test(plainDocId('完全中文.md')));
  });

  test('排序序号：00 → D1…D7 → 08', () => {
    const files = ['P5_08_x.md', 'P5_D2_x.md', 'P5_00_x.md', 'P5_D1_x.md'];
    assert.deepEqual(files.sort((a, b) => docOrder(a) - docOrder(b)), ['P5_00_x.md', 'P5_D1_x.md', 'P5_D2_x.md', 'P5_08_x.md']);
  });

  test('P3 已有文件用固定 slug', () => {
    assert.deepEqual(p3Slug('P3_东南大学_集成电路学院.md'), { slug: 'seu-ic', rule: 'map' });
    assert.equal(p3Slug('P3_中科院物理所_物理方向.md').slug, 'iop');
    assert.equal(p3Slug('P3_中国科学院大学_物理学院.md').slug, 'ucas-phys');
  });

  test('P3 新文件自动拼 slug（南京大学）', () => {
    assert.deepEqual(p3Slug('P3_南京大学_电子学院.md'), { slug: 'nju-ee', rule: 'auto' });
    assert.equal(autoSlug('南京大学_集成电路学院'), 'nju-ic');
    assert.equal(autoSlug('中科院金属所与苏州纳米所'), 'imr-sinano');
  });

  test('学校不在字典里时退化为哈希 slug（ASCII，稳定）', () => {
    const a = p3Slug('P3_某某大学_化学学院.md');
    assert.equal(a.rule, 'hash');
    assert.match(a.slug, /^x-[0-9a-f]{6}$/);
    assert.equal(p3Slug('P3_某某大学_化学学院.md').slug, a.slug);
  });

  test('公开汇编 docId 用 pub- 前缀短 slug', () => {
    assert.equal(publicSlug('P3公开_北京大学_集成电路学院.md').slug, 'pub-pku-ic');
    assert.equal(publicSlug('P3公开_武汉大学_电子信息学院.md').slug, 'pub-whu-ee');
  });

  test('售卖页卖点：优先「一句话卖点」，否则第一个二级标题', () => {
    assert.equal(extractSellingPoint('# P1产品介绍\n\n一句话卖点：把申请拆成步骤\n\n## 其他'), '把申请拆成步骤');
    assert.equal(extractSellingPoint('产品：x\n\n# P1产品介绍\n\n## 把申请任务拆成可执行步骤\n'), '把申请任务拆成可执行步骤');
  });
});

describe('上传', () => {
  test('单个值超过 25MB 报错（中文提示）', () => {
    assert.doesNotThrow(() => checkValueSize('pdf:P1', MAX_VALUE_BYTES));
    assert.throws(() => checkValueSize('pdf:P4', MAX_VALUE_BYTES + 1), /pdf:P4.*超过 Workers KV 单个值 25 MB 的上限/);
  });

  test('bulk 按大小和条数分批', () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({ key: `c:P:${i}`, value: 'x'.repeat(100) }));
    const b = splitBatches(entries, 450, 1000);
    assert.ok(b.length > 1);
    assert.equal(b.flat().length, 10);
    assert.equal(splitBatches(entries, 1e9, 3).length, 4);
  });
});

describe('发布前检查：公开页 × 锁定正文', () => {
  // 造一篇 n 句的正文：每句都不一样、足够长
  const para = (tag, n, from = 0) => Array.from({ length: n }, (_, i) => `<p>${tag}第${from + i}条：这是一句足够长的示例正文用于比对重复。</p>`).join('');
  const products = [
    { id: 'P1', family: 'P1', includes: [] },
    { id: 'P4', family: 'P4', includes: ['P3-a'] },
    { id: 'P3-a', family: 'P3', includes: [] },
    { id: 'P3-b', family: 'P3', includes: [] },
    { id: 'KIT', family: 'KIT', includes: [] },
  ];
  const locked = [
    { productId: 'KIT', docId: 'T_CV', title: '简历模板', html: para('简历', 20) },
    { productId: 'P1', docId: 'P1_01', title: '第1章', html: para('一章', 20) },
    { productId: 'P1', docId: 'P1_02', title: '第2章', html: para('二章', 100) },
    { productId: 'P3-a', docId: 'a', title: '甲校', html: para('甲校', 40) },
  ];

  test('句子切分：去掉标签、实体、标点和免责声明，短句不计', () => {
    const s = htmlSentences('<p>这是&nbsp;一句 <b>很长</b>的句子，用来检查切分是否正常。短句。</p><aside class="disclaimer"><p>本资料由作者本人整理而成，不承诺任何结果。</p></aside>');
    assert.deepEqual([...s], ['这是一句很长的句子用来检查切分是否正常']);
  });

  test('服务介绍页原样粘贴学员工具包正文 → 不发布；其他页面照常发布', () => {
    const r = checkPublicLeaks({
      locked, products,
      pages: [
        { id: 'services/T_CV.html', kind: 'service', html: `<h2>价格</h2><p>159元一份，具体以确认单为准。</p>${para('简历', 18)}` },
        { id: 'services/T_QA.html', kind: 'service', html: '<p>基础咨询九十九元三十分钟，先核对事实再给方法。</p>' },
      ],
    });
    assert.deepEqual([...r.withheld.keys()], ['services/T_CV.html']);
    assert.equal(r.withheld.get('services/T_CV.html')[0].docKey, 'KIT/T_CV');
    assert.equal(r.withheld.get('services/T_CV.html')[0].hits, 18);
  });

  test('产品自己的试读引用自己的正文是正常的（含同系列、includes）；超过全书比例上限才拦', () => {
    const ok = checkPublicLeaks({
      locked, products,
      pages: [
        { id: 'library/P1/preview.html', kind: 'preview', productId: 'P1', family: 'P1', html: para('一章', 20) }, // 第1章全文
        { id: 'library/P4/preview.html', kind: 'preview', productId: 'P4', family: 'P4', html: para('甲校', 10) },
        { id: 'library/P3-b/preview.html', kind: 'preview', productId: 'P3-b', family: 'P3', html: para('甲校', 6) },
        { id: 'library/P3/preview.html', kind: 'preview', productId: null, family: 'P3', html: para('甲校', 6) },
      ],
    });
    assert.equal(ok.withheld.size, 0);
    assert.ok(ok.pairs.every((x) => x.own));
    const tooMuch = checkPublicLeaks({
      locked, products,
      pages: [{ id: 'library/P1/preview.html', kind: 'preview', productId: 'P1', family: 'P1', html: para('一章', 20) + para('二章', 30) }],
    });
    assert.deepEqual([...tooMuch.withheld.keys()], ['library/P1/preview.html']); // 50/120 > 30%
    assert.equal(tooMuch.withheld.get('library/P1/preview.html')[0].own, true);
  });

  test('别的产品的页面引用正文算越界；分散在多个页面也累计计算', () => {
    const r = checkPublicLeaks({
      locked, products,
      pages: [
        { id: 'library/P4/sale.html', kind: 'sale', productId: 'P4', family: 'P4', html: para('二章', 15) },
        { id: 'services/A.html', kind: 'service', html: para('二章', 12, 15) },
        { id: 'services/B.html', kind: 'service', html: para('二章', 4, 27) },
      ],
    });
    // 31 句 > 30 句：先撤下重复最多的 P4 售卖页，剩下 16 句（16%）不再超标
    assert.deepEqual([...r.withheld.keys()], ['library/P4/sale.html']);
  });

  test('LEAK_ALLOW 登记的组合不计入；少于 minSentences 句不处理', () => {
    const pages = [{ id: 'services/T_CV.html', kind: 'service', html: para('简历', 18) }];
    assert.equal(checkPublicLeaks({ locked, products, pages, allow: ['services/T_CV.html|KIT/T_CV'] }).withheld.size, 0);
    const few = [{ id: 'services/T_CV.html', kind: 'service', html: para('简历', 4) }];
    assert.equal(checkPublicLeaks({ locked, products, pages: few }).withheld.size, 0);
  });
});

// 已经构建过内容时，独立复查一遍产物：公开目录里不能有学员专属产品，公开页不能大段包含锁定正文
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, '.content', 'public');
const KVDIR = join(ROOT, '.content', 'kv');
describe('已构建的公开内容（.content/public）', { skip: !existsSync(join(PUB, 'catalog.json')) && '还没有运行 build-content' }, () => {
  test('catalog.json 不含学员专属产品（与匿名访问 /api/catalog 一致）', () => {
    const c = JSON.parse(readFileSync(join(PUB, 'catalog.json'), 'utf8'));
    assert.ok(c.products.length > 0);
    assert.ok(!c.products.some((p) => p.studentOnly || p.id === 'KIT'));
  });

  test('任何公开页都不大段包含学员工具包正文', () => {
    const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
    const pages = walk(PUB).filter((f) => f.endsWith('.html'));
    const kit = readdirSync(KVDIR).filter((f) => f.startsWith('c__KIT__'));
    const allow = new Set(cfg.LEAK_ALLOW);
    const L = cfg.LEAK_LIMITS;
    for (const f of kit) {
      const doc = htmlSentences(readFileSync(join(KVDIR, f), 'utf8'), L);
      const docKey = `KIT/${f.slice('c__KIT__'.length, -5)}`;
      const exposed = new Set();
      for (const pg of pages) {
        const rel = pg.slice(PUB.length + 1).split(String.fromCharCode(92)).join('/');
        if (allow.has(`${rel}|${docKey}`)) continue;
        for (const s of htmlSentences(readFileSync(pg, 'utf8'), L)) if (doc.has(s)) exposed.add(s);
      }
      assert.ok(exposed.size < L.minSentences || (exposed.size / doc.size <= L.maxRatio && exposed.size <= L.maxSentences),
        `${docKey} 有 ${exposed.size}/${doc.size} 句出现在公开页里`);
    }
  });
});

// 资料源在本机时，跑一遍真实目录的结构检查（CI 上没有源目录会自动跳过）
describe('真实资料目录（只读）', { skip: !existsSync(cfg.CONTENT_ROOT) && '找不到 CONTENT_ROOT' }, () => {
  test('产品清单结构完整', async () => {
    const { loadCatalog } = await import('../scripts/lib-content/catalog.mjs');
    const c = loadCatalog(cfg);
    const ids = c.products.map((p) => p.id);
    for (const id of ['P1', 'P2', 'P4', 'P5', 'KIT', 'P3-seu-ic', 'P3-pku-ic', 'P3-pku-sam', 'P3-pku-see', 'P3-uestc-ic', 'P3-imr', 'P3-sinano', 'P3-iop', 'P3-ucas-phys']) {
      assert.ok(ids.includes(id), `缺少产品 ${id}`);
    }
    assert.equal(new Set(ids).size, ids.length);
    for (const p of c.products) {
      assert.ok(p.docs.length > 0, `${p.id} 没有文档`);
      const dids = p.docs.map((d) => d.id);
      assert.equal(new Set(dids).size, dids.length, `${p.id} 有重复 docId`);
      for (const d of dids) assert.match(d, /^[A-Za-z0-9_-]+$/);
    }
    const p4 = c.products.find((p) => p.id === 'P4');
    assert.deepEqual(p4.includes, ids.filter((id) => id.startsWith('P3-')));
    assert.ok(p4.docs.some((d) => d.id.startsWith('pub-')));
    const kit = c.products.find((p) => p.id === 'KIT');
    assert.equal(kit.forSale, false);
    assert.equal(kit.studentOnly, true);
    assert.equal(c.products.find((p) => p.id === 'P5').docs.map((d) => d.id).join(','), 'P5_00,D1,D2,D3,D4,D5,D6,D7,P5_08');
  });
});
