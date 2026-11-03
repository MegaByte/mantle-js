// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _morphRouteDiag.mjs — why a morph does not take the unified morph route under 'auto'.
//
// Twelve route smokes fail with "did not route" while their pictures equal the Slug morph. The
// failing cases morph smooth 4-cubic ellipses; the passing `flip` case is lines + one cubic. This
// draws each case the way morphRouteSmoke does and records, per draw, the route gate, the morph
// mesh state and the variant, once with SDF primitives on and once off.
//
//   node probes/_morphRouteDiag.mjs
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const K = 0.5522847498;
const ellipsePath = (cx, cy, rx, ry) =>
  `M ${cx + rx} ${cy} ` +
  `C ${cx + rx} ${cy - K * ry} ${cx + K * rx} ${cy - ry} ${cx} ${cy - ry} ` +
  `C ${cx - K * rx} ${cy - ry} ${cx - rx} ${cy - K * ry} ${cx - rx} ${cy} ` +
  `C ${cx - rx} ${cy + K * ry} ${cx - K * rx} ${cy + ry} ${cx} ${cy + ry} ` +
  `C ${cx + K * rx} ${cy + ry} ${cx + rx} ${cy + K * ry} ${cx + rx} ${cy} Z`;
const svg = (d, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="${d}" fill="#3366cc" ${extra}/></svg>`;
const ring = (a, b, c, d) =>
  svg(`${ellipsePath(100, 100, a, b)} ${ellipsePath(100, 100, c, d)}`, 'fill-rule="evenodd"');
const WOBBLE =
  'M100 40 C140 10 170 50 165 100 C160 150 140 170 100 165 C55 160 30 140 35 100 C40 50 60 10 100 40 Z';

const CASES = {
  fast: { src: svg(ellipsePath(100, 100, 60, 60)), dst: svg(ellipsePath(100, 100, 80, 40)) },
  holed: { src: ring(70, 70, 35, 35), dst: ring(80, 50, 40, 25) },
  flip: {
    src: svg('M 40 160 L 160 160 L 160 90 C 130 50 70 50 40 90 Z'),
    dst: svg('M 40 160 L 160 160 L 160 90 C 130 120 70 120 40 90 Z'),
  },
  wobble: { src: svg(ellipsePath(100, 100, 60, 60)), dst: svg(WOBBLE) },
};

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const W = 256, H = 256, CASES = ${JSON.stringify(CASES)};
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders); renderer.setViewport(W, H);
const clr = () => { gl.clearColor(1, 1, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summarize = (ms) => {
  if (!ms) return ms === undefined ? 'undefined' : String(ms);
  return Array.from(ms).map((m) => m ? { keys: Object.keys(m).slice(0, 24).join(','), mode: m.mode, prim: m.prim,
    kindMask: m.kindMask, vc: m.vertexCount, slug: !!m.slug, segs: m.segments ? m.segments.length : 0 } : null);
};
async function runCase(key, sdf) {
  if (renderer.setSdfPrimitives) renderer.setSdfPrimitives(sdf);
  const c = CASES[key];
  const morph = createShapeMorph(gl, createBundle(gl, await importSvg(c.src)), createBundle(gl, await importSvg(c.dst)));
  renderer.setLoopBlinnMorphFill('auto');
  const trace = [];
  for (let i = 0; i < 40; i++) {
    morph.setT(0); clr();
    const before = renderer.debugStats.loopBlinnMorphRouteCount | 0;
    renderer.drawBundle(morph);
    const st = renderer.debugStats;
    const routed = (st.loopBlinnMorphRouteCount | 0) - before;
    if (i === 0 || i === 1 || i === 39 || routed) {
      trace.push({ i, routed, gate: st.unifiedFillGate, variant: st.fillVariantKey, lbMode: st.loopBlinnFillMode,
        built: morph._morphMeshesBuilt, inFlight: morph._morphWorkerSrc === morph._morphSrc,
        matchedAll: !!(morph._morphSrc && morph._morphSrc.matchedAll),
        morphMeshes: summarize(morph._morphMeshes), partial: morph._morphMeshesPartial ? 'yes' : null,
        lbMeshes: summarize(morph._lbMeshes), elig: morph._lbEligCache || null,
        prim: morph._primScanGen, hasPrim: morph._hasPrim });
    }
    if (routed) break;
    await sleep(25);
  }
  try { morph.dispose(); } catch {}
  return trace;
}
const out = {};
try {
  for (const sdf of [true, false]) for (const key of Object.keys(CASES)) out[key + (sdf ? '' : ':noSdf')] = await runCase(key, sdf);
  out.ok = true;
} catch (e) { out.err = String((e && e.stack) || e); }
window.__r = out; window.__done = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  const p = decodeURIComponent(u.pathname);
  const mm =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mm + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--no-sandbox', '--use-gl=angle'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warn') console.error('  [console]', m.text());
});
await page.goto('http://127.0.0.1:' + server.address().port + '/', {
  waitUntil: 'load',
  timeout: 20000,
});
await page.waitForFunction(() => window.__done === true, { timeout: 180000 }).catch(() => {});
const r = await page.evaluate(() => window.__r);
await browser.close();
server.close();
console.log(JSON.stringify(r, null, 1));
process.exit(r && r.ok ? 0 : 1);
