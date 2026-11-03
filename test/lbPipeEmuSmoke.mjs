// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbPipeEmuSmoke — the whole-LB-pipeline emulator (test/_lbPipeEmu.mjs + _lbPipeScene.mjs) keeps meaning what it says,
// and the LB CPU twin (probes/lbAccuracy/_lbRaster.mjs + _lbKernel.mjs) keeps being the kernel it models.
//
// The emulator runs the generated vertex and fragment texts end to end on the CPU, with a rasterizer and real 2x2-quad
// derivatives. Held to it, the twin agrees to 0.5/255 on tiger's fills (stroke rows, the ribbon gate and the band's
// GL-frame dFdy included). This keeps both
// halves honest on a small drawing with the kinds tiger exercises (interior chains, crescents, curve bands, a cubic):
//   (a) the emulator draws the right AMOUNT of ink: a circle and a triangle within 1% of their area;
//   (b) the twin and the emulator agree on every pixel of a fill-only drawing to 2/255, under COARSE derivatives
//       (the twin's opt.coarseDeriv) and under FINE ones (its default: what ANGLE on Metal takes);
//   (c) not vacuously: the drawing has fragments of several kinds, and discarded ones;
//   (d) the curve band, fragment for fragment, on the tiger shapes most sensitive to two drifts the twin can have (the
//       ribbon gate and the band's GL-frame dFdy), at 512 px with only kind-12 triangles rasterized. Each drift, put back, moves
//       14-26 band fragments here (up to 93/255). Skipped when examples/tiger.svg (a fetched fixture) is absent.
// SKIPs (exit 77) without a C++ compiler and clang.
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { hasLbPipeEmu } from './_lbPipeEmu.mjs';
import { lbScene, renderScene, compositeAlpha } from './_lbPipeScene.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasLbPipeEmu()) {
  console.log('SKIP lbPipeEmuSmoke: needs a C++17 compiler and clang');
  process.exit(77);
}
let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const t0 = Date.now();
const warn = console.warn;
console.warn = () => {};
const VT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
const FT = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');

// ── (a) the amount of ink ────────────────────────────────────────────────────────────────────────────────────────────
{
  const N = 96;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="30" fill="#000"/>' +
    '<path d="M10 10 L40 12 L20 40 Z" fill="#000"/><rect x="0" y="0" width="0.01" height="0.01"/><rect x="99.99" y="99.99" width="0.01" height="0.01"/></svg>';
  const sc = await lbScene(svg, { N });
  const r = renderScene(sc, VT, FT);
  const cov = compositeAlpha(r.recs, N);
  let ink = 0;
  for (const c of cov) ink += c;
  const pxPerEm = N / Math.max(sc.gbb[2], sc.gbb[3]);
  const area = (Math.PI * 900 + 440 + 2e-4) * pxPerEm * pxPerEm;
  ok(
    Math.abs(ink - area) / area < 0.01,
    `a circle and a triangle: ${ink.toFixed(1)} px^2 of ink against ${area.toFixed(1)} exact`,
  );
}

// ── (b) + (c) the twin against the shader ────────────────────────────────────────────────────────────────────────────
{
  const N = 128;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<path d="M50 8 C80 8 92 30 92 50 C92 80 70 92 50 92 C25 92 8 75 8 50 C8 25 25 8 50 8 Z M50 30 L70 50 L50 70 L30 50 Z" fill="#000" fill-rule="evenodd"/>' +
    '<path d="M60 12 Q95 20 88 60 L70 40 Z" fill="#000"/>' +
    '<path d="M12 60 C12 95 45 98 40 70 C38 62 30 80 20 75 Z" fill="#000"/></svg>';
  const { shapesOf, viewOf, buildMesh, rasterMesh } =
    await import('../probes/lbAccuracy/_lbRaster.mjs');
  const xd = await import('@xmldom/xmldom');
  globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
  globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
  const { default: importSvg } = await import('../src/svg/importer.js');
  const { shapes, bbox } = await shapesOf(await importSvg(svg), { rows: 'fill' });
  const view = viewOf(bbox, N);
  const sc = await lbScene(svg, { N });
  for (const coarse of [true, false]) {
    const twin = new Float64Array(N * N).fill(1);
    for (const sh of shapes) {
      const b = await buildMesh(sh);
      if (b) rasterMesh(b.pk, view, twin, coarse ? { coarseDeriv: true } : {}, null, null, null);
    }
    const r = renderScene(sc, VT, FT, [], { coarse });
    const emu = compositeAlpha(r.recs, N);
    let bad = 0,
      max = 0,
      ink = 0;
    for (let k = 0; k < emu.length; k++) {
      const d = Math.abs(emu[k] - (1 - twin[k])) * 255;
      if (d > max) max = d;
      if (d > 2) bad++;
      ink += emu[k];
    }
    ok(
      bad === 0,
      `${coarse ? 'coarse' : 'fine'} derivatives: the twin and the shader agree on every pixel to 2/255 (${bad} off, max ${max.toFixed(2)}/255, ${ink.toFixed(0)} px^2 of ink)`,
    );
    if (coarse) {
      const kinds = new Set();
      let disc = 0;
      const ko = r.vert.outOff[r.vert.io.outs.findIndex((o) => o.name === 'vKind')];
      for (let q = 0; q < r.recs.length / 9; q++) {
        kinds.add(Math.floor(r.vOut[((r.recs[q * 9] | 0) * 3 + 2) * r.vert.outN + ko] + 1e-4));
        disc += r.recs[q * 9 + 7];
      }
      ok(
        kinds.size >= 3 && disc > 100,
        `not vacuous: ${r.recs.length / 9} fragments of kinds ${[...kinds].sort((a, b) => a - b).join(', ')}, ${disc} discarded`,
      );
    }
  }
}

