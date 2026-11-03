// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeCurveJoinSvgShapeSmoke — the CURVE path's joins (_strokeMath.glsl,
// strokeCapsJoinsDash) against the SVG 2 stroke shape, and the reach of an arcs join.
//
// SVG 2 (https://www.w3.org/TR/svg-strokes/, "Computing the shape of the stroke"), verbatim, for a
// join between segments whose tangent lines are A and B, with P1 / P2 the outer offset points and
// P3 their intersection:
//   miter, miter-clip : "the line join region is the union of bevel and the triangle formed from
//                        the three points P1, P2 and P3... If 1 / sin(theta / 2) <=
//                        stroke-miterlimit, then return the line join region. If stroke-linejoin is
//                        miter-clip, then clip any part of the line join region that extends past
//                        the miter limit and return this region. Return bevel."
//   arcs              : "...Extend the stroke edges using these circles... Next calculate the miter
//                        limit... Clip any part of the line join region that extends past the miter
//                        limit. Return the resulting region."
//
// Three hazards in the curve branch, which _coverage.glsl's LINE branch does not share for the first two:
//   * MITER-CLIP MUST CLIP, NOT CAP THE ALONG-TANGENT EXTENT. Clamping miterLen to miterLimit * halfW
//     and then bounding `along` by the clamped value times cos(theta / 2) cuts the kite square across
//     the TANGENT, where SVG 2 cuts it square to the BISECTOR, and the second cos(theta / 2) shortens
//     it again.
//   * A CURVE MITER PAST ITS LIMIT MUST NOT DRAW ROUND. Adding nothing leaves `thisD`, which at a join
//     vertex IS the radial distance, so the over-limit join would keep a full halfW disc where SVG 2
//     draws the bevel triangle.
//   * AN ARCS JOIN PAST ITS LIMIT MUST NOT BEVEL. SVG 2 clips it; it never returns bevel.
// And one bound: src/bundle/strokeReach.js assumes an arcs join stays within halfW *
// sqrt(miterLimit^2 + 1). Between STRAIGHT segments it does (SVG 2 sends arcs to miter-clip there).
// Between CURVED ones the branch paints the intersection of two osculating-circle BANDS, and those
// bands meet again on the far side of the circles, so uncut its reach is 2 / |kappa| + halfW — 201
// half-widths at kappa * halfW = 0.01, at every miter limit. The branch cuts its region at that
// bound, which makes the assumption true by construction. It is not a claim about SVG 2, whose own
// arcs region between curved segments EXCEEDS the bound (measured below); the renderer draws a band
// intersection, not that region.
//
// Checks, over the port in test/_strokeCurveRef.mjs and the exact SVG 2 shape there:
//   (a) the curve rule's joins answer what the LINE rule answers — the same polylines drawn as
//       DEGENERATE quads, whose line answers test/strokeLineJoinSvgShapeSmoke.mjs proves exact;
//   (b) on curved poly-quads, a miter past its limit stops painting outside the shape;
//   (c) AA: over the pixels each fix moves, the error against 8x8 box coverage falls;
//   (d) the miter-clip geometry itself: a named over-limit join, cut on the bisector at
//       miterLimit * halfW, where a tangent cut lands somewhere else;
//   (e) mutations — the round shoulder restored, the clip line dropped, arcs bevelling past the
//       limit, the arcs cut removed — each have to be caught;
//   (f) THE REACH: straight/straight arcs reaches sqrt(miterLimit^2 + 1) and no more; the uncut
//       band intersection reaches 2 / |kappa| + halfW; the cut holds it at the bound; and SVG 2's
//       own arcs region between curved segments is measured against it;
//   (g) END TO END: importSvg, then the band-walk emulator (cover quad, band pick, gates);
//   (h) the shader and src/hitTest/curveGeom.js spell the same rule.
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
  rendererArcsReach,
  svgArcsReach,
  norm,
} from './_strokeCurveRef.mjs';
import { makeStrokeCases, pixels, minDist, svgInside, JOINS } from './_strokeShapeRef.mjs';
import { makeStrokeEmu, strokeRowsOf } from './_strokeBandEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const CAPS = ['butt', 'round', 'square'];
const cases = makeCurveCases(0x2c17, 200);

