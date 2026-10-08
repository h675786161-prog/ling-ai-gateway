export const ROUTING_MODES=['smart','parallel','sequential'];
export function routingPolicy(settings={}) {
  return {mode:ROUTING_MODES.includes(settings.routing_mode)?settings.routing_mode:'smart',
    hedge_delay_ms:settings.hedge_delay_ms??4000,multi_reply_limit:settings.multi_reply_limit??3};
}
export function rankRoutes(routes,now=Date.now()) {
  const category=r=>Date.parse(r.provider.open_until||'')>now?3:r.stale||r.status==='unchecked'||!r.status?1:r.status==='available'?0:2;
  const first=r=>r.status==='available'&&!r.stale&&Number.isFinite(r.first_token_ms)?r.first_token_ms:Infinity;
  const errors=r=>r.provider.total_attempts?r.provider.total_errors/r.provider.total_attempts:0;
  return [...routes].sort((a,b)=>category(a)-category(b)||a.provider.priority-b.provider.priority||first(a)-first(b)||errors(a)-errors(b));
}
// A soft delay launches a second request, without cancelling or discarding the first.
// run reports completion before persistence so an HTTP failure immediately frees its slot.
export function dispatchRoutes(routes,policy,run,{signal,deadline=Infinity}={}) {
  const selected=policy.mode==='parallel'&&policy.multi_reply_limit>0?routes.slice(0,policy.multi_reply_limit):routes;
  return new Promise(resolve=>{
    let at=0,active=0,settling=0,timer=null,seenText=false,stopped=!!signal?.aborted;
    const clear=()=>{clearTimeout(timer);timer=null;};
    const finish=()=>{if(active===0&&settling===0&&(stopped||seenText||at>=selected.length)){clear();signal?.removeEventListener('abort',abort);resolve();}};
    const allowed=()=>!stopped&&Date.now()<deadline&&at<selected.length&&(policy.mode==='parallel'||!seenText);
    const arm=()=>{clear();if(policy.mode==='smart'&&active===1&&allowed())timer=setTimeout(()=>{timer=null;if(allowed()&&active<2)launch();},Math.min(policy.hedge_delay_ms,Math.max(1,deadline-Date.now())));};
    function abort(){stopped=true;clear();finish();}
    function launch(){
      if(!allowed()){if(Date.now()>=deadline)stopped=true;finish();return;}
      const route=selected[at++];active++;settling++;let completed=false;
      const hooks={visible(){seenText=true;clear();},complete(){if(completed)return;completed=true;active--;if(allowed()&&policy.mode!=='parallel')launch();else if(Date.now()>=deadline)stopped=true;arm();finish();}};
      Promise.resolve().then(()=>run(route,hooks)).catch(()=>{}).finally(()=>{hooks.complete();settling--;finish();});
      arm();
    }
    signal?.addEventListener('abort',abort,{once:true});
    if(policy.mode==='parallel'){while(allowed())launch();if(Date.now()>=deadline)stopped=true;finish();}
    else launch();
  });
}
