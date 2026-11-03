// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbSeamPartitionSmoke.mjs — rim accuracy of the UNIFIED fill draw vs Slug.
//
// On a lone crescent and on arcs separated by lines the unified draw matches Slug; on an 8-arc
// quad ellipse it reads +0.146, which is the LB curve kernel's own AA differing from Slug on
// ADJACENT quad arcs, the documented LB characteristic (LB curve AA is 2-3x less accurate than
// Slug), and not a compositing defect: probes/_lbUnifiedVsClassic.mjs compares the unified draw
// with a per-shape route pixel for pixel on these shapes.
//
//   lone crescent      chord cut active (abs(vSign) > 2)   maxPos  0.003  ok
//   arcs sep. by lines no adjacent crescents               maxPos  0.003  ok
//   quad ellipse       interior + 8 adjacent crescents     maxPos  0.146  LB AA
//
// TWO MEASUREMENT TRAPS, both worth keeping:
//
// 1. A GL DRAW COUNT OF 1 DOES NOT IDENTIFY THE UNIFIED ROUTE. Another route can
//    paint a solid bundle in one drawArrays too, so a draw count cannot tell them
//    apart. debugStats.unifiedFillDraws is bumped at the unified drawArrays
//    itself and is the only counter that separates them.
//
// 2. THE UNIFIED DRAW BLENDS WITH OVER under the depth claim, not MAX. MAX lives
//    only in the coverage-RT paths used for gradient/image/composed shapes. So the
//    premise "OVER cannot reproduce MAX on a multi-piece mesh" cannot be tested by
//    comparing one OVER draw with another.
//
// Also true, and worth remembering for the RT paths: a pixel is
// an AREA, so two triangles can partition it exactly and still both shade it, each
// computing coverage over the whole pixel. That is why the coverage RT uses MAX.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const wrap = (d) =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  `<path d="${d}" fill="#3060c0"/></svg>`;
// LONE: one quad + closing chord — the whole fill is a single crescent.
const LONE = wrap('M14 70 Q50 8 86 70 Z');
// MULTI: an ELLIPSE, which is what lbQuadSeam renders. It does not go through
// crescents at all — ellipseFromContours lifts it to the kind-7 analytic SDF —
// so it exercises a different LB kind than the blob above; a synthetic blob
// misses the seam case, which is why this uses the real shape.
function quadEllipse(cx, cy, rx, ry) {
  const N = 8,
    pt = (a) => [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  const tan = (a) => [-rx * Math.sin(a), ry * Math.cos(a)];
  let d = '';
  for (let i = 0; i < N; i++) {
    const a0 = (2 * Math.PI * i) / N,
      a1 = (2 * Math.PI * (i + 1)) / N;
    const p0 = pt(a0),
      p1 = pt(a1),
      t0 = tan(a0),
      t1 = tan(a1);
    const det = t0[0] * -t1[1] - t0[1] * -t1[0];
    const k = ((p1[0] - p0[0]) * -t1[1] - (p1[1] - p0[1]) * -t1[0]) / det;
    const c = [p0[0] + k * t0[0], p0[1] + k * t0[1]];
    d += (i ? '' : `M${p0[0]} ${p0[1]}`) + ` Q${c[0]} ${c[1]} ${p1[0]} ${p1[1]}`;
  }
  return d + ' Z';
}
// exactly lbQuadSeam's content and size: an 8-segment quad ellipse at 40x40,
// where the AA rim is a large fraction of the shape. The earlier stand-ins (a
// 200px blob, an SVG <ellipse> that lifts to the kind-7 SDF) both missed it.
// SEP: two arcs SEPARATED by straight edges — crescents exist but none is
// adjacent to another. Discriminates "adjacent crescents overlap" from "any
// crescent over-covers".
const SEP =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
  '<path fill="#3060c0" d="M12 8 L28 8 Q36 8 36 20 L36 22 Q36 32 28 32 L12 32 Q4 32 4 22 L4 20 Q4 8 12 8 Z"/></svg>';
const MULTI =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">` +
  `<path fill="#3060c0" d="${quadEllipse(20, 20, 17, 11)}"/></svg>`;

const SIZE = Number(process.env.SEAM_SIZE || 200);
const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = ${SIZE};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
// COUNT GL DRAWS — but note what that does and does NOT prove. bundle._unifiedFill
// is set when the vertex CACHE is built, several lines before the draw, so it says
// nothing about which route produced the pixels; loopBlinnRouteCount is bumped by
// every LB route, so it can't tell them apart either. And a draw count of 1 does
// NOT identify the unified route: the classic COMBINED route (_drawBundleLoopBlinn)
// also paints a solid bundle in exactly one drawArrays. Only
// debugStats.unifiedFillDraws, bumped at the unified drawArrays itself, does.
let draws = 0;
for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
  const orig = gl[m].bind(gl);
  gl[m] = (...a) => { draws++; return orig(...a); };
}
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const read = () => { const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };

