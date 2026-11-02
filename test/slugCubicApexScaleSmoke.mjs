// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// slugCubicApexScaleSmoke — the Slug cubic walk answers the same at every coordinate scale (_coverage.glsl
// solveCubicBisect and the H/V cubic walkers, and solveCubicBisect in src/hitTest/bandWinding.js).
//
// THE HAZARD. An apex rule for a sub-interval endpoint within an ABSOLUTE 1e-6 em of the ray (classified as the
// opposite side of its neighbor) reaches 1.05 units of the art at 2^-20, so rows up to a unit away from a vertex
// or a critical point count crossings that are not there; and in float32 it is already below the rounding of
// evalC(cy, 1) once the control values sum to about one em, so on large art a vertex exactly on the ray loses the
// rule it exists for. There is no on-the-ray tolerance at all: 0 counts as non-negative, as in the line walker,
// and a segment's ends are read as p1 and p4 exactly (see slugCubicVertexTouchSmoke), so a vertex on the ray is
// exact. Newton stops on an exact zero slope, not an absolute 1e-12, and an unfilled root slot has t = -1.
//
// (a) seeded cubic contours whose vertices sit on sample rows and columns, or 0.05 to 0.95 units off them,
//     both fill rules: every pixel center reads the same at 2^-20 and 2^20 as at 1;
// (b) every pixel more than 1.5 px from the outline matches an independent winding number at all three scales,
//     rows and columns through a vertex included;
// (c) the shader carries the same forms;
// (d) what the apex rule is for still holds: a 4-cubic ellipse whose side vertices sit exactly on a sample row
//     (the contour CROSSES the ray there) fills that row like its neighbors, at all three scales.
// Mutations, each required to FAIL: an absolute 1e-6 on-the-ray band restored; a root at t = 1 dropped.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// ---- the module under test, and mutations of it -------------------------------------------
const SRC = readFileSync(path.join(ROOT, 'src/hitTest/bandWinding.js'), 'utf8');
const SIDE = 'const sLo = yLo >= 0,\n      sHi = yHi >= 0;';
const mutate = (pairs) => {
  let s = SRC;
  for (const [from, to] of pairs) {
    ok(s.includes(from), `mutation hinge present: ${from.slice(0, 48)}`);
    s = s.split(from).join(to);
  }
  return import('data:text/javascript;base64,' + Buffer.from(s).toString('base64'));
};
const SHIPPED = await import('../src/hitTest/bandWinding.js');
const MUTANTS = [
  [
    'an absolute 1e-6 on-the-ray band restored',
    await mutate([[SIDE, 'const sLo = yLo >= -1e-6, sHi = yHi >= -1e-6;']]),
  ],
  [
    'a root at t = 1 dropped',
    await mutate([
      [
        'if (tsv[j] < 0 || rs[j] !== rs[j]) continue;',
        'if (tsv[j] < 0 || tsv[j] >= 1 || rs[j] !== rs[j]) continue;',
      ],
    ]),
  ],
];

function bundleOf(b) {
  const MF = parseMetaBin(b.meta, b.metaFloatsPerShape).metaFloats;
  return {
    bandF: new Float32Array(b.bands),
    curveF: new Float32Array(b.curves),
    gd: [
      MF[M.META_GLYPH_LOC_X],
      MF[M.META_GLYPH_LOC_Y],
      MF[M.META_BAND_MAX_X],
      MF[M.META_BAND_MAX_Y],
    ],
    bb: [MF[M.META_BBOX_XMIN], MF[M.META_BBOX_YMIN], MF[M.META_BBOX_XMAX], MF[M.META_BBOX_YMAX]],
  };
}
const svgOf = (d, S, evenOdd) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${64 * S} ${64 * S}"><path ${evenOdd ? 'fill-rule="evenodd" ' : ''}d="${d}"/></svg>`;
const cov = (mod, B, x, y, S, evenOdd) =>
  mod.bandFillCoverage(B.bandF, B.curveF, B.gd, B.bb, x * S, y * S, 1 / S, 1 / S, evenOdd);

