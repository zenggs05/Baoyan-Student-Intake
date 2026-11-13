// 飞鸟研习社 · 教程子站（learn.feiniaofly.cn）
//
// 把作者在 GitHub Pages 上的教程站实时转发到自己的子域名：
//   https://learn.feiniaofly.cn/dft/…  ←→  https://zenggs05.github.io/DFT-Tutorials/…
// GitHub 一更新（Actions 部署完成后），这里在 CACHE_TTL 秒内自动同步，不需要重新部署。
//
// 为什么用独立子域名：教程站会加载第三方脚本（如 jsDelivr 上的 MathJax）。放在 learn.
// 子域名下，这些脚本与主站（feiniaofly.cn）不同源，读不到主站的登录 Cookie，也不能借用户
// 身份调用付费资料接口。主站 Cookie 没有设置 Domain 属性，不会发送到子域名。
//
// 新增教程（例如以后的大模型教程仓库）：在 SITES 里加一行 { slug: 'GitHub Pages 路径' }，然后部署。

export const LEARN_HOST_PREFIX = 'learn.';
const MAIN_SITE = 'https://feiniaofly.cn';
const UPSTREAM = 'https://zenggs05.github.io';
const CACHE_TTL = 300; // 秒；GitHub 推送后最多约 5 分钟同步

/** slug → GitHub Pages 项目路径 */
export const SITES = {
  dft: '/DFT-Tutorials/',
};

export function isLearnHost(hostname) {
  return hostname.startsWith(LEARN_HOST_PREFIX);
}

export async function handleLearn(request) {
  const url = new URL(request.url);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  // 第三方 CDN 中转：jsDelivr 在大陆不稳定，MathJax 改由本域名经 Cloudflare 取回（只放行 MathJax）
  if (url.pathname.startsWith(CDN_PREFIX)) return proxyCdn(url);

  const [, slug, ...rest] = url.pathname.split('/');
  // 子站首页 → 主站的研习社总览
  if (!slug) return Response.redirect(`${MAIN_SITE}/research/`, 302);
  const base = SITES[slug];
  if (!base) return notFound();
  if (url.pathname === `/${slug}`) return Response.redirect(`${url.origin}/${slug}/${url.search}`, 301);

  const upstreamUrl = `${UPSTREAM}${base}${rest.map(encodeURIComponentSafe).join('/')}${url.search}`;
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: request.method,
      redirect: 'manual',
      headers: { 'User-Agent': 'feiniaofly-learn-proxy', Accept: request.headers.get('Accept') || '*/*' },
      cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
    });
  } catch {
    return new Response('教程站暂时无法访问，请稍后刷新。', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  const publicPrefix = `${url.origin}/${slug}/`;
  const upstreamPrefix = `${UPSTREAM}${base}`;
  const mapUrl = (v) => {
    if (!v) return v;
    if (v.startsWith(upstreamPrefix)) return publicPrefix + v.slice(upstreamPrefix.length);
    if (v.startsWith(base)) return `/${slug}/` + v.slice(base.length);
    return v;
  };

  const headers = new Headers(upstream.headers);
  for (const h of ['set-cookie', 'x-github-request-id', 'x-fastly-request-id', 'x-served-by', 'x-cache', 'x-cache-hits', 'x-timer', 'via', 'x-proxy-cache']) headers.delete(h);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Cache-Control', `public, max-age=${CACHE_TTL}`);

  // 上游重定向（如目录补斜杠）改写到本站路径
  if (upstream.status >= 300 && upstream.status < 400) {
    const loc = headers.get('Location');
    if (loc) headers.set('Location', mapUrl(loc));
    return new Response(null, { status: upstream.status, headers });
  }

  const type = headers.get('Content-Type') || '';
  if (type.includes('text/html')) {
    headers.delete('Content-Length');
    const rewriteAttr = (attr) => ({
      element(el) {
        const v = el.getAttribute(attr);
        const m = mapUrl(v);
        if (m !== v) el.setAttribute(attr, m);
      },
    });
    return new HTMLRewriter()
      // Google 字体在大陆通常被拦截，且位于 <head> 会阻塞渲染：直接去掉，主题自动回退到系统字体
      .on('link[href^="https://fonts.googleapis.com"], link[href^="https://fonts.gstatic.com"]', { element(el) { el.remove(); } })
      .on('script[src^="https://cdn.jsdelivr.net/npm/mathjax@3/"]', {
        element(el) { el.setAttribute('src', el.getAttribute('src').replace('https://cdn.jsdelivr.net/', CDN_PREFIX)); },
      })
      .on('a[href], link[href], area[href]', rewriteAttr('href'))
      .on('script[src], img[src], source[src], iframe[src]', rewriteAttr('src'))
      .on('meta[content]', rewriteAttr('content'))
      .on('body', { element(el) { el.append(BACK_PILL, { html: true }); } })
      .transform(new Response(upstream.body, { status: upstream.status, headers }));
  }
  if (type.includes('xml') || type.includes('text/plain')) {
    // sitemap.xml / robots.txt 等：替换绝对地址
    headers.delete('Content-Length');
    const text = await upstream.text();
    return new Response(text.split(upstreamPrefix).join(publicPrefix), { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

const CDN_PREFIX = '/_cdn/jsdelivr/';
const CDN_ALLOW = /^npm\/mathjax@3(\.[\d.]+)?\/[\w./@-]+$/; // 只允许 MathJax 3 的静态文件，防止被当作公共代理

async function proxyCdn(url) {
  const path = url.pathname.slice(CDN_PREFIX.length);
  if (!CDN_ALLOW.test(path) || path.includes('..')) return new Response('Not Found', { status: 404 });
  let r;
  try {
    r = await fetch(`https://cdn.jsdelivr.net/${path}`, { cf: { cacheTtl: 86400 * 7, cacheEverything: true } });
  } catch {
    return new Response('Bad Gateway', { status: 502 });
  }
  const headers = new Headers();
  for (const h of ['content-type', 'etag', 'last-modified']) if (r.headers.get(h)) headers.set(h, r.headers.get(h));
  headers.set('Cache-Control', 'public, max-age=604800, immutable');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(r.body, { status: r.status, headers });
}

function encodeURIComponentSafe(seg) {
  // 路径段已是浏览器编码后的形式；只防止出现 .. 之类的穿越（上游是静态站点，本身也不会越出项目路径）
  return seg === '..' ? '' : seg;
}

function notFound() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>没有找到这个教程</title>' +
      '<p style="font-family:system-ui,sans-serif;padding:40px">没有找到这个教程。<a href="' + MAIN_SITE + '/research/">返回飞鸟研习社</a></p>',
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

// 每个教程页面左下角的“返回”小按钮（内联样式，不依赖教程站主题）
const BACK_PILL = `<a href="${MAIN_SITE}/research/" aria-label="返回飞鸟研习社" style="position:fixed;left:16px;bottom:16px;z-index:9999;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:999px;background:#172946;color:#fff;font:600 13px/1.2 'PingFang SC','Microsoft YaHei',system-ui,sans-serif;text-decoration:none;box-shadow:0 4px 16px rgba(23,41,70,.25);opacity:.92">← 飞鸟研习社</a>`;
