const encoder=new TextEncoder();
const visible=m=>typeof m.content==='string'&&m.content.trim()||m.tool_calls?.length;
const text=c=>typeof c==='string'?c:Array.isArray(c)?c.map(p=>p.text||'').join(''):'';
const frame=obj=>encoder.encode('data: '+JSON.stringify(obj)+'\n\n');
export function createFanout({db,fetcher,validBase,verifyDNS,resolveDNS,unseal,secret,digest,configurationHash,persist,reply,error,firstTimeout=18000,totalTimeout=100000}) {
 async function getReplies(id,auth){if(!/^[a-f0-9-]{36}$/.test(id))return error('not_found',404);const log=(await db.table('logs','?id=eq.'+id+'&user_id=eq.'+auth.user.id))[0];if(!log)return error('not_found',404);
  const replies=await db.table('replies','?log_id=eq.'+id+'&order=choice_index.asc.nullslast,created_at.asc');return reply({id,model:log.model,status:log.status,replies});}
 async function chat(req,auth,b,routes,limit) {
  const deadline=Date.now()+totalTimeout,reservation=await db.rpc('reserve',{p_user:auth.user.id,p_model:b.model});if(reservation.error)return error(reservation.error,reservation.error==='public_closed'?403:429);
  const id=reservation.id,completionID='chatcmpl-ling-'+id,created=Math.floor(Date.now()/1000),results=[],controllers=new Set();let nextIndex=0,output,closed=false,persistenceFailed=false;
  const showAll=!b.stream||Number(b.n)>1;
  const emit=obj=>{if(b.stream&&output&&!closed){try{output.enqueue(frame({id:completionID,object:'chat.completion.chunk',created,model:b.model,...obj}));}catch{closed=true;}}};
  const disconnect=()=>controllers.forEach(c=>c.abort());if(req.signal.aborted)disconnect();req.signal.addEventListener('abort',disconnect,{once:true});
  function publish(result,delta,finish=null){if(result.choice_index===null&&visible(result.message))result.choice_index=nextIndex++;if(result.choice_index===null)return;
   if(showAll||result.choice_index===0)emit({choices:[{index:result.choice_index,delta,finish_reason:finish}],gateway:{request_id:id,provider_name:result.provider_name,upstream_model:result.upstream_model,status:finish===null?'generating':result.status}});}
  async function save(r,p,hash){try{await db.write('replies','POST',r);
    if(r.status!=='skipped')await db.write('models','PATCH',{status:r.status==='success'?'available':r.http_status===429?'rate_limited':r.http_status===401||r.http_status===403?'unauthorized':r.http_status===404?'not_found':r.reason==='timeout'?'timeout':r.http_status===402?'no_credit':'error',http_status:r.http_status,latency_ms:r.latency_ms,checked_at:new Date().toISOString(),config_hash:hash,returned_model:r.returned_model},'?provider_id=eq.'+p.id+'&model_id=eq.'+encodeURIComponent(r.upstream_model));
   }catch{persistenceFailed=true;}}
  async function run(route){const p=route.provider,start=Date.now(),r={log_id:id,provider_id:p.id,provider_name:p.name,upstream_model:route.model_id,returned_model:null,choice_index:null,status:'failed',http_status:0,latency_ms:0,message:{role:'assistant',content:''},finish_reason:null,usage:null,reason:null};
   const hash=await configurationHash(p,digest);results.push(r);let controller,timer,reader,expired=false,first=true,complete=false,retry=0,prelude={},published=false;
   function merge(delta){if(delta.content!==undefined)r.message.content+=text(delta.content);for(const field of ['reasoning_content','reasoning','refusal'])if(typeof delta[field]==='string')r.message[field]=(r.message[field]||'')+delta[field];
    if(Array.isArray(delta.tool_calls)){r.message.tool_calls||=[];for(const [position,t]of delta.tool_calls.entries()){const at=Number.isInteger(t.index)?t.index:position;if(at<0||at>100)throw new Error('invalid_tool_index');const target=r.message.tool_calls[at]||={id:t.id||'',type:t.type||'function',function:{name:'',arguments:''}};if(t.id)target.id=t.id;if(t.function?.name)target.function.name+=t.function.name;if(t.function?.arguments)target.function.arguments+=t.function.arguments;}}
    if(!published){for(const [k,v]of Object.entries(delta)){if(k==='content')prelude.content=(prelude.content||'')+text(v);else if(typeof v==='string')prelude[k]=(prelude[k]||'')+v;else if(k==='tool_calls')prelude[k]=r.message.tool_calls;}}
    if(visible(r.message)){if(first){first=false;clearTimeout(timer);timer=setTimeout(()=>{expired=true;controller.abort();},Math.max(1,deadline-Date.now()));}
     if(!published){published=true;publish(r,{...prelude,role:'assistant'});prelude={};}else publish(r,delta);}}
   try{
    if(req.signal.aborted)throw new Error('cancelled');
    if(!await db.rpc('claim',{p_provider:p.id,p_admin:auth.user.role==='admin'})){r.status='skipped';r.reason='cooldown_or_quota';return;}
    controller=new AbortController();controllers.add(controller);timer=setTimeout(()=>{expired=true;controller.abort();},Math.max(1,Math.min(firstTimeout,deadline-Date.now())));
    validBase(p.base_url,p.kind);await verifyDNS(new URL(p.base_url).hostname,resolveDNS);const key=await unseal(p.secret_cipher,secret);
    const payload={...b,model:route.model_id,stream:true};delete payload.user;delete payload.n;delete payload.gateway;
    if(payload.max_completion_tokens===undefined)payload.max_tokens=limit;
    const up=await fetcher(p.base_url+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(payload),signal:controller.signal,redirect:'error'});r.http_status=up.status;
    if(!up.ok){const value=up.headers.get('retry-after');retry=/^\d+$/.test(value||'')?Number(value):Math.max(0,Math.ceil((Date.parse(value||'')-Date.now())/1000))||0;await up.body?.cancel();r.reason='http_'+up.status;return;}
    reader=up.body?.getReader();if(!reader)throw new Error('empty_response');const decoder=new TextDecoder();let buffer='',bytes=0,done=false;
    if(!up.headers.get('content-type')?.includes('text/event-stream')){
     while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>1048576)throw new Error('response_too_large');buffer+=decoder.decode(chunk.value,{stream:true});}
     const obj=JSON.parse(buffer);if(obj.error)throw new Error('upstream_error');const choice=obj.choices?.find(c=>c.index===0)||obj.choices?.[0];if(!choice?.message)throw new Error('invalid_response');r.returned_model=typeof obj.model==='string'?obj.model.slice(0,200):null;r.usage=obj.usage||null;r.finish_reason=choice.finish_reason||'stop';merge(choice.message);complete=!!visible(r.message);
    }else{
     while(!done){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>1048576)throw new Error('response_too_large');buffer+=decoder.decode(chunk.value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let at;
      while((at=buffer.indexOf('\n\n'))>=0){const raw=buffer.slice(0,at);buffer=buffer.slice(at+2);const data=raw.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!data)continue;if(data==='[DONE]'){done=true;complete=!!visible(r.message);break;}const obj=JSON.parse(data);if(obj.error)throw new Error('upstream_error');if(typeof obj.model==='string')r.returned_model=obj.model.slice(0,200);if(obj.usage)r.usage=obj.usage;
       const choice=obj.choices?.find(c=>c.index===0)||obj.choices?.[0];if(choice){merge(choice.delta||choice.message||{});if(choice.finish_reason){r.finish_reason=choice.finish_reason;complete=!!visible(r.message);}}
      }
     }
    }
    r.status=complete?'success':visible(r.message)?'partial':'failed';if(!complete)r.reason=visible(r.message)?'stream_interrupted':'empty_response';
   }catch(e){r.status=visible(r.message)?'partial':'failed';r.reason=req.signal.aborted||closed?'cancelled':expired?'timeout':e.message==='response_too_large'?'response_too_large':'upstream_error';}
   finally{
    clearTimeout(timer);controller?.abort();controllers.delete(controller);await reader?.cancel().catch(()=>{});r.latency_ms=Date.now()-start;if(r.choice_index!==null)publish(r,{},r.finish_reason||'stop');
    if(r.status!=='skipped')try{await persist('route_result',{p_provider:p.id,p_status:r.status==='success'?200:r.http_status===200?502:r.http_status,p_latency:r.latency_ms,p_success:r.status==='success',p_retry:retry});}catch{persistenceFailed=true;}
    await save(r,p,hash);
   }
  }
  async function work(){await Promise.allSettled(routes.map(run));const success=results.some(r=>r.status==='success'),partial=results.some(r=>r.status==='partial'),status=success?'success':partial?'partial':'failed';
   const sum=field=>results.some(r=>Number.isFinite(r.usage?.[field]))?results.reduce((n,r)=>n+(Number(r.usage?.[field])||0),0):null;
   const usage={prompt_tokens:sum('prompt_tokens'),completion_tokens:sum('completion_tokens')};if(usage.prompt_tokens!==null||usage.completion_tokens!==null)usage.total_tokens=(usage.prompt_tokens||0)+(usage.completion_tokens||0);
   try{await persist('finish',{p_log:id,p_status:status,p_attempts:results.map(r=>({provider_id:r.provider_id,status:r.http_status,latency_ms:r.latency_ms,outcome:r.status,reason:r.reason})),p_prompt:usage.prompt_tokens,p_completion:usage.completion_tokens});}catch{persistenceFailed=true;}
   req.signal.removeEventListener('abort',disconnect);
   const choices=results.filter(r=>r.choice_index!==null).sort((a,b)=>a.choice_index-b.choice_index).map(r=>({index:r.choice_index,message:r.message,finish_reason:r.finish_reason||'stop',gateway:{provider_name:r.provider_name,status:r.status,upstream_model:r.upstream_model,returned_model:r.returned_model}}));
   return {id:completionID,object:'chat.completion',created,model:b.model,choices,usage,gateway:{request_id:id,reply_count:choices.length,site_count:routes.length,status,saved:!persistenceFailed,stream_multi_reply_enabled:showAll}};
  }
  if(!b.stream){const result=await work();return result.choices.length?reply(result):reply({error:{code:'all_providers_unavailable',type:'gateway_error',message:'all_providers_unavailable'},gateway:result.gateway},503);}
  const body=new ReadableStream({start(c){output=c;work().then(result=>{if(!result.choices.length)emit({error:{code:'all_providers_unavailable',message:'all_providers_unavailable'}});emit({choices:[],usage:result.usage,gateway:result.gateway});if(!closed){c.enqueue(encoder.encode('data: [DONE]\n\n'));c.close();closed=true;}}).catch(()=>{emit({error:{code:'gateway_unavailable',message:'gateway_unavailable'}});if(!closed){c.close();closed=true;}});},cancel(){closed=true;disconnect();}});
  return new Response(body,{headers:{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no','x-gateway-request-id':id}});
 }
 return {chat,getReplies};
}
