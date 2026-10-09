import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {initializeSchema,tableNames} from '../server/schema.mjs';
import {PostgresDB} from '../server/postgres.mjs';
import {createMigrationTarget} from '../server/migration-target.mjs';
import {createHTTPServer} from '../server/http.mjs';
import {createGateway,digest,seal,unseal} from '../src/gateway.mjs';
import {exportGatewaySnapshot,encryptSnapshot,decryptSnapshot} from '../src/migration.mjs';

const sourceSecret='a'.repeat(64),masterKey='b'.repeat(64),bootstrapToken='c'.repeat(64);
const upstreamKey='TEST_UPSTREAM_KEY_NOT_A_REAL_CREDENTIAL';
const apiKey='TEST_APPLICATION_KEY_NOT_A_REAL_CREDENTIAL';
const gate='TEST_GATE_NOT_A_REAL_PASSWORD';
const poolFor=lite=>{
 const wrap=client=>({query:async(sql,args)=>args===undefined&&sql.includes(';')?(await client.exec(sql)).at(-1):client.query(sql,args)});
 return {...wrap(lite),transaction:fn=>lite.transaction(client=>fn(wrap(client)))};
};
async function fixture(t,seed=false){
 const lite=new PGlite(),pool=poolFor(lite);t.after(()=>lite.close());
 await initializeSchema(pool);const db=new PostgresDB(pool);
 if(seed){
  const user=(await db.write('users','POST',{name:'迁移测试账号',role:'admin',daily_limit:null}))[0];
  await db.write('settings','POST',{id:true,access_code_hash:await digest(gate),max_output_tokens:null,first_output_timeout_ms:90000,hedge_delay_ms:10000,routing_mode:'smart'});
  await db.write('keys','POST',{user_id:user.id,key_hash:await digest(apiKey),prefix:'TEST_KEY',name:'测试应用',admin_access:false});
  const provider=(await db.write('providers','POST',{name:'迁移测试线路',kind:'custom',base_url:'https://example.com/v1',secret_cipher:await seal(upstreamKey,sourceSecret),enabled:true,aliases:{fast:'gemini-3.8-flash'}}))[0];
  const configHash=await digest(provider.kind+'\n'+provider.base_url+'\n'+JSON.stringify(provider.secret_cipher));
  await db.rpc('model_catalog',{p_provider:provider.id,p_models:[{id:'agycli-gemini-3.8-flash-high',canonical_id:'gemini-3.8-flash'}]});
  await db.write('models','PATCH',{status:'available',config_hash:configHash,canonical_source:'manual'},'?provider_id=eq.'+provider.id+'&model_id=eq.agycli-gemini-3.8-flash-high');
  const log=(await db.write('logs','POST',{user_id:user.id,model:'gemini-3.8-flash',status:'success',attempts:[{provider_id:provider.id,status:200}]}))[0];
  await db.write('replies','POST',{log_id:log.id,provider_id:provider.id,provider_name:provider.name,upstream_model:'agycli-gemini-3.8-flash-high',choice_index:0,status:'success',message:{role:'assistant',content:'这是迁移前保存的测试回复。'}});
 }
 return {lite,pool,db};
}

test('PostgreSQL schema and binding preserve limits, JSON arrays, filtering, and manual names',async t=>{
 const {pool,db}=await fixture(t,true);
 assert.equal(tableNames.length,10);
 const settings=(await db.table('settings'))[0];
 assert.equal(settings.max_output_tokens,null);assert.equal(settings.first_output_timeout_ms,90000);assert.equal(settings.hedge_delay_ms,10000);
 const log=(await db.table('logs'))[0];assert.equal(log.attempts[0].status,200);
 const model=(await db.table('models'))[0];assert.equal(model.canonical_source,'manual');
 const hostile="gemini-3.8-flash'); DROP TABLE ling_gateway_users; --";
 await db.write('models','PATCH',{model_id:hostile},'?provider_id=eq.'+model.provider_id+'&model_id=eq.'+encodeURIComponent(model.model_id));
 assert.equal((await db.table('models','?model_id=eq.'+encodeURIComponent(hostile)))[0].model_id,hostile);
 assert.equal((await db.table('users')).length,1);
 await assert.rejects(db.table('models','?id%3BDROP=eq.x'),/invalid_database_column/);
 await assert.rejects(db.table('models','?order=model_id.asc%3BDROP'),/invalid_database_order/);
 await assert.rejects(db.write('users','DELETE',{}),/unbounded_database_write/);
 assert.equal(await initializeSchema(pool),false);
});

