// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// noAaArcRowSmoke — band-hard counts an ARC's ray crossings from the endpoint SIDES, like every
// other segment type, and not from a tolerance band.
//
// WHY. A `hardCrossArc` that asks "is this endpoint ON the ray?" as `|y - c.y| < arcOnRayTol`
// — 1e-5 of |cy| + |rx| + |ry| — and where it says yes SYNTHESIZES a crossing from the arc's
// heading and drops the root that endpoint owns gets the window wrong: an endpoint strictly on the far
// side of the ray but inside that window is not on the ray, and there the rule invents a crossing the
// outline does not have, or drops one it does, while hardCrossLine/Quad/Cubic decide the same vertex by
// an exact sign test. One miscounted crossing flips every pixel of that row to its left, and the window
// is a fixed width in EM, so it covers more pixel rows the finer the raster — wrong runs growing as N^2.
//
// THE REFERENCE IS THE PATH. `rowSpans` (src/renderer/cpatchConvert.js) gives a scanline's filled
// spans exactly, so "is this pixel center inside?" is answered without any renderer — and band-hard
// is a containment test at the pixel center, so the exact answer IS its specification. The kernel
// side is the SHIPPED shader text run in float32 on the CPU (test/_glslEmu.mjs), not a port.
//
// WHAT IT PINS
//   (a) the constructed row sweep: a lone arc endpoint with an empty region to its left, every row
//       across +-4x the arcOnRayTol window — with the window, every row in (0, arcOnRayTol) below the
//       endpoint is wrong; with the sign rule none is;
//   (b) arc-heavy art far from the origin (which is what inflates the window) at 512 and 1024: with
//       the window 100 wrong pixel centers at 512 and 374 at 1024, in runs of 96 and 116; with the sign rule 0 and 8 —
//       and each of the 8 is a lone center within a float32 hair of the outline, never a run;
//   (c) three mutations of the sign rule — the sweep direction dropped from the crossing's sign, the
//       monotone split removed, and the ends REBUILT from the angles instead of read from the record — are
//       each caught, so neither the topology nor the vertices can be lost silently.
//
// NO EPSILON IS LEFT. The ends are the record's stored vertices, the floats the segment
// beside the arc stores, so the arc and its neighbor decide a vertex on the row by one number. Rebuilt
// from a float32 θ, at a quadrant endpoint the rounding has a fixed sign: a snap that places an end
// within one float32 ulp of the row (arcRayUlp, 1.2e-7 of |cy| + |rx| + |ry|) ON it still lets two arcs
// sharing a vertex flip a row an ulp from it (arcStar).
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_HARD } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP noAaArcRowSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
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
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const { pointInFill } = await import('../src/hitTest/fillCoverage.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');

/// Import, and give each fill shape the converter contours the exact oracle reads.
async function load(svg) {
  const b = await importSvg(svg, { preserveViewport: true });
  const shapes = fillShapes(b, parseMetaBin, M);
  const curve = new Float32Array(b.curves);
  for (const sh of shapes) {
    const cs = contoursToConverter(curveRangeToContours(curve, sh.range.begin, sh.range.end), null);
    sh.segs = cs ? cs.flat() : null;
  }
  return { shapes, band: new Float32Array(b.bands), curve };
}
const insideAt = (segs, x, y, eo) => {
  for (const s of rowSpans(segs, y, eo)) if (x >= s[0] && x < s[1]) return 1;
  return 0;
};

// ---- the fixture ----------------------------------------------------------------------------------------------------
// A bar and a lobe, in ONE shape, with a gap between them: a spurious crossing to the right of the
// gap takes the winding there from 0 to 1, which a containment test reports as ink. With the two
// arc endpoints at the same y (a symmetric lobe) the two spurious terms cancel and nothing shows —
// so the lobe's arc has exactly one end on the row under test.
const VERTEX_Y = 100,
  ARC_R = 50,
  ARC_CY = 100; // the encoded center's |cy|, for the tolerance below
const OLD_TOL = 1e-5 * (Math.abs(ARC_CY) + ARC_R + ARC_R);
// ...and a second lobe whose arc sweeps the OTHER way (sweep-flag 0, so the encoded theta1 < theta0),
// because the crossing's sign is the side of the end the PATH reaches last and only a reversed sweep
// tells that apart from "the end at the larger theta".
const FIXTURE =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 300">
 <path d="M 0 0 L 40 0 L 40 300 L 0 300 Z M 200 0 L 200 ${VERTEX_Y} A ${ARC_R} ${ARC_R} 0 0 1 250 ${VERTEX_Y - ARC_R} L 250 0 Z` +
  ` M 305 0 L 305 ${VERTEX_Y} A ${ARC_R} ${ARC_R} 0 0 0 355 ${VERTEX_Y - ARC_R} L 355 0 Z" fill="#000"/>
</svg>`;
const GAP_X = [60.5, 100.5, 150.5, 199.5]; // inside the shape's box, outside the shape

