// Public model IDs are separate from upstream wire IDs. Do not strip versions/dates.
import {removeModelDecorations,reviewedModel,modelExclusion,mappingState,modelCore,directoryModelID} from './model-names.mjs';
const cleanID=/^(?:(?:假流式|抗截断|防截断)-)?[a-z0-9][a-z0-9._-]{0,199}$/;
const family=/^(gemini-|claude-|gpt-|chatgpt-|o[134](?:-|$)|deepseek-|llama-|qwen|qwq-|qvq-|glm-|kimi-|moonshot-|mistral-|mixtral-|codestral-|ministral-|pixtral-|magistral-|gemma-|command-|grok-|ernie-|yi-|nemotron-|jamba-|granite-|olmo-|phi-|nova-|hermes-|minimax-|longcat-|devstral-)/;
export function canonicalName(value,kind='custom',station='') {
 let id=String(value||'').trim().toLowerCase().replace(/^models\//,'');
 if(id==='openrouter/free')return null; // A router is not a specific official model.
 const label=station.trim().toLowerCase();
 if(label){for(const sep of ['/',':','-','_']){if(id.startsWith(label+sep))id=id.slice(label.length+1);if(id.endsWith(sep+label))id=id.slice(0,-label.length-1);}}
 if(kind==='openrouter')id=id.replace(/:free$/,'');
 if(id.startsWith('@cf/'))id=id.split('/').slice(2).join('/');
 else if(id.includes('/'))id=id.split('/').at(-1);
 id=removeModelDecorations(id);
 if(/^gemini-(?:pro|flash)(?:-|$)/.test(modelCore(id)))return null; // Generic station aliases do not identify a version.
 return !modelExclusion(id)&&id.length<=200&&cleanID.test(id)&&(family.test(modelCore(id))||reviewedModel(id))?id:null;
}
export function canonicalID(value){if(typeof value!=='string')throw new Error('invalid_canonical_model');const id=value.trim().toLowerCase();if(id.length>200||!cleanID.test(id)||['fast','smart','rp','backup'].includes(id))throw new Error('invalid_canonical_model');return id;}
export const configurationHash=(p,digest)=>digest(p.kind+'\n'+p.base_url+'\n'+JSON.stringify(p.secret_cipher));
export async function modelRows(db,query='') {
 const rows=[];for(let offset=0;;offset+=1000){const page=await db.table('models',query+(query?'&':'?')+'order=provider_id.asc,model_id.asc&limit=1000&offset='+offset);rows.push(...page);if(page.length<1000)break;}
 return rows;
}
export function createModelDirectory({db,digest}) {
 async function snapshot(){const providers=await db.table('providers','?order=priority.asc,created_at.asc'),models=await modelRows(db,'?listed=eq.true');const hashes=new Map();await Promise.all(providers.map(async p=>hashes.set(p.id,await configurationHash(p,digest))));
  const routes=models.flatMap(m=>{const p=providers.find(x=>x.id===m.provider_id);return p?[{...m,directory_id:directoryModelID(m),provider:p,stale:!!m.config_hash&&hashes.get(p.id)!==m.config_hash}]:[];});return {providers,routes};}
 function selectRoutes(routes,id){const chosen=new Map();for(const r of routes.filter(r=>r.directory_id===id&&r.provider.enabled&&r.provider.secret_cipher)){const old=chosen.get(r.provider.id),score=r=>(r.status==='available'&&!r.stale?2:0)+(r.model_id===id?1:0);if(!old||score(r)>score(old))chosen.set(r.provider.id,r);}return [...chosen.values()].sort((a,b)=>a.provider.priority-b.provider.priority);}
 function groups(routes,publicOnly){const map=new Map();for(const r of routes){if(publicOnly&&(!r.provider.enabled||!r.provider.secret_cipher))continue;const id=r.directory_id;if(!id)continue;let g=map.get(id);if(!g){g={id,object:'model',created:1791331200,owned_by:'ling',naming:r.canonical_id?'canonical':'original',sites:new Map()};map.set(id,g);}if(r.canonical_id)g.naming='canonical';const old=g.sites.get(r.provider.id);const available=r.status==='available'&&!r.stale;g.sites.set(r.provider.id,{enabled:r.provider.enabled&&!!r.provider.secret_cipher,available:available||old?.available,checked:!!r.checked_at&&!r.stale||old?.checked,name:r.provider.name});}
  return [...map.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(({sites,naming,...g})=>({...g,gateway:{naming,site_count:sites.size,enabled_sites:[...sites.values()].filter(s=>s.enabled).length,available_sites:[...sites.values()].filter(s=>s.enabled&&s.available).length,unchecked_sites:[...sites.values()].filter(s=>!s.checked).length,...(!publicOnly?{sites:[...sites.values()],probe_routes:selectRoutes(routes,g.id).map(r=>({provider_id:r.provider.id,provider_name:r.provider.name,model_id:r.model_id,status:r.status,stale:r.stale,http_status:r.http_status,latency_ms:r.latency_ms,first_token_ms:r.first_token_ms,checked_at:r.checked_at}))}:{})}}));}
 return {
  async list(publicOnly=true){const s=await snapshot();const result={object:'list',data:groups(s.routes,publicOnly)};if(!publicOnly){const counts={total:s.routes.length,mapped:0,unrecognized:0,non_chat:0,hidden:0};const entries=s.routes.map(r=>{const classification=mappingState(r);counts[classification.state]++;return {provider_id:r.provider.id,provider_name:r.provider.name,model_id:r.model_id,canonical_id:r.canonical_id,canonical_source:r.canonical_source,directory_id:r.directory_id,enabled:r.provider.enabled,has_key:!!r.provider.secret_cipher,...classification};});result.mapping={counts,entries};}return result;},
  async routes(value){if(typeof value!=='string'||!value.trim()||value.length>200||/[\u0000-\u001f\u007f]/.test(value))throw new Error('invalid_canonical_model');const s=await snapshot();let id=value.trim();if(!s.routes.some(r=>r.directory_id===id)){try{id=canonicalID(id);}catch{}}return {id,routes:selectRoutes(s.routes,id)};}
 };
}
