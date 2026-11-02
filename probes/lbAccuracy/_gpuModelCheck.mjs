// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _gpuModelCheck — THE FALSIFICATION TEST FOR THE CPU KERNEL MODEL.
//
// The LB antialiasing measurements in this folder use probes/lbAccuracy/_lbKernel.mjs, a CPU twin
// of _lbVertexSetup.glsl + _lbCoverage.glsl. A twin is only worth what its fidelity is worth: a twin
// that models a superseded term invalidates every measurement written against it (cpatchCov.js is
// the warning). So this renders the same assets on the GPU with Loop-Blinn PINNED and
// compares, per pixel, against what the model says the kernel will produce.
//
// THE CLAIM, and it is falsifiable:
//
//   On each asset below, rendered black-on-white at CANVAS px with the LB route pinned and the
//   engine ledger confirming LB drew it, the GPU's coverage agrees with the CPU model to
//
//       mean  <= 1.0/255      max <= 12/255      pixels off by more than 4/255  <= 0.5%
//
//   The tolerance is not zero and must not be: the model runs in float64 where the shader runs in
//   float32, the kernel's own epsilons (1e-4 border tests, 1e-9 clip guards, the 0.004 claim gate)
//   sit at those magnitudes, and a fragment on one of them can land either side. What the claim
//   rules out is a STRUCTURAL difference -- a branch the model takes and the kernel does not, a
//   varying read from the wrong slot, a discard in the wrong place -- because any of those move
//   whole runs of pixels by far more than 12/255.
//
//   IF IT FAILS, the twin's numbers are not evidence about the shader and have to be re-derived.
//   The failing asset and the worst pixel are printed so the divergent branch can be found: dump
//   the model's `F._hit` at that pixel (which kind painted it) and read that block of
//   _lbCoverage.glsl against _lbKernel.mjs.
//
// THE REAL FALSIFIER IS THE KNIFE-EDGE SET, and a tolerance in /255 is not it. A GPU snaps every
//   vertex to a fixed-point subpixel grid before it rasterizes, so a pixel center within that grid
//   of a triangle edge can land either side -- and it lands there by a whole FRAGMENT, which no
//   per-pixel tolerance can absorb. `fragileMask` (_lbRaster.mjs) names that set IN ADVANCE by
//   shifting the raster grid half a subpixel each way and keeping every pixel that moves. The claim
//   this probe states is the sharp one: OUTSIDE that set the model and the GPU agree, and a
//   disagreement outside it falsifies the model no matter how small.
//
// THE MODEL'S own FIT AND KERNEL ARE CHECKED: the model fits `bundle.globalBBox`, as the renderer does
//   (a CONTROL-POINT HULL fit is, on tiger, a 4.4% scale error plus a 21.8 em shift -- a different SIZE of
//   drawing compared pixel for pixel), and the twin has `arcCov`. See test/lbKernelTwinFidelitySmoke.mjs,
//   which checks both against the thing they model rather than against a second reading of it.
//
// WHAT CAN still DIFFER ON TIGER, shown by running the shader itself on the CPU (test/_lbPipeEmu.mjs,
//   probes/lbAccuracy/_twinVsPipeEmu.mjs):
//   * THE GPU DRAWS TIGER'S STROKES and the twin has no stroke model: at 256 px about 2,200 px of the frame are
//     stroke ink outside the fills. So the tiger row renders TIGER'S FILLS (every stroke set to none) on both arms.
//   * STROKE ROWS: a twin that meshes every row with curves paints a stroked path's interior twice and a
//     stroke-only path solid. The check asks shapesOf for the rows the fill pass meshes.
//   * KERNEL TERMS: the twin carries the ribbon gate (lbTangentTriDist) and the curve band's GL-frame dFdy in
//     its corner combine; with them, on tiger's fills the twin and the shader agree to 0.5/255 at 256 px.
//   * DERIVATIVES: the Bezout crescent (kind 4) differentiates its cofactor gradient across the 2x2 quad, and a GPU
//     picks fine (per row and column) or coarse (one per quad) differences. ANGLE on Metal takes FINE ones: on tiger's
//     fills at 256 px the readback matches the fine-derivative emulator to 1.6/255 outside the knife-edge set, and the
//     coarse one misses by 71 px (max 55.7/255, all on kind-4 pieces). So the twin takes fine derivatives by
//     default; TWIN_DERIV=coarse runs it the other way for a GPU that differs.
//
//   node probes/lbAccuracy/_gpuModelCheck.mjs           CANVAS=256 GPU=1 KEEP=1 [TWIN_DERIV=coarse] [DUMP=1]
// DUMP=1 writes each asset's GPU coverage to probes/_lbPipeOut/gpu_<asset>_<CANVAS>.json, which
// probes/lbAccuracy/_pipeEmuVsGpu.mjs holds against the whole-LB-pipeline emulator (no GPU needed there).
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import { launchBrowser } from '../../test/_launch.mjs';
import { viewOf, rasterMesh, shapesOf, buildMesh, fragileMask } from './_lbRaster.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CANVAS = +(process.env.CANVAS || 256);
const PX = 100 / CANVAS;

