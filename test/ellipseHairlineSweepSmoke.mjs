// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Broad sweep guarding against a vertical center hairline through
// ellipseContour circles, across configurations:
//
//   - world-matrix scale / translate (joint position in pixel space)
//   - non-square canvas / non-square globalBBox (aspect-ratio scaling)
//   - off-center circles (cx, cy != canvas center)
//   - non-uniform ellipse (rx != ry)
//   - wide size sweep
//
// Detection: scan the center column (column nearest x=cx in pixel
// space) for rows visibly darker than the 2-px side neighbors.
//
// CENTER COLUMN (second page). The 4-segment cubic approximation lands its top and bottom apex
// vertices on x=cx (the center column), where the coverage H-walker can mis-count the crossing at
// the shared-endpoint vertex. A circle is rendered at sizes the sweep's base cases skip (157, 241,
// 300, 400, 599 among them: the hairline appears at widths where (canvas_w / em_w) places the center
// column on an exact pixel center, typically odd widths) and the center column is read against the
// column 2 px to its left. It runs twice:
//   - ellipseContour, the scene API's own ellipse emitter;
//   - the canonical 4-cubic fan (cardinal-point joints at (cx±rx,cy) and (cx,cy±ry)) authored
//     directly through the cubic-segment scene API, so it exercises the renderer rather than the
//     emitter: a pass means the renderer is robust to shared-vertex apex joints.
// A size fails when more than 3 interior rows of the center column are visibly darker than the side.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'ellipse-hairline-sweep');
mkdirSync(OUT, { recursive: true });

// Test cases — each independently rendered and inspected.
const CASES = [
  // Dense size sweep at canvas origin, identity world matrix.
  ...[...Array(50).keys()].map((i) => ({
    name: `base-${50 + i * 5}`,
    w: 50 + i * 5,
    h: 50 + i * 5,
    cx: 50,
    cy: 50,
    rx: 50,
    ry: 50,
    worldM: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    bboxW: 100,
    bboxH: 100,
  })),
  // World matrix scale (joint x in pixel space shifts by sx).
  ...[1.0, 1.2, 1.5, 1.7, 1.9, 2.0, 2.3, 2.7, 3.0].map((sx) => ({
    name: `worldscale-sx${sx.toFixed(1)}`,
    w: 200,
    h: 200,
    cx: 50,
    cy: 50,
    rx: 50 / sx,
    ry: 50 / sx,
    worldM: [sx, 0, 0, 0, sx, 0, 0, 0, 1],
    bboxW: 100,
    bboxH: 100,
  })),
  // World matrix translate.
  ...[-30, -15, -7, 0, 7, 15, 30].map((tx) => ({
    name: `worldtrans-tx${tx}`,
    w: 200,
    h: 200,
    cx: 50,
    cy: 50,
    rx: 50,
    ry: 50,
    worldM: [1, 0, 0, 0, 1, 0, tx, 0, 1],
    bboxW: 100,
    bboxH: 100,
  })),
  // Non-square canvas (200x100, 100x200, 300x150, 150x300).
  ...[
    [200, 100],
    [100, 200],
    [300, 150],
    [150, 300],
    [400, 100],
    [100, 400],
  ].map(([w, h]) => ({
    name: `canvas-${w}x${h}`,
    w,
    h,
    cx: 50,
    cy: 50,
    rx: 50,
    ry: 50,
    worldM: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    bboxW: 100,
    bboxH: 100,
  })),
  // Off-center circle (canvas center at 100,100, circle center offset).
  ...[
    [25, 50],
    [75, 50],
    [50, 25],
    [50, 75],
    [33, 67],
    [66, 33],
    [75, 75],
    [25, 25],
  ].map(([cx, cy]) => ({
    name: `offcenter-cx${cx}-cy${cy}`,
    w: 200,
    h: 200,
    cx,
    cy,
    rx: 20,
    ry: 20,
    worldM: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    bboxW: 100,
    bboxH: 100,
  })),
  // Non-uniform ellipse (rx != ry).
  ...[
    [50, 30],
    [30, 50],
    [70, 20],
    [20, 70],
    [50, 25],
  ].map(([rx, ry]) => ({
    name: `ellipse-rx${rx}-ry${ry}`,
    w: 200,
    h: 200,
    cx: 50,
    cy: 50,
    rx,
    ry,
    worldM: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    bboxW: 100,
    bboxH: 100,
  })),
];

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="400" height="400"></canvas>
<script type="module">
import {
  createScene, sceneToBundle, ellipseContour,
  createBundle, createRenderer, loadShaders,
} from '/src/index.js';

const CASES = ${JSON.stringify(CASES)};
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', {
  stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true,
});
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);

