import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {isIP} from 'node:net';

const publicRoot=new URL('../public/',import.meta.url);
const assets=new Set(['index.html','app.js','model-checks.js','directory-checks.js','mapping-review.js','chat-replies.js','styles.css']);
const mime=file=>file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8';

export function createHTTPServer({handle,trustProxy=false}){
 return http.createServer(async(req,res)=>{
  const abort=new AbortController();res.once('close',()=>{if(!res.writableFinished)abort.abort();});
  try{
   const url=new URL(req.url,'http://gateway.local'),path=url.pathname.replace(/^\/ling-ai-gateway(?=\/|$)/,'')||'/';
   if(path==='/config.js'&&['GET','HEAD'].includes(req.method)){
    res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:'window.LING_GATEWAY_BASE = window.location.origin;');return;
   }
   const file=path==='/'?'index.html':path.slice(1);
   if(assets.has(file)&&['GET','HEAD'].includes(req.method)){
    const data=await readFile(new URL(file,publicRoot));res.writeHead(200,{'content-type':mime(file),'cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});res.end(req.method==='HEAD'?undefined:data);return;
   }
   const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);
   const forwarded=trustProxy?(headers.get('x-forwarded-for')||'').split(',').map(x=>x.trim()).filter(isIP).at(-1):null;
   headers.delete('cf-connecting-ip');headers.delete('x-forwarded-for');headers.set('x-forwarded-for',forwarded||req.socket.remoteAddress||'unknown');
   const request=new Request(url,{method:req.method,headers,signal:abort.signal,...(['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'})});
   const response=await handle(request);
   const responseHeaders=Object.fromEntries(response.headers);delete responseHeaders['transfer-encoding'];
   res.writeHead(response.status,responseHeaders);
   if(req.method==='HEAD'||!response.body){res.end();return;}
   await pipeline(Readable.fromWeb(response.body),res);
  }catch{
   if(res.headersSent){res.destroy();return;}
   res.writeHead(503,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}).end(JSON.stringify({error:{code:'gateway_unavailable',message:'网关暂时无法完成请求，请稍后重试。'}}));
  }
 });
}