// ---- (a) the same shape, drawn by the curve rule ---------------------------------------------------
// Every polyline case of test/_strokeShapeRef.mjs re-expressed as DEGENERATE quads (control point at
// the midpoint). The line rule is exact against SVG 2 there, so any disagreement is the curve rule's.
{
  const polys = makeStrokeCases(0x51de, 360);
  const tally = {};
  for (const cs of polys) {
    const Q = cs.segs.map((s) => [s.a, [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2], s.b]);
    const qsegs = quadSegs(Q, cs.closed);
    const t = (tally[JOINS[cs.joinStyle]] ??= {
      n: 0,
      line: 0,
      base: 0,
      fixed: 0,
      out: 0,
      preOut: 0,
    });
    for (const c of pixels(cs)) {
      const sv = svgInside(c, cs.P, cs.closed, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      t.n++;
      if (
        minDist('fixed', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <=
          cs.halfW !==
        sv
      )
        t.line++;
      for (const rule of ['miterClipClamp', 'fixed'])
        if (
          minDistCurve(rule, c, qsegs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <=
            cs.halfW !==
          sv
        )
          t[rule === 'fixed' ? 'fixed' : 'base']++;
      // The wedge rule, split out by DIRECTION: its job is to stop painting where SVG 2 does not. What
      // is left is an UNDER-paint, which it does not address.
      if (
        minDistCurve('fixed', c, qsegs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <=
          cs.halfW &&
        !sv
      )
        t.out++;
      if (
        minDistCurve('wedgeVertexDrop', c, qsegs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit)
          .minD <= cs.halfW &&
        !sv
      )
        t.preOut++;
    }
  }
  for (const j of ['miter', 'arcs']) {
    const t = tally[j];
    ok(
      t.line === 0 && t.fixed < t.base * 0.75,
      `(a) ${j}, the polylines drawn as quads: the curve rule disagrees with SVG 2 at ${t.base} of ${t.n} centers under the base rule and ${t.fixed} under the current one (the line rule: ${t.line})`,
    );
  }
  for (const j of ['round', 'bevel']) {
    const t = tally[j];
    ok(t.fixed === t.base, `(a) ${j} is untouched: ${t.base} -> ${t.fixed} disagreements`);
  }
  const mc = tally['miter-clip'];
  console.log(`       miter-clip ${mc.base} -> ${mc.fixed} of ${mc.n}`);
  // outside the wedge the curve branch ends in a BUTT end, as the line branch does (the mutation falls
  // through to the radial halfW disc), and on this population -- straight segments, where the line
  // rule is exact -- the curve rule paints nothing outside the shape. What remains is an UNDER-paint,
  // which the wedge rule does not close and slightly enlarges.
  ok(
    ['miter', 'miter-clip', 'arcs'].every((j) => tally[j].out === 0 && tally[j].preOut > 0),
    `(a) nothing painted outside the SVG 2 shape for miter, miter-clip or arcs — ` +
      ['miter', 'miter-clip', 'arcs']
        .map((j) => `${j} ${tally[j].preOut} -> ${tally[j].out}`)
        .join(', '),
  );
  // The residual UNDER-paint is printed, not asserted: a reference cubic solver that loses the interior
  // root of a near-straight quad shows up here, and so does a round/bevel join-wedge defect.
  // test/strokeCurveSolverRefSmoke.mjs and test/strokeCurveRoundBevelWedgeSmoke.mjs own both.
  const resid = ['miter', 'miter-clip', 'arcs', 'round', 'bevel'].map(
    (j) => tally[j].fixed - tally[j].out,
  );
  ok(
    resid.every((v) => v === 0),
    `(a) and the under-paint that is left is ${resid.join(' / ')} — the curve branch answers the exact SVG 2 shape on every straight-quad center, in both directions`,
  );
}

// ---- (b) a curve miter past its limit stops painting outside ----------------------------------------
function membership(rule, keep) {
  let n = 0,
    outside = 0,
    unpainted = 0;
  for (const cs of cases) {
    if (!keep(cs)) continue;
    for (const c of pixelsCurve(cs)) {
      n++;
      const inS =
        minDistCurve(rule, c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <=
        cs.halfW;
      const inV = svgInsideCurve(
        c,
        cs.segs,
        cs.closed,
        cs.halfW,
        cs.cap,
        cs.joinStyle,
        cs.miterLimit,
      );
      if (inS && !inV) outside++;
      if (!inS && inV) unpainted++;
    }
  }
  return { n, outside, unpainted };
}
{
  const before = membership('miterClipClamp', (cs) => cs.joinStyle === 0);
  const after = membership('fixed', (cs) => cs.joinStyle === 0);
  ok(
    before.outside > 10 && after.outside === 0,
    `(b) miter on curves: ${before.outside} of ${before.n} centers painted outside the SVG 2 shape under the base rule, ${after.outside} under the current one`,
  );
  const bA = membership('miterClipClamp', (cs) => cs.joinStyle === 4);
  const aA = membership('fixed', (cs) => cs.joinStyle === 4);
  ok(
    aA.unpainted < bA.unpainted * 0.5,
    `(b) arcs on curves, against SVG 2's miter-clip fallback: ${bA.unpainted} of ${bA.n} centers unpainted under the base rule, ${aA.unpainted} under the current one (${bA.outside} -> ${aA.outside} outside)`,
  );
}

// ---- (c) the AA it buys ------------------------------------------------------------------------------
function aaOver(a, b, keep, N = 8) {
  let changed = 0,
    eA = 0,
    eB = 0;
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
      changed++;
      eA += Math.abs(ca - k / (N * N));
      eB += Math.abs(cb - k / (N * N));
    }
  }
  return { changed, eA, eB };
}
{
  for (const [j, name, factor] of [
    [0, 'miter', 0.5],
    [3, 'miter-clip', 1.0],
    [4, 'arcs', 0.5],
  ]) {
    const r = aaOver('fixed', 'miterClipClamp', (cs) => cs.joinStyle === j);
    ok(
      r.changed > 20 && r.eA < r.eB * factor,
      `(c) ${name}: ${r.changed} pixels change; summed error against 8x8 box coverage ${r.eB.toFixed(1)} -> ${r.eA.toFixed(1)}`,
    );
  }
  for (const [j, name] of [
    [1, 'round'],
    [2, 'bevel'],
  ]) {
    const r = aaOver('fixed', 'miterClipClamp', (cs) => cs.joinStyle === j);
    ok(r.changed === 0, `(c) ${name} moves ${r.changed} pixels`);
  }
}

// ---- (d) the clip line, named ------------------------------------------------------------------------
{
  // two straight quads meeting at (0,0) with a 60-degree interior angle, halfW 2, miterLimit 1:
  // miterLen = 2 / sin 30 = 4 > 2, so the join is past its limit and the clip line sits 2 units out
  // along the bisector. Bounding `along` by miterLimit * halfW * cos(theta / 2) = 1.732 on the
  // TANGENT instead is a different cut.
  const a = (60 * Math.PI) / 180;
  const A = [-Math.cos(a / 2), -Math.sin(a / 2)],
    B = [Math.cos(a / 2), -Math.sin(a / 2)];
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const P0 = [A[0] * 12, A[1] * 12],
    P2 = [B[0] * 12, B[1] * 12];
  const segs = quadSegs(
    [
      [P0, mid(P0, [0, 0]), [0, 0]],
      [[0, 0], mid([0, 0], P2), P2],
    ],
    false,
  );
  const at = (rule, q) => minDistCurve(rule, q, segs, 2, 0, 3, 1).minD <= 2;
  const svgAt = (q) => svgInsideCurve(q, segs, false, 2, 0, 3, 1);
  ok(
    svgAt([0, 1.9]) && !svgAt([0, 2.1]),
    '(d) SVG 2 clips this join at 2.0 along the bisector (inside at 1.9, outside at 2.1)',
  );
  ok(at('fixed', [0, 1.9]) && !at('fixed', [0, 2.1]), '(d) and so does the shipped rule');
  // ON the bisector the two rules coincide (alongMax = miterLimit * halfW * cos(theta/2) is exactly
  // the clip line's own bisector distance there); they part OFF it, which is the whole difference
  // between cutting square to the tangent and square to the bisector. Sweep the join's outer
  // neighborhood and count against SVG 2.
  const scan = (rule) => {
    let wrong = 0,
      n = 0;
    for (let y = 0; y <= 3.2; y += 0.02)
      for (let x = -3.2; x <= 3.2; x += 0.02) {
        n++;
        if (at(rule, [x, y]) !== svgAt([x, y])) wrong++;
      }
    return { wrong, n };
  };
  const f = scan('fixed'),
    p = scan('miterClipClamp'),
    nc = scan('noMiterClipLine');
  ok(
    f.wrong === 0,
    `(d) over the join's outer neighborhood the shipped rule agrees with SVG 2 at all ${f.n} samples`,
  );
  ok(
    p.wrong > 20,
    `(d) mutation "miter-clip capped on the tangent" is caught: ${p.wrong} of ${p.n} samples disagree — the tangent cut keeps a wedge past the clip line and loses one beside it`,
  );
  ok(
    nc.wrong > 20,
    `(d) mutation "the clip line dropped" is caught: ${nc.wrong} of ${nc.n} samples disagree`,
  );
}

// ---- (e) mutations ------------------------------------------------------------------------------------
{
  const base = membership('fixed', (cs) => cs.joinStyle === 0);
  const rp = membership('roundPastLimit', (cs) => cs.joinStyle === 0);
  ok(
    rp.outside > base.outside,
    `(e) mutation "the round shoulder restored past the miter limit" is caught: ${rp.outside} painted outside against ${base.outside}`,
  );
  const nc = membership('noMiterClipLine', (cs) => cs.joinStyle === 3 || cs.joinStyle === 4);
  const b2 = membership('fixed', (cs) => cs.joinStyle === 3 || cs.joinStyle === 4);
  ok(
    nc.outside > b2.outside,
    `(e) mutation "the clip line dropped" is caught: ${nc.outside} painted outside against ${b2.outside}`,
  );
  const ba = aaOver('fixed', 'bevelArcs', (cs) => cs.joinStyle === 4);
  ok(
    ba.changed > 0 && ba.eA < ba.eB,
    `(e) mutation "arcs bevels past the limit" is caught: ${ba.changed} pixels, error ${ba.eB.toFixed(1)} against ${ba.eA.toFixed(1)}`,
  );
}

// ---- (f) the reach --------------------------------------------------------------------------------------
{
  const rot = (d) => [Math.cos((d * Math.PI) / 180), Math.sin((d * Math.PI) / 180)];
  const TURNS = [10, 45, 90, 150, 179];
  // straight / straight: SVG 2 sends arcs to miter-clip, whose corners are sqrt(ml^2 + 1) out
  for (const ml of [1, 4]) {
    const bound = Math.sqrt(ml * ml + 1);
    let best = 0;
    for (const d of TURNS) best = Math.max(best, svgArcsReach([1, 0], rot(d), 0, 0, 1, ml) || 0);
    ok(
      best <= bound + 1e-6 && best > bound * 0.99,
      `(f) straight/straight arcs at miterLimit ${ml}: SVG 2's region reaches ${best.toFixed(3)} half-widths, against the bound's ${bound.toFixed(3)}`,
    );
  }
  // curved / curved, the band intersection WITHOUT the cut: the far side of the osculating circle.
  // This measures the join BRANCH's own region, which is what the reach bound is a statement about.
  // A fragment only reaches that branch when its closest point on the segment is the join vertex
  // (strokeCapsJoinsDash runs it under t < 1e-4 / t > 1 - 1e-4), and the cover quad and band pad cut
  // whatever survives at the bound anyway — so the excess does not show on a render and the cut
  // does not move a GPU pixel on the cases in probes/strokeCurve. It makes the bound true instead
  // of assumed; it is not a repair of a visible artifact.
  const k = 0.01,
    uncut = rendererArcsReach([1, 0], rot(90), 0, k, 1, 4, 'miterClipClamp', 1500, 9);
  ok(
    uncut > 150,
    `(f) uncut, at kappa * halfW = ${k} (radius ${1 / k} half-widths): the band intersection reaches ${uncut.toFixed(0)} half-widths — 2 / |kappa| + halfW, against the assumed bound of ${Math.sqrt(17).toFixed(2)}`,
  );
  let worstCut = 0,
    worstCfg = null;
  for (const ml of [1, 2, 4])
    for (const d of TURNS)
      for (const kA of [0, 0.01, 0.2, 1, -0.2, -1])
        for (const kB of [0, 0.01, 0.2, 1, -0.2, -1]) {
          const r =
            rendererArcsReach([1, 0], rot(d), kA, kB, 1, ml, 'fixed', 900, 7) /
            Math.sqrt(ml * ml + 1);
          if (r > worstCut) {
            worstCut = r;
            worstCfg = { ml, d, kA, kB };
          }
        }
  ok(
    worstCut <= 1 + 1e-6,
    `(f) cut: over turn x both curvatures x miter limit the renderer's arcs region stays within the bound (worst ${worstCut.toFixed(4)} of it, at ${JSON.stringify(worstCfg)})`,
  );
  // ...and what SVG 2 itself would draw there, which the cut does NOT cover (a known gap)
  let worstSvg = 0,
    svgCfg = null;
  for (const ml of [1, 2, 3, 4])
    for (const d of [90, 150, 179, 179.9])
      for (const kA of [0.05, 0.12, 0.26, 0.58, 1])
        for (const kB of [-0.05, -0.2, -0.45, 0.2, 0.45]) {
          const s = svgArcsReach([1, 0], rot(d), kA, kB, 1, ml);
          if (s != null && s / Math.sqrt(ml * ml + 1) > worstSvg) {
            worstSvg = s / Math.sqrt(ml * ml + 1);
            svgCfg = { ml, d, kA, kB, s: +s.toFixed(2) };
          }
        }
  ok(
    worstSvg > 1.5,
    `(f) KNOWN GAP: SVG 2's own arcs region between curved segments reaches ${worstSvg.toFixed(2)}x the bound (${JSON.stringify(svgCfg)}); the renderer draws a band intersection cut at the bound, not that region`,
  );
}

// ---- (g) end to end ---------------------------------------------------------------------------------------
{
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const { default: importSvg } = await import('../src/svg/importer.js');
  let rows = 0,
    n = 0,
    unpainted = 0,
    outside = 0,
    offQuad = 0,
    skipped = 0;
  for (const cs of cases) {
    if (cs.closed || cs.joinStyle < 3 || cs.segs.length < 2) continue;
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
    rows > 15 && n > 30000 && unpainted === 0 && outside === 0,
    `(g) end to end over ${rows} miter-clip / arcs curve rows: of ${n} centers ${unpainted} unpainted and ${outside} painted outside (${offQuad} outside the cover quad; ${skipped} on a boundary skipped)`,
  );
}

// ---- (h) the shader and the hit test spell the same rule ------------------------------------------------
{
  const sm = readFileSync(path.join(ROOT, 'src/shaders/_strokeMath.glsl'), 'utf8');
  const pin = (re, m) => ok(re.test(sm), `(h) ${m}`);
  // One copy serves both ends: din / dout the directions into and out of the vertex.
  ok(
    (sm.match(/if \(joinStyle == 0 && !fits\) \{/g) || []).length === 1 &&
      /if \(t < 1e-4 \|\| t > 1\.0 - 1e-4\) \{\s*bool atS = t < 1e-4;/.test(sm),
    '(h) _strokeMath.glsl: both vertices (one copy) take the bevel branch when a miter is past its limit',
  );
  ok(
    !/if \(joinStyle == 3\) miterLen = min\(miterLen, maxMiter\);/.test(sm),
    '(h) and miter-clip does not clamp miterLen to bound the along-tangent extent',
  );
  pin(
    /vec2 tipDir = din - dout;[\s\S]{0,220}?dClip = max\(dClip, halfW \+ dot\(-ep, tipDir\) \/ tipLen - mlClip\);/,
    'miter-clip is the kite cut perpendicular to the bisector at halfW * miterLimit',
  );
  pin(
    /vec2 din = atS \? inTan : tOwn, dout = atS \? tOwn : outTan;/,
    'at both vertices: in and out of the vertex along the path',
  );
  ok(
    (sm.match(/halfW \+ length\(-ep\) - halfW \* strokeArcsReachFactor\(miterLimit\)\)?;/g) || [])
      .length === 2,
    "(h) both vertices, arcs and the clipped miter: the region is cut at src/bundle/strokeReach.js's bound",
  );
  ok(
    /float strokeArcsReachFactor\(float miterLimit\) \{\s*float ml = max\(miterLimit, 1\.0\);\s*return sqrt\(ml \* ml \+ 1\.0\);/.test(
      sm,
    ),
    '(h) and that bound is sqrt(miterLimit^2 + 1), the one the pads use',
  );
  const cg = readFileSync(path.join(ROOT, 'src/hitTest/curveGeom.js'), 'utf8');
  ok(
    /if \(joinStyle === JOIN_MITER && tipDist > maxTip\) \{/.test(cg),
    '(h) src/hitTest/curveGeom.js: a curve miter past its limit is a bevel there too',
  );
  ok(
    /d1 = Math\.max\(d1, halfW \+ Math\.hypot\(qx, qy\) - halfW \* Math\.sqrt\(ml \* ml \+ 1\)\);/.test(
      cg,
    ),
    '(h) and its arcs region takes the same cut',
  );
}

if (fail) {
  console.error(`STROKE-CURVE-JOIN-SVG-SHAPE FAIL (${fail})`);
  process.exit(1);
}
console.log(`STROKE-CURVE-JOIN-SVG-SHAPE PASS (${(performance.now() / 1000).toFixed(1)} s)`);
