// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// alphaInteriorMetricSmoke — "on opaque tiger, interior pixel error changes with the
// background". It does not. The pixels such a count picks up are EDGE pixels, and the renderer's composite is
// sound; what matters is what the metric in probes/_zzEnginePaint.mjs calls interior.
//
// THE METRIC. The probe renders a frame on white and on a dark ground and counts pixels whose error
// against the reference MOVES with the ground (|errDark - errWhite| > 8/255): a pixel whose color
// depends on what is behind it has accumulated alpha below 1. It restricts that count to "interior"
// pixels, to keep AA ramps out -- and judging interior as "the WHITE-ground reference agrees with
// all eight neighbors" is the trap. Near-white ink over white is flat at ANY coverage, so the silhouette
// of a pale shape is invisible to that test: its edge pixels pass as interior, and every engine's
// ordinary AA error on them moves with the ground. Hence every symptom: all engines show it, the
// count tracks each engine's edge accuracy (aac < slug < cpatch < lb), and it needs MANY shapes --
// one- and two-shape controls have no pale shape on the silhouette.
//
// THE PROOF, on the CPU. The fill-only tiger frame on the Slug and AAC arms is ONE draw into the
// canvas under src-over (ONE, ONE_MINUS_SRC_ALPHA), with no copy, blit, render target or cache
// (recorded below on test/_fakeGl.mjs). Its depth test is LEQUAL on z = 1 - shapeIdx/N
// (mantle.vert.glsl), which only ever lets a LATER shape through, so the frame is exactly a painter's
// composite in document order. Composite each shape's kernel coverage (the shipped GLSL in float32,
// test/_glslEmu.mjs) that way, one 8-bit rounding per shape, on both grounds, and score it with the
// probe's own reference and metric at 512:
//
//                        probe's metric (flat on white)     GPU               solid interior
//   exact coverage       0                                  -                 0
//   Slug                 437, max 0.255                     437, max 0.255    0
//   AAC                  125, max 0.165                     122, max 0.165    0
//
// Slug matches the GPU to the pixel and to the level, so nothing between the kernel and the
// framebuffer contributes: not the depth claim, not a cache blit, not batching order, not a
// premultiply at a boundary (there is no boundary in this frame). Every counted pixel has reference
// alpha below 1. Restricted to pixels where the reference is SOLID (alpha 255), the count is 0 for
// every arm; the probe counts those as ALPHA and the pale edges separately as EDGE.
//
// NON-VACUITY: the same solid-interior metric on a composite whose every shape is 10% short of
// opaque must count the interior that one shape alone covers.
import path from 'path';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_SLUG, K_AAC, AAC_HARD } from './_glslEmu.mjs';
import { example, readAsset, skip } from './_assets.mjs';
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) skip('no C++ compiler ($CXX, clang++, g++, c++) for test/_glslEmu.mjs');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { importSvg, createBundle, createRenderer } = await import('../src/index.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const M = await import('../src/bundle/layout.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { contoursToConverter } = await import('../src/renderer/cpatchBuild.js');
const { rowSpans, rowCross } = await import('../src/renderer/cpatchConvert.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// Fill-only, exactly as the probe strips it.
const SVG = readAsset(example('tiger.svg'), 'utf8')
  .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
  .replace(/stroke-width\s*=\s*"[^"]*"/g, '')
  .replace(/(^|[;{\s"'])stroke\s*:\s*[^;}"']+/g, '$1stroke:none');
const N = 512,
  G2 = [0.04 * 255, 0.22 * 255, 0.55 * 255],
  ALPHA_BAD = 8;

// ---- the frame is one src-over draw into the canvas -----------------------------------------------
for (const arm of ['slug', 'aac']) {
  const F = createFakeGl({ width: N, height: N });
  const calls = [];
  const WATCH = new Set([
    'enable',
    'disable',
    'depthFunc',
    'depthMask',
    'drawArrays',
    'drawArraysInstanced',
    'drawElements',
  ]);
  const gl = new Proxy(
    {},
    {
      get(_t, k) {
        const v = F.gl[k];
        if (typeof k === 'string' && WATCH.has(k))
          return (...a) => {
            calls.push([k, ...a]);
            return v(...a);
          };
        return v;
      },
    },
  );
  const R = createRenderer(gl, taggedShaderSources(), {});
  if (arm === 'slug') R.setLoopBlinnFill('off');
  else R.setFillEngine('aac');
  const b = createBundle(gl, await importSvg(SVG, { preserveViewport: true }));
  for (let k = 0; k < 3; k++) {
    R.setViewport(N, N);
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundle(b);
    R.endFrame();
  }
  const lastFunc = [...calls].reverse().find((c) => c[0] === 'depthFunc');
  const n0 = F.log.length,
    c0 = calls.length;
  R.setViewport(N, N);
  R.beginFrame([0.04, 0.22, 0.55, 1]);
  R.drawBundle(b);
  R.endFrame();
  const fr = F.log.slice(n0),
    cf = calls.slice(c0);
  const draws = fr.filter((e) => e.op === 'draw');
  const other = fr.filter((e) => e.op !== 'draw' && e.op !== 'clear');
  const drawAt = cf.findIndex((c) => c[0].startsWith('draw'));
  const depthOn =
    cf
      .slice(0, drawAt)
      .filter((c) => c[1] === F.gl.DEPTH_TEST)
      .map((c) => c[0])
      .pop() === 'enable';
  // every shape's cover, in one draw: a box (6 vertices) or, where its hull beats the box, a fan
  const coverVerts = b.coverQuadChunks.reduce((s, c) => s + c.count, 0);
  // The unified route draws a primitive shape (the tiger's two ellipses) as its own 6-vertex SDF box in place of its cover fan: the draw is
  // every cover's vertices less what those primitives save (the aac arm builds no primitive meshes, so it draws every cover).
  const primSaved = (b._lbMeshes || []).reduce(
    (sum, m, i) =>
      m && m.prim && !m.slug && (m.verts || m.vbo) && m.vertexCount > 0
        ? sum + b.coverQuadChunks[i].count - m.vertexCount
        : sum,
    0,
  );
  ok(
    draws.length === 1 &&
      draws[0].fbo == null &&
      draws[0].blend &&
      draws[0].blend.join() === 'ONE,ONE_MINUS_SRC_ALPHA' &&
      other.length === 0 &&
      b.coverQuadChunks.length === b.numShapes &&
      draws[0].count === coverVerts - primSaved,
    `${arm}: fill-only tiger is ${draws.length} draw of ${draws[0] && draws[0].count} vertices (${b.numShapes} covers, ${coverVerts} vertices, ${primSaved} saved by SDF primitives) into the canvas ` +
      `under ${draws[0] && draws[0].blend}, and ${other.length} copies/blits/render targets`,
  );
  ok(
    depthOn && lastFunc && lastFunc[1] === F.gl.LEQUAL,
    `${arm}: its depth test is LEQUAL (on z = 1 - shapeIdx/N, so it never rejects a later shape): the frame is a painter's composite`,
  );
}

// ---- the probe's reference, built as probes/_zzEnginePaint.mjs builds it --------------------------
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape),
  MF = meta.metaFloats,
  ST = meta.floatsPerShape | 0;
const bb = Array.from(sec.globalBBox),
  sAR = bb[2] / bb[3];
const arX = sAR > 1 ? 1 : sAR,
  arY = sAR > 1 ? 1 / sAR : 1;
const emX = (i) => bb[0] + ((((2 * (i + 0.5)) / N - 1) / arX + 1) / 2) * bb[2];
const emY = (jb) => bb[1] + ((1 - ((2 * (jb + 0.5)) / N - 1) / arY) / 2) * bb[3];
const SCX = bb[2] / (arX * N),
  SCY = bb[3] / (arY * N),
  SC = Math.max(SCX, SCY);
const GL5 = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
const shapes = [];
for (let s = 0; s < meta.numShapes; s++) {
  const o = s * ST,
    r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(MF[o + 7] > 0)) continue;
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    cs = null;
  }
  if (!cs || !cs.length) continue;
  const all = [];
  for (const c of cs) for (const sg of c) all.push(sg);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sg of all)
    for (const P of sg.P) {
      x0 = Math.min(x0, P[0]);
      x1 = Math.max(x1, P[0]);
      y0 = Math.min(y0, P[1]);
      y1 = Math.max(y1, P[1]);
    }
  shapes.push({
    i: s,
    segs: all,
    rgb: [MF[o + 4] * 255, MF[o + 5] * 255, MF[o + 6] * 255],
    a: MF[o + 7],
    evenOdd: MF[o + 13] > 0.5,
    bb: [x0, y0, x1, y1],
  });
}
const spansOf = (sh, y) => {
  if (!sh.evenOdd) return rowSpans(sh.segs, y) || [];
  const xs = [];
  for (const sg of sh.segs) rowCross(sg, y, (v) => xs.push(v));
  xs.sort((p, q) => p - q);
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2)
    if (xs[k + 1] - xs[k] > 1e-9) out.push([xs[k], xs[k + 1]]);
  return out;
};
// Each shape's exact box coverage over its own pixel window (the reference's per-shape `a`).
for (const sh of shapes) {
  const i0 = Math.max(0, Math.floor((sh.bb[0] - SC - bb[0]) / SCX) - 2),
    i1 = Math.min(N - 1, Math.ceil((sh.bb[2] + SC - bb[0]) / SCX) + 2);
  let j0 = N,
    j1 = -1;
  for (let j = 0; j < N; j++) {
    const cy = emY(j);
    if (cy >= sh.bb[1] - SC && cy <= sh.bb[3] + SC) {
      j0 = Math.min(j0, j);
      j1 = Math.max(j1, j);
    }
  }
  sh.win = { i0, j0, W: Math.max(0, i1 - i0 + 1), H: Math.max(0, j1 - j0 + 1) };
  const { W, H } = sh.win,
    cov = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const cy = emY(j0 + j);
    for (let i = 0; i < W; i++) {
      const cx = emX(i0 + i);
      if (cx < sh.bb[0] - SC || cx > sh.bb[2] + SC || cy < sh.bb[1] - SC || cy > sh.bb[3] + SC)
        continue;
      let t = 0;
      for (const [q, w] of GL5) {
        const y = cy + 0.5 * SCY * q;
        let c2 = 0;
        for (const sp of spansOf(sh, y))
          c2 += Math.max(0, Math.min(cx + SCX / 2, sp[1]) - Math.max(cx - SCX / 2, sp[0]));
        t += (w * 0.5 * c2) / SCX;
      }
      cov[j * W + i] = Math.min(1, Math.max(0, t));
    }
  }
  sh.exact = cov;
}
const ref = new Uint8Array(N * N * 3),
  refB = new Uint8Array(N * N * 3),
  refA = new Uint8Array(N * N);
{
  const P = new Float64Array(N * N * 4);
  for (const sh of shapes) {
    const { i0, j0, W, H } = sh.win;
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const a = sh.exact[j * W + i] * sh.a;
        if (a <= 0) continue;
        const q = ((j0 + j) * N + i0 + i) * 4;
        for (let c = 0; c < 3; c++) P[q + c] = sh.rgb[c] * a + P[q + c] * (1 - a);
        P[q + 3] = a + P[q + 3] * (1 - a);
      }
  }
  for (let q = 0; q < N * N; q++) {
    const pa = P[q * 4 + 3];
    for (let c = 0; c < 3; c++) {
      ref[q * 3 + c] = Math.round(P[q * 4 + c] + (1 - pa) * 255);
      refB[q * 3 + c] = Math.round(P[q * 4 + c] + (1 - pa) * G2[c]);
    }
    refA[q] = Math.round(pa * 255);
  }
}
const flat = new Uint8Array(N * N);
for (let j = 0; j < N; j++)
  for (let i = 0; i < N; i++) {
    let same = 1;
    const k = (j * N + i) * 3;
    for (let dj = -1; dj <= 1 && same; dj++)
      for (let di = -1; di <= 1; di++) {
        const jj = j + dj,
          ii = i + di;
        if (jj < 0 || jj >= N || ii < 0 || ii >= N) continue;
        const k2 = (jj * N + ii) * 3;
        if (
          Math.abs(ref[k] - ref[k2]) > 2 ||
          Math.abs(ref[k + 1] - ref[k2 + 1]) > 2 ||
          Math.abs(ref[k + 2] - ref[k2 + 2]) > 2
        ) {
          same = 0;
          break;
        }
      }
    flat[j * N + i] = same;
  }
