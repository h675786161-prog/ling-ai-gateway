import {digest} from '../src/gateway.mjs';
import {transaction} from './schema.mjs';

// Temporary authenticated deployment fixture. Removed after live verification.
export function deploymentTest(pool,token){
 const prefix='/internal/deployment-test';
 return async req=>{
  const path=new URL(req.url).pathname;
  if(!path.startsWith(prefix+'/'))return null;
  if(await digest(req.headers.get('authorization')||'')!==await digest('Bearer '+token))return new Response(null,{status:401});
  if(path===prefix+'/models'&&req.method==='GET')return Response.json({data:[{id:'ling-migration-longstream',object:'model'}]});
  if(path===prefix+'/chat/completions'&&req.method==='POST'){
   const encoder=new TextEncoder();let heartbeat,finish;
   const chunk=text=>'data: '+JSON.stringify({id:'chatcmpl-deployment-test',object:'chat.completion.chunk',model:'ling-migration-longstream',choices:[{index:0,delta:{content:text},finish_reason:null}]})+'\n\n';
   return new Response(new ReadableStream({start(out){
    out.enqueue(encoder.encode(chunk('OK ')));
    heartbeat=setInterval(()=>out.enqueue(encoder.encode(': keepalive\n\n')),10000);
    finish=setTimeout(()=>{clearInterval(heartbeat);out.enqueue(encoder.encode(chunk('after 165 seconds')+'data: [DONE]\n\n'));out.close();},165000);
   },cancel(){clearTimeout(finish);clearInterval(heartbeat);}}),{headers:{'content-type':'text/event-stream','cache-control':'no-store'}});
  }
  if(path===prefix+'/cleanup'&&req.method==='POST'){
   const b=await req.json();
   for(const field of ['providers','keys','logs'])if(!Array.isArray(b[field])||b[field].length>10||b[field].some(id=>!/^[-a-f0-9]{36}$/.test(id)))return new Response(null,{status:400});
   const counts=await transaction(pool,async client=>{
    const p=(await client.query('select name from public.ling_gateway_providers where id=any($1::uuid[])',[b.providers])).rows;
    const k=(await client.query('select name from public.ling_gateway_keys where id=any($1::uuid[])',[b.keys])).rows;
    const logs=(await client.query('select id,model,status from public.ling_gateway_logs where id=any($1::uuid[])',[b.logs])).rows;
    if(p.some(r=>!r.name.startsWith('迁移测试·'))||k.some(r=>!['迁移临时管理会话','迁移实测临时密钥'].includes(r.name))||logs.some(r=>!/^ling-migration-/.test(r.model)||r.status==='pending'))throw new Error('fixture_cleanup_rejected');
    await client.query("update public.ling_gateway_usage u set requests=greatest(0,u.requests-s.n),inflight=greatest(0,u.inflight) from (select user_id,(started_at at time zone 'Asia/Shanghai')::date as day,count(*)::integer as n from public.ling_gateway_logs where id=any($1::uuid[]) and status in ('success','partial') group by user_id,day) s where u.user_id=s.user_id and u.day=s.day",[b.logs]);
    await client.query('delete from public.ling_gateway_logs where id=any($1::uuid[])',[b.logs]);
    await client.query('delete from public.ling_gateway_models where provider_id=any($1::uuid[])',[b.providers]);
    await client.query('delete from public.ling_gateway_providers where id=any($1::uuid[])',[b.providers]);
    await client.query('delete from public.ling_gateway_keys where id=any($1::uuid[])',[b.keys]);
    const names=['users','settings','providers','keys','usage','provider_usage','logs','models','replies','login_limits'];
    const result={};for(const name of names)result[name]=(await client.query('select count(*)::integer as n from public.ling_gateway_'+name)).rows[0].n;
    return result;
   });
   return Response.json({ok:true,counts});
  }
  return new Response(null,{status:404});
 };
}
