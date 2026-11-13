// 把 .content/kv/ 写进 Workers KV（docs/ARCHITECTURE.md §5.3）。
//   node scripts/upload-content.mjs --local            写本地 KV（与 `wrangler dev` 用同一个默认目录 .wrangler/state）
//   node scripts/upload-content.mjs --remote           写线上 KV（wrangler.toml 里要填真实的 KV id，并已 wrangler login）
// 可选：
//   --persist-to <dir>     本地持久化目录（默认不传，与 wrangler dev 的默认值一致）
//   --prune                删除 KV 里已不存在于本次构建的 c:* / pdf:* / pdfstamp:* 旧键
//   --dry-run              只生成 bulk JSON（.content/bulk/），不调用 wrangler
//   --allow-missing-pdf    缺 PDF 时不报错，并把清单里对应产品的 pdf 标成 false
// 顺序：先写正文和 PDF，最后写 manifest，保证清单里引用的键都已存在。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KV_DIR = join(ROOT, '.content', 'kv');
const BULK_DIR = join(ROOT, '.content', 'bulk');
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
export const MAX_VALUE_BYTES = 25 * 1024 * 1024; // Workers KV 单个值上限 25 MiB
const MAX_FILE_BYTES = 40 * 1024 * 1024; // 每个 bulk 文件的大致上限（远低于 100MB 的接口请求上限）
const MAX_FILE_KEYS = 5000;

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

function fail(msg) {
  console.error(`[upload-content] ${msg}`);
  process.exit(1);
}

/** 检查一条 KV 记录的大小；超过上限时抛出中文错误。 */
export function checkValueSize(key, bytes) {
  if (bytes > MAX_VALUE_BYTES) {
    throw new Error(`「${key}」有 ${(bytes / 1048576).toFixed(1)} MB，超过 Workers KV 单个值 25 MB 的上限。请拆分这个产品（例如在 catalog.config.mjs 里减少并入 PDF 的内容）或压缩后再上传。`);
  }
}