// ── the assets: the sub-pixel feature classes, sized in DEVICE pixels ─────────────────────────
// Two corner dots pin the content bbox, which is what the renderer fits, so a feature's size in
// pixels is set by CANVAS and nothing else.
const wrap = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
  `<rect x="0" y="0" width="0.02" height="0.02" fill="#000"/>` +
  `<rect x="99.98" y="99.98" width="0.02" height="0.02" fill="#000"/>${body}</svg>`;
const bars = (w, n) => {
  let b = '';
  for (let i = 0; i < n; i++) {
    const x = 10 + i * 4.37 * PX,
      y = 20,
      h = 6 * PX;
    b += `<path d="M${x} ${y} L${x + w * PX} ${y} L${x + w * PX} ${y + h} L${x} ${y + h} Z" fill="#000"/>`;
  }
  return b;
};
const squares = (s, n) => {
  let b = '';
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = 10 + i * 4.37 * PX,
        y = 20 + j * 4.37 * PX;
      b += `<path d="M${x} ${y} L${x + s * PX} ${y} L${x + s * PX} ${y + s * PX} L${x} ${y + s * PX} Z" fill="#000"/>`;
    }
  return b;
};
const diag = `<path d="M20 20 L80 35 L35 80 Z" fill="#000"/>`;
const ASSETS = {
  'bars 0.5px': wrap(bars(0.5, 20)),
  'bars 1.5px': wrap(bars(1.5, 20)),
  'squares 1.5px': wrap(squares(1.5, 8)),
  'squares 3px': wrap(squares(3, 8)),
  'triangle (control)': wrap(diag),
};
const TIGER = '../MantleSamples/Assets/Mantle/tiger.svg';
// THE FILLS only. The twin models the Loop-Blinn fill pass; the stroke rows are cover quads shaded by the stroke kernel,
// which it does not model, so a render with strokes compares the stroke kernel against nothing.
const noStrokes = (t) =>
  t.replace(/\bstroke="[^"]*"/g, 'stroke="none"').replace(/\bstroke\s*:\s*[^;"]+/g, 'stroke:none');
if (existsSync(path.resolve(ROOT, TIGER)))
  ASSETS['tiger (fills)'] = noStrokes(readFileSync(path.resolve(ROOT, TIGER), 'utf8'));
const TWIN_OPT = process.env.TWIN_DERIV === 'coarse' ? { coarseDeriv: true } : {};

