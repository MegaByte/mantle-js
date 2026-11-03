// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbEmTunedLengthScaleSmoke — the Loop-Blinn build carries no EM-TUNED LENGTH, pinned per site.
//
// lbCpatchScaleEquivarianceSmoke pins the general property (a build on 2^k * contours is the scale-1
// build scaled) with one case per absolute tolerance. This pins the em-tuned lengths in lbInteriorSplit.js
// and lbPartition.js (0.015, 0.002, 0.00025) and their kin: one case per site, at the exponent where an
// em-tuned test there would fail it, plus the two the other smoke cannot see at all. Each site, the
// em-tuned form it must not take, and the case that catches it:
//
//   lbInteriorSplit        `ownD > 0.015`: a centroid's depth below its own ramp line against a world
//                          -unit constant. The most common first-differing site at 2^-20.
//                          colorPalette #1 reaches it with ownD 2.78 at scale 1 and 2.6e-6 at
//                          2^-20, so the face would rebind at one size and not the other.
//   lbInteriorSplit        `area < 0.002`: the junction-chip branch, against a world-unit area.
//                          enginePeer #1's face is 1.23 at scale 1 and 1.1e-12 at 2^-20.
//   lbPartition            `sag/n^2 > 0.00025`: how many pieces the analytic chain cuts a hull into.
//                          entryPointRoute #0 would stop at n=4 at 2^-20 and run to the cap at 2^8.
//   lbPack (ekey5)         a straight edge's endpoints keyed onto an absolute 1/65536 of a WORLD unit:
//                          at 2^-20 every endpoint keys to 0, every crescent decides its chord is a
//                          shape boundary, and |sign| flips 1 -> 3 (the flag the fragment shader clips
//                          on). aacPointsRoute #2.
//   lbFastMesh             ptInFace's `tol = 1e-11` on a CROSS PRODUCT -- every face's whole area at
//                          2^-20, so the sliver-containment scan answers differently.
//                          lbTranslucentStripBlend #0 would go from 3390 interior floats to 338.
//   lbCubicMath            `d0 < 1e-12` on a cubic piece's control leg: a whole cubic at 2^-20, so every
//                          piece reads "no turn" and none is split. cuspFill #0 (the CDT stage).
//   lbContour              _setKeyOrigin's box: of the segment START points alone, a ONE-SEGMENT contour
//                          has a degenerate box and _koScale falls to an absolute 64 -- a 1024-unit
//                          stand-in for the shape at every size. Every tolerance above is written
//                          against that stand-in, so for such shapes they would stay em-tuned however
//                          the drawing is scaled. _arcs_circle #1 is 1.86 units across.
//                          NOTE this shape has fill alpha 0, which is why probes/_zzScaleWide.mjs --
//                          which gates on it -- reads 0 without this case.
import { readFileSync } from 'fs';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { buildLbShape } = await import('../src/renderer/lbBuildCore.js');
const { buildLoopBlinnCDT } = await import('../src/renderer/loopBlinn.js');
const { packLoopBlinnMesh, LB_VERT_FLOATS, unpackKlmGrad } =
  await import('../src/renderer/lbPack.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkQuad, mkCubic, mkRQuad } =
  await import('../src/primitives/seg.js');

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const _warn = console.warn;
console.warn = () => {};

// ------------------------------------------------------------------ comparator
// Same contract as lbCpatchScaleEquivarianceSmoke: every number equal under SOME integer power of the
// scale (positions S, gradients 1/S, areas S^2), every tag, count, length and key identical. The lanes
// lbPack still fills with packHalf2x16 hold UNIT VECTORS, so only their 2^-11 quantum is excused; the
// cubic band's klm gradient pair, the one packed lane that scales, is decoded and held strictly.
const f32 = new Float32Array(1),
  u32 = new Uint32Array(f32.buffer);
const halfToNum = (h) => {
  const s = h & 0x8000 ? -1 : 1,
    e = (h >>> 10) & 0x1f,
    m = h & 0x3ff;
  return e === 0
    ? s * m * 2 ** -24
    : e === 31
      ? m
        ? NaN
        : s * Infinity
      : s * (1 + m / 1024) * 2 ** (e - 15);
};
const halves = (v) => {
  f32[0] = v;
  const x = u32[0];
  return [halfToNum(x & 0xffff), halfToNum(x >>> 16)];
};
function numEq(a, b, S, tol) {
  if (a === b || (a !== a && b !== b)) return true;
  if (!isFinite(a) || !isFinite(b) || a === 0 || b === 0) return false;
  for (let e = -8, p = S ** -8; e <= 8; e++, p *= S)
    if (Math.abs(a / p - b) <= Math.abs(b) * tol) return true;
  return false;
}
function cmp(a, b, S, p = '', key = '', seen = new Set()) {
  if (typeof a !== typeof b) return `${p}: ${typeof b} -> ${typeof a}`;
  if (typeof a === 'number') return numEq(a, b, S, 1e-9) ? null : `${p}: ${b} -> ${a}`;
  if (typeof a !== 'object')
    return a === b || typeof a === 'function' ? null : `${p}: ${b} -> ${a}`;
  if (a === null || b === null) return a === b ? null : `${p}: null-ness`;
  if (seen.has(b)) return null;
  seen.add(b);
  if (ArrayBuffer.isView(a)) {
    if (a.constructor !== b.constructor || a.length !== b.length)
      return `${p}: length ${b.length} -> ${a.length}`;
    const lb = key === 'verts' && a.length % LB_VERT_FLOATS === 0;
    for (let i = 0; i < a.length; i++) {
      if (numEq(a[i], b[i], S, a.constructor === Float32Array ? 1e-6 : 1e-9)) continue;
      if (lb) {
        const lane = i % LB_VERT_FLOATS,
          v0 = i - lane,
          kd = Math.floor(b[v0 + 5]);
        const packed =
          kd === 12
            ? lane === 15 || lane === 16
            : kd === 4
              ? lane === 22 && b[v0 + 23] === 9
              : false;
        if (packed) {
          const ha = halves(a[i]),
            hb = halves(b[i]);
          if (
            [0, 1].every(
              (j) =>
                numEq(ha[j], hb[j], S, 2e-3) ||
                ha[j] === 0 ||
                hb[j] === 0 ||
                !isFinite(ha[j]) ||
                !isFinite(hb[j]),
            )
          )
            continue;
        }
        // The cubic band's klm gradient pair is the one packed lane that scales (as 1/S). It is a shared-exponent
        // pair with float32's own range, not two halves, so it is DECODED and held to the
        // format's 2^-11, with no saturation or flush escape. See lbPack's packKlmGrad.
        if (kd === 12 && lane === 9 && Math.abs(b[v0 + 6]) >= 8192) {
          const ga = unpackKlmGrad(a[i]),
            gb = unpackKlmGrad(b[i]);
          if ([0, 1].every((j) => numEq(ga[j], gb[j], S, 2e-3) || (ga[j] === 0 && gb[j] === 0)))
            continue;
        }
      }
      return `${p}[${i}]: ${b[i]} -> ${a[i]}`;
    }
    return null;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${p}: array-ness`;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${p}: length ${b.length} -> ${a.length}`;
    for (let i = 0; i < a.length; i++) {
      const r = cmp(a[i], b[i], S, `${p}[${i}]`, key, seen);
      if (r) return r;
    }
    return null;
  }
  const ka = Object.keys(a).sort(),
    kb = Object.keys(b).sort();
  if (ka.join() !== kb.join()) return `${p}: keys {${kb}} -> {${ka}}`;
  for (const k of Object.keys(b)) {
    const r = cmp(a[k], b[k], S, `${p}.${k}`, k, seen);
    if (r) return r;
  }
  return null;
}

// ------------------------------------------------------------------ inputs
/// FRESH segments at 2^k, field by field: a spread copy carries the builders' memos (under symbols) along.
const scaled = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const P = (q) => q && [q[0] * S, q[1] * S];
      if (sg.type === SEG_LINE) return mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
      if (sg.type === SEG_QUAD) return mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
      if (sg.type === SEG_CUBIC) return mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
      return mkRQuad(
        P(sg.p1),
        P(sg.p2),
        P(sg.p3),
        sg.w,
        sg.circle ? { cx: sg.circle.cx * S, cy: sg.circle.cy * S, r: sg.circle.r * S } : null,
      );
    }),
  );