test('encrypted migration preserves application keys, gate, mappings, replies, and usable upstream secrets',async t=>{
 const source=await fixture(t,true),target=await fixture(t);
 let activated=null;
 const migration=await createMigrationTarget({pool:target.pool,masterKey,bootstrapToken,onImported:key=>{activated=key;}});
 const exported=await exportGatewaySnapshot({db:source.db,secret:sourceSecret,unseal,seal,digest,publicKey:migration.publicKey});
 const serialized=JSON.stringify(exported);assert.ok(!serialized.includes(upstreamKey));assert.ok(!serialized.includes(gate));assert.ok(!serialized.includes(apiKey));
 const unauthorized=await migration.handle(new Request('http://target/migration/import',{method:'POST',body:JSON.stringify(exported.envelope)}));assert.equal(unauthorized.status,401);
 const response=await migration.handle(new Request('http://target/migration/import',{method:'POST',headers:{authorization:'Bearer '+bootstrapToken},body:JSON.stringify(exported.envelope)}));assert.equal(response.status,200);
 const imported=await response.json();assert.deepEqual(imported.counts,exported.counts);assert.ok(activated);assert.notEqual(activated,sourceSecret);
 const provider=(await target.db.table('providers'))[0];assert.equal(await unseal(provider.secret_cipher,activated),upstreamKey);
 const model=(await target.db.table('models'))[0];assert.equal(model.canonical_source,'manual');assert.equal(model.config_hash,await digest(provider.kind+'\n'+provider.base_url+'\n'+JSON.stringify(provider.secret_cipher)));
 assert.equal((await target.db.table('keys'))[0].key_hash,await digest(apiKey));assert.equal((await target.db.table('settings'))[0].access_code_hash,await digest(gate));
 assert.equal((await target.db.table('replies'))[0].message.content,'这是迁移前保存的测试回复。');
 const stored=(await target.pool.query('select encryption_key_cipher from public.ling_gateway_runtime')).rows[0];assert.ok(!JSON.stringify(stored).includes(activated));
 assert.equal(await migration.load(),activated);
 const retired=await migration.handle(new Request('http://target/migration/key',{headers:{authorization:'Bearer '+bootstrapToken}}));assert.equal(retired.status,410);
 await assert.rejects(migration.importSnapshot({tables:{}}),/migration_already_completed/);
});

test('migration rejects tampered ciphertext and rolls back an invalid provider secret',async t=>{
 const source=await fixture(t,true),target=await fixture(t);
 const migration=await createMigrationTarget({pool:target.pool,masterKey,bootstrapToken});
 const rsa=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['encrypt','decrypt']);
 const pub=await crypto.subtle.exportKey('jwk',rsa.publicKey);
 const exported=await exportGatewaySnapshot({db:source.db,secret:sourceSecret,unseal,seal,digest,publicKey:pub});
 const changed=structuredClone(exported.envelope);changed.ciphertext=(changed.ciphertext[0]==='a'?'b':'a')+changed.ciphertext.slice(1);
 await assert.rejects(decryptSnapshot(changed,rsa.privateKey));
 const snapshot=await decryptSnapshot(exported.envelope,rsa.privateKey);snapshot.tables.providers[0].secret_cipher.data='00';
 const invalid=await encryptSnapshot(snapshot,migration.publicKey);
 const failed=await migration.handle(new Request('http://target/migration/import',{method:'POST',headers:{authorization:'Bearer '+bootstrapToken},body:JSON.stringify(invalid)}));
 assert.equal(failed.status,409);assert.equal(migration.isImported(),false);
 for(const name of tableNames)assert.equal((await target.db.table(name)).length,0);
 assert.equal((await target.pool.query('select count(*)::integer as count from public.ling_gateway_runtime')).rows[0].count,0);
});

