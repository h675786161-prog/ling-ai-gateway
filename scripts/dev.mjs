import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../public/', import.meta.url));
http.createServer(async (req,res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const files = {'/':'index.html','/index.html':'index.html','/app.js':'app.js','/model-checks.js':'model-checks.js','/styles.css':'styles.css','/config.js':'config.js'};
  if (!files[pathname]) {res.writeHead(404).end();return;}
  try {res.setHeader('Content-Type', pathname.endsWith('.js')?'text/javascript':pathname.endsWith('.css')?'text/css':'text/html');res.end(await readFile(root+files[pathname]));}
  catch {res.writeHead(404).end();}
}).listen(8787,'127.0.0.1',()=>console.log('管理页：http://127.0.0.1:8787'));
