// Word 导出测试：用内容丰富的示例数据生成 test-artifacts/intake-sample.docx，并检查版式要素。
// 运行：node --test tests/intake-docx.test.mjs
// 视觉检查：用 Word 把生成的 docx 转成 PDF 再渲染为 PNG（见最终报告）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate'; // docx@9 自带的依赖
import { buildDocx, Packer } from '../src/intake/export-docx.js';
import { parseBackup, validateForm, collectPending } from '../src/intake/validate.js';
import { createEmptyForm } from '../src/intake/form.js';
import { exportFileName } from '../src/intake/model.js';
import { sampleJson } from './intake-fixtures.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test-artifacts');
mkdirSync(OUT, { recursive: true });

async function render(form, name) {
  const buf = await Packer.toBuffer(buildDocx(form, { now: new Date('2026-11-13T10:00:00+08:00') }));
  writeFileSync(join(OUT, name), buf);
  const files = unzipSync(new Uint8Array(buf));
  const xml = (p) => strFromU8(files[p]);
  return { buf, files, xml };
}

test('示例数据：可导出且版式要素齐全', async () => {
  const form = parseBackup(sampleJson());
  assert.equal(validateForm(form).length, 0, '示例数据应当通过校验（与真实导出条件一致）');
  const pending = collectPending(form);
  assert.ok(pending.length >= 4, '示例数据含多项待确认');

  const { buf, files, xml } = await render(form, 'intake-sample.docx');
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  const doc = xml('word/document.xml');

  // A4 + 2cm 页边距
  assert.match(doc, /<w:pgSz w:w="11906" w:h="16838"/);
  assert.match(doc, /w:top="1134"[^>]*w:right="1134"[^>]*w:bottom="1134"[^>]*w:left="1134"/);
  // 微软雅黑（含 eastAsia）
  assert.match(doc, /w:eastAsia="Microsoft YaHei"/);
  // 页眉 / 页脚
  const headerFile = Object.keys(files).find((f) => /^word\/header\d*\.xml$/.test(f));
  const footerFile = Object.keys(files).find((f) => /^word\/footer\d*\.xml$/.test(f));
  assert.match(xml(headerFile), /保研全程陪跑 · 学员档案/);
  assert.match(xml(headerFile), /<w:jc w:val="right"\/>/);
  const footer = xml(footerFile);
  assert.match(footer, /PAGE/);
  assert.match(footer, /NUMPAGES/);
  assert.match(footer, /<w:jc w:val="center"\/>/);
  // 标题、信息卡、概览
  for (const s of ['学员基本信息档案', '称呼', '林同学', '华东示例理工大学', '填表日期', '最后更新', '档案概览', '必填项完成度', '待确认信息', '需补充或修正',
    '3.82 / 4', '6 / 128', '612 / 未考', '2 项', '1 篇', '示例大学、某某科技大学']) {
    assert.ok(doc.includes(s), `应包含「${s}」`);
  }
  // 可重复条目标题：「科研项目 1 · <名称>」；空白条目不导出
  assert.ok(doc.includes('科研项目 1 · 钙钛矿氧化物表面氧空位的第一性原理研究'));
  assert.ok(doc.includes('科研项目 2 · 柔性透明导电薄膜的制备与表征'));
  assert.ok(!doc.includes('科研项目 3'));
  assert.ok(doc.includes('目标院校 2 · 某某科技大学'));
  // 标签浅底、边框色、未填写灰色斜体、待确认琥珀底纹
  assert.match(doc, /w:fill="F2F5FA"/);
  assert.match(doc, /w:color="E4E9F1"/);
  assert.match(doc, /<w:i\/>[\s\S]{0,200}?<w:t[^>]*>未填写<\/w:t>/);
  assert.match(doc, /w:fill="FFF4DB"/);
  // 多行文本保留换行：每行一个段落
  assert.ok(doc.includes('固体物理 95</w:t>') && doc.includes('材料科学基础 93</w:t>'));
  // 文件名规则与原版一致
  assert.equal(exportFileName(form, 'docx'), '2026_华东示例理工大学_林同学_保研基本信息表.docx');
});

test('特殊字符：emoji 保留，残缺字符和控制字符不会让文件损坏', async () => {
  const form = parseBackup(sampleJson());
  form.student.notes = '加油\u{1F600}\uD800结尾\u0001';
  const { xml } = await render(form, 'intake-special-chars.docx');
  const doc = xml('word/document.xml');
  assert.ok(doc.includes('加油\u{1F600}\uFFFD结尾'));
  assert.ok(!/[\u0000-\u0008]/.test(doc));
});

test('空白表单：模块为空时写一句说明', async () => {
  const form = createEmptyForm();
  form.experienceStatus.publications = 'none';
  form.experienceStatus.competitions = 'unsure';
  const { xml } = await render(form, 'intake-empty.docx');
  const doc = xml('word/document.xml');
  assert.ok(doc.includes('尚未填写科研项目记录。'));
  assert.ok(doc.includes('学员已确认：暂无论文。'));
  assert.ok(doc.includes('竞赛与荣誉记录情况待确认，后续补充。'));
});