const results = {};
for (const cs of CASES) {
  cnv.width = cs.w;
  cnv.height = cs.h;
  const scene = createScene();
  scene.root.shapes.push({
    contours: [ellipseContour(cs.cx, cs.cy, cs.rx, cs.ry)],
    fill: { kind: 'solid', color: [1, 0, 0, 1] },
  });
  const sections = await sceneToBundle(scene);
  const bundle = createBundle(gl, sections);
  renderer.setViewport(cs.w, cs.h);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(bundle, { worldMatrix: new Float32Array(cs.worldM) });
  renderer.endFrame();

  // Apply the world transform + arScale + viewBox mapping to find
  // the pixel column where x=cx maps to. For this smoke the shapes
  // produce their own viewBox (sceneToBundle auto-computes globalBBox
  // from shape geometry — for a single ellipseContour it's the
  // ellipse's tight bbox). After arScale the center of the geometry
  // bbox maps to canvas center. Simpler: scan the WHOLE canvas for
  // any vertical streak of dark pixels with bright pixels on both
  // sides.
  const w = cs.w, h = cs.h;
  // Build per-row R channel.
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  // Per-column count of "interior" rows (R > 200).
  // A hairline column is one where the per-row R is < neighbors' R
  // by >20 on most rows.
  const hairlineCols = [];
  // Skip columns within 1px of canvas edge (no neighbors).
  for (let x = 2; x < w - 2; x++) {
    let badRows = 0;
    let interiorRows = 0;
    for (let y = 0; y < h; y++) {
      const cR  = buf[(y * w + x)     * 4];
      const lR  = buf[(y * w + x - 2) * 4];
      const rR  = buf[(y * w + x + 2) * 4];
      // Both neighbors must be "deep interior" for this row to count.
      if (lR > 200 && rR > 200) {
        interiorRows++;
        if (cR < Math.min(lR, rR) - 20) badRows++;
      }
    }
    if (interiorRows > 5 && badRows > interiorRows * 0.5) {
      hairlineCols.push({ x, badRows, interiorRows });
    }
  }
  results[cs.name] = {
    canvasW: w, canvasH: h,
    hairlineCols,
    pngDataUrl: cnv.toDataURL('image/png'),
  };
  bundle.dispose();
}
window.__result = results;
window.__done = true;
</script>
</body></html>`;

// Center-column sizes: odd and even canvas widths.
const CENTER_SIZES = [50, 100, 150, 157, 200, 241, 250, 300, 400, 599];

const CENTER_HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="400" height="400"></canvas>
<script type="module">
import {
  createScene, sceneToBundle, ellipseContour,
  createBundle, createRenderer, loadShaders,
} from '/src/index.js';

const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);

// The exact 4-cubic ellipse fan.
const K = 0.5522847498307936;
function fourCubicEllipseContour(cx, cy, rx, ry) {
  const Kx = rx * K, Ky = ry * K;
  return {
    segments: [
      { p0: [cx + rx, cy     ], p1: [cx + rx, cy + Ky], p2: [cx + Kx, cy + ry] },
      { p0: [cx,      cy + ry], p1: [cx - Kx, cy + ry], p2: [cx - rx, cy + Ky] },
      { p0: [cx - rx, cy     ], p1: [cx - rx, cy - Ky], p2: [cx - Kx, cy - ry] },
      { p0: [cx,      cy - ry], p1: [cx + Kx, cy - ry], p2: [cx + rx, cy - Ky] },
    ],
    closed: true,
  };
}
const CONTOURS = { ellipse: ellipseContour, fourCubic: fourCubicEllipseContour };

const sizes = ${JSON.stringify(CENTER_SIZES)};
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
const results = {};
for (const kind of Object.keys(CONTOURS)) {
  results[kind] = {};
  for (const px of sizes) {
    cnv.width = px;
    cnv.height = px;
    const scene = createScene();
    scene.root.shapes.push({
      contours: [CONTOURS[kind](50, 50, 50, 50)],
      fill: { kind: 'solid', color: [1, 0, 0, 1] },
    });
    const sections = await sceneToBundle(scene);
    const bundle = createBundle(gl, sections);
    renderer.setViewport(px, px);
    renderer.beginFrame([0, 0, 0, 1]);
    renderer.drawBundle(bundle, { worldMatrix: id });
    renderer.endFrame();
    // Read the CENTER COLUMN — if a hairline exists it shows as
    // black/dark pixels along x = px/2 with red on either side.
    const w = px, h = px;
    const colX = w >> 1;
    const pxBuf = new Uint8Array(4);
    const colRs = [];     // R value at each y of center column
    const sideRs = [];    // R value at colX - 2 (just left of column)
    for (let y = 0; y < h; y++) {
      gl.readPixels(colX,     y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pxBuf); colRs.push(pxBuf[0]);
      gl.readPixels(colX - 2, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pxBuf); sideRs.push(pxBuf[0]);
    }
    // Count rows where center is visibly DARKER than the side (hairline).
    // Threshold: side > 200 (deep inside the disk) AND center < side - 20.
    let darkerRows = 0;
    const darkerY = [];
    for (let y = 0; y < h; y++) {
      if (sideRs[y] > 200 && colRs[y] < sideRs[y] - 20) {
        darkerRows++;
        if (darkerY.length < 5) darkerY.push({ y, col: colRs[y], side: sideRs[y] });
      }
    }
    results[kind][px] = {
      interiorRows: sideRs.filter(v => v > 200).length,
      centerDarkerRows: darkerRows,
      sample: darkerY,
      pngDataUrl: cnv.toDataURL('image/png'),
    };
    bundle.dispose();
  }
}
window.__result = results;
window.__done = true;
</script>
</body></html>`;

