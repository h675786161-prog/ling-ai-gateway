import {createGateway} from './gateway.mjs';

let directHandler;

function directGateway(env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return null;
  if (!directHandler) {
    const supabaseUrl = env.SUPABASE_URL || new URL(env.GATEWAY_ORIGIN).origin;
    directHandler = createGateway({
      SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      ENCRYPTION_KEY: env.LING_GATEWAY_ENCRYPTION_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
    }, {
      // Cloudflare owns the long-lived client stream. One hour is a safety
      // ceiling, not the old 130s platform deadline.
      totalTimeout: 60 * 60 * 1000,
    });
  }
  return directHandler;
}

async function proxyToSupabase(request, env, runtime='supabase-fallback') {
  const u = new URL(request.url);
  const target = env.GATEWAY_ORIGIN.replace(/\/$/, '') + u.pathname + u.search;
  const headers = new Headers(request.headers);
  headers.delete('host');
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  });
  const out = new Headers(response.headers);
  out.set('x-gateway-runtime', runtime);
  return new Response(response.body, {status: response.status, headers: out});
}

export default {
  async fetch(request, env) {
    const u = new URL(request.url);

    if (u.pathname.startsWith('/v1/')) {
      const direct = directGateway(env);
      if (direct) {
        // Clone before handing the body to the direct runtime so a startup
        // failure can still fall back without losing the original request.
        const fallbackRequest = request.clone();
        const response = await direct(request);
        if (response.status !== 503) {
          const headers = new Headers(response.headers);
          headers.set('x-gateway-runtime', 'cloudflare-direct');
          return new Response(response.body, {status: response.status, headers});
        }
        return proxyToSupabase(fallbackRequest, env, 'supabase-after-direct-failure');
      }
      return proxyToSupabase(request, env);
    }

    if (/^\/(admin\/|health$)/.test(u.pathname)) {
      return proxyToSupabase(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
