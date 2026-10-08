import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dispatchRoutes,rankRoutes,routingPolicy} from '../src/routing.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const routes=[1,2,3,4].map(id=>({id,provider:{id,priority:10,total_attempts:10,total_errors:0},status:'unchecked'}));
test('new deployment defaults to smart, four seconds, three multi-reply sites',()=>{
 assert.deepEqual(routingPolicy(),{mode:'smart',hedge_delay_ms:4000,multi_reply_limit:3});
});
test('fast primary uses exactly one site and waits for saving to complete',async()=>{
 const called=[];let saved=false;await dispatchRoutes(routes,{mode:'smart',hedge_delay_ms:20},async(r,h)=>{called.push(r.id);h.visible();h.complete();await wait(5);saved=true;});assert.deepEqual(called,[1]);assert.equal(saved,true);
});
test('soft delay starts backup, keeps the slow original, and never starts a third after text',async()=>{
 const called=[],completed=[];await dispatchRoutes(routes,{mode:'smart',hedge_delay_ms:10},async(r,h)=>{called.push(r.id);await wait(r.id===1?35:1);h.visible();completed.push(r.id);h.complete();});assert.deepEqual(called,[1,2]);assert.deepEqual(completed,[2,1]);
});
test('error frees its slot immediately, before persistence and without waiting the hedge delay',async()=>{
 const called=[],states=[];await dispatchRoutes(routes,{mode:'smart',hedge_delay_ms:1000},async(r,h)=>{called.push(r.id);if(r.id===1){h.complete();await wait(10);states.push('saved error');}else{states.push('backup started');h.visible();h.complete();}});assert.deepEqual(called,[1,2]);assert.deepEqual(states,['backup started','saved error']);
});
test('repeated failures keep smart concurrency at two and refill free slots',async()=>{
 let active=0,maximum=0;const called=[];await dispatchRoutes(routes,{mode:'smart',hedge_delay_ms:2},async(r,h)=>{active++;maximum=Math.max(active,maximum);called.push(r.id);await wait(5);active--;h.complete();});assert.equal(maximum,2);assert.deepEqual(called,[1,2,3,4]);
});
test('sequential sends one at a time and stops when the second produces text',async()=>{
 let active=0,maximum=0;const called=[];await dispatchRoutes(routes,{mode:'sequential'},async(r,h)=>{called.push(r.id);active++;maximum=Math.max(maximum,active);await wait(2);if(r.id===2)h.visible();active--;h.complete();});assert.deepEqual(called,[1,2]);assert.equal(maximum,1);
});
test('parallel respects selected site count, including explicit all-sites option',async()=>{
 for(const limit of [2,3,0]){const called=[];await dispatchRoutes(routes,{mode:'parallel',multi_reply_limit:limit},async(r,h)=>{called.push(r.id);await wait(1);h.visible();h.complete();});assert.equal(called.length,limit||4);}
});
test('cancellation stops queued requests even when active persistence continues',async()=>{
 const controller=new AbortController(),called=[];await dispatchRoutes(routes,{mode:'smart',hedge_delay_ms:10},async(r,h)=>{called.push(r.id);controller.abort();await wait(20);h.complete();},{signal:controller.signal});assert.deepEqual(called,[1]);
});
test('expired overall deadline dispatches nothing',async()=>{
 let called=0;await dispatchRoutes(routes,{mode:'parallel',multi_reply_limit:0},()=>called++,{deadline:Date.now()-1});assert.equal(called,0);
});
test('selection favors verified models; stale checks and active circuits lose priority',()=>{
 const a={...routes[0],status:'available',first_token_ms:200},b={...routes[1],status:'available',first_token_ms:50},stale={...routes[2],status:'available',stale:true,first_token_ms:1},cool={...routes[3],status:'available',provider:{...routes[3].provider,open_until:new Date(Date.now()+60000).toISOString()}};assert.deepEqual(rankRoutes([stale,cool,a,b]).map(r=>r.id),[2,1,3,4]);
});
