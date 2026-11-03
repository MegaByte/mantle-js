// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Does the unified route mis-draw a FILTERED asset when LB/CPatch are forced? The bench says LB
// and CPatch post byte-identical structural counts on all 8 filter assets while slug/aac/auto are
// clean — identical counts across the two engines that share the route implicate the route.
const R = decodeURIComponent(new URL('..', import.meta.url).pathname); // the package root, with a trailing slash
import fs from 'fs';
import http from 'http';
import path from 'path';
import { launchBrowser } from '../test/_launch.mjs';
const ASSET = process.env.ASSET || 'examples/_dropshadow.svg';
const SVG = fs.readFileSync(path.join(R, ASSET), 'utf8');
const PAGE = `<!doctype html><body><canvas id=c width=384 height=384></canvas><script type=module>
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const svgText=${JSON.stringify(SVG)};
const shot=async(cfg)=>{ const r=createRenderer(gl,shaders,cfg.opts||{}); r.setViewport(384,384);
  if(cfg.route) r.setFillEngine({route:cfg.route});
  const b=createBundle(gl,await importSvg(svgText)); r.prepareBundle(b);
  if(r.awaitEngine){try{await r.awaitEngine(b,cfg.route||'lb',20000);}catch{}}
  r.beginFrame([1,1,1,1]); r.drawBundle(b,{}); r.endFrame();
  const px=new Uint8Array(384*384*4); gl.readPixels(0,0,384,384,gl.RGBA,gl.UNSIGNED_BYTE,px);
  const ds=r.debugStats;
  return {px:Array.from(px), route: r.getFillEngine?JSON.stringify(r.getFillEngine()):'?', cpatchFillOpt: !!(r.opts&&r.opts.cpatchFill), engines: ds.engines?JSON.stringify(ds.engines.draws):null,
          uni: ds.unifiedFillDraws|0, gate: ds.unifiedFillGate||null, stomps: ds.fillMeshStomps|0}; };
const slug=await shot({route:'none'}); const lb=await shot({route:'lb'}); const cp=await shot({route:'cpatch',opts:{cpatchFill:true}});
const diff=(a,b)=>{let n=0,worst=0; for(let i=0;i<a.px.length;i+=4){ for(let k=0;k<4;k++){const d=Math.abs(a.px[i+k]-b.px[i+k]); if(d>worst)worst=d;}
  if(Math.abs(a.px[i]-b.px[i])>24||Math.abs(a.px[i+1]-b.px[i+1])>24||Math.abs(a.px[i+2]-b.px[i+2])>24||Math.abs(a.px[i+3]-b.px[i+3])>24)n++; } return {n,worst};};
window.__out={lb:{...diff(slug,lb),engines:lb.engines,uni:lb.uni,gate:lb.gate,stomps:lb.stomps,route:lb.route},
              cp:{...diff(slug,cp),engines:cp.engines,uni:cp.uni,gate:cp.gate,stomps:cp.stomps,route:cp.route}};
window.__ready=true;
</script></body>`;
const srv = http.createServer((q, r) => {
  try {
    if (q.url === '/') {
      r.writeHead(200, { 'content-type': 'text/html' });
      r.end(PAGE);
      return;
    }
    const p = decodeURIComponent(q.url.split('?')[0]);
    r.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    r.end(fs.readFileSync(path.join(R, p)));
  } catch {
    if (!r.headersSent) r.writeHead(404);
    r.end();
  }
});
await new Promise((x) => srv.listen(0, '127.0.0.1', x));
const port = srv.address().port;
const args = ['--no-sandbox'];
if (process.env.GPU === '1') args.push('--use-angle=metal', '--enable-gpu');
else args.push('--enable-unsafe-swiftshader');
const br = await launchBrowser({ headless: 'new', args });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error('[pg]', e.message));
await pg.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction(() => window.__ready, { timeout: 120000 });
const o = await pg.evaluate(() => window.__out);
console.log(`\n  ${ASSET}  (vs slug)`);
for (const k of ['lb', 'cp'])
  console.log(
    `   ${k.padEnd(4)} wrong=${String(o[k].n).padStart(7)} worst=${String(o[k].worst).padStart(4)}  route=${o[k].route}  engines=${o[k].engines}  gate=${o[k].gate}`,
  );
await br.close();
srv.close();
