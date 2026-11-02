// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnCornerCompositeSmoke — a per-shape kernel count is not a frame count.
//
// The two count different populations, and a prediction that carries one over to the other is wrong.
//
// `test/gwnCornerWindingSmoke.mjs` scores each fill shape ON ITS own: a pixel is "wrong solid" when
// that SHAPE's coverage disagrees with that SHAPE's exact fill at a pixel whose membership matches
// all eight neighbours IN THAT SHAPE'S WINDOW. That is the right instrument for a kernel rule — it
// isolates the shape the rule fires on. A RENDER has no such thing. It composites 226 fills OVER
// one another in document order and compares the FRAME, so a shape's wrong pixel only counts if
// nothing later paints over it, and "flat" is a property of the composite, not of one shape.
//
// So a kernel rule's effect on a frame is bounded by how much of each shape it corrects is still visible after
// compositing. Same kernels, same encoder output, same 512 px grid, no GPU. The protection is the two-edge rule AND
// the exact-pass routing (`holds`; see gwnCornerWindingSmoke), and the kernel's ink sides are per piece. With both
// removed, as the mutation here does:
//   (a) the harness's metric over ALL 226 shapes: ~363 -> 0 wrong solid, ~125 of them on its 20 shapes;
//   (b) COMPOSITING is the gap: of the per-shape wrong pixels only ~10 reach the frame, and the protection
//       removes them;
//   (c) the frame's remaining wrong pixels with the protection ON are a different defect, scored so it has a number.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_GWN } from './_glslEmu.mjs';
import { requireAsset, PKG_ROOT } from './_assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP gwnCornerCompositeSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
const TIGER = requireAsset(path.join(PKG_ROOT, 'examples/tiger.svg'));
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { rowSpans } = await import('../src/renderer/cpatchConvert.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const RULE = '  if (anyIn != bothIn) reflex = inside > 0.5;';
const ROUTING = '  if (!subPx && holds) return cov;';
const WITHOUT = GLSL.replace(RULE, '  // (rule removed by the smoke)').replace(
  ROUTING,
  '  if (!subPx) return cov;   // (routing removed by the smoke)',
);
ok(
  GLSL.includes(RULE) && GLSL.includes(ROUTING),
  'the center-consistency rule and the exact-pass routing are in the shipped shader text',
);
const emuOn = buildGlslEmu(ROOT, { defines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'] });
const emuOff = buildGlslEmu(ROOT, { defines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'], glsl: WITHOUT });

// The fill-only tiger the GPU probe renders, and the harness's own 20 shapes.
const ONLY = new Set([
  12, 90, 93, 96, 97, 104, 105, 113, 120, 152, 153, 154, 159, 171, 173, 176, 187, 192, 215, 223,
]);
const svg = readFileSync(TIGER, 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '')
  .replace(/(^|[;{\s"'])stroke\s*:\s*[^;}"']+/g, '$1stroke:none');
const b = await importSvg(svg, { preserveViewport: true, gwnTree: true });
const shapes = fillShapes(b, parseMetaBin, M);
const curve = new Float32Array(b.curves),
  band = new Float32Array(b.bands);
for (const sh of shapes) {
  const cs = contoursToConverter(curveRangeToContours(curve, sh.range.begin, sh.range.end), null);
  sh.segs = cs ? cs.flat() : null;
}
const N = 512;
let x0 = Infinity,
  y0 = Infinity,
  x1 = -Infinity,
  y1 = -Infinity;
for (const s of shapes) {
  x0 = Math.min(x0, s.bb[0]);
  y0 = Math.min(y0, s.bb[1]);
  x1 = Math.max(x1, s.bb[2]);
  y1 = Math.max(y1, s.bb[3]);
}
const px = Math.max(x1 - x0, y1 - y0) / N;
const X = (i) => x0 + (i + 0.5) * px,
  Y = (j) => y0 + (j + 0.5) * px;

// ---- one pass: every shape's coverage both ways, its exact membership, and the composite ---------
const accOn = new Float64Array(N * N),
  accOff = new Float64Array(N * N),
  accEx = new Float64Array(N * N);
const wrongOff = [],
  wrongOn = [];
let onlyOff = 0,
  onlyOn = 0;
for (const sh of shapes) {
  if (!sh.segs || !sh.segs.length) continue;
  const i0 = Math.max(0, Math.floor((sh.bb[0] - x0) / px) - 2),
    i1 = Math.min(N - 1, Math.ceil((sh.bb[2] - x0) / px) + 2);
  const j0 = Math.max(0, Math.floor((sh.bb[1] - y0) / px) - 2),
    j1 = Math.min(N - 1, Math.ceil((sh.bb[3] - y0) / px) + 2);
  if (i1 < i0 || j1 < j0) continue;
  const W = i1 - i0 + 1,
    H = j1 - j0 + 1;
  const qs = [],
    inside = new Uint8Array(W * H);
  for (let j = 0; j < H; j++) {
    const spans = rowSpans(sh.segs, Y(j0 + j), sh.eo);
    for (let i = 0; i < W; i++) {
      const x = X(i0 + i);
      for (const s of spans)
        if (x >= s[0] && x < s[1]) {
          inside[j * W + i] = 1;
          break;
        }
      qs.push({ k: K_GWN, GD: sh.GD, bb: sh.bb, eo: sh.eo, c: [x, Y(j0 + j)], ePx: [px, px] });
    }
  }
  const rOn = emuOn.run(band, curve, qs),
    rOff = emuOff.run(band, curve, qs);
  // the harness's own "wrong solid": flat IN this SHAPE'S WINDOW
  for (let j = 1; j < H - 1; j++)
    for (let i = 1; i < W - 1; i++) {
      const k = j * W + i,
        v = inside[k];
      let same = true;
      for (let dj = -1; dj <= 1 && same; dj++)
        for (let di = -1; di <= 1; di++)
          if (inside[(j + dj) * W + i + di] !== v) {
            same = false;
            break;
          }
      if (!same) continue;
      if (Math.abs(rOff[k] - v) > 0.5) {
        wrongOff.push([i0 + i, j0 + j]);
        if (ONLY.has(sh.s)) onlyOff++;
      }
      if (Math.abs(rOn[k] - v) > 0.5) {
        wrongOn.push([i0 + i, j0 + j]);
        if (ONLY.has(sh.s)) onlyOn++;
      }
    }
  // ...and the composite a render actually shows: alpha OVER, in document order
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const g = (j0 + j) * N + (i0 + i),
        k = j * W + i;
      const a = Math.min(1, Math.max(0, rOn[k]));
      accOn[g] = accOn[g] * (1 - a) + a;
      const c = Math.min(1, Math.max(0, rOff[k]));
      accOff[g] = accOff[g] * (1 - c) + c;
      accEx[g] = accEx[g] * (1 - inside[k]) + inside[k];
    }
}

// ---- (a) the shape subset is not the gap -----------------------------------------------------------
ok(
  wrongOff.length >= 20 && wrongOn.length <= 1 && onlyOn <= 1,
  `(a) the harness's metric over ALL ${shapes.length} tiger shapes: ${wrongOff.length} -> ${wrongOn.length} wrong solid (${onlyOff} -> ${onlyOn} on the 20 shapes it scores)`,
);

// ---- (b) compositing is the gap ---------------------------------------------------------------------
{
  let survive = 0;
  for (const [i, j] of wrongOff)
    if (Math.abs(accOff[j * N + i] - accEx[j * N + i]) > 0.25) survive++;
  ok(
    survive >= 3 && survive <= 0.1 * wrongOff.length,
    `(b) of those ${wrongOff.length} per-shape wrong pixels, only ${survive} still differ in the COMPOSITED frame — the other ${wrongOff.length - survive} are painted over by a later shape`,
  );
  // what the frame itself shows, on pixels the composited reference agrees with all eight neighbours on
  const flat = new Uint8Array(N * N);
  for (let j = 1; j < N - 1; j++)
    for (let i = 1; i < N - 1; i++) {
      const q = j * N + i,
        v = accEx[q];
      let same = true;
      for (let dj = -1; dj <= 1 && same; dj++)
        for (let di = -1; di <= 1; di++)
          if (Math.abs(accEx[(j + dj) * N + i + di] - v) > 1e-9) {
            same = false;
            break;
          }
      flat[q] = same ? 1 : 0;
    }
  let fOff = 0,
    fOn = 0;
  for (let q = 0; q < N * N; q++) {
    if (!flat[q]) continue;
    if (Math.abs(accOff[q] - accEx[q]) > 0.5) fOff++;
    if (Math.abs(accOn[q] - accEx[q]) > 0.5) fOn++;
  }
  ok(
    fOff >= 3 && fOn === 0,
    `(b) scored the way a RENDER scores it — composited alpha, flat pixels of the composited reference — the protection takes ${fOff} to ${fOn}`,
  );
  // (c) the frame's residual, at the probe's own solid bar, so the OTHER defect has a number
  let r25 = 0;
  for (let q = 0; q < N * N; q++) if (flat[q] && Math.abs(accOn[q] - accEx[q]) > 0.25) r25++;
  ok(
    r25 > 0,
    `(c) with the protection ON, ${r25} flat composited pixels are still off by more than a quarter coverage: a different defect, outside what the two-edge combine addresses`,
  );
}

console.log(fail ? `gwnCornerCompositeSmoke FAIL (${fail})` : 'gwnCornerCompositeSmoke PASS');
process.exit(fail ? 1 : 0);
