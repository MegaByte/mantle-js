// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeCurveCapSvgShapeSmoke — the butt-end plane on CURVES: a free butt end's plane cuts the pixels just
// INSIDE it, not only those past the end (_strokeMath.glsl, strokeCapsJoinsDash).
//
// SVG 2 (https://www.w3.org/TR/svg-strokes/, "Computing the shape of the stroke") builds a dash's
// body from "all points that lie on the line perpendicular to the subpath at that distance and
// which are within distance stroke-width/2 of the point on the subpath at that position", and a
// butt cap adds nothing. So the shape ENDS at the perpendicular through the endpoint: that line is
// a boundary of the stroke, and a pixel whose box straddles it is a partial.
//
// The hazard. Every cap branch in strokeCapsJoinsDash is behind `t < 1e-4` / `t > 1 - 1e-4` — the
// closest point being the endpoint — which is only true for pixels PAST the end. The pixels just
// INSIDE have an interior closest point, take the body distance, and would paint solid; only the
// outer half of the end's AA ramp would exist, and a center exactly on the plane would go solid or
// half by the rounding of the fragment. (That `1e-4` is also a PARAMETER-space tolerance, so the
// sliver it does cover is wide in pixels on a short curve and vanishing on a long one.)
// _coverage.glsl's LINE branch takes max(perpendicular, halfW + distance past the plane) on every body hit.
//
// Why the line fix does not carry over, and what replaces it. A curve can fold back behind its own
// start plane, and the unconditional term erases the returning arm. The term therefore carries a
// LOCALITY TEST with two halves, both load-bearing:
//   aOut <= 0            the term may only LOWER the coverage of a pixel the shape already
//                        contains, so membership at d <= halfW cannot move. That is the invariant
//                        the line fix has for free — a line's body hit is always in front of its
//                        own end plane, a curve's is not — and it is why src/hitTest/curveGeom.js
//                        needs no twin of this fix.
//   |lateral| <= halfW   the end plane bounds the stroke only ACROSS THE BUTT SEGMENT ITSELF. For a
//                        circular arc the body is an annulus SECTOR whose start boundary is exactly
//                        that radial segment of half-length halfW; past it the plane is not the
//                        boundary at all, and a fold-back arm crossing in front of it would take a
//                        hairline of partial coverage straight across its own body.
//
// This carries a CPU model of the shader's QUAD branch (test/_strokeCurveRef.mjs — quads because
// strokeQuadAccum, strokeCubicAccum and strokeArcAccum all hand caps, joins and dashes to the one
// strokeCapsJoinsDash, and a quad's closest point is a cubic root, solved in closed form, so no
// Newton residual is in the measurement), the exact SVG 2 shape of a chain of quads, and seeded
// random poly-quads a quarter of which fold back hard. It checks:
//   (a) MEMBERSHIP: the plane moves no pixel of any case, at three coordinate scales — the aOut <= 0
//       half, and the reason the hit test needs no twin;
//   (b) CONFINED: it moves no pixel of a case without a free butt end;
//   (c) AA: over the pixels it does move, the error against 8x8 box coverage falls;
//   (d) THE RAMP: on one quad it is 0.75 / 0.5 / 0.25 a quarter pixel inside, on, and a quarter
//       past the start plane, where the body distance alone gives 1 / 0.5 / 0.25;
//   (e) the locality test is load-bearing — without it the term erases centers SVG 2 puts inside,
//       and the parameter-space form it replaces is scale-dependent (same pixels, longer curve,
//       different answer);
//   (f) END TO END: importSvg, then the band-walk emulator (test/_strokeBandEmu.mjs: cover quad,
//       band pick, break / far / saturation gates) over the quad sub-loop;
//   (g) the shader spells both halves of the test, and the line twin is still there.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  makeCurveCases,
  pixelsCurve,
  minDistCurve,
  coverageCurve,
  svgInsideCurve,
  quadSegs,
  coverageTail,
} from './_strokeCurveRef.mjs';
import { makeStrokeEmu, strokeRowsOf } from './_strokeBandEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const CAPS = ['butt', 'round', 'square'],
  JOINS = ['miter', 'round', 'bevel', 'miter-clip', 'arcs'];
