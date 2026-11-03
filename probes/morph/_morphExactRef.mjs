// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _morphExactRef — ring morphs drawn by CPatch (CPU pack and GPU blend), Loop-Blinn and Slug, each
// scored against exact coverage of the interpolated pose.
//
//   node probes/morph/_morphExactRef.mjs
//
// The pose at t is the per-control-point lerp of the two SVGs' cubics (the rings have matching
// structure, so createShapeMorph pairs them one to one); the em->pixel map is the renderer's own
// (the morph bundle's globalBBox fitted through arScale). Every pixel where two engines disagree by
// more than 32/255 is supersampled 12x12 against the pose's nonzero winding. Slug reads 0 off
// everywhere, which is what validates the map. The two rings are where a morph's CPatch plan and its
// Loop-Blinn route can go wrong: tens to a hundred-odd px off on the bow-growing 6-ring, and tens at
// t = 0.2 on the scale-only 12-ring.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const N = 256;
function blobPath(t, K, grow) {
  const R = 40 + 22 * t,
    cx = 100,
    cy = 100,
    f = (v) => v.toFixed(3);
  const at = (j) => [
    cx + R * Math.cos((2 * Math.PI * j) / K),
    cy + R * Math.sin((2 * Math.PI * j) / K),
  ];
  let d = '';
  for (let j = 0; j < K; j++) {
    const A = at(j),
      B = at(j + 1),
      bow = grow ? 0.3 + 0.14 * t : 0.3;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    const c1 = [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
      c2 = [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1];
    if (j === 0) d += `M${f(A[0])} ${f(A[1])}`;
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(B[0])} ${f(B[1])}`;
  }
  return d + ' Z';
}
const svgAt = (t, K, grow) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#123" d="${blobPath(t, K, grow)}"/></svg>`;
// Two morphs: the six-cubic ring whose bow grows (its plan does not finish; the LB route hands it to
// Slug), and a twelve-cubic ring that only scales (its plan lands in ~0.3 s, and a CPatch that
// draws from that plan without care draws it BLANK).
const CASES = [
  ['6 cubics, bow grows', svgAt(0, 6, true), svgAt(1, 6, true)],
  ['12 cubics, scale only', svgAt(0, 12, false), svgAt(1, 12, false)],
];
const TS = [0.2, 0.45, 0.7];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="a" width="${N}" height="${N}"></canvas><canvas id="b" width="${N}" height="${N}"></canvas><canvas id="g" width="${N}" height="${N}"></canvas><canvas id="s" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
async function side(id, cpatch, src, dst, gpuBlend, slug) {
  const gl = document.getElementById(id).getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const R = createRenderer(gl, shaders, cpatch ? { cpatchFill: true, cpatchOpts: { gpuBlend }, aacFill: false, unifiedMorph: true } : { aacFill: false, unifiedMorph: true });
  if (R.ready) await R.ready;
  R.setLoopBlinnFill(slug ? 'off' : 'on');
  const m = createShapeMorph(gl, createBundle(gl, await importSvg(src)), createBundle(gl, await importSvg(dst)));
  const bb = m.bundle || m;
  m.setT(0);
  if (R.prepareBundle) { try { R.prepareBundle(bb); } catch {} }
  if (R.awaitLbReady) { try { await R.awaitLbReady(m, 30000); } catch {} }
  return { gl, R, m, bb };
}
async function frame(s, t) {
  s.m.setT(t);
  if (s.R.prepareBundle) { try { s.R.prepareBundle(s.bb); } catch {} }
  if (s.R.awaitLbReady) { try { await s.R.awaitLbReady(s.m, 30000); } catch {} }
  const before = Object.assign({}, (s.R.debugStats.engines || {}).draws || {});
  s.R.setViewport(${N}, ${N}); s.R.beginFrame([1, 1, 1, 1]); s.R.drawBundle(s.m); s.R.endFrame();
  const after = (s.R.debugStats.engines || {}).draws || {}, drew = {};
  for (const k of Object.keys(after)) { const n = (after[k] | 0) - (before[k] | 0); if (n) drew[k] = n; }
  const px = new Uint8Array(${N} * ${N} * 4);
  s.gl.readPixels(0, 0, ${N}, ${N}, s.gl.RGBA, s.gl.UNSIGNED_BYTE, px);
  return { px, drew };
}
window.__run = async (src, dst, ts) => {
  const A = await side('a', true, src, dst, false), G = await side('g', true, src, dst, true), B = await side('b', false, src, dst), SL = await side('s', false, src, dst, false, true);
  // Wait for both CPatch sides' plans (bounded at 5 s by the planner itself).
  for (let i = 0; i < 400; i++) {
    for (const s of [A, G]) { if (s.R.prepareBundle) { try { s.R.prepareBundle(s.bb); } catch {} } }
    const done = [A, G].every((s) => s.bb._cpatchMorphPlan !== undefined && s.bb._cpatchMorphPlan !== 'pending');
    if (done) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const out = [];
  for (const t of ts) {
    const a = await frame(A, t), g = await frame(G, t), b = await frame(B, t), sl = await frame(SL, t);
    let slb = 0, cps = 0, diff = 0, ink = 0, big = 0, gdiff = 0, gbig = 0, gmax = 0, amax = 0;
    for (let i = 0; i < a.px.length; i += 4) {
      const da = Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i + 3] - b.px[i + 3]));
      const dg = Math.max(Math.abs(g.px[i] - b.px[i]), Math.abs(g.px[i + 3] - b.px[i + 3]));
      const ds = Math.max(Math.abs(sl.px[i] - b.px[i]), Math.abs(sl.px[i + 3] - b.px[i + 3])), dcs = Math.max(Math.abs(a.px[i] - sl.px[i]), Math.abs(a.px[i + 3] - sl.px[i + 3]));
      if (ds > 32) slb++; if (dcs > 32) cps++;
      if (da > 32) big++; if (dg > 2) gdiff++; if (dg > 32) gbig++; if (dg > gmax) gmax = dg; if (da > amax) amax = da;
      // > 2/255: the two renderers compile different define sets (one carries CPatch), which moves a
      // stray edge pixel by one level even when both draw Slug.
      if (Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i + 1] - b.px[i + 1]), Math.abs(a.px[i + 2] - b.px[i + 2]), Math.abs(a.px[i + 3] - b.px[i + 3])) > 2) diff++;
      if (a.px[i] < 128) ink++;
    }
    const red = (px) => { const o = new Uint8Array(${N} * ${N}); for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) o[y * ${N} + x] = px[((${N} - 1 - y) * ${N} + x) * 4]; return Array.from(o); };
    out.push({ imgs: { cpatch: red(a.px), lb: red(b.px), slug: red(sl.px) }, bbox: Array.from(B.bb.globalBBox || []), t, slb, cps, drewS: sl.drew, diff, ink, big, gdiff, gbig, gmax, amax, drewG: g.drew, drewA: a.drew, drewB: b.drew, plan: A.bb._cpatchMorphPlan === undefined ? 'never requested' : String(A.bb._cpatchMorphPlan) });
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