async function shoot(svg, opts, lb) {
  const r = createRenderer(gl, shaders, opts);
  const b = createBundle(gl, await importSvg(svg));
  r.setLoopBlinnFill(lb);
  try { r.prepareBundle(b); } catch {}
  if (lb !== 'off' && r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  const frame = () => { r.setViewport(S, S); r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame(); };
  frame();                 // warm (build may still be settling)
  draws = 0; frame();
  const nDraws = draws;
  const px = read();
  const st = r.debugStats || {};
  // _unifiedFill is created ONLY by the unified route. loopBlinnRouteCount is
  // incremented by every LB route, so it cannot tell the paths apart — without
  // this the test can pass while measuring the route it is not testing.
  try { b.dispose(); } catch {}
  return { px, lb: (st.loopBlinnRouteCount | 0) + (st.loopBlinnMorphRouteCount | 0),
           nDraws, uni: st.unifiedFillDraws | 0 };
}

// Signed bias over the BOUNDARY BAND only — the partial-coverage pixels, where
// Slug is neither empty nor solid. Averaging over every ink pixel instead washes
// a boundary-only error out completely: an interior of thousands of exact pixels
// buries a one-pixel rim, and that is how the first version of this test read
// 0.0000 on a shape lbQuadSeam scores at 0.1352.
const bias = (a, b) => {
  // Coverage is the pixel value divided by the SOLID fill value, not by 255 —
  // #3060c0 averages 112, so testing "< 249" called every filled pixel partial
  // and the band swallowed the whole shape (11786 of 11582 ink px).
  let full = 0;
  for (let i = 0; i < S * S; i++) { const v = (a[i * 4] + a[i * 4 + 1] + a[i * 4 + 2]) / 3; if (v > full) full = v; }
  full = Math.max(full, 1);
  let sum = 0, n = 0, ink = 0, worst = 0, maxPos = 0, maxNeg = 0;
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    const ca = (a[o] + a[o + 1] + a[o + 2]) / 3 / full, cb = (b[o] + b[o + 1] + b[o + 2]) / 3 / full;
    if (ca > 0.03) ink++;
    if (ca > 0.03 && ca < 0.97) {                // Slug's AA rim, in COVERAGE units
      const d = cb - ca; sum += d; n++;
      if (Math.abs(d) > Math.abs(worst)) worst = d;
      if (d > maxPos) maxPos = d;              // OVER-coverage only
      if (d < maxNeg) maxNeg = d;              // UNDER-coverage only
    }
  }
  return { bias: n ? +(sum / n).toFixed(4) : 0, band: n, worst: +worst.toFixed(3),
           maxPos: +maxPos.toFixed(3), maxNeg: +maxNeg.toFixed(3), ink };
};

const out = {};
for (const [name, svg] of [['lone', ${JSON.stringify(LONE)}], ['multi', ${JSON.stringify(MULTI)}], ['sep', ${JSON.stringify(SEP)}]]) {
  const slug = await shoot(svg, { aacFill: false }, 'off');
  const uni  = await shoot(svg, { aacFill: false, fillDefines: ['MANTLE_LB_FILL'] }, 'on');
  const r = bias(slug.px, uni.px);
  out[name] = { bias: r.bias, maxPos: r.maxPos, maxNeg: r.maxNeg, band: r.band, ink: r.ink,
                draws: uni.nDraws, uni: uni.uni };
}
window.out = out;
</script></body></html>`;

const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    res.writeHead(200, { 'content-type': mime(u.pathname) + '; charset=utf-8' });
    res.end(b);
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 180000,
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error') logs.push(m.text());
});
page.on('pageerror', (e) => logs.push(String(e.message)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
try {
  await page.waitForFunction('typeof window.out !== "undefined"', {
    timeout: 120000,
    polling: 100,
  });
} catch {
  console.log('  page never finished:\n    ' + (logs.join('\n    ') || '(none)'));
  await browser.close();
  server.close();
  process.exit(1);
}
const r = await page.evaluate(() => window.out);
await browser.close();
server.close();

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
console.log(`  ${JSON.stringify(r)}`);
ok(
  r.lone.ink > 300 && r.multi.ink > 300,
  `both shapes rendered (${r.lone.ink} / ${r.multi.ink} px)`,
);
ok(
  r.lone.draws === 1 && r.multi.draws === 1 && r.sep.draws === 1,
  `all three drew in ONE GL call (lone ${r.lone.draws}, multi ${r.multi.draws}, sep ${r.sep.draws})`,
);
ok(
  r.lone.uni > 0 && r.multi.uni > 0 && r.sep.uni > 0,
  `and it is the unified route (unifiedFillDraws ${r.lone.uni} / ${r.multi.uni} / ${r.sep.uni})`,
);
ok(
  Math.abs(r.lone.bias) < 0.02,
  `LONE crescent (no shared seam) matches Slug under OVER (bias ${r.lone.bias})`,
);
// The DEFECT is a worst-case at seam pixels, not a shifted mean — it is local,
// so a mean over the rim understates it ~60x (0.0022 vs 0.137 at 40px).
const SEAM_TOL = 0.2; // LB curve-AA vs Slug on adjacent quad arcs — not a route defect
// Assert the OVER-coverage specifically. maxPos is the defect; maxNeg is the
// ordinary LB-vs-Slug AA difference and is not what this test is about.
ok(
  r.multi.maxPos < SEAM_TOL,
  `adjacent-arc rim delta ${r.multi.maxPos} (tol ${SEAM_TOL} — LB curve AA, identical under both routes)`,
);
ok(
  r.lone.band > 40 && r.multi.band > 40,
  `the band is a real rim, not the whole shape (${r.lone.band} / ${r.multi.band} px vs ${r.lone.ink} / ${r.multi.ink} ink)`,
);

console.log(
  `\nlbSeamPartitionSmoke: ${fail ? 'FAIL' : 'PASS'} — unified-route rim accuracy at ${SIZE}px;` +
    ` adjacent-arc delta ${r.multi.maxPos}, lone ${r.lone.maxPos}, separated ${r.sep.maxPos}`,
);
process.exit(fail ? 1 : 0);
