// 模块解析钩子：仅对 scripts/build-site.mjs 生效（原因见 intake-build.mjs）。
//   'esbuild' → intake-build-esbuild.mjs（target 中 safari14 → safari14.1）
//   'node:fs' → intake-build-fs.mjs（cpSync 换成纯 JS 递归复制，规避 Node 22 在中文路径下 cpSync 直接崩溃）
const SHIMS = { esbuild: './intake-build-esbuild.mjs', 'node:fs': './intake-build-fs.mjs' };

export async function resolve(specifier, context, next) {
  if (SHIMS[specifier] && context.parentURL?.endsWith('/scripts/build-site.mjs')) {
    return { url: new URL(SHIMS[specifier], import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
