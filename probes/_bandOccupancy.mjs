// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _bandOccupancy — why does a QUAD ring cost more per pixel than a CUBIC one?
//
// The stroke sweep measured quadratics at 1.44x cubics on the same 64-segment ring at the same ink,
// which is backwards from the algebra: a quad's closest point is a cubic solve (closed form), a
// cubic's is a quintic (9 samples + 3 Newton). Two arms proved the solver is NOT the cause -- the
// iterative alternative and a fused-trig variant are both SLOWER than the shipping closed form.
//
// The remaining suspect is what the band walk has to visit. A band lists every segment whose bound
// overlaps it, so a segment with a WIDER bound appears in more bands, and every fragment in those
// bands pays to consider it. Control-hull width differs by type for the same drawn curve. This
// reports the encoded sizes so the ratio can be read off rather than guessed at.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEGS = +(process.env.SEGS || 64),
  SW = +(process.env.SW || 8);

const PAGE = `<!doctype html><body><canvas id=c width=64 height=64></canvas><script type=module>
import { importSvg } from '/src/index.js';
const W=128, SEGS=${SEGS};
const ring=(type)=>{const cx=W/2,cy=W/2,rad=W*0.36,P=[];
  for(let i=0;i<SEGS;i++){const a=-Math.PI/2+i*2*Math.PI/SEGS;P.push([cx+rad*Math.cos(a),cy+rad*Math.sin(a)]);}
  let d='M'+P[0][0].toFixed(3)+' '+P[0][1].toFixed(3);
  for(let i=0;i<SEGS;i++){const p=P[i],q=P[(i+1)%SEGS];
    const mx=(p[0]+q[0])/2,my=(p[1]+q[1])/2,bx=cx+(mx-cx)*1.02,by=cy+(my-cy)*1.02;
    if(type==='line') d+=' L'+q[0].toFixed(3)+' '+q[1].toFixed(3);
    else if(type==='quad') d+=' Q'+bx.toFixed(3)+' '+by.toFixed(3)+' '+q[0].toFixed(3)+' '+q[1].toFixed(3);
    else if(type==='cubic'){const c1=[p[0]+(bx-p[0])*0.66,p[1]+(by-p[1])*0.66],c2=[q[0]+(bx-q[0])*0.66,q[1]+(by-q[1])*0.66];
      d+=' C'+c1[0].toFixed(3)+' '+c1[1].toFixed(3)+' '+c2[0].toFixed(3)+' '+c2[1].toFixed(3)+' '+q[0].toFixed(3)+' '+q[1].toFixed(3);}
    else d+=' A'+rad.toFixed(3)+' '+rad.toFixed(3)+' 0 0 1 '+q[0].toFixed(3)+' '+q[1].toFixed(3);}
  return d+' Z';};
const svgOf=(t)=>'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+W+' '+W+'"><path d="'+ring(t)
  +'" fill="none" stroke="#000" stroke-width="${SW}" stroke-linejoin="miter" stroke-linecap="butt"/></svg>';
const out=[];
for (const t of ['line','quad','cubic','arc']) {
  const s = await importSvg(svgOf(t));
  // importSvg hands back the wire planes as ArrayBuffers; a band entry is one RGBA32F texel.
  out.push({ t,
    bandTexels: (s.bands ? s.bands.byteLength : 0) / 16,
    curveTexels: (s.curves ? s.curves.byteLength : 0) / 16,
    metaTexels: (s.meta ? s.meta.byteLength : 0) / 16 });
}
window.__out=out;
</script>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    const _p = q.url.split('?')[0];
    if (_p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
      return;
    }
    res.writeHead(200, { 'content-type': mime(_p) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(_p))));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction('window.__out', { timeout: 120000, polling: 100 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();
console.log(
  `\n  band occupancy — the SAME ring said four ways (${SEGS} segments, stroke-width ${SW})`,
);
console.log('    type      band texels   curve texels   band vs line   curve vs line');
const base = o[0].bandTexels,
  baseC = o[0].curveTexels;
for (const x of o)
  console.log(
    `    ${x.t.padEnd(9)} ${String(x.bandTexels).padStart(11)} ${String(x.curveTexels).padStart(14)}` +
      ` ${(x.bandTexels / base).toFixed(2).padStart(14)}x ${(x.curveTexels / baseC).toFixed(2).padStart(14)}x`,
  );
console.log(
  '\n    A band lists every segment whose bound overlaps it, so "per band" is what a fragment walks.',
);