const cache = new Map();
/// keepStroke: the _setKeyOrigin case below is a STROKE-only one-segment path, so stripping the
/// stroke (which the rest of the cases do, to isolate the fill build) removes the shape entirely.
async function load(file, keepStroke) {
  const ck = file + (keepStroke ? '!s' : '');
  if (cache.has(ck)) return cache.get(ck);
  let svg = readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  if (!keepStroke)
    svg = svg
      .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
      .replace(/stroke-width\s*=\s*"[^"]*"/g, '');
  const sec = await importSvg(svg, { preserveViewport: true });
  const v = {
    sec,
    cf: new Float32Array(sec.curves),
    meta: new Float32Array(sec.meta, 32),
    mst: sec.metaFloatsPerShape,
  };
  cache.set(ck, v);
  return v;
}
/// NO FILL-ALPHA GATE. probes/_zzScaleWide.mjs skips a shape whose fill alpha is 0, which is exactly
/// how the _setKeyOrigin case below stayed invisible: it is a stroked one-segment path.
function contoursOf(A, s) {
  const r = A.sec.curveRangesByShape[s];
  if (!r || r.end <= r.begin) return null;
  return curveRangeToContours(A.cf, r.begin, r.end);
}
function flagsOf(A, s) {
  const m = A.meta,
    mst = A.mst,
    bb = s * mst;
  return {
    transSolid:
      m[bb + 7] < 0.996 &&
      Math.floor(m[bb + 28] + 0.5) === 0 &&
      (mst < 36 || Math.floor(m[bb + 35] + 0.5) === 0),
    evenOdd: m[bb + 13] > 0.5,
  };
}
const packOf = (b) =>
  b
    ? {
        raw: b.raw,
        lbpk: {
          verts: b.pk.verts.subarray(0, b.pk.vertexCount * LB_VERT_FLOATS),
          vertexCount: b.pk.vertexCount,
          kindMask: b.pk.kindMask | 0,
        },
      }
    : null;

