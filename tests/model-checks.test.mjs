import {test} from 'node:test';
import assert from 'node:assert/strict';
import {probeModel,discoverModels,normalizeCatalog,modelEndpoint,createModelChecks} from '../src/model-checks.mjs';

const provider={id:'11111111-1111-4111-8111-111111111111',kind:'custom',base_url:'https://first.example.org/v1',secret_cipher:{data:'ciphertext'},enabled:false};
const sse=text=>new Response(text,{headers:{'content-type':'text/event-stream'}});
const frame=obj=>'data: '+JSON.stringify(obj)+'\n\n';
const ok=()=>Response.json({model:'actual-model',choices:[{message:{content:'OK'}}]});
function hangingBody(signal,prefix='') {
 return new ReadableStream({start(c){if(prefix)c.enqueue(new TextEncoder().encode(prefix));signal.addEventListener('abort',()=>c.error(new DOMException('Aborted','AbortError')),{once:true});}});
}

test('metadata catalog does not send generation or claim a model is usable',async()=>{
 let count=0;const models=await discoverModels(provider,'hidden-key',async(url,options)=>{count++;assert.equal(url,provider.base_url+'/models');assert.equal(options.method,undefined);assert.equal(options.redirect,'error');return Response.json({data:[{id:'listed-only',name:'Candidate'}]});});
 assert.equal(count,1);assert.deepEqual(models,[{id:'listed-only',name:'Candidate'}]);assert.equal(models[0].status,undefined);
});
test('Cloudflare catalog uses model name rather than UUID; ignores image task',()=>{
 const p={kind:'cloudflare',base_url:'https://api.cloudflare.com/client/v4/accounts/a/ai/v1'};
 assert.ok(modelEndpoint(p).endsWith('/ai/models/search?task=Text%20Generation&per_page=1000'));
 assert.deepEqual(normalizeCatalog({result:[{id:'uuid',name:'@cf/text/model',task:{name:'Text Generation'}},{id:'uuid2',name:'@cf/image/model',task:{name:'Text-to-Image'}}]},'cloudflare').map(x=>x.id),['@cf/text/model']);
});
test('free catalog excludes paid and non-text models and deduplicates',()=>{
 const data={data:[{id:'paid/model',pricing:{prompt:'0.1'}},{id:'free/model:free'},{id:'free/model:free'},{id:'free/image:free',architecture:{output_modalities:['image']}},{id:'bad\nmodel:free'}]};
 assert.deepEqual(normalizeCatalog(data,'openrouter').map(x=>x.id),['openrouter/free','free/model:free']);
 assert.deepEqual(normalizeCatalog({data:[{id:'models/gemini-2.5-flash'},{id:'embedding-001'}]},'gemini').map(x=>x.id),['gemini-2.5-flash']);
});
test('role, reasoning, whitespace and DONE cannot create a false usable result',async()=>{
 const r=await probeModel(provider,'secret','requested',{fetcher:async()=>sse(': heartbeat\n\n'+frame({choices:[{delta:{role:'assistant',reasoning_content:'thinking',content:'  '}}]})+'data: [DONE]\n\n')});
 assert.equal(r.status,'empty');assert.equal(r.http_status,200);
});
test('real text split across chunks is accepted; first text cancels the stream',async()=>{
 const bytes=new TextEncoder().encode(frame({model:'returned-alias',choices:[{delta:{content:'好'}}]}));let cancelled=false;
 const r=await probeModel(provider,'secret','requested',{fetcher:async()=>new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,bytes.length-8));c.enqueue(bytes.slice(bytes.length-8));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}})});
 assert.equal(r.status,'available');assert.equal(r.returned_model,'returned-alias');assert.equal(r.model_id,'requested');assert.equal(cancelled,true);
});
test('probe calls exactly the selected upstream, without gateway failover',async()=>{
 const seen=[];const r=await probeModel(provider,'secret','dead-model',{fetcher:async(url,o)=>{seen.push(url);assert.deepEqual(JSON.parse(o.body),{model:'dead-model',messages:[{role:'user',content:'Reply with only OK.'}],stream:true});return new Response('secret internal body',{status:503});}});
 assert.deepEqual(seen,[provider.base_url+'/chat/completions']);assert.equal(r.status,'error');assert.equal(JSON.stringify(r).includes('secret'),false);
});
test('HTTP failures distinguish quota, permissions, model absence and format',async()=>{
 for(const [http,status]of [[401,'unauthorized'],[403,'unauthorized'],[404,'not_found'],[429,'rate_limited'],[402,'no_credit'],[400,'unsupported'],[422,'unsupported'],[502,'error']]){
  const r=await probeModel(provider,'secret','m',{fetcher:async()=>new Response('{}',{status:http})});assert.equal(r.status,status);assert.equal(r.http_status,http);
 }
});
test('HTTP 200 SSE error never counts as available',async()=>{
 const r=await probeModel(provider,'secret','m',{fetcher:async()=>sse(frame({error:{status:429,message:'private'}}))});assert.equal(r.status,'rate_limited');assert.equal(JSON.stringify(r).includes('private'),false);
});
test('JSON fallback needs actual message text, not successful headers',async()=>{
 assert.equal((await probeModel(provider,'secret','m',{fetcher:async()=>Response.json({choices:[{message:{content:''}}]})})).status,'empty');
 assert.equal((await probeModel(provider,'secret','m',{fetcher:async()=>Response.json({choices:[{message:{content:[{type:'text',text:'OK'}]}}]})})).status,'available');
});
test('timeout bounds both waiting for headers and waiting for visible body text',async()=>{
 const headers=await probeModel(provider,'secret','m',{timeoutMs:20,fetcher:async(_u,o)=>new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))});assert.equal(headers.status,'timeout');
 const body=await probeModel(provider,'secret','m',{timeoutMs:20,fetcher:async(_u,o)=>new Response(hangingBody(o.signal,frame({choices:[{delta:{reasoning_content:'thinking'}}]})),{headers:{'content-type':'text/event-stream'}})});assert.equal(body.status,'timeout');assert.equal(body.http_status,200);
});
test('user cancellation stays separate from a dead model',async()=>{
 const controller=new AbortController();setTimeout(()=>controller.abort(),15);
 const r=await probeModel(provider,'secret','m',{signal:controller.signal,fetcher:async(_u,o)=>new Response(hangingBody(o.signal),{headers:{'content-type':'text/event-stream'}})});assert.equal(r.status,'cancelled');
});
test('malformed JSON and oversized replies cannot be classified usable',async()=>{
 assert.equal((await probeModel(provider,'secret','m',{fetcher:async()=>new Response('{oops')})).status,'error');
 assert.equal((await probeModel(provider,'secret','m',{fetcher:async()=>new Response('x'.repeat(524289))})).status,'error');
});
function service(claim={lease:'lease-test'}){
 const calls=[],p={...provider},rows=[{model_id:'m',status:'available',config_hash:'old-config',lease_token:'hidden-lease',lease_until:new Date(Date.now()+10000).toISOString()}];
 const db={async table(name){return name==='providers'?[p]:rows;},async rpc(name,args){calls.push({name,args});return name==='probe_claim'?claim:true;},async request(...args){calls.push({name:'request',args});}};
 let fetches=0;const checks=createModelChecks({db,fetcher:async()=>{fetches++;return ok();},validBase:()=>true,verifyDNS:async()=>{},unseal:async()=> 'test-key',digest:async()=> 'current-config',secret:'test'});
 return {checks,calls,p,get fetches(){return fetches;}};
}
test('old station configuration invalidates results; lease and hash stay server-side',async()=>{
 const {models}=await service().checks.list(provider.id);assert.equal(models[0].stale,true);assert.equal(models[0].checking,true);assert.equal(models[0].lease_token,undefined);assert.equal(models[0].lease_until,undefined);assert.equal(models[0].config_hash,undefined);
});
test('site rate limit prevents an upstream request and does not overwrite a result',async()=>{
 const s=service({error:'provider_minute_limit',retry_after:21}),r=await s.checks.probe(provider.id,'m',12);assert.deepEqual(r,{blocked:'provider_minute_limit',retry_after:21});assert.equal(s.fetches,0);assert.deepEqual(s.calls.map(x=>x.name),['probe_claim']);
});
test('disabled station can be probed; saved result follows its original lease',async()=>{
 const s=service(),r=await s.checks.probe(provider.id,'m',12);assert.equal(s.p.enabled,false);assert.equal(s.fetches,1);assert.equal(r.result.status,'available');assert.equal(r.persisted,true);assert.equal(s.calls[1].args.p_lease,'lease-test');assert.equal(s.calls[1].args.p_hash,'current-config');
});
test('invalid time limits and paid free-provider models reject before spending requests',async()=>{
 const s=service();await assert.rejects(()=>s.checks.probe(provider.id,'m',31),/invalid_probe_timeout/);s.p.kind='openrouter';await assert.rejects(()=>s.checks.probe(provider.id,'paid/model',12),/openrouter_free_models_only/);await assert.rejects(()=>s.checks.add(provider.id,['paid/model']),/openrouter_free_models_only/);assert.equal(s.fetches,0);assert.equal(s.calls.length,0);
});
