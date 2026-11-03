// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeDashSeamRenderSmoke -- the dash pattern runs through the seam of a closed dashed contour on the GPU. The float32 emulation proofs are
// test/strokeDashSeamSmoke.mjs; this renders closed dashed polygons with the real shader at 128 px (100-unit viewBox, white ground):
//   svg      the closed dashed document under test;
//   control  the same picture authored with simpler features: every dash its own open polyline (the dash that is on at both ends of the
//            contour ONE polyline through the seam), cut by the independent oracle (test/_strokeDashOracle.mjs dashClosed): the render must match it to
//            within `tol` (default 4/255);
//   old      the WRONG reading: the same dashes with the seam dash split in two (caps, not a join, at the seam vertex): the render must DIFFER
//            from svg by at least 48/255 somewhere.
// (`tol` 64 where the control's dash ends are path ends: a dash end is an SDF cut in one and a path end in the other, and 6/4 dashes at 0.78 px a unit differ by up to 58/255 at the ends.)
// MORPH (second page): a morph of a closed dashed contour draws the seam as the pose's own import does, on the CPU lerp and on the GPU lerp.
// A square -> quadrilateral morph (one closed dashed path, round caps, miter joins) is drawn at t = 0.3, 0.5 and 0.8 two ways -- the CPU lerp (createShapeMorph
// cpuLerp) and the GPU lerp with its fixup pass (gpuSmallPlanes forces it on this small plane: shapeMorph.js FIX_DASH writes each segment's startDist and, on the
// contour's first and last segment, its length -L) -- and compared with the STATIC bundle of that pose's geometry (the control points' lerp, exact for lines).
// HELD: both morph draws are within 6/255 of the static pose everywhere, and the picture is not blank.
// SMOKE_SRC_DIR=DIR/js.kontek.mantle/src runs the same cells against another tree's shaders and encoder.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as O from './_strokeDashOracle.mjs';
import * as C from './_strokeSeamCases.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.env.SMOKE_SRC_DIR || null;
const WHITE = [255, 255, 255],
  BLACK = [0, 0, 0];
