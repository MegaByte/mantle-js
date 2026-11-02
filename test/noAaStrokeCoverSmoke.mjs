// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// noAaStrokeCoverSmoke — the opaque-stroke-covered no-AA fill gate (band-hard, v1).
//
// When every drawn fill in a bundle is covered by an opaque, solid, undashed stroke wide
// enough to hide its 1px AA band, aacFill:'auto' routes the FILL to band-hard (no-AA) — a
// crossing-count winding that skips coverage integration (~23-36% faster; probes/_noAaNet).
// The stroke paints over the fill boundary, so the result is pixel-identical to the AA fill.
//
// Pins:
//   1. a stroked, opaque-filled bundle ROUTES no-AA under 'auto' (R._autoEngine === 'hard-band')
//   2. its render is pixel-parity with the AA fill (the stroke hides any boundary difference)
//   3. a fill with NO stroke does NOT route no-AA (the predicate is necessary — bare fill AA is visible)
//   4. a DASHED stroke does NOT route no-AA (gaps expose the fill boundary)
//   5. the engine tally (debugStats.engines) records the kernel that drew: on pipelines that never warm, the selector
//      still decides band-hard but the base (Slug) program shades every frame, so the tally must say slug
//   6. a renderer warms the variant it draws even when ANOTHER renderer on the same WebGL context claimed the bundle's
//      creation-time prewarm (the cold renderer's first paint claims both new bundles below); the tally then records
//      hard-band.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 512;

const ring = (K, cx, cy, r) =>
  Array.from({ length: K }, (_, j) => [
    cx + r * Math.cos((2 * Math.PI * j) / K),
    cy + r * Math.sin((2 * Math.PI * j) / K),
  ]);
