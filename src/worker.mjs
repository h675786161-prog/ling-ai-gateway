import {createGateway} from './gateway.mjs';

let directHandler;

function directGateway(env) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.LING_GATEWAY_ENCRYPTION_KEY) return null;
  if (!directHandler) {
    const supabaseUrl = env.SUPABASE_URL || new URL(env.GATEWAY_ORIGIN).origin;
    directHandler = createGateway({
      SUPABASE_URL: supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      ENCRYPTION_KEY: env.LING_GATEWAY_ENCRYPTION_KEY,
    }, {
      // Cloudflare handles the long-lived client stream. Keep a generous safety
      // ceiling instead of the 130s Supabase Edge Function wall-clock budget.
      totalTimeout: 60 * 60 * 1000,
    });
  }
  return directHandler;
}

async function proxyToSupabase(request, env) {
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
  out.set('x-gateway-runtime', 'supabase-fallback');
  return new Response(response.body, {status: response.status, headers: out});
}

export default {
  async fetch(request, env) {
    const u = new URL(request.url);

    if (u.pathname.startsWith('/v1/')) {
      const direct = directGateway(env);
      if (direct) {
        const response = await direct(request);
        const headers = new Headers(response.headers);
        headers.set('x-gateway-runtime', 'cloudflare-direct');
        return new Response(response.body, {status: response.status, headers});
      }
      // Safe migration path: until the two Worker secrets are configured,
      // keep the existing API working through Supabase instead of breaking it.
      return proxyToSupabase(request, env);
    }

    if (/^\/(admin\/|health$)/.test(u.pathname)) {
      return proxyToSupabase(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
