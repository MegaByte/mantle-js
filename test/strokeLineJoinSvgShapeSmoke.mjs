// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeLineJoinSvgShapeSmoke — the LINE stroke path's caps and joins (_coverage.glsl,
// strokeBandAccum) against the SVG 2 stroke shape.
//
// SVG 2 (painting.html, "Computing the shape of the stroke") builds a stroke from each segment's
// RECTANGLE, a cap shape at each open end (butt: nothing; round: a SEMICIRCLE; square: a halfW-deep
// rectangle) and a join shape at each vertex: bevel = triangle(P, P1, P2); round = bevel U the
// circular SECTOR from P1 to P2 — not a disc; miter = bevel U triangle(P1, P2, P3) when
// 1/sin(theta/2) <= stroke-miterlimit, otherwise "return bevel"; miter-clip = the same region, but
// past the limit "clip any part of the line join region that extends past the miter limit"; arcs
// "fall through to miter-clip" when both curvatures are zero, which on straight segments they
// always are. Every join shape lies in the wedge between the two segments' perpendiculars at the
// vertex.
//
// What this pins:
//   * a miter past its limit is the bevel SVG returns, not a ROUND shoulder (the radial distance);
//   * outside the join wedge an interior end is a BUTT end — the butt cap's own SDF — so it adds
//     nothing and still gives an AA ramp across its end plane. Falling through to the radial
//     distance would paint a full halfW disc at every vertex, which a neighbor's rectangle covers
//     only when the neighbor is at least halfW long; a shorter neighbor lets it spill past its far end.
//   * miter-clip is the miter kite cut by the clip line at halfW * miterLimit along the bisector,
//     inside the wedge (within the limit and past it), and so is arcs past the limit — not ROUND,
//     which leaves the whole clipped spike unpainted. The importer's stroke pad, the band
//     membership and the shader's search radius reach the clip line's corners, halfW *
//     sqrt(miterLimit^2 + 1) from the vertex; a pad of halfW for miter-clip cuts the spike flat.
//   * a square cap is the halfW-deep box as an SDF, max(perpendicular, along), with the butt cap's
//     AA ramp (also in the curve twin, _strokeMath.glsl), not a hard cutoff at its far plane.
//   * the curve twin's wedge rule is this branch's butt end.
// (The reference's round join is a sector, as SVG 2 specifies; a full disc there would report a
// "round join clipped by two butt caps" that is the reference's own error.)
//
// This carries a CPU model of the shader's line branch, as shipped and with each rule reverted, the
// frag's coverage tail, and the SVG 2 shape, and sweeps random open and closed polylines over
// join x cap x half-width x segment length (down to a quarter of halfW) x miter limit:
//   (a) MEMBERSHIP: every pixel center the shader calls inside (minD <= halfW) is inside the SVG 2
//       shape and vice versa, for all five joins — at three coordinate scales;
//   (b) CONFINED: where every segment is at least halfW long and no miter is past its limit, every
//       pixel's coverage is bit-identical with the bevel and butt-end rules reverted;
//   (c) AA: over the pixels those rules change, the error against 4x4 box coverage falls (reported);
//   (d) the gate is load-bearing and the rule is not the curve path's drop (kept);
//   (e) the shader spells the vertex branches and the search radius the way the model does;
//   (f) moves no pixel of a miter, round or bevel join, nor of an arcs join that never passes
//       its limit, and over the pixels it moves the AA error against 8x8 box coverage falls;
//   (g) END TO END: importSvg, then the band-walk emulator (test/_strokeBandEmu.mjs: cover quad, band
//       pick, break / far / saturation gates) with the model — no pixel center of any join or cap
//       left unpainted or painted outside, gates on and off (an importer pad short of the clip
//       corners fails miter-clip and arcs here, and one short of the square-cap corners, square caps);
//   (h) changes no pixel's membership and no pixel without a square cap, puts a ramp across a
//       square cap's far plane, and over the pixels it moves the AA error against 8x8 box coverage
//       falls; both shaders spell it.
// Mutations of the model — the radial fall-through restored, the round shoulder restored, the gate
// removed, the clip line dropped, the miter-clip rule reverted, the square-cap rule reverted — each have to FAIL a check.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

