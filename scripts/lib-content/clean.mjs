// 纯文本层面的清洗与检测（docs/ARCHITECTURE.md §5.2）。
// 约定：所有清洗都“保留行号”——被删掉的行替换成空行，这样报告里的行号就是源文件行号。

const BOM_RE = new RegExp('^' + String.fromCharCode(0xfeff));
// 中文字符（CJK 统一表意文字 + 扩展 A + 兼容表意文字），用码点构造，避免源码里出现不可见字符
const CJK_RE = new RegExp(`[${String.fromCharCode(0x3400)}-${String.fromCharCode(0x9fff)}${String.fromCharCode(0xf900)}-${String.fromCharCode(0xfaff)}]`, 'g');

/** 统一换行、去 BOM。 */
export function normalizeSource(src) {
  return String(src).replace(BOM_RE, '').replace(/\r\n?/g, '\n');
}

/**
 * 按围栏代码块切分：返回 [{code:boolean, text}]，拼回去等于原文。
 * 只识别行首（最多 3 个空格缩进）的 ``` / ~~~ 围栏。
 */
export function splitFences(src) {
  const lines = src.split('\n');
  const parts = [];
  let buf = [];
  let fence = null; // 当前围栏的开头字符串
  const flush = (code) => { if (buf.length) parts.push({ code, text: buf.join('\n') }); buf = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!fence && m) { flush(false); fence = m[1]; buf.push(line); continue; }
    if (fence && m && m[1][0] === fence[0] && m[1].length >= fence.length && /^ {0,3}(`{3,}|~{3,})\s*$/.test(line)) {
      buf.push(line); flush(true); fence = null; continue;
    }
    buf.push(line);
  }
  flush(!!fence);
  // 各段之间原本是换行连接
  return parts.map((p, i) => ({ ...p, text: i < parts.length - 1 ? p.text + '\n' : p.text }));
}

/** 只对围栏代码块以外的文本做替换。 */
export function mapOutsideFences(src, fn) {
  return splitFences(src).map((p) => (p.code ? p.text : fn(p.text))).join('');
}

/** 把一段文字换成同样行数的空行。 */
const blankKeepLines = (s) => s.replace(/[^\n]/g, '');

/** 解析元信息行：「产品：P1 第3章 … ｜ 版本 v0.1 ｜ 状态：待作者补充 ｜ 字数：1037（…） ｜ 来源构成：…」 */
export function parseMeta(line) {
  const meta = { raw: line };
  const parts = line.split(/\s*[｜|]\s*/);
  meta.product = parts[0].replace(/^产品[:：]\s*/, '').trim();
  for (const p of parts.slice(1)) {
    let m;
    if ((m = /^版本\s*[:：]?\s*(.+)$/.exec(p))) meta.version = m[1].trim();
    else if ((m = /^状态\s*[:：]\s*(.+)$/.exec(p))) meta.status = m[1].trim();
    else if ((m = /^字数\s*[:：]\s*(\d+)/.exec(p))) meta.words = Number(m[1]);
    else if ((m = /^题数\s*[:：]\s*(\d+)/.exec(p))) meta.questions = Number(m[1]);
    else if ((m = /^来源构成\s*[:：]\s*(.+)$/.exec(p))) meta.sources = m[1].trim();
  }
  return meta;
}

/** 规则 1：删掉第一行以「产品：」开头的元信息（替换为空行，保留行号）。 */
export function stripMetaLine(src) {
  const text = normalizeSource(src);
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  if (!/^\s*产品[:：]/.test(first)) return { text, meta: null };
  return { text: (nl < 0 ? '' : text.slice(nl)), meta: parseMeta(first.trim()) };
}

/** 规则 2：删掉 HTML 注释（不动代码块；多行注释换成等量空行）。返回 {text, removed:[{line, text}]} */
export function stripComments(src) {
  const removed = [];
  let offsetLine = 1;
  const out = splitFences(src).map((p) => {
    const startLine = offsetLine;
    offsetLine += (p.text.match(/\n/g) || []).length;
    if (p.code) return p.text;
    return p.text.replace(/<!--[\s\S]*?-->/g, (m, idx) => {
      const line = startLine + (p.text.slice(0, idx).match(/\n/g) || []).length;
      removed.push({ line, text: m.replace(/\s+/g, ' ').slice(0, 120) });
      return blankKeepLines(m);
    });
  }).join('');
  return { text: out, removed };
}

/** 只保留第二个一级标题之前的内容（用于合并版文件只取开头的总览）。 */
export function trimBeforeSecondH1(src) {
  let count = 0;
  let cutAt = -1;
  let pos = 0;
  for (const p of splitFences(src)) {
    if (!p.code) {
      const re = /^# [^\n]*$/gm;
      let m;
      while ((m = re.exec(p.text))) {
        count++;
        if (count === 2) { cutAt = pos + m.index; break; }
      }
    }
    if (cutAt >= 0) break;
    pos += p.text.length;
  }
  return cutAt >= 0 ? src.slice(0, cutAt).replace(/\s+$/, '') + '\n' : src;
}

/** 第一个一级标题的文字（不在代码块里）。 */
export function firstH1(src) {
  for (const p of splitFences(src)) {
    if (p.code) continue;
    const m = /^# +(.+?)\s*#*\s*$/m.exec(p.text);
    if (m) return m[1].trim();
  }
  return null;
}

// ---------------------------------------------------------------- 占位符
/** 规则 3：作者待确认占位符 {{待作者确认:xxx}}（半角或全角冒号）。 */
export const TODO_RE = /\{\{\s*待作者确认\s*[:：]\s*([^{}]*?)\s*\}\}/;
/** 其他 {{xxx}} 占位（模板里的填写位，如 {{学校与专业}}）。 */
export const SLOT_RE = /\{\{\s*([^{}\n]+?)\s*\}\}/;

/** 扫描占位符位置：[{line, kind:'todo'|'slot', text}]（跳过代码块）。 */
export function findPlaceholders(src) {
  const found = [];
  let line = 1;
  for (const p of splitFences(src)) {
    if (!p.code) {
      const lines = p.text.split('\n');
      lines.forEach((l, i) => {
        const re = new RegExp(SLOT_RE.source, 'g');
        let m;
        while ((m = re.exec(l))) {
          const todo = TODO_RE.exec(m[0]);
          found.push(todo ? { line: line + i, kind: 'todo', text: todo[1] } : { line: line + i, kind: 'slot', text: m[1] });
        }
      });
    }
    line += (p.text.match(/\n/g) || []).length;
  }
  return found;
}

// ---------------------------------------------------------------- 免责声明 / 内部用语 / 字数
export function isDisclaimerText(text, prefix) {
  return !!prefix && String(text).trim().startsWith(prefix);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** ASCII 词用单词边界匹配，中文词直接匹配。 */
export function termRegex(term) {
  return /^[\x00-\x7f]+$/.test(term) ? new RegExp(`\\b${escapeRe(term)}\\b`, 'g') : new RegExp(escapeRe(term), 'g');
}

/**
 * 规则 6：检测内部用语（只报告，不修改）。
 * 跳过免责声明段落（其中的「内部信息」是正常表述）。返回 [{term, line, snippet}]。
 * 较长的词先匹配，被它覆盖的较短词（如「内部来源表」里的「内部」）不重复报告。
 */
export function findInternalTerms(src, terms, disclaimerPrefix) {
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  const hits = [];
  src.split('\n').forEach((l, i) => {
    if (isDisclaimerText(l, disclaimerPrefix)) return;
    const taken = [];
    for (const term of sorted) {
      const re = termRegex(term);
      let m;
      while ((m = re.exec(l))) {
        const s = m.index, e = s + m[0].length;
        if (taken.some(([a, b]) => s >= a && e <= b)) continue;
        taken.push([s, e]);
        const snippet = l.slice(Math.max(0, s - 18), Math.min(l.length, e + 18)).trim();
        hits.push({ term, line: i + 1, snippet });
      }
    }
  });
  return hits.sort((a, b) => a.line - b.line);
}

/**
 * 字数：中文字符 + 英文单词（与源文件元信息口径一致：不计免责声明、代码块和 URL）。
 */
export function countWords(src, disclaimerPrefix) {
  let n = 0;
  for (const p of splitFences(src)) {
    if (p.code) continue;
    const text = p.text
      .split('\n').filter((l) => !isDisclaimerText(l, disclaimerPrefix)).join('\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\]\([^)]*\)/g, ']')
      .replace(/https?:\/\/\S+/g, ' ');
    n += (text.match(CJK_RE) || []).length;
    n += (text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
  }
  return n;
}

/** 源文件里可能有风险的原始 HTML（html:true 会原样输出），报告提醒。 */
export function findRiskyHtml(src) {
  const hits = [];
  src.split('\n').forEach((l, i) => {
    if (/<\s*(script|iframe|object|embed|form|style|link|meta)\b/i.test(l) || /\son[a-z]+\s*=/i.test(l) || /javascript:/i.test(l)) {
      hits.push({ line: i + 1, snippet: l.trim().slice(0, 100) });
    }
  });
  return hits;
}

/** 完整清洗（规则 1、2 + 可选截取）：返回 {text, meta, comments} */
export function cleanSource(raw, { trim } = {}) {
  const { text: noMeta, meta } = stripMetaLine(raw);
  const { text, removed } = stripComments(noMeta);
  return { text: trim === 'beforeSecondH1' ? trimBeforeSecondH1(text) : text, meta, comments: removed };
}
