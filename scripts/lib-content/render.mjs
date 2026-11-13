// Markdown → HTML 片段（docs/ARCHITECTURE.md §5.2）。
// - markdown-it: html:true, linkify:true（关闭“模糊链接”，否则 run.py / job.sh / x.md 会被误认成网址）
// - {{待作者确认:xxx}} → <span class="todo" title="xxx">待补充</span>
// - 其他 {{xxx}}（模板填写位）→ <span class="slot">[xxx]</span>
// - 固定免责声明段落 → <aside class="disclaimer">（同一篇里重复的只保留第一段）
// - h2/h3（以及标题之外的 h1）加 id，抽取为目录；第一个 h1 作为文档标题，默认从片段里去掉
// - 表格外包 <div class="table-wrap" data-cols="N">
// - 指向 .md 的相对链接交给 resolveLink 改写；解析不了的去掉链接只留文字
import MarkdownIt from 'markdown-it';
import { TODO_RE, SLOT_RE, isDisclaimerText } from './clean.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 内联规则：{{…}} 占位符。 */
function placeholderRule(state, silent) {
  const src = state.src;
  const pos = state.pos;
  if (src.charCodeAt(pos) !== 0x7b /* { */ || src.charCodeAt(pos + 1) !== 0x7b) return false;
  const m = new RegExp('^' + SLOT_RE.source).exec(src.slice(pos));
  if (!m) return false;
  if (!silent) {
    const todo = new RegExp('^' + TODO_RE.source).exec(m[0]);
    const tok = state.push(todo ? 'bys_todo' : 'bys_slot', '', 0);
    tok.meta = { text: todo ? todo[1] : m[1] };
    tok.content = todo ? '待补充' : `[${m[1]}]`;
  }
  state.pos += m[0].length;
  return true;
}

/** 标题 / 链接文字的纯文本。 */
function inlineText(token) {
  if (!token || !token.children) return token?.content?.trim() || '';
  return token.children.map((c) => {
    if (c.type === 'text' || c.type === 'code_inline') return c.content;
    if (c.type === 'bys_todo' || c.type === 'bys_slot') return c.content;
    if (c.type === 'softbreak' || c.type === 'hardbreak') return ' ';
    return '';
  }).join('').replace(/\s+/g, ' ').trim();
}

function processLinks(children, env, line) {
  for (let j = 0; j < children.length; j++) {
    const open = children[j];
    if (open.type !== 'link_open') continue;
    let k = j + 1;
    while (k < children.length && children[k].type !== 'link_close') k++;
    const close = children[k];
    const href = open.attrGet('href') || '';
    const textTokens = children.slice(j + 1, k);
    const text = textTokens.map((t) => t.content).join('').trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      if (/^https?:/i.test(href)) { open.attrSet('target', '_blank'); open.attrSet('rel', 'noopener noreferrer'); }
      continue;
    }
    if (href.startsWith('#') || !href) continue;
    let pathPart = href, hash = '';
    const hi = href.indexOf('#');
    if (hi >= 0) { pathPart = href.slice(0, hi); hash = href.slice(hi + 1); }
    let decoded = pathPart;
    try { decoded = decodeURIComponent(pathPart); } catch { /* keep */ }
    const file = decoded.split('/').pop();
    const res = env.resolveLink ? env.resolveLink({ file, hash, text, href: decoded }) : null;
    env.links.push({ line, href: decoded, file, text, resolved: !!(res && res.href), to: res?.href || null });
    // 链接文字就是文件名（如 [P5_D1_原理与名词.md](P5_D1_原理与名词.md)）时换成目标标题
    if (res?.title && textTokens.length === 1 && textTokens[0].type === 'text' && /\.md$/i.test(text)) {
      textTokens[0].content = res.title;
    }
    if (res && res.href) {
      open.attrSet('href', res.href);
    } else {
      open.type = 'bys_unlink';
      if (close) close.type = 'bys_unlink';
    }
  }
}