import {
  minDist,
  coverage,
  svgInside,
  makeStrokeCases,
  pixels,
  JOINS,
} from './_strokeShapeRef.mjs';
import { makeStrokeEmu, strokeRowsOf } from './_strokeBandEmu.mjs';

const cases = makeStrokeCases();
function membership(rule, joins, scale = 1) {
  let outside = 0,
    unpainted = 0,
    n = 0;
  for (const cs of cases) {
    if (!joins.includes(cs.joinStyle)) continue;
    const P = cs.P.map((p) => [p[0] * scale, p[1] * scale]),
      segs = cs.segs.map((s) => ({
        ...s,
        a: [s.a[0] * scale, s.a[1] * scale],
        b: [s.b[0] * scale, s.b[1] * scale],
      })),
      hw = cs.halfW * scale;
    for (const c0 of pixels(cs)) {
      const c = [c0[0] * scale, c0[1] * scale];
      const inShader = minDist(rule, c, segs, hw, cs.cap, cs.joinStyle, cs.miterLimit).minD <= hw;
      const inSvg = svgInside(c, P, cs.closed, hw, cs.cap, cs.joinStyle, cs.miterLimit);
      n++;
      if (inShader && !inSvg) outside++;
      if (!inShader && inSvg) unpainted++;
    }
  }
  return { wrong: outside + unpainted, outside, unpainted, n };
}
const membershipWrong = membership;
function movedBetween(ruleA, ruleB, keep) {
  let moved = 0,
    n = 0,
    nCases = 0;
  for (const cs of cases) {
    if (!keep(cs)) continue;
    nCases++;
    for (const c of pixels(cs)) {
      n++;
      if (
        coverage(ruleA, c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit) !==
        coverage(ruleB, c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit)
      )
        moved++;
    }
  }
  return { moved, n, nCases };
}
const confinedMoved = (rule) =>
  movedBetween(
    rule,
    'prefix',
    (cs) => cs.minLen >= cs.halfW && !(cs.joinStyle === 0 && cs.pastLimit),
  );

// ---- (a) membership ----------------------------------------------------------------------------
{
  const before = membershipWrong('prefix', [0, 1, 2]),
    after = membershipWrong('fixed', [0, 1, 2, 3, 4]);
  ok(
    before.wrong > 0,
    `(a) with the bevel and butt-end fixes reverted the rule disagrees with SVG 2 at ${before.wrong} of ${before.n} pixel centers (miter, round, bevel)`,
  );
  ok(
    after.wrong === 0,
    `(a) the shipped rule agrees at every one of ${after.n}, all five joins (${after.outside} painted outside, ${after.unpainted} unpainted)`,
  );
  for (const S of [1e-3, 1e3]) {
    const r = membershipWrong('fixed', [0, 1, 2, 3, 4], S);
    ok(r.wrong === 0, `(a) and at coordinate scale ${S} (${r.wrong} of ${r.n} disagree)`);
  }
  for (const j of [0, 1, 2]) {
    const b = membershipWrong('prefix', [j]).wrong;
    console.log(`       ${JOINS[j].padEnd(10)} reverted: ${b} disagreements`);
  }
  for (const j of [3, 4]) {
    const b = membership('miterClipRound', [j]);
    ok(
      b.unpainted > 0,
      `(a) with the miter-clip fix reverted, ${JOINS[j]} leaves ${b.unpainted} centers unpainted (${b.outside} painted outside)`,
    );
    const f = membership('fixed', [j]);
    ok(
      f.unpainted === 0 && f.outside === 0,
      `(a) shipped, ${JOINS[j]}: ${f.unpainted} unpainted, ${f.outside} painted outside of ${f.n}`,
    );
  }
}

// ---- (b) confined ------------------------------------------------------------------------------
{
  const r = confinedMoved('fixed');
  ok(
    r.nCases > 50 && r.moved === 0,
    `(b) ${r.nCases} cases with every segment >= halfW and no miter past its limit: ${r.moved} of ${r.n} pixels differ with the bevel and butt-end fixes reverted`,
  );
}