// ── the model's prediction, per asset: a coverage buffer, both arms ──────────────────────────
console.warn = () => {};
/// The model's coverage for an SVG given as TEXT (loadSvg takes a path, so import importSvg here).
async function modelCover(svgText) {
  const xd = await import('@xmldom/xmldom');
  globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
  globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
  const { default: importSvg } = await import('../../src/svg/importer.js');
  const bundle = await importSvg(svgText);
  // THE BOX THE RENDERER FITS, not the control-point hull — shapesOf returns `bundle.globalBBox`,
  // which is what mantle.vert's uv divides by and what arScale turns into uCanvasAR. Fitting the
  // hull instead rendered tiger 4.4% smaller at a different origin and compared THAT to the GPU.
  const { shapes, bbox } = await shapesOf(bundle, { rows: 'fill' });
  const view = viewOf(bbox, CANVAS);
  const acc = new Float64Array(CANVAS * CANVAS).fill(1);
  let declined = 0;
  const pks = [];
  for (const sh of shapes) {
    const built = await buildMesh(sh);
    if (!built) {
      declined++;
      continue;
    }
    pks.push(built.pk);
    // Each shape paints its own coverage; they are all the same color here, so one OVER
    // accumulator over the whole drawing is exactly what the frame's alpha will be.
    rasterMesh(built.pk, view, acc, TWIN_OPT, null, null, null);
  }
  const cov = new Float64Array(CANVAS * CANVAS);
  for (let i = 0; i < cov.length; i++) cov[i] = 1 - acc[i];
  // The knife-edge set: pixels a GPU's subpixel snapping is ALLOWED to land either side of. Named
  // in advance, so a disagreement inside it is expected and one outside it falsifies the model.
  const fr = fragileMask(pks, view, undefined, TWIN_OPT);
  return { cov, declined, shapes: shapes.length, fragile: fr.mask, nFragile: fr.n };
}
const pred = {};
for (const [name, svg] of Object.entries(ASSETS)) {
  const a = await modelCover(svg);
  let inkA = 0;
  for (let i = 0; i < a.cov.length; i++) inkA += a.cov[i];
  pred[name] = { cov: a.cov, inkA, declined: a.declined, fragile: a.fragile, nFragile: a.nFragile };
  console.log(
    `PREDICTED ${name.padEnd(20)} shapes ${a.shapes} (declined ${a.declined})  ink ${inkA.toFixed(1)} px^2`,
  );
  console.log(
    `          ${' '.repeat(20)} knife-edge set ${a.nFragile} px ` +
      `(${((100 * a.nFragile) / a.cov.length).toFixed(3)}% of the frame) — a GPU may differ on any of these`,
  );
}

if (!process.env.GPU) {
  console.log('\nPredictions only. Set GPU=1 to render and falsify (needs a browser).');
  process.exit(0);
}

// ── the GPU arm ───────────────────────────────────────────────────────────────────────────────
let HTML = '';
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/probe.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(HTML);
  }
  const p = path.join(ROOT, url);
  if (!p.startsWith(ROOT) || !existsSync(p)) {
    res.writeHead(404);
    return res.end();
  }
  const ext = path.extname(p);
  res.writeHead(200, {
    'Content-Type':
      ext === '.js' || ext === '.mjs'
        ? 'text/javascript'
        : ext === '.glsl'
          ? 'text/plain'
          : 'text/html',
  });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