/// Rows across the arcOnRayTol window, plus the row exactly through the vertex.
const ROWS = (() => {
  const out = new Set([VERTEX_Y]);
  for (let k = -16; k <= 16; k++) out.add(Math.fround(VERTEX_Y + (k * OLD_TOL) / 4));
  return [...out].sort((a, b) => a - b);
})();

const FIX = await load(FIXTURE);
{
  const sh = FIX.shapes[0];
  ok(
    FIX.shapes.length === 1 && sh.segs && sh.segs.some((s) => s.t === 'rquad'),
    `fixture: one fill shape, ${sh.segs.length} segments (${[...new Set(sh.segs.map((s) => s.t))].join(', ')}); arcOnRayTol ${OLD_TOL.toExponential(2)} em`,
  );
  ok(
    GAP_X.every((x) => insideAt(sh.segs, x, VERTEX_Y + 3 * OLD_TOL, false) === 0),
    'fixture: the sampled band is OUTSIDE the shape and inside its box, so one extra crossing shows as ink',
  );
}

/// Rows of the sweep whose band-hard answer differs from the exact one, for one shader text.
function sweepWrong(glsl) {
  const emu = buildGlslEmu(ROOT, { defines: ['MANTLE_HARD'], glsl });
  const sh = FIX.shapes[0],
    qs = [],
    meta = [];
  for (const y of ROWS)
    for (const x of GAP_X) {
      qs.push({ k: K_HARD, GD: sh.GD, bb: sh.bb, eo: sh.eo, c: [x, y], ePx: [1, 1] });
      meta.push([x, y]);
    }
  const r = emu.run(FIX.band, FIX.curve, qs);
  const rows = new Set();
  for (let i = 0; i < meta.length; i++)
    if (Math.abs(r[i] - insideAt(sh.segs, meta[i][0], meta[i][1], sh.eo)) > 0.5)
      rows.add(meta[i][1]);
  return [...rows];
}

// ---- (a) ---------------------------------------------------------------------------------------------------------
{
  const w = sweepWrong(GLSL);
  ok(
    w.length === 0,
    `(a) ${ROWS.length} rows across +-4x the arcOnRayTol window, and the row through the vertex: ${w.length} wrong` +
      (w.length ? ` (first dy ${(w[0] - VERTEX_Y).toExponential(2)})` : ''),
  );
}