const flower = (K, cx, cy, r, b = 0.12) => {
  const P = ring(K, cx, cy, r);
  let d = `M ${P[0][0].toFixed(2)} ${P[0][1].toFixed(2)} `;
  for (let j = 0; j < K; j++) {
    const A = P[j],
      B = P[(j + 1) % K];
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * b,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * b;
    d += `Q ${mx.toFixed(2)} ${my.toFixed(2)} ${B[0].toFixed(2)} ${B[1].toFixed(2)} `;
  }
  return d + 'Z';
};
// cubic spline ring — exercises the tree-hard (cubic) route
const cubicRing = (K, cx, cy, r) => {
  const P = ring(K, cx, cy, r);
  const T = (j) => {
    const a = (2 * Math.PI * j) / K;
    return [-Math.sin(a), Math.cos(a)];
  };
  const h = (r * 2 * Math.PI) / K / 3;
  let d = `M ${P[0][0].toFixed(2)} ${P[0][1].toFixed(2)} `;
  for (let j = 0; j < K; j++) {
    const A = P[j],
      B = P[(j + 1) % K],
      ta = T(j),
      tb = T(j + 1);
    d += `C ${(A[0] + ta[0] * h).toFixed(2)} ${(A[1] + ta[1] * h).toFixed(2)} ${(B[0] - tb[0] * h).toFixed(2)} ${(B[1] - tb[1] * h).toFixed(2)} ${B[0].toFixed(2)} ${B[1].toFixed(2)} `;
  }
  return d + 'Z';
};
const grid = (n, sw, dash, gen = flower) => {
  const cols = 4,
    cell = n / cols;
  let b = '';
  const dashAttr = dash ? ` stroke-dasharray="${dash}"` : '';
  for (let i = 0; i < 16; i++)
    b += `<path fill="#c0392b" ${sw ? `stroke="#111" stroke-width="${sw}"` : ''}${dashAttr} d="${gen(24, (i % cols) * cell + cell / 2, Math.floor(i / cols) * cell + cell / 2, cell * 0.42)}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n}" height="${n}">${b}</svg>`;
};
const CASES = {
  stroked: grid(N, 8, 0), // opaque wide stroke, quads → band-hard
  strokedCubic: grid(N, 8, 0, cubicRing), // opaque wide stroke, cubics → band-hard (tree-hard is opt-in)
  bare: grid(N, 0, 0), // no stroke → must NOT route no-AA
  dashed: grid(N, 8, '20 8'), // dashed stroke → must NOT route no-AA
  strokeFirst: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}"><path fill="#c0392b" stroke="#111" stroke-width="8" paint-order="stroke fill" d="${flower(48, 256, 256, 210)}"/></svg>`,
  open: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}"><path fill="#c0392b" stroke="#111" stroke-width="8" d="M40 420 L256 40 L472 420"/></svg>`,
};

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N};
const rAuto = createRenderer(gl, shaders, { aacFill: 'auto' }); rAuto.setLoopBlinnFill('off');
const rSlug = createRenderer(gl, shaders, {}); rSlug.setLoopBlinnFill('off');
// Pipelines that never warm (psoWarmIdle false) keep drawing with the base program when variantFirst is off (the opt-out); always-idle ones upgrade.
// variantFirst is the DEFAULT: there the first frame already draws the decided lean program, and the tally must say so (rLean).
const rCold = createRenderer(gl, shaders, { aacFill: 'auto', psoWarmIdle: () => false, variantFirst: false }); rCold.setLoopBlinnFill('off');
const rLean = createRenderer(gl, shaders, { aacFill: 'auto', psoWarmIdle: () => false }); rLean.setLoopBlinnFill('off');
const rWarm = createRenderer(gl, shaders, { aacFill: 'auto', psoWarmIdle: () => true }); rWarm.setLoopBlinnFill('off');
const paint = (r, b) => { r.setViewport(N,N); gl.viewport(0,0,N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); };
const ledgerOf = (r) => ({ decided: r.debugStats.autoEngine, kernel: r.debugStats.coverKernel, draws: Object.keys((r.debugStats.engines && r.debugStats.engines.draws) || {}) });
const grab = () => { const p = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); return p; };
const draw = (r, b, opts) => { r.setViewport(N,N); gl.viewport(0,0,N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b, opts); r.endFrame(); const s=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,s); return grab(); };
window.__run = async (cases) => {
  const out = {};
  for (const [name, svg] of Object.entries(cases)) {
    const bA = createBundle(gl, await importSvg(svg)), bS = createBundle(gl, await importSvg(svg));
    const autoPx = draw(rAuto, bA); const engine = rAuto.debugStats.autoEngine; const noAaFlag = !!bA.noAaFill;
    if (name === 'stroked') {
      draw(rAuto, bA, { worldMatrix: [10,0,0, 0,0.05,0, 0,0,1] });
      out.strokedAnisotropic = { engine: rAuto.debugStats.autoEngine };
      draw(rAuto, bA, { alpha: 0.5 });
      out.strokedAlpha = { engine: rAuto.debugStats.autoEngine };
      // Both bundles exist before the cold renderer's first frame, whose warm tick claims them from the shared context queue.
      const bC = createBundle(gl, await importSvg(svg)), bW = createBundle(gl, await importSvg(svg));
      for (let i = 0; i < 3; i++) paint(rCold, bC);
      out.ledgerCold = ledgerOf(rCold);
      const bL = createBundle(gl, await importSvg(svg));
      for (let i = 0; i < 3; i++) paint(rLean, bL);
      out.ledgerLean = ledgerOf(rLean);
      bL.dispose();
      for (let i = 0; i < 300 && rWarm.debugStats.coverKernel !== 'hard-band'; i++) { paint(rWarm, bW); await new Promise((res) => setTimeout(res, 4)); }
      paint(rWarm, bW);
      out.ledgerWarm = ledgerOf(rWarm);
      bC.dispose(); bW.dispose();
    }
    const slugPx = draw(rSlug, bS);
    let mx = 0, nDiff = 0; for (let i = 0; i < autoPx.length; i++) { const d = Math.abs(autoPx[i]-slugPx[i]); if (d>mx) mx=d; if (d>16) nDiff++; }
    out[name] = { engine, noAaFlag, maxDiff: mx, nDiff: Math.round(nDiff/4) };
    bA.dispose(); bS.dispose();
  }
  return out;
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
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });
const o = await pg.evaluate((c) => window.__run(c), CASES);
await br.close();
server.close();

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
console.log('  routing:', JSON.stringify(o));
ok(o.stroked.noAaFlag === true, 'stroked bundle is flagged noAaFill at build');
ok(
  o.stroked.engine === 'hard-band',
  `stroked quad bundle routes band-hard under auto (got ${o.stroked.engine})`,
);
ok(
  o.stroked.nDiff < 40,
  `stroked band-hard is pixel-parity with Slug (${o.stroked.nDiff} px differ >16, max ${o.stroked.maxDiff})`,
);
ok(
  o.strokedCubic.engine === 'hard-band',
  `stroked cubic bundle routes band-hard under auto (got ${o.strokedCubic.engine})`,
);
ok(
  o.strokedCubic.nDiff < 60,
  `stroked cubic band-hard is pixel-parity with Slug (${o.strokedCubic.nDiff} px differ >16, max ${o.strokedCubic.maxDiff})`,
);
ok(o.bare.noAaFlag === false, 'unstroked bundle is NOT flagged noAaFill');
ok(o.bare.engine !== 'hard-band', `unstroked bundle does NOT route no-AA (got ${o.bare.engine})`);
ok(o.dashed.noAaFlag === false, 'dashed-stroke bundle is NOT flagged noAaFill');
ok(
  o.dashed.engine !== 'hard-band',
  `dashed-stroke bundle does NOT route no-AA (got ${o.dashed.engine})`,
);
ok(o.strokeFirst.noAaFlag === false, 'stroke-under-fill paint order is NOT flagged noAaFill');
ok(o.open.noAaFlag === false, 'open path with an unstroked implicit close is NOT flagged noAaFill');
ok(
  !String(o.strokedAnisotropic.engine).startsWith('noaa'),
  'anisotropic scale with a thin device-axis stroke stays AA',
);
ok(!String(o.strokedAlpha.engine).startsWith('noaa'), 'sub-opaque draw alpha stays AA');
ok(
  o.ledgerCold.decided === 'hard-band',
  `cold pipelines (variantFirst: false): the selector still decides band-hard (got ${o.ledgerCold.decided})`,
);
ok(
  o.ledgerCold.kernel === 'slug',
  `cold pipelines (variantFirst: false): the base program drew, and coverKernel says slug (got ${o.ledgerCold.kernel})`,
);
ok(
  o.ledgerCold.draws.includes('slug') && !o.ledgerCold.draws.includes('hard-band'),
  `cold pipelines (variantFirst: false): the tally records slug, not the undrawn band-hard (draws ${o.ledgerCold.draws.join('+')})`,
);
ok(
  o.ledgerLean.decided === 'hard-band' &&
    o.ledgerLean.kernel === 'hard-band' &&
    o.ledgerLean.draws.includes('hard-band') &&
    !o.ledgerLean.draws.includes('slug'),
  `variantFirst (default): the first frame draws the decided lean program and the tally records it (decided ${o.ledgerLean.decided}, kernel ${o.ledgerLean.kernel}, draws ${o.ledgerLean.draws.join('+')})`,
);
ok(
  o.ledgerWarm.kernel === 'hard-band' && o.ledgerWarm.draws.includes('hard-band'),
  `a renderer warms the variant it draws, though another renderer claimed its bundle (kernel ${o.ledgerWarm.kernel}, draws ${o.ledgerWarm.draws.join('+')})`,
);
console.log(fail ? `\nNOAA-STROKE-COVER FAIL (${fail})` : '\nNOAA-STROKE-COVER PASS');
process.exit(fail ? 1 : 0);
