// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchMorphServeSmoke — under route:'cpatch' a MORPH draws with CPatch, and draws its pose exactly.
//
// morphDraw's cpatchServes serves morphs on CPatch, and this is what holds it: a planned pose must not
// draw blank, the planner must not run for minutes on imported coordinates, the posed layout must tile at
// interior t, and the GPU blend's first frame must not be stale.
//
// Two rings, each drawn by two CPatch renderers -- the GPU blend (cpatchOpts.gpuBlend, the default)
// and the CPU pack -- at t = 0.2, 0.45 and 0.7, the first of them being the first frame after the plan
// lands. For every frame:
//   - the morph draws with CPatch: the frame's own engine tally has cpatch draws and no Slug or LB
//     draws, and a plan landed (an object, not 'pending' or null);
//   - its pixels are within a small bar of the exact coverage of the pose. The pose is the per-point
//     lerp of the two SVGs' control points (the rings pair one to one), the em->pixel map is the
//     renderer's own (the morph bundle's globalBBox fitted through arScale), and every pixel that is
//     partial or disagrees with its center sample is supersampled 12 x 12 against nonzero winding --
//     the method of probes/morph/_morphExactRef.mjs, which validates the map by Slug reading 0 off.
//     The bar: at most 4 px off by more than 32/255 and none off by half a pixel or more.
// Nothing is compared against Loop-Blinn, which has its own open interior-t defect.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 256,
  TS = [0.2, 0.45, 0.7];
