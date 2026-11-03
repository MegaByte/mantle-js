// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// slugArcRowSmoke — a pixel near an ARC's endpoint reads the exact answer (the arc's crossings of a ray are counted
// from the endpoint SIDES, like every other segment type's, and not from a tolerance window).
//
// THE HAZARD. An arc walker that asks "is this endpoint ON the ray?" as `|u| < tol` — 1e-5 of |center| + |rx| + |ry|
// on the crossing axis — and where it says yes SYNTHESIZES a crossing from the arc's heading and drops the root the
// endpoint owns is wrong for an endpoint strictly on the far side of the ray but inside that window: it is not on the
// ray, and the rule invents a crossing the outline does not have, or drops one it does. One miscounted crossing is a
// whole unit of winding on every pixel of that row left of the vertex, and where it CANCELS the winding -- a vertex
// inside a filled region -- the pixel reads empty. Band-hard counts from the endpoint sides (test/noAaArcRowSmoke.mjs)
// and the default kernel counts no ray at all (renderFill is the exact walk, which integrates the arc), so what is
// held here is the ANSWER at those pixels, through the shader, and the ray walk's CPU model (hitTest/bandWinding.js)
// that band-hard's conventions are checked against.
//
// THE REFERENCE IS THE PATH. `rowSpans` (src/renderer/cpatchConvert.js) answers "is this pixel center inside?"
// exactly, with no renderer, and a pixel more than 1.5 px from every outline is solid or empty under any AA. The kernel
// side is the SHIPPED shader text run in float32 on the CPU (test/_glslEmu.mjs).
//
// (a) the constructed rows: a lone arc endpoint with open space left of it, alone and inside a filled rectangle of
//     either orientation, authored and transposed, on rows across +-4x that window and the row through the vertex:
//     the exact answer there is the reference row's (the window's rows are no special case of the geometry);
// (b) ...and the drawn coverage there is the exact answer — under the window rule the rectangle's interior reads EMPTY;
// (c) the ray walk's CPU model gives the same answers;
// (d) arc-heavy drawings a thousand em from the origin (what makes that window span pixel rows) at 512 and 1024:
//     every pixel center more than 1.5 px from the outline reads the exact answer — the drawn coverage and the CPU
//     model.
// (e) a ray TANGENT to an arc: circles centered on a pixel center put rows and columns exactly on a tangent. Through the
//     shader every pixel of those circles is its exact box coverage to 1e-4 (a two-ray estimate that keeps the tangent
//     pair in its ramp weight draws 0.25 for 0.46 there).
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_SLUG } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const { bandFillCoverage } = await import('../src/hitTest/bandWinding.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- the kernel: the default program's drawn coverage (renderFill) -------------------------------------------------
const SHADER = hasCxx();
let emu = null;
if (SHADER)
  emu = {
    cov: buildGlslEmu(ROOT, {
      glsl: readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8'),
    }),
  };
else
  console.log(
    '  SKIPPED (shader arms): no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation; the CPU model still runs',
  );
const runAll = (F, qs) => (SHADER ? { cov: emu.cov.run(F.band, F.curve, qs) } : null);

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

// ---- (a)-(c) the constructed rows ---------------------------------------------------------------------------------
// noAaArcRowSmoke's two lobes, each an arc with ONE end on the row y = VY (its other end is at VY - R): a line runs
// down to (200, VY) and an arc leaves it, and the second lobe's arc sweeps the other way. Alone, the space left of the
// lobes is empty; inside a rectangle it is filled, with the rectangle wound either way — which decides whether a
// spurious crossing raises the winding (hidden by the fold) or cancels it (an empty row inside the fill).
const VY = 100,
  R = 50;
const OLD_TOL = 1e-5 * (Math.abs(VY) + R + R); // arcOnRayTol of the lobes' arcs: |cy| + rx + ry
const LOBES = `M 200 0 L 200 ${VY} A ${R} ${R} 0 0 1 250 ${VY - R} L 250 0 Z M 305 0 L 305 ${VY} A ${R} ${R} 0 0 0 355 ${VY - R} L 355 0 Z`;
const FIXTURES = [
  ['lobes alone', `M 0 0 L 40 0 L 40 300 L 0 300 Z ${LOBES}`],
  ['lobes in a rectangle wound one way', `M -20 -20 L 380 -20 L 380 320 L -20 320 Z ${LOBES}`],
  [
    'lobes in a rectangle wound the other way',
    `M -20 -20 L -20 320 L 380 320 L 380 -20 Z ${LOBES}`,
  ],
];
// every one more than 1.5 units from any outline: left of the first lobe, and between the two
const XS = [60.5, 100.5, 150.5, 190.5, 270.5, 290.5];
const ROWS = (() => {
  const out = new Set([VY]);
  for (let k = -16; k <= 16; k++) out.add(Math.fround(VY + (k * OLD_TOL) / 4));
  return [...out].sort((a, b) => a - b);
})();
// A row just OUTSIDE the window on each side: no outline lies between it and any row of the sweep on the same
// side at the sampled x, so its count is the count every such row must have, and its exact answer theirs. The vertex
// row itself is the NON-NEGATIVE side's (a centered y of exactly 0 counts as non-negative), i.e. the rows ABOVE it.
// The exact answer is read on the reference row because rowSpans cannot be asked ON the vertex row: a scanline that
// only TOUCHES the outline at a vertex is ambiguous to it, and it reads (60.5, 100) inside the rectangle wound the
// other way as empty. Every other row of the sweep is checked against rowSpans directly as well.
const REF_BELOW = Math.fround(VY + 5 * OLD_TOL),
  REF_ABOVE = Math.fround(VY - 5 * OLD_TOL);
const refRow = (y) => (y > VY ? REF_BELOW : REF_ABOVE);
const svgOf = (d, transposed) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-40 -40 440 400"><path ${transposed ? 'transform="matrix(0 1 1 0 0 0)" ' : ''}d="${d}" fill="#000"/></svg>`;

const rowBad = { cov: [], cpu: [], oracle: [] };
let rowN = 0;
for (const [name, d] of FIXTURES)
  for (const transposed of [false, true]) {
    const F = await load(svgOf(d, transposed));
    const sh = F.shapes[0];
    const ray = transposed ? 'V' : 'H';
    const rows = [...ROWS, REF_BELOW, REF_ABOVE];
    const qs = [],
      meta = [];
    for (const y of rows)
      for (const x of XS) {
        const c = transposed ? [y, x] : [x, y];
        qs.push({ k: K_SLUG, GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [1, 1] });
        meta.push({ y, x, c });
      }
    const r = runAll(F, qs);
    meta.forEach((m, i) => {
      if (m.y === REF_BELOW || m.y === REF_ABOVE) return;
      rowN++;
      const at = `${name}, ${ray} ray, row ${((m.y - VY) / OLD_TOL).toFixed(2)} x window, ${m.x}`;
      const want = transposed
        ? insideAt(sh.segs, refRow(m.y), m.x, sh.eo)
        : insideAt(sh.segs, m.x, refRow(m.y), sh.eo);
      if (m.y !== VY && insideAt(sh.segs, m.c[0], m.c[1], sh.eo) !== want) rowBad.oracle.push(at);
      if (r && Math.abs(r.cov[i] - want) > 1e-5)
        rowBad.cov.push(`${at}: coverage ${r.cov[i]} (exact ${want})`);
      const cpu = bandFillCoverage(F.band, F.curve, sh.GD, sh.bb, m.c[0], m.c[1], 1, 1, sh.eo);
      if (Math.abs(cpu - want) > 0.5) rowBad.cpu.push(`${at}: CPU ${cpu} (exact ${want})`);
    });
  }
const first = (a) => (a.length ? ` — first: ${a[0]}` : '');
ok(
  rowBad.oracle.length === 0,
  `(a) the exact answer is the reference row's on every row of the sweep off the vertex (${rowBad.oracle.length} differ${first(rowBad.oracle)})`,
);
if (SHADER)
  ok(
    rowBad.cov.length === 0,
    `(b) ${rowN} pixel centres on ${ROWS.length} rows across +-4x the window (${OLD_TOL.toExponential(1)} em) and through the vertex, 3 fixtures authored and transposed: ` +
      `the drawn coverage is the exact answer to 1e-5 at all of them (${rowBad.cov.length} wrong${first(rowBad.cov)})`,
  );
ok(
  rowBad.cpu.length === 0,
  `(c) the ray walk's CPU model agrees with the exact answer at all of them (${rowBad.cpu.length} wrong${first(rowBad.cpu)})`,
);

// ---- (d) arc-heavy art far from the origin --------------------------------------------------------------------------
// The window is 1e-5 of |center| + rx + ry, so distance from the origin is what makes it wide enough to catch pixel
// rows. Rounded boxes (quadrant arc endpoints meeting lines) and rotated half-ellipses; noAaArcRowSmoke's drawings.
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
const FARS = [];
for (const s of [1, 3, 11, 13, 17, 19, 23, 29]) FARS.push(await load(farArt(1000, 300, s)));
/// A pixel center is SETTLED when the exact answer is the same at it and at +-1.5 px on both axes and both diagonals.
function settled(sh, x, y, px) {
  const v = insideAt(sh.segs, x, y, sh.eo);
  for (const dy of [-1.5, 0, 1.5])
    for (const dx of [-1.5, 0, 1.5])
      if (insideAt(sh.segs, x + dx * px, y + dy * px, sh.eo) !== v) return -1;
  return v;
}
function farWrong(N) {
  const w = { n: 0, cov: 0, cpu: 0 };
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
        want = [];
      const i0 = Math.floor((sh.bb[0] - x0) / px) - 2,
        i1 = Math.ceil((sh.bb[2] - x0) / px) + 2;
      const j0 = Math.floor((sh.bb[1] - y0) / px) - 2,
        j1 = Math.ceil((sh.bb[3] - y0) / px) + 2;
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const c = [Math.fround(x0 + (i + 0.5) * px), Math.fround(y0 + (j + 0.5) * px)];
          const v = settled(sh, c[0], c[1], px);
          if (v < 0) continue;
          qs.push({ k: K_SLUG, GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [px, px] });
          want.push(v);
        }
      const r = runAll(FAR, qs);
      for (let i = 0; i < qs.length; i++) {
        w.n++;
        const c = qs[i].c;
        if (r && Math.abs(r.cov[i] - want[i]) > 0.5) w.cov++;
        if (
          Math.abs(
            bandFillCoverage(FAR.band, FAR.curve, sh.GD, sh.bb, c[0], c[1], 1 / px, 1 / px, sh.eo) -
              want[i],
          ) > 0.5
        )
          w.cpu++;
      }
    }
  }
  return w;
}
for (const N of [512, 1024]) {
  const w = farWrong(N);
  if (SHADER) {
    ok(
      w.n > 250000 && w.cov === 0,
      `(d) at ${N}: the drawn coverage reads the exact answer at all ${w.n} settled pixel centers of 8 drawings 1000 em from the origin (${w.cov} wrong; the window rule gives ${N === 512 ? 197 : 778})`,
    );
  }
  ok(
    w.cpu === 0,
    `(d) at ${N}: the ray walk's CPU model reads the exact answer at all ${w.n} of them (${w.cpu} wrong)`,
  );
}