const shape = (id) => C.shapes().find((s) => s.id === id);
const f = (v) => +v.toPrecision(12);
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="white"/>${body}</svg>`;

// a dash piece (polygon shapes only: straight segments) as an open polyline, or a closed ring
function pieceD(pc) {
  const pts = [];
  for (const g of pc.segs) {
    const a = O.ev(g.s, g.t0),
      b = O.ev(g.s, g.t1);
    if (!pts.length) pts.push(a);
    pts.push(b);
  }
  return `M${pts.map((p) => `${f(p[0])} ${f(p[1])}`).join(' L')}${pc.closed ? ' Z' : ''}`;
}
function cell(name, id, cap, join, dash, doff, probes, hw = 5, mode = 'chrome') {
  const sh = shape(id),
    c = { id, subs: sh.subs, hw, cap, join, ml: 4, dash, doff };
  const sp = O.wholeSubpaths(sh.subs)[0];
  const attrs = `fill="none" stroke="black" stroke-width="${2 * hw}" stroke-linecap="${cap}" stroke-linejoin="${join}" stroke-miterlimit="4"`;
  const merged = O.dashClosed(sp, dash, doff),
    pieces = mode === 'chrome' ? merged : O.dashSub(sp, dash, doff).filter((q) => !q.zero);
  const control = pieces.map((p) => `<path d="${pieceD(p)}" ${attrs}/>`).join('');
  // the picture the OTHER reading draws: for compat 'chrome' the seam dash split in two, for the spec default the merged seam dash (Chrome's)
  const split = [];
  if (mode === 'chrome') {
    for (const p of pieces) {
      const cut = p.segs.findIndex(
        (g, k) =>
          k > 0 &&
          p.segs[k - 1].t1 >= 1 &&
          g.t0 <= 0 &&
          Math.hypot(...O.sub(O.ev(g.s, 0), sh.subs[0].segs[0].p[0])) < 1e-9,
      );
      if (cut > 0) {
        split.push(
          { segs: p.segs.slice(0, cut), closed: false },
          { segs: p.segs.slice(cut), closed: false },
        );
      } else split.push(p);
    }
  } else split.push(...merged);
  const old = split.map((p) => `<path d="${pieceD(p)}" ${attrs}/>`).join('');
  return {
    name,
    compat: mode,
    svg: doc(
      `<path d="${C.dOfSubs(sh.subs)}" ${attrs} stroke-dasharray="${dash.join(' ')}" stroke-dashoffset="${doff}"/>`,
    ),
    control: doc(control),
    old: doc(old),
    probes,
  };
}
const L200 = [14, 10]; // the square's contour is 200 long: 200 mod 24 = 8, so with offset 0 the dash on at the end (8 of it) meets the one on at the start
const CELLS = [
  Object.assign(
    cell(
      'SPEC (the default): a square whose dash is on at both ends of the contour has TWO butt caps at the seam corner, not one joined dash',
      'square',
      'butt',
      'miter',
      L200,
      0,
      [
        [22, 22, WHITE, 1],
        [28, 28, BLACK, 1],
      ],
      5,
      'spec',
    ),
    { tol: 70 },
  ),
  cell(
    'a square, miter, the dash through the seam corner is ONE dash with a miter join',
    'square',
    'butt',
    'miter',
    L200,
    0,
    [
      [22, 22, BLACK, 1],
      [18, 18, WHITE, 1],
    ],
  ),
  Object.assign(
    cell(
      'a square, round cap, a seam in a gap draws neither a cap nor a join',
      'square',
      'round',
      'miter',
      [14, 10],
      16,
      [[22, 22, WHITE, 1]],
    ),
    { sameAsOld: true, tol: 64 },
  ),
  Object.assign(
    cell(
      'a triangle, round cap, miter join: a dash that starts at the apex seam is capped, not joined (the shader-only attempt made this row worse)',
      'tri',
      'round',
      'miter',
      [30, 20],
      10,
      [[50, 12, WHITE, 1]],
    ),
    { sameAsOld: true, tol: 64 },
  ),
  Object.assign(
    cell(
      'a triangle, butt cap, the dash passes through the apex seam with a miter tip',
      'tri',
      'butt',
      'miter',
      [6, 4],
      0,
      [[50, 12, BLACK, 1]],
    ),
    { tol: 64 },
  ),
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { paint, viewport } from '/test/_auditPaintCases.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__render = async (sources) => {
  viewport(gl, R); R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const out = [];
  for (const s of sources) {
    const b = createBundle(gl, await importSvg(s.svg, { preserveViewport: true, compat: s.compat }));
    out.push(Array.from(await paint(gl, R, b))); b.dispose();
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

// The morph page: a square -> quadrilateral morph of one closed dashed path, and the static import of each pose.
const morphCase = (() => {
  const SQUARE = [
      [25, 25],
      [75, 25],
      [75, 75],
      [25, 75],
    ],
    RECT = [
      [15, 35],
      [85, 30],
      [90, 65],
      [20, 70],
    ];
  const doc = (P) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="white"/>` +
    `<path d="M${P[0]} ${P.slice(1)
      .map((p) => `L${p}`)
      .join(
        ' ',
      )} Z" fill="none" stroke="black" stroke-width="8" stroke-linecap="round" stroke-linejoin="miter" stroke-dasharray="${14} ${11}" stroke-dashoffset="3"/></svg>`;
  const lerpP = (A, B, t) =>
    A.map((p, i) => [
      +(p[0] * (1 - t) + B[i][0] * t).toPrecision(12),
      +(p[1] * (1 - t) + B[i][1] * t).toPrecision(12),
    ]);
  const TS = [0.3, 0.5, 0.8];

  const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
  <script type="module">
  import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
  const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
  R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' }); R.setViewport(128, 128);
  async function frame(draw) {
    for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); draw(); R.endFrame(); await new Promise((r) => setTimeout(r, 20)); }
    const px = new Uint8Array(128 * 128 * 4); gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, px); return Array.from(px);
  }
  window.__run = async (srcSvg, dstSvg, poses, ts) => {
    const A = createBundle(gl, await importSvg(srcSvg, { preserveViewport: true, compat: 'chrome' })), B = createBundle(gl, await importSvg(dstSvg, { preserveViewport: true, compat: 'chrome' }));
    const out = { cpu: [], gpu: [], stat: [] };
    for (const mode of ['cpu', 'gpu']) {
      const m = createShapeMorph(gl, A, B, { cpuLerp: mode === 'cpu' });
      if (mode === 'gpu') m.bundle._morphSrc.gpuSmallPlanes = true;
      for (const t of ts) { m.setT(t); out[mode].push(await frame(() => R.drawBundle(m))); }
      m.dispose();
    }
    for (const s of poses) { const b = createBundle(gl, await importSvg(s, { preserveViewport: true, compat: 'chrome' })); out.stat.push(await frame(() => R.drawBundle(b))); b.dispose(); }
    A.dispose(); B.dispose();
    return out;
  };
  window.__ready = true;
  </script></body></html>`;
  return { HTML, SQUARE, RECT, doc, lerpP, TS };
})();

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    if (u === '/morph') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(morphCase.HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(
      readFileSync(
        SRC && p.startsWith('/src/') ? path.join(SRC, p.slice('/src/'.length)) : path.join(ROOT, p),
      ),
    );
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { launchBrowser } = await import('./_launch.mjs');
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const at = (px, x, y) => {
  const i = ((127 - Math.floor(y * 1.28)) * 128 + Math.floor(x * 1.28)) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const worstAt = (a, b) => {
  let m = 0,
    k = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) {
      m = d;
      k = i;
    }
  }
  const q = k >> 2;
  return `at px (${q % 128},${127 - (q >> 7)})`;
};
for (const c of CELLS) {
  let px;
  try {
    px = await page.evaluate(
      (s) => window.__render(s),
      [
        { svg: c.svg, compat: c.compat || 'chrome' },
        { svg: c.control, compat: 'spec' },
        { svg: c.old, compat: 'spec' },
      ],
    );
  } catch (e) {
    fail(c.name + ': ' + e.message);
    continue;
  }
  const [a, b, o] = px;
  const vsControl = maxDiff(a, b),
    vsOld = maxDiff(a, o);
  const bad = c.probes
    .filter(([x, y, want, tol]) => maxDiff(at(a, x, y), want) > tol)
    .map(([x, y, want]) => `(${x},${y}) is [${at(a, x, y)}], wanted [${want}]`);
  const line = `${c.name}: control maxByte ${vsControl}, old differs by ${vsOld}`;
  if (vsControl > (c.tol ?? 4)) fail(line + ` -- render differs from its control ${worstAt(a, b)}`);
  else if (vsOld < 48 && !c.sameAsOld)
    fail(line + " -- vacuous: the other reading's picture is the same");
  else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
  else ok(line);
}

// ---- a closed dashed contour morphs through its seam like a static import of each pose ----
{
  const { SQUARE, RECT, doc, lerpP, TS } = morphCase;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto('http://127.0.0.1:' + server.address().port + '/morph', {
    waitUntil: 'load',
    timeout: pageTimeoutFor(),
  });
  await page.waitForFunction(() => window.__ready === true, {
    timeout: pageTimeoutFor(),
    polling: 100,
  });
  const r = await page.evaluate(
    (a, b, p, t) => window.__run(a, b, p, t),
    doc(SQUARE),
    doc(RECT),
    TS.map((t) => doc(lerpP(SQUARE, RECT, t))),
    TS,
  );
  await page.close();
  const maxDiff = (a, b) => {
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
  };
  const ink = (px) => {
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] < 128) n++;
    return n;
  };
  TS.forEach((t, k) => {
    for (const mode of ['cpu', 'gpu']) {
      const d = maxDiff(r[mode][k], r.stat[k]),
        n = ink(r.stat[k]);
      const line = `t=${t} ${mode} lerp: max byte vs the static pose ${d} (ink ${n} px)`;
      if (!(n > 500) || d > 6) {
        failures++;
        console.error('FAIL: ' + line);
      } else console.log('ok ' + line);
    }
  });
}

await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  "\nstrokeDashSeamRenderSmoke: a closed dashed contour's seam renders as its already-correct control on the GPU",
);
