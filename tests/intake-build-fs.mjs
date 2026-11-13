// node:fs 薄封装：其余函数原样导出，只替换 cpSync。
// 原因：本机 Node 22.22.2 在 Windows 上对含中文的路径调用 fs.cpSync 会直接崩溃退出（退出码 127，无报错信息），
// 而 build-site.mjs 末尾用 cpSync 复制 .content/public。异步的 fs.promises.cp 没有这个问题。
import { mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

export * from 'node:fs';

export function cpSync(src, dest, options = {}) {
  if (!statSync(src).isDirectory()) {
    copyFileSync(src, dest);
    return;
  }
  if (!options.recursive) throw new Error('cpSync: 复制目录需要 recursive: true');
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) cpSync(join(src, name), join(dest, name), options);
}