/** 把记录切成多个 bulk 文件：每个不超过 MAX_FILE_BYTES / MAX_FILE_KEYS。 */
export function splitBatches(entries, maxBytes = MAX_FILE_BYTES, maxKeys = MAX_FILE_KEYS) {
  const batches = [];
  let cur = [];
  let size = 2;
  for (const e of entries) {
    const n = JSON.stringify(e).length + 1;
    if (cur.length && (size + n > maxBytes || cur.length >= maxKeys)) { batches.push(cur); cur = []; size = 2; }
    cur.push(e);
    size += n;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function wrangler(cmdArgs, { capture = false } = {}) {
  const r = spawnSync(process.execPath, [WRANGLER, ...cmdArgs], {
    cwd: ROOT,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  return r;
}

function main() {
  const local = has('--local');
  const remote = has('--remote');
  if (local === remote) fail('请指定 --local（写本地开发用的 KV）或 --remote（写线上 KV），二选一。');
  if (!existsSync(WRANGLER)) fail('找不到 wrangler，请先在项目根目录安装依赖。');
  const manifestFile = join(KV_DIR, 'manifest.json');
  if (!existsSync(manifestFile)) fail('找不到 .content/kv/manifest.json，请先运行 npm run content（以及 npm run content:pdf）。');

  if (remote) {
    const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8');
    const id = (/\[\[kv_namespaces\]\][^[]*?\bid\s*=\s*"([^"]*)"/.exec(toml) || [])[1] || '';
    if (!id || /REPLACE|PLACEHOLDER|^x+$/i.test(id)) {
      fail('wrangler.toml 里的 KV id 还是占位值。请先运行 `npx wrangler kv namespace create KV`，把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]]，再重试。');
    }
  }

  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const entries = [];
  const missingDocs = [];
  const missingPdf = [];
  let totalBytes = 0;
  for (const p of manifest.products) {
    for (const d of p.docs) {
      const f = join(KV_DIR, `c__${p.id}__${d.id}.html`);
      if (!existsSync(f)) { missingDocs.push(`${p.id}/${d.id}`); continue; }
      const value = readFileSync(f, 'utf8');
      const bytes = Buffer.byteLength(value);
      checkValueSize(`c:${p.id}:${d.id}`, bytes);
      totalBytes += bytes;
      entries.push({ key: `c:${p.id}:${d.id}`, value });
    }
    if (p.pdf) {
      const f = join(KV_DIR, `pdf__${p.id}.pdf`);
      const sf = join(KV_DIR, `pdfstamp__${p.id}.json`);
      if (!existsSync(f)) { missingPdf.push(p.id); continue; }
      // 授权标识的位置信息：没有它 Worker 会拒绝下载（不发不带标识的 PDF），所以和 PDF 一起检查
      if (!existsSync(sf)) fail(`${p.id} 的 PDF 缺少授权标识位置信息（pdfstamp__${p.id}.json），可能是旧版脚本生成的。请重新运行 npm run content:pdf。`);
      const stamp = JSON.parse(readFileSync(sf, 'utf8'));
      const bytes = statSync(f).size;
      if (stamp.size !== bytes) fail(`${p.id} 的 PDF 与授权标识位置信息不匹配（文件被改动过）。请重新运行 npm run content:pdf。`);
      checkValueSize(`pdf:${p.id}`, bytes);
      totalBytes += bytes;
      entries.push({ key: `pdf:${p.id}`, value: readFileSync(f).toString('base64'), base64: true });
      entries.push({ key: `pdfstamp:${p.id}`, value: JSON.stringify(stamp) });
    }
  }
  if (missingDocs.length) fail(`清单里的这些正文没有对应文件：${missingDocs.join('、')}。请重新运行 npm run content。`);
  if (missingPdf.length) {
    if (!has('--allow-missing-pdf')) fail(`这些产品还没有 PDF：${missingPdf.join('、')}。请先运行 npm run content:pdf；如果暂时不需要下载功能，可加 --allow-missing-pdf。`);
    for (const p of manifest.products) if (missingPdf.includes(p.id)) p.pdf = false;
    console.warn(`[upload-content] 缺少 PDF，已在清单里标记为不可下载：${missingPdf.join('、')}`);
  }
  const manifestValue = JSON.stringify(manifest);
  checkValueSize('manifest', Buffer.byteLength(manifestValue));

  // 写 bulk 文件
  rmSync(BULK_DIR, { recursive: true, force: true });
  mkdirSync(BULK_DIR, { recursive: true });
  const batches = splitBatches(entries);
  const files = batches.map((b, i) => {
    const f = join(BULK_DIR, `bulk-${String(i + 1).padStart(2, '0')}.json`);
    writeFileSync(f, JSON.stringify(b));
    return f;
  });
  const mf = join(BULK_DIR, 'bulk-99-manifest.json');
  writeFileSync(mf, JSON.stringify([{ key: 'manifest', value: manifestValue }]));
  files.push(mf);
  const mode = local ? ['--local'] : ['--remote'];
  const persist = argVal('--persist-to');
  if (local && persist) mode.push('--persist-to', persist);
  console.log(`[upload-content] ${entries.length + 1} 条记录（正文 ${entries.filter((e) => e.key.startsWith('c:')).length}、PDF ${entries.filter((e) => e.base64).length}、PDF 标识位置 ${entries.filter((e) => e.key.startsWith('pdfstamp:')).length}、manifest 1），共 ${(totalBytes / 1048576).toFixed(1)} MB，分 ${files.length} 个文件 → ${local ? '本地 KV' : '线上 KV'}`);
  if (has('--dry-run')) {
    console.log(`[upload-content] --dry-run：只生成了 ${relative(ROOT, BULK_DIR)}，没有写入 KV。`);
    return;
  }

  for (const f of files) {
    console.log(`[upload-content] 写入 ${relative(ROOT, f)} …`);
    const r = wrangler(['kv', 'bulk', 'put', f, '--binding', 'KV', ...mode]);
    if (r.status !== 0) fail(`wrangler 写入失败（${relative(ROOT, f)}）。请检查上面的错误信息${remote ? '，并确认已运行 npx wrangler login' : ''}后重试。`);
  }

  if (has('--prune')) {
    const keep = new Set([...entries.map((e) => e.key), 'manifest']);
    const stale = [];
    for (const prefix of ['c:', 'pdf:', 'pdfstamp:']) {
      const r = wrangler(['kv', 'key', 'list', '--binding', 'KV', '--prefix', prefix, ...mode], { capture: true });
      if (r.status !== 0) fail(`读取现有键失败：${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
      const out = r.stdout || '';
      const json = out.slice(out.indexOf('['), out.lastIndexOf(']') + 1);
      for (const k of JSON.parse(json || '[]')) if (!keep.has(k.name)) stale.push(k.name);
    }
    if (stale.length) {
      const df = join(BULK_DIR, 'delete.json');
      writeFileSync(df, JSON.stringify(stale));
      const r = wrangler(['kv', 'bulk', 'delete', df, '--binding', 'KV', '--force', ...mode]);
      if (r.status !== 0) fail('删除旧键失败，请检查上面的错误信息。');
      console.log(`[upload-content] 已删除 ${stale.length} 个旧键：${stale.slice(0, 10).join('、')}${stale.length > 10 ? ' 等' : ''}`);
    } else console.log('[upload-content] 没有需要清理的旧键。');
  }
  console.log(`[upload-content] 完成。内容版本 ${manifest.version}。验证：npx wrangler kv key get manifest --binding KV ${mode.join(' ')}`);
}

// 作为脚本运行时执行（被测试 import 时不执行）
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  try { main(); } catch (e) { fail(e.message); }
}