// ---- (e) tangent rows and columns --------------------------------------------------------------------------------
if (SHADER) {
  // the exact area of a disc of radius r centered at the origin inside [x0,x1]x[y0,y1] (smallRadiusAaSmoke's closed form)
  const F = (x, y, r) => {
    const a = Math.min(Math.max(x, 0), r),
      b = Math.min(Math.max(y, 0), r);
    if (a * a + b * b <= r * r) return a * b;
    const xa = Math.min(a, Math.sqrt(Math.max(r * r - b * b, 0)));
    const I = (t) =>
      0.5 * (t * Math.sqrt(Math.max(r * r - t * t, 0)) + r * r * Math.asin(Math.min(1, t / r)));
    return xa * b + (I(a) - I(xa));
  };
  const S = (x, y, r) => Math.sign(x) * Math.sign(y) * F(Math.abs(x), Math.abs(y), r);
  const discBox = (x0, y0, x1, y1, r) => S(x1, y1, r) - S(x0, y1, r) - S(x1, y0, r) + S(x0, y0, r);
  const circles = [];
  for (const r of [1, 2, 4, 8]) {
    const C = 16 * r + 0.5; // a pixel center: the rows and columns through cy +- r are tangent
    const F2 = await load(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${32 * r} ${32 * r}"><circle cx="${C}" cy="${C}" r="${r}" fill="#000"/></svg>`,
    );
    const sh = F2.shapes[0],
      qs = [],
      want = [];
    for (let jx = Math.floor(C) - r - 2; jx <= Math.floor(C) + r + 2; jx++)
      for (let jy = Math.floor(C) - r - 2; jy <= Math.floor(C) + r + 2; jy++) {
        qs.push({
          k: K_SLUG,
          GD: sh.GD,
          bb: sh.bb,
          eo: sh.eo,
          c: [jx + 0.5, jy + 0.5],
          ePx: [1, 1],
        });
        want.push(discBox(jx - C, jy - C, jx + 1 - C, jy + 1 - C, r));
      }
    circles.push({ r, F2, qs, want });
  }
  const worst = (e) => {
    let w = 0,
      at = '';
    for (const { r, F2, qs, want } of circles) {
      const got = e.run(F2.band, F2.curve, qs);
      for (let i = 0; i < qs.length; i++)
        if (Math.abs(got[i] - want[i]) > w) {
          w = Math.abs(got[i] - want[i]);
          at = `r=${r} (${qs[i].c}) drew ${got[i].toFixed(3)} for ${want[i].toFixed(3)}`;
        }
    }
    return { w, at };
  };
  const shipped = worst(emu.cov);
  ok(
    shipped.w <= 1e-4,
    `(e) pixel-aligned circles r = 1, 2, 4, 8 px through the shader: every pixel within ${shipped.w.toExponential(1)} of its exact box coverage (bar 1e-4; worst ${shipped.at})`,
  );
}

console.log(fail ? `SLUG-ARC-ROW FAIL (${fail})` : 'SLUG-ARC-ROW PASS');
process.exit(fail ? 1 : 0);
