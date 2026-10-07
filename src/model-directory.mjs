// Public model IDs are separate from upstream wire IDs. Do not strip versions/dates.
const cleanID=/^[a-z0-9][a-z0-9._-]{0,199}$/;
const family=/^(gemini-|claude-|gpt-|chatgpt-|o[134](?:-|$)|deepseek-|llama-|qwen|qwq-|qvq-|glm-|kimi-|moonshot-|mistral-|mixtral-|codestral-|ministral-|pixtral-|magistral-|gemma-|command-|grok-|ernie-|yi-|nemotron-|jamba-|granite-|olmo-|phi-|nova-|hermes-|minimax-|longcat-|devstral-)/;
export function canonicalName(value,kind='custom',station='') {
 let id=String(value||'').trim().toLowerCase().replace(/^models\//,'');
 if(id==='openrouter/free')return null; // A router is not a specific official model.
 const label=station.trim().toLowerCase();
 if(label){for(const sep of ['/',':','-','_']){if(id.startsWith(label+sep))id=id.slice(label.length+1);if(id.endsWith(sep+label))id=id.slice(0,-label.length-1);}}
 if(kind==='openrouter')id=id.replace(/:free$/,'');
 if(id.startsWith('@cf/'))id=id.split('/').slice(2).join('/');
 else if(id.includes('/'))id=id.split('/').at(-1);
 return cleanID.test(id)&&family.test(id)?id:null;
}
export function canonicalID(value){if(typeof value!=='string')throw new Error('invalid_canonical_model');const id=value.trim().toLowerCase();if(!cleanID.test(id)||['fast','smart','rp','backup'].includes(id))throw new Error('invalid_canonical_model');return id;}
export const configurationHash=(p,digest)=>digest(p.kind+'\n'+p.base_url+'\n'+JSON.stringify(p.secret_cipher));
export async function modelRows(db,query='') {
 const rows=[];for(let offset=0;;offset+=1000){const page=await db.table('models',query+(query?'&':'?')+'order=provider_id.asc,model_id.asc&limit=1000&offset='+offset);rows.push(...page);if(page.length<1000)break;}
 return rows;
}
export function createModelDirectory({db,digest}) {
 async function snapshot(){const providers=await db.table('providers','?order=priority.asc,created_at.asc'),models=await modelRows(db,'?listed=eq.true&canonical_id=not.is.null');const hashes=new Map();await Promise.all(providers.map(async p=>hashes.set(p.id,await configurationHash(p,digest))));
  const routes=models.flatMap(m=>{const p=providers.find(x=>x.id===m.provider_id);return p?[{...m,provider:p,stale:!!m.config_hash&&hashes.get(p.id)!==m.config_hash}]:[];});return {providers,routes};}
 function groups(routes,publicOnly){const map=new Map();for(const r of routes){if(publicOnly&&(!r.provider.enabled||!r.provider.secret_cipher))continue;const id=r.canonical_id;if(!id)continue;let g=map.get(id);if(!g){g={id,object:'model',created:1791331200,owned_by:'ling',sites:new Map()};map.set(id,g);}const old=g.sites.get(r.provider.id);const available=r.status==='available'&&!r.stale;g.sites.set(r.provider.id,{enabled:r.provider.enabled&&!!r.provider.secret_cipher,available:available||old?.available,checked:!!r.checked_at&&!r.stale||old?.checked,name:r.provider.name});}
  return [...map.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(({sites,...g})=>({...g,gateway:{site_count:sites.size,enabled_sites:[...sites.values()].filter(s=>s.enabled).length,available_sites:[...sites.values()].filter(s=>s.enabled&&s.available).length,unchecked_sites:[...sites.values()].filter(s=>!s.checked).length,...(!publicOnly?{sites:[...sites.values()]}:{})}}));}
 return {
  async list(publicOnly=true){const s=await snapshot();return {object:'list',data:groups(s.routes,publicOnly)};},
  async routes(value){const id=canonicalID(value),s=await snapshot(),chosen=new Map();for(const r of s.routes.filter(r=>r.canonical_id===id&&r.provider.enabled&&r.provider.secret_cipher)){const old=chosen.get(r.provider.id),score=r=>(r.status==='available'&&!r.stale?2:0)+(r.model_id===id?1:0);if(!old||score(r)>score(old))chosen.set(r.provider.id,r);}return {id,routes:[...chosen.values()].sort((a,b)=>a.provider.priority-b.provider.priority)};}
 };
}
