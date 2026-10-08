import {createModelChecks} from './model-checks.mjs';
import {createModelDirectory,configurationHash} from './model-directory.mjs';
import {createFanout} from './fanout.mjs';
import {ROUTING_MODES,routingPolicy} from './routing.mjs';
import {readUpstreamError,failureDiagnostic,allFailedMessage} from './diagnostics.mjs';
export const ALIASES = ['fast','smart','rp','backup'];
const encoder = new TextEncoder();
const DAY = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const hex = b => [...new Uint8Array(b)].map(v=>v.toString(16).padStart(2,'0')).join('');
const unhex = s => Uint8Array.from(s.match(/../g)||[],v=>parseInt(v,16));
export async function digest(s) { return hex(await crypto.subtle.digest('SHA-256',encoder.encode(s))); }
export function randomKey() { return 'lg_'+hex(crypto.getRandomValues(new Uint8Array(32))); }
async function aes(secret) { return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode('ling-gateway-v1:'+secret)),'AES-GCM',false,['encrypt','decrypt']); }
export async function seal(value,secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return {iv:hex(iv),data:hex(await crypto.subtle.encrypt({name:'AES-GCM',iv},await aes(secret),encoder.encode(value)))};
}
export async function unseal(value,secret) {
  return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unhex(value.iv)},await aes(secret),unhex(value.data)));
}
export function validBase(value,kind='custom') {
  let u; try {u=new URL(value);} catch {throw new Error('invalid_provider_url');}
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||(u.port&&u.port!=='443')) throw new Error('invalid_provider_url');
  const h=u.hostname.toLowerCase();
  if(!h.includes('.')||h.includes(':')||/^\d+\.\d+\.\d+\.\d+$/.test(h)||/\.(localhost|local|internal|lan|test)$/.test(h)||h==='localhost') throw new Error('invalid_provider_url');
  if(kind==='gemini'&&(h!=='generativelanguage.googleapis.com'||u.pathname.replace(/\/$/,'')!=='/v1beta/openai')) throw new Error('invalid_provider_url');
  if(kind==='openrouter'&&(h!=='openrouter.ai'||u.pathname.replace(/\/$/,'')!=='/api/v1')) throw new Error('invalid_provider_url');
  if(kind==='cloudflare'&&(h!=='api.cloudflare.com'||!/^\/client\/v4\/accounts\/[a-f0-9]{32}\/ai\/v1\/?$/.test(u.pathname))) throw new Error('invalid_provider_url');
  return value.replace(/\/+$/,'');
}
function privateAddress(ip) {
  if(ip.includes(':')) return /^(::|fc|fd|fe8|fe9|fea|feb|ff)/i.test(ip)||/::ffff:/i.test(ip);
  const p=ip.split('.').map(Number);
  return p[0]===0||p[0]===10||p[0]===127||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&p[1]===168||p[0]===100&&p[1]>=64&&p[1]<=127||p[0]>=224;
}
async function verifyDNS(host,resolver) {
  if (!resolver) return;
  const records=await resolver(host);
  if (!records.length||records.some(privateAddress)) throw new Error('unsafe_provider_address');
}
export class DB {
  constructor(env,fetcher=fetch) {this.env=env;this.fetcher=fetcher;}
  async request(path,method='GET',body,extraHeaders={}) {
    const k=this.env.SUPABASE_SERVICE_ROLE_KEY;
    const r=await this.fetcher(this.env.SUPABASE_URL+'/rest/v1/'+path,{method,headers:{apikey:k,...(k.startsWith('eyJ')?{authorization:'Bearer '+k}:{}),'content-type':'application/json',Prefer:'return=representation',...extraHeaders},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    if(!r.ok) throw new Error('database_unavailable');
    if(r.status===204)return null;
    return r.json();
  }
  rpc(name,args) {return this.request('rpc/ling_gateway_'+name,'POST',args);}
  table(name,query='') {return this.request('ling_gateway_'+name+query);}
  write(name,method,data,query='') {return this.request('ling_gateway_'+name+query,method,data);}
}
function reply(data,status=200) {return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
function error(code,status=400) {return reply({error:{message:code,type:'gateway_error',code}},status);}
function cors(response) {
  const h=new Headers(response.headers);
  h.set('access-control-allow-origin','*');h.set('access-control-allow-headers','authorization,content-type');h.set('access-control-allow-methods','GET,POST,PATCH,DELETE,OPTIONS');
  h.set('access-control-expose-headers','x-gateway-request-id');
  h.set('x-content-type-options','nosniff');h.set('referrer-policy','no-referrer');
  return new Response(response.body,{status:response.status,headers:h});
}
async function readJSON(req,limit=1048576) {
  if(Number(req.headers.get('content-length'))>limit)throw new Error('body_too_large');
  const reader=req.body?.getReader();if(!reader)throw new Error('invalid_json');
  let length=0,chunks=[];while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();throw new Error('body_too_large');}chunks.push(value);}
  const bytes=new Uint8Array(length);let i=0;for(const chunk of chunks){bytes.set(chunk,i);i+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Error('invalid_json');}
}
async function equal(a,b) { return await digest(a)===await digest(b); }
function safeProvider(p,usage) {
  const {secret_cipher,...safe}=p;
  return {...safe,has_key:!!secret_cipher,day_requests:usage?.requests||0,
    remaining:p.daily_limit===null?null:Math.max(0,p.daily_limit-(usage?.requests||0)),
    error_rate:p.total_attempts?Number(p.total_errors)/Number(p.total_attempts):0};
}
function visibleSettings(settings) {
  const {monitor_hash,access_code_hash,...safe}=settings;
  return safe;
}
export function createGateway(env,options={}) {
  const db=options.db||new DB(env,options.fetcher);
  const fetcher=options.fetcher||fetch;
  const modelChecks=createModelChecks({db,fetcher,validBase,resolveDNS:options.resolveDNS,verifyDNS,unseal,digest,secret:env.ENCRYPTION_KEY||env.SUPABASE_SERVICE_ROLE_KEY});
  const persist=async(name,args)=> {for(let n=0;n<2;n++){try{return await db.rpc(name,args);}catch(e){if(n===1)throw e;}}};
  const directory=createModelDirectory({db,digest});
  const fanout=createFanout({db,fetcher,validBase,verifyDNS,resolveDNS:options.resolveDNS,unseal,secret:env.ENCRYPTION_KEY||env.SUPABASE_SERVICE_ROLE_KEY,digest,configurationHash,persist,reply,error,firstTimeout:options.firstTimeout,totalTimeout:options.totalTimeout});
  async function authenticate(req,admin=false) {
    const raw=(req.headers.get('authorization')||'').match(/^Bearer (\S+)$/)?.[1];
    if(!raw)return null;
    const rows=await db.table('keys','?key_hash=eq.'+await digest(raw)+'&enabled=eq.true&limit=1');
    const key=rows[0];if(!key||key.expires_at&&Date.parse(key.expires_at)<=Date.now())return null;
    const user=(await db.table('users','?id=eq.'+key.user_id+'&enabled=eq.true&limit=1'))[0];
    if(!user||admin&&(!key.admin_access||user.role!=='admin'))return null;
    return {user,key};
  }
  async function issue(user,name,admin=false,expiry=null) {
    const token=randomKey();
    const row=await db.write('keys','POST',{user_id:user.id,key_hash:await digest(token),prefix:token.slice(0,11),name,admin_access:admin,expires_at:expiry});
    return {id:row[0].id,key:token,prefix:token.slice(0,11)};
  }
  async function health(p) {
    const start=Date.now();let status=0;
    try {validBase(p.base_url,p.kind);await verifyDNS(new URL(p.base_url).hostname,options.resolveDNS);
      const key=await unseal(p.secret_cipher,env.ENCRYPTION_KEY||env.SUPABASE_SERVICE_ROLE_KEY);
      const endpoint=p.kind==='cloudflare'?p.base_url.replace(/\/v1$/,'')+'/models/search?per_page=1':p.base_url+'/models';
      const r=await fetcher(endpoint,{headers:{authorization:'Bearer '+key},signal:AbortSignal.timeout(8000),redirect:'error'});
      status=r.status;await r.body?.cancel();
    }catch{}
    await persist('provider_result',{p_provider:p.id,p_status:status,p_latency:Date.now()-start,p_success:status>=200&&status<300,p_health:true,p_retry:0});
    return {id:p.id,status,ok:status>=200&&status<300,latency_ms:Date.now()-start};
  }
  async function admin(req,path,auth) {
    const user=auth.user;
    if(path==='/admin/model-directory'&&req.method==='GET')return reply(await directory.list(false));
    if(path==='/admin/models'&&req.method==='GET')return reply(await modelChecks.list(new URL(req.url).searchParams.get('provider_id')));
    if(path.startsWith('/admin/models/')&&req.method==='POST'){
      const b=await readJSON(req,32768);
      if(path==='/admin/models/discover')return reply(await modelChecks.discover(b.provider_id));
      if(path==='/admin/models/add')return reply(await modelChecks.add(b.provider_id,b.models));
      if(path==='/admin/models/map')return reply(await modelChecks.map(b.provider_id,b.model_id,b.canonical_id));
      if(path==='/admin/models/probe')return reply(await modelChecks.probe(b.provider_id,b.model_id,b.timeout_seconds??12,req.signal));
    }
    if(path==='/admin/overview'&&req.method==='GET') {
      const [providers,usage,users,keys,logs,settings,userUsage]=await Promise.all([
        db.table('providers','?order=priority.asc'),db.table('provider_usage','?day=eq.'+DAY()),db.table('users','?order=created_at.asc'),
        db.table('keys','?admin_access=eq.false&select=id,user_id,prefix,name,enabled,created_at,expires_at'),
        db.table('logs','?order=started_at.desc&limit=100'),db.table('settings'),db.table('usage','?day=eq.'+DAY())]);
      return reply({providers:providers.map(p=>safeProvider(p,usage.find(u=>u.provider_id===p.id))),users,keys,logs,settings:visibleSettings(settings[0]),usage:userUsage,day:DAY(),owner_id:user.id});
    }
    if(path==='/admin/provider'&&['POST','PATCH'].includes(req.method)) {
      const b=await readJSON(req,16384);let p;
      if(b.id) {if(!/^[a-f0-9-]{36}$/.test(b.id))return error('invalid_id');p=(await db.table('providers','?id=eq.'+b.id))[0];if(!p)return error('not_found',404);}
      const kind=b.kind||p?.kind||'custom';if(!['custom','gemini','openrouter','cloudflare'].includes(kind))return error('invalid_provider_kind');
      const base=validBase(b.base_url||p?.base_url,kind);await verifyDNS(new URL(base).hostname,options.resolveDNS);
      const aliases=b.aliases||p?.aliases||{};
      if(!aliases||typeof aliases!=='object'||Array.isArray(aliases)||Object.keys(aliases).some(a=>!ALIASES.includes(a))||Object.values(aliases).some(m=>typeof m!=='string'||!m||m.length>200))return error('invalid_aliases');
      if(kind==='openrouter'&&Object.values(aliases).some(m=>m!=='openrouter/free'&&!m.endsWith(':free')))return error('openrouter_free_models_only');
      const data={name:String(b.name||p?.name||'新线路').slice(0,80),kind,base_url:base,aliases};
      for(const [field,min,max] of [['priority',0,10000],['rpm_limit',1,1000],['daily_limit',1,1000000]]) {
        if(b[field]!==undefined) {if(field==='daily_limit'&&b[field]===null)data[field]=null;else if(!Number.isInteger(b[field])||b[field]<min||b[field]>max)return error('invalid_'+field);else data[field]=b[field];}
      }
      if(b.key!==undefined&&b.key!==''){if(typeof b.key!=='string'||b.key.length>4096)return error('invalid_key');data.secret_cipher=await seal(b.key,env.ENCRYPTION_KEY||env.SUPABASE_SERVICE_ROLE_KEY);}
      if(b.enabled!==undefined){if(typeof b.enabled!=='boolean')return error('invalid_enabled');data.enabled=b.enabled;}
      if(data.enabled&&!(data.secret_cipher||p?.secret_cipher))return error('provider_key_required');
      const out=await db.write('providers',p?'PATCH':'POST',data,p?'?id=eq.'+p.id:'');return reply({provider:safeProvider(out[0])});
    }
    if(path==='/admin/health'&&req.method==='POST') {
      const b=await readJSON(req,2048);const rows=await db.table('providers','?enabled=eq.true');
      return reply({checks:await Promise.all(rows.filter(p=>p.secret_cipher&&(!b.id||p.id===b.id)).map(health)),note:'检查厂商模型列表的连通性；不消耗聊天推理额度，也不证明某个模型可生成。'});
    }
    if(path==='/admin/reset-circuit'&&req.method==='POST') {
      const b=await readJSON(req,2048);if(!/^[a-f0-9-]{36}$/.test(b.id||''))return error('invalid_id');
      await db.write('providers','PATCH',{open_until:null,probe_until:null,failures:0},'?id=eq.'+b.id);return reply({ok:true});
    }
    if(path==='/admin/settings'&&req.method==='PATCH') {
      const b=await readJSON(req,2048),data={};
      for(const [f,min,max] of [['default_daily_limit',0,100000],['owner_reserve',0,100000]])if(b[f]!==undefined){if(!Number.isInteger(b[f])||b[f]<min||b[f]>max)return error('invalid_'+f);data[f]=b[f];}
      if(b.max_output_tokens!==undefined){if(b.max_output_tokens!==null&&(!Number.isSafeInteger(b.max_output_tokens)||b.max_output_tokens<1))return error('invalid_max_output_tokens');data.max_output_tokens=b.max_output_tokens;}
      if(b.routing_mode!==undefined){if(!ROUTING_MODES.includes(b.routing_mode))return error('invalid_routing_mode');data.routing_mode=b.routing_mode;}
      if(b.hedge_delay_ms!==undefined){if(!Number.isInteger(b.hedge_delay_ms)||b.hedge_delay_ms<1000||b.hedge_delay_ms>30000)return error('invalid_hedge_delay');data.hedge_delay_ms=b.hedge_delay_ms;}
      if(b.first_output_timeout_ms!==undefined){if(!Number.isInteger(b.first_output_timeout_ms)||b.first_output_timeout_ms<5000||b.first_output_timeout_ms>120000)return error('invalid_first_output_timeout');data.first_output_timeout_ms=b.first_output_timeout_ms;}
      if(b.multi_reply_limit!==undefined){if(!Number.isInteger(b.multi_reply_limit)||(b.multi_reply_limit!==0&&(b.multi_reply_limit<2||b.multi_reply_limit>20)))return error('invalid_multi_reply_limit');data.multi_reply_limit=b.multi_reply_limit;}
      if(b.public_enabled!==undefined){if(typeof b.public_enabled!=='boolean')return error('invalid_public_enabled');data.public_enabled=b.public_enabled;}
      return reply({settings:visibleSettings((await db.write('settings','PATCH',data,'?id=eq.true'))[0])});
    }
    if(path==='/admin/users'&&req.method==='POST') {
      const b=await readJSON(req,2048);const n=b.daily_limit;
      if(n!==null&&n!==undefined&&(!Number.isInteger(n)||n<0||n>100000))return error('invalid_daily_limit');
      const created=(await db.write('users','POST',{name:String(b.name||'朋友').slice(0,80),daily_limit:n??null,role:'user'}))[0];return reply({user:created,credential:await issue(created,'初始密钥')});
    }
    if(path==='/admin/users'&&req.method==='PATCH') {
      const b=await readJSON(req,2048);if(!/^[a-f0-9-]{36}$/.test(b.id||''))return error('invalid_id');
      const target=(await db.table('users','?id=eq.'+b.id))[0];if(!target)return error('not_found',404);
      const data={};if(b.daily_limit!==undefined){if(b.daily_limit!==null&&(!Number.isInteger(b.daily_limit)||b.daily_limit<0||b.daily_limit>1000000))return error('invalid_daily_limit');data.daily_limit=b.daily_limit;}
      if(b.enabled!==undefined){if(typeof b.enabled!=='boolean'||target.role==='admin'&&!b.enabled)return error('invalid_enabled');data.enabled=b.enabled;}
      return reply({user:(await db.write('users','PATCH',data,'?id=eq.'+b.id))[0]});
    }
    if(path==='/admin/keys'&&req.method==='POST') {
      const b=await readJSON(req,2048);if(!/^[a-f0-9-]{36}$/.test(b.user_id||''))return error('invalid_id');
      const target=(await db.table('users','?id=eq.'+b.user_id))[0];if(!target)return error('not_found',404);
      return reply({credential:await issue(target,String(b.name||'应用密钥').slice(0,80))});
    }
    if(path==='/admin/keys'&&req.method==='DELETE') {
      const b=await readJSON(req,2048);if(!/^[a-f0-9-]{36}$/.test(b.id||''))return error('invalid_id');
      await db.write('keys','PATCH',{enabled:false},'?id=eq.'+b.id);return reply({ok:true});
    }
    if(path==='/admin/logout'&&req.method==='POST'){await db.write('keys','PATCH',{enabled:false},'?id=eq.'+auth.key.id);return reply({ok:true});}
    return error('not_found',404);
  }
  async function chat(req,auth) {
    const deadline=Date.now()+130000;
    const b=await readJSON(req);
    if(typeof b.model!=='string'||!b.model||b.model.length>200)return error('unknown_model');
    if(!Array.isArray(b.messages)||!b.messages.length||b.messages.length>1000||b.messages.some(m=>!m||!['system','developer','user','assistant','tool','function'].includes(m.role)))return error('invalid_messages');
    if(b.stream!==undefined&&typeof b.stream!=='boolean')return error('invalid_stream');
    if(b.n!==undefined&&(!Number.isInteger(b.n)||b.n<1||b.n>1000))return error('invalid_n');
    const settings=(await db.table('settings'))[0];
    for(const field of ['max_tokens','max_completion_tokens']){
      if(b[field]===null)delete b[field];
      else if(b[field]!==undefined&&(!Number.isSafeInteger(b[field])||b[field]<1))return error('invalid_'+field);
    }
    const limit=b.max_completion_tokens??b.max_tokens??settings.max_output_tokens??undefined;
    if(settings.max_output_tokens!=null&&limit>settings.max_output_tokens)return error('max_tokens_exceeded');
    if(b.max_completion_tokens!==undefined)delete b.max_tokens;
    if(!ALIASES.includes(b.model)){const selected=await directory.routes(b.model);if(!selected.routes.length)return error('unknown_model');return fanout.chat(req,auth,{...b,model:selected.id},selected.routes,limit,settings);}
    const providers=(await db.table('providers','?enabled=eq.true&order=priority.asc,created_at.asc')).filter(p=>p.aliases[b.model]&&p.secret_cipher);
    if(!providers.length)return error('no_provider_configured',503);
    const reservation=await db.rpc('reserve',{p_user:auth.user.id,p_model:b.model});
    if(reservation.error)return error(reservation.error,reservation.error==='public_closed'?403:429);
    const attempts=[];let settled=false;
    async function finish(status,usage) {if(settled)return;await persist('finish',{p_log:reservation.id,p_status:status,p_attempts:attempts,p_prompt:usage?.prompt_tokens??null,p_completion:usage?.completion_tokens??null});settled=true;}
    let tried=0;
    for(const p of providers) {
      if(tried>=3||Date.now()>=deadline)break;
      if(!await db.rpc('claim',{p_provider:p.id,p_admin:auth.user.role==='admin'}))continue;
      tried++;const start=Date.now(),controller=new AbortController();
      const disconnect=()=>controller.abort();req.signal.addEventListener('abort',disconnect,{once:true});
      const waitMs=options.firstTimeout??settings.first_output_timeout_ms??90000;
      let timer=setTimeout(()=>controller.abort(),Math.max(1,Math.min(waitMs,deadline-Date.now()))),up,streamStarted=false;
      const cleanup=()=>{clearTimeout(timer);req.signal.removeEventListener('abort',disconnect);};
      try {
        validBase(p.base_url,p.kind);await verifyDNS(new URL(p.base_url).hostname,options.resolveDNS);
        const key=await unseal(p.secret_cipher,env.ENCRYPTION_KEY||env.SUPABASE_SERVICE_ROLE_KEY);
        const payload={...b,model:p.aliases[b.model]};
        if(b.max_completion_tokens===undefined&&limit!==undefined)payload.max_tokens=limit;
        delete payload.user; // Do not send local user identifiers upstream.
        up=await fetcher(p.base_url+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(payload),signal:controller.signal,redirect:'error'});
        if(!up.ok) {
          const status=up.status,details=await readUpstreamError(up,{secrets:[key],sensitive:b.messages.map(m=>m.content).filter(c=>typeof c==='string')});cleanup();
          const retry=up.headers.get('retry-after');const secs=/^\d+$/.test(retry||'')?Number(retry):Math.max(0,Math.ceil((Date.parse(retry||'')-Date.now())/1000))||0;
          const failed={provider_id:p.id,provider_name:p.name,http_status:status,status,reason:'http_'+status,latency_ms:Date.now()-start,...details};failed.diagnostic=failureDiagnostic(failed);attempts.push(failed);
          await persist('provider_result',{p_provider:p.id,p_status:status,p_latency:Date.now()-start,p_success:false,p_health:false,p_retry:secs});
          if([401,403,404,429].includes(status)||status>=500)continue;
          await finish('failed');return reply({error:{code:'upstream_rejected_request',type:'gateway_error',message:allFailedMessage(b.model,[failed])}},status>=400&&status<500?status:502);
        }
        if(b.stream) {
          if(!up.headers.get('content-type')?.includes('text/event-stream')||!up.body)throw new Error('invalid_upstream_stream');
          const reader=up.body.getReader(),decoder=new TextDecoder();let buffer='',pending=[],doneMarker=false,usage;
          function frames(text) {
            buffer+=text;buffer=buffer.replace(/\r\n/g,'\n');
            let at;const result=[];
            while((at=buffer.indexOf('\n\n'))>=0){if(at>1048576)throw new Error('upstream_frame_too_large');const frame=buffer.slice(0,at);buffer=buffer.slice(at+2);const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
              if(!data)continue;if(data==='[DONE]'){doneMarker=true;result.push('data: [DONE]\n\n');continue;}
              const obj=JSON.parse(data);if(obj.error)throw new Error('upstream_stream_error');
              if(!Array.isArray(obj.choices))throw new Error('invalid_upstream_chunk');
              obj.model=b.model;if(obj.usage)usage=obj.usage;result.push('data: '+JSON.stringify(obj)+'\n\n');}
            if(buffer.length>1048576)throw new Error('upstream_frame_too_large');return result;
          }
          // Wait for a valid OpenAI chunk BEFORE sending headers. Errors here may fail over.
          while(!pending.length){const item=await reader.read();if(item.done)throw new Error('empty_upstream_stream');pending.push(...frames(decoder.decode(item.value,{stream:true})));}
          cleanup();req.signal.addEventListener('abort',disconnect,{once:true});timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-Date.now()));
          attempts.push({provider_id:p.id,status:200,latency_ms:Date.now()-start});streamStarted=true;
          let complete=false;
          async function end(success) {if(complete)return;complete=true;cleanup();
            if(!success)attempts[attempts.length-1].status=502;
            await persist('provider_result',{p_provider:p.id,p_status:success?200:502,p_latency:Date.now()-start,p_success:success,p_health:false,p_retry:0});
            await finish(success?'success':'partial',usage);}
          const body=new ReadableStream({
            async pull(out) {
              try {
                if(pending.length){for(const frame of pending.splice(0))out.enqueue(encoder.encode(frame));if(doneMarker){await reader.cancel();await end(true);out.close();}return;}
                const item=await reader.read();if(item.done){if(!doneMarker)throw new Error('truncated_stream');await end(true);out.close();return;}
                for(const frame of frames(decoder.decode(item.value,{stream:true})))out.enqueue(encoder.encode(frame));
                if(doneMarker){await reader.cancel();await end(true);out.close();}
              }catch {await reader.cancel().catch(()=>{});await end(false);out.enqueue(encoder.encode('data: '+JSON.stringify({error:{message:'stream_interrupted',code:'stream_interrupted'}})+'\n\ndata: [DONE]\n\n'));out.close();}
            },async cancel(){controller.abort();await reader.cancel().catch(()=>{});await end(false);}
          });
          return new Response(body,{headers:{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no'}});
        }
        const obj=await up.json();if(obj.error||!Array.isArray(obj.choices)||!obj.choices.length)throw new Error('invalid_upstream_response');
        cleanup();obj.model=b.model;attempts.push({provider_id:p.id,status:200,latency_ms:Date.now()-start});
        await persist('provider_result',{p_provider:p.id,p_status:200,p_latency:Date.now()-start,p_success:true,p_health:false,p_retry:0});
        await finish('success',obj.usage);return reply(obj);
      }catch(e) {
        const wasTimedOut=controller.signal.aborted;cleanup();controller.abort();if(streamStarted)throw e;
        if(e.message==='database_unavailable')throw e;
        const failed={provider_id:p.id,provider_name:p.name,status:0,http_status:0,latency_ms:Date.now()-start,reason:wasTimedOut?'timeout':'upstream_error',wait_seconds:Math.ceil((Date.now()-start)/1000)};failed.diagnostic=failureDiagnostic(failed);attempts.push(failed);
        await persist('provider_result',{p_provider:p.id,p_status:0,p_latency:Date.now()-start,p_success:false,p_health:false,p_retry:0});
        if(req.signal.aborted){await finish('failed');return error('client_cancelled',499);}
      }
    }
    await finish('failed');return reply({error:{code:'all_providers_unavailable',type:'gateway_error',message:allFailedMessage(b.model,attempts)}},503);
  }
  return async req => {
    try {
      const url=new URL(req.url);let path=url.pathname.replace(/^(?:\/functions\/v1)?\/ling-ai-gateway(?=\/|$)/,'').replace(/\/$/,'')||'/';
      if(req.method==='OPTIONS')return cors(new Response(null,{status:204}));
      if(path==='/health'&&req.method==='GET')return cors(reply({ok:true,service:'ling-ai-gateway',version:'0.5.3'}));
      if(path==='/internal/health'&&req.method==='POST') {
        const token=(req.headers.get('authorization')||'').match(/^Bearer (\S+)$/)?.[1];
        const settings=(await db.table('settings'))[0];
        if(!token||!settings.monitor_hash||!await equal(await digest(token),settings.monitor_hash))return cors(error('unauthorized',401));
        const providers=(await db.table('providers','?enabled=eq.true')).filter(p=>p.secret_cipher);
        return cors(reply({checks:await Promise.all(providers.slice(0,12).map(health))}));
      }
      if(path==='/admin/login'&&req.method==='POST') {
        const b=await readJSON(req,2048);
        const ip=req.headers.get('cf-connecting-ip')||req.headers.get('x-forwarded-for')?.split(',')[0]||'unknown';
        if(!await db.rpc('login_attempt',{p_ip:await digest(ip)}))return cors(error('login_rate_limited',429));
        if(typeof b.password!=='string'||b.password.length>256)return cors(error('unauthorized',401));
        const settings=(await db.table('settings'))[0];
        const gateHash=settings.access_code_hash||(await db.request('private_site_state?site_id=eq.site-access-auth&select=state&limit=1'))[0]?.state?.hash;
        if(!gateHash||!await equal(await digest(b.password),gateHash))return cors(error('unauthorized',401));
        const owner=(await db.table('users','?role=eq.admin&enabled=eq.true&limit=1'))[0];
        return cors(reply({session:await issue(owner,'管理会话',true,new Date(Date.now()+8*3600000).toISOString())}));
      }
      if(path.startsWith('/admin/')) {const auth=await authenticate(req,true);if(!auth)return cors(error('unauthorized',401));return cors(await admin(req,path,auth));}
      if(path.startsWith('/v1/')) {
        const auth=await authenticate(req);if(!auth)return cors(error('unauthorized',401));
        if(auth.user.role!=='admin'&&!(await db.table('settings'))[0].public_enabled)return cors(error('public_closed',403));
        if(path==='/v1/models'&&req.method==='GET')return cors(reply({...await directory.list(),routing:routingPolicy((await db.table('settings'))[0])}));
        if(path.startsWith('/v1/replies/')&&req.method==='GET')return cors(await fanout.getReplies(path.slice('/v1/replies/'.length),auth));
        if(path==='/v1/chat/completions'&&req.method==='POST')return cors(await chat(req,auth));
      }
      return cors(error('not_found',404));
    }catch(e){
      const inputErrors=['invalid_json','invalid_id','invalid_models','invalid_canonical_model','model_not_registered','invalid_probe_timeout','invalid_provider_url','unsafe_provider_address','provider_key_required','provider_not_found','openrouter_free_models_only'];
      const publicErrors=[...inputErrors,'body_too_large','invalid_model_catalog','catalog_too_large'];
      return cors(error(publicErrors.includes(e.message)||/^model_catalog_http_\d+$/.test(e.message)?e.message:'gateway_unavailable',e.message==='body_too_large'?413:inputErrors.includes(e.message)?400:503));
    }
  };
}
