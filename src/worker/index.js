// Cloudflare Worker entry: static assets (dist/) + /api/* (see docs/ARCHITECTURE.md §3–§4).
import { handleRequest } from './router.js';
import { isLearnHost, handleLearn } from './learn.js';

export default {
  async fetch(request, env) {
    // learn.feiniaofly.cn：飞鸟研习社教程子站（转发 GitHub Pages，见 learn.js）
    if (isLearnHost(new URL(request.url).hostname)) return handleLearn(request);
    return handleRequest(request, env);
  },
};
