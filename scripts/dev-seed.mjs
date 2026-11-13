// Seed LOCAL KV with a tiny fake catalogue for Worker / front-end testing.
// Contains NO real course material — every document is placeholder text.
//
// Usage:
//   node scripts/dev-seed.mjs                        # write into the default local state (.wrangler/state)
//   node scripts/dev-seed.mjs --persist-to <dir>     # write into an isolated local state (same flag as `wrangler dev`)
//   node scripts/dev-seed.mjs --dry-run              # only generate the bulk JSON file
//
// Products: P2, P5, P4 (includes P3-*), P3-demo, KIT (student only). pdf:P2 is a small generated PDF with
// licence-stamp placeholders (+ pdfstamp:P2), like the ones scripts/build-pdf.mjs produces.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { addStampPlaceholders, findStampSlots } from './lib-content/pdf-stamp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argVal = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
};
const persistTo = argVal('--persist-to');
const dryRun = process.argv.includes('--dry-run');
const outDir = join(ROOT, 'test-artifacts', 'dev-seed');

const toc = (...items) => items.map(([id, text, level = 2]) => ({ id, text, level }));

function fakeDoc(title, sections) {
  const parts = [`<h1>${title}</h1>`, '<p>这是<strong>本地测试用的示例文档</strong>，正文内容为占位文字，不代表真实资料。</p>'];
  for (const s of sections) {
    parts.push(`<h${s.level || 2} id="${s.id}">${s.text}</h${s.level || 2}>`);
    parts.push(`<p>示例段落：${s.text}。这里用于检查排版、目录跳转与水印显示是否正常。</p>`);
    parts.push('<ul><li>示例要点一</li><li>示例要点二</li><li>示例要点三</li></ul>');
  }
  parts.push('<aside class="disclaimer">示例免责声明：本页仅用于本地开发测试。</aside>');
  return parts.join('\n');
}

const products = [
  {
    id: 'P2', title: '理工科面试题库（示例）', subtitle: '本地测试用示例产品', price: 49.9, priceNote: '',
    sellingPoint: '示例卖点：按专业方向整理的常见问题', forSale: true, studentOnly: false, includes: [], preview: true, pdf: true,
    docs: [
      { id: 'P2_00', title: '使用说明（示例）', toc: toc(['s1', '怎么使用这份题库'], ['s2', '答题框架']) },
      { id: 'P2_01', title: '专业基础题（示例）', toc: toc(['q1', '示例问题一'], ['q1-a', '参考思路', 3]) },
    ],
  },
  {
    id: 'P5', title: 'DFT 一周入门笔记（示例）', subtitle: '本地测试用示例产品', price: 249, priceNote: '含一周答疑 / 纯资料 199',
    sellingPoint: '示例卖点：七天从零上手', forSale: true, studentOnly: false, includes: [], preview: true, pdf: false,
    docs: [{ id: 'D1', title: '第一天（示例）', toc: toc(['d1-1', '基本概念'], ['d1-2', '软件安装']) }],
  },
  {
    id: 'P4', title: '多校面经合集（示例）', subtitle: '本地测试用示例产品', price: 169, priceNote: '加答疑版 199',
    sellingPoint: '示例卖点：多所学校面经汇总', forSale: true, studentOnly: false, includes: ['P3-*'], preview: true, pdf: false,
    docs: [
      { id: 'P4_00', title: '合集导读（示例）', toc: toc(['g1', '如何阅读本合集']) },
      { id: 'P4_01', title: '学校 A 面经（示例）', toc: toc(['a1', '流程'], ['a2', '问题回顾']) },
    ],
  },
  {
    id: 'P3-demo', title: '单校面经复盘·示例大学示例学院', subtitle: '本地测试用示例产品', price: 59.9, priceNote: '',
    sellingPoint: '示例卖点：一所学校的完整复盘', forSale: true, studentOnly: false, includes: [], preview: false, pdf: false,
    docs: [{ id: 'demo', title: '示例大学复盘（示例）', toc: toc(['r1', '时间线'], ['r2', '面试问题']) }],
  },
  {
    id: 'KIT', title: '陪跑学员工具包（示例）', subtitle: '仅陪跑学员可见', price: null, priceNote: '',
    sellingPoint: '', forSale: false, studentOnly: true, includes: [], preview: false, pdf: false,
    docs: [
      { id: 'T_MAIL', title: '邮件模板（示例）', toc: toc(['m1', '第一封邮件']) },
      { id: 'T_CV', title: '简历模板（示例）', toc: toc(['c1', '版式建议']) },
    ],
  },
];

const manifest = { version: 1, builtAt: Date.now(), seed: true, products };

async function makePdf(title) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const page = pdf.addPage([595.28, 841.89]);
    page.drawText(`${title} - local test PDF`, { x: 60, y: 760, size: 20, font, color: rgb(0.09, 0.16, 0.27) });
    page.drawText(`Placeholder page ${i} / 2. Not real course material.`, { x: 60, y: 720, size: 12, font, color: rgb(0.44, 0.5, 0.59) });
  }
  await addStampPlaceholders(pdf, { title });
  const bytes = Buffer.from(await pdf.save());
  return { bytes, stamp: findStampSlots(bytes) };
}

const bulk = [{ key: 'manifest', value: JSON.stringify(manifest) }];
for (const p of products) {
  for (const d of p.docs) {
    bulk.push({ key: `c:${p.id}:${d.id}`, value: fakeDoc(d.title, d.toc) });
  }
}
const p2pdf = await makePdf('P2');
bulk.push({ key: 'pdf:P2', value: p2pdf.bytes.toString('base64'), base64: true });
bulk.push({ key: 'pdfstamp:P2', value: JSON.stringify(p2pdf.stamp) });

mkdirSync(outDir, { recursive: true });
const file = join(outDir, 'kv-bulk.json');
writeFileSync(file, JSON.stringify(bulk));
console.log(`[dev-seed] wrote ${bulk.length} entries -> ${file}`);

if (!dryRun) {
  const wrangler = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const args = [wrangler, 'kv', 'bulk', 'put', file, '--binding', 'KV', '--local'];
  if (persistTo) args.push('--persist-to', resolve(ROOT, persistTo));
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
  console.log(`[dev-seed] seeded local KV${persistTo ? ` (${persistTo})` : ''}`);
}
