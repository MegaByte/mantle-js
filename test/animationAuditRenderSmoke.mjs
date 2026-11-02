// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// animationAuditRenderSmoke -- the morph-pose rules that change PIXELS, on the GPU (the record-level proofs
// are test/animationAuditSmoke.mjs).
//
// Each cell morphs two endpoint documents to t = .5 and compares the render at 128 px (100-unit viewBox, white ground) with a
// CONTROL: the pose authored literally as a static document (the lerped corner points, or the lerped arc numbers). The morph
// must match its control within MAXBYTE on every channel, and must DIFFER from its `old` picture (what the morph would draw
// with the defect) by at least 48/255 somewhere, so a pass cannot be a picture the defect also draws.
//
//   a rect morphing to a rotated rect (a diamond). A rect row that kept primKind 2 would let the closed-form rect coverage of
//          the fragment shader paint the SOURCE rect's box through the pose; old = that rect.
//   a rotated ellipse (two arcs) turning 0 -> 180 degrees. A pose bbox taken as the linear lerp of the endpoint boxes is
//          smaller than the pose, so the quad extent / box-indexed coverage would clip the arcs; old = the same pose clipped to
//          the linear box.
//
// Engines: AAC and Slug covers, each with primitives 'on' (the primFast path live) and 'off'; GPU curve lerp and CPU curve lerp.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="white"/>${body}</svg>`;
const MAXBYTE = 40; // AA edge differences between a morph pose and a static document at 128 px

const rect = doc('<rect id="s" x="30" y="30" width="40" height="40" fill="#c81e1e"/>');
const diamond = doc('<path id="s" fill="#c81e1e" d="M50 20L80 50L50 80L20 50Z"/>');
const P = [
    [30, 30],
    [70, 30],
    [70, 70],
    [30, 70],
  ],
  Q = [
    [50, 20],
    [80, 50],
    [50, 80],
    [20, 50],
  ];
const lerpPoly = (t) =>
  doc(
    `<path id="s" fill="#c81e1e" d="M${P.map((v, i) => `${v[0] * (1 - t) + Q[i][0] * t} ${v[1] * (1 - t) + Q[i][1] * t}`).join('L')}Z"/>`,
  );

// The rotation lerps as a number with the end points in place, so the pose at t = .5 is the path with rotation 90: scaled up to span the chord, it swings far out of both poses' boxes.
const ell = (phi) =>
  doc(`<path id="s" fill="#1e5ac8" d="M90 50A40 10 ${phi} 0 1 10 50A40 10 ${phi} 0 1 90 50Z"/>`);

const CELLS = [
  {
    name: 'rect -> diamond at t=.5',
    a: rect,
    b: diamond,
    t: 0.5,
    control: lerpPoly(0.5),
    old: doc('<rect x="30" y="30" width="40" height="40" fill="#c81e1e"/>'),
  },
  {
    name: 'ellipse 0 -> 180 degrees at t=.5',
    a: ell(0),
    b: ell(180),
    t: 0.5,
    control: ell(90),
    old: doc(
      '<clipPath id="k"><rect x="10" y="40" width="80" height="20"/></clipPath><path fill="#1e5ac8" d="M90 50A40 10 90 0 1 10 50A40 10 90 0 1 90 50Z" clip-path="url(#k)"/>',
    ),
  },
];
const CONFIGS = [
  { route: 'none', kernel: 'aac', primitives: 'on' },
  { route: 'none', kernel: 'aac', primitives: 'off' },
  { route: 'none', kernel: 'slug', primitives: 'on' },
  { route: 'none', kernel: 'slug', primitives: 'off' },
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
import { paint, viewport } from '/test/_auditPaintCases.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__render = async (cell, cfg, cpuLerp) => {
  viewport(gl, R); R.setFillEngine(cfg);
  const bd = async (s) => createBundle(gl, await importSvg(s, { preserveViewport: true }));
  const a = await bd(cell.a), b = await bd(cell.b), ctl = await bd(cell.control), old = await bd(cell.old);
  const m = createShapeMorph(gl, a, b, { cpuLerp });
  if (!cpuLerp) m.bundle._morphSrc.gpuSmallPlanes = true;
  m.setT(cell.t);
  const out = { pose: Array.from(await paint(gl, R, m)), control: Array.from(await paint(gl, R, ctl)), old: Array.from(await paint(gl, R, old)),
    prim: m.bundle.metaFloats[44], gpu: !!m.usesGpuCurveLerp };
  m.dispose(); a.dispose(); b.dispose(); ctl.dispose(); old.dispose();
  return out;
};
window.__backend = (() => { const e = gl.getExtension('WEBGL_debug_renderer_info'); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); })();
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
console.log('backend:', await page.evaluate(() => window.__backend));
let failures = 0;
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
for (const cell of CELLS)
  for (const cfg of CONFIGS)
    for (const cpuLerp of [false, true]) {
      const tag = `${cell.name} [${cfg.kernel}/prim ${cfg.primitives}/${cpuLerp ? 'cpu' : 'gpu'} lerp]`;
      let r;
      try {
        r = await page.evaluate((c, g, l) => window.__render(c, g, l), cell, cfg, cpuLerp);
      } catch (e) {
        failures++;
        console.error('FAIL: ' + tag + ': ' + e.message);
        continue;
      }
      const vsControl = maxDiff(r.pose, r.control),
        vsOld = maxDiff(r.pose, r.old);
      const line = `${tag}: control maxByte ${vsControl}, old differs by ${vsOld}, prim slot ${r.prim}`;
      if (vsControl > MAXBYTE) {
        failures++;
        console.error('FAIL: ' + line + ' -- render differs from its control');
      } else if (vsOld < 48) {
        failures++;
        console.error('FAIL: ' + line + ' -- vacuous: the defect picture is the same');
      } else console.log('ok ' + line);
    }
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nanimationAuditRenderSmoke: a rect -> diamond and a turning ellipse render as their literal poses on the GPU',
);
