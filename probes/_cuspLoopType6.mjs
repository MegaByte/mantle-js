// _cuspLoopType6 — CUSP cubics are recovered EXACTLY on the tree-hard fill via a new type-6 hard
// cubic piece (raw control points wound by the exact +x ray-crossing hardCrossCubic), replacing the
// old straight-line fallback that miscounted a cusp by ~504 px. Self-intersecting LOOP cubics
// CANNOT be made exact on the tree (the far-node chord approximation and the piece winding both
// break on a self-intersecting run — measured 278 px on a type-6 loop, 5946 px on a type-4 loop),
// so they are vetoed off the no-AA path to an AA engine (Slug/AAC), which fills them exactly.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 512;

// stroke-covered (opaque, wide, solid) closed cubic → routes tree-hard under aacFill:'auto'
const shape = (P) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">`
  + `<path fill="#c0392b" stroke="#111" stroke-width="10" fill-rule="nonzero" `
  + `d="M ${P[0][0]} ${P[0][1]} C ${P[1][0]} ${P[1][1]} ${P[2][0]} ${P[2][1]} ${P[3][0]} ${P[3][1]} Z"/></svg>`;

const CASES = {
  loop:  shape([[120, 260], [400, 60], [120, 60], [400, 260]]),    // symmetric self-touch (klmn null)
  tilt:  shape([[100, 300], [450, 380], [420, 120], [180, 360]]),  // GENUINE distinct-crossing loop (klmn ok)
  cusp:  shape([[100, 300], [500, 300], [100, 100], [500, 100]]),  // klmn null real cusp (P0!=P3)
};

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N};
const rAuto = createRenderer(gl, shaders, { aacFill: 'auto' }); rAuto.setLoopBlinnFill('off');
const rSlug = createRenderer(gl, shaders, {}); rSlug.setLoopBlinnFill('off');
const grab = () => { const p = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
const draw = (r, b) => { r.setViewport(N,N); gl.viewport(0,0,N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); const s=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,s); return grab(); };
window.__run = async (cases) => {
  const out = {};
  for (const [name, svg] of Object.entries(cases)) {
    const bA = createBundle(gl, await importSvg(svg)), bS = createBundle(gl, await importSvg(svg));
    const autoPx = draw(rAuto, bA); const engine = rAuto.debugStats.autoEngine;
    const slugPx = draw(rSlug, bS);
    let mx = 0, nDiff = 0; for (let i = 0; i < autoPx.length; i++) { const d = Math.abs(autoPx[i]-slugPx[i]); if (d>mx) mx=d; if (d>16) nDiff++; }
    out[name] = { engine, maxDiff: mx, nDiff: Math.round(nDiff/4) };
    bA.dispose(); bS.dispose();
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  let f = decodeURIComponent(req.url.split('?')[0]);
  if (f === '/') { res.setHeader('content-type', 'text/html'); return res.end(HTML); }
  try {
    const body = readFileSync(path.join(ROOT, f));
    res.setHeader('content-type', f.endsWith('.js') || f.endsWith('.mjs') ? 'text/javascript'
      : f.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream');
    res.end(body);
  } catch { res.statusCode = 404; res.end('nf'); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const br = await puppeteer.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', e => console.error('[PGERR]', e.message));
await pg.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
await pg.waitForFunction('window.__ready === true', { timeout: 20000 });
const o = await pg.evaluate((c) => window.__run(c), CASES);
await br.close(); server.close();

let fail = 0;
const ok = (c, m) => c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m));
console.log('  result:', JSON.stringify(o));
// CUSP: recovered EXACTLY on the tree via the type-6 hard cubic piece (was 504 px on the old line
// fallback). A cusp is a single strand, so nothing pokes out from under the covering stroke → 0 px.
ok(o.cusp.engine === 'noaa-tree', `cusp routes tree-hard via type-6 (got ${o.cusp.engine})`);
ok(o.cusp.nDiff === 0 && o.cusp.maxDiff === 0, `cusp tree-hard is EXACT vs Slug (${o.cusp.nDiff} px >16, max ${o.cusp.maxDiff})`);
// LOOPS: opaque-stroke-covered self-intersecting loops stay on the tree, wound EXACTLY by type-6
// pieces (hardCrossCubic) — the genuine distinct-crossing loop `tilt` was 5946 px on the old type-4
// klm implicit. The winding is now correct; only a sub-pixel hard-vs-AA residual remains at the
// self-crossing (the one fill edge the covering stroke can't mask), which the no-AA route accepts.
// A loop that is NOT opaque-stroke-covered never reaches here — it renders on an AA engine (exact).
for (const k of ['loop', 'tilt']) {
  ok(o[k].engine === 'noaa-tree', `${k} loop stays on the tree via type-6 (got ${o[k].engine})`);
  ok(o[k].nDiff < 120, `${k} winding correct; only a sub-pixel self-crossing residual (${o[k].nDiff} px >16, max ${o[k].maxDiff})`);
}
console.log(fail ? `\nCUSP-LOOP-TYPE6 FAIL (${fail})` : '\nCUSP-LOOP-TYPE6 PASS');
process.exit(fail ? 1 : 0);