// ── (d) the band kernel on tiger's own shapes ────────────────────────────────────────────────────────────────────────
const TIGER = path.join(ROOT, 'examples/tiger.svg');
if (!existsSync(TIGER))
  console.log('  -- (d) skipped: examples/tiger.svg is absent (npm run fetch-fixtures)');
else {
  const N = 512;
  const { shapesOf, viewOf, buildMesh, rasterMesh } =
    await import('../probes/lbAccuracy/_lbRaster.mjs');
  const { default: importSvg } = await import('../src/svg/importer.js');
  // Tiger's fills (strokes set to none, as _gpuModelCheck draws them); the shapes, by fill-row index, whose band
  // fragments differ when the twin lacks either rule (probes/lbAccuracy/_twinVsPipeEmu.mjs).
  const fills = readFileSync(TIGER, 'utf8').replace(/\bstroke="[^"]*"/g, 'stroke="none"');
  const PICK = new Set([
    13, 14, 15, 16, 17, 18, 19, 20, 21, 24, 25, 32, 35, 66, 97, 99, 101, 103, 110, 116, 117, 157,
    204, 206,
  ]);
  const tb = await importSvg(fills),
    g = tb.globalBBox,
    f = (x) => +x.toFixed(4);
  let body = `<rect x="${f(g[0])}" y="${f(g[1])}" width="0.05" height="0.05"/><rect x="${f(g[0] + g[2] - 0.05)}" y="${f(g[1] + g[3] - 0.05)}" width="0.05" height="0.05"/>`;
  for (const sh of (await shapesOf(tb, { rows: 'fill' })).shapes) {
    if (!PICK.has(sh.s)) continue;
    let d = '';
    for (const c of sh.contours) {
      if (!c.length) continue;
      d += `M${f(c[0].p1[0])} ${f(c[0].p1[1])}`;
      for (const q of c)
        d +=
          q.type === 2
            ? ` C${f(q.p2[0])} ${f(q.p2[1])} ${f(q.p3[0])} ${f(q.p3[1])} ${f(q.p4[0])} ${f(q.p4[1])}`
            : ` L${f(q.p2[0])} ${f(q.p2[1])}`;
      d += ' Z';
    }
    body += `<path d="${d}" fill="#000"${sh.evenOdd ? ' fill-rule="evenodd"' : ''}/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 900">${body}</svg>`;
  // A static klm piece's ring carries its arc (kind 4); the TEST HOOK keeps the kind-12 klm ring this part
  // exists to hold to the twin (a morph pair and the fast-mesh route still pack it), in both builds below.
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__LB_BEZ_RING_ARC = false;
  const { shapes, bbox } = await shapesOf(await importSvg(svg), { rows: 'fill' });
  const view = viewOf(bbox, N);
  const twin = new Map();
  for (const sh of shapes) {
    const b = await buildMesh(sh);
    if (b)
      rasterMesh(
        b.pk,
        view,
        new Float64Array(N * N).fill(1),
        { coarseDeriv: true, onFrag: (t, i, j, c) => twin.set(`${sh.s}:${t}:${i}:${j}`, c) },
        null,
        null,
        null,
      );
  }
  const sc = await lbScene(svg, { N });
  const r = renderScene(sc, VT, FT, [], { coarse: true, kinds: [12] });
  delete globalThis.__LB_BEZ_RING_ARC;
  delete globalThis.__MANTLE_DEBUG__;
  let n = 0,
    bad = 0,
    max = 0,
    painted = 0;
  for (let q = 0; q < r.recs.length / 9; q++) {
    const t = r.recs[q * 9] | 0,
      e = sc.entries[sc.entryOfTri[t]];
    const key = `${e.shapeIdx}:${((t * 3 - e.vStart) / 3) | 0}:${r.recs[q * 9 + 1] | 0}:${r.recs[q * 9 + 2] | 0}`;
    if (!twin.has(key)) continue;
    const tc = twin.get(key),
      ec = r.recs[q * 9 + 7] === 1 ? 0 : r.recs[q * 9 + 6];
    const d = Math.abs((tc === null ? 0 : Math.min(1, Math.max(0, tc))) - ec) * 255;
    n++;
    if (ec > 0) painted++;
    if (d > max) max = d;
    if (d > 2) bad++;
  }
  ok(
    n > 300 && painted > 100,
    `(d) ${n} curve-band fragments of ${PICK.size} tiger shapes matched, ${painted} painted`,
  );
  ok(
    bad === 0,
    `(d) the twin's band kernel is the shader's, fragment for fragment, to 2/255 (${bad} off, max ${max.toFixed(1)}/255)`,
  );
}

console.warn = warn;
console.log(
  fail
    ? `lbPipeEmuSmoke FAIL (${fail})`
    : `lbPipeEmuSmoke: all checks passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(fail ? 1 : 0);
