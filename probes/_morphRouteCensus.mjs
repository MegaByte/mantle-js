// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _morphRouteCensus — which morphs take the UNIFIED route and which fall back, per feature.
//
// The static fill is fully unified: cover quads and analytic geometry in one drawArrays through
// the ubershader. Morphs are supposed to be the same draw, and mostly are -- but R.lbPairProg
// (loopBlinn.frag, per-shape, coverage-RT) is still bound in two places, so some morph is not.
// "Some" is not an answer, and neither is reading the fallback chain: the routes are chosen by
// draw-time state, so only drawing them says which.
//
// Per feature, at t = 0, 0.5 and 1: the unified draw count and the engine ledger's attribution.
// A feature that reports unifiedDraws 0 with pixels on screen took the classic pair path.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const poly = (cx, cy, r, n, rot) => {
  const p = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i * 2 * Math.PI) / n;
    p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return (
    'M' + p.map((q, i) => (i ? 'L' : '') + q[0].toFixed(3) + ' ' + q[1].toFixed(3)).join(' ') + ' Z'
  );
};
const wrap = (b) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${b}</svg>`;
const A = (extra, attrs) =>
  wrap(
    (extra || '') +
      `<path d="${poly(64, 64, 42, 16, -Math.PI / 2)}" fill="#265b9b" ${attrs || ''}/>`,
  );
const B = (extra, attrs) =>
  wrap(
    (extra || '') +
      `<path d="${poly(64, 64, 30, 16, -Math.PI / 2 + 0.3)}" fill="#265b9b" ${attrs || ''}/>`,
  );
const CLIP = `<defs><clipPath id="c"><circle cx="64" cy="64" r="34"/></clipPath></defs>`;
const FILT = `<defs><filter id="f"><feGaussianBlur stdDeviation="1.2"/></filter></defs>`;
// THE exactly-SYMMETRIC ENDPOINT: a rounded square whose control points are round numbers lands
// a cubic's sign classifier precisely on zero, and without the endpoint margin every pair ending
// at t=1 bails -- taking the whole bundle to Slug. The endpoint margin is a FALLBACK rather than
// the default, so this case must still route LB: if it reports slug only, the margin is not
// reached where it is genuinely needed.
const rsq = (x, y, s, r) =>
  `M${x + r} ${y} L${x + s - r} ${y} Q${x + s} ${y} ${x + s} ${y + r} L${x + s} ${y + s - r} Q${x + s} ${y + s} ${x + s - r} ${y + s}` +
  ` L${x + r} ${y + s} Q${x} ${y + s} ${x} ${y + s - r} L${x} ${y + r} Q${x} ${y} ${x + r} ${y} Z`;
const IMG = `<defs><linearGradient id="lg"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>`;
const CASES = {
  // IMAGE/GRADIENT paint: morphImageRouteSmoke and morphTranslucentRouteSmoke both fail when the
  // classic route is removed, with gate='variant-warming' -- the unified morph variant never links.
  gradientPaint: [
    wrap(IMG + `<path d="${poly(64, 64, 42, 16, -Math.PI / 2)}" fill="url(#lg)"/>`),
    wrap(IMG + `<path d="${poly(64, 64, 30, 16, -Math.PI / 2 + 0.3)}" fill="url(#lg)"/>`),
  ],
  roundedSquare: [
    wrap(`<path d="${rsq(24, 24, 80, 20)}" fill="#265b9b"/>`),
    wrap(`<path d="${rsq(34, 34, 60, 10)}" fill="#265b9b"/>`),
  ],
  solid: [A(), B()],
  translucent: [A('', 'fill-opacity="0.55"'), B('', 'fill-opacity="0.55"')],
  stroked: [A('', 'stroke="#e8b" stroke-width="5"'), B('', 'stroke="#e8b" stroke-width="5"')],
  clipped: [A(CLIP, 'clip-path="url(#c)"'), B(CLIP, 'clip-path="url(#c)"')],
  filtered: [A(FILT, 'filter="url(#f)"'), B(FILT, 'filter="url(#f)"')],
};
const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const CASES=${JSON.stringify(CASES)};
const ROUTE=${JSON.stringify(process.env.ROUTE || 'lb')};
window.__run=async()=>{
  const out=[];
  for (const [name,[sa,sb]] of Object.entries(CASES)) {
    const c=document.createElement('canvas');c.width=256;c.height=256;document.body.appendChild(c);
    const gl=c.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});
    const r=createRenderer(gl,shaders,{precompileFillsBudgetMs:5000}); await r.ready;
    r.setViewport(256,256); r.setFillEngine({route:ROUTE, kernel:'slug'});
    const m=createShapeMorph(gl, createBundle(gl,await importSvg(sa,{})), createBundle(gl,await importSvg(sb,{})));
    const b=m.bundle||m;
    if(r.awaitEngine) await r.awaitEngine(b, ROUTE==='none'?'slug':ROUTE, 30000);
    const row={name, t:{}};
    for (const t of [0,0.5,1]) {
      if(m.setT) m.setT(t);
      // Warm this t first — a variant still linking reports the fallback's counts — then measure
      // a FRESH frame. Filter results are cached across frames, so the measured frame must be one
      // that actually redraws: bump t imperceptibly to invalidate the cache without moving the art.
      for(let i=0;i<3;i++){ r.beginFrame([0,0,0,1]); r.drawBundle(m,{}); r.endFrame(); }
      const d0=r.debugStats, u0=d0.unifiedFillDraws|0, e0=Object.assign({},(d0.engines||{}).draws||{});
      if(m.setT) m.setT(t===1?0.999999:t+1e-6);
      r.beginFrame([0,0,0,1]); r.drawBundle(m,{}); r.endFrame();
      const d=r.debugStats, E=d.engines||{draws:{}};
      const drew={}; for(const k of Object.keys(E.draws||{})){const n=(E.draws[k]|0)-(e0[k]|0); if(n) drew[k]=n;}
      const px=new Uint8Array(256*256*4); gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,px);
      let ink=0; for(let i=0;i<px.length;i+=4) if(px[i]||px[i+1]||px[i+2]) ink++;
      // ROUTING IS NOT CORRECTNESS. This probe proved which route drew and said nothing about
      // what it painted -- and an image morph through the unified route turns out to diverge from
      // Slug by 221/255. Same drawing, LB off, is the reference.
      r.setFillEngine({route:'none', kernel:'slug'});
      for(let i=0;i<2;i++){ r.beginFrame([0,0,0,1]); r.drawBundle(m,{}); r.endFrame(); }
      const ref=new Uint8Array(256*256*4); gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,ref);
      r.setFillEngine({route:ROUTE, kernel:'slug'});
      let mx=0,nd=0;
      for(let i=0;i<px.length;i+=4){
        const d=Math.max(Math.abs(px[i]-ref[i]),Math.abs(px[i+1]-ref[i+1]),Math.abs(px[i+2]-ref[i+2]));
        if(d>8) nd++; if(d>mx) mx=d; }
      const R0=Object.assign({},(d0.engines||{}).routes||{}), R1=(E.routes||{});
      const rts={}; for(const k of Object.keys(R1)){const n=(R1[k]|0)-(R0[k]|0); if(n) rts[k]=n;}
      row.gate=d.unifiedFillGate;
      row.t[t]={uni:(d.unifiedFillDraws|0)-u0, drew:Object.entries(drew).map(([k,v])=>k+':'+v).join(' ')||'-',
                routes:Object.entries(rts).map(([k,v])=>k+':'+v).join(' ')||'-', ink, mx, nd};
    }
    out.push(row);
  }
  return out;
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
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 200)));
pg.on('console', (m) => {
  const t = m.text();
  if (/link failed|not compiled|ERROR:/i.test(t))
    console.error(' [console]', t.replace(/^[^:]*\]:/, '').slice(0, 400));
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === 1, { timeout: 120000, polling: 50 });
const rows = await pg.evaluate(() => window.__run());
await br.close();
server.close();
console.log('\n  route=' + (process.env.ROUTE || 'lb'));
console.log('  vs the Slug morph (mx = worst channel delta, n = pixels off by >8)');
console.log('  feature       t=0          t=0.5        t=1');
for (const r of rows) {
  const cell = (x) =>
    ('mx' + String(x.mx).padStart(3) + ' n' + String(x.nd).padStart(5)).padEnd(13);
  console.log(
    '  ' +
      r.name.padEnd(13) +
      cell(r.t[0]) +
      cell(r.t[0.5]) +
      cell(r.t[1]) +
      '  gate=' +
      (r.gate || '?'),
  );
}
const classic = rows.filter((r) => [0, 0.5, 1].some((t) => /classic/.test(r.t[t].routes)));
console.log(
  '\n  ' +
    (classic.length
      ? 'NOT UNIFIED: ' +
        classic.map((r) => r.name).join(', ') +
        ' — drew through the classic per-shape route'
      : 'every morph feature drew through the unified route'),
);
