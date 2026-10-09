import pg from 'pg';
import {resolve4,resolve6} from 'node:dns/promises';
import {initializeSchema} from './schema.mjs';
import {PostgresDB} from './postgres.mjs';
import {createMigrationTarget} from './migration-target.mjs';
import {createHTTPServer} from './http.mjs';
import {createGateway} from '../src/gateway.mjs';

async function start(){
 if(!process.env.DATABASE_URL)throw new Error('database_configuration_required');
 pg.types.setTypeParser(20,value=>{const n=Number(value);if(!Number.isSafeInteger(n))throw new Error('database_integer_out_of_range');return n;});
 pg.types.setTypeParser(1082,value=>value);
 const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5,connectionTimeoutMillis:10000,idleTimeoutMillis:30000,statement_timeout:10000});
 pool.on('error',()=>console.error('database_connection_error'));
 await initializeSchema(pool);
 const db=new PostgresDB(pool);let gateway=null;
 const resolveDNS=async host=>(await Promise.allSettled([resolve4(host),resolve6(host)])).flatMap(r=>r.status==='fulfilled'?r.value:[]);
 const activate=secret=>{gateway=createGateway({ENCRYPTION_KEY:secret},{db,resolveDNS});};
 const migration=await createMigrationTarget({pool,masterKey:process.env.GATEWAY_MASTER_KEY,bootstrapToken:process.env.MIGRATION_IMPORT_TOKEN,onImported:activate});
 const key=await migration.load();if(key)activate(key);
 const server=createHTTPServer({trustProxy:process.env.TRUST_PROXY==='true',handle:async req=>{
  const path=new URL(req.url).pathname;
  if(path==='/health'&&req.method==='GET'){await pool.query('select 1');return Response.json({ok:true,service:'ling-ai-gateway',version:'0.6.0',storage:'postgres',imported:migration.isImported()},{headers:{'cache-control':'no-store'}});}
  const imported=await migration.handle(req);if(imported)return imported;
  if(!gateway)return Response.json({error:{code:'migration_pending',message:'新入口正在准备中，请暂时继续使用原站。'}},{status:503});
  return gateway(req);
 }});
 const port=Number(process.env.PORT||8080);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('invalid_server_port');
 server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({event:'server_ready',port,imported:migration.isImported()})));
 let maintenanceRunning=false;
 const maintenance=setInterval(async()=>{
  if(!gateway||maintenanceRunning)return;
  maintenanceRunning=true;
  try{await db.rpc('maintenance',{});await gateway.checkHealth();}
  catch{console.error('maintenance_failed');}
  finally{maintenanceRunning=false;}
 },3600000);maintenance.unref();
 const shutdown=()=>{clearInterval(maintenance);server.close(()=>pool.end().finally(()=>process.exit(0)));setTimeout(()=>process.exit(1),10000).unref();};
 process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
}
start().catch(()=>{console.error('server_start_failed: check the private database and migration environment configuration');process.exitCode=1;});
