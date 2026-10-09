import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
for(const directory of ['src','public','server','scripts']){
 for(const name of await readdir(new URL('../'+directory+'/',import.meta.url))){
  if(!/\.(mjs|js)$/.test(name))continue;
  const result=spawnSync(process.execPath,['--check',directory+'/'+name],{stdio:'inherit'});
  if(result.status!==0)process.exit(result.status||1);
 }
}
