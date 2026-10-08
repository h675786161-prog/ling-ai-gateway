import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGateway,seal,digest,randomKey} from '../src/gateway.mjs';
import {canonicalName,canonicalID,createModelDirectory} from '../src/model-directory.mjs';
const model='gemini-2.5-flash',logId='33333333-3333-4333-8333-333333333333';
const event=o=>'data: '+JSON.stringify(o)+'\n\n';
const json=content=>Response.json({model:'raw-returned',choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3}});
function stream(text,delay=1,truncate=false,signal){let timer;return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(event({choices:[{index:0,delta:{role:'assistant'}}]})));timer=setTimeout(()=>{try{c.enqueue(new TextEncoder().encode(event({model:'raw-returned',choices:[{index:0,delta:{content:text}}]})));if(!truncate)c.enqueue(new TextEncoder().encode(event({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3}})+'data: [DONE]\n\n'));c.close();}catch{}},delay);signal?.addEventListener('abort',()=>{clearTimeout(timer);try{c.error(new DOMException('Aborted','AbortError'));}catch{}},{once:true});},cancel(){clearTimeout(timer);}}),{headers:{'content-type':'text/event-stream'}});}
async function fixture(fetcher,count=4,settings={routing_mode:'parallel',multi_reply_limit:0},timings={firstTimeout:50,totalTimeout:500}){const secret=randomKey(),token=randomKey(),hashed=await digest(token),cipher=await seal('upstream-hidden',secret);
 const providers=Array.from({length:count},(_,i)=>({id:'11111111-1111-4111-8111-'+String(i+1).padStart(12,'0'),name:'Station '+(i+1),kind:'custom',base_url:'https://p'+(i+1)+'.example.org/v1',secret_cipher:cipher,enabled:true,priority:i,aliases:{}}));
 const models=providers.map((p,i)=>({provider_id:p.id,model_id:'station-wire-'+(i+1),canonical_id:model,listed:true,status:'unchecked'})),saved=[],rpcCalls=[],patches=[],calls=[];
 const db={async table(name,q=''){if(name==='keys')return q.includes(hashed)?[{id:'key',user_id:'owner',enabled:true,admin_access:false}]:[];if(name==='users')return[{id:'owner',role:'admin',enabled:true}];if(name==='settings')return[{public_enabled:true,max_output_tokens:4096,...settings}];if(name==='providers')return providers;if(name==='models')return models;if(name==='logs')return q.includes('user_id=eq.owner')?[{id:logId,model,status:'success'}]:[];if(name==='replies')return saved;return[];},async rpc(name,args){rpcCalls.push({name,args});return name==='reserve_routed'?{id:logId}:name==='claim'?true:undefined;},async write(name,method,data,q){if(name==='replies')saved.push(structuredClone(data));if(name==='models')patches.push(data);return[data];}};
 const gateway=createGateway({SUPABASE_SERVICE_ROLE_KEY:secret},{db,fetcher:async(url,o)=>{calls.push({url,payload:JSON.parse(o.body)});return fetcher(url,o);},...timings});
 const req=(b={model,messages:[{role:'user',content:'fixture'}]},path='/v1/chat/completions')=>new Request('https://gateway.example.org'+path,{method:path==='/v1/chat/completions'?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:path==='/v1/chat/completions'?JSON.stringify(b):undefined});
 return {gateway,req,db,providers,models,saved,rpcCalls,patches,calls};
}
test('merged model routing forwards large limits unchanged and does not add an unlimited default',async()=>{
 const f=await fixture(()=>json('OK'),1,{max_output_tokens:null});
 for(const parameters of [{max_tokens:65536},{max_completion_tokens:131072},{},{max_tokens:null,max_completion_tokens:null},{max_tokens:65536,max_completion_tokens:131072}]){
  assert.equal((await f.gateway(f.req({model,messages:[{role:'user',content:'fixture'}],...parameters}))).status,200);
 }
 assert.equal(f.calls[0].payload.max_tokens,65536);assert.equal(f.calls[1].payload.max_completion_tokens,131072);assert.ok(!('max_tokens' in f.calls[1].payload));
 for(const call of f.calls.slice(2,4)){assert.ok(!('max_tokens' in call.payload));assert.ok(!('max_completion_tokens' in call.payload));}
 assert.equal(f.calls[4].payload.max_completion_tokens,131072);assert.ok(!('max_tokens' in f.calls[4].payload));
});
test('configured merged-model output cap remains enforced before any reservation or upstream request',async()=>{
 const f=await fixture(()=>json('OK'),1,{max_output_tokens:65536});
 for(const field of ['max_tokens','max_completion_tokens'])assert.equal((await f.gateway(f.req({model,messages:[{role:'user',content:'fixture'}],[field]:131072}))).status,400);
 assert.equal(f.calls.length,0);assert.equal(f.rpcCalls.length,0);
 assert.equal((await f.gateway(f.req())).status,200);assert.equal(f.calls[0].payload.max_tokens,65536);
});
test('long SSE answers above the old cumulative 1 MB ceiling complete and persist all text',async()=>{
 const piece='long answer '.repeat(90),expected=piece.repeat(1100),encoder=new TextEncoder();let at=0;
 const f=await fixture(()=>new Response(new ReadableStream({pull(controller){
  if(at++<1100)controller.enqueue(encoder.encode(event({choices:[{index:0,delta:{content:piece}}]})));
  else {controller.enqueue(encoder.encode(event({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n'));controller.close();}
 }}),{headers:{'content-type':'text/event-stream'}}),1,{max_output_tokens:null});
 const response=await f.gateway(f.req({model,messages:[{role:'user',content:'fixture'}],stream:true,max_tokens:131072})),body=await response.text();
 assert.equal(response.status,200);assert.ok(body.length>1048576);assert.ok(body.endsWith('data: [DONE]\n\n'));assert.equal(f.saved[0].status,'success');assert.equal(f.saved[0].message.content,expected);
});
test('non-streaming upstream fallback accepts a long JSON answer above 1 MB',async()=>{
 const expected='long answer '.repeat(100000),f=await fixture(()=>json(expected),1,{max_output_tokens:null});
 const response=await f.gateway(f.req());assert.equal(response.status,200);assert.equal((await response.json()).choices[0].message.content,expected);assert.equal(f.saved[0].status,'success');
});
test('unterminated oversized SSE frames are still rejected without buffering an entire unbounded answer',async()=>{
 const f=await fixture(()=>new Response('data: '+ 'x'.repeat(1048577),{headers:{'content-type':'text/event-stream'}}),1,{max_output_tokens:null});
 const response=await f.gateway(f.req());assert.equal(response.status,503);assert.equal(f.saved[0].reason,'response_too_large');
});
test('canonical IDs strip namespaces/free suffixes, keep dates and versions, hide unknown labels',()=>{
 assert.equal(canonicalName('google/gemini-2.5-flash:free','openrouter'),model);assert.equal(canonicalName('@cf/meta/llama-3.1-8b-instruct','cloudflare'),'llama-3.1-8b-instruct');
 assert.equal(canonicalName('My Site/gemini-2.5-flash','custom','My Site'),model);assert.equal(canonicalName('gemini-2.5-flash-My Site','custom','My Site'),model);
 assert.equal(canonicalName('openrouter/free','openrouter'),null);assert.equal(canonicalName('VIP Claude special','custom'),null);assert.notEqual(canonicalName('gpt-4o-2024-08-06'),canonicalName('gpt-4o'));
 assert.throws(()=>canonicalID('brand/model'),/invalid_canonical_model/);assert.throws(()=>canonicalID('fast'));
});
test('model endpoint deduplicates names, omits disabled stations and leaks no wire ID or secret',async()=>{
 const f=await fixture(()=>json('OK'));f.providers[3].enabled=false;const r=await f.gateway(f.req(undefined,'/v1/models')),data=await r.json();assert.deepEqual(data.data.map(m=>m.id),[model]);assert.equal(data.data[0].gateway.site_count,3);assert.equal(JSON.stringify(data).includes('station-wire'),false);assert.equal(JSON.stringify(data).includes('cipher'),false);
});
test('private merged-directory test plan uses the same unique enabled wire routes as chat and exposes no credentials',async()=>{
 const f=await fixture(()=>json('OK'));f.providers[3].enabled=false;f.models.push({...f.models[0],model_id:model,status:'available'});
 const directory=createModelDirectory({db:f.db,digest}),privateList=await directory.list(false),publicList=await directory.list(),routes=(await directory.routes(model)).routes;
 const plan=privateList.data[0].gateway.probe_routes;assert.equal(plan.length,3);assert.deepEqual(plan.map(r=>r.model_id),routes.map(r=>r.model_id));assert.equal(plan[0].model_id,model);assert.equal(new Set(plan.map(r=>r.provider_id)).size,3);
 assert.equal(publicList.data[0].gateway.probe_routes,undefined);assert.ok(!JSON.stringify(plan).includes('secret_cipher'));assert.ok(!JSON.stringify(plan).includes('upstream-hidden'));assert.ok(plan.every(r=>!r.base_url));
});
test('reviewed names follow Ling grouping policy without mixing dated model versions',()=>{
 assert.equal(canonicalName('[NV]gemma-4-31b'),'gemma-4-31b-it');assert.equal(canonicalName('[G]Kimi-2.6'),'kimi-k2.6');assert.equal(canonicalName('[OR]north-mini-code'),'north-mini-code');
 assert.equal(canonicalName('[NV]diffusiongemma-26b-a4b'),'diffusiongemma-26b-a4b-it');
 assert.equal(canonicalName('假流式-gemini-2.5-pro-cache'),'gemini-2.5-pro');assert.equal(canonicalName('抗截断-gemini-3.1-pro-preview'),'gemini-3.1-pro-preview');assert.equal(canonicalName('防截断-gemini-3.1-pro-preview'),'gemini-3.1-pro-preview');
 assert.equal(canonicalID('假流式-gemini-2.5-pro'),'假流式-gemini-2.5-pro');assert.throws(()=>canonicalID('随意前缀-gemini-2.5-pro'));
 assert.equal(canonicalName('gemini-2.5-pro-search'),'gemini-2.5-pro');assert.equal(canonicalName('muse-spark-1.3-contributor-free'),'muse-spark-1.3-contributor');
 assert.equal(canonicalName('step-3.5-flash'),'step-3.5-flash');assert.equal(canonicalName('step-3.5-flash-2603'),null);assert.equal(canonicalName('agnes-3.0-flash'),null);
 assert.equal(canonicalName('qwen3-embedding-8b'),null);assert.equal(canonicalName('x-ai/grok-imagine-image'),null);assert.equal(canonicalName('[OR]llama-nemotron-rerank-vl-1b-v2'),null);
 assert.notEqual(canonicalName('deepseek-v4-flash-0731'),canonicalName('deepseek-v4-flash'));
});
test('private review distinguishes unknown, manual hiding and dedicated APIs; public catalog reveals none of it',async()=>{
 const f=await fixture(()=>json('OK'),2);f.providers[1].enabled=false;
 for(const [model_id,canonical_source]of [['agnes-3.0-flash','auto'],['hidden-alias','manual'],['BAAI/bge-m3','auto']])f.models.push({provider_id:f.providers[1].id,model_id,listed:true,canonical_source,canonical_id:null,config_hash:'private-hash',lease_token:'private-lease'});
 const directory=createModelDirectory({db:f.db,digest}),review=(await directory.list(false)).mapping;
 assert.deepEqual(review.counts,{total:5,mapped:2,unrecognized:1,hidden:1,non_chat:1});assert.equal(review.entries.find(x=>x.model_id==='hidden-alias').state,'hidden');assert.equal(review.entries.find(x=>x.model_id==='agnes-3.0-flash').enabled,false);
 for(const hidden of ['secret_cipher','base_url','private-hash','private-lease','upstream-hidden'])assert.equal(JSON.stringify(review).includes(hidden),false);
 const publicCatalog=await directory.list();assert.equal(publicCatalog.mapping,undefined);assert.equal(JSON.stringify(publicCatalog).includes('agnes'),false);assert.deepEqual(publicCatalog.data.map(x=>x.id),[model]);
 assert.equal((await f.gateway(f.req(undefined,'/admin/model-directory'))).status,401);
});
test('explicit manual transport mappings remain selectable and keep upstream IDs intact',async()=>{
 const f=await fixture(()=>json('OK'),3);f.models[0].canonical_id='gemini-2.5-pro';f.models[1].canonical_id='假流式-gemini-2.5-pro';f.models[2].canonical_id='抗截断-gemini-2.5-pro';
 const response=await(await f.gateway(f.req({model:'假流式-gemini-2.5-pro',messages:[{role:'user',content:'x'}]}))).json();assert.equal(response.model,'假流式-gemini-2.5-pro');assert.equal(f.calls.length,1);assert.equal(f.calls[0].payload.model,'station-wire-2');
 const catalog=await(await f.gateway(f.req(undefined,'/v1/models'))).json();assert.deepEqual(new Set(catalog.data.map(x=>x.id)),new Set(['gemini-2.5-pro','假流式-gemini-2.5-pro','抗截断-gemini-2.5-pro']));
});
test('CLI station prefixes and Gemini or Claude option suffixes group by model while keeping versions intact',()=>{
 const examples=[['agycli-claude-opus-5-5-high','claude-opus-5-5'],['agycli-claude-opus-5-5-high-假流式','claude-opus-5-5'],['agycli-claude-sonnet-5-5-medium-抗截断','claude-sonnet-5-5'],['agycli-gemini-3.5-flash-extra-low-search','gemini-3.5-flash'],['agycli-gemini-3.6-flash-tiered-抗截断','gemini-3.6-flash'],['agycli-gemini-3.8-flash-medium-假流式','gemini-3.8-flash'],['gcli-gemini-3.1-flash-lite-preview-search','gemini-3.1-flash-lite-preview'],['gcli-gemini-2.5-pro-假流式','gemini-2.5-pro']];
 for(const [raw,expected]of examples)assert.equal(canonicalName(raw),expected,raw);
 assert.notEqual(canonicalName('agycli-gemini-3.6-flash-high'),canonicalName('gcli-gemini-3.8-flash'));
 assert.equal(canonicalName('agycli-gemini-pro-agent'),null);assert.equal(canonicalName('agycli-gemini-pro-agent-search'),null);
 assert.equal(canonicalName('agycli-gemini-3.1-flash-image-假流式'),null);
 assert.equal(canonicalName('gcli-made-up-alias'),null);
});
test('unknown models keep exact original IDs, deduplicate only identical names and route without guessed identities',async()=>{
 const f=await fixture(()=>json('Original'),3),original='Mystery/Alpha [v1]';for(let i=0;i<2;i++){f.models[i].canonical_id=null;f.models[i].canonical_source='auto';f.models[i].model_id=original;}
 const catalog=await(await f.gateway(f.req(undefined,'/v1/models'))).json();const entry=catalog.data.find(x=>x.id===original);assert.equal(entry.gateway.naming,'original');assert.equal(entry.gateway.site_count,2);assert.equal(catalog.data.filter(x=>x.id===original).length,1);assert.ok(!JSON.stringify(catalog).includes('Station'));
 const result=await(await f.gateway(f.req({model:original,messages:[{role:'user',content:'x'}]}))).json();assert.equal(result.model,original);assert.equal(f.calls.length,2);assert.ok(f.calls.every(c=>c.payload.model===original));
 f.models.push({provider_id:f.providers[2].id,model_id:'[NV]diffusiongemma-26b-a4b',canonical_id:null,canonical_source:'auto',listed:true});assert.ok((await(await f.gateway(f.req(undefined,'/v1/models'))).json()).data.some(m=>m.id==='[NV]diffusiongemma-26b-a4b'));
 f.models[0].canonical_source='manual';const directory=createModelDirectory({db:f.db,digest});assert.equal((await directory.routes(original)).routes.length,1);
});
test('all matching stations start in parallel; first visible text wins; every response saved',async()=>{
 let arrived=0,release;const barrier=new Promise(r=>release=r);const f=await fixture(async(url,o)=>{if(++arrived===4)release();await barrier;const n=Number(new URL(url).hostname[1]);return n===4?new Response('private error body',{status:429}):stream('Reply '+n,n===2?1:n===1?15:30,false,o.signal);});
 const result=await (await f.gateway(f.req())).json();assert.equal(f.calls.length,4);assert.deepEqual(result.choices.map(c=>c.message.content),['Reply 2','Reply 1','Reply 3']);assert.deepEqual(result.choices.map(c=>c.index),[0,1,2]);assert.equal(result.model,model);assert.equal(f.saved.length,4);assert.equal(f.saved.find(r=>r.http_status===429).reason,'http_429');assert.equal(f.rpcCalls.filter(c=>c.name==='reserve_routed').length,1);assert.equal(f.rpcCalls.filter(c=>c.name==='claim').length,4);assert.equal(result.usage.prompt_tokens,6);assert.equal(result.usage.completion_tokens,9);assert.ok(f.calls.every(c=>c.payload.n===undefined&&c.payload.model.startsWith('station-wire-')));assert.equal(JSON.stringify(result).includes('private error body'),false);assert.equal(result.gateway.saved,true);
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

test('smart fast response leaves other stations uncalled and exposes actual attempt count',async()=>{
 const f=await fixture(()=>json('Fast'),3,{routing_mode:'smart',hedge_delay_ms:20});const result=await(await f.gateway(f.req())).json();assert.equal(f.calls.length,1);assert.equal(f.saved.length,1);assert.equal(result.gateway.routing_mode,'smart');assert.equal(result.gateway.attempted_sites,1);assert.equal(result.gateway.not_started_sites,2);assert.equal(f.rpcCalls.find(r=>r.name==='reserve_routed').args.p_mode,'smart');assert.ok(f.saved[0].first_token_ms>=0);
});
test('smart delayed backup preserves both complete responses and never calls a third site',async()=>{
 const f=await fixture((url,o)=>stream(new URL(url).hostname,url.includes('p1.')?40:1,false,o.signal),3,{routing_mode:'smart',hedge_delay_ms:10});const r=await(await f.gateway(f.req())).json();assert.deepEqual(r.choices.map(c=>c.message.content),['p2.example.org','p1.example.org']);assert.equal(f.calls.length,2);assert.equal(f.saved.length,2);assert.equal(f.patches.filter(p=>p.first_token_ms>=0).length,2);
});
test('smart HTTP failure starts backup before its one-second soft delay',async()=>{
 const f=await fixture(url=>url.includes('p1.')?new Response('limited',{status:429}):json('Backup'),3,{routing_mode:'smart',hedge_delay_ms:1000});const start=Date.now(),result=await(await f.gateway(f.req())).json();assert.equal(result.choices[0].message.content,'Backup');assert.equal(f.calls.length,2);assert.ok(Date.now()-start<500);assert.equal(f.saved.find(r=>r.http_status===429).reason,'http_429');
});
test('sequential timeout switches to another station with one logical quota reservation',async()=>{
 const f=await fixture((url,o)=>url.includes('p1.')?new Response(new ReadableStream({start(c){o.signal.addEventListener('abort',()=>c.error(new Error('aborted')));}}),{headers:{'content-type':'text/event-stream'}}):json('Backup'),3,{routing_mode:'sequential'});const result=await(await f.gateway(f.req())).json();assert.equal(result.choices.length,1);assert.equal(f.calls.length,2);assert.equal(f.saved.find(r=>r.provider_name==='Station 1').reason,'timeout');assert.equal(f.rpcCalls.filter(r=>r.name==='reserve_routed').length,1);
});
test('parallel limit controls real upstream generation rather than truncating collected replies',async()=>{
 const f=await fixture(()=>json('OK'),4,{routing_mode:'parallel',multi_reply_limit:2});const result=await(await f.gateway(f.req())).json();assert.equal(f.calls.length,2);assert.equal(result.choices.length,2);assert.equal(result.gateway.not_started_sites,2);
});
test('cancellation during quota claim never sends a request or poisons circuit and model health',async()=>{
 const f=await fixture(()=>json('Never'),3,{routing_mode:'smart',hedge_delay_ms:10}),controller=new AbortController(),original=f.db.rpc;f.db.rpc=async(name,args)=>{if(name==='claim')controller.abort();return original(name,args);};const r=await f.gateway(new Request(f.req(),{signal:controller.signal}));assert.equal(r.status,503);assert.equal(f.calls.length,0);assert.equal(f.saved[0].reason,'cancelled');assert.equal(f.patches.length,0);assert.equal(f.rpcCalls.filter(c=>c.name==='route_result').length,0);
});
test('routing settings reject invalid values, require admin sessions, and do not overwrite sharing',async()=>{
 const f=await fixture(()=>json('Unused'),1),original=f.db.table,writes=[];f.db.write=async(name,method,data)=>{writes.push({name,data});return[data];};const request=body=>new Request('https://gateway.example.org/admin/settings',{method:'PATCH',headers:f.req().headers,body:JSON.stringify(body)});assert.equal((await f.gateway(request({routing_mode:'smart'}))).status,401);f.db.table=async(name,q)=>{const data=await original(name,q);return name==='keys'?data.map(k=>({...k,admin_access:true})):data;};for(const body of [{routing_mode:'wrong'},{hedge_delay_ms:999},{multi_reply_limit:1}])assert.equal((await f.gateway(request(body))).status,400);assert.equal(writes.length,0);assert.equal((await f.gateway(request({routing_mode:'smart',hedge_delay_ms:4000,multi_reply_limit:3}))).status,200);assert.deepEqual(writes[0].data,{routing_mode:'smart',hedge_delay_ms:4000,multi_reply_limit:3});
});
test('slow reasoning waits for the saved first-output timeout while smart backup still starts promptly',async()=>{
 const encoder=new TextEncoder(),f=await fixture((url,o)=>{
  if(!url.includes('p1.'))return stream('fast backup',1,false,o.signal);
  let timer;return new Response(new ReadableStream({start(c){c.enqueue(encoder.encode(event({choices:[{index:0,delta:{reasoning_content:'Still thinking'}}]})));timer=setTimeout(()=>{c.enqueue(encoder.encode(event({choices:[{index:0,delta:{content:'slow answer'}}]})+event({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n'));c.close();},120);o.signal.addEventListener('abort',()=>{clearTimeout(timer);try{c.error(new Error('abort'));}catch{}},{once:true});},cancel(){clearTimeout(timer);}}),{headers:{'content-type':'text/event-stream'}});
 },3,{routing_mode:'smart',hedge_delay_ms:20,first_output_timeout_ms:250},{totalTimeout:500});
 const response=await(await f.gateway(f.req())).json();assert.deepEqual(response.choices.map(c=>c.message.content),['fast backup','slow answer']);assert.equal(f.calls.length,2);assert.ok(f.saved.every(r=>r.status==='success'));
});
test('Chinese HTTP diagnostics survive failover, stream errors and later saved-reply lookup',async()=>{
 const f=await fixture((_url,o)=>Response.json({error:{code:'model_not_allowed',message:'This model is not allowed. Bearer '+o.headers.authorization.slice(7)}},{status:403}),2);
 const response=await f.gateway(f.req({model,messages:[{role:'user',content:'x'}],stream:true})),body=await response.text();assert.ok(body.includes('HTTP 403'));assert.ok(body.includes('上游没有提供这个模型'));assert.ok(body.includes('Station 1'));assert.ok(!body.includes('upstream-hidden'));assert.ok(body.includes('all_providers_unavailable'));
 const stored=await(await f.gateway(f.req(undefined,'/v1/replies/'+logId))).json();assert.equal(stored.replies.length,2);assert.ok(stored.replies[0].diagnostic.summary_zh.includes('模型'));assert.ok(!JSON.stringify(stored).includes('upstream-hidden'));
 assert.ok(f.rpcCalls.find(c=>c.name==='finish').args.p_attempts[0].diagnostic.upstream_code==='model_not_allowed');
});
test('reasoning-only timeouts are translated clearly without becoming empty candidate replies',async()=>{
 const f=await fixture((_url,o)=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(event({choices:[{delta:{reasoning_content:'thinking'}}]})));o.signal.addEventListener('abort',()=>c.error(new Error('aborted')));}}),{headers:{'content-type':'text/event-stream'}}),1);
 const response=await f.gateway(f.req()),body=await response.json();assert.equal(response.status,503);assert.ok(body.error.message.includes('已在思考'));assert.equal(body.gateway.reply_count,0);assert.equal(f.saved[0].diagnostic.reasoning_received,true);
});
test('old failure records receive readable diagnostics without inventing an upstream error message',async()=>{
 const f=await fixture(()=>json('unused'),1);f.saved.push({provider_name:'old slow',status:'failed',reason:'timeout',http_status:200,latency_ms:18089,message:{content:'',reasoning_content:'reasoning'}});
 const stored=await(await f.gateway(f.req(undefined,'/v1/replies/'+logId))).json();assert.equal(stored.replies[0].diagnostic.wait_seconds,18);assert.equal(stored.replies[0].diagnostic.upstream_message,null);assert.ok(stored.replies[0].diagnostic.summary_zh.includes('已在思考'));
});
