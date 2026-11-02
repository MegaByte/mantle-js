// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Guards two Q/cubic stroke-join overshoot conditions:
//   * miter overshoot — the half-angle formula must use cosec-half, not
//     secant-half; otherwise near-collinear miter joins compute
//     miterLen≈∞, clamp to halfW*miterLimit, and a rectangular spike
//     sticks out perpendicular to the seg at gentle interior vertices.
//   * round/bevel-join overshoot — an interior join must not fall through
//     to the natural vertex distance (a full halfW-radius disc), which
//     leaks past the NEXT segment's free butt end when that segment is
//     shorter than halfW, producing a round bulge at the path's true end.
//
// Predicates: probe the spike / bulge regions (must be BACKDROP) and the
// curve body (must stay STROKE). Ground truth is rsvg-convert.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

// Render one repro and return a pixel sampler over its viewBox.
async function renderProbe(svgPath, viewBox) {
  const target = `http://127.0.0.1:${port}/mantleDemo.html?svg=${encodeURIComponent(svgPath)}`;
  await openReady(page, target, { ready: 'demoSvg' });
  return page.evaluate((VB) => {
    const cnv = document.getElementById('glcanvas');
    const gl = window.__mantleGl,
      renderer = window.__mantleRenderer;
    if (!cnv || !gl || !renderer) return { err: 'no gl/renderer' };
    renderer.render();
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const [VBx, VBy, VBw, VBh] = VB;
    const sample = (sx, sy) => {
      const gx = Math.round(((sx - VBx) / VBw) * w);
      const gy = h - 1 - Math.round(((sy - VBy) / VBh) * h); // gl bottom-up
      if (gx < 0 || gx >= w || gy < 0 || gy >= h) return [0, 0, 0, 0];
      const o = (gy * w + gx) * 4;
      return [px[o], px[o + 1], px[o + 2], px[o + 3]];
    };
    // Collect samples requested by the caller via a marker object.
    return { w, h, samples: window.__probePoints.map(([x, y]) => sample(x, y)) };
  }, viewBox);
}

// ---- Miter overshoot (examples/_miter_overshoot.svg) ----
// viewBox "240 380 100 50". Stroke #A87575. First interior vertex
// (268.382, 407.440); an overshoot spike would stick UP-LEFT ~24px.
// Probe points: body on the curve (STROKE), and spike region well
// outside the 6px halfW (must be BACKDROP).
{
  const VB = [240, 380, 100, 50];
  await page.evaluateOnNewDocument(() => {}); // noop hook slot
  await openReady(
    page,
    `http://127.0.0.1:${port}/mantleDemo.html?svg=${encodeURIComponent('/examples/_miter_overshoot.svg')}`,
    { ready: 'demoSvg' },
  );
  const r = await page.evaluate((VB) => {
    const cnv = document.getElementById('glcanvas');
    const gl = window.__mantleGl,
      renderer = window.__mantleRenderer;
    renderer.render();
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const [VBx, VBy, VBw, VBh] = VB;
    const sample = (sx, sy) => {
      const gx = Math.round(((sx - VBx) / VBw) * w);
      const gy = h - 1 - Math.round(((sy - VBy) / VBh) * h);
      if (gx < 0 || gx >= w || gy < 0 || gy >= h) return [0, 0, 0, 0];
      const o = (gy * w + gx) * 4;
      return [px[o], px[o + 1], px[o + 2], px[o + 3]];
    };
    const isStroke = (c) =>
      c[3] > 128 && c[0] > 120 && c[0] < 210 && c[1] > 80 && c[1] < 160 && c[0] > c[1] + 20;
    // Body on the first segment, near its midpoint (267.5, 410).
    const body = sample(267.5, 410.0);
    // The miter spike is a large block (~10% extra area). Single-point
    // probes are fragile because the curved arm legitimately passes near
    // the vertices, so total stroke area is the robust signal: anything
    // above the area threshold means a spike is present.
    let strokePx = 0;
    for (let i = 0; i < px.length; i += 4) {
      const c = [px[i], px[i + 1], px[i + 2], px[i + 3]];
      if (isStroke(c)) strokePx++;
    }
    return { bodyStroke: isStroke(body), strokePx };
  }, VB);
  if (r.bodyStroke) ok('miter: curve body is stroke');
  else fail('miter: body not stroke');
  // 63000 separates a smooth join from a spiked one at the 600px viewport.
  if (r.strokePx > 0 && r.strokePx < 63000)
    ok(`miter: no spike (stroke area ${r.strokePx} < 63000)`);
  else fail(`miter: spike present — stroke area ${r.strokePx} ≥ 63000`);
}

