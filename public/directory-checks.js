(() => {
 const directory={models:[],running:false,siteRunning:false,controller:null,done:0,total:0,paused:0,testing:new Map()};
 const labels={unchecked:'未测',available:'可用',timeout:'超时',rate_limited:'限流',unauthorized:'无权限',not_found:'模型不存在',unsupported:'请求不支持',empty:'没有文字',network_error:'连接失败',error:'上游报错',no_credit:'余额不足'};
 const routes=m=>m?.gateway?.probe_routes||[],good=r=>r.status==='available'&&!r.stale,needs=r=>r.stale||!r.checked_at||r.status==='unchecked';
 function status(m){const rs=routes(m);return !rs.length?'disabled':rs.some(good)?'available':rs.some(needs)?'unchecked':'issues';}
 function controls(){const busy=directory.running||directory.siteRunning;$('test-directory').disabled=busy||!directory.models.some(m=>routes(m).length);$('retry-directory').disabled=busy||!directory.models.some(m=>routes(m).some(r=>!good(r)));$('directory-timeout').disabled=busy;$('stop-directory').hidden=!directory.running;document.querySelectorAll('[data-directory-probe]').forEach(b=>b.disabled=busy||!routes(directory.models.find(m=>m.id===b.dataset.directoryProbe)).length);}
 function render(){
  const search=$('directory-search').value.trim().toLowerCase(),filter=$('directory-filter').value,shown=directory.models.filter(m=>m.id.toLowerCase().includes(search)&&(filter==='all'||filter==='original'&&m.gateway.naming==='original'||filter===status(m)));
  $('merged-model-list').replaceChildren();const enabled=directory.models.filter(m=>routes(m).length),available=enabled.filter(m=>status(m)==='available').length,original=directory.models.filter(m=>m.gateway.naming==='original').length;$('directory-summary').textContent=directory.models.length+' 个模型名称 · '+original+' 个原名保留 · '+enabled.length+' 个已加入酒馆 · '+available+' 个有实测可用线路';
  for(const m of shown){const e=node('article',undefined,'directory-model');e.dataset.directoryModel=m.id;const heading=node('div',undefined,'directory-model-heading'),kind=status(m),n=routes(m).filter(good).length;
   const badge=directory.testing.has(m.id)?'测试中…':kind==='disabled'?'未启用':kind==='available'?'可用':kind==='unchecked'?'待实测':'暂未测通';
   heading.append(node('code',m.id),node('span',badge,'model-badge '+(directory.testing.has(m.id)?'testing':kind==='issues'?'error':kind==='disabled'?'unchecked':kind)),node('small',m.gateway.site_count+' 个站点 · '+routes(m).length+' 条启用线路 · '+n+' 条实测可用'));if(m.gateway.naming==='original')heading.append(node('span','原名保留','mapping-state'));
   const actions=node('div',undefined,'directory-actions'),test=action('测这个模型',()=>batch([m.id]));test.dataset.directoryProbe=m.id;test.setAttribute('aria-label','测试 '+m.id);const copy=action('复制',()=>navigator.clipboard.writeText(m.id));copy.setAttribute('aria-label','复制 '+m.id);actions.append(test,copy);heading.append(actions);e.append(heading);
   if(routes(m).length){const detail=node('details',undefined,'directory-sites');detail.append(node('summary','查看各站结果'));for(const r of routes(m)){const row=node('div',undefined,'directory-site');const outcome=r.stale?'需重测':labels[r.status]||r.status||'未测';row.append(node('span',r.provider_name),node('span',outcome,'model-badge '+(r.stale?'stale':r.status||'unchecked')));const measured=good(r)?r.first_token_ms??r.latency_ms:null;if(measured!==null&&measured!==undefined)row.append(node('small','首段正文 '+(measured/1000).toFixed(2)+' 秒'));else if(r.latency_ms!==null&&r.latency_ms!==undefined&&!r.stale)row.append(node('small','耗时 '+(r.latency_ms/1000).toFixed(2)+' 秒'));if(r.http_status&&!r.stale)row.append(node('small','HTTP '+r.http_status));if(r.checked_at)row.append(node('small',new Date(r.checked_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})));detail.append(row);}e.append(detail);}
   $('merged-model-list').append(e);
  }
  if(!shown.length)$('merged-model-list').append(node('p',directory.models.length?'没有符合筛选条件的模型。':'读取站点目录后，这里显示归并名称和原名保留的选项。','muted fine'));controls();
 }
 function progress(text){$('directory-progress').hidden=false;$('directory-progress-text').textContent=text+' '+directory.done+' / '+directory.total+' 条线路'+(directory.paused?' · '+directory.paused+' 条因站点限制跳过':'');$('directory-progress-bar').max=directory.total||1;$('directory-progress-bar').value=directory.done+directory.paused;}
 async function reload(session=state.session){if(!session||!state.admin)return;const data=await api('/admin/model-directory');if(state.session===session){directory.models=data.data;render();}}
 function wait(ms,signal){return new Promise(resolve=>{if(signal.aborted)return resolve();let timer;const stop=()=>{clearTimeout(timer);signal.removeEventListener('abort',stop);resolve();};timer=setTimeout(stop,ms);signal.addEventListener('abort',stop,{once:true});});}
 async function batch(ids,onlyIssues=false){
  if(directory.running||directory.siteRunning||!ids.length)return;const session=state.session,controller=new AbortController(),timeout=Number($('directory-timeout').value);directory.running=true;directory.controller=controller;directory.done=0;directory.paused=0;window.dispatchEvent(new CustomEvent('ling-directory-running',{detail:true}));controls();notice('');
  const blocked=new Map(),pauseUntil=new Map(),activeProviders=new Set();let queue=[],failed=false;
  try{
   await reload(session);if(controller.signal.aborted||state.session!==session)return;
   queue=directory.models.filter(m=>ids.includes(m.id)).flatMap(m=>routes(m).filter(r=>!onlyIssues||!good(r)).map(r=>({model:m,route:r})));directory.total=queue.length;if(!queue.length){notice('没有需要测试的已启用线路。');return;}progress('正在实测合并目录。');
   async function worker(){while(queue.length&&!controller.signal.aborted&&!failed){
    let at=queue.findIndex(t=>blocked.has(t.route.provider_id)||!activeProviders.has(t.route.provider_id)&&(pauseUntil.get(t.route.provider_id)||0)<=Date.now());if(at<0){await wait(250,controller.signal);continue;}
    const task=queue.splice(at,1)[0],{model,route}=task,pid=route.provider_id;if(blocked.has(pid)){directory.paused++;progress('受限站点已暂停，继续检查其他站点。');continue;}
    activeProviders.add(pid);directory.testing.set(model.id,(directory.testing.get(model.id)||0)+1);render();
    try{const response=await fetch(base+'/admin/models/probe',{method:'POST',headers:{authorization:'Bearer '+session,'content-type':'application/json'},body:JSON.stringify({provider_id:pid,model_id:route.model_id,timeout_seconds:timeout}),signal:controller.signal});const data=await response.json();if(!response.ok)throw new Error(explain(data.error?.code));
     if(controller.signal.aborted||state.session!==session)return;
     if(data.blocked){if(['provider_minute_limit','probe_busy'].includes(data.blocked)){pauseUntil.set(pid,Date.now()+Math.max(1,data.retry_after)*1000);queue.push(task);progress('达到检查速率，等待后继续；可以随时停止。');}else{blocked.set(pid,data.blocked);directory.paused++;progress('受限站点已暂停，继续检查其他站点。');}continue;}
     if(data.result.status!=='cancelled'){Object.assign(route,data.result,{stale:false,...(data.result.status==='available'?{first_token_ms:data.result.latency_ms}:{})});directory.done++;}
     if(['rate_limited','no_credit'].includes(route.status)||route.status==='unauthorized'&&route.http_status===401)blocked.set(pid,route.status);
     progress(blocked.size?'受限站点已暂停，继续检查其他站点。':'正在实测合并目录。');
    }catch(e){if(e.name!=='AbortError'){failed=true;notice(e.message);}}
    finally{activeProviders.delete(pid);const count=directory.testing.get(model.id)||0;if(count<=1)directory.testing.delete(model.id);else directory.testing.set(model.id,count-1);if(state.session===session)render();}
   }}
   await Promise.all([worker(),worker()]);
  }catch(e){if(e.name!=='AbortError'){failed=true;notice(e.message);}}
  finally{
   directory.running=false;directory.controller=null;directory.testing.clear();window.dispatchEvent(new CustomEvent('ling-directory-running',{detail:false}));
   if(state.session===session){render();progress(controller.signal.aborted?'已停止，已有结果保留。':failed?'检查中断，已有结果保留。':directory.paused?'检查完成，受限线路未判为不可用。':'检查完成。');await reload(session).catch(e=>notice(e.message));window.dispatchEvent(new Event('ling-models-updated'));window.dispatchEvent(new CustomEvent('ling-directory-finished'));}
  }
 }
 $('test-directory').onclick=()=>batch(directory.models.map(m=>m.id));$('retry-directory').onclick=()=>batch(directory.models.map(m=>m.id),true);$('stop-directory').onclick=()=>directory.controller?.abort();$('directory-search').oninput=render;$('directory-filter').onchange=render;
 window.addEventListener('ling-directory-loaded',e=>{if(!directory.running){directory.models=e.detail;render();}});window.addEventListener('ling-site-probe-running',e=>{directory.siteRunning=e.detail;controls();});
 window.addEventListener('ling-locked',()=>{directory.controller?.abort();directory.models=[];directory.testing.clear();$('merged-model-list').replaceChildren();$('directory-progress').hidden=true;$('directory-summary').textContent='';});
 render();
})();
