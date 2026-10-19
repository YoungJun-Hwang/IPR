// Local check of the exact static output and Web Request/Response function handler.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import handler from '../netlify/functions/api.mjs';
const root=fileURLToPath(new URL('../dist/',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8'};
const server=http.createServer(async(req,res)=> {
  try {
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname.startsWith('/api/')) {
      const chunks=[]; let size=0;
      for await (const chunk of req) {
        size+=chunk.length;
        if(size>3*1024*1024){res.writeHead(413).end(); return;}
        chunks.push(chunk);
      }
      const response=await handler(new Request(url,{method:req.method,headers:req.headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)}));
      res.writeHead(response.status,Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));return;
    }
    const filename=path.resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
    if(!filename.startsWith(root)){res.writeHead(403).end();return;}
    const data=await readFile(filename);
    res.writeHead(200,{'Content-Type':types[path.extname(filename)]||'application/octet-stream'});res.end(data);
  } catch {res.writeHead(404).end('Not found');}
});
server.listen(8888,'127.0.0.1',()=>console.log('Netlify output and function preview listening on local port 8888'));
