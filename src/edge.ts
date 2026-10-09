const target = 'https://p01--ling-ai-gateway--vbxqzx898zzq.code.run';
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^(?:\/functions\/v1)?\/ling-ai-gateway(?=\/|$)/, '') || '/';
  const headers = new Headers(req.headers);
  for (const name of ['host','cf-connecting-ip','x-forwarded-for','x-forwarded-host','x-forwarded-proto','connection','content-length']) headers.delete(name);
  try {
    return await fetch(target + path + url.search, {method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:req.body,redirect:'error',signal:req.signal});
  } catch {
    return Response.json({error:{code:'gateway_unavailable',type:'gateway_error',message:'新入口暂时无法连接，请稍后重试。'}},{status:503,headers:{'cache-control':'no-store','access-control-allow-origin':'*'}});
  }
});
