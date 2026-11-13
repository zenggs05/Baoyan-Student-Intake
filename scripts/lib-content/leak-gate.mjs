// 公开页发布前检查（docs/ARCHITECTURE.md §5.2-7）：把所有公开页（售卖页、试读、服务介绍）和全部锁定正文逐句比对，
// 某篇锁定正文有太多句子出现在公开页里时，不发布造成重复的公开页，并在报告里写明原因。
//
// 规则：
//   - 句子 = 渲染后的纯文本按「。！？；」和换行切开，去掉空白和标点后至少 minChars 个字；免责声明不参与比对。
//   - 产品自己的售卖页 / 试读引用自己的正文是正常的「试读」（同一系列、或 includes 包含的产品也算自己）；
//     其余公开页（服务介绍页、别的产品的页面）对某篇正文的重复都计入「越界重复」。
//   - 越界重复：某篇正文累计有 ≥ minSentences 句出现在这些页面里，并且超过全文的 maxRatio 或超过 maxSentences 句
//     → 从重复最多的页面开始逐个不发布，直到不再超标。
//   - 试读上限：一个产品自己的售卖页 / 试读合计公开了该产品全部正文的 ownMaxRatio 以上 → 同样不发布（防止误把整份资料当试读）。
//   - allow 里登记的 '<公开页路径>|<产品 id>/<docId>' 组合不计入（确认是有意公开时使用）。

export const DEFAULT_LEAK_LIMITS = { minChars: 12, minSentences: 5, maxRatio: 0.2, maxSentences: 30, ownMaxRatio: 0.3 };

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// 行内标签去掉后文字连在一起；其余标签（段落、列表项、表格单元格、标题…）当作断句
const INLINE_TAG = /<\/?(?:a|b|strong|em|i|u|s|del|ins|mark|span|code|kbd|small|sup|sub|abbr)\b[^>]*>/gi;

/** 渲染后的 HTML → 归一化句子集合。 */
export function htmlSentences(html, { minChars = DEFAULT_LEAK_LIMITS.minChars } = {}) {
  const text = decodeEntities(String(html)
    .replace(/<aside class="disclaimer">[\s\S]*?<\/aside>/g, '\n')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '\n')
    .replace(INLINE_TAG, '')
    .replace(/<[^>]+>/g, '\n'));
  const out = new Set();
  for (const part of text.split(/[。！？!?；;\n]+/)) {
    const s = part.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
    if (s.length >= minChars) out.add(s);
  }
  return out;
}

const docKey = (d) => `${d.productId}/${d.docId}`;

/**
 * @param {object} a
 * @param {{productId:string, docId:string, title?:string, html:string}[]} a.locked   锁定正文（只进 KV）
 * @param {{id:string, kind:'sale'|'preview'|'service', productId?:string|null, family?:string|null, html:string}[]} a.pages  公开页
 * @param {{id:string, family?:string, includes?:string[]}[]} a.products
 * @param {object} [a.limits]
 * @param {string[]} [a.allow]
 * @returns {{withheld: Map<string, {docKey:string, title:string, hits:number, total:number, own:boolean}[]>, pairs: object[]}}
 */
