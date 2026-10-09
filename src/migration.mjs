const enc=new TextEncoder();
const hex=b=>[...new Uint8Array(b)].map(v=>v.toString(16).padStart(2,'0')).join('');
const bytes=s=>Uint8Array.from(s.match(/../g)||[],v=>parseInt(v,16));
const randomSecret=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
const TABLES=['users','settings','providers','keys','usage','provider_usage','logs','models','replies','login_limits'];

export function validateSnapshot(snapshot){
 if(!snapshot||snapshot.version!==1||typeof snapshot.encryption_key!=='string'||!/^[a-f0-9]{64}$/.test(snapshot.encryption_key))throw new Error('invalid_migration_snapshot');
 if(!snapshot.tables||Object.keys(snapshot.tables).sort().join(',')!==[...TABLES].sort().join(','))throw new Error('invalid_migration_tables');
 for(const name of TABLES)if(!Array.isArray(snapshot.tables[name])||snapshot.tables[name].length>200000)throw new Error('invalid_migration_table');
 if(snapshot.tables.settings.length!==1||!snapshot.tables.settings[0].access_code_hash||!snapshot.tables.users.some(u=>u.role==='admin'&&u.enabled))throw new Error('invalid_migration_account');
 return snapshot;
}

export async function encryptSnapshot(snapshot,publicKey){
 if(!publicKey||publicKey.kty!=='RSA'||publicKey.d||typeof publicKey.n!=='string'||publicKey.n.length<342||publicKey.n.length>1400)throw new Error('invalid_migration_public_key');
 const rsa=await crypto.subtle.importKey('jwk',{...publicKey,alg:'RSA-OAEP-256',ext:true}, {name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
 const aes=await crypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);
 const iv=crypto.getRandomValues(new Uint8Array(12)),payload=enc.encode(JSON.stringify(snapshot));
 if(payload.length>16777216)throw new Error('migration_snapshot_too_large');
 const aad=enc.encode('ling-gateway-migration-v1');
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad},aes,payload);
 const wrapped=await crypto.subtle.encrypt({name:'RSA-OAEP'},rsa,await crypto.subtle.exportKey('raw',aes));
 return {version:1,algorithm:'RSA-OAEP-256/AES-256-GCM',iv:hex(iv),wrapped_key:hex(wrapped),ciphertext:hex(cipher)};
}

export async function decryptSnapshot(envelope,privateKey){
 if(!envelope||envelope.version!==1||envelope.algorithm!=='RSA-OAEP-256/AES-256-GCM'||!/^[a-f0-9]{24}$/.test(envelope.iv)||typeof envelope.ciphertext!=='string'||envelope.ciphertext.length>33554464)throw new Error('invalid_migration_envelope');
 for(const field of ['iv','wrapped_key','ciphertext'])if(typeof envelope[field]!=='string'||!envelope[field].length||envelope[field].length%2||!/^[a-f0-9]+$/.test(envelope[field]))throw new Error('invalid_migration_envelope');
 const raw=await crypto.subtle.decrypt({name:'RSA-OAEP'},privateKey,bytes(envelope.wrapped_key));
 const aes=await crypto.subtle.importKey('raw',raw,'AES-GCM',false,['decrypt']);
 const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(envelope.iv),additionalData:enc.encode('ling-gateway-migration-v1')},aes,bytes(envelope.ciphertext));
 return validateSnapshot(JSON.parse(new TextDecoder().decode(plain)));
}

export async function exportGatewaySnapshot({db,secret,unseal,seal,digest,publicKey}){
 // The RPC obtains every gateway table under one PostgreSQL statement snapshot.
 const tables=await db.rpc('migration_snapshot',{}),encryption_key=randomSecret(),hashes=new Map();
 for(const p of tables.providers){
  const oldHash=await digest(p.kind+'\n'+p.base_url+'\n'+JSON.stringify(p.secret_cipher));
  if(p.secret_cipher)p.secret_cipher=await seal(await unseal(p.secret_cipher,secret),encryption_key);
  hashes.set(p.id,{old:oldHash,next:await digest(p.kind+'\n'+p.base_url+'\n'+JSON.stringify(p.secret_cipher))});
 }
 // Re-encryption changes the configuration hash, although the actual upstream key is identical.
 // Only update results whose source hash matched; already-stale results stay stale.
 for(const m of tables.models){const h=hashes.get(m.provider_id);if(h&&m.config_hash===h.old)m.config_hash=h.next;}
 const snapshot=validateSnapshot({version:1,source:'ling-ai-gateway',exported_at:new Date().toISOString(),encryption_key,tables});
 const envelope=await encryptSnapshot(snapshot,publicKey);
 return {counts:Object.fromEntries(TABLES.map(name=>[name,tables[name].length])),envelope};
}

export const importOrder=TABLES;
