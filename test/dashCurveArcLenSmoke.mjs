// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verifies the renderer dashes curves by TRUE arc length, not chord.
// _dash_cubic.svg is a cubic whose arc length (320) is exactly 2× its
// chord (160), dasharray "16 16": true arc length → 10 dash cycles,
// chord → 5. Walks the curve in arc-length space, sampling the center
// of each dash (must be stroke) and gap (must be backdrop); chord
// dashing inverts the mid-curve dash/gap centers.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { _segLenInvert, segArcLen } from '../src/svg/textures.js';
import * as T from '../src/svg/textures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const seg = { type: T.SEG_CUBIC ?? 2, p1: [20, 180], p2: [20, 20], p3: [180, 20], p4: [180, 180] };
const total = segArcLen(seg); // 320
const evalC = (s, t) => {
  // cubic Bézier point at t
  const u = 1 - t;
  const b0 = u * u * u,
    b1 = 3 * u * u * t,
    b2 = 3 * u * t * t,
    b3 = t * t * t;
  return [
    b0 * s.p1[0] + b1 * s.p2[0] + b2 * s.p3[0] + b3 * s.p4[0],
    b0 * s.p1[1] + b1 * s.p2[1] + b2 * s.p3[1] + b3 * s.p4[1],
  ];
};
// Sample points: dash centers (covered) + gap centers (gap), arc-length k*32+{8,24},
// for k=1..8 (skip the cap-affected ends).
const probes = [];
for (let k = 1; k <= 8; k++) {
  for (const [off, covered] of [
    [8, true],
    [24, false],
  ]) {
    const s = k * 32 + off;
    if (s >= total) continue;
    const t = _segLenInvert(seg, s, total);
    probes.push({ s, covered, pt: evalC(seg, t) });
  }
}

// Native QUAD path: arch quad (true arc length 236.6 ≈ 1.48× its chord 160),
// dashed "16 16". Validates the native quad accumulator's closed-form dash
// gate (chord would shorten the spacing).
const qseg = { type: T.SEG_QUAD ?? 1, p1: [20, 180], p2: [100, 20], p3: [180, 180] };
const qtotal = segArcLen(qseg);
const evalQ = (s, t) => {
  const u = 1 - t,
    b0 = u * u,
    b1 = 2 * u * t,
    b2 = t * t;
  return [b0 * s.p1[0] + b1 * s.p2[0] + b2 * s.p3[0], b0 * s.p1[1] + b1 * s.p2[1] + b2 * s.p3[1]];
};
const qprobes = [];
for (let k = 1; k <= 6; k++) {
  for (const [off, covered] of [
    [8, true],
    [24, false],
  ]) {
    const s = k * 32 + off;
    if (s >= qtotal) continue;
    qprobes.push({ s, covered, pt: evalQ(qseg, _segLenInvert(qseg, s, qtotal)) });
  }
}

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (p.endsWith('.glsl')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try {
    res.writeHead(200, { 'content-type': mime(p) });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const fail = (m) => {
  failures++;
  console.error(`FAIL: ${m}`);
};
const ok = (m) => console.log(`ok ${m}`);

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 600, height: 600 });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));

await openReady(
  page,
  `http://127.0.0.1:${port}/mantleDemo.html?svg=${encodeURIComponent('/examples/_dash_cubic.svg')}`,
  { ready: 'demoSvg' },
);

const r = await page.evaluate((probes) => {
  const cnv = document.getElementById('glcanvas');
  const gl = window.__mantleGl,
    renderer = window.__mantleRenderer;
  if (!cnv || !gl || !renderer) return { err: 'no gl/renderer' };
  renderer.render();
  const w = cnv.width,
    h = cnv.height;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const VB = 200;
  const sample = (x, y) => {
    // 3×3 darkest, viewBox 0..200 → canvas
    const gx = Math.round((x / VB) * w),
      gy = h - 1 - Math.round((y / VB) * h);
    let dark = 255;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = gx + dx,
          yy = gy + dy;
        if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
        const o = (yy * w + xx) * 4;
        if (px[o + 3] > 128) dark = Math.min(dark, Math.max(px[o], px[o + 1], px[o + 2]));
      }
    return dark; // low = stroke(black), high = white bg
  };
  return { results: probes.map((p) => ({ ...p, dark: sample(p.pt[0], p.pt[1]) })) };
}, probes);