function tableStats(tokens, i, limits) {
  let rows = 0, cols = 0, maxCell = 0, inHead = false, curCols = 0;
  let j = i;
  for (; j < tokens.length && tokens[j].type !== 'table_close'; j++) {
    const t = tokens[j];
    if (t.type === 'thead_open') inHead = true;
    if (t.type === 'thead_close') inHead = false;
    if (t.type === 'tr_open') curCols = 0;
    if (t.type === 'th_open' || t.type === 'td_open') curCols++;
    if (t.type === 'tr_close') { cols = Math.max(cols, curCols); if (!inHead) rows++; }
    if (t.type === 'inline') maxCell = Math.max(maxCell, inlineText(t).length);
  }
  return { cols, rows, maxCell };
}

/** 创建 markdown-it 实例（可复用；每篇文档的状态放在 env 里）。 */
export function createMarkdown() {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false, fuzzyIP: false });
  md.inline.ruler.before('emphasis', 'bys_placeholder', placeholderRule);

  md.core.ruler.push('bys_post', (state) => {
    const env = state.env;
    const tokens = state.tokens;
    const prefix = env.idPrefix || '';
    let n = 0;
    let disclaimerSeen = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      const line = t.map ? t.map[0] + 1 + (env.lineOffset || 0) : null;
      if (t.type === 'heading_open') {
        const level = Number(t.tag.slice(1));
        const text = inlineText(tokens[i + 1]);
        if (level === 1 && env.title == null) {
          env.title = text;
          if (env.stripTitle) { tokens.splice(i, 3); i--; continue; }
          t.attrSet('id', `${prefix}title`);
          continue;
        }
        if (level <= 3) {
          n++;
          const id = `${prefix}sec-${n}`;
          t.attrSet('id', id);
          env.toc.push({ id, text, level });
        }
      } else if (t.type === 'paragraph_open' && tokens[i + 1]?.type === 'inline'
        && isDisclaimerText(tokens[i + 1].content, env.disclaimerPrefix)) {
        if (disclaimerSeen && env.dedupeDisclaimer !== false) {
          tokens.splice(i, 3); i--; env.dedupedDisclaimers++; continue;
        }
        disclaimerSeen = true;
        env.disclaimers++;
        t.tag = 'aside';
        t.attrSet('class', 'disclaimer');
        tokens[i + 2].tag = 'aside';
      } else if (t.type === 'table_open') {
        const st = tableStats(tokens, i);
        t.meta = { ...(t.meta || {}), cols: st.cols };
        env.tables.push({ line, ...st });
      } else if (t.type === 'inline' && t.children) {
        processLinks(t.children, env, line);
        for (const c of t.children) {
          if (c.type === 'bys_todo') env.todos.push({ line, text: c.meta.text });
          if (c.type === 'bys_slot') env.slots.push({ line, text: c.meta.text });
        }
      }
    }
  });

  const r = md.renderer.rules;
  r.bys_todo = (tokens, idx) => `<span class="todo" title="${esc(tokens[idx].meta.text)}">待补充</span>`;
  r.bys_slot = (tokens, idx) => `<span class="slot">${esc(tokens[idx].content)}</span>`;
  r.bys_unlink = () => '';
  r.table_open = (tokens, idx) => `<div class="table-wrap" data-cols="${tokens[idx].meta?.cols || 0}">\n<table>\n`;
  r.table_close = () => '</table>\n</div>\n';
  return md;
}

let shared = null;
/**
 * 渲染一篇（已清洗的）Markdown。
 * opts: { idPrefix, stripTitle=true, resolveLink, disclaimerPrefix, dedupeDisclaimer=true }
 * 返回 { html, title, toc, todos, slots, tables, links, disclaimers, dedupedDisclaimers }
 */
export function renderMarkdown(src, opts = {}) {
  shared ||= createMarkdown();
  const env = {
    idPrefix: opts.idPrefix || '',
    stripTitle: opts.stripTitle !== false,
    resolveLink: opts.resolveLink || null,
    disclaimerPrefix: opts.disclaimerPrefix || '',
    dedupeDisclaimer: opts.dedupeDisclaimer,
    title: null, toc: [], todos: [], slots: [], tables: [], links: [], disclaimers: 0, dedupedDisclaimers: 0,
  };
  const html = shared.render(src, env).trim() + '\n';
  return {
    html, title: env.title, toc: env.toc, todos: env.todos, slots: env.slots, tables: env.tables,
    links: env.links, disclaimers: env.disclaimers, dedupedDisclaimers: env.dedupedDisclaimers,
  };
}

export { esc as escapeHtml };