// ---- the cases ------------------------------------------------------------------------------
let seed = 0xa9e5;
const rnd = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
// a vertex on a pixel-center row/column (k + 0.5), or 0.05..0.95 off one
const coord = (v) => Math.floor(v) + (rnd() < 0.5 ? 0.5 : +(0.05 + 0.9 * rnd()).toFixed(3));
function contour() {
  const k = 3 + Math.floor(rnd() * 4),
    pts = [];
  for (let i = 0; i < k; i++) {
    const a = ((i + rnd() * 0.6) / k) * Math.PI * 2,
      r = 8 + rnd() * 20;
    pts.push([coord(32 + r * Math.cos(a)), coord(32 + r * Math.sin(a))]);
  }
  const parts = [['M', ...pts[0]]];
  for (let i = 1; i <= k; i++) {
    const [x, y] = pts[i % k],
      [px, py] = pts[i - 1],
      nx = py - y,
      ny = x - px,
      u = rnd(),
      s = (rnd() - 0.5) * 1.4;
    // arches get unequal control offsets: a cubic whose leading coefficient cancels to zero trips an absolute test in the
    // IMPORTER's tight bbox at 2^20 (src/svg/bbox.js), which is not what this smoke is about
    if (u < 0.5) {
      const s2 = s * (0.6 + 0.8 * rnd());
      parts.push([
        'C',
        px + (x - px) / 3 + nx * s,
        py + (y - py) / 3 + ny * s,
        px + (2 * (x - px)) / 3 + nx * s2,
        py + (2 * (y - py)) / 3 + ny * s2,
        x,
        y,
      ]);
    } else if (u < 0.8)
      parts.push([
        'C',
        px + (x - px) / 3 + nx * s,
        py + (y - py) / 3 + ny * s,
        px + (2 * (x - px)) / 3 - nx * s,
        py + (2 * (y - py)) / 3 - ny * s,
        x,
        y,
      ]);
    else
      parts.push([
        'C',
        coord(px + (rnd() - 0.5) * 30),
        coord(py + (rnd() - 0.5) * 30),
        coord(x + (rnd() - 0.5) * 30),
        coord(y + (rnd() - 0.5) * 30),
        x,
        y,
      ]);
  }
  return (S) =>
    parts
      .map(
        (p) =>
          p[0] +
          ' ' +
          p
            .slice(1)
            .map((v) => +(v * S).toPrecision(17))
            .join(' '),
      )
      .join(' ') + ' Z';
}
const SCALES = [Math.pow(2, -20), 1, Math.pow(2, 20)];
const cases = [];
let farTotal = 0;
for (let i = 0; i < 50; i++) {
  const d = contour();
  for (const evenOdd of [false, true]) {
    const bundles = new Map();
    for (const S of SCALES)
      bundles.set(
        S,
        bundleOf(await importSvg(svgOf(d(S), S, evenOdd), { preserveViewport: true })),
      );
    const b1 = await importSvg(svgOf(d(1), 1, evenOdd), { preserveViewport: true }),
      rg = b1.curveRangesByShape[0];
    const segs = decodeSegs(bundles.get(1).curveF, rg.begin, rg.end);
    const pl = segs.map((s) => {
      if (s.t !== 2)
        return [
          [s.x0, s.y0],
          [s.x1, s.y1],
        ];
      const o = [];
      for (let k = 0; k <= 300; k++) {
        const t = k / 300,
          u = 1 - t,
          w0 = u * u * u,
          w1 = 3 * u * u * t,
          w2 = 3 * u * t * t,
          w3 = t * t * t;
        o.push([
          w0 * s.x0 + w1 * s.c1x + w2 * s.c2x + w3 * s.x1,
          w0 * s.y0 + w1 * s.c1y + w2 * s.c2y + w3 * s.y1,
        ]);
      }
      return o;
    });
    const far = [];
    for (let yi = 0; yi < 64; yi++)
      for (let xi = 0; xi < 64; xi++) {
        const x = xi + 0.5,
          y = yi + 0.5;
        let dist = Infinity,
          w = 0;
        for (const p of pl)
          for (let j = 0; j + 1 < p.length; j++) {
            const ax = p[j][0] - x,
              ay = p[j][1] - y,
              bx = p[j + 1][0] - x,
              by = p[j + 1][1] - y;
            w += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
            const dx = bx - ax,
              dy = by - ay,
              L2 = dx * dx + dy * dy;
            const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
            dist = Math.min(dist, Math.hypot(ax + t * dx, ay + t * dy));
          }
        if (dist <= 1.5) continue;
        const wn = Math.round(w / (2 * Math.PI));
        far.push({ x, y, want: (evenOdd ? (wn & 1) === 1 : wn !== 0) ? 1 : 0 });
      }
    farTotal += far.length;
    cases.push({ evenOdd, bundles, far });
  }
}
function sweep(mod) {
  let n = 0,
    differ = 0,
    wrong = 0;
  for (const c of cases) {
    for (let yi = 0; yi < 64; yi++)
      for (let xi = 0; xi < 64; xi++) {
        const c1 = cov(mod, c.bundles.get(1), xi + 0.5, yi + 0.5, 1, c.evenOdd);
        for (const S of SCALES)
          if (S !== 1) {
            n++;
            if (cov(mod, c.bundles.get(S), xi + 0.5, yi + 0.5, S, c.evenOdd) !== c1) differ++;
          }
      }
    for (const S of SCALES)
      for (const p of c.far)
        if (Math.abs(cov(mod, c.bundles.get(S), p.x, p.y, S, c.evenOdd) - p.want) > 1e-9) wrong++;
  }
  return { n, differ, wrong };
}
{
  const r = sweep(SHIPPED);
  ok(
    r.n > 300000 && r.differ === 0,
    `(a) every pixel reads the same at 2^-20 and 2^20 as at 1 (${r.differ} of ${r.n} differ)`,
  );
  ok(
    farTotal > 50000 && r.wrong === 0,
    `(b) ${farTotal} pixels per scale more than 1.5 px from the outline match the winding number at all three scales (${r.wrong} wrong)`,
  );
}

