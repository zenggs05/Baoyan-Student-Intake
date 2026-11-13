// 采集页本地静态服务器（端口 8791）。
//   /intake/…  → test-artifacts/intake-dist/intake/…（构建产物）
//   /_chunks/… → test-artifacts/intake-dist/_chunks/…
//   /legacy/…  → legacy/…（原线上版本，用于验证新旧版本草稿互通）
// 直接运行：node tests/intake-serve.mjs   （Ctrl+C 停止）
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname, extname, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};

export function startServer({ port = 8791, dist = join(ROOT, 'test-artifacts', 'intake-dist') } = {}) {
  const mounts = [['/legacy/', join(ROOT, 'legacy')], ['/', dist]];
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (path.endsWith('/')) path += 'index.html';
      const [prefix, base] = mounts.find(([p]) => path.startsWith(p));
      const file = normalize(join(base, path.slice(prefix.length)));
      if (!file.startsWith(base + sep) && file !== base) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
      if (!(await stat(file)).isFile()) throw Object.assign(new Error('not file'), { code: 'ENOENT' });
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = await startServer();
  console.log('采集页：http://127.0.0.1:8791/intake/   原版：http://127.0.0.1:8791/legacy/   （Ctrl+C 停止）');
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}
