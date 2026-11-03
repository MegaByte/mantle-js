// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Why does the balance bench's CPatch arm draw LB on every morph row? Reproduce its exact morph
// setup — createShapeMorph over two pose bundles, cpatchFill:true — and read the reason that the
// fallback records (debugStats.cpatchMorphError) instead of swallowing.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ring = (r, rot, family, segs) => {
  const P = [],
    cx = 64,
    cy = 64;
  for (let i = 0; i < segs; i++) {
    const a = rot * 6.283185 + (i * 6.283185) / segs;
    P.push([cx + 128 * r * Math.cos(a), cy + 128 * r * Math.sin(a)]);
  }
  let d = 'M' + P[0][0].toFixed(3) + ' ' + P[0][1].toFixed(3);
  for (let i = 0; i < segs; i++) {
    const p = P[i],
      q = P[(i + 1) % segs],
      mx = (p[0] + q[0]) / 2,
      my = (p[1] + q[1]) / 2,
      bx = cx + (mx - cx) * 1.18,
      by = cy + (my - cy) * 1.18;
    if (family === 'line') d += ' L' + q[0].toFixed(3) + ' ' + q[1].toFixed(3);
    else if (family === 'quad')
      d +=
        ' Q' + bx.toFixed(3) + ' ' + by.toFixed(3) + ' ' + q[0].toFixed(3) + ' ' + q[1].toFixed(3);
    else {
      const c1x = p[0] + (bx - p[0]) * 1.35,
        c1y = p[1] + (by - p[1]) * 1.35,
        c2x = q[0] + (bx - q[0]) * 1.35,
        c2y = q[1] + (by - q[1]) * 1.35;
      d +=
        ' C' +
        c1x.toFixed(3) +
        ' ' +
        c1y.toFixed(3) +
        ' ' +
        c2x.toFixed(3) +
        ' ' +
        c2y.toFixed(3) +
        ' ' +
        q[0].toFixed(3) +
        ' ' +
        q[1].toFixed(3);
    }
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path d="' +
    d +
    ' Z" fill="#265b9b"/></svg>'
  );
};
const FAM = process.env.FAMILY || 'cubic',
  SEGS = +(process.env.SEGS || 8);
const A = ring(0.4, 0, FAM, SEGS),
  B = ring(0.26, 0.55, FAM, SEGS);