// What the center-column page reports for each builder: where its PNGs go and its verdict lines.
const CENTER_RUNS = [
  {
    kind: 'ellipse',
    out: path.join(__dirname, 'visuals', 'ellipse-hairline'),
    png: (px) => `ellipse-${px}.png`,
    failMsg: 'FAIL: center hairline detected (center column pixels darker than +/-2 px sides)',
    passMsg: 'PASS: no center hairline at any tested size',
  },
  {
    kind: 'fourCubic',
    out: path.join(__dirname, 'visuals', 'four-cubic-ellipse'),
    png: (px) => `4cubic-${px}.png`,
    failMsg: 'FAIL: 4-cubic ellipse center hairline detected',
    passMsg: 'PASS: 4-cubic ellipse renders clean (renderer robust to shared-vertex apex)',
  },
];
for (const run of CENTER_RUNS) mkdirSync(run.out, { recursive: true });

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  if (u.pathname === '/center') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(CENTER_HTML);
    return;
  }
  let p = decodeURIComponent(u.pathname);
  const mime =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.error('  [console-err]', msg.text());
});
await page.setViewport({ width: 500, height: 500 });
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__done === true, {
  timeout: pageTimeoutFor(180000),
  polling: 100,
});
const results = await page.evaluate(() => window.__result);
await page.close();

const centerPage = await browser.newPage();
centerPage.on('pageerror', (e) => console.error('  [page-err]', e.message));
await centerPage.setViewport({ width: 500, height: 500 });
await centerPage.goto(url + 'center', { waitUntil: 'load', timeout: pageTimeoutFor() });
await centerPage.waitForFunction(() => window.__done === true, {
  timeout: pageTimeoutFor(),
  polling: 100,
});
const centerResults = await centerPage.evaluate(() => window.__result);
await browser.close();
server.close();

let anyHairline = false;
let totalCases = 0;
let cleanCases = 0;
for (const name of Object.keys(results)) {
  totalCases++;
  const r = results[name];
  // Always write PNGs so the user can visually verify.
  if (r.pngDataUrl) {
    writeFileSync(
      path.join(OUT, name + '.png'),
      Buffer.from(r.pngDataUrl.slice('data:image/png;base64,'.length), 'base64'),
    );
  }
  if (r.hairlineCols.length > 0) {
    anyHairline = true;
    console.error(
      `FAIL ${name} (canvas=${r.canvasW}x${r.canvasH}): hairline at columns ${JSON.stringify(r.hairlineCols)}`,
    );
  } else {
    cleanCases++;
  }
}
console.log(`\n${cleanCases}/${totalCases} clean`);
if (anyHairline) console.error(`\nELLIPSE-HAIRLINE-SWEEP FAIL`);
else console.log(`\nELLIPSE-HAIRLINE-SWEEP PASS`);

// Center column, per builder: more than 3 darker rows at any size is a hairline.
let anyCenterHairline = false;
for (const run of CENTER_RUNS) {
  const res = centerResults[run.kind];
  let hairline = false;
  for (const px of CENTER_SIZES) {
    const r = res[px];
    const pct = r.interiorRows > 0 ? ((100 * r.centerDarkerRows) / r.interiorRows).toFixed(1) : '0';
    console.log(
      `size=${String(px).padStart(3)}: interior=${r.interiorRows}, center-darker=${r.centerDarkerRows} (${pct}%) ${r.sample.length ? 'first: ' + JSON.stringify(r.sample[0]) : ''}`,
    );
    if (r.pngDataUrl) {
      writeFileSync(
        path.join(run.out, run.png(px)),
        Buffer.from(r.pngDataUrl.slice('data:image/png;base64,'.length), 'base64'),
      );
    }
    if (r.centerDarkerRows > 3) hairline = true;
  }
  console.log(`PNGs saved to ${run.out}`);
  if (hairline) {
    anyCenterHairline = true;
    console.error(run.failMsg);
  } else console.log(run.passMsg);
}
if (anyHairline || anyCenterHairline) process.exit(1);
