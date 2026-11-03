// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aaMonotonicSmoke — crossing an edge, coverage must fall from solid to background WITHOUT
// rising again, and asking for an engine must actually get you that engine.
//
// Two things this pins, on an even-odd ring:
//
// 1. NON-MONOTONE AA. Coverage must fall from solid to background without rising again — not
//    wobble 100 → 40 → 60 → 0. The trap: orienting the exact half-plane area by comparing it
//    against the WINDING MAGNITUDE rather than a coverage is meaningless on an interior edge
//    (winding 1 → 2, so the comparison is against ~1.5 and just takes the larger of ec / 1-ec).
//    Half those picks are the wrong side, which returns a 0.7 pixel as 0.3.
//
// 2. THE ENGINE YOU ASK FOR. `aacFill: true` must draw AAC, not keep drawing Slug while the AAC
//    program links and its pipeline warms — otherwise any render of a few frames (a test, an
//    A/B, the demo) silently produces Slug and calls it AAC, and every AAC comparison made that
//    way compares Slug with itself. The last assertion here is the guard: AAC must not be
//    pixel-identical to Slug.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 400;

// A ring: every tangent angle appears, so the AA ramp is sampled at every width.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <path fill="#3366cc" fill-rule="evenodd" d="M 170 100 C 170 61.34 138.66 30 100 30 C 61.34 30 30 61.34 30 100 C 30 138.66 61.34 170 100 170 C 138.66 170 170 138.66 170 100 Z M 135 100 C 135 80.67 119.33 65 100 65 C 80.67 65 65 80.67 65 100 C 65 119.33 80.67 135 100 135 C 119.33 135 135 119.33 135 100 Z"/>
</svg>`;
emitFixture('aaMonotonic__RING', SVG);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, SVG = ${JSON.stringify(SVG)};
const shots = {};
async function paint(label, rOpts, impOpts, lbMode) {
  const r = createRenderer(gl, shaders, rOpts || {});
  r.setLoopBlinnFill(lbMode || 'off');
  const b = createBundle(gl, await importSvg(SVG, impOpts || {}));
  r.prepareBundle(b);
  if (r.awaitLbReady && lbMode && lbMode !== 'off') await r.awaitLbReady(b);
  r.setViewport(N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b, {}); r.endFrame();
  const px = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px);
  shots[label] = px;
}
await paint('slug', null, null, 'off');
await paint('aac',  { aacFill: true }, null, 'off');
await paint('gwn',  { fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF'] }, { gwnTree:true }, 'off');
await paint('lb',   null, null, 'on');

// Coverage 0..100 from luminance (the fill is #3366cc on white).
const cov = (px, x, y) => { const o = (y*N + x)*4;
  return (255 - (px[o]+px[o+1]+px[o+2])/3) / (255 - 119) * 100; };
// Score only GENUINE single-edge crossings: a short run of partial pixels with SOLID on one
// side and BACKGROUND on the other. A run bounded the same way at both ends is a scanline
// grazing the curve, where a rise is legitimate — scoring those flags even the browser.
const wobble = (px) => {
  let bad = 0, runs = 0, worst = 0;
  const scan = (get) => {
    for (let a = 0; a < N; a++) {
      let run = [], prevSolid = false;
      for (let b = 0; b <= N; b++) {
        const c = (b < N) ? get(a, b) : 0;
        const solid = c > 97, bg = c < 3;
        if (solid || bg || b === N) {
          if (run.length >= 1 && run.length <= 5 && prevSolid === bg && (prevSolid || solid)) {
            const seq = prevSolid ? run : run.slice().reverse();   // travel SOLID -> BACKGROUND
            runs++;                       // COUNT one-pixel ramps too, or an engine whose ramps
            for (let i = 1; i < seq.length; i++) {   // are all 1px scores 0/0 and the assertion
              const d = seq[i] - seq[i-1];           // "0 wobbles" proves nothing at all.
              if (d > 6) { bad++; if (d > worst) worst = d; }
            }
          }
          run = []; prevSolid = solid;
        } else run.push(c);
      }
    }
  };
  scan((y, x) => cov(px, x, y));
  scan((x, y) => cov(px, x, y));
  return { bad, runs, worst: +worst.toFixed(1) };
};
const same = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
window.__out = {
  wobble: Object.fromEntries(Object.entries(shots).map(([k,v]) => [k, wobble(v)])),
  aacIsSlug: same(shots.aac, shots.slug),
};
window.__ready = true;
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
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 100 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
const w = o.wobble;

for (const k of ['slug', 'aac', 'gwn', 'lb'])
  console.log(
    `  ${k.padEnd(5)} ${w[k].bad} of ${w[k].runs} edge crossings wobble (worst +${w[k].worst} coverage)`,
  );

ok(!o.aacIsSlug, 'aacFill:true actually engages the AAC kernel (not pixel-identical to Slug)');
// Guard the guard: if no crossings are scored, "0 wobbles" is vacuous.
for (const k of ['slug', 'aac', 'gwn', 'lb'])
  ok(
    w[k].runs > 100,
    `${k}: the ring presents ${w[k].runs} edge crossings to score (not a vacuous pass)`,
  );
// Slug is the DEFAULT engine, so this is the one that decides what the games look like.
ok(w.slug.bad === 0, `Slug's AA is monotone across every edge crossing (${w.slug.bad} wobbles)`);
ok(w.lb.bad === 0, `LB's AA is monotone across every edge crossing (${w.lb.bad} wobbles)`);
ok(w.aac.bad === 0, `AAC's AA is monotone across every edge crossing (${w.aac.bad} wobbles)`);
ok(w.gwn.bad === 0, `GWN's AA is monotone across every edge crossing (${w.gwn.bad} wobbles)`);

// GWN has the same trap in a different dress: orienting its coverage half-plane by "ink is left
// of travel" holds only for consistently-wound contours — and an even-odd ring's inner circle is
// wound the same way as its outer. Where that fails, the ramp runs backwards: a white seam inside
// the ink, and stipple. GWN takes the fill side from the winding it already computes
// (single-edge pixels only; at a corner the center's winding does not determine each plane's side).

console.log(fail ? `\nAA-MONOTONIC FAIL (${fail})` : '\nAA-MONOTONIC PASS');
process.exit(fail ? 1 : 0);
