(() => {
 const checks={provider:'',models:[],running:false,controller:null,done:0,total:0,loading:0,generation:0,directoryRunning:false};
 const statusLabels={unchecked:'未检查',available:'可用',timeout:'超时',rate_limited:'限流',unauthorized:'没有权限',not_found:'模型不存在',unsupported:'请求不支持',empty:'没有文字',network_error:'连接失败',error:'上游报错',no_credit:'余额不足'};
 const good=m=>m.status==='available'&&!m.stale;
 function providers(){return state.data?.providers||[];}
 function controls(){const hasKey=providers().find(p=>p.id===checks.provider)?.has_key,busy=checks.running||checks.directoryRunning||checks.loading>0;
  $('probe-provider').disabled=busy;$('probe-timeout').disabled=busy;$('discover-models').disabled=busy||!hasKey;$('run-models').disabled=busy||!hasKey||!checks.models.some(m=>m.listed);$('retry-models').disabled=busy||!hasKey||!checks.models.some(m=>m.listed&&!good(m));$('manual-models').disabled=busy||!checks.provider;$('copy-models').disabled=!checks.models.some(m=>m.listed&&good(m));$('stop-models').hidden=!checks.running;
  $('model-results').querySelectorAll('.model-actions button:first-child').forEach(b=>b.disabled=busy||!hasKey);$('model-results').querySelectorAll('.model-actions button:last-child').forEach(b=>b.disabled=busy);
 }
 function fillProviders(event){const old=checks.running?checks.provider:event?.detail?.provider_id||checks.provider;$('probe-provider').replaceChildren();for(const p of providers())$('probe-provider').append(new Option(p.name+(p.has_key?'':' · 待填密钥'),p.id));
  checks.provider=providers().some(p=>p.id===old&&p.has_key)?old:(providers().find(p=>p.has_key)?.id||providers()[0]?.id||'');$('probe-provider').value=checks.provider;if(!checks.running)loadModels();else controls();
 }
 function renderModels(){
  const visible=checks.models.filter(m=>m.listed),counts=[[visible.filter(good).length,'实测可用'],[visible.filter(m=>!m.stale&&m.status!=='unchecked'&&!good(m)).length,'异常结果'],[visible.filter(m=>m.stale||m.status==='unchecked').length,'等待检查']];
  $('model-stats').replaceChildren();for(const [value,title]of counts){const n=node('div',undefined,'stat');n.append(node('b',String(value)),node('span',title));$('model-stats').append(n);}
  const search=$('model-search').value.trim().toLowerCase(),filter=$('model-filter').value;
  const shown=visible.filter(m=>(m.model_id+' '+m.name).toLowerCase().includes(search)).filter(m=>filter==='all'||filter==='available'&&good(m)||filter==='issues'&&!good(m)&&!m.stale&&m.status!=='unchecked'||filter==='unchecked'&&(m.stale||m.status==='unchecked'));
  $('model-results').replaceChildren();const configured=providers().find(p=>p.id===checks.provider)?.has_key;
  $('model-empty').hidden=visible.length>0;$('model-result-note').hidden=!visible.length;
  if(!visible.length){$('model-empty').querySelector('h3').textContent=configured?'读取列表，然后一键实测。':'先添加一个你想检查的站点。';$('model-empty').querySelector('p').textContent=configured?'也可以手动粘贴模型名称。每个结果都会保存，之后不用从头再测。':'填写站点的 API 地址和密钥即可。无需启用聊天路由；密钥只保存在服务端。';}
  for(const m of shown){const row=node('article',undefined,'model-result'),identity=node('div',undefined,'model-identity');identity.append(node('code',m.model_id));identity.append(node('small','酒馆名称：'+(m.directory_id?m.directory_id+(m.canonical_id?'':'（原名保留）'):m.canonical_source==='manual'?'已手动隐藏':'需专用接口（暂不加入聊天目录）')));if(m.first_token_ms!==null&&m.first_token_ms!==undefined&&!m.stale)identity.append(node('small','首段正文 '+(m.first_token_ms/1000).toFixed(2)+' 秒'));if(m.name!==m.model_id)identity.append(node('small',m.name));if(m.returned_model&&m.returned_model!==m.model_id)identity.append(node('small','上游返回：'+m.returned_model));
   const label=m.checking?'检查中…':m.stale?'需重测':statusLabels[m.status]||m.status;const outcome=node('div',undefined,'model-outcome');outcome.append(node('span',label,'model-badge '+(m.checking?'testing':m.stale?'stale':m.status)));outcome.append(node('small',m.latency_ms===null||m.latency_ms===undefined?'—':(m.latency_ms/1000).toFixed(2)+' 秒'));
   const detail=node('div',undefined,'model-detail');detail.append(node('small',m.checked_at?new Date(m.checked_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚未发送生成请求'));if(m.http_status)detail.append(node('small','HTTP '+m.http_status));if(!m.stale&&m.diagnostic){detail.append(node('small',m.diagnostic.summary_zh));if(m.diagnostic.upstream_message)detail.append(node('small','上游说明：'+m.diagnostic.upstream_message));}
   const actions=node('div',undefined,'model-actions'),retry=action('重试',()=>batch([m]));retry.disabled=checks.running||checks.directoryRunning||checks.loading>0;actions.append(retry);
   const copy=action('复制',()=>navigator.clipboard.writeText(m.directory_id));copy.disabled=!m.directory_id;actions.append(copy);
   const mapping=action('归并',async()=>{const value=prompt('酒馆里显示的模型官方名称。不同站点填相同名称即可合并；留空则隐藏。上游请求仍使用原名称。',m.canonical_id||'');if(value===null)return;const r=await api('/admin/models/map','POST',{provider_id:checks.provider,model_id:m.model_id,canonical_id:value.trim()||null});checks.models=r.models;renderModels();await loadDirectory();window.dispatchEvent(new Event('ling-models-updated'));});mapping.disabled=checks.running||checks.directoryRunning;actions.append(mapping);
   row.append(identity,outcome,detail,actions);$('model-results').append(row);
  }
  if(visible.length&&!shown.length)$('model-results').append(node('p','没有符合筛选条件的模型。','empty'));controls();
 }
 async function loadModels(){const id=checks.provider,generation=++checks.generation;if(!id){checks.models=[];renderModels();return;}checks.loading++;controls();try{const r=await api('/admin/models?provider_id='+encodeURIComponent(id));if(generation===checks.generation){checks.models=r.models;renderModels();}await loadDirectory();}catch(e){notice(e.message);}finally{checks.loading--;controls();}}
 async function loadDirectory(){const session=state.session;if(!state.admin||!session)return;const r=await api('/admin/model-directory');if(state.session!==session)return;window.dispatchEvent(new CustomEvent('ling-directory-loaded',{detail:r.data}));window.dispatchEvent(new CustomEvent('ling-mapping-loaded',{detail:r.mapping}));}
 async function loading(fn){checks.loading++;controls();try{await fn();}catch(e){notice(e.message);}finally{checks.loading--;controls();}}
 const setProgress=text=>{$('probe-progress').hidden=false;$('probe-progress-text').textContent=text;$('probe-progress-count').textContent=checks.done+' / '+checks.total;$('probe-progress-bar').max=checks.total||1;$('probe-progress-bar').value=checks.done;};
 async function waitFor(ms,signal){return new Promise(resolve=>{if(signal.aborted){resolve();return;}const onAbort=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},ms);signal.addEventListener('abort',onAbort,{once:true});});}
 async function batch(models){if(checks.running||checks.directoryRunning||!models.length)return;checks.running=true;window.dispatchEvent(new CustomEvent('ling-site-probe-running',{detail:true}));checks.done=0;checks.total=models.length;checks.controller=new AbortController();const controller=checks.controller,id=checks.provider,timeout=Number($('probe-timeout').value);let at=0,halted=false,pauseUntil=0;
  controls();notice('');setProgress('正在检查，结果会逐个显示。');
  async function worker(){while(at<models.length&&!controller.signal.aborted&&!halted){if(pauseUntil>Date.now()){await waitFor(Math.min(1000,pauseUntil-Date.now()),controller.signal);continue;}const m=models[at++];let retry=true;
   while(retry&&!controller.signal.aborted&&!halted){retry=false;m.checking=true;renderModels();
    try{const r=await fetch(base+'/admin/models/probe',{method:'POST',headers:{authorization:'Bearer '+state.session,'content-type':'application/json'},body:JSON.stringify({provider_id:id,model_id:m.model_id,timeout_seconds:timeout}),signal:controller.signal});const data=await r.json();if(!r.ok)throw new Error(errorMessage(data.error));
     if(data.blocked){m.checking=false;if(['provider_minute_limit','probe_busy'].includes(data.blocked)){const seconds=Math.max(1,data.retry_after);pauseUntil=Math.max(pauseUntil,Date.now()+seconds*1000);setProgress('达到站点检查速率，约 '+seconds+' 秒后继续；可以随时停止。');await waitFor(seconds*1000,controller.signal);retry=true;continue;}halted=true;notice(data.blocked==='provider_daily_limit'?'这条站点的站内日上限已用完。剩余模型保持未检查；可在站点配置调整上限。':data.blocked);break;}
     if(data.result.status!=='cancelled'){Object.assign(m,data.result,{stale:false,checking:false});checks.done++;}
     if(['rate_limited','no_credit'].includes(data.result.status)||data.result.status==='unauthorized'&&data.result.http_status===401){halted=true;notice(data.result.status==='rate_limited'?'上游开始限流，已暂停批量检查；剩余模型未判为不可用。':data.result.status==='no_credit'?'上游提示余额不足，已暂停检查。':'上游拒绝这个密钥，已暂停检查。请核对密钥后重试。');}
     setProgress(halted?'检查已暂停。':'正在检查，结果会逐个显示。');
    }catch(e){if(e.name!=='AbortError'){halted=true;notice(e.message);}}finally{m.checking=false;renderModels();}
   }
  }}
  try{await Promise.all([worker(),worker()]);}finally{checks.running=false;window.dispatchEvent(new CustomEvent('ling-site-probe-running',{detail:false}));checks.controller=null;models.forEach(m=>m.checking=false);renderModels();setProgress(controller.signal.aborted?'已停止，已有结果保留。':halted?'检查已暂停，已有结果保留。':'检查完成。');await loadModels();}
 }
 $('probe-provider').onchange=()=>{checks.provider=$('probe-provider').value;checks.models=[];renderModels();loadModels();};
 $('discover-models').onclick=()=>loading(async()=>{const r=await api('/admin/models/discover','POST',{provider_id:checks.provider});checks.models=r.models;renderModels();await loadDirectory();window.dispatchEvent(new Event('ling-models-updated'));notice('已读到 '+r.catalog_count+' 个候选模型。已识别的名称自动归并，未知型号原名保留；可以一键实测，或按需手动修改名称。');});
 $('run-models').onclick=()=>batch(checks.models.filter(m=>m.listed));$('retry-models').onclick=()=>batch(checks.models.filter(m=>m.listed&&!good(m)));$('stop-models').onclick=()=>checks.controller?.abort();
 $('model-search').oninput=renderModels;$('model-filter').onchange=renderModels;
 $('copy-models').onclick=()=>navigator.clipboard.writeText([...new Set(checks.models.filter(m=>m.listed&&good(m)&&m.directory_id).map(m=>m.directory_id))].join('\n')).then(()=>notice('实测可用的酒馆模型名称已复制。')).catch(()=>notice('复制失败，可单独复制某个模型名称。'));
 $('model-add-provider').onclick=()=>editProvider();
 $('manual-models').onclick=()=>{$('manual-model-error').textContent='';$('manual-model-input').value='';$('manual-model-dialog').showModal();};
 $('manual-model-form').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{const models=$('manual-model-input').value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);const r=await api('/admin/models/add','POST',{provider_id:checks.provider,models});checks.models=r.models;$('manual-model-dialog').close();renderModels();await loadDirectory();window.dispatchEvent(new Event('ling-models-updated'));}catch(e){$('manual-model-error').textContent=e.message;}finally{e.submitter.disabled=false;}};
 window.addEventListener('ling-directory-running',e=>{checks.directoryRunning=e.detail;controls();});window.addEventListener('ling-directory-finished',()=>loadModels());window.addEventListener('ling-refreshed',fillProviders);window.addEventListener('ling-locked',()=>{checks.controller?.abort();checks.generation++;checks.models=[];checks.provider='';$('model-results').replaceChildren();$('merged-model-list').replaceChildren();});
 window.addEventListener('ling-mapping-saved',e=>{if(e.detail.provider_id===checks.provider){checks.models=e.detail.models;renderModels();}});
 if(state.data)fillProviders();else renderModels();
})();