// ---- (c) AA ------------------------------------------------------------------------------------
{
  let changed = 0,
    closer = 0,
    same = 0,
    farther = 0,
    errBefore = 0,
    errAfter = 0,
    worst = 0;
  for (const cs of cases) {
    if (cs.joinStyle > 2) continue;
    for (const c of pixels(cs)) {
      const cN = coverage('fixed', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      const cO = coverage('prefix', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      if (cN === cO) continue;
      let k = 0;
      for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++)
          if (
            svgInside(
              [c[0] - 0.5 + (i + 0.5) / 4, c[1] - 0.5 + (j + 0.5) / 4],
              cs.P,
              cs.closed,
              cs.halfW,
              cs.cap,
              cs.joinStyle,
              cs.miterLimit,
            )
          )
            k++;
      const t = k / 16,
        eO = Math.abs(cO - t),
        eN = Math.abs(cN - t);
      changed++;
      errBefore += eO;
      errAfter += eN;
      if (eN < eO - 0.07) closer++;
      else if (eN > eO + 0.07) {
        farther++;
        worst = Math.max(worst, eN - eO);
      } else same++;
    }
  }
  ok(
    changed > 0 && errAfter < errBefore * 0.5,
    `(c) ${changed} pixels change; summed error against 4x4 box coverage ${errBefore.toFixed(1)} -> ${errAfter.toFixed(1)}`,
  );
  console.log(
    `       ${closer} closer, ${same} within one 4x4 sample, ${farther} farther (worst +${worst.toFixed(2)}: two pieces' edges crossing inside one pixel, which a min-of-distances ramp cannot resolve)`,
  );
}

// ---- (d) the gate carries weight, and the line rule is not the curve rule's drop -----------
{
  const noGate = membershipWrong('noGate', [0, 1, 2]);
  ok(
    noGate.wrong > 0,
    `(d) removing the ourTerritory gate paints ${noGate.wrong} pixel centers wrong, so it is not dead code`,
  );
}

// ---- (e) the shader text --------------------------------------------------------------------------
{
  const gl = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8');
  const lines = gl.slice(gl.indexOf('float strokeBandAccum('), gl.indexOf('// ---- QUADS (native'));
  const pin = (re, m) => ok(re.test(lines), `(e) ${m}`);
  pin(
    /bool ourTerritory = dot\(cq - a, inTan\) >= 0\.0;\s*if \(!ourTerritory\) \{\s*thisD = max\(length\(cq - a\), halfW \+ dot\(cq - a, -segTan\)\);/,
    'start vertex: outside the wedge a butt end',
  );
  pin(
    /bool ourTerritory = dot\(cq - b, -outTan\) >= 0\.0;\s*if \(!ourTerritory\) \{\s*thisD = max\(length\(cq - b\), halfW \+ dot\(cq - b, segTan\)\);/,
    'end vertex: outside the wedge a butt end',
  );
  const bevelRe =
    /bool bevelHere = joinStyle == 2 \|\| \(joinStyle == 0 && !\(miterLen <= halfW \* miterLimit\)\);\s*if \(bevelHere\) \{/g;
  ok(
    (lines.match(bevelRe) || []).length === 2,
    '(e) both vertices: a miter past its limit takes the bevel branch',
  );
  ok(
    !/drop = true;[^\n]*ourTerritory|ourTerritory[^\n]*drop = true/.test(lines),
    '(e) and the gate still never drops',
  );
  const sm = readFileSync(path.join(ROOT, 'src/shaders/_strokeMath.glsl'), 'utf8');
  // the CURVE twin has this same rule (a drop gated on the neighbour's encoded reach would do
  // nothing at most interior vertices and keep the halfW disc). Both branches are one rule.
  ok(
    /&& outWedge\) \{/.test(sm) &&
      /thisD = max\(thisD, halfW \+ dot\(-ep, uOwn\)\);/.test(sm) &&
      /bool outWedge = atS \? dot\(-ep, inTan\) < 0\.0 : dot\(-ep, outTan\) > 0\.0;/.test(sm),
    '(e) the curve twin (_strokeMath.glsl) takes the same butt end outside the wedge',
  );
  ok(
    !/startPrevReach|endNextReach/.test(sm.replace(/^\s*\/\/.*$/gm, '')),
    '(e) and no reach field gates it',
  );
  ok(
    (lines.match(/if \(joinStyle == 0 \|\| joinStyle == 3 \|\| joinStyle == 4\) \{/g) || [])
      .length === 2,
    '(e) both vertices: miter, miter-clip and arcs share the miter within the limit',
  );
  const clipRe = (v, own) =>
    new RegExp(
      String.raw`\} else if \(\(joinStyle == 3 \|\| joinStyle == 4\) && !\(miterLen <= halfW \* miterLimit\)\) \{[\s\S]*?` +
        String.raw`vec2 tipDir = ${own};\s*float tipLen = length\(tipDir\);\s*thisD = max\(perpThis, perpOther\);\s*` +
        String.raw`if \(tipLen > 1e-4\)\s*thisD = max\(thisD, halfW \+ dot\(cq - ${v}, tipDir\) / tipLen - halfW \* _ml\);`,
    );
  pin(
    clipRe('a', 'inTan - segTan'),
    'start vertex: past the limit, miter-clip and arcs are the kite cut at halfW * miterLimit',
  );
  pin(clipRe('b', 'segTan - outTan'), 'end vertex: the same');
  pin(
    /float _ml = max\(miterLimit, 1\.0\);\s*float _reach = halfW \* max\(\(joinStyle == 0 \? _ml\s*: \(joinStyle == 3 \|\| joinStyle == 4\) \? sqrt\(_ml \* _ml \+ 1\.0\) : 1\.0\),/,
    "the search radius reaches a clipped miter's corners, halfW * sqrt(miterLimit^2 + 1)",
  );
}

// ---- (f) the miter-clip fix is confined, and its AA ---------------------------------------------------------------
{
  const others = movedBetween('fixed', 'miterClipRound', (cs) => cs.joinStyle <= 2);
  ok(
    others.moved === 0,
    `(f) moves ${others.moved} of ${others.n} pixels of miter, round and bevel joins (${others.nCases} cases)`,
  );
  const arcsFit = movedBetween(
    'fixed',
    'miterClipRound',
    (cs) => cs.joinStyle === 4 && !cs.pastLimit,
  );
  ok(
    arcsFit.nCases > 5 && arcsFit.moved === 0,
    `(f) and ${arcsFit.moved} of ${arcsFit.n} of arcs joins that never pass the limit (${arcsFit.nCases} cases)`,
  );
  let changed = 0,
    errBefore = 0,
    errAfter = 0;
  for (const cs of cases) {
    if (cs.joinStyle < 3) continue;
    for (const c of pixels(cs)) {
      const cN = coverage('fixed', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      const cO = coverage(
        'miterClipRound',
        c,
        cs.segs,
        cs.halfW,
        cs.cap,
        cs.joinStyle,
        cs.miterLimit,
      );
      if (cN === cO) continue;
      let k = 0;
      for (let i = 0; i < 8; i++)
        for (let j = 0; j < 8; j++)
          if (
            svgInside(
              [c[0] - 0.5 + (i + 0.5) / 8, c[1] - 0.5 + (j + 0.5) / 8],
              cs.P,
              cs.closed,
              cs.halfW,
              cs.cap,
              cs.joinStyle,
              cs.miterLimit,
            )
          )
            k++;
      changed++;
      errBefore += Math.abs(cO - k / 64);
      errAfter += Math.abs(cN - k / 64);
    }
  }
  ok(
    changed > 0 && errAfter < errBefore * 0.1,
    `(f) ${changed} miter-clip / arcs pixels change; summed error against 8x8 box coverage ${errBefore.toFixed(1)} -> ${errAfter.toFixed(1)}`,
  );
}

// ---- (g) end to end: the importer's pad, bands and cover quad ------------------------------------
{
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const { default: importSvg } = await import('../src/svg/importer.js');
  const CAPS = ['butt', 'round', 'square'];
  const tally = {};
  for (const cs of cases) {
    const d = 'M ' + cs.P.map((p) => `${p[0]} ${p[1]}`).join(' L ') + (cs.closed ? ' Z' : '');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-100 -100 200 200"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * cs.halfW}"` +
      ` stroke-linecap="${CAPS[cs.cap]}" stroke-linejoin="${JOINS[cs.joinStyle]}" stroke-miterlimit="${cs.miterLimit}"/></svg>`;
    const b = await importSvg(svg);
    const row = strokeRowsOf(b)[0];
    const emus = [makeStrokeEmu(b, row, { gates: true }), makeStrokeEmu(b, row, { gates: false })];
    const t = (tally[JOINS[cs.joinStyle]] ??= {
      n: 0,
      skipped: 0,
      unpainted: [0, 0],
      outside: [0, 0],
      quad: 0,
    });
    const eps = 1e-4 * cs.halfW;
    for (const c of pixels(cs)) {
      const inSvg = svgInside(c, cs.P, cs.closed, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      // centers within a relative hair of the boundary: the bundle is float32
      if (
        [
          [eps, 0],
          [-eps, 0],
          [0, eps],
          [0, -eps],
        ].some(
          ([dx, dy]) =>
            svgInside(
              [c[0] + dx, c[1] + dy],
              cs.P,
              cs.closed,
              cs.halfW,
              cs.cap,
              cs.joinStyle,
              cs.miterLimit,
            ) !== inSvg,
        )
      ) {
        t.skipped++;
        continue;
      }
      t.n++;
      emus.forEach((emu, k) => {
        const r = emu.eval(c),
          painted = r.inQuad && r.minD <= cs.halfW;
        if (inSvg && !painted) {
          t.unpainted[k]++;
          if (k === 0 && !r.inQuad) t.quad++;
        }
        if (!inSvg && painted) t.outside[k]++;
      });
    }
  }
  for (const [j, t] of Object.entries(tally))
    ok(
      t.n > 50000 && t.unpainted[0] + t.unpainted[1] + t.outside[0] + t.outside[1] === 0,
      `(g) end to end, ${j}: of ${t.n} centers ${t.unpainted[0]} / ${t.unpainted[1]} unpainted and ${t.outside[0]} / ${t.outside[1]} painted outside (gates on / off; ${t.quad} outside the cover quad; ${t.skipped} on a boundary skipped)`,
    );
}

// ---- (h) the square cap's far plane has an AA ramp ------------------------------------------
{
  let memberMoved = 0,
    n = 0,
    movedNoSquare = 0,
    changed = 0,
    errBefore = 0,
    errAfter = 0;
  for (const cs of cases) {
    const square = !cs.closed && cs.cap === 2;
    for (const c of pixels(cs)) {
      n++;
      const dN = minDist('fixed', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD;
      const dO = minDist(
        'squareCapDrop',
        c,
        cs.segs,
        cs.halfW,
        cs.cap,
        cs.joinStyle,
        cs.miterLimit,
      ).minD;
      if (dN <= cs.halfW !== dO <= cs.halfW) memberMoved++;
      const cN = coverage('fixed', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      const cO = coverage(
        'squareCapDrop',
        c,
        cs.segs,
        cs.halfW,
        cs.cap,
        cs.joinStyle,
        cs.miterLimit,
      );
      if (cN === cO) continue;
      if (!square) {
        movedNoSquare++;
        continue;
      }
      let k = 0;
      for (let i = 0; i < 8; i++)
        for (let j = 0; j < 8; j++)
          if (
            svgInside(
              [c[0] - 0.5 + (i + 0.5) / 8, c[1] - 0.5 + (j + 0.5) / 8],
              cs.P,
              cs.closed,
              cs.halfW,
              cs.cap,
              cs.joinStyle,
              cs.miterLimit,
            )
          )
            k++;
      changed++;
      errBefore += Math.abs(cO - k / 64);
      errAfter += Math.abs(cN - k / 64);
    }
  }
  ok(
    memberMoved === 0 && movedNoSquare === 0,
    `(h) changes the membership of ${memberMoved} of ${n} centers, and the coverage of ${movedNoSquare} without a square cap`,
  );
  ok(
    changed > 0 && errAfter < errBefore * 0.3,
    `(h) ${changed} square-cap pixels change; summed error against 8x8 box coverage ${errBefore.toFixed(1)} -> ${errAfter.toFixed(1)}`,
  );
  // one segment (0,0)-(10,0), halfW 2: the square cap's far plane is x = 12
  const segs = [
    { a: [0, 0], b: [10, 0], freeStart: true, freeEnd: true, inTan: [0, 0], outTan: [0, 0] },
  ];
  const ramp = (rule) => [11.75, 12, 12.25].map((x) => coverage(rule, [x, 0], segs, 2, 2, 0, 4));
  const rN = ramp('fixed'),
    rO = ramp('squareCapDrop');
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  ok(
    near(rN, [0.75, 0.5, 0.25]),
    `(h) across the far plane the coverage ramps: ${rN.join(', ')} at 0.25 inside, on, and 0.25 past it`,
  );
  ok(
    !near(rO, [0.75, 0.5, 0.25]),
    `(h) mutation "square-cap fix reverted" is caught: ${rO.join(', ')} (the hard cutoff)`,
  );
  const gl = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8');
  ok(
    /float along = dot\(cq - a, -segTan\);\s*thisD = max\(length\(\(cq - a\) \+ segTan \* along\), along\);/.test(
      gl,
    ) &&
      /float along = dot\(cq - b, segTan\);\s*thisD = max\(length\(\(cq - b\) - segTan \* along\), along\);/.test(
        gl,
      ),
    '(h) _coverage.glsl: both square caps are max(perpendicular, along), no drop',
  );
  const sm = readFileSync(path.join(ROOT, 'src/shaders/_strokeMath.glsl'), 'utf8');
  // The curve twin is the same SDF. The line branch reaches its vertex code only when the closest
  // point is PAST the end, so `along >= 0` holds there by construction and it simply assigns
  // max(perp, along). The curve branch's gate is the closest-point PARAMETER (`t < 1e-4`), which also
  // admits t in (0, 1e-4) where the pixel is interior and `a` is negative — and there it does nothing
  // rather than DROP the whole segment, leaving the body distance, which is the only reading of the line rule that survives the
  // difference in gates. test/strokeSquareCapDropSmoke.mjs measures what that is worth.
  ok(
    (
      sm.match(
        /if \(a >= 0\.0\) \{ float perp = length\(-ep - uOwn \* a\); thisD = min\(thisD, max\(perp, a\)\); \}/g,
      ) || []
    ).length === 1 &&
      !/a > halfW\) drop = true/.test(sm) &&
      !/if \(a < 0\.0\) drop = true/.test(sm),
    "(h) _strokeMath.glsl: the curve twin's square caps are the same, drop nothing past halfW, and drop nothing in front of the cap plane either",
  );
}

// ---- mutations ----------------------------------------------------------------------------------
for (const [rule, name] of [
  ['radialOutside', 'the radial fall-through restored outside the wedge'],
  ['roundPastLimit', 'the round shoulder restored past the miter limit'],
  ['noGate', 'the ourTerritory gate removed'],
]) {
  const a = membershipWrong(rule, [0, 1, 2]).wrong,
    b = confinedMoved(rule).moved;
  ok(
    a > 0 || b > 0,
    `mutation "${name}" is caught: ${a} membership disagreements, ${b} pixels moved where nothing may move`,
  );
}
for (const [rule, name] of [
  ['noClip', 'the clip line dropped'],
  ['miterClipRound', 'reverted'],
]) {
  const a = membership(rule, [3, 4]);
  ok(
    a.wrong > 0,
    `mutation "${name}" is caught: ${a.outside} painted outside, ${a.unpainted} unpainted (miter-clip, arcs)`,
  );
}

if (fail) {
  console.error(`STROKE-LINE-JOIN-SVG-SHAPE FAIL (${fail})`);
  process.exit(1);
}
console.log(`STROKE-LINE-JOIN-SVG-SHAPE PASS (${(performance.now() / 1000).toFixed(1)} s)`);
