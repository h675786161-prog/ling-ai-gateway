import {canonicalName,canonicalID,modelRows} from './model-directory.mjs';
import {directoryModelID} from './model-names.mjs';
import {readUpstreamError,errorObject,failureDiagnostic} from './diagnostics.mjs';
// Real per-model checks: never use the gateway's failover router during a probe.
export const MODEL_STATES={available:'可用',timeout:'超时',rate_limited:'限流',unauthorized:'没有权限',not_found:'模型不存在',unsupported:'请求不支持',empty:'没有文字',network_error:'连接失败',error:'上游报错',no_credit:'余额不足',unchecked:'未检查'};
export function modelEndpoint(provider) {
 return provider.kind==='cloudflare'?provider.base_url.replace(/\/v1$/,'')+'/models/search?task=Text%20Generation&per_page=1000':provider.base_url+'/models';
}
export function normalizeCatalog(data,kind) {
 let source=kind==='cloudflare'?data.result:data.data;
 if(!Array.isArray(source))throw new Error('invalid_model_catalog');
 if(kind==='cloudflare')source=source.filter(m=>!m.task?.name||m.task.name==='Text Generation'||m.task.id==='text-generation');
 const seen=new Set(),models=[];
 for(const item of source){const id=String((kind==='cloudflare'?item.name:item.id)||item.name||'').replace(/^models\//,'');
  if(!id||id.length>200||/[\r\n\0]/.test(id)||seen.has(id))continue;
  if(kind==='openrouter'&&id!=='openrouter/free'&&!id.endsWith(':free'))continue;
  if(kind==='gemini'&&!id.startsWith('gemini-'))continue;
  if(item.architecture?.output_modalities&&!item.architecture.output_modalities.includes('text'))continue;
  seen.add(id);models.push({id,name:String(item.name||id).slice(0,200)});
 }
 if(kind==='openrouter'&&!seen.has('openrouter/free'))models.unshift({id:'openrouter/free',name:'OpenRouter 免费自动选择'});
 if(models.length>1000)throw new Error('catalog_too_large');
 return models;
}
export function probeStatus(http) {
 if(http===401||http===403)return 'unauthorized';if(http===404)return 'not_found';if(http===429)return 'rate_limited';if(http===402)return 'no_credit';if(http===400||http===405||http===422)return 'unsupported';return 'error';
}
function textValue(content) {
 if(typeof content==='string')return content.trim();
 if(Array.isArray(content))return content.map(p=>typeof p.text==='string'?p.text:'').join('').trim();return '';
}
async function boundedJSON(response,maxBytes=524288) {
 const reader=response.body?.getReader();if(!reader)throw new Error('invalid_response');let bytes=0,parts=[];
 try{while(true){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>maxBytes)throw new Error('response_too_large');parts.push(r.value);}}finally{await reader.cancel().catch(()=>{});}
 const result=new Uint8Array(bytes);let offset=0;for(const b of parts){result.set(b,offset);offset+=b.length;}return JSON.parse(new TextDecoder().decode(result));
}
export async function discoverModels(provider,key,fetcher=fetch) {
 const r=await fetcher(modelEndpoint(provider),{headers:{authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(10000)});
 if(!r.ok){await r.body?.cancel();const e=new Error('model_catalog_http_'+r.status);e.http=r.status;throw e;}
 return normalizeCatalog(await boundedJSON(r,8388608),provider.kind);
}
export async function probeModel(provider,key,model,{fetcher=fetch,timeoutMs=12000,signal}={}) {
 const started=Date.now(),controller=new AbortController();let expired=false,reader;
 const abort=()=>controller.abort();if(signal?.aborted)controller.abort();else signal?.addEventListener('abort',abort,{once:true});
 const timer=setTimeout(()=>{expired=true;controller.abort();},timeoutMs);
 const result={model_id:model,status:'network_error',http_status:0,latency_ms:0,returned_model:null};
 try {
  const response=await fetcher(provider.base_url+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},redirect:'error',signal:controller.signal,
   body:JSON.stringify({model,messages:[{role:'user',content:'Reply with only OK.'}],stream:true})});
  result.http_status=response.status;
  if(!response.ok){result.status=probeStatus(response.status);Object.assign(result,await readUpstreamError(response,{secrets:[key]}));return result;}
  if(!response.headers.get('content-type')?.includes('text/event-stream')){
   const data=await boundedJSON(response);
   result.returned_model=typeof data.model==='string'?data.model.slice(0,200):null;
   if(data.error)Object.assign(result,errorObject(data,{secrets:[key]}));result.status=data.error?probeStatus(Number(data.error.status)||502):textValue(data.choices?.[0]?.message?.content)?'available':'empty';return result;
  }
  reader=response.body.getReader();const decoder=new TextDecoder();let buffer='',bytes=0;
  while(true){const chunk=await reader.read();if(chunk.done){result.status='empty';break;}bytes+=chunk.value.length;if(bytes>524288)throw new Error('response_too_large');
   buffer+=decoder.decode(chunk.value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let index;
   while((index=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,index);buffer=buffer.slice(index+2);const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)continue;
    if(data==='[DONE]'){result.status='empty';return result;}
    const obj=JSON.parse(data);if(obj.error){Object.assign(result,errorObject(obj,{secrets:[key]}));result.status=probeStatus(Number(obj.error.status)||Number(obj.error.code)||502);return result;}
    if(typeof obj.model==='string')result.returned_model=obj.model.slice(0,200);
    if(textValue(obj.choices?.[0]?.delta?.content)||textValue(obj.choices?.[0]?.message?.content)){result.status='available';return result;}
   }
  }
 }catch(e){result.status=signal?.aborted?'cancelled':expired?'timeout':e instanceof SyntaxError||e.message==='response_too_large'?'error':'network_error';}
 finally {result.latency_ms=Date.now()-started;result.diagnostic=result.status==='available'?null:failureDiagnostic({...result,reason:result.status==='timeout'?'timeout':result.status==='empty'?'empty_response':result.status==='cancelled'?'cancelled':'upstream_error',wait_seconds:timeoutMs/1000});controller.abort();clearTimeout(timer);signal?.removeEventListener('abort',abort);await reader?.cancel().catch(()=>{});}
 return result;
}
export function createModelChecks({db,fetcher,validBase,resolveDNS,verifyDNS,unseal,digest,secret}) {
 const idOK=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
 const modelOK=m=>typeof m==='string'&&m.length>=1&&m.length<=200&&!/[\r\n\0]/.test(m);
 const hash=p=>digest(p.kind+'\n'+p.base_url+'\n'+JSON.stringify(p.secret_cipher));
 async function provider(id){if(!idOK(id))throw new Error('invalid_id');const p=(await db.table('providers','?id=eq.'+id))[0];if(!p)throw new Error('provider_not_found');return p;}
 async function prepare(p){if(!p.secret_cipher)throw new Error('provider_key_required');validBase(p.base_url,p.kind);await verifyDNS(new URL(p.base_url).hostname,resolveDNS);return unseal(p.secret_cipher,secret);}
 async function list(p){const rows=await db.table('models','?provider_id=eq.'+p.id+'&listed=eq.true&order=model_id.asc&limit=1000'),current=await hash(p);return rows.map(({config_hash,lease_token,lease_until,...r})=>({...r,directory_id:directoryModelID(r),stale:!!config_hash&&config_hash!==current,checking:!!lease_until&&Date.parse(lease_until)>Date.now()}));}
 return {
  async list(id){return {models:await list(await provider(id))};},
  async discover(id){const p=await provider(id),key=await prepare(p),models=(await discoverModels(p,key,fetcher)).map(m=>({...m,canonical_id:canonicalName(m.id,p.kind,p.name)}));await db.rpc('model_catalog',{p_provider:id,p_models:models});return {models:await list(p),catalog_count:models.length};},
  async add(id,models){const p=await provider(id);if(!Array.isArray(models)||!models.length||models.length>100||models.some(m=>!modelOK(m)))throw new Error('invalid_models');
   if(p.kind==='openrouter'&&models.some(m=>m!=='openrouter/free'&&!m.endsWith(':free')))throw new Error('openrouter_free_models_only');
   const existing=await modelRows(db,'?provider_id=eq.'+id);
   await db.request('ling_gateway_models?on_conflict=provider_id,model_id','POST',[...new Set(models)].map(m=>{const old=existing.find(x=>x.model_id===m);return {provider_id:id,model_id:m,name:m,listed:true,source:'manual',canonical_id:old?.canonical_source==='manual'?old.canonical_id:canonicalName(m,p.kind,p.name)};}),{Prefer:'resolution=merge-duplicates,return=representation'});return {models:await list(p)};},
  async map(id,model,canonical){await provider(id);if(!modelOK(model))throw new Error('invalid_models');const value=canonical===null||canonical===''?null:canonicalID(canonical);const rows=await db.write('models','PATCH',{canonical_id:value,canonical_source:'manual'},'?provider_id=eq.'+id+'&model_id=eq.'+encodeURIComponent(model));if(!rows.length)throw new Error('model_not_registered');return {models:await list(await provider(id))};},
  async probe(id,model,timeout,signal){const p=await provider(id);if(!modelOK(model))throw new Error('invalid_models');if(!Number.isInteger(timeout)||timeout<5||timeout>30)throw new Error('invalid_probe_timeout');
   if(p.kind==='openrouter'&&model!=='openrouter/free'&&!model.endsWith(':free'))throw new Error('openrouter_free_models_only');
   const key=await prepare(p),version=await hash(p),claim=await db.rpc('probe_claim',{p_provider:id,p_model:model});
   if(claim.error)return {blocked:claim.error,retry_after:claim.retry_after||0};
   const result=await probeModel(p,key,model,{fetcher,timeoutMs:timeout*1000,signal});
   let persisted;for(let i=0;i<2;i++){try{persisted=await db.rpc('probe_finish',{p_lease:claim.lease,p_status:result.status,p_http:result.http_status,p_latency:result.latency_ms,p_hash:version,p_returned:result.returned_model,p_diagnostic:result.diagnostic});break;}catch(e){if(i===1)throw e;}}
   return {result:{...result,checked_at:new Date().toISOString()},persisted};
  }
 };
}
