// Optional free Cloudflare front door. Authentication and secrets stay in Supabase.
export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    if (/^\/(v1\/|admin\/|health$)/.test(u.pathname)) {
      const target = env.GATEWAY_ORIGIN.replace(/\/$/, '') + u.pathname + u.search;
      const headers = new Headers(request.headers);
      headers.delete('host');
      return fetch(target, { method: request.method, headers, body: ['GET','HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual' });
    }
    return env.ASSETS.fetch(request);
  }
};