const cases = makeCurveCases(0x2c17, 200);
const scaled = (cs, S) => ({
  ...cs,
  halfW: cs.halfW * S,
  segs: quadSegs(
    cs.Q.map((q) => q.map((p) => [p[0] * S, p[1] * S])),
    cs.closed,
  ),
});

// ---- (a) membership ------------------------------------------------------------------------------
{
  for (const S of [1, 1e-3, 1e3]) {
    let moved = 0,
      n = 0;
    for (const cs0 of cases) {
      const cs = S === 1 ? cs0 : scaled(cs0, S);
      for (const c0 of pixelsCurve(cs0)) {
        const c = [c0[0] * S, c0[1] * S];
        n++;
        const a =
          minDistCurve('fixed', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <=
          cs.halfW;
        const b =
          minDistCurve('buttPastEnd', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit)
            .minD <= cs.halfW;
        if (a !== b) moved++;
      }
    }
    ok(
      n > 100000 && moved === 0,
      `(a) moves the membership of ${moved} of ${n} pixel centers at coordinate scale ${S}`,
    );
  }
}

// ---- (b) confined, and (c) the AA it buys ---------------------------------------------------------
function aaOver(a, b, keep, N = 8) {
  let changed = 0,
    eA = 0,
    eB = 0,
    closer = 0,
    same = 0,
    farther = 0,
    worst = 0;
  for (const cs of cases) {
    if (!keep(cs)) continue;
    for (const c of pixelsCurve(cs)) {
      const ca = coverageCurve(a, c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      const cb = coverageCurve(b, c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      if (ca === cb) continue;
      let k = 0;
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++)
          if (
            svgInsideCurve(
              [c[0] - 0.5 + (i + 0.5) / N, c[1] - 0.5 + (j + 0.5) / N],
              cs.segs,
              cs.closed,
              cs.halfW,
              cs.cap,
              cs.joinStyle,
              cs.miterLimit,
            )
          )
            k++;
      const t = k / (N * N),
        dA = Math.abs(ca - t),
        dB = Math.abs(cb - t);
      changed++;
      eA += dA;
      eB += dB;
      if (dA < dB - 0.07) closer++;
      else if (dA > dB + 0.07) {
        farther++;
        worst = Math.max(worst, dA - dB);
      } else same++;
    }
  }
  return { changed, eA, eB, closer, same, farther, worst };
}
{
  const other = aaOver('fixed', 'buttPastEnd', (cs) => cs.closed || cs.cap !== 0);
  ok(other.changed === 0, `(b) moves ${other.changed} pixels of cases with no free butt end`);
  const r = aaOver('fixed', 'buttPastEnd', (cs) => !cs.closed && cs.cap === 0);
  ok(
    r.changed > 100 && r.eA < r.eB * 0.5,
    `(c) ${r.changed} butt-capped pixels change; summed error against 8x8 box coverage ${r.eB.toFixed(1)} -> ${r.eA.toFixed(1)}`,
  );
  console.log(
    `       ${r.closer} closer, ${r.same} within one 8x8 sample, ${r.farther} farther (worst +${r.worst.toFixed(2)})`,
  );
}

// ---- (d) the ramp across the start plane ----------------------------------------------------------
{
  // one quad from (0,0) heading +x, halfW 2, butt caps: the start plane is x = 0
  const segs = quadSegs(
    [
      [
        [0, 0],
        [10, 0],
        [20, 6],
      ],
    ],
    false,
  );
  const ramp = (rule) => [0.25, 0, -0.25].map((x) => coverageCurve(rule, [x, 0], segs, 2, 0, 0, 4));
  const rN = ramp('fixed'),
    rO = ramp('buttPastEnd');
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  ok(
    near(rN, [0.75, 0.5, 0.25]),
    `(d) across the start plane the coverage ramps: ${rN.join(', ')} at 0.25 inside, on, and 0.25 past it`,
  );
  ok(
    !near(rO, [0.75, 0.5, 0.25]) && rO[0] === 1,
    `(d) mutation "the butt-end plane reverted" is caught: ${rO.join(', ')} — solid a quarter pixel inside, so only the outer half of the ramp existed`,
  );
}

// ---- (e) the locality test -------------------------------------------------------------------------
{
  let erased = 0,
    n = 0,
    foldCases = 0;
  for (const cs of cases) {
    if (cs.closed || cs.cap !== 0) continue;
    let hit = false;
    for (const c of pixelsCurve(cs)) {
      n++;
      const inSvg = svgInsideCurve(
        c,
        cs.segs,
        cs.closed,
        cs.halfW,
        cs.cap,
        cs.joinStyle,
        cs.miterLimit,
      );
      const inNo =
        minDistCurve('noLocality', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit)
          .minD <= cs.halfW;
      if (inSvg && !inNo) {
        erased++;
        hit = true;
      }
    }
    if (hit) foldCases++;
  }
  ok(
    erased > 100,
    `(e) mutation "the locality test removed" is caught: the plane erases ${erased} of ${n} centers SVG 2 puts inside, in ${foldCases} cases — a curve's own body where it folds back`,
  );
  // the parameter-space gate (the one the cap branches use, t < 1e-4): the same pixel
  // geometry — halfW 2, a quarter of a unit inside the start plane — against curves of two LENGTHS.
  // A tolerance on t is a tolerance in em of 1e-4 of the curve's own length, so it covers 0.001 of
  // a unit on a short curve and 2 units on a long one; the answer depends on the curve, not the
  // pixel. The shipped gate is geometric and gives the same answer for both.
  const line = (L) =>
    quadSegs(
      [
        [
          [0, 0],
          [L / 2, 0],
          [L, 0],
        ],
      ],
      false,
    );
  const at = (rule, L) => coverageCurve(rule, [0.25, 0], line(L), 2, 0, 0, 4);
  const tShort = at('tGate', 10),
    tLong = at('tGate', 20000);
  ok(
    Math.abs(tShort - tLong) > 0.1,
    `(e) mutation "the plane gated in parameter space" is caught: the same pixel a quarter unit inside the plane reads ${tShort} on a curve 10 units long and ${tLong} on one 20000 long`,
  );
  ok(
    Math.abs(at('fixed', 10) - at('fixed', 20000)) < 1e-9 && at('fixed', 10) === 0.75,
    `(e) the shipped gate is geometric: ${at('fixed', 10)} for both`,
  );
}

// ---- (f) end to end: the importer's pad, bands and cover quad ---------------------------------------
{
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const { default: importSvg } = await import('../src/svg/importer.js');
  let n = 0,
    unpainted = 0,
    outside = 0,
    offQuad = 0,
    skipped = 0,
    rows = 0;
  for (const cs of cases) {
    if (cs.closed || cs.cap !== 0) continue;
    const d =
      `M ${cs.Q[0][0][0]} ${cs.Q[0][0][1]} ` +
      cs.Q.map(([, b, e]) => `Q ${b[0]} ${b[1]} ${e[0]} ${e[1]}`).join(' ');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-100 -100 200 200"><path d="${d}" fill="none"` +
      ` stroke="#000" stroke-width="${2 * cs.halfW}" stroke-linecap="${CAPS[cs.cap]}"` +
      ` stroke-linejoin="${JOINS[cs.joinStyle]}" stroke-miterlimit="${cs.miterLimit}"/></svg>`;
    const b = await importSvg(svg);
    const row = strokeRowsOf(b)[0];
    if (row == null) continue;
    rows++;
    const emu = makeStrokeEmu(b, row, { gates: true, kind: 'quad' });
    const eps = 1e-4 * cs.halfW;
    for (const c of pixelsCurve(cs)) {
      const port =
        minDistCurve('fixed', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <=
        cs.halfW;
      // centers within a relative hair of the port's own boundary: the bundle is float32
      if (
        [
          [eps, 0],
          [-eps, 0],
          [0, eps],
          [0, -eps],
        ].some(
          ([dx, dy]) =>
            minDistCurve(
              'fixed',
              [c[0] + dx, c[1] + dy],
              cs.segs,
              cs.halfW,
              cs.cap,
              cs.joinStyle,
              cs.miterLimit,
            ).minD <=
              cs.halfW !==
            port,
        )
      ) {
        skipped++;
        continue;
      }
      n++;
      const r = emu.eval(c),
        painted = r.inQuad && r.minD <= cs.halfW;
      if (port && !painted) {
        unpainted++;
        if (!r.inQuad) offQuad++;
      }
      if (!port && painted) outside++;
    }
  }
  ok(
    rows > 30 && n > 50000 && unpainted === 0 && outside === 0,
    `(f) end to end over ${rows} butt-capped curve rows: of ${n} centers ${unpainted} unpainted and ${outside} painted outside (${offQuad} outside the cover quad; ${skipped} on a boundary skipped)`,
  );
}

// ---- (g) the shader text ---------------------------------------------------------------------------
{
  const sm = readFileSync(path.join(ROOT, 'src/shaders/_strokeMath.glsl'), 'utf8');
  const pin = (re, m) => ok(re.test(sm), `(g) ${m}`);
  pin(
    /if \(!drop && t > 1e-4 && t < 1\.0 - 1e-4\) \{/,
    '_strokeMath.glsl: the end plane is applied on a BODY hit, not only at t ~ 0 / 1',
  );
  // (Each also has two more gates: the pixel's closest point is the end's own stretch, and it lies short of the center of
  // curvature, kL <= 1; strokeCurveButtPlaneSmoke shows each carries weight)
  pin(
    /float aOut = dot\(qv, -sn\), lat = dot\(qv, vec2\(-sn\.y, sn\.x\)\), kL = curv\.x \* lat;\s*bool own = aOut <= 0\.0 && [^;]*;\s*if \(own && abs\(lat\) <= halfW && kL <= 1\.0\) endD = halfW \+ aOut;/,
    'start: both halves of the locality test (in front of the plane, and within halfW across it)',
  );
  pin(
    /float aOut = dot\(qv, en\), lat = dot\(qv, vec2\(-en\.y, en\.x\)\), kL = curv\.y \* lat;\s*bool own = aOut <= 0\.0 && [^;]*;\s*if \(own && abs\(lat\) <= halfW && kL <= 1\.0\) endD = max\(endD, halfW \+ aOut\);/,
    'end: the same',
  );
  pin(
    /if \(endD > thisD\) \{ thisD = endD; gradIO = vec2\(0\.0\); \}/,
    'and the plane hands back a zero gradient, as the cap branches do',
  );
  const gl = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8');
  ok(
    /if \(freeStart && startCap == 0\) endD = halfW \+ dot\(cq - a, -segTan\);\s*if \(freeEnd && endCap == 0\) endD = max\(endD, halfW \+ dot\(cq - b, segTan\)\);/.test(
      gl,
    ),
    '(g) _coverage.glsl: the LINE twin is unchanged and still unconditional',
  );
}

if (fail) {
  console.error(`STROKE-CURVE-CAP-SVG-SHAPE FAIL (${fail})`);
  process.exit(1);
}
console.log(`STROKE-CURVE-CAP-SVG-SHAPE PASS (${(performance.now() / 1000).toFixed(1)} s)`);