const BAR_32 = 4;
// Control points of the ring at t, rounded as the SVG text rounds them.
function ringPts(t, K, grow) {
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
    segs.push(
      [
        A,
        [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
        [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1],
        B,
      ].map((p) => p.map(f)),
    );
  }
  return segs;
}
const svgAt = (t, K, grow) => {
  const s = ringPts(t, K, grow);
  let d = `M${s[0][0][0]} ${s[0][0][1]}`;
  for (const c of s) d += ` C${c[1][0]} ${c[1][1]} ${c[2][0]} ${c[2][1]} ${c[3][0]} ${c[3][1]}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path fill="#123" d="${d} Z"/></svg>`;
};
// The six-cubic ring whose bow grows (non-affine, so a layout has to TILE at interior t) and
// the twelve-cubic ring that only scales (two constraint blocks, so the blend's second block is read).
const CASES = [
  { name: '6 cubics, bow grows', K: 6, grow: true },
  { name: '12 cubics, scale only', K: 12, grow: false },
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="g" width="${N}" height="${N}"></canvas><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
async function side(id, gpuBlend, src, dst) {
  const gl = document.getElementById(id).getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const R = createRenderer(gl, shaders, { cpatchFill: true, cpatchOpts: { gpuBlend }, aacFill: false, unifiedMorph: true });
  if (R.ready) await R.ready;
  const m = createShapeMorph(gl, createBundle(gl, await importSvg(src)), createBundle(gl, await importSvg(dst)));
  const bb = m.bundle || m;
  m.setT(0);
  // Until the plan lands (the planner's own bound is 5 s): a bundle not yet prepared has not ASKED.
  for (let i = 0; i < 600; i++) {
    if (R.prepareBundle) { try { R.prepareBundle(bb); } catch {} }
    const pl = bb._cpatchMorphPlan;
    if (pl !== undefined && pl !== 'pending') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return { gl, R, m, bb };
}
async function frame(s, t) {
  s.m.setT(t);
  let drew = {};
  for (let i = 0; i < 300; i++) {
    if (s.R.prepareBundle) { try { s.R.prepareBundle(s.bb); } catch {} }
    const before = Object.assign({}, (s.R.debugStats.engines || {}).draws || {});
    s.R.setViewport(${N}, ${N}); s.R.beginFrame([1, 1, 1, 1]); s.R.drawBundle(s.m); s.R.endFrame();
    if (s.R.precompileFills) { try { s.R.precompileFills(); } catch {} }
    const after = (s.R.debugStats.engines || {}).draws || {};
    drew = {};
    for (const k of Object.keys(after)) { const n = (after[k] | 0) - (before[k] | 0); if (n) drew[k] = n; }
    if (drew.cpatch) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const px = new Uint8Array(${N} * ${N} * 4);
  s.gl.readPixels(0, 0, ${N}, ${N}, s.gl.RGBA, s.gl.UNSIGNED_BYTE, px);
  const red = new Uint8Array(${N} * ${N});
  for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) red[y * ${N} + x] = px[((${N} - 1 - y) * ${N} + x) * 4];
  return { red: Array.from(red), drew };
}
window.__run = async (src, dst, ts) => {
  const G = await side('g', true, src, dst), C = await side('c', false, src, dst);
  const planOf = (s) => (s.bb._cpatchMorphPlan && typeof s.bb._cpatchMorphPlan === 'object') ? 'landed'
    : s.bb._cpatchMorphPlan === undefined ? 'never requested' : String(s.bb._cpatchMorphPlan);
  const out = [];
  for (const t of ts) {
    const g = await frame(G, t), c = await frame(C, t);
    out.push({ t, bbox: Array.from(G.bb.globalBBox || []), gpu: { ...g, plan: planOf(G), blend: !!G.bb._cpatchBlend },
               cpu: { ...c, plan: planOf(C), blend: !!C.bb._cpatchBlend } });
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

// ---- exact coverage of the pose, in the renderer's own pixel map ------------------------------------
function scorer(K, grow, t, bb) {
  const s0 = ringPts(0, K, grow),
    s1 = ringPts(1, K, grow);
  const segs = s0.map((sg, i) =>
    sg.map((p, k) => [p[0] + (s1[i][k][0] - p[0]) * t, p[1] + (s1[i][k][1] - p[1]) * t]),
  );
  const lines = [];
  for (const [a, b, c, d] of segs) {
    let px = a[0],
      py = a[1];
    for (let k = 1; k <= 400; k++) {
      const u = k / 400,
        v = 1 - u;
      const x = v * v * v * a[0] + 3 * v * v * u * b[0] + 3 * v * u * u * c[0] + u * u * u * d[0];
      const y = v * v * v * a[1] + 3 * v * v * u * b[1] + 3 * v * u * u * c[1] + u * u * u * d[1];
      lines.push([px, py, x, y]);
      px = x;
      py = y;
    }
  }
  // Nonzero winding by rows: a row's crossings (x, direction) are found once and every sample on the
  // row reads them, so the reference costs a scan per row rather than per sample.
  const rows = new Map();
  const rowAt = (y) => {
    let r = rows.get(y);
    if (r) return r;
    const xs = [];
    for (const [x0, y0, x1, y1] of lines) {
      if (y0 <= y === y1 <= y) continue;
      xs.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), y1 > y0 ? 1 : -1]);
    }
    xs.sort((p, q) => p[0] - q[0]);
    r = { xs: xs.map((c) => c[0]), after: new Int32Array(xs.length + 1) };
    for (let k = xs.length - 1; k >= 0; k--) r.after[k] = r.after[k + 1] + xs[k][1];
    rows.set(y, r);
    return r;
  };
  const inside = (x, y) => {
    const r = rowAt(y);
    let lo = 0,
      hi = r.xs.length; // first crossing to the right of x
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (r.xs[mid] > x) hi = mid;
      else lo = mid + 1;
    }
    return r.after[lo] !== 0;
  };
  // pixel (top-down) -> em: pixel = (plane * 0.5 + 0.5) * N, plane = (uv * 2 - 1) * ar, uv = (em - bb.xy) / bb.zw
  const sAR = bb[2] / bb[3];
  let ax = 1,
    ay = 1;
  if (sAR > 1) ay = 1 / sAR;
  else ax = sAR;
  const toEm = (px, py) => {
    const plx = (px / N) * 2 - 1,
      ply = (py / N) * 2 - 1;
    return [bb[0] + ((plx / ax + 1) / 2) * bb[2], bb[1] + ((ply / ay + 1) / 2) * bb[3]];
  };
  const INK = 0x11; // the fill's red channel, over a white clear
  return (red) => {
    let off32 = 0,
      wrong = 0,
      worst = 0;
    for (let i = 0; i < N * N; i++) {
      const x = i % N,
        y = (i / N) | 0;
      const [cx, cy] = toEm(x + 0.5, y + 0.5);
      const got = (255 - red[i]) / (255 - INK); // coverage the frame shows
      const center = inside(cx, cy);
      let cov = center ? 1 : 0;
      if ((got > 0.02 && got < 0.98) || center !== got > 0.5) {
        const SS = 12;
        let c = 0;
        for (let a = 0; a < SS; a++)
          for (let b = 0; b < SS; b++) {
            const [ex, ey] = toEm(x + (a + 0.5) / SS, y + (b + 0.5) / SS);
            if (inside(ex, ey)) c++;
          }
        cov = c / (SS * SS);
      }
      const e = Math.abs(got - cov) * (255 - INK);
      if (e > 32) off32++;
      if (e >= (255 - INK) / 2) wrong++;
      if (e > worst) worst = e;
    }
    return { off32, wrong, worst };
  };
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
  for (const C of CASES) {
    console.log(`  ${C.name}`);
    const res = await page.evaluate(
      (s, d, ts) => window.__run(s, d, ts),
      svgAt(0, C.K, C.grow),
      svgAt(1, C.K, C.grow),
      TS,
    );
    for (const r of res) {
      for (const [route, f] of [
        ['gpu blend', r.gpu],
        ['cpu pack', r.cpu],
      ]) {
        const tag = `${C.name}, ${route}, t=${r.t}`;
        const others = Object.keys(f.drew).filter((k) => k !== 'cpatch' && k !== 'stroke');
        if (f.plan !== 'landed') {
          fail(`${tag}: no plan (${f.plan})`);
          continue;
        }
        if (!(f.drew.cpatch > 0) || others.length) {
          fail(`${tag}: the frame drew ${JSON.stringify(f.drew)}, not CPatch alone`);
          continue;
        }
        if (f.blend !== (route === 'gpu blend')) {
          fail(`${tag}: the renderer ${f.blend ? 'used' : 'did not use'} the GPU blend`);
          continue;
        }
        const sc = scorer(C.K, C.grow, r.t, r.bbox)(f.red);
        console.log(
          `    ${tag}: ${sc.off32} px off the exact coverage by more than 32/255, ${sc.wrong} by half or more (worst ${sc.worst.toFixed(0)}/255)`,
        );
        if (sc.off32 <= BAR_32 && sc.wrong === 0)
          ok(`${tag}: draws with CPatch, within ${BAR_32} px of the exact pose`);
        else
          fail(
            `${tag}: ${sc.off32} px off the exact coverage by more than 32/255 (bar ${BAR_32}), ${sc.wrong} with the wrong verdict`,
          );
      }
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
  '\ncpatchMorphServeSmoke: a CPatch-route morph draws with CPatch, and draws its pose exactly',
);