// ---- Round-join overshoot (examples/_join_overshoot.svg) ----
// viewBox "-30 -30 60 60". Stroke #000000. Path A (round joins, LEFT)
// has a short tail; an overshoot bulge would appear at the free end
// (visual TOP, SVG y is down so the last point y=-0.6 is highest).
// Path A's last point (-7.3, -0.6); the bulge would extend ~halfW above it.
{
  const VB = [-30, -30, 60, 60];
  await openReady(
    page,
    `http://127.0.0.1:${port}/mantleDemo.html?svg=${encodeURIComponent('/examples/_join_overshoot.svg')}`,
    { ready: 'demoSvg' },
  );
  const r = await page.evaluate((VB) => {
    const cnv = document.getElementById('glcanvas');
    const gl = window.__mantleGl,
      renderer = window.__mantleRenderer;
    renderer.render();
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const [VBx, VBy, VBw, VBh] = VB;
    const sample = (sx, sy) => {
      const gx = Math.round(((sx - VBx) / VBw) * w);
      const gy = h - 1 - Math.round(((sy - VBy) / VBh) * h);
      if (gx < 0 || gx >= w || gy < 0 || gy >= h) return [0, 0, 0, 0];
      const o = (gy * w + gx) * 4;
      return [px[o], px[o + 1], px[o + 2], px[o + 3]];
    };
    const isStroke = (c) => c[3] > 128 && c[0] < 80 && c[1] < 80 && c[2] < 80;
    const isBg = (c) =>
      Math.abs(c[0] - 204) < 30 && Math.abs(c[1] - 204) < 30 && Math.abs(c[2] - 204) < 30;
    // Body on path A near its end (last on-curve pts around (-7.7,0.2)).
    const body = sample(-7.9, 0.6);
    // Bulge region: past path A's true end (-7.3,-0.6), in the path's
    // forward direction (toward smaller y). Probe 3–6px BEYOND the end.
    // Forward tangent at end ≈ (0.45,-0.89). Points past the butt cap:
    const t = [0.447, -0.894];
    const beyond = [3, 5, 7].map((d) => sample(-7.3 + t[0] * d, -0.6 + t[1] * d));
    // Path B (MITER joins, x+20). Same short-tail geometry; its end is at
    // (12.7,-0.6) (=-7.3+20). The miter join's natural-distance disc can
    // bulge past the free butt end too — guard it the same way.
    const tB = [0.447, -0.894];
    const beyondB = [3, 5, 7].map((d) => sample(12.7 + tB[0] * d, -0.6 + tB[1] * d));
    return {
      bodyStroke: isStroke(body),
      beyondBg: beyond.map(isBg),
      beyondStroke: beyond.map(isStroke),
      beyondBBg: beyondB.map(isBg),
      beyondBStroke: beyondB.map(isStroke),
    };
  }, VB);
  if (r.bodyStroke) ok('round-join: path body is stroke');
  else fail('round-join: body not stroke');
  if (r.beyondBg.every(Boolean) && !r.beyondStroke.some(Boolean))
    ok('round-join: no bulge past free butt end (region is backdrop)');
  else
    fail(
      `round-join: bulge present — bg=${JSON.stringify(r.beyondBg)} stroke=${JSON.stringify(r.beyondStroke)}`,
    );
  if (r.beyondBBg.every(Boolean) && !r.beyondBStroke.some(Boolean))
    ok('miter-join: no bulge past short free butt end (region is backdrop)');
  else
    fail(
      `miter-join: bulge present — bg=${JSON.stringify(r.beyondBBg)} stroke=${JSON.stringify(r.beyondBStroke)}`,
    );
}

// ---- Inner bend must NOT notch ----
// examples/_qbend_round.svg — a long-segment Q S-curve with round
// joins/caps. The join clamp must NOT carve a notch at the interior bend.
{
  const VB = [-30, -30, 60, 60];
  await openReady(
    page,
    `http://127.0.0.1:${port}/mantleDemo.html?svg=${encodeURIComponent('/examples/_qbend_round.svg')}`,
    { ready: 'demoSvg' },
  );
  const r = await page.evaluate((VB) => {
    const cnv = document.getElementById('glcanvas');
    const gl = window.__mantleGl,
      renderer = window.__mantleRenderer;
    renderer.render();
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const [VBx, VBy, VBw, VBh] = VB;
    const sample = (sx, sy) => {
      const gx = Math.round(((sx - VBx) / VBw) * w);
      const gy = h - 1 - Math.round(((sy - VBy) / VBh) * h);
      if (gx < 0 || gx >= w || gy < 0 || gy >= h) return [0, 0, 0, 0];
      const o = (gy * w + gx) * 4;
      return [px[o], px[o + 1], px[o + 2], px[o + 3]];
    };
    const isStroke = (c) => c[3] > 128 && c[0] < 80 && c[1] < 80 && c[2] < 80;
    // The join vertex is at (-2,-2). Sample AT the vertex and just to the
    // inner side — must be solid stroke (no notch).
    return { atVertex: isStroke(sample(-2, -2)), nearVertex: isStroke(sample(-3, -1)) };
  }, VB);
  if (r.atVertex && r.nearVertex) ok('round-join: inner bend filled (no notch)');
  else fail(`round-join: NOTCH at inner bend — atVertex=${r.atVertex} nearVertex=${r.nearVertex}`);
}

