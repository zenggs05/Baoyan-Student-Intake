// 采集页的临时构建入口（只用于本地测试）。
//
// 背景：scripts/build-site.mjs 的 esbuild target 是 ['es2020','chrome90','safari14']。
// esbuild 认为 Safari 14.0 的解构语法有缺陷，会尝试降级，但它不支持降级解构，于是报错
// 「Transforming destructuring ... is not supported yet」——docx@9 和任何用到解构的代码都无法打包。
// 修复办法（需要负责共享脚本的人改）：把 'safari14' 改成 'safari14.1'（或 'safari15'）。
//
// 另一个问题：本机 Node 22.22.2 在 Windows 上对含中文的路径调用 fs.cpSync 会直接崩溃（退出码 127，无任何报错），
// build-site.mjs 末尾复制 .content/public 时就会触发；改用 `await fs.promises.cp(...)` 即可（已验证可用）。
//
// 在共享脚本修复前，这个包装器通过 Node 的模块解析钩子，把 build-site.mjs 里的 esbuild / node:fs 换成薄封装
// （只改 target 和 cpSync，见 intake-build-hooks.mjs），其余逻辑与参数完全沿用 build-site.mjs。
// 用法与 build-site 相同：node tests/intake-build.mjs --only intake --out test-artifacts/intake-dist
import { register } from 'node:module';

register('./intake-build-hooks.mjs', import.meta.url);
await import('../scripts/build-site.mjs');
