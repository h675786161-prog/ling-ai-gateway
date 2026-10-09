import {manifest,identifier,transaction} from './schema.mjs';
import {seal,unseal} from '../src/gateway.mjs';
import {decryptSnapshot,importOrder} from '../src/migration.mjs';

const json=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const counts=tables=>Object.fromEntries(importOrder.map(name=>[name,tables[name].length]));

export async function createMigrationTarget({pool,masterKey,bootstrapToken,onImported}){
 if(typeof masterKey!=='string'||masterKey.length<32||typeof bootstrapToken!=='string'||bootstrapToken.length<32)throw new Error('migration_server_credentials_required');
 const keys=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:3072,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['encrypt','decrypt']);
 const publicKey=await crypto.subtle.exportKey('jwk',keys.publicKey);
 let imported=!!(await pool.query('select id from public.ling_gateway_runtime where id')).rows.length;
 async function load(){
  const row=(await pool.query('select encryption_key_cipher from public.ling_gateway_runtime where id')).rows[0];
  return row?unseal(row.encryption_key_cipher,masterKey):null;
 }
 async function importSnapshot(snapshot){
  const result=await transaction(pool,async client=>{
   await client.query('select pg_advisory_xact_lock(71607192)');
   if((await client.query('select id from public.ling_gateway_runtime where id')).rows.length)throw new Error('migration_already_completed');
   for(const name of importOrder){
    const table=manifest.tables.find(t=>t.name==='ling_gateway_'+name);
    if((await client.query('select count(*)::integer as count from public.'+identifier(table.name))).rows[0].count)throw new Error('migration_target_not_empty');
    const columns=new Map(table.columns.map(c=>[c.name,c]));
    for(const row of snapshot.tables[name]){
     const fields=Object.keys(row);if(!fields.length||fields.some(f=>!columns.has(f)))throw new Error('migration_schema_mismatch');
     const values=fields.map(f=>columns.get(f).type==='jsonb'&&row[f]!==null?JSON.stringify(row[f]):row[f]);
     await client.query('insert into public.'+identifier(table.name)+' ('+fields.map(identifier).join(',')+') values ('+fields.map((_,i)=>'$'+(i+1)).join(',')+')',values);
    }
   }
   // Verify that every transferred ciphertext is usable before committing any data.
   for(const p of snapshot.tables.providers)if(p.secret_cipher)await unseal(p.secret_cipher,snapshot.encryption_key);
   const transferred=counts(snapshot.tables);
   for(const name of importOrder){const n=(await client.query('select count(*)::integer as count from public.'+identifier('ling_gateway_'+name))).rows[0].count;if(n!==transferred[name])throw new Error('migration_row_count_mismatch');}
   const wrapped=await seal(snapshot.encryption_key,masterKey);
   await client.query('insert into public.ling_gateway_runtime(id,encryption_key_cipher,source,counts) values(true,$1::jsonb,$2,$3::jsonb)',[JSON.stringify(wrapped),String(snapshot.source||'ling-ai-gateway'),JSON.stringify(transferred)]);
   return transferred;
  });
  imported=true;await onImported?.(snapshot.encryption_key);return result;
 }
 async function handle(req){
  const path=new URL(req.url).pathname;
  if(!path.startsWith('/migration/'))return null;
  // This bootstrap credential is separate from all user keys and is disabled after import.
  if(imported)return new Response(JSON.stringify({error:{code:'migration_already_completed'}}),{status:410,headers:{'content-type':'application/json','cache-control':'no-store'}});
  const token=(req.headers.get('authorization')||'').match(/^Bearer (\S+)$/)?.[1];
  if(token!==bootstrapToken)return new Response(JSON.stringify({error:{code:'unauthorized'}}),{status:401,headers:{'content-type':'application/json','cache-control':'no-store'}});
  if(path==='/migration/key'&&req.method==='GET')return json({version:1,public_key:publicKey});
  if(path==='/migration/import'&&req.method==='POST'){
   const reader=req.body?.getReader();if(!reader)return new Response(null,{status:400});
   const chunks=[];let length=0;
   while(true){const item=await reader.read();if(item.done)break;length+=item.value.byteLength;if(length>34603008){await reader.cancel();return new Response(null,{status:413});}chunks.push(item.value);}
   const raw=new Uint8Array(length);let at=0;for(const b of chunks){raw.set(b,at);at+=b.length;}
   try{const envelope=JSON.parse(new TextDecoder().decode(raw)),snapshot=await decryptSnapshot(envelope,keys.privateKey);return json({ok:true,counts:await importSnapshot(snapshot)});}
   catch(e){const allowed=['migration_already_completed','migration_target_not_empty','migration_schema_mismatch','migration_row_count_mismatch'];const code=allowed.includes(e.message)?e.message:'migration_import_failed';return new Response(JSON.stringify({error:{code}}),{status:409,headers:{'content-type':'application/json','cache-control':'no-store'}});}
  }
  return new Response(null,{status:404});
 }
 return {handle,load,importSnapshot,isImported:()=>imported,publicKey};
}
