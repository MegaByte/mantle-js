// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _classicRouteCensus — is the standalone loopBlinn program reachable at all any more?
//
// There is no classic per-shape fill route; the unified draw replaces it. What remains is a
// second family: R.lbProg / R.lbProgLean (static per-shape direct, static coverage-RT) and
// R.lbPairProg (morph pair), all built from loopBlinn.vert/frag and bound through
// _drawLBShapeDirect / _renderStaticCovRT / _drawLbPartitionPair / _renderPairCovRT. Six bind
// sites. If LB is genuinely all-unified, those programs are dead weight -- a full program link at
// startup, ~1000 lines of shader kept building, and four draw paths kept correct by hand.
//
// "Reading the code says they're unreachable" is not evidence: the routes are chosen by draw-time
// state, and a fallback chain can be wrong about itself. The engine ledger attributes every
// fill draw to a ROUTE, so this renders the whole example corpus -- every
// feature the repo has art for -- and counts. A single `classic` draw anywhere is the answer.
import { readFileSync, readdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = [path.join(ROOT, '..', 'examples'), path.join(ROOT, 'examples')];
const files = [];
for (const d of dirs) {
  let names = [];
  try {
    names = readdirSync(d);
  } catch {
    continue;
  }
  for (const n of names) if (n.endsWith('.svg')) files.push(path.join(d, n));
}
const LIMIT = +(process.env.LIMIT || 0);
const picked = LIMIT ? files.slice(0, LIMIT) : files;
const CORPUS = {};
for (const f of picked) {
  try {
    CORPUS[path.basename(f)] = readFileSync(f, 'utf8');
  } catch {
    /* skip */
  }
}
const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const CORPUS=${JSON.stringify(CORPUS)};
const ROUTE=${JSON.stringify(process.env.ROUTE || 'lb')};
window.__run=async()=>{
  const c=document.createElement('canvas');c.width=384;c.height=384;document.body.appendChild(c);
  const gl=c.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});
  const r=createRenderer(gl,shaders,{precompileFillsBudgetMs:5000}); await r.ready;
  r.setViewport(384,384); r.setFillEngine({route:ROUTE, kernel:'auto'});
  const per=[], errs=[];
  for (const [name,SVG] of Object.entries(CORPUS)) {
    try {
      const b=createBundle(gl,await importSvg(SVG,{}));
      if(r.awaitEngine) await r.awaitEngine(b, ROUTE==='none'?'slug':ROUTE, 20000);
      const R0=Object.assign({},(r.debugStats.engines||{}).routes||{});
      // Several draw states: a translucent pass and a scaled pass take different variants, and
      // variant choice is one of the things that can push a bundle off the unified route.
      for (const o of [{}, {alpha:0.5}, {worldMatrix:[0.6,0,0,0,0.6,0,0,0,1]}]) {
        for(let i=0;i<2;i++){ r.beginFrame([0,0,0,1]); r.drawBundle(b,o); r.endFrame(); }
      }
      const R1=(r.debugStats.engines||{}).routes||{};
      const d={}; for(const k of Object.keys(R1)){const n=(R1[k]|0)-(R0[k]|0); if(n) d[k]=n;}
      per.push({name, routes:d, shapes:b.numShapes|0});
      if(b.dispose) b.dispose();
    } catch(e){ errs.push(name+': '+String(e.message).slice(0,60)); }
  }
  const E=r.debugStats.engines||{};
  return {per, errs, total:E.routes||{}, viaRoute:E.viaRoute||{}, declines:E.declines||{}};
};
window.__ready=1;
</script></body></html>`;
const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
// HEADLESS EVEN ON THE GPU. Headless Chrome reaches the real GPU: ANGLE (Apple, ANGLE Metal
// Renderer) reports and TIMES the same headless or headful.
// A window is not free to the person running this: macOS CLAMPS --window-position (measured:
// screenX/Y 83,65 whatever you pass), so a headful run cannot be put out of the way and lands
// on whichever desktop is in front.
const br = await launchBrowser(
  process.env.GPU === '1'
    ? { headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
    : { headless: 'new', args: ['--no-sandbox'] },
);
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 160)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === 1, { timeout: 120000, polling: 50 });
const res = await pg.evaluate(() => window.__run());
await br.close();
server.close();
const classic = res.per.filter((p) => (p.routes.classic | 0) > 0);
console.log(
  '\n  assets rendered: ' +
    res.per.length +
    (res.errs.length ? '   (skipped ' + res.errs.length + ')' : ''),
);
console.log('  route totals:   ' + JSON.stringify(res.total));
console.log('  engine@route:   ' + JSON.stringify(res.viaRoute));
if (Object.keys(res.declines).length)
  console.log('  declines:       ' + JSON.stringify(res.declines));
if (classic.length) {
  console.log('\n  CLASSIC ROUTE IS REACHABLE — ' + classic.length + ' asset(s):');
  for (const p of classic.slice(0, 20))
    console.log('    ' + p.name.padEnd(38) + JSON.stringify(p.routes));
} else {
  console.log(
    '\n  NO CLASSIC DRAWS across the corpus — the standalone loopBlinn program was never bound',
  );
}
