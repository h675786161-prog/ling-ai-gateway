(() => {
 const review={entries:[],counts:null,siteBusy:false,directoryBusy:false,saving:false,limit:50,editing:null};
 const titles={mapped:'已归并',unrecognized:'原名保留',non_chat:'专用接口',hidden:'手动隐藏'};
 function busy(){return review.siteBusy||review.directoryBusy||review.saving;}
 function render(){
  const c=review.counts||{total:0,mapped:0,unrecognized:0,non_chat:0,hidden:0};
  $('mapping-summary').textContent='模型名称归并 · '+c.unrecognized+' 条原名保留';
  $('mapping-overview-text').textContent='各站共 '+c.total+' 条记录 · '+c.mapped+' 条已归并 · '+c.unrecognized+' 条原名保留 · '+c.non_chat+' 条需专用接口 · '+c.hidden+' 条手动隐藏';
  $('mapping-stats').replaceChildren();
  for(const [key,label]of Object.entries(titles)){const button=node('button',undefined,'mapping-stat');button.type='button';button.dataset.mappingCategory=key;button.append(node('b',String(c[key])),node('span',label));button.classList.toggle('selected',$('mapping-filter').value===key);button.onclick=()=>{$('mapping-filter').value=key;review.limit=50;render();};$('mapping-stats').append(button);}
  const search=$('mapping-search').value.trim().toLowerCase(),filter=$('mapping-filter').value,provider=$('mapping-provider').value;
  const shown=review.entries.filter(m=>(filter==='all'||m.state===filter)&&(!provider||m.provider_id===provider)&&(m.model_id+' '+m.provider_name+' '+(m.canonical_id||'')).toLowerCase().includes(search));
  $('mapping-list').replaceChildren();
  for(const m of shown.slice(0,review.limit)){
   const row=node('article',undefined,'mapping-row');row.dataset.mappingModel=m.model_id;row.dataset.mappingProvider=m.provider_id;
   const identity=node('div',undefined,'mapping-identity');identity.append(node('code',m.model_id),node('small',m.provider_name+(m.enabled?'':' · 未启用')+(m.has_key?'':' · 待填密钥')));
   const detail=node('div',undefined,'mapping-detail');detail.append(node('span',titles[m.state],'mapping-state '+m.state),node('small',m.canonical_id?'酒馆名称：'+m.canonical_id:m.reason));
   const edit=action(m.state==='hidden'?'恢复 / 归并':'修改名称',()=>open(m));edit.dataset.mappingEdit='';edit.disabled=busy();
   row.append(identity,detail,edit);$('mapping-list').append(row);
  }
  if(!shown.length)$('mapping-list').append(node('p',filter==='unrecognized'?'没有按原名保留的型号。以后新读到的未知名称会集中列在这里。':'没有符合筛选条件的记录。','empty'));
  $('mapping-result-count').textContent='显示 '+Math.min(shown.length,review.limit)+' / '+shown.length+' 条；同一模型在不同站点分别计数。';
  $('mapping-more').hidden=shown.length<=review.limit;
  $('mapping-save').disabled=busy();$('mapping-hide').disabled=busy();
 }
 function receive(mapping){
  const selected=$('mapping-provider').value;review.entries=mapping?.entries||[];review.counts=mapping?.counts||null;
  $('mapping-provider').replaceChildren(new Option('所有站点',''));const providers=new Map(review.entries.map(m=>[m.provider_id,m.provider_name]));
  for(const [id,name]of providers)$('mapping-provider').append(new Option(name,id));if(providers.has(selected))$('mapping-provider').value=selected;
  render();
 }
 function open(m){review.editing=m;$('mapping-error').textContent='';$('mapping-dialog-source').textContent=m.provider_name+' · '+m.model_id;$('mapping-official-name').value=m.canonical_id||'';render();$('mapping-dialog').showModal();$('mapping-official-name').focus();}
 async function save(canonical){
  if(busy()||!review.editing)return;const editing=review.editing,session=state.session;review.saving=true;$('mapping-error').textContent='';render();
  try{const r=await api('/admin/models/map','POST',{provider_id:editing.provider_id,model_id:editing.model_id,canonical_id:canonical});if(session!==state.session)return;
   $('mapping-dialog').close();window.dispatchEvent(new CustomEvent('ling-mapping-saved',{detail:{provider_id:editing.provider_id,models:r.models}}));window.dispatchEvent(new Event('ling-models-updated'));
   const directory=await api('/admin/model-directory');if(session!==state.session)return;window.dispatchEvent(new CustomEvent('ling-directory-loaded',{detail:directory.data}));receive(directory.mapping);notice(canonical?'已归并到 '+canonical+'，上游仍使用原始名称。':'已手动隐藏，刷新模型列表时会保留这个选择。');
  }catch(e){if(session===state.session){$('mapping-error').textContent=e.message;$('mapping-dialog').open||notice('名称保存后的目录刷新未完成，请刷新核对。');}}
  finally{review.saving=false;render();}
 }
 $('open-mapping-review').onclick=()=>{$('mapping-review').open=true;$('mapping-filter').value='unrecognized';review.limit=50;render();$('mapping-review').scrollIntoView({behavior:'smooth',block:'start'});};
 for(const id of ['mapping-search','mapping-filter','mapping-provider'])$(id).addEventListener(id==='mapping-search'?'input':'change',()=>{review.limit=50;render();});
 $('mapping-more').onclick=()=>{review.limit+=50;render();};
 $('mapping-form').onsubmit=e=>{e.preventDefault();const value=$('mapping-official-name').value.trim();if(!value){$('mapping-error').textContent='请填写官方名称；要隐藏请点击“从酒馆隐藏”。';return;}save(value);};
 $('mapping-hide').onclick=()=>save(null);
 window.addEventListener('ling-mapping-loaded',e=>receive(e.detail));
 window.addEventListener('ling-site-probe-running',e=>{review.siteBusy=e.detail;render();});window.addEventListener('ling-directory-running',e=>{review.directoryBusy=e.detail;render();});
 window.addEventListener('ling-locked',()=>{review.editing=null;review.limit=50;$('mapping-search').value='';$('mapping-official-name').value='';$('mapping-error').textContent='';receive(null);});
 render();
})();