// ---- (b) ---------------------------------------------------------------------------------------------------------
// Art FAR FROM THE ORIGIN: the arcOnRayTol window is 1e-5 of |cy| + rx + ry, so distance from the origin is
// what makes it wide enough to catch pixel rows. Rounded boxes (axis-angle arc endpoints) and
// rotated half-ellipses, on the raster the whole drawing is rendered at.
function farArt(off, span, seed0) {
  let seed = seed0;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  let d = '';
  for (let k = 0; k < 10; k++) {
    const w = span * (0.05 + rnd() * 0.12),
      h = span * (0.05 + rnd() * 0.12);
    const x = off + rnd() * (span - w),
      y = off + rnd() * (span - h);
    const f = (v) => v.toFixed(4);
    if (k % 2 === 0) {
      const r = Math.min(w, h) * (0.15 + rnd() * 0.35);
      d +=
        `<path d="M ${f(x + r)} ${f(y)} L ${f(x + w - r)} ${f(y)} A ${f(r)} ${f(r)} 0 0 1 ${f(x + w)} ${f(y + r)}` +
        ` L ${f(x + w)} ${f(y + h - r)} A ${f(r)} ${f(r)} 0 0 1 ${f(x + w - r)} ${f(y + h)} L ${f(x + r)} ${f(y + h)}` +
        ` A ${f(r)} ${f(r)} 0 0 1 ${f(x)} ${f(y + h - r)} L ${f(x)} ${f(y + r)} A ${f(r)} ${f(r)} 0 0 1 ${f(x + r)} ${f(y)} Z" fill="#000"/>`;
    } else {
      const rx = w / 2,
        ry = h / 2,
        cx = x + rx,
        cy = y + ry;
      d +=
        `<path d="M ${f(cx - rx)} ${f(cy)} A ${f(rx)} ${f(ry)} ${(rnd() * 80).toFixed(3)} 0 1 ${f(cx + rx)} ${f(cy)}` +
        ` L ${f(cx + rx * 0.3)} ${f(cy + ry)} L ${f(cx - rx * 0.3)} ${f(cy + ry)} Z" fill="#000"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${off} ${off} ${span} ${span}">${d}</svg>`;
}
const SEEDS = [1, 3, 11, 13, 17, 19, 23, 29];
const FARS = [];
for (const s of SEEDS) FARS.push(await load(farArt(1000, 300, s)));
/// Wrong pixel centers, and the LONGEST consecutive run of them on one row: a miscounted crossing
/// paints a run, a pixel center sitting on the outline is alone.
function farWrong(glsl, N) {
  const emu = buildGlslEmu(ROOT, { defines: ['MANTLE_HARD'], glsl });
  let bad = 0,
    tot = 0,
    maxRun = 0;
  for (const FAR of FARS) {
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const s of FAR.shapes) {
      x0 = Math.min(x0, s.bb[0]);
      y0 = Math.min(y0, s.bb[1]);
      x1 = Math.max(x1, s.bb[2]);
      y1 = Math.max(y1, s.bb[3]);
    }
    const px = Math.max(x1 - x0, y1 - y0) / N;
    for (const sh of FAR.shapes) {
      if (!sh.segs) continue;
      const qs = [],
        meta = [];
      const i0 = Math.floor((sh.bb[0] - x0) / px) - 2,
        i1 = Math.ceil((sh.bb[2] - x0) / px) + 2;
      const j0 = Math.floor((sh.bb[1] - y0) / px) - 2,
        j1 = Math.ceil((sh.bb[3] - y0) / px) + 2;
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const c = [x0 + (i + 0.5) * px, y0 + (j + 0.5) * px];
          qs.push({ k: K_HARD, GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [px, px] });
          meta.push(c);
        }
      const r = emu.run(FAR.band, FAR.curve, qs);
      const w = i1 - i0 + 1;
      let run = 0;
      for (let i = 0; i < meta.length; i++) {
        tot++;
        const isBad = Math.abs(r[i] - insideAt(sh.segs, meta[i][0], meta[i][1], sh.eo)) > 0.5;
        if (isBad) {
          bad++;
          run = i % w === 0 ? 1 : run + 1;
          if (run > maxRun) maxRun = run;
        } else run = 0;
      }
    }
  }
  return { bad, tot, maxRun };
}
{
  const a = farWrong(GLSL, 512),
    b = farWrong(GLSL, 1024);
  ok(
    a.bad + b.bad <= 12 && a.maxRun <= 1 && b.maxRun <= 1,
    `(b) ${SEEDS.length} arc-heavy drawings 1000 em from the origin: ${a.bad} wrong of ${a.tot} pixel centres at 512 (longest run ${a.maxRun}), ` +
      `${b.bad} of ${b.tot} at 1024 (longest run ${b.maxRun}); with the window 100 and 374, runs of 96 and 116`,
  );
}

// ---- (c) ---------------------------------------------------------------------------------------------------------
// Mutations of the sign rule, each a single edit that would put the topology back in the solve's
// hands. Each must be caught by (a) or (b). The rule is arcRayCrossings, which Slug's two arc walkers
// share, so each edit lands in all three walkers; this test reads band-hard's.
{
  // ...in both places band-hard applies it: arcRayCrossings' pieces, and the end-sign rule for an arc wholly
  // right of the pixel, which takes the direction as the sweep's sign (dropped: the ends' difference alone).
  const DIR_SHORT = 'return sw.z * (nnHi - nnLo);';
  const noDir = GLSL.includes(DIR_SHORT)
    ? GLSL.replace(
        'return ((dir > 0.0) ? bNeg : aNeg) ? 2.0 : 1.0;',
        'return bNeg ? 2.0 : 1.0;',
      ).replace(DIR_SHORT, 'return nnHi - nnLo;')
    : GLSL;
  const noSplit = GLSL.replace(
    'bool in0 = e0 > lo && e0 < hi, in1 = e1 > lo && e1 < hi;',
    'bool in0 = false, in1 = false;',
  );
  // the ends rebuilt from the center form instead of read from the record, with no snap
  const rebuilt = GLSL.replace(
    '  arcEndsLoHi(ends, sw.z, pLo, pHi);',
    '  { float q0, q1, q2, q3; arcSample(d1, cp, sp, sw.x, pLo, q0, q1); arcSample(d1, cp, sp, sw.y, pHi, q2, q3); }',
  );
  ok(
    noDir !== GLSL && noSplit !== GLSL && rebuilt !== GLSL,
    '(c) all three mutations apply to the shipped text',
  );
  const dW = sweepWrong(noDir).length + farWrong(noDir, 512).bad;
  const sW = sweepWrong(noSplit).length + farWrong(noSplit, 512).bad;
  const wW = farWrong(rebuilt, 512).bad + farWrong(rebuilt, 1024).bad,
    wS = farWrong(GLSL, 512).bad + farWrong(GLSL, 1024).bad;
  ok(dW > 0, `(c) the sweep direction dropped from the crossing's sign is caught: ${dW} wrong`);
  ok(sW > 0, `(c) the monotone split removed is caught: ${sW} wrong`);
  console.log(
    `  .. (c) the ends rebuilt from the angles: ${wW} wrong on (b)'s drawings (stored ends ${wS}) -- caught by (d), where arcs share a vertex`,
  );
}

