import {manifest,identifier,transaction} from './schema.mjs';

const tables=new Map(manifest.tables.map(t=>[t.name.slice('ling_gateway_'.length),t]));
const functions=new Map(manifest.functions.map(f=>[f.name.slice('ling_gateway_'.length),f]));
functions.set('migration_snapshot',{name:'ling_gateway_migration_snapshot',args:[],arg_types:[]});

export class PostgresDB{
 constructor(pool){this.pool=pool;}
 describe(name){const table=tables.get(name);if(!table)throw new Error('invalid_database_table');return table;}
 async request(path,method,data,headers={}){
  // Manual catalog additions are the only PostgREST-style request used by the gateway.
  // Keep this narrow so a legacy request can never reach unrelated application tables.
  if(path!=='ling_gateway_models?on_conflict=provider_id,model_id'||method!=='POST'||headers.Prefer!=='resolution=merge-duplicates,return=representation')throw new Error('legacy_shared_gate_disabled');
  if(!Array.isArray(data)||!data.length||data.length>100)throw new Error('invalid_database_write');
  const columns=new Map(this.describe('models').columns.map(c=>[c.name,c]));
  return transaction(this.pool,async client=>{
   const result=[];
   for(const row of data){
    const fields=Object.keys(row||{});
    if(fields.some(f=>!columns.has(f))||!fields.includes('provider_id')||!fields.includes('model_id'))throw new Error('invalid_database_column');
    const updates=fields.filter(f=>!['provider_id','model_id'].includes(f));
    if(!updates.length)throw new Error('empty_database_write');
    const values=fields.map(f=>columns.get(f).type==='jsonb'&&row[f]!==null?JSON.stringify(row[f]):row[f]);
    const sql='insert into public.ling_gateway_models ('+fields.map(identifier).join(',')+') values ('+fields.map((_,i)=>'$'+(i+1)).join(',')+') on conflict (provider_id,model_id) do update set '+updates.map(f=>identifier(f)+'=excluded.'+identifier(f)).join(',')+' returning *';
    result.push(...(await client.query(sql,values)).rows);
   }
   return result;
  });
 }
 async rpc(name,args={}){
  const fn=functions.get(name);if(!fn)throw new Error('invalid_database_function');
  const names=Object.keys(args),values=[];
  for(const name of names){const i=(fn.args||[]).indexOf(name);if(i<0)throw new Error('invalid_database_argument');values.push(fn.arg_types[i]==='jsonb'&&args[name]!==null?JSON.stringify(args[name]):args[name]);}
  const sql='select public.'+identifier(fn.name)+'('+names.map((n,i)=>identifier(n)+' => $'+(i+1)).join(',')+') as result';
  return (await this.pool.query(sql,values)).rows[0].result;
 }
 parse(name,query='',values=[]){
  const table=this.describe(name),columns=new Set(table.columns.map(c=>c.name)),params=new URLSearchParams(query.replace(/^\?/,'')),filters=[];
  const column=c=>{if(!columns.has(c))throw new Error('invalid_database_column');return identifier(c);};
  for(const [key,value] of params){
   if(['select','order','limit','offset'].includes(key))continue;
   const i=value.indexOf('.'),op=value.slice(0,i),operand=value.slice(i+1),field=column(key);
   if(i<1)throw new Error('invalid_database_filter');
   if(op==='is'&&operand==='null'){filters.push(field+' is null');continue;}
   const operator={eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='}[op];
   if(!operator)throw new Error('invalid_database_filter');
   values.push(operand);filters.push(field+' '+operator+' $'+values.length);
  }
  let order='';
  if(params.has('order'))order=' order by '+params.get('order').split(',').map(item=>{
   const [key,direction='asc',nulls]=item.split('.');if(!['asc','desc'].includes(direction)||nulls&&!['nullsfirst','nullslast'].includes(nulls))throw new Error('invalid_database_order');
   return column(key)+' '+direction+(nulls?' nulls '+(nulls==='nullsfirst'?'first':'last'):'');
  }).join(',');
  const integer=(key,fallback)=>{if(!params.has(key))return fallback;const raw=params.get(key);if(!/^\d+$/.test(raw)||Number(raw)>1000000)throw new Error('invalid_database_pagination');return Number(raw);};
  const select=params.has('select')?params.get('select').split(',').map(column).join(','):'*';
  return {table,select,where:filters.length?' where '+filters.join(' and '):'',order,limit:Math.min(integer('limit',1000),1000),offset:integer('offset',0),values};
 }
 async table(name,query=''){
  const q=this.parse(name,query);
  return (await this.pool.query('select '+q.select+' from public.'+identifier(q.table.name)+q.where+q.order+' limit '+q.limit+' offset '+q.offset,q.values)).rows;
 }
 async write(name,method,data,query=''){
  const table=this.describe(name),columns=new Map(table.columns.map(c=>[c.name,c])),keys=Object.keys(data||{}),values=[];
  if(keys.some(k=>!columns.has(k)))throw new Error('invalid_database_column');
  const value=k=>columns.get(k).type==='jsonb'&&data[k]!==null?JSON.stringify(data[k]):data[k];
  let sql;
  if(method==='POST'){
   if(!keys.length)throw new Error('empty_database_write');
   keys.forEach(k=>values.push(value(k)));
   sql='insert into public.'+identifier(table.name)+' ('+keys.map(identifier).join(',')+') values ('+keys.map((_,i)=>'$'+(i+1)).join(',')+') returning *';
  }else if(['PATCH','DELETE'].includes(method)){
   if(method==='PATCH'&&!keys.length)throw new Error('empty_database_write');
   const set=keys.map(k=>{values.push(value(k));return identifier(k)+'=$'+values.length;}).join(',');
   const q=this.parse(name,query,values);if(!q.where)throw new Error('unbounded_database_write');
   sql=(method==='PATCH'?'update public.'+identifier(table.name)+' set '+set:'delete from public.'+identifier(table.name))+q.where+' returning *';
  }else throw new Error('invalid_database_method');
  return (await this.pool.query(sql,values)).rows;
 }
}