let nFlat = 0,
  nSolid = 0,
  nPale = 0;
for (let q = 0; q < N * N; q++)
  if (flat[q]) {
    nFlat++;
    if (refA[q] === 255) nSolid++;
    else if (refA[q] > 0) nPale++;
  }

// ---- the frame, composited as the GPU does it: src-over per shape, rounded to 8 bits ---------------
const frame = (covOf, ground, alphaScale = 1) => {
  const img = new Float32Array(N * N * 3);
  for (let q = 0; q < N * N; q++) for (let c = 0; c < 3; c++) img[q * 3 + c] = ground[c];
  for (const sh of shapes) {
    const { i0, j0, W, H } = sh.win,
      cov = covOf(sh);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        const a = cov[j * W + i] * sh.a * alphaScale;
        if (!(a > 0)) continue;
        const q = ((j0 + j) * N + i0 + i) * 3;
        for (let c = 0; c < 3; c++) img[q + c] = Math.round(sh.rgb[c] * a + img[q + c] * (1 - a));
      }
  }
  return img;
};
const score = (covOf, alphaScale = 1) => {
  const px = frame(covOf, [255, 255, 255], alphaScale),
    px2 = frame(covOf, G2, alphaScale);
  const r = { flat: 0, flatMax: 0, flatPartial: 0, solid: 0 };
  for (let q = 0; q < N * N; q++) {
    if (!flat[q]) continue;
    let gd = 0;
    for (let c = 0; c < 3; c++)
      gd = Math.max(
        gd,
        Math.abs(px2[q * 3 + c] - refB[q * 3 + c] - (px[q * 3 + c] - ref[q * 3 + c])),
      );
    if (gd <= ALPHA_BAD) continue;
    r.flat++;
    r.flatMax = Math.max(r.flatMax, gd);
    if (refA[q] < 255) r.flatPartial++;
    else r.solid++;
  }
  return r;
};

