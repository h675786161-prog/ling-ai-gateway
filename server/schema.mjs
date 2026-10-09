import {readFile} from 'node:fs/promises';

export const manifest=JSON.parse(await readFile(new URL('./schema.json',import.meta.url),'utf8'));
export const identifier=name=>{if(!/^[a-z][a-z0-9_]*$/.test(name))throw new Error('invalid_database_identifier');return '"'+name+'"';};
export const tableNames=manifest.tables.map(t=>t.name.slice('ling_gateway_'.length));
// A live standalone stream may run for one hour; repair only records beyond that window.
const maintenanceDefinition=manifest.functions.find(f=>f.name==='ling_gateway_maintenance').definition;
export const maintenanceSQL=maintenanceDefinition.replace("interval '5 minutes'","interval '70 minutes'")+';';
export const snapshotSQL='create or replace function public.ling_gateway_migration_snapshot() returns jsonb language sql stable security invoker set search_path = \'\' as $snapshot$ select jsonb_build_object('+manifest.tables.map(t=>"'"+t.name.slice('ling_gateway_'.length)+"',coalesce((select jsonb_agg(to_jsonb(t)) from public."+identifier(t.name)+" t),'[]'::jsonb)").join(',')+'); $snapshot$; revoke all on function public.ling_gateway_migration_snapshot() from public;';

export function schemaSQL(){
 const parts=[];
 for(const t of manifest.tables){
  if(!t.name.startsWith('ling_gateway_'))throw new Error('unexpected_database_table');
  if(t.columns.some(c=>c.generated||c.identity))throw new Error('unsupported_generated_column');
  parts.push('create table public.'+identifier(t.name)+' ('+t.columns.map(c=>identifier(c.name)+' '+c.type+(c.default?' default '+c.default:'')+(c.not_null?' not null':'')).join(',')+');');
 }
 // Primary and unique constraints must exist before foreign keys are restored.
 for(const foreign of [false,true])for(const t of manifest.tables)for(const c of t.constraints){
  if((c.type==='f')!==foreign)continue;
  parts.push('alter table public.'+identifier(t.name)+' add constraint '+identifier(c.name)+' '+c.definition+';');
 }
 for(const t of manifest.tables){
  for(const index of t.indexes)parts.push(index+';');
  if(t.rls)parts.push('alter table public.'+identifier(t.name)+' enable row level security;');
  parts.push('revoke all on public.'+identifier(t.name)+' from public;');
 }
 for(const f of manifest.functions){
  if(!f.name.startsWith('ling_gateway_'))throw new Error('unexpected_database_function');
  parts.push(f.name==='ling_gateway_maintenance'?maintenanceSQL:f.definition+';');
  parts.push('revoke all on function public.'+identifier(f.name)+'('+(f.arg_types||[]).join(',')+') from public;');
 }
 parts.push(snapshotSQL);
 parts.push('create table public.ling_gateway_runtime (id boolean primary key default true check(id), encryption_key_cipher jsonb not null, source text not null, counts jsonb not null, imported_at timestamptz not null default now());');
 parts.push('alter table public.ling_gateway_runtime enable row level security; revoke all on public.ling_gateway_runtime from public;');
 return parts.join('\n');
}

export async function transaction(pool,fn){
 if(typeof pool.transaction==='function')return pool.transaction(fn);
 const client=await pool.connect();
 try{await client.query('begin');const result=await fn(client);await client.query('commit');return result;}
 catch(e){await client.query('rollback').catch(()=>{});throw e;}
 finally{client.release();}
}

export async function initializeSchema(pool){
 return transaction(pool,async client=>{
  await client.query('select pg_advisory_xact_lock(71607191)');
  const state=(await client.query("select to_regclass('public.ling_gateway_runtime') as runtime")).rows[0];
  if(state.runtime){await client.query(maintenanceSQL);return false;}
  const existing=(await client.query("select count(*)::integer as count from pg_tables where schemaname='public' and tablename like 'ling_gateway_%'")).rows[0];
  if(existing.count)throw new Error('database_requires_manual_schema_review');
  await client.query(schemaSQL());
  return true;
 });
}
