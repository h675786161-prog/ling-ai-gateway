import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createGateway,digest} from '../src/gateway.mjs';

async function fixture(independent=true) {
  const accessHash=await digest('fixture-independent-code'),sharedHash=await digest('fixture-shared-code'),adminHash=await digest('fixture-admin-session');
  let sharedReads=0;
  const settings={access_code_hash:independent?accessHash:null,monitor_hash:'hidden-monitor-hash',routing_mode:'smart'};
  const db={
    async table(name){if(name==='settings')return [settings];if(name==='users')return [{id:'owner',role:'admin',enabled:true}];if(name==='keys')return [{id:'session',user_id:'owner',key_hash:adminHash,admin_access:true}];return [];},
    async request(){sharedReads++;return [{state:{hash:sharedHash}}];},
    async rpc(){return true;},
    async write(name,method,data){if(name==='settings')Object.assign(settings,data);return [{id:'issued',...data}];}
  };
  const gateway=createGateway({SUPABASE_SERVICE_ROLE_KEY:'fixture-secret'},{db});
  const login=password=>gateway(new Request('https://gateway.example.org/admin/login',{method:'POST',body:JSON.stringify({password})}));
  const admin=(path,method='GET',body)=>gateway(new Request('https://gateway.example.org'+path,{method,headers:{authorization:'Bearer fixture-admin-session'},body:body===undefined?undefined:JSON.stringify(body)}));
  return {login,admin,sharedReads:()=>sharedReads,accessHash};
}

test('independent gateway gate accepts its code and rejects old website code without reading website state',async()=>{
  const f=await fixture();const correct=await f.login('fixture-independent-code');assert.equal(correct.status,200);const session=(await correct.json()).session;assert.ok(session.key.startsWith('lg_'));
  assert.equal((await f.login('fixture-shared-code')).status,401);assert.equal((await f.login('incorrect')).status,401);assert.equal(f.sharedReads(),0);
});
test('unconfigured independent gate keeps legacy shared-code compatibility',async()=>{
  const f=await fixture(false);assert.equal((await f.login('fixture-shared-code')).status,200);assert.equal(f.sharedReads(),1);
});
test('management overview and settings responses never send gate or monitor hashes to browser',async()=>{
  const f=await fixture();for(const response of [await f.admin('/admin/overview'),await f.admin('/admin/settings','PATCH',{routing_mode:'sequential'})]){
    assert.equal(response.status,200);const settings=(await response.json()).settings;assert.equal(settings.access_code_hash,undefined);assert.equal(settings.monitor_hash,undefined);assert.ok(settings.routing_mode);
  }
});
test('admin can remove the output cap and optionally save caps above the previous 32768 ceiling',async()=>{
 const f=await fixture();
 for(const value of [65536,131072,null]){
  const response=await f.admin('/admin/settings','PATCH',{max_output_tokens:value});assert.equal(response.status,200);assert.equal((await response.json()).settings.max_output_tokens,value);
  assert.equal((await (await f.admin('/admin/overview')).json()).settings.max_output_tokens,value);
 }
 for(const value of [0,-1,1.5,'65536',9007199254740992])assert.equal((await f.admin('/admin/settings','PATCH',{max_output_tokens:value})).status,400);
 assert.equal((await (await f.admin('/admin/overview')).json()).settings.max_output_tokens,null);
});