// ---- (c) the shader ------------------------------------------------------------------------------
{
  const gl = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8');
  const fn = gl.slice(gl.indexOf('void solveCubicBisect('), gl.indexOf('@@BOX_COV@@'));
  ok(
    /bool sLo = yLo >= 0\.0;/.test(fn) &&
      /sLo != sHi/.test(fn) &&
      !/apexTol|EPS|1e-12/.test(fn.replace(/\/\/[^\n]*/g, '')),
    '(c) solveCubicBisect: no on-the-ray tolerance and no absolute 1e-6 or 1e-12 is left',
  );
  // The Newton step is SAFEGUARDED by the bracket the sign test proved; a zero slope is an exact
  // comparison (it bisects), never an absolute tolerance.
  ok(
    /float xr = clamp\(lo - yLo \* \(hi - lo\) \/ sden, lo, hi\);/.test(fn) &&
      /\(fdy != 0\.0\) \? xr - fy \/ fdy : 0\.5 \* \(bl \+ bh\)/.test(fn),
    '(c) solveCubicBisect: the secant seed is unguarded and a zero slope is only an exact comparison (it bisects the bracket)',
  );
  ok(!/rs\[j\] >= 1e10/.test(gl), '(c) no cubic walker (H, V, band-hard) keeps the 1e10 sentinel');
  // ONE cubic ray walker is left: band-hard's. Slug's H and V walkers are gone (renderFill is the exact box coverage).
  ok(
    (gl.match(/\) >= 0\.0 \|\| max\(max\(p/g) || []).length === 1 &&
      !/hullTol|> 1e-6 \|\|/.test(gl),
    "(c) the hull reject uses the solver's own sides on band-hard's walker, with no tolerance",
  );
}

// ---- (d) a vertex that CROSSES the ray ----------------------------------------------------------------
const ellipse = [];
for (const S of SCALES)
  for (const evenOdd of [false, true]) {
    const cx = 32.5,
      cy = 32.5,
      rx = 20,
      ry = 14,
      kx = 0.5523 * rx,
      ky = 0.5523 * ry,
      n = (v) => +(v * S).toPrecision(17);
    const d =
      `M ${n(cx + rx)} ${n(cy)} C ${n(cx + rx)} ${n(cy + ky)} ${n(cx + kx)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} ` +
      `C ${n(cx - kx)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + ky)} ${n(cx - rx)} ${n(cy)} ` +
      `C ${n(cx - rx)} ${n(cy - ky)} ${n(cx - kx)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} ` +
      `C ${n(cx + kx)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - ky)} ${n(cx + rx)} ${n(cy)} Z`;
    ellipse.push({
      S,
      evenOdd,
      B: bundleOf(await importSvg(svgOf(d, S, evenOdd), { preserveViewport: true })),
    });
  }
function ellipseRowBad(mod) {
  let bad = 0;
  for (const e of ellipse)
    for (let xi = 0; xi < 64; xi++) {
      const x = xi + 0.5,
        want = Math.abs(x - 32.5) < 17 ? 1 : Math.abs(x - 32.5) > 22 ? 0 : -1;
      if (want < 0) continue; // the ramp at the side vertices themselves
      if (Math.abs(cov(mod, e.B, x, 32.5, e.S, e.evenOdd) - want) > 1e-9) bad++;
    }
  return bad;
}
{
  const bad = ellipseRowBad(SHIPPED);
  ok(
    bad === 0,
    `(d) the row through a 4-cubic ellipse's side vertices fills like its neighbors at 2^-20, 1 and 2^20, both fill rules (${bad} pixels wrong)`,
  );
}

// ---- mutations ----------------------------------------------------------------------------------
for (const [name, mod] of MUTANTS) {
  const r = sweep(mod),
    e = ellipseRowBad(mod);
  ok(
    r.differ > 0 || r.wrong > 0 || e > 0,
    `mutation "${name}" is caught: ${r.differ} pixels off scale 1, ${r.wrong} far pixels wrong, ${e} ellipse-row pixels wrong`,
  );
}

if (fail) {
  console.error(`SLUG-CUBIC-APEX-SCALE FAIL (${fail})`);
  process.exit(1);
}
console.log('SLUG-CUBIC-APEX-SCALE PASS');