async function lbCase(file, s, KS, label, keepStroke) {
  const A = await load(file, keepStroke);
  const base = contoursOf(A, s);
  if (!base) {
    check(false, `${label}: ${file} #${s} has no curve range`);
    return;
  }
  const { transSolid, evenOdd } = flagsOf(A, s);
  const ref = packOf(buildLbShape(base, transSolid, evenOdd));
  if (!ref) {
    check(false, `${label}: ${file} #${s} declines at scale 1`);
    return;
  }
  for (const k of KS) {
    const w = cmp(packOf(buildLbShape(scaled(base, 2 ** k), transSolid, evenOdd)), ref, 2 ** k);
    check(
      !w,
      `${label}: ${file.replace('examples/', '')} #${s} buildLbShape at 2^${k} is the scale-1 mesh scaled${w ? ' -- ' + w : ''}`,
    );
  }
}
async function cdtCase(file, s, KS, label) {
  const A = await load(file);
  const base = contoursOf(A, s);
  if (!base) {
    check(false, `${label}: ${file} #${s} has no curve range`);
    return;
  }
  const { evenOdd } = flagsOf(A, s);
  const run = (cs, S) => {
    const m = buildLoopBlinnCDT(cs, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
    const pk = packLoopBlinnMesh(m);
    return {
      raw: m,
      lbpk: pk
        ? {
            verts: pk.verts.subarray(0, pk.vertexCount * LB_VERT_FLOATS),
            vertexCount: pk.vertexCount,
            kindMask: pk.kindMask | 0,
          }
        : null,
    };
  };
  const ref = run(base, 1);
  for (const k of KS) {
    const w = cmp(run(scaled(base, 2 ** k), 2 ** k), ref, 2 ** k);
    check(
      !w,
      `${label}: ${file.replace('examples/', '')} #${s} buildLoopBlinnCDT at 2^${k} is the scale-1 mesh scaled${w ? ' -- ' + w : ''}`,
    );
  }
}

console.log(
  'lbInteriorSplit.js: the centroid-depth and face-area constants (0.015 / 0.02 / 0.05 / 0.002 / 1e-3)',
);
await lbCase('examples/smoke/colorPalette__SVG.svg', 1, [-20, -8], '1225 ownD');
await lbCase('examples/smoke/exportFrameSvg__CLIPART.svg', 0, [-20], '1225 ownD');
await lbCase(
  'examples/smoke/importerScaleInvariant__svgDoc_0_0_64_64_path_d_M10_10.svg',
  0,
  [8, 20],
  '1225/1302 ownD',
);
await lbCase('examples/smoke/enginePeer__SVG.svg', 1, [-20], '868 area');
await lbCase('examples/smoke/filterBakeCache__SVG.svg', 0, [-20], '868 area');

console.log("lbPartition.js: the analytic chain's flatness budget (0.00025 / 0.002)");
await lbCase('examples/smoke/entryPointRoute__GLYPHS.svg', 0, [-20, 8], '2165 hull chain');
await lbCase(
  'examples/smoke/shapeAnimationMultiCurveDiag__DST_SVG.svg',
  0,
  [-20, 8],
  '2165 hull chain',
);
await lbCase('examples/smoke/occlusionCull__SVG.svg', 0, [-20], '2165 hull chain');

console.log('lbPack.js: the straight-edge key lattice (ekey5, an absolute 1/65536 world unit)');
await lbCase('examples/smoke/aacPointsRoute__SVG_FILL.svg', 2, [-20], '393 ekey5');
await lbCase('examples/smoke/gwnKernelScale__SVG.svg', 5, [-20, 8], '393 ekey5');

console.log("lbFastMesh.js: ptInFace's cross-product bar and the point-location grid floors");
await lbCase('examples/smoke/lbTranslucentStripBlend__SVG.svg', 0, [-20], '1257 ptInFace');

console.log("lbCubicMath.js: a cubic piece's control-leg direction bar (1e-12)");
await cdtCase('examples/smoke/cuspFill__SVG.svg', 0, [-20], '674 turn');
await cdtCase('examples/smoke/lbSplitRoute__SVG.svg', 1, [-20], '674 turn');

// The unit the rest of them are written against. A ONE-SEGMENT contour's start-point box is a point,
// so _koScale would fall to an absolute 64 and every tolerance above become em-tuned again -- at every
// scale, which is why this case would fail at both a large and a small exponent.
console.log("lbContour.js: _setKeyOrigin's box, for a one-segment contour (fill alpha 0)");
await lbCase('examples/_arcs_circle.svg', 1, [-20, -8, 8, 20], '72 key origin', true);
await lbCase('examples/_pattern.svg', 5, [-20, 8], '72 key origin');

console.warn = _warn;
if (fail) {
  console.log(`FAIL lbEmTunedLengthScaleSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS lbEmTunedLengthScaleSmoke');
