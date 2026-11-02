// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Does the CPatch depth claim fire whenever "CPatch owns this bundle's meshes", as it does for
// "LB kind mask bit 14"? CPatch patches OVERLAP by construction, so without the claim they
// composite under OVER and over-paint — ink well above Slug's is the signature. This prints both
// predicates side by side: they must agree.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="M64.000 20.000 Q82.356 19.684 95.113 32.887 Q108.316 45.644 108.000 64.000 Q108.316 82.356 95.113 95.113 Q82.356 108.316 64.000 108.000 Q45.644 108.316 32.887 95.113 Q19.684 82.356 20.000 64.000 Q19.684 45.644 32.887 32.887 Q45.644 19.684 64.000 20.000 Z" fill="#265b9b"/></svg>';
const PAGE = `<!doctype html><body><canvas id=c width=256 height=256></canvas><script type=module>
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const svg=${JSON.stringify(SVG)};
const go=async(route)=>{ const r=createRenderer(gl,shaders,route==='cpatch'?{cpatchFill:true,cpatchOpts:{}}:{});
  r.setViewport(256,256); r.setFillEngine({route});
  const b=createBundle(gl,await importSvg(svg)); r.prepareBundle(b);
  if(r.awaitEngine){try{await r.awaitEngine(b,route,30000);}catch{}}
  r.beginFrame([1,1,1,1]); r.drawBundle(b,{}); r.endFrame();
  const px=new Uint8Array(256*256*4); gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,px);
  let ink=0; for(let p=0;p<px.length;p+=4) if(px[p+3]>8&&!(px[p]>247&&px[p+1]>247&&px[p+2]>247)) ink++;
  const km = r._lbKindMask ? r._lbKindMask(b) : (b._lbKindMask|0);
  const ds=r.debugStats, e=ds.engines&&ds.engines.draws||{};
  return { route, ink, owner: b._fillMeshOwner||null, kindMask: km,
           oldPredicate: !!((km|0) & (1<<14)), newPredicate: b._fillMeshOwner==='cpatch',
           depthClaim: !!b._lbDepthClaim, built: b._cpatchBuilt|0,
           drew: Object.keys(e).filter(k=>e[k]>0).sort().join('+')||'none' }; };
window.__out=[await go('none'), await go('lb'), await go('cpatch')]; window.__ready=true;
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
    r.end(readFileSync(path.join(ROOT, p)));
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
console.log(
  '\n  route     ink    drew      built  owner    kindMask  oldPred  newPred  depthClaim',
);
for (const r of o)
  console.log(
    '  ' +
      r.route.padEnd(9) +
      String(r.ink).padStart(6) +
      '  ' +
      String(r.drew).padEnd(9) +
      ' ' +
      String(r.built).padStart(5) +
      '  ' +
      String(r.owner).padEnd(8) +
      ' ' +
      String(r.kindMask).padStart(8) +
      '  ' +
      String(r.oldPredicate).padEnd(7) +
      '  ' +
      String(r.newPredicate).padEnd(7) +
      '  ' +
      r.depthClaim,
  );
const cp = o.find((x) => x.route === 'cpatch'),
  sl = o.find((x) => x.route === 'none');
if (cp && sl)
  console.log(
    '\n  CPatch ink vs Slug: ' +
      (cp.ink / sl.ink).toFixed(3) +
      'x' +
      (cp.ink / sl.ink > 1.02 ? '   <-- OVER-PAINT' : '   (matched)'),
  );
if (cp) console.log('  predicates agree: ' + (cp.oldPredicate === cp.newPredicate));
await br.close();
srv.close();