if (r.err) {
  fail(r.err);
} else {
  let cycles = 0;
  for (const p of r.results) {
    const isStroke = p.dark < 100;
    if (p.covered) {
      if (isStroke) cycles++;
      else
        fail(
          `dash center @arcLen ${p.s} should be STROKE (got brightness ${p.dark}) — chord dashing?`,
        );
    } else {
      if (isStroke)
        fail(
          `gap center @arcLen ${p.s} should be BACKDROP (got brightness ${p.dark}) — chord dashing?`,
        );
    }
  }
  if (failures === 0)
    ok(
      `dashed cubic: all ${r.results.length} arc-length dash/gap centers correct (${cycles} dash centers hit; true-arclength 2× the chord rate)`,
    );
}

// ---- Dashed native ARC (circle) — the renderer's arc band loop must gate
// dashes too. r=40 circumference 251, "10 10" → ~12-13 dash runs around the
// ring. Without the arc dash gate it draws a SOLID ring = 1 run. We walk the
// centerline by angle and count backdrop→stroke transitions.
{
  await openReady(
    page,
    `http://127.0.0.1:${port}/mantleDemo.html?svg=${encodeURIComponent('/examples/_dash_circle.svg')}`,
    { ready: 'demoSvg' },
  );
  const runs = await page.evaluate(() => {
    const cnv = document.getElementById('glcanvas');
    const gl = window.__mantleGl,
      renderer = window.__mantleRenderer;
    renderer.render();
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const VB = 100,
      cx = 50,
      cy = 50,
      r = 40;
    const strokeAt = (x, y) => {
      // 3×3 any-dark, viewBox 0..100
      const gx = Math.round((x / VB) * w),
        gy = h - 1 - Math.round((y / VB) * h);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = gx + dx,
            yy = gy + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const o = (yy * w + xx) * 4;
          if (px[o + 3] > 128 && px[o] < 100 && px[o + 1] < 100 && px[o + 2] < 100) return true;
        }
      return false;
    };
    const N = 720;
    const seq = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * 2 * Math.PI;
      seq.push(strokeAt(cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
    let transitions = 0;
    for (let i = 0; i < N; i++) if (seq[i] && !seq[(i + N - 1) % N]) transitions++; // bg→stroke edges = dash count
    return transitions;
  });
  // ~12-13 dashes expected; solid (un-gated) ring = 0 transitions (all stroke).
  if (runs >= 10 && runs <= 15)
    ok(`dashed circle (native arc): ${runs} dash runs around the ring (gated; solid would be 0)`);
  else
    fail(
      `dashed circle: ${runs} dash runs (expected ~12-13; 0 ⇒ arc dash gate missing → solid ring)`,
    );
}

// ---- Native dashed QUAD: same arc-length dash/gap-center check ----
{
  await openReady(
    page,
    `http://127.0.0.1:${port}/mantleDemo.html?svg=${encodeURIComponent('/examples/_dash_quad.svg')}`,
    { ready: 'demoSvg' },
  );
  const r = await page.evaluate((probes) => {
    const cnv = document.getElementById('glcanvas');
    const gl = window.__mantleGl,
      renderer = window.__mantleRenderer;
    renderer.render();
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const VB = 200;
    const sample = (x, y) => {
      const gx = Math.round((x / VB) * w),
        gy = h - 1 - Math.round((y / VB) * h);
      let dark = 255;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = gx + dx,
            yy = gy + dy;
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const o = (yy * w + xx) * 4;
          if (px[o + 3] > 128) dark = Math.min(dark, Math.max(px[o], px[o + 1], px[o + 2]));
        }
      return dark;
    };
    return { results: probes.map((p) => ({ ...p, dark: sample(p.pt[0], p.pt[1]) })) };
  }, qprobes);
  let qbad = 0;
  for (const p of r.results) {
    const isStroke = p.dark < 100;
    if (p.covered && !isStroke) {
      fail(`quad dash center @arcLen ${p.s} should be STROKE (got ${p.dark})`);
      qbad++;
    }
    if (!p.covered && isStroke) {
      fail(`quad gap center @arcLen ${p.s} should be BACKDROP (got ${p.dark})`);
      qbad++;
    }
  }
  if (!qbad)
    ok(
      `dashed native quad: all ${r.results.length} arc-length dash/gap centers correct (closed-form quad arc length)`,
    );
}

await browser.close();
server.close();
console.log(failures ? `\nDASH-CURVE-ARCLEN FAIL (${failures})` : '\nDASH-CURVE-ARCLEN PASS');
process.exit(failures ? 1 : 0);