// ---- (d) two arcs sharing a vertex ------------------------------------------------------------------
// A star of arcs, every vertex shared by two arcs, at 2^-20, 1 and 2^20: rows through every vertex and 1..3 float32
// ulps either side, 24 centers each. An arc that rebuilds the shared vertex from its own center, radii and angles and
// snaps it within its own tolerance flips a row an ulp from it -- and flips it differently in a FUSED build. The
// reference here is the CPU hit test (hitTest/fillCoverage.js pointInFill, f64 roots): the rational-quad
// path `rowSpans` reads is exact to the path but not to the ulp at a vertex, and a row an ulp from one reads a
// sliver there that is not in the path. With the ends stored: none wrong, fused or not, at every scale; with them
// rebuilt (the (c) mutation): wrong again.
const f4 = (v) => v.toFixed(4);
function arcStar(S) {
  const n = 8,
    cx = 64,
    cy = 64,
    r0 = 44,
    r1 = 30;
  const P = (k, r) => [cx + r * Math.cos((Math.PI * k) / n), cy + r * Math.sin((Math.PI * k) / n)];
  let d = `M${f4(P(0, r0)[0])} ${f4(P(0, r0)[1])} `;
  for (let k = 0; k < 2 * n; k += 2) {
    const b = P(k + 2, r0);
    d += `A${f4(r0 * 0.3)} ${f4(r0 * 0.2)} ${k * 7} 0 1 ${f4(b[0])} ${f4(b[1])} `;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${128 * S} ${128 * S}"><g transform="scale(${S})"><path d="${d}Z"/></g></svg>`;
}
const STARS = [];
for (const k of [-20, 0, 20]) STARS.push({ k, X: await load(arcStar(2 ** k)) });
function starWrong(glsl, contract = false) {
  const emu = buildGlslEmu(ROOT, { defines: ['MANTLE_HARD'], glsl, contract });
  const out = [];
  for (const { X } of STARS) {
    let bad = 0,
      tot = 0;
    for (const sh of X.shapes) {
      if (!sh.segs) continue;
      const hs = decodeSegs(X.curve, sh.range.begin, sh.range.end);
      const ys = new Set();
      for (let h = sh.range.begin; h + 4 <= sh.range.end;) {
        const t = X.curve[h] & 3,
          d = h + 4;
        if (t === 3) {
          ys.add(X.curve[d + 9]);
          ys.add(X.curve[d + 11]);
          h = d + 16;
        } else h = d + (t === 0 ? 8 : 12);
      }
      const qs = [],
        at = [];
      for (const y0 of ys)
        for (let u = -3; u <= 3; u++) {
          const ulp = Math.abs(y0) * 2 ** -23,
            y = Math.fround(y0 + u * ulp);
          for (let i = 0; i < 24; i++) {
            const x = Math.fround(sh.bb[0] + ((i + 0.37) / 24) * (sh.bb[2] - sh.bb[0]));
            qs.push({ k: K_HARD, GD: sh.GD, bb: sh.bb, eo: sh.eo, c: [x, y], ePx: [1, 1] });
            at.push([x, y]);
          }
        }
      const r = emu.run(X.band, X.curve, qs);
      for (let i = 0; i < at.length; i++) {
        tot++;
        if (Math.abs(r[i] - (pointInFill(hs, at[i][0], at[i][1], sh.eo) ? 1 : 0)) > 0.5) bad++;
      }
    }
    out.push(bad);
  }
  return out;
}
{
  const good = starWrong(GLSL),
    goodF = starWrong(GLSL, true);
  ok(
    good.every((n) => n === 0) && goodF.every((n) => n === 0),
    `(d) an arc star's vertex rows and the rows an ulp or three from them, at 2^-20 / 1 / 2^20: ${good.join(' / ')} wrong, fused ${goodF.join(' / ')}`,
  );
  const rebuilt = GLSL.replace(
    '  arcEndsLoHi(ends, sw.z, pLo, pHi);',
    '  { float q0, q1, q2, q3; arcSample(d1, cp, sp, sw.x, pLo, q0, q1); arcSample(d1, cp, sp, sw.y, pHi, q2, q3); }',
  );
  const bad = starWrong(rebuilt);
  ok(
    bad.some((n) => n > 0),
    `(d) ...and with the ends rebuilt from the angles they are wrong again: ${bad.join(' / ')}`,
  );
}

console.log(fail ? `noAaArcRowSmoke FAIL (${fail})` : 'noAaArcRowSmoke PASS');
process.exit(fail ? 1 : 0);
