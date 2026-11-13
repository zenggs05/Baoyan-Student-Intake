// Post-processing for trusted, pre-rendered HTML fragments (sale pages, previews, service pages, documents).

/** Wrap tables for horizontal scrolling, neutralise links to source .md files, harden external links. */
export function enhanceProse(root, { previewHref } = {}) {
  for (const t of root.querySelectorAll('table')) {
    if (t.parentElement?.classList.contains('table-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', '表格（可左右滑动）');
    t.replaceWith(wrap);
    wrap.append(t);
  }
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (/\.md(#.*)?$/i.test(href)) {
      // Links to source markdown files are meaningless on the site.
      if (previewHref && /试读\.md/.test(decodeURIComponent(href))) { a.setAttribute('href', previewHref); continue; }
      const span = document.createElement('span');
      span.className = 'plain-link';
      span.append(...a.childNodes);
      a.replaceWith(span);
    } else if (/^https?:\/\//i.test(href) && !href.startsWith(location.origin)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }
  for (const pre of root.querySelectorAll('pre')) pre.tabIndex = 0;
  return root;
}

/** Collect h2/h3 headings (with ids) as a table of contents. */
export function collectToc(root) {
  const out = [];
  let n = 0;
  for (const el of root.querySelectorAll('h2, h3')) {
    if (!el.id) el.id = `sec-${++n}`;
    out.push({ id: el.id, text: el.textContent.trim(), level: el.tagName === 'H2' ? 2 : 3 });
  }
  return out;
}
