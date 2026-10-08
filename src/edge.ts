import { createGateway } from './gateway.mjs';
const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default;
const env = { SUPABASE_URL: Deno.env.get('SUPABASE_URL'), SUPABASE_SERVICE_ROLE_KEY: secret, ENCRYPTION_KEY: Deno.env.get('LING_GATEWAY_ENCRYPTION_KEY') };
const resolveDNS = async (host: string) => {
  const results = await Promise.allSettled([Deno.resolveDns(host,'A'),Deno.resolveDns(host,'AAAA')]);
  return results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
};
Deno.serve(createGateway(env,{resolveDNS,totalTimeout:145000}));
