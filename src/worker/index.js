// Cloudflare Worker entry: static assets (dist/) + /api/* (see docs/ARCHITECTURE.md §3–§4).
import { handleRequest } from './router.js';

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
