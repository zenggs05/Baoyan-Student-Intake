// 生成 .content/report.md（给作者看的内容检查报告）。
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const fmtDate = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const MAX_LIST = 400; // 每个产品最多列出多少条明细

function countBy(arr, key) {
  const m = new Map();
  for (const x of arr) m.set(x[key], (m.get(x[key]) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function tableIssues(tables, limits) {
  return tables.filter((t) => t.cols >= limits.wideCols || t.rows >= limits.longRows || t.maxCell >= limits.longCell)
    .map((t) => {
      const why = [];
      if (t.cols >= limits.wideCols) why.push(`${t.cols} 列`);
      if (t.rows >= limits.longRows) why.push(`${t.rows} 行`);
      if (t.maxCell >= limits.longCell) why.push(`最长单元格 ${t.maxCell} 字`);
      return { ...t, why: why.join('，') };
    });
}

export function summarizeDoc(d, limits, weak = new Set()) {
  const todos = d.placeholders.filter((x) => x.kind === 'todo');
  const slots = d.placeholders.filter((x) => x.kind === 'slot');
  return {
    todos, slots, tables: tableIssues(d.tables, limits),
    internal: d.internal.filter((h) => !weak.has(h.term)), // 明确的内部用语
    weak: d.internal.filter((h) => weak.has(h.term)), // 常见于正常表述的词（如「内部结构」），只列出供核对
    unresolved: d.links.filter((l) => !l.resolved), risky: d.risky,
  };
}

/** 写报告；同时返回汇总数据（build-pdf 会在报告后面追加 PDF 一节）。 */
export function writeReport(file, data) {
  const { products, publicPages, notes, limits } = data;
  const weak = new Set(data.weakTerms || []);
  const L = [];
  const push = (...xs) => L.push(...xs);

  push('# 内容构建报告', '');
  push(`- 生成时间：${fmtDate(data.builtAt)}`);
  push(`- 内容版本：\`${data.version}\``);
  push(`- 资料源（只读）：\`${data.contentRoot}\`、\`${data.sopRoot}\``);
  push(`- 产物：\`.content/kv/\`（${data.kvFiles} 篇正文 + manifest.json），\`.content/public/\`（catalog.json、售卖页、试读、服务介绍）`);
  push('- 清洗规则：删除首行元信息、删除 HTML 注释、`{{待作者确认:…}}` 显示为「待补充」、固定免责声明改为 `<aside class="disclaimer">`；内部用语只在本报告提示，不自动修改。');
  push('');

  // ------------------------------------------------ 总览
  const sums = products.map((p) => {
    const s = p.docs.map((d) => summarizeDoc(d, limits, weak));
    const statuses = countBy(p.docs.filter((d) => d.meta?.status).map((d) => ({ s: d.meta.status })), 's');
    return {
      p, s,
      words: p.docs.reduce((a, d) => a + d.words, 0),
      todos: s.reduce((a, x) => a + x.todos.length, 0),
      slots: s.reduce((a, x) => a + x.slots.length, 0),
      internal: s.reduce((a, x) => a + x.internal.length, 0),
      weak: s.reduce((a, x) => a + x.weak.length, 0),
      tables: s.reduce((a, x) => a + x.tables.length, 0),
      statuses: statuses.map(([k, n]) => `${k}×${n}`).join('、') || '—',
    };
  });
  push('## 一、总览', '');
  push('| 产品 | 名称 | 篇数 | 字数 | 待补充 | 模板填写位 | 内部用语 | 需留意的表格 | 源文件状态 |');
  push('|---|---|--:|--:|--:|--:|--:|--:|---|');
  for (const x of sums) {
    push(`| ${x.p.id} | ${cell(x.p.title)} | ${x.p.docs.length} | ${x.words} | ${x.todos || '—'} | ${x.slots || '—'} | ${x.internal || '—'}${x.weak ? `（疑似 ${x.weak}）` : ''} | ${x.tables || '—'} | ${cell(x.statuses)} |`);
  }
  const pubS = publicPages.map((pg) => ({ pg, s: summarizeDoc(pg, limits, weak) }));
  const pubInternal = pubS.reduce((a, x) => a + x.s.internal.length, 0);
  const pubWeak = pubS.reduce((a, x) => a + x.s.weak.length, 0);
  const pubTodos = pubS.reduce((a, x) => a + x.s.todos.length + x.s.slots.length, 0);
  push('', `公开页面 ${publicPages.length} 个（售卖页 / 试读 / 服务介绍，任何人都能看到）：内部用语 ${pubInternal} 处（另有疑似 ${pubWeak} 处），占位符 ${pubTodos} 处。`, '');
  push(`「内部用语」只统计明确的内部说法；${[...weak].map((t) => `「${t}」`).join('')}这类词也常出现在正常表述里（如“内部结构”“草稿纸”），单独记为“疑似”，逐条位置见明细。`, '');

  // ------------------------------------------------ 重点
  push('## 二、需要作者在内容层面处理的问题', '');
  const top = [];
  const leak = data.leak;
  if (leak?.withheld?.size) {
    top.push(`**${leak.withheld.size} 个公开页与锁定正文重复过多，本次没有发布**：${[...leak.withheld.keys()].map((r) => `\`${r}\``).join('、')}。这些页面几乎原样包含了需要购买或陪跑学员才能看的正文，任何人都能直接打开。请改写源文件（服务介绍页只写服务范围、价格、流程和常见问题，不要粘贴模板或正文），重新构建后会自动发布。明细见第三节末尾。`);
  }
  if (pubInternal) top.push(`**公开页面里有 ${pubInternal} 处内部用语**（${countBy(pubS.flatMap((x) => x.s.internal), 'term').slice(0, 6).map(([t, n]) => `「${t}」${n}`).join('、')}），访客能直接看到，建议上线前优先改写。明细见第三节。`);
  const heavyTodo = sums.filter((x) => x.todos > 0).sort((a, b) => b.todos - a.todos);
  if (heavyTodo.length) top.push(`**正文里还有「待补充」占位符**：${heavyTodo.map((x) => `${x.p.id}（${x.todos} 处）`).join('、')}。读者会看到琥珀色的「待补充」标记。`);
  const heavyInternal = sums.filter((x) => x.internal > 0).sort((a, b) => b.internal - a.internal);
  if (heavyInternal.length) top.push(`**正文里的内部用语**：${heavyInternal.map((x) => `${x.p.id}（${x.internal} 处）`).join('、')}（另有疑似 ${sums.reduce((a, x) => a + x.weak, 0)} 处）。最常见的是：${countBy(sums.flatMap((x) => x.s.flatMap((s) => s.internal)), 'term').slice(0, 8).map(([t, n]) => `「${t}」${n}`).join('、')}。`);
  const slotDocs = sums.filter((x) => x.slots > 0);
  if (slotDocs.length) top.push(`**模板填写位** \`{{…}}\`：${slotDocs.map((x) => `${x.p.id}（${x.slots} 处）`).join('、')}。模板里给学员填写的位置是正常的（显示为「[学校与专业]」这类方括号），但像「作者建模经历」这类应由作者补写的内容需要处理。`);
  const tblDocs = sums.filter((x) => x.tables > 0);
  if (tblDocs.length) top.push(`**过宽或过长的表格**：${tblDocs.map((x) => `${x.p.id}（${x.tables} 张）`).join('、')}。网页上可横向滚动，PDF 里 ${limits.pdfCardCols} 列及以上的表格会自动改成“逐条卡片”排版；如果希望读者更好读，可以考虑拆表。`);
  const unresolved = [...sums.flatMap((x) => x.s.flatMap((s) => s.unresolved)), ...pubS.flatMap((x) => x.s.unresolved)];
  if (unresolved.length) top.push(`**${unresolved.length} 个站内链接找不到目标**（例如指向「宣传院校覆盖表.md」等未公开文件），已自动去掉链接、只保留文字。`);
  const priceBad = publicPages.filter((pg) => pg.priceCheck && !pg.priceCheck.ok);
  if (priceBad.length) top.push(`**售卖页价格与配置不一致**：${priceBad.map((pg) => `${pg.id}「${pg.priceCheck.line}」`).join('；')}（网站上显示的价格以 catalog.config.mjs 为准）。`);
  const risky = [...sums.flatMap((x) => x.s.flatMap((s) => s.risky)), ...pubS.flatMap((x) => x.s.risky)];
  if (risky.length) top.push(`**源文件里有 ${risky.length} 处可能有风险的原始 HTML**（script、iframe、事件属性等），请检查。`);
  top.forEach((t, i) => push(`${i + 1}. ${t}`));
  if (!top.length) push('没有发现需要处理的问题。');
  push('');

  // ------------------------------------------------ 公开页面
  push('## 三、公开页面检查（售卖页 / 试读 / 服务介绍）', '');
  push('| 页面 | 源文件 | 字数 | 内部用语 | 占位符 | 用于 |');
  push('|---|---|--:|--:|--:|---|');
  for (const { pg, s } of pubS) {
    const kind = { sale: '售卖页', preview: '试读', service: '服务介绍' }[pg.kind];
    const used = pg.usedBy.length > 3 ? `${pg.usedBy.slice(0, 2).join('、')} 等 ${pg.usedBy.length} 个` : pg.usedBy.join('、');
    push(`| ${kind} | \`${cell(pg.rel)}\` | ${pg.words} | ${s.internal.length || '—'}${s.weak.length ? `（疑似 ${s.weak.length}）` : ''} | ${(s.todos.length + s.slots.length) || '—'} | ${cell(used)} |`);
  }
  push('');
  for (const { pg, s } of pubS) {
    if (!s.internal.length && !s.weak.length && !s.todos.length && !s.slots.length) continue;
    push(`- \`${pg.rel}\``);
    for (const h of s.internal) push(`  - 第 ${h.line} 行「${h.term}」：${cell(h.snippet)}`);
    for (const h of s.weak) push(`  - 第 ${h.line} 行「${h.term}」（疑似）：${cell(h.snippet)}`);
    for (const h of [...s.todos, ...s.slots]) push(`  - 第 ${h.line} 行占位符 \`{{${h.kind === 'todo' ? '待作者确认:' : ''}${h.text}}}\``);
  }
  push('');
  if (leak) {
    const L = leak.limits;
    push('### 与锁定正文的重复（发布前检查）', '');
    push(`逐句比对公开页和全部锁定正文（${L.minChars} 字以上的句子，免责声明不计）。产品自己的售卖页、试读引用自己的正文算「试读」；其他公开页累计公开某篇正文超过 ${Math.round(L.maxRatio * 100)}% 或 ${L.maxSentences} 句（且至少 ${L.minSentences} 句）就不发布；试读合计超过本产品正文的 ${Math.round(L.ownMaxRatio * 100)}% 也不发布。确属有意公开的组合可在 \`catalog.config.mjs\` 的 \`LEAK_ALLOW\` 里登记。`, '');
    if (leak.withheld.size) {
      push('**本次没有发布的页面**', '');
      for (const [rel, why] of leak.withheld) {
        push(`- \`${rel}\`：${why.map((w) => (w.own ? `试读合计公开了「${cell(w.title)}」${w.hits}/${w.total} 句` : `与「${cell(w.title)}」重复 ${w.hits}/${w.total} 句`)).join('；')}`);
      }
      push('');
    } else push('所有公开页都通过了检查。', '');
    if (leak.pairs.length) {
      push(`<details><summary>重复 ${L.minSentences} 句以上的组合（${leak.pairs.length} 个）</summary>`, '');
      push('| 公开页 | 锁定正文 | 重复句数 | 类型 | 结果 |', '|---|---|--:|---|---|');
      for (const x of leak.pairs) push(`| \`${x.page}\` | ${cell(x.title)} | ${x.hits}/${x.total} | ${x.own ? '本产品试读' : '越界'} | ${x.withheld ? '未发布' : '已发布'} |`);
      push('', '</details>', '');
    }
  }

  // ------------------------------------------------ 各产品明细
  push('## 四、各产品明细', '');
  for (const x of sums) {
    const { p } = x;
    push(`### ${p.id} ${p.title}`, '');
    push(`${p.docs.length} 篇，约 ${x.words} 字；待补充 ${x.todos} 处，模板填写位 ${x.slots} 处，内部用语 ${x.internal} 处（另有疑似 ${x.weak} 处）。`, '');
    push('| docId | 标题 | 字数 | 状态 | 待补充 | 内部用语 | 目录条数 |');
    push('|---|---|--:|---|--:|--:|--:|');
    p.docs.forEach((d, i) => {
      const s = x.s[i];
      push(`| \`${d.id}\` | ${cell(d.title)}${d.trimmed ? '（只取开头总览）' : ''} | ${d.words} | ${cell(d.meta?.status || '—')} | ${s.todos.length || '—'} | ${s.internal.length || '—'}${s.weak.length ? `（疑似 ${s.weak.length}）` : ''} | ${d.toc.length} |`);
    });
    push('');
    const todoLines = p.docs.flatMap((d, i) => x.s[i].todos.map((h) => `- \`${d.rel}\` 第 ${h.line} 行：待作者确认「${cell(h.text)}」`));
    if (todoLines.length) push('**待补充位置**', '', ...todoLines.slice(0, MAX_LIST), ...(todoLines.length > MAX_LIST ? [`- …另有 ${todoLines.length - MAX_LIST} 处`] : []), '');
    const slotLines = p.docs.flatMap((d, i) => x.s[i].slots.map((h) => `- \`${d.rel}\` 第 ${h.line} 行：\`{{${cell(h.text)}}}\``));
    if (slotLines.length) push('**模板填写位**', '', ...slotLines.slice(0, MAX_LIST), '');
    const allInternal = p.docs.flatMap((d, i) => x.s[i].internal.map((h) => ({ ...h, rel: d.rel })));
    if (allInternal.length) {
      push(`**内部用语**（${countBy(allInternal, 'term').map(([t, n]) => `「${t}」${n}`).join('、')}）`, '');
      push('<details><summary>逐条位置</summary>', '');
      for (const h of allInternal.slice(0, MAX_LIST)) push(`- \`${h.rel}\` 第 ${h.line} 行「${h.term}」：${cell(h.snippet)}`);
      if (allInternal.length > MAX_LIST) push(`- …另有 ${allInternal.length - MAX_LIST} 处`);
      push('', '</details>', '');
    }
    const allWeak = p.docs.flatMap((d, i) => x.s[i].weak.map((h) => ({ ...h, rel: d.rel })));
    if (allWeak.length) {
      push(`<details><summary>疑似内部用语 ${allWeak.length} 处（${countBy(allWeak, 'term').map(([t, n]) => `「${t}」${n}`).join('、')}，多为正常表述，仅供核对）</summary>`, '');
      for (const h of allWeak.slice(0, MAX_LIST)) push(`- \`${h.rel}\` 第 ${h.line} 行「${h.term}」：${cell(h.snippet)}`);
      push('', '</details>', '');
    }
    const tbl = p.docs.flatMap((d, i) => x.s[i].tables.map((t) => `- \`${d.rel}\` 第 ${t.line} 行：${t.why}`));
    if (tbl.length) push('**需留意的表格**', '', ...tbl, '');
    const links = p.docs.flatMap((d, i) => x.s[i].unresolved.map((l) => `- \`${d.rel}\` 第 ${l.line} 行：「${cell(l.text)}」→ \`${cell(l.href)}\``));
    if (links.length) push('**找不到目标的链接（已去掉链接）**', '', ...links, '');
  }

  // ------------------------------------------------ 处理说明
  push('## 五、构建时的自动处理', '');
  const comments = products.flatMap((p) => p.docs.flatMap((d) => d.comments.map((c) => ({ rel: d.rel, ...c }))));
  push(`- 删除 HTML 注释 ${comments.length} 处（如「公开面经补充 BEGIN/END」标记）。`);
  const dedup = [...products.flatMap((p) => p.docs), ...publicPages].filter((d) => d.dedupedDisclaimers > 0);
  if (dedup.length) push(`- 同一篇里重复出现的免责声明只保留一段：${dedup.map((d) => `\`${d.rel}\``).join('、')}。`);
  const noDisc = products.flatMap((p) => p.docs).filter((d) => !d.disclaimers && !d.trimmed);
  if (noDisc.length) push(`- 以下正文没有固定免责声明：${noDisc.map((d) => `\`${d.rel}\``).join('、')}。`);
  const trimmed = products.flatMap((p) => p.docs).filter((d) => d.trimmed);
  for (const d of trimmed) push(`- \`${d.rel}\` 与「公开面经汇编」目录下的单校文件内容重复，只保留开头的覆盖总览（docId \`${d.id}\`），各校正文用单独文件。`);
  for (const n of notes) push(`- ${n}`);
  const unresolvedPub = pubS.flatMap((x) => x.s.unresolved.map((l) => `\`${x.pg.rel}\` 第 ${l.line} 行「${cell(l.text)}」→ \`${cell(l.href)}\``));
  if (unresolvedPub.length) push(`- 公开页面里找不到目标的链接（已去掉链接、保留文字）：${unresolvedPub.join('；')}。`);
  push('');
  push('<!-- PDF-SECTION -->', '');
  // 保留上一次 build-pdf 写的 PDF 一节，并提示可能已过期
  const old = existsSync(file) ? readFileSync(file, 'utf8').split('<!-- PDF-SECTION -->')[1] : '';
  const oldPdf = (old || '').replace(/^\s*>[^\n]*\n\n/m, '').trim();
  if (oldPdf) push(`> 以下是上次生成 PDF 时的结果；正文刚重新构建过，如内容有变化请重新运行 \`npm run content:pdf\`。`, '', oldPdf, '');
  writeFileSync(file, L.join('\n'));
}

/** build-pdf 调用：把 PDF 结果写进 report.md 末尾（替换上一次的 PDF 一节）。 */
export function appendPdfSection(file, lines) {
  if (!existsSync(file)) return;
  const src = readFileSync(file, 'utf8');
  const head = src.split('<!-- PDF-SECTION -->')[0];
  writeFileSync(file, `${head}<!-- PDF-SECTION -->\n\n${lines.join('\n')}\n`);
}