HTML = `<!DOCTYPE html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
window.__shot = async (svgText, sz) => {
  const c = document.createElement('canvas'); c.width = sz; c.height = sz; document.body.appendChild(c);
  const gl = c.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, depth: true, stencil: true });
  const r = createRenderer(gl, shaders, { precompileFillsBudgetMs: 5000 }); await r.ready;
  r.setViewport(sz, sz); r.setFillEngine({ route: 'lb', kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svgText, {}));
  if (r.prepareBundle) r.prepareBundle(b);
  if (r.awaitEngine) await r.awaitEngine(b, 'lb', 30000);
  // COVERAGE IS THE ALPHA CHANNEL ON A TRANSPARENT CLEAR, not 1 - red on a white one. The model
  // computes geometric coverage, which has no colour in it; reading red against white only equals
  // that for a BLACK drawing. The synthetic cases are black and read the same either way, but tiger
  // is coloured, so its red channel was reporting the fill's hue and the arm compared a colour map
  // against a coverage map -- 16,071.8 px^2 of "ink" against a modelled 37,803.6, which looked like
  // a kernel disagreement and was a unit mismatch.
  for (let i = 0; i < 3; i++) { r.beginFrame([0, 0, 0, 0]); r.drawBundle(b, {}); r.endFrame(); }
  const px = new Uint8Array(sz * sz * 4); gl.readPixels(0, 0, sz, sz, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const cov = new Float64Array(sz * sz);
  for (let y = 0; y < sz; y++) for (let x = 0; x < sz; x++)
    cov[y * sz + x] = px[((sz - 1 - y) * sz + x) * 4 + 3] / 255;   // GL reads bottom-up
  const E = r.debugStats.engines || { draws: {} };
  return { cov: Array.from(cov), gate: r.debugStats.unifiedFillGate || '?',
           drew: Object.entries(E.draws || {}).filter(([, v]) => v > 0).map(([k]) => k).join('+') || '-' };
};
window.__ready = true;
</script></body></html>`;

const browser = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=metal', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.error('  [page]', m.text());
});
// SERVED, not setContent: the page imports /src/index.js as a module, which needs a real origin.
await page.goto(`http://localhost:${PORT}/probe.html`, { waitUntil: 'load' });
// polling: 100 -- waitForFunction's default rAF polling stalls headless under load.
await page.waitForFunction('window.__ready === true', { polling: 100, timeout: 120000 });

// each ARM GETS ITS own PAGE. Two page.evaluate calls share the page's module registry, and the
// build path keeps module-level memos keyed on geometry rather than on the test hooks — so the
// second arm was served the first arm's mesh and the A/B read as "the flag did not reach the
// builder" when what happened is that the flag never got the chance to matter. The same class of
// trap as the LB mesh-cache A/B and the stage memos that faked scale divergences: a memo that
// outlives an arm makes the arms one arm.
const shot = async (svg) => {
  const pg = await browser.newPage();
  pg.on('console', (m) => {
    if (m.type() === 'error') console.error('  [page]', m.text());
  });
  await pg.goto(`http://localhost:${PORT}/probe.html`, { waitUntil: 'load' });
  await pg.waitForFunction('window.__ready === true', { polling: 100, timeout: 120000 });
  try {
    return await pg.evaluate((s, n) => window.__shot(s, n), svg, CANVAS);
  } finally {
    await pg.close();
  }
};