// ---- Closed near-collinear MITER circle must stay smooth ----
// examples/_miter_circle.svg — a finely-tessellated Q circle, stroked
// with default (miter) joins. The tiny-angle miters must stay round, not
// spike into an octagon: the perpOther wedge clamp (with the cosec-half
// formula) keeps them round. Guard via the silhouette's max-radius /
// mean-radius ratio from its centroid: a smooth disc is ~1.50, a spiky
// octagon ~1.62.
{
  await openReady(
    page,
    `http://127.0.0.1:${port}/mantleDemo.html?svg=${encodeURIComponent('/examples/_miter_circle.svg')}`,
    { ready: 'demoSvg' },
  );
  const r = await page.evaluate(() => {
    const cnv = document.getElementById('glcanvas');
    const gl = window.__mantleGl,
      renderer = window.__mantleRenderer;
    renderer.render();
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0,
      sx = 0,
      sy = 0;
    const pts = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (px[i + 3] > 128 && px[i] < 80 && px[i + 1] < 80 && px[i + 2] < 80) {
          n++;
          sx += x;
          sy += y;
          pts.push([x, y]);
        }
      }
    if (!n) return { ratio: 0, n: 0 };
    sx /= n;
    sy /= n;
    let maxR = 0,
      sumR = 0;
    for (const [x, y] of pts) {
      const d = Math.hypot(x - sx, y - sy);
      if (d > maxR) maxR = d;
      sumR += d;
    }
    return { ratio: maxR / (sumR / n), n };
  });
  // Smooth disc ≈ 1.50; spiky octagon ≈ 1.62. 1.55 separates them.
  if (r.n > 0 && r.ratio < 1.55)
    ok(`miter circle: smooth (maxR/avgR ${r.ratio.toFixed(3)} < 1.55)`);
  else fail(`miter circle: SPIKY — maxR/avgR ${r.ratio.toFixed(3)} ≥ 1.55 (octagon)`);
}

// ---- Closed near-collinear ARCS-JOIN circle must stay smooth ----
// Twin of the miter check above, for stroke-linejoin:arcs. An SVG2 arcs join
// extends each edge as its osculating circle until they meet; with near-zero
// curvature that reduces to a miter, so the wedge must be bounded ALONG THE
// TANGENT by miterLen*cos(theta/2) exactly as a miter is. Unbounded it ran
// past every vertex on a tessellated curve: 144989 px / maxR-avgR 1.596,
// against 125380 / 1.503 for round and bevel on the same path.
{
  await openReady(
    page,
    `http://127.0.0.1:${port}/mantleDemo.html?svg=${encodeURIComponent('/examples/_arcs_circle.svg')}`,
    { ready: 'demoSvg' },
  );
  const rA = await page.evaluate(() => {
    const cnv = document.getElementById('glcanvas');
    const gl = window.__mantleGl,
      renderer = window.__mantleRenderer;
    renderer.render();
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0,
      sx = 0,
      sy = 0;
    const pts = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (px[i + 3] > 128 && px[i] < 80 && px[i + 1] < 80 && px[i + 2] < 80) {
          n++;
          sx += x;
          sy += y;
          pts.push([x, y]);
        }
      }
    if (!n) return { ratio: 0, n: 0 };
    sx /= n;
    sy /= n;
    let maxR = 0,
      sumR = 0;
    for (const [x, y] of pts) {
      const d = Math.hypot(x - sx, y - sy);
      if (d > maxR) maxR = d;
      sumR += d;
    }
    return { ratio: maxR / (sumR / n), n };
  });
  if (rA.n > 0 && rA.ratio < 1.55)
    ok(`arcs-join circle: smooth (maxR/avgR ${rA.ratio.toFixed(3)} < 1.55)`);
  else
    fail(
      `arcs-join circle: SPIKY — maxR/avgR ${rA.ratio.toFixed(3)} >= 1.55 (wedge unbounded past the vertex)`,
    );
}

await browser.close();
server.close();
if (failures === 0) console.log('\nSTROKE-CUBIC-OVERSHOOT PASS');
else console.log(`\nSTROKE-CUBIC-OVERSHOOT FAIL (${failures})`);
process.exit(failures ? 1 : 0);