test('standalone HTTP serves the gated application and authenticated model directory from PostgreSQL',async t=>{
 const {db}=await fixture(t,true),gateway=createGateway({ENCRYPTION_KEY:sourceSecret},{db}),server=createHTTPServer({handle:gateway});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base='http://127.0.0.1:'+server.address().port;
 const home=await fetch(base+'/');assert.equal(home.status,200);assert.ok((await home.text()).includes('模型检查'));
 const config=await(await fetch(base+'/config.js')).text();assert.ok(config.includes('window.location.origin'));assert.ok(!config.includes('supabase.co'));
 assert.equal((await fetch(base+'/server/schema.json')).status,404);
 assert.equal((await fetch(base+'/v1/models')).status,401);
 const directory=await(await fetch(base+'/v1/models',{headers:{authorization:'Bearer '+apiKey}})).json();assert.ok(directory.data.some(m=>m.id==='gemini-3.8-flash'));
 assert.equal((await fetch(base+'/admin/migration/export',{method:'POST',headers:{authorization:'Bearer '+apiKey},body:'{}'})).status,401);
 assert.equal((await fetch(base+'/internal/health',{method:'POST'})).status,401);
 const login=await(await fetch(base+'/admin/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:gate})})).json();assert.ok(login.session.key);
 const overview=await(await fetch(base+'/admin/overview',{headers:{authorization:'Bearer '+login.session.key}})).json();assert.equal(overview.providers.length,1);assert.ok(!JSON.stringify(overview).includes(upstreamKey));assert.ok(!overview.providers[0].secret_cipher);
 const providerId=overview.providers[0].id;
 const hostile="manual-model'); DROP TABLE ling_gateway_users; --";
 const added=await fetch(base+'/admin/models/add',{method:'POST',headers:{authorization:'Bearer '+login.session.key,'content-type':'application/json'},body:JSON.stringify({provider_id:providerId,models:['agycli-gemini-3.8-flash-high',hostile]})});
 assert.equal(added.status,200);assert.equal((await added.json()).models.length,2);
 const original=(await db.table('models','?model_id=eq.agycli-gemini-3.8-flash-high'))[0];assert.equal(original.canonical_source,'manual');assert.equal(original.status,'available');
 assert.equal((await db.table('models','?model_id=eq.'+encodeURIComponent(hostile))).length,1);assert.equal((await db.table('users')).length,1);
 await assert.rejects(db.request('private_site_state','GET'),/legacy_shared_gate_disabled/);
 const rsa=await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},false,['encrypt','decrypt']);
 const publicKey=await crypto.subtle.exportKey('jwk',rsa.publicKey);
 const exported=await(await fetch(base+'/admin/migration/export',{method:'POST',headers:{authorization:'Bearer '+login.session.key,'content-type':'application/json'},body:JSON.stringify({public_key:publicKey})})).json();
 assert.equal(exported.counts.models,2);assert.ok(exported.envelope);assert.ok(!JSON.stringify(exported).includes(upstreamKey));
 assert.equal((await decryptSnapshot(exported.envelope,rsa.privateKey)).tables.settings[0].access_code_hash,await digest(gate));
});

test('HTTP disconnect cancels the active response without retaining a running upstream stream',async t=>{
 let cancelled=false,aborted=false;
 const server=createHTTPServer({handle:async req=>{req.signal.addEventListener('abort',()=>{aborted=true;});return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: first\n\n'));},cancel(){cancelled=true;}}),{headers:{'content-type':'text/event-stream'}});}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/chat/completions',{method:'POST',body:'{}'}),reader=response.body.getReader();
 assert.ok((await reader.read()).value.length);await reader.cancel();
 const deadline=Date.now()+3000;while(Date.now()<deadline&&!(cancelled&&aborted))await new Promise(r=>setTimeout(r,20));
 assert.ok(cancelled);assert.ok(aborted);
});