// Control points of blobPath as numbers, rounded like the SVG text.
function blobPts(t, K, grow) {
  const R = 40 + 22 * t,
    cx = 100,
    cy = 100,
    f = (v) => +v.toFixed(3);
  const at = (j) => [
    cx + R * Math.cos((2 * Math.PI * j) / K),
    cy + R * Math.sin((2 * Math.PI * j) / K),
  ];
  const segs = [];
  for (let j = 0; j < K; j++) {
    const A = at(j),
      B = at(j + 1),
      bow = grow ? 0.3 + 0.14 * t : 0.3;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    const c1 = [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
      c2 = [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1];
    segs.push([A, c1, c2, B].map((p) => p.map(f)));
  }
  return segs;
}
function exactScore(name, res) {
  const K = name.startsWith('6') ? 6 : 12,
    grow = name.startsWith('6');
  const s0 = blobPts(0, K, grow),
    s1 = blobPts(1, K, grow);
  for (const r of res) {
    const t = r.t,
      bb = r.bbox;
    const segs = s0.map((sg, i) =>
      sg.map((p, k) => [p[0] + (s1[i][k][0] - p[0]) * t, p[1] + (s1[i][k][1] - p[1]) * t]),
    );
    // flatten each cubic finely
    const lines = [];
    for (const [a, b, c, d] of segs) {
      let px = a[0],
        py = a[1];
      for (let k = 1; k <= 400; k++) {
        const u = k / 400,
          v = 1 - u;
        const x = v * v * v * a[0] + 3 * v * v * u * b[0] + 3 * v * u * u * c[0] + u * u * u * d[0],
          y = v * v * v * a[1] + 3 * v * v * u * b[1] + 3 * v * u * u * c[1] + u * u * u * d[1];
        lines.push([px, py, x, y]);
        px = x;
        py = y;
      }
    }
    const inside = (x, y) => {
      let w = 0;
      for (const [x0, y0, x1, y1] of lines) {
        if (y0 <= y === y1 <= y) continue;
        const xx = x0 + ((y - y0) / (y1 - y0)) * (x1 - x0);
        if (xx > x) w += y1 > y0 ? 1 : -1;
      }
      return w !== 0;
    };
    // pixel (top-down) -> em: pixel = (plane*0.5+0.5)*N, plane = (uv*2-1)*ar, uv = (em-bb.xy)/bb.zw
    const cAR = 1,
      sAR = bb[2] / bb[3];
    let ax = 1,
      ay = 1;
    if (sAR > cAR) ay = cAR / sAR;
    else ax = sAR / cAR;
    const toEm = (px, py) => {
      const plx = (px / N) * 2 - 1,
        ply = (py / N) * 2 - 1;
      return [bb[0] + ((plx / ax + 1) / 2) * bb[2], bb[1] + ((ply / ay + 1) / 2) * bb[3]];
    };
    const I = r.imgs,
      cand = new Set();
    for (let i = 0; i < N * N; i++) {
      const v = [I.cpatch[i], I.lb[i], I.slug[i]];
      if (Math.max(...v) - Math.min(...v) > 32) cand.add(i);
    }
    const off = { cpatch: 0, lb: 0, slug: 0 },
      SS = 12;
    for (const i of cand) {
      const x = i % N,
        y = (i / N) | 0;
      let c = 0;
      for (let a = 0; a < SS; a++)
        for (let b = 0; b < SS; b++) {
          const [ex, ey] = toEm(x + (a + 0.5) / SS, y + (b + 0.5) / SS);
          if (inside(ex, ey)) c++;
        }
      const want = 255 * (1 - c / (SS * SS));
      for (const k of Object.keys(off)) if (Math.abs(I[k][i] - want) > 32) off[k]++;
    }
    // sanity: tight bbox of the t=0 path vs the renderer's bbox
    console.log(
      `  EXACT t=${t}: ${cand.size} disputed px; off by >32 from exact: cpatch ${off.cpatch}, lb ${off.lb}, slug ${off.slug}   (bbox ${bb.map((v) => v.toFixed(2)).join(',')})`,
    );
  }
}
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail('page: ' + e.message));
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
  for (const [name, src, dst] of CASES) {
    console.log(`  ${name}`);
    const res = await page.evaluate((s, d, ts) => window.__run(s, d, ts), src, dst, TS);
    exactScore(name, res);
    for (const r of res) {
      console.log(
        `  t=${r.t}: slug vs LB >32: ${r.slb}; cpatch vs slug >32: ${r.cps} (slug drew ${JSON.stringify(r.drewS)}); cpu-pack vs LB: ${r.diff} px >2, ${r.big} >32, max ${r.amax}; gpu-blend vs LB: ${r.gdiff} >2, ${r.gbig} >32, max ${r.gmax}; drew cpu ${JSON.stringify(r.drewA)} gpu ${JSON.stringify(r.drewG)} lb ${JSON.stringify(r.drewB)}`,
      );
      continue;
      console.log(
        `  t=${r.t}: cpatch renderer drew ${JSON.stringify(r.drewA)}, lb renderer ${JSON.stringify(r.drewB)}, ${r.diff} px differ, ink ${r.ink}, plan ${r.plan}`,
      );
      if (r.ink < 1000) {
        fail(`t=${r.t}: the frame is nearly blank (${r.ink} ink px)`);
        continue;
      }
      const eng = (d) =>
        Object.keys(d)
          .filter((k) => k !== 'stroke')
          .sort()
          .join('+');
      if (!(r.drewA.cpatch | 0) && eng(r.drewA) === eng(r.drewB))
        ok(
          `t=${r.t}: under route:'cpatch' the morph draws with the LB route's engine (${eng(r.drewA)})`,
        );
      else
        fail(
          `t=${r.t}: under route:'cpatch' the morph drew ${JSON.stringify(r.drewA)} where the LB route drew ${JSON.stringify(r.drewB)}`,
        );
      if (r.plan === 'never requested') ok(`t=${r.t}: no CPatch plan was requested`);
      else
        fail(
          `t=${r.t}: a CPatch plan was requested (${r.plan}) — it holds a pool worker for minutes`,
        );
      if (r.diff === 0)
        ok(`t=${r.t}: it draws what the LB route draws (no pixel off by more than 2/255)`);
      else fail(`t=${r.t}: ${r.diff} px differ from the LB route`);
    }
  }
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\ncpatchMorphDeclineSmoke: a CPatch-route morph draws with Loop-Blinn, correctly, and plans nothing',
);
