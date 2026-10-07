import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGateway,seal,digest,randomKey} from '../src/gateway.mjs';
import {canonicalName,canonicalID,createModelDirectory} from '../src/model-directory.mjs';
const model='gemini-2.5-flash',logId='33333333-3333-4333-8333-333333333333';
const event=o=>'data: '+JSON.stringify(o)+'\n\n';
const json=content=>Response.json({model:'raw-returned',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3}});
function stream(text,delay=1,truncate=false,signal){let timer;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(event({choices:[{index:0,delta:{role:'assistant'}}]})));timer=setTimeout(()=>{try{c.enqueue(new TextEncoder().encode(event({model:'raw-returned',choices:[{index:0,delta:{content:text}}]})));if(!truncate)c.enqueue(new TextEncoder().encode(event({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3}})+'data: [DONE]\n\n'));c.close();}catch{}},delay);signal?.addEventListener('abort',()=>{clearTimeout(timer);try{c.error(new DOMException('Aborted','AbortError'));}catch{}},{once:true});},cancel(){clearTimeout(timer);}}),{headers:{'content-type':'text/event-stream'}});}
async function fixture(fetcher,count=4){const secret=randomKey(),token=randomKey(),hashed=await digest(token),cipher=await seal('upstream-hidden',secret);
 const providers=Array.from({length:count},(_,i)=>({id:'11111111-1111-4111-8111-'+String(i+1).padStart(12,'0'),name:'Station '+(i+1),kind:'custom',base_url:'https://p'+(i+1)+'.example.org/v1',secret_cipher:cipher,enabled:true,priority:i,aliases:{}}));
 const models=providers.map((p,i)=>({provider_id:p.id,model_id:'station-wire-'+(i+1),canonical_id:model,listed:true,status:'unchecked'})),saved=[],rpcCalls=[],patches=[],calls=[];
 const db={async table(name,q=''){if(name==='keys')return q.includes(hashed)?[{id:'key',user_id:'owner',enabled:true,admin_access:false}]:[];if(name==='users')return[{id:'owner',role:'admin',enabled:true}];if(name==='settings')return[{public_enabled:true,max_output_tokens:4096}];if(name==='providers')return providers;if(name==='models')return models;if(name==='logs')return q.includes('user_id=eq.owner')?[{id:logId,model,status:'success'}]:[];if(name==='replies')return saved;return[];},async rpc(name,args){rpcCalls.push({name,args});return name==='reserve'?{id:logId}:name==='claim'?true:undefined;},async write(name,method,data,q){if(name==='replies')saved.push(structuredClone(data));if(name==='models')patches.push(data);return[data];}};
 const gateway=createGateway({SUPABASE_SERVICE_ROLE_KEY:secret},{db,fetcher:async(url,o)=>{calls.push({url,payload:JSON.parse(o.body)});return fetcher(url,o);},firstTimeout:50,totalTimeout:500});
 const req=(b={model,messages:[{role:'user',content:'fixture'}]},path='/v1/chat/completions')=>new Request('https://gateway.example.org'+path,{method:path==='/v1/chat/completions'?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:path==='/v1/chat/completions'?JSON.stringify(b):undefined});
 return {gateway,req,db,providers,models,saved,rpcCalls,patches,calls};
}
test('canonical IDs strip namespaces/free suffixes, keep dates and versions, hide unknown labels',()=>{
 assert.equal(canonicalName('google/gemini-2.5-flash:free','openrouter'),model);assert.equal(canonicalName('@cf/meta/llama-3.1-8b-instruct','cloudflare'),'llama-3.1-8b-instruct');
 assert.equal(canonicalName('My Site/gemini-2.5-flash','custom','My Site'),model);assert.equal(canonicalName('gemini-2.5-flash-My Site','custom','My Site'),model);
 assert.equal(canonicalName('openrouter/free','openrouter'),null);assert.equal(canonicalName('VIP Claude special','custom'),null);assert.notEqual(canonicalName('gpt-4o-2024-08-06'),canonicalName('gpt-4o'));
 assert.throws(()=>canonicalID('brand/model'),/invalid_canonical_model/);assert.throws(()=>canonicalID('fast'));
});
test('model endpoint deduplicates names, omits disabled stations and leaks no wire ID or secret',async()=>{
 const f=await fixture(()=>json('OK'));f.providers[3].enabled=false;const r=await f.gateway(f.req(undefined,'/v1/models')),data=await r.json();assert.deepEqual(data.data.map(m=>m.id),[model]);assert.equal(data.data[0].gateway.site_count,3);assert.equal(JSON.stringify(data).includes('station-wire'),false);assert.equal(JSON.stringify(data).includes('cipher'),false);
});
test('all matching stations start in parallel; first visible text wins; every response saved',async()=>{
 let arrived=0,release;const barrier=new Promise(r=>release=r);const f=await fixture(async(url,o)=>{if(++arrived===4)release();await barrier;const n=Number(new URL(url).hostname[1]);return n===4?new Response('private error body',{status:429}):stream('Reply '+n,n===2?1:n===1?15:30,false,o.signal);});
 const result=await (await f.gateway(f.req())).json();assert.equal(f.calls.length,4);assert.deepEqual(result.choices.map(c=>c.message.content),['Reply 2','Reply 1','Reply 3']);assert.deepEqual(result.choices.map(c=>c.index),[0,1,2]);assert.equal(result.model,model);assert.equal(f.saved.length,4);assert.equal(f.saved.find(r=>r.http_status===429).reason,'http_429');assert.equal(f.rpcCalls.filter(c=>c.name==='reserve').length,1);assert.equal(f.rpcCalls.filter(c=>c.name==='claim').length,4);assert.equal(result.usage.prompt_tokens,6);assert.equal(result.usage.completion_tokens,9);assert.ok(f.calls.every(c=>c.payload.n===undefined&&c.payload.model.startsWith('station-wire-')));assert.equal(JSON.stringify(result).includes('private error body'),false);assert.equal(result.gateway.saved,true);
});
test('multi-stream emits one choice per frame with contiguous indices and one DONE',async()=>{
 const f=await fixture((url,o)=>stream(new URL(url).hostname,Number(new URL(url).hostname[1])*5,false,o.signal),3),r=await f.gateway(f.req({model,messages:[{role:'user',content:'x'}],stream:true,n:2})),text=await r.text();
 const frames=text.split('\n\n').filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));assert.deepEqual([...new Set(frames.flatMap(x=>x.choices?.filter(c=>c.delta.content).map(c=>c.index)||[]))],[0,1,2]);assert.equal(text.match(/\[DONE\]/g).length,1);assert.ok(frames.every(x=>x.model===model));assert.equal(f.saved.length,3);
});
test('ordinary single-stream clients get one reply; other replies remain retrievable',async()=>{
 const f=await fixture((_u,o)=>stream('OK',1,false,o.signal),3),r=await f.gateway(f.req({model,messages:[{role:'user',content:'x'}],stream:true,n:1})),s=await r.text();assert.ok(!s.includes('"index":1'));assert.equal(f.saved.length,3);const stored=await (await f.gateway(f.req(undefined,'/v1/replies/'+logId))).json();assert.equal(stored.replies.length,3);
});
test('JSON upstreams are accepted even when streaming was requested, including text parts',async()=>{
 const f=await fixture(()=>json([{type:'text',text:'JSON OK'}]),1),s=await (await f.gateway(f.req({model,messages:[{role:'user',content:'x'}],stream:true,n:2}))).text();assert.ok(s.includes('JSON OK'));assert.equal(f.saved[0].message.content,'JSON OK');
});
test('a partially delivered reply is kept as a candidate without losing other stations',async()=>{
 const f=await fixture((url,o)=>stream(new URL(url).hostname,1,url.includes('p1.'),o.signal),2),result=await (await f.gateway(f.req())).json();assert.equal(result.choices.length,2);assert.equal(f.saved.find(r=>r.provider_name==='Station 1').status,'partial');assert.equal(f.rpcCalls.find(c=>c.name==='finish').args.p_status,'success');
});
test('model-less heartbeats and role chunks time out without an empty candidate',async()=>{
 const f=await fixture(async(_url,o)=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(': ping\n\n'+event({choices:[{delta:{role:'assistant',reasoning_content:'thinking'}}]})));o.signal.addEventListener('abort',()=>c.error(new Error('abort')));}}),{headers:{'content-type':'text/event-stream'}}),1);const r=await f.gateway(f.req());assert.equal(r.status,503);assert.equal(f.saved[0].choice_index,null);assert.equal(f.saved[0].reason,'timeout');assert.equal(f.rpcCalls.find(c=>c.name==='finish').args.p_status,'failed');
});
test('provider circuit/quotas skip a station without sending it a request',async()=>{
 const f=await fixture(()=>json('OK'),2),old=f.db.rpc;f.db.rpc=async(name,args)=>name==='claim'&&args.p_provider===f.providers[0].id?false:old(name,args);const result=await (await f.gateway(f.req())).json();assert.equal(f.calls.length,1);assert.equal(result.choices.length,1);assert.equal(f.saved.find(r=>r.provider_name==='Station 1').status,'skipped');
});
test('all failed responses refund the logical call and retain site diagnostics',async()=>{
 const f=await fixture(()=>new Response('{}',{status:503}),3);assert.equal((await f.gateway(f.req())).status,503);assert.equal(f.saved.length,3);assert.ok(f.saved.every(r=>r.status==='failed'));assert.equal(f.rpcCalls.find(c=>c.name==='finish').args.p_status,'failed');
});
test('two upstream IDs of one station are mapped to one call, preferring verified route',async()=>{
 const f=await fixture(()=>json('OK'),1);f.models.push({...f.models[0],model_id:model,status:'available'});await f.gateway(f.req());assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.model,model);
});
test('reply lookup requires an owned log before reading any saved contents',async()=>{
 const f=await fixture(()=>json('OK'),1);const old=f.db.table;f.db.table=async(name,q)=>name==='logs'?[]:old(name,q);const r=await f.gateway(f.req(undefined,'/v1/replies/'+logId));assert.equal(r.status,404);
});
test('unknown official names and invalid n values reject before provider quota reservation',async()=>{
 const f=await fixture(()=>json('OK'),1);assert.equal((await f.gateway(f.req({model:'gpt-missing',messages:[{role:'user',content:'x'}]}))).status,400);assert.equal((await f.gateway(f.req({model,messages:[{role:'user',content:'x'}],n:0}))).status,400);assert.equal(f.calls.length,0);assert.equal(f.rpcCalls.length,0);
});