export function checkPublicLeaks({ locked, pages, products, limits = {}, allow = [] }) {
  const L = { ...DEFAULT_LEAK_LIMITS, ...limits };
  const allowSet = new Set(allow);
  const prod = new Map(products.map((p) => [p.id, p]));
  const docs = locked.map((d) => ({ ...d, key: docKey(d), sents: htmlSentences(d.html, L) })).filter((d) => d.sents.size);
  const index = new Map(); // 句子 → 含有它的正文
  for (const d of docs) for (const s of d.sents) {
    if (!index.has(s)) index.set(s, []);
    index.get(s).push(d);
  }

  // 每个公开页与每篇正文的重复句
  const overlap = new Map(); // pageId → Map(docKey → Set(句子))
  for (const pg of pages) {
    const m = new Map();
    for (const s of htmlSentences(pg.html, L)) {
      for (const d of index.get(s) || []) {
        if (allowSet.has(`${pg.id}|${d.key}`)) continue;
        if (!m.has(d.key)) m.set(d.key, new Set());
        m.get(d.key).add(s);
      }
    }
    overlap.set(pg.id, m);
  }

  /** 这个公开页引用这篇正文算不算「自己的试读」。 */
  const isOwn = (pg, d) => {
    if (pg.kind !== 'sale' && pg.kind !== 'preview') return false;
    const target = prod.get(d.productId);
    if (pg.productId && pg.productId === d.productId) return true;
    const owner = pg.productId ? prod.get(pg.productId) : null;
    if (owner?.includes?.includes(d.productId)) return true;
    const fam = owner?.family || pg.family; // 同一系列（如 P3 各校）共用售卖页和试读
    return !!fam && fam === target?.family;
  };

  const published = new Set(pages.map((p) => p.id));
  const withheld = new Map();
  const withhold = (pageId, why) => {
    published.delete(pageId);
    if (!withheld.has(pageId)) withheld.set(pageId, []);
    withheld.get(pageId).push(why);
  };
  const exceeds = (hits, total) => hits >= L.minSentences && (hits / total > L.maxRatio || hits > L.maxSentences);

  // 1) 越界重复：逐篇正文累计，超标就从重复最多的页面开始撤下
  for (const d of docs) {
    for (;;) {
      const contrib = pages.filter((pg) => published.has(pg.id) && !isOwn(pg, d) && overlap.get(pg.id).get(d.key)?.size);
      const exposed = new Set(contrib.flatMap((pg) => [...overlap.get(pg.id).get(d.key)]));
      if (!exceeds(exposed.size, d.sents.size)) break;
      const worst = contrib.sort((a, b) => overlap.get(b.id).get(d.key).size - overlap.get(a.id).get(d.key).size)[0];
      withhold(worst.id, { docKey: d.key, title: d.title || d.key, hits: overlap.get(worst.id).get(d.key).size, total: d.sents.size, own: false });
    }
  }

  // 2) 试读上限：一个产品自己的公开页合计公开了多少
  const byProduct = new Map();
  for (const d of docs) {
    if (!byProduct.has(d.productId)) byProduct.set(d.productId, []);
    byProduct.get(d.productId).push(d);
  }
  for (const [pid, list] of byProduct) {
    const all = new Set(list.flatMap((d) => [...d.sents]));
    for (;;) {
      const contrib = new Map(); // pageId → Set
      for (const pg of pages) {
        if (!published.has(pg.id)) continue;
        for (const d of list) {
          if (!isOwn(pg, d)) continue;
          const hit = overlap.get(pg.id).get(d.key);
          if (!hit?.size) continue;
          if (!contrib.has(pg.id)) contrib.set(pg.id, new Set());
          for (const s of hit) contrib.get(pg.id).add(s);
        }
      }
      const exposed = new Set([...contrib.values()].flatMap((x) => [...x]));
      if (!(exposed.size >= L.minSentences && exposed.size / all.size > L.ownMaxRatio)) break;
      const [worstId, worstSet] = [...contrib].sort((a, b) => b[1].size - a[1].size)[0];
      withhold(worstId, { docKey: `${pid}/*`, title: prod.get(pid)?.title || pid, hits: worstSet.size, total: all.size, own: true });
    }
  }

  // 给报告用：所有达到 minSentences 的「公开页 × 正文」组合
  const pairs = [];
  for (const pg of pages) {
    for (const [key, set] of overlap.get(pg.id)) {
      if (set.size < L.minSentences) continue;
      const d = docs.find((x) => x.key === key);
      pairs.push({ page: pg.id, docKey: key, title: d.title || key, hits: set.size, total: d.sents.size, own: isOwn(pg, d), withheld: withheld.has(pg.id) });
    }
  }
  pairs.sort((a, b) => b.hits / b.total - a.hits / a.total);
  // 撤下的页面：原因按重复比例从高到低列出（最多 3 条），比「哪一步撤下的」更直观
  for (const [pageId, why] of withheld) {
    const top = pairs.filter((x) => x.page === pageId && !x.own).slice(0, 3)
      .map((x) => ({ docKey: x.docKey, title: x.title, hits: x.hits, total: x.total, own: false }));
    withheld.set(pageId, [...top, ...why.filter((w) => w.own || !top.some((t) => t.docKey === w.docKey))].slice(0, 3));
  }
  return { withheld, pairs, limits: L };
}