console.log(
  `  fill-only tiger @${N}: ${shapes.length} filled shapes; ${nFlat} px flat on white, of which ${nSolid} solid and ${nPale} PALE EDGE (reference alpha between 0 and 1)`,
);
ok(
  nPale > 0,
  `the probe's "interior" admits ${nPale} edge pixels whose reference alpha is below 1 -- the silhouettes of pale shapes over white`,
);
{
  const r = score((sh) => sh.exact);
  ok(
    r.flat === 0 && r.solid === 0,
    `exact coverage, 8-bit src-over: ${r.flat} flagged by the probe's metric, ${r.solid} on solid interior`,
  );
}
const fsh = fillShapes(sec, parseMetaBin, M),
  byS = new Map(fsh.map((f) => [f.s, f]));
const band = new Float32Array(sec.bands),
  curve = new Float32Array(sec.curves);
// The GPU reads in the table above predate the corner rule (corner pixels take the secant, bent by the tangents), which
// moves Slug's edge pixels toward the exact area: the same metric on its emulated kernel reads ~230, not 437. So Slug's
// count is held to the edges-only property alone (no GPU number). AAC's count moves by under the tolerance.
const GPU = { slug: null, aac: 122 };
for (const [name, defs, k] of [
  ['slug', [], K_SLUG],
  ['aac', AAC_HARD, K_AAC],
]) {
  const emu = buildGlslEmu(ROOT, { defines: defs }),
    cov = new Map();
  for (const sh of shapes) {
    const f = byS.get(sh.i),
      { i0, j0, W, H } = sh.win;
    if (!f || !W || !H) {
      cov.set(sh.i, new Float32Array(W * H));
      continue;
    }
    const qs = [];
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++)
        qs.push({
          k,
          GD: f.GD,
          bb: f.bb,
          eo: f.eo,
          c: [emX(i0 + i), emY(j0 + j)],
          ePx: [SCX, SCY],
        });
    cov.set(sh.i, Float32Array.from(emu.run(band, curve, qs)));
  }
  const r = score((sh) => cov.get(sh.i));
  ok(
    r.flat > 0 &&
      r.flatPartial === r.flat &&
      (GPU[name] == null || Math.abs(r.flat - GPU[name]) <= 8),
    `${name}: the probe's metric flags ${r.flat} px (max ${(r.flatMax / 255).toFixed(3)}; ` +
      (GPU[name] == null ? 'a GPU read of this kernel is owed' : `the GPU read ${GPU[name]}`) +
      `) and ALL ${r.flatPartial} have reference alpha below 1 -- edges, not interior`,
  );
  ok(
    r.solid === 0,
    `${name}: ${r.solid} solid-interior px whose error moves with the ground -- accumulated alpha reaches 1 wherever the reference does`,
  );
  if (name === 'slug') {
    // 10% short: one layer then leaves 0.1 of the ground, 24 levels on the red channel. Where two
    // or more shapes stack, the deficit compounds away (0.01), which is why this is not every pixel.
    const v = score((sh) => cov.get(sh.i), 0.9);
    ok(
      v.solid > nSolid / 10,
      `non-vacuity: every shape 10% short of opaque flags ${v.solid} of ${nSolid} solid-interior px`,
    );
  }
}

console.log(fail ? `alphaInteriorMetricSmoke FAIL (${fail})` : 'alphaInteriorMetricSmoke PASS');
process.exit(fail ? 1 : 0);
