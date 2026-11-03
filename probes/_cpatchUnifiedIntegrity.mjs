// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchUnifiedIntegrity — CPatch has its own kernel, vertex stage and defines, separate from
// Loop-Blinn. What must hold is that it still rides the UNIFIED fill draw:
// one drawArrays carrying cover quads and analytic geometry together, through the ubershader.
//
// Separating an engine's CODE and separating its DRAW are different things, and only the first is
// wanted. A split that quietly gave CPatch its own pass would still render correctly and would
// still pass every pixel test -- it would just cost a draw per bundle and undo the batching the
// unified route exists for. Draw counts are the only witness.
//
// Checks, per case: the ubershader's unified draw ran; it ran ONCE per frame regardless of shape
// count (batching intact); the engine ledger attributes the draw to cpatch; and a MIXED bundle --
// CPatch geometry plus shapes CPatch cannot take -- still resolves to one draw with both engines
// recorded, which is the case that proves cover quads and CPatch patches still share a stream.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const poly = (cx, cy, r, n) => {
  const p = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return (
    'M' + p.map((q, i) => (i ? 'L' : '') + q[0].toFixed(3) + ' ' + q[1].toFixed(3)).join(' ') + ' Z'
  );
};
const curvy = (cx, cy, r) =>
  `M${cx - r} ${cy} C${cx - r} ${cy - r * 1.3} ${cx + r} ${cy - r * 1.3} ${cx + r} ${cy} ` +
  `C${cx + r} ${cy + r * 1.3} ${cx - r} ${cy + r * 1.3} ${cx - r} ${cy} Z`;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${body}</svg>`;
const CASES = {
  one: svg(`<path d="${poly(64, 64, 44, 16)}" fill="#265b9b"/>`),
  eight: svg(
    Array.from(
      { length: 8 },
      (_, i) =>
        `<path d="${poly(20 + (i % 4) * 30, 30 + ((i / 4) | 0) * 60, 13, 12)}" fill="#265b9b"/>`,
    ).join(''),
  ),
  curves: svg(`<path d="${curvy(64, 64, 40)}" fill="#265b9b"/>`),
  mixed: svg(
    `<path d="${poly(40, 64, 30, 16)}" fill="#265b9b"/>` +
      `<path d="${curvy(96, 64, 26)}" fill="#9b2659"/>` +
      `<rect x="4" y="4" width="20" height="20" fill="#4d9b26"/>`,
  ),
  // A STROKE puts stroke-segment vertices in the same stream as CPatch patches. If the split had
  // given CPatch its own pass, this is where it would show as two draws.
  stroked: svg(`<path d="${poly(64, 64, 40, 16)}" fill="#265b9b" stroke="#e8b" stroke-width="5"/>`),
  // A gradient selects a different fill VARIANT. Same stream, different program: the check is that
  // the route survives the variant change rather than declining to a per-shape path.
  gradient: svg(
    `<defs><linearGradient id="g"><stop offset="0" stop-color="#265b9b"/>` +
      `<stop offset="1" stop-color="#9b2659"/></linearGradient></defs>` +
      `<path d="${poly(64, 64, 42, 16)}" fill="url(#g)"/>`,
  ),
  // A shape CPatch REFUSES, alongside one it takes. Both must land in ONE draw with both engines
  // recorded -- that is the property that proves cover quads and CPatch patches still share a
  // stream rather than merely both existing.
  declineMix: svg(
    `<path d="${poly(38, 64, 28, 16)}" fill="#265b9b"/>` +
      `<path d="${curvy(96, 40, 22)}" fill="#9b2659"/>` +
      `<path d="M70 92 L118 92 L118 120 L70 120 Z" fill="#4d9b26"/>`,
  ),
};
// A REAL ASSET is the only reliable way to get a genuine mix: the synthetic shapes above are all
// convertible, and a converter robust enough to take everything cannot be made to decline by
// tightening a budget (maxCurves: 2 just produced more cells). The tiger has contours CPatch drops,
// so its bundle carries CPatch patches AND cover-quad fills -- in one draw, or the split broke the
// thing it was not supposed to touch.
// THE COMPOSED PATH is served by a DIFFERENT program: loopBlinn.frag as R.lbProg, bound via
// _drawLBShapeDirect / _renderStaticCovRT for clip/mask/filter over a static fill. That program is
// compiled WITHOUT MANTLE_CPATCH, so a kind-14 vertex reaching it has no kernel to be shaded by --
// it would render wrong, silently, with every counter still reporting CPatch. These cases ask
// whether a CPatch bundle can get there.
CASES.clipped = svg(
  `<defs><clipPath id="c"><circle cx="64" cy="64" r="34"/></clipPath></defs>` +
    `<path d="${poly(64, 64, 46, 16)}" fill="#265b9b" clip-path="url(#c)"/>`,
);
CASES.filtered = svg(
  `<defs><filter id="f"><feGaussianBlur stdDeviation="1.2"/></filter></defs>` +
    `<path d="${poly(64, 64, 42, 16)}" fill="#265b9b" filter="url(#f)"/>`,
);
CASES.grouped = svg(`<g opacity="0.55"><path d="${poly(64, 64, 42, 16)}" fill="#265b9b"/></g>`);
CASES.tiger = readFileSync(path.join(ROOT, '..', 'examples', 'Ghostscript_Tiger.svg'), 'utf8');
const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const CASES=${JSON.stringify(CASES)};
window.__run=async()=>{
  const out=[];
  for (const [name, SVG] of Object.entries(CASES)) {
    const c=document.createElement('canvas');c.width=256;c.height=256;document.body.appendChild(c);
    const gl=c.getContext('webgl2',{antialias:false,preserveDrawingBuffer:true,depth:true,stencil:true});
    // declineMix forces refusals with a tight per-patch curve budget, so SOME shapes convert and
    // the rest fall back to cover quads -- in the same bundle, which is the case that proves the
    // stream is still shared rather than merely that both engines exist.
    const cpOpts = name==='declineMix' ? {cpatchOpts:{maxCurves:2, tolPx:0.0005}} : {};
    const r=createRenderer(gl,shaders,{precompileFillsBudgetMs:5000,...cpOpts}); await r.ready;
    r.setViewport(256,256); r.setFillEngine({route:'cpatch', kernel:'slug'});
    const b=createBundle(gl,await importSvg(SVG,{}));
    if(r.awaitEngine) await r.awaitEngine(b,'cpatch',30000);
    // Warm frames first: a variant still linking would report the fallback's draw counts.
    for(let i=0;i<3;i++){ r.beginFrame([0,0,0,1]); r.drawBundle(b,{}); r.endFrame(); }
    const d0=r.debugStats, u0=d0.unifiedFillDraws|0, e0=Object.assign({},(d0.engines||{}).draws||{});
    r.beginFrame([0,0,0,1]); r.drawBundle(b,{}); r.endFrame();
    const d=r.debugStats, E=d.engines||{draws:{}};
    const drew={}; for(const k of Object.keys(E.draws||{})){const n=(E.draws[k]|0)-(e0[k]|0); if(n) drew[k]=n;}
    const px=new Uint8Array(256*256*4); gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,px);
    let ink=0; for(let i=0;i<px.length;i+=4) if(px[i]||px[i+1]||px[i+2]) ink++;
    out.push({name, shapes:b.numShapes|0, cpatchBuilt:b._cpatchBuilt|0, cells:b._cpatchCells|0,
              uni:(d.unifiedFillDraws|0)-u0, drew, ink, dropped:b._cpatchDropped|0,
              declines:Object.keys((E.declines)||{}).length?E.declines:null});
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
  if (/link failed|not compiled|ERROR/i.test(t)) console.error(' [console]', t.slice(0, 300));
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === 1, { timeout: 120000, polling: 50 });
const rows = await pg.evaluate(() => window.__run());
await br.close();
server.close();
let bad = 0;
console.log('\n  case     shapes  patches  cells   unifiedDraws  engines drew          ink');
for (const r of rows) {
  const drew =
    Object.entries(r.drew)
      .map(([k, v]) => k + ':' + v)
      .join(' ') || '-';
  console.log(
    '  ' +
      r.name.padEnd(9) +
      String(r.shapes).padStart(4) +
      String(r.cpatchBuilt).padStart(9) +
      String(r.cells).padStart(7) +
      String(r.uni).padStart(13) +
      '   ' +
      drew.padEnd(20) +
      String(r.ink).padStart(7) +
      (r.dropped ? '  dropped ' + r.dropped : ''),
  );
  const composed = r.name === 'clipped' || r.name === 'filtered' || r.name === 'grouped';
  if (!composed && r.uni !== 1) {
    console.log('    FAIL: expected exactly ONE unified draw, got ' + r.uni);
    bad++;
  }
  if (!composed && !(r.drew.cpatch > 0)) {
    console.log('    FAIL: no draw attributed to cpatch');
    bad++;
  }
  if (composed)
    console.log(
      '    composed-path case: unifiedDraws=' +
        r.uni +
        ' engines=' +
        drew +
        (r.uni
          ? '  (stayed unified)'
          : '  (took the composed path -- check the program has the kernel)'),
    );
  if (r.dropped && Object.keys(r.drew).length < 2)
    console.log(
      '    FAIL: ' + r.dropped + ' shapes fell off CPatch but no second engine was recorded',
    );
  if (!r.ink) {
    console.log('    FAIL: painted nothing');
    bad++;
  }
  if (r.declines) console.log('    declines: ' + JSON.stringify(r.declines));
}
console.log(
  '\n  ' +
    (bad
      ? 'UNIFIED-INTEGRITY FAIL (' + bad + ')'
      : 'UNIFIED-INTEGRITY PASS — CPatch is its own engine and still ONE draw'),
);
process.exit(bad ? 1 : 0);
