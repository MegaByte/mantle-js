// A node using the static-scene cache (ForceA1) whose SVG carries a filter
// (here feGaussianBlur, which exercises the filter region's offscreen RT +
// composite) must bake correctly. Composites must target the cache FBO
// during a bake, not the canvas — otherwise the blit comes back blank/wrong.
// Asserts RMSE(live, cached) stays low.
import { readFileSync } from 'fs';
import http from 'http'; import path from 'path'; import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const mime = p => p.endsWith('.html') ? 'text/html' : (p.endsWith('.js')||p.endsWith('.mjs')) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream';
const server = http.createServer((q,r)=>{const u=new URL(q.url,'http://l');const p=decodeURIComponent(u.pathname==='/'?'/mantleDemo.html':u.pathname);let b=null;try{b=readFileSync(path.join(ROOT,p));}catch{}if(b){r.writeHead(200,{'content-type':mime(p)});r.end(b);}else{r.writeHead(404);r.end();}});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;
const BLUR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><defs><filter id="b" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter></defs><rect x="55" y="55" width="90" height="90" fill="#ff3000" filter="url(#b)"/></svg>`;
const br = await puppeteer.launch({ headless:'new', args:['--enable-unsafe-swiftshader','--no-sandbox'] });
const pg = await br.newPage(); await pg.setViewport({ width:300, height:300 });
pg.on('pageerror', e => console.error('[page]', e.message));
await pg.goto(url, { waitUntil:'load', timeout:15000 });
await pg.waitForFunction(()=>window.__mantleRenderer&&window.__mantleGl, { timeout:15000 });
const out = await pg.evaluate(async (BLUR) => {
  const { importSvg, createBundle, CacheStrategy } = await import('/src/index.js');
  const gl = window.__mantleGl, r = window.__mantleRenderer, cnv = document.getElementById('glcanvas');
  const grab = () => { const px=new Uint8Array(cnv.width*cnv.height*4); gl.readPixels(0,0,cnv.width,cnv.height,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };
  let nonbg = 0;
  const b = createBundle(gl, await importSvg(BLUR));
  r.setBundle(b);
  r.disableStaticCache(); r.render(); const live = grab();
  r.enableStaticCache({ strategy: CacheStrategy.ForceA1 });
  r.render(); const cached = grab();
  let se = 0; for (let i=0;i<live.length;i++) se += (live[i]-cached[i])**2;
  for (let i=0;i<live.length;i+=4) if (live[i]>50||live[i+1]>50||live[i+2]>50) nonbg++;
  return { rmse: Math.sqrt(se/live.length), liveNonBg: nonbg, px: live.length/4 };
}, BLUR);
await br.close(); server.close();
console.log(`  live non-bg px=${out.liveNonBg};  RMSE(live, cached)=${out.rmse.toFixed(2)}`);
const ok = out.liveNonBg > 1000 && out.rmse < 6;
console.log(ok ? 'staticCacheFilterSmoke: PASS' : 'staticCacheFilterSmoke: FAIL (filter lost in static-cache bake)');
process.exit(ok ? 0 : 1);
