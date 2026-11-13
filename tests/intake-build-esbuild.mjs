// esbuild 薄封装：只把 target 里的 'safari14' 换成 'safari14.1'（原因见 intake-build.mjs）。
import { createRequire } from 'node:module';

const esbuild = createRequire(import.meta.url)('esbuild');
const fixTarget = (t) => (Array.isArray(t) ? t.map((x) => (x === 'safari14' ? 'safari14.1' : x)) : t);

export const build = (options) => esbuild.build({ ...options, target: fixTarget(options.target) });
export const context = (options) => esbuild.context({ ...options, target: fixTarget(options.target) });
