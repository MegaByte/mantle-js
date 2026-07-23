import { readFileSync } from 'fs'; import http from 'http'; import path from 'path';
import { fileURLToPath } from 'url'; import puppeteer from 'puppeteer';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(process.env.F, 'utf8');
const HTML = `<!DOCTYPE html><html><body><script type="module">
const raw = ${JSON.stringify(raw)};
const out = [];
async function tryLoad(tag, text) {
  const url = URL.createObjectURL(new Blob([text], {type:'image/svg+xml'}));
  const img = new Image();
  const r = await new Promise((res) => { img.onload=()=>res('ok '+img.width+'x'+img.height); img.onerror=()=>res('REFUSED'); img.src=url; });
  out.push(tag+': '+r);
}
await tryLoad('raw-as-is', raw);
const noProlog = raw.replace(/^\\s*<\\?xml[^>]*\\?>\\s*/, '');
await tryLoad('no-prolog', noProlog);
let sized = noProlog.replace(/(<svg[^>]*?)\\swidth="[^"]*"/,'$1').replace(/(<svg[^>]*?)\\sheight="[^"]*"/,'$1')
  .replace(/(<svg[^>]*?)\\sviewBox="[^"]*"/,'$1').replace(/(<svg[^>]*?)\\spreserveAspectRatio="[^"]*"/,'$1');
sized = sized.replace(/<svg/, '<svg width="2048" height="2048" viewBox="0 0 900 900" preserveAspectRatio="xMidYMid meet"');
await tryLoad('rewritten', sized);
out.push('head: ' + sized.slice(0, 180));
window.__out = out; window.__ready = true;
</${'script'}></body></html>`;
const server = http.createServer((q,res)=>{ if(q.url.split('?')[0]==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end(HTML);return;}
  try{ const b=readFileSync(path.join(ROOT,q.url.split('?')[0])); res.writeHead(200); res.end(b);}catch{res.writeHead(404);res.end('nf');}});
await new Promise(r=>server.listen(0,r));
const br = await puppeteer.launch({headless:'new',args:['--no-sandbox']});
const pg = await br.newPage(); pg.on('pageerror',e=>console.error(' [err]',e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'load'});
await pg.waitForFunction('window.__ready===true',{timeout:60000});
for (const l of await pg.evaluate(()=>window.__out)) console.log('  '+l);
await br.close(); server.close();