let fail = 0;
for (const [name, svg] of Object.entries(ASSETS)) {
  const on = await shot(svg);
  if (process.env.DUMP) {
    const { mkdirSync, writeFileSync } = await import('fs');
    const dir = path.join(ROOT, 'probes/_lbPipeOut');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, `gpu_${name.replace(/[^a-z0-9]+/gi, '_')}_${CANVAS}.json`),
      JSON.stringify({ name, N: CANVAS, svg, drew: on.drew, cov: on.cov }),
    );
  }
  if (!/lb/.test(on.drew)) {
    fail++;
    console.error(
      `  FAIL ${name}: the engine ledger says '${on.drew}' drew it, not lb (gate ${on.gate})`,
    );
    continue;
  }
  const cmp = (gpu, model, label, fragile) => {
    let n = 0,
      sum = 0,
      max = 0,
      bad = 0,
      at = null;
    // THE CLAIM IS ABOUT PIXELS OUTSIDE THE KNIFE-EDGE SET. Inside it the GPU's subpixel snapping
    // may legitimately land either way, by a whole fragment; a tolerance in /255 cannot express
    // that and a max taken over it reports the ambiguity as a modelling error.
    let maxF = 0,
      badF = 0,
      atF = null,
      nF = 0;
    for (let i = 0; i < model.length; i++) {
      const d = Math.abs(gpu[i] - model[i]) * 255;
      n++;
      sum += d;
      if (d > max) {
        max = d;
        at = i;
      }
      if (d > 4) bad++;
      if (fragile && fragile[i]) {
        nF++;
        continue;
      }
      if (d > maxF) {
        maxF = d;
        atF = i;
      }
      if (d > 4) badF++;
    }
    const mean = sum / n,
      badPct = (100 * bad) / n;
    const okAll = mean <= 1.0 && max <= 12 && badPct <= 0.5;
    if (!okAll) fail++;
    console.log(
      `  ${okAll ? 'ok  ' : 'FAIL'} ${name} [${label}]  mean ${mean.toFixed(3)}/255  max ${max.toFixed(1)}/255` +
        ` at (${at % CANVAS},${(at / CANVAS) | 0})  off>4/255 ${badPct.toFixed(3)}%`,
    );
    if (fragile) {
      // The falsifier. A model that is the kernel disagrees only where a GPU is ALLOWED to differ.
      console.log(
        `       OUTSIDE the ${nF}-px knife-edge set: max ${maxF.toFixed(1)}/255` +
          (atF == null ? '' : ` at (${atF % CANVAS},${(atF / CANVAS) | 0})`) +
          `, ${badF} px off by more than 4/255` +
          `  => ${
            badF === 0
              ? 'every disagreement is a pixel a GPU may land either side of'
              : 'THE MODEL IS FALSIFIED THERE — those pixels are not rasterizer ambiguity'
          }`,
      );
    }
    // WHERE the disagreement is, which separates "one shape the model declined" from "everywhere".
    // A single missing shape is a COMPACT blob whose pixels are almost all biased the same way; a
    // kernel disagreement is scattered along edges with both signs.
    if (!okAll && bad > 0) {
      let x0 = 1e9,
        y0 = 1e9,
        x1 = -1,
        y1 = -1,
        gpuHigh = 0,
        modelHigh = 0;
      for (let i = 0; i < model.length; i++) {
        if (Math.abs(gpu[i] - model[i]) * 255 <= 4) continue;
        const x = i % CANVAS,
          y = (i / CANVAS) | 0;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (gpu[i] > model[i]) gpuHigh++;
        else modelHigh++;
      }
      const w = x1 - x0 + 1,
        h = y1 - y0 + 1;
      const dens = (100 * bad) / (w * h);
      // THE SIGN BALANCE IS THE DIAGNOSIS, not the density. A missing or extra shape is one solid
      // region, one-sided; a systematic modelling error is one-sided but SPREAD; a genuine
      // two-sided scatter along edges is the kernel disagreeing in both directions. Keying on
      // density alone called a 100%-one-sided result "both signs", which is the opposite reading.
      const skew = Math.max(gpuHigh, modelHigh) / Math.max(1, bad);
      const side = gpuHigh >= modelHigh ? 'the GPU paints MORE' : 'the MODEL paints more';
      const verdict =
        skew < 0.75
          ? 'two-sided scatter — the kernel disagrees in both directions'
          : dens > 25
            ? `one solid region, ${side} — a missing or extra SHAPE`
            : `spread but ${(100 * skew).toFixed(0)}% one-sided, ${side} — a SYSTEMATIC modelling error, not noise`;
      console.log(
        `       ${bad} disagreeing px span ${w}x${h} at (${x0},${y0})` +
          ` filling ${dens.toFixed(1)}% of that span; GPU higher on ${gpuHigh}, model higher on ${modelHigh}` +
          `\n       => ${verdict}`,
      );
    }
  };
  cmp(on.cov, pred[name].cov, 'lb', pred[name].fragile);
  const inkOn = on.cov.reduce((a, b) => a + b, 0);
  console.log(
    `       ink on GPU ${inkOn.toFixed(1)} px^2 (model predicted ${pred[name].inkA.toFixed(1)})`,
  );
}
await browser.close();
server.close();
console.log(
  fail
    ? `GPU-MODEL-CHECK FAIL (${fail}) — the CPU model is not the kernel; re-derive the cluster's numbers`
    : 'GPU-MODEL-CHECK OK — the CPU model reproduces the shader within tolerance on every asset',
);
process.exit(fail ? 1 : 0);
