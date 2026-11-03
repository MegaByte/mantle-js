// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupTargetsRenderSmoke -- group targets and their rects, in pixels.
//
//   frame: a filter frame sets the viewport to the frame's size, and a filtered leaf, group or blend leaf inside it must not re-size the canvas-sized accumulator the outer group is still drawing into.
//          The outer group's other content must survive, on every frame of a filter that re-evaluates (groupFrameTargetSmoke has the dataflow).
//   slot:  a faded instance's slot offset goes through the matrix's w: a matrix and its multiple are one transform and paint one picture (alphaInstanceSlotsSmoke).
//   morph: the instance plan follows a morph's pose: t 0 then t 1 paints what t 1 alone paints.
//   width: a stroke-width override reaches past the row's authored box and the group's composite does not cut it (strokeWidthOverrideRectSmoke).
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ROOT = process.env.MANTLE_SMOKE_SRC_ROOT
  ? path.resolve(process.env.MANTLE_SMOKE_SRC_ROOT)
  : ROOT;
let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const SZ = 400;

const DEFS =
  '<defs><filter id="b" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="8"/><feOffset dx="3" dy="3"/></filter></defs>';
const doc = (body, vb = '0 0 400 400') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>`;
const BLUE = '<rect x="250" y="250" width="60" height="60" fill="#0000ff"/>';
const FRAME_CASES = {
  'a graph-filtered leaf': doc(
    `${DEFS}<g opacity="0.5">${BLUE}<rect id="f" x="-40" y="100" width="120" height="120" fill="#c33" filter="url(#b)"/></g>`,
  ),
  'a plain group in a filtered group': doc(
    `${DEFS}<g opacity="0.5">${BLUE}<g filter="url(#b)"><g opacity="0.5"><rect id="f" x="-40" y="100" width="120" height="120" fill="#c33"/><rect x="-30" y="110" width="120" height="120" fill="#3c3"/></g></g></g>`,
  ),
  'a blend leaf in a filtered group': doc(
    `${DEFS}<g opacity="0.5">${BLUE}<g filter="url(#b)"><rect id="f" x="-40" y="100" width="120" height="120" fill="#c33"/><rect x="-30" y="110" width="120" height="120" fill="#3c3" style="mix-blend-mode:multiply"/></g></g>`,
  ),
};
const TWO = doc(
  '<rect x="40" y="40" width="240" height="240" fill="#e04020"/><rect x="140" y="140" width="240" height="240" fill="#2040c0"/>',
);
const POSE_A = doc(
  '<rect id="a" x="16" y="16" width="48" height="48" fill="#e04020"/><rect id="b" x="32" y="32" width="48" height="48" fill="#2040c0"/><rect width="400" height="400" fill="none"/>',
);
const POSE_B = doc(
  '<rect id="a" x="16" y="16" width="360" height="360" fill="#e04020"/><rect id="b" x="32" y="32" width="340" height="340" fill="#2040c0"/><rect width="400" height="400" fill="none"/>',
);
const RUN = doc(
  '<g opacity="0.5"><rect id="r1" x="80" y="80" width="40" height="40" fill="none" stroke="#c00000" stroke-width="4"/></g><g opacity="0.5"><rect x="250" y="250" width="40" height="40" fill="none" stroke="#00c000" stroke-width="4"/></g><g opacity="0.5"><rect x="80" y="250" width="40" height="40" fill="none" stroke="#0000c0" stroke-width="4"/></g>',
);

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${SZ}" height="${SZ}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, createOverrideTable, createShapeMorph, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); await R.ready;
R.setViewport(${SZ}, ${SZ});
const imp = async (s) => createBundle(gl, await importSvg(s, { preserveViewport: true }));
const shot = () => { const b = new Uint8Array(${SZ * SZ * 4}); gl.readPixels(0, 0, ${SZ}, ${SZ}, gl.RGBA, gl.UNSIGNED_BYTE, b); return b; };
const at = (b, x, y) => { const o = ((${SZ} - 1 - y) * ${SZ} + x) * 4; return [b[o], b[o + 1], b[o + 2]]; };
const glClean = () => { let e, n = 0; while ((e = gl.getError()) !== gl.NO_ERROR && n < 64) n++; return n; };
const warm = async (draw) => { const w = await R.warmScene([{ draw }], { maxPasses: 16 }); return w.complete; };
const maxDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > m) m = d; } return m; };
window.__frame = async (svg) => {
  const b = await imp(svg), t = createOverrideTable(gl, b);
  const row = b.drawList.filter((o) => o.kind === 'fillShape').map((o) => o.shapeIdx).pop();
  // each frame moves the override, so the filter re-evaluates (a miss) on every frame
  let v = 0;
  const draw = () => { v = (v + 1) % 16; t.set(row, { tint: [1, 1 - v / 64, 1, 1] }); R.beginFrame([1, 1, 1, 1]); R.drawBundle(b, { overrides: t }); R.endFrame(); };
  const warmed = await warm(draw);
  glClean();
  const seen = [];
  for (let i = 0; i < 4; i++) { draw(); seen.push(at(shot(), 280, 280)); }
  const errs = glClean();
  b.dispose();
  return { warmed, seen, errs };
};
window.__slot = async (svg) => {
  const b = await imp(svg), out = [];
  for (const mul of [1, 2]) {
    const inst = Array.from({ length: 16 }, (_, i) => ({ worldMatrix: new Float32Array([0.45, 0, 0, 0, 0.45, 0, -0.75 + 0.5 * (i % 4), 0.75 - 0.5 * ((i / 4) | 0), 1].map((v) => v * mul)), alpha: 0.5 }));
    const s0 = R.debugStats.alphaSlotBatches | 0;
    const draw = () => { R.beginFrame([1, 1, 1, 1]); R.drawBundleInstanced(b, inst); R.endFrame(); };
    await warm(draw); draw();
    out.push({ px: shot(), slot: (R.debugStats.alphaSlotBatches | 0) - s0 });
  }
  b.dispose();
  return { diff: maxDiff(out[0].px, out[1].px), slots: out.map((o) => o.slot) };
};
window.__morph = async (a, c) => {
  const A = await imp(a), C = await imp(c);
  const inst = [0, 1, 2, 3].map((i) => ({ worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0.8 * (i % 2) - 0.4, 0.4 - 0.8 * (i >> 1), 1]), alpha: 0.5 }));
  R.setFillEngine({ route: 'none', kernel: 'slug' });
  const m1 = createShapeMorph(gl, A, C, {}), m2 = createShapeMorph(gl, A, C, {});
  const draw = (m) => { R.beginFrame([1, 1, 1, 1]); R.drawBundleInstanced(m, inst); R.endFrame(); };
  m2.setT(1); await warm(() => draw(m2)); draw(m2); const cold = shot();
  m1.setT(0); await warm(() => draw(m1)); draw(m1);
  m1.setT(1); await warm(() => draw(m1)); draw(m1); const stale = shot();
  R.setFillEngine({ route: 'auto', kernel: 'auto', commit: false });
  return { diff: maxDiff(cold, stale) };
};
window.__width = async (svg) => {
  const b = await imp(svg), t = createOverrideTable(gl, b);
  const row = b.drawList.filter((o) => o.kind === 'fillShape')[0].shapeIdx;
  const draw = () => { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b, { overrides: t }); R.endFrame(); };
  await warm(draw); draw();
  t.set(row, { strokeWidth: 60 });
  await warm(draw); draw();
  const p = shot();
  b.dispose();
  // the stroke's outer edge is 30 past the rect, at x 50: inside it and far outside the authored box
  return { past: at(p, 60, 100), pastY: at(p, 100, 60), onPath: at(p, 80, 100) };
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
    res.end(readFileSync(path.join(SRC_ROOT, p)));
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
page.on('pageerror', (e) => fail('pageerror ' + e.message));
page.setDefaultTimeout(pageTimeoutFor());
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: pageTimeoutFor(),
});
await page.waitForFunction(() => window.__ready === true, {
  timeout: pageTimeoutFor(),
  polling: 100,
});

const near = (a, b, d = 3) => a.every((v, i) => Math.abs(v - b[i]) <= d);
for (const [name, svg] of Object.entries(FRAME_CASES)) {
  const r = await page.evaluate((s) => window.__frame(s), svg);
  const bad = r.seen.filter((p) => !near(p, [128, 128, 255]));
  if (bad.length || r.errs)
    fail(
      `frame, ${name}: the outer group's square over white, every frame: ${JSON.stringify(r.seen)}, GL errors ${r.errs}`,
    );
  else ok(`frame, ${name}: ${JSON.stringify(r.seen[0])} on every frame, no GL error`);
}
{
  const r = await page.evaluate((s) => window.__slot(s), TWO);
  if (!(r.slots[0] > 0 && r.slots[1] > 0))
    fail(`slot: vacuous, the slot path did not run: ${r.slots}`);
  else if (r.diff > 1) fail(`slot: a matrix and its double paint one picture: differ by ${r.diff}`);
  else ok(`slot: a matrix and its double within ${r.diff}`);
}
{
  const r = await page.evaluate((a, c) => window.__morph(a, c), POSE_A, POSE_B);
  if (r.diff > 2) fail(`morph: t 0 then t 1 against t 1 alone: differ by ${r.diff}`);
  else ok(`morph: t 0 then t 1 is t 1 alone, within ${r.diff}`);
}
{
  const r = await page.evaluate((s) => window.__width(s), RUN);
  const ink = (p) => p[1] < 200 && p[2] < 200 && p[0] > 200;
  if (!ink(r.past) || !ink(r.pastY))
    fail(
      `width: the wider stroke past the authored box: at x 60 ${r.past}, at y 60 ${r.pastY}, on the path ${r.onPath}`,
    );
  else ok(`width: the wider stroke reaches past the authored box: ${r.past}`);
}
await browser.close();
server.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\ngroupTargetsRenderSmoke: ok');
process.exit(0);