const PAGE = `<!doctype html><body><canvas id=c width=256 height=256></canvas><script type=module>
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true,depth:true,stencil:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
// EXACTLY the bench's cpatch arm: cpatchFill in renderer opts, LB route on.
const r=createRenderer(gl,shaders,{cpatchFill:true,cpatchOpts:{}}); r.setViewport(256,256); r.setLoopBlinnFill('on');
const bA=createBundle(gl,await importSvg(${JSON.stringify(A)})), bB=createBundle(gl,await importSvg(${JSON.stringify(B)}));
window.__stage='created morph';
const morph=createShapeMorph(gl,bA,bB); const b=morph.bundle||morph;
globalThis.__CPATCH_TRACE=[];
morph.__tag='WRAPPER'; b.__tag='BUNDLE'; bA.__tag='poseA'; bB.__tag='poseB';
r.prepareBundle(b);
const trace=[];
// the readiness call the bench now makes
let awaitErr=null;
window.__stage='awaitEngine';
try { await r.awaitEngine(b,'cpatch',30000); } catch(e){ awaitErr=String(e&&e.message||e); }
trace.push('after awaitEngine: plan='+(b._cpatchMorphPlan==='pending'?'pending':(b._cpatchMorphPlan?'yes':'no'))+' conv='+(b._cpatchConv===undefined?'none':b._cpatchConv));
// ...and poll it directly, in case the plan resolves on its own schedule
for (let i=0;i<200 && b._cpatchMorphPlan==='pending';i++) await new Promise(z=>setTimeout(z,25));
trace.push('after 5s poll: plan='+(b._cpatchMorphPlan==='pending'?'pending':(b._cpatchMorphPlan?'yes':'no'))+' bail='+(b._cpatchBail||'none'));
const shot=(label)=>{ const ds=r.debugStats;
  return {label, built:b._cpatchBuilt|0, conv:b._cpatchConv===undefined?'none':b._cpatchConv,
          plan: b._cpatchMorphPlan==='pending'?'pending':(b._cpatchMorphPlan?'yes':'no'),
          bail: b._cpatchBail||null, why: b._cpatchMorphWhy||null, kindMask:b._lbKindMask|0,
          morphSrcOnB: !!b._morphSrc, morphSrcOnMorph: !!(morph&&morph._morphSrc),
          err: ds.cpatchMorphError||null, engines: ds.engines?JSON.stringify(ds.engines.draws):null,
          planOnWrapper: morph._cpatchMorphPlan==='pending'?'pending':(morph._cpatchMorphPlan?'yes':'undefined'),
          planOnBundle:  b._cpatchMorphPlan==='pending'?'pending':(b._cpatchMorphPlan?'yes':'undefined'),
          whyOnWrapper: morph._cpatchMorphWhy||null, builtOnWrapper: morph._cpatchBuilt|0 }; };
const out=[shot('after prepare')];
window.__stage='drawing';
for (const t of [0, .25, .5]) { window.__stage='draw t='+t; morph.setT(t); r.beginFrame([1,1,1,1]); r.drawBundle(morph,{}); r.endFrame(); out.push(shot('t='+t)); }
window.__out={trace2:globalThis.__CPATCH_TRACE.slice(-14), out, sameObj: (morph.bundle===morph), trace, awaitErr, hasAwaitEngine: typeof r.awaitEngine==='function'}; window.__ready=true;
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
pg.on('pageerror', (e) => console.error('[pg ERROR]', e.message));
pg.on('console', (m) => console.error('[pg ' + m.type() + ']', m.text().slice(0, 200)));
await pg.goto('http://127.0.0.1:' + port + '/', { waitUntil: 'load', timeout: 60000 });
await pg
  .waitForFunction(() => window.__ready || window.__stage, { timeout: 60000 })
  .catch(async () => {
    const st = await pg.evaluate(() => window.__stage || 'no stage marker');
    console.error('  HUNG AT: ' + st);
    process.exit(1);
  });
await pg
  .waitForFunction(() => window.__ready, { timeout: 60000 })
  .catch(async () => {
    const st = await pg.evaluate(() => ({
      stage: window.__stage || '?',
      trace: (globalThis.__CPATCH_TRACE || []).length,
    }));
    console.error('  HUNG AT STAGE: ' + st.stage + '   apply/gate trace entries: ' + st.trace);
    await br.close();
    srv.close();
    process.exit(1);
  });
const o = await pg.evaluate(() => window.__out);
console.log(
  `\n  family=${FAM} segs=${SEGS}   morph.bundle === morph: ${o.sameObj}   awaitEngine present: ${o.hasAwaitEngine}`,
);
if (o.awaitErr) console.log('  awaitEngine threw: ' + o.awaitErr);
for (const t of o.trace) console.log('  · ' + t);
console.log('  applyCPatchMorphFrame calls (last 12):');
for (const c of o.trace2)
  console.log(
    c.exit
      ? '    EXIT  set _cpatchBuilt=' + c.built + ' _lbMeshes.len=' + c.meshes + ' on ' + c.tag
      : c.gate
        ? '    GATE  built=' +
          String(c.built).padEnd(4) +
          ' lbMeshes=' +
          String(c.meshes).padEnd(6) +
          ' drewLB=' +
          c.drew
        : '    apply got=' +
          String(c.tag).padEnd(9) +
          ' plan=' +
          String(c.plan).padEnd(10) +
          ' morphSrc=' +
          c.morphSrc,
  );
console.log();
for (const s of o.out) {
  console.log(
    '  ' +
      String(s.label).padEnd(14) +
      ' plan[bundle]=' +
      String(s.planOnBundle).padEnd(9) +
      ' plan[wrapper]=' +
      String(s.planOnWrapper).padEnd(9) +
      ' built[bundle]=' +
      s.built +
      ' built[wrapper]=' +
      s.builtOnWrapper +
      ' engines=' +
      s.engines,
  );
  if (s.why) console.log('                 why[bundle]:  ' + s.why);
  if (s.err)
    console.log(
      '                 THREW: ' +
        s.err.msg +
        '\n                   ' +
        String(s.err.stack || '')
          .split('\n')
          .slice(1, 5)
          .join('\n                   '),
    );
  if (s.whyOnWrapper) console.log('                 why[wrapper]: ' + s.whyOnWrapper);
}
await br.close();
srv.close();
