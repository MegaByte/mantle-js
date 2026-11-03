// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeCurveWedgeSmoke — the curve branch's join wedge means ONE thing.
//
// SVG 2 builds a stroke from each segment's swept perpendicular plus, at every join, a join shape
// that lies entirely in the WEDGE between the two segments' perpendiculars. Outside that wedge a
// segment's end is a BUTT end — the tube cut by its own end plane. _coverage.glsl's LINE branch says
// exactly that (`ourTerritory`), and strokeLineJoinSvgShapeSmoke proves it exact
// against SVG 2 over 360 polylines.
//
// The CURVE branch (_strokeMath.glsl strokeCapsJoinsDash) must say the same at every site. Gating it on
// an encoded neighbour "reach" field says three different things at once:
//   * on the main route the endpoint outside the wedge is DROPPED only when the encoder made this
//     side's neighbour "reach" finite — which src/svg/textures.js does only when the neighbour is itself
//     free-ended (the field's finiteness decides, never its LENGTH);
//   * for CUBICS and ARCS on that route a reach of 1e9 turns the gate off;
//   * on the SPLIT-STROKE route a reach of 0 at every interior join turns it always ON — one bundle,
//     two join regions.
// Where the gate is off, the radial fall-through leaves the full halfW disc at the vertex. All four
// sites take the line branch's butt end, and no reach field reaches the shader.
//
//   (a) the encoder's asymmetry, counted: how many interior vertex-ends carry a finite reach;
//   (b) the rule, on curved chains: painted outside / unpainted inside against the exact SVG 2
//       shape, for the shipped rule, the reach gate, and a hard DROP;
//   (c) AA: summed |coverage - exact area| over the pixels near an interior vertex, against 16x16
//       sampling of the exact shape — which is what separates the butt end from the drop;
//   (d) END TO END through importSvg and the band-walk emulator: the cover quad and the band pad
//       still reach every pixel the butt-end rule inks;
//   (e) the shader text — all four sites, both routes, and no reach field left in either.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  makeCurveCases,
  pixelsCurve,
  svgInsideCurve,
  minDistCurve,
  coverageCurve,
  quadSegs,
} from './_strokeCurveRef.mjs';
import { makeStrokeEmu, strokeRowsOf } from './_strokeBandEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const t0 = Date.now();
const JOINS = ['miter', 'round', 'bevel', 'miter-clip', 'arcs'];

const cases = makeCurveCases(0x2c17, 300)
  .concat(makeCurveCases(0x4f31, 300))
  .filter((cs) => cs.segs.length >= 2 || cs.closed);
// (b) walks three rules over five join styles, so it takes one seed; (a), (d) and the AA pass take
// the whole set.
const half = cases.filter((_, i) => i % 2 === 0);

// ---- (a) the encoder's asymmetry -----------------------------------------------------------------
{
  let verts = 0,
    finite = 0;
  for (const cs of cases)
    for (const s of cs.segs) {
      if (!s.freeStart) {
        verts++;
        if (s.startPrevReach < 1e8) finite++;
      }
      if (!s.freeEnd) {
        verts++;
        if (s.endNextReach < 1e8) finite++;
      }
    }
  ok(
    finite > 0 && finite < verts,
    `(a) src/svg/textures.js makes the neighbour reach finite at ${finite} of ${verts} interior vertex-ends (${((100 * finite) / verts).toFixed(1)}%) — next to a free end and nowhere else, so a gate on it could never mean one thing`,
  );
  const tex = readFileSync(path.join(ROOT, 'src/svg/textures.js'), 'utf8');
  ok(
    /const endNextReach = \(ni >= 0 && freeEnd\[ni\] === 1\) \? segLens\[ni\] : kJoinReachInf;/.test(
      tex,
    ) &&
      /const startPrevReach = \(pi >= 0 && freeStart\[pi\] === 1\) \? segLens\[pi\] : kJoinReachInf;/.test(
        tex,
      ),
    '(a) and it still WRITES them: the HLSL twin gates on the field and a bundle is portable, so the encoder keeps the 1e9 sentinel',
  );
}

// ---- (b) the rule, on curved chains ---------------------------------------------------------------
const memb = {};
for (const join of [0, 1, 2, 3, 4]) {
  memb[join] = {};
  for (const rule of ['fixed', 'wedgeVertexDrop', 'dropWedge']) {
    let out = 0,
      miss = 0,
      n = 0;
    for (const cs of half)
      for (const c of pixelsCurve(cs)) {
        const sv = svgInsideCurve(c, cs.segs, cs.closed, cs.halfW, cs.cap, join, cs.miterLimit);
        const p =
          minDistCurve(rule, c, cs.segs, cs.halfW, cs.cap, join, cs.miterLimit).minD <= cs.halfW;
        n++;
        if (p && !sv) out++;
        if (!p && sv) miss++;
      }
    memb[join][rule] = { out, miss, n };
  }
}
{
  const f = (j, r) => `${memb[j][r].out}/${memb[j][r].miss}`;
  ok(
    [0, 3].every((j) => memb[j].fixed.out === 0 && memb[j].wedgeVertexDrop.out > 0),
    `(b) nothing is painted outside the SVG 2 shape: miter ${f(0, 'wedgeVertexDrop')} -> ${f(0, 'fixed')}, miter-clip ${f(3, 'wedgeVertexDrop')} -> ${f(3, 'fixed')} (painted outside / unpainted inside, ${memb[0].fixed.n} centers over ONE of the two seeds; the whole set is 1,686,625 and gives 42/259 -> 0/263 and 139/102 -> 0/103)`,
  );
  ok(
    memb[4].fixed.out < memb[4].wedgeVertexDrop.out,
    `(b) arcs too, against SVG 2's miter-clip construction: ${f(4, 'wedgeVertexDrop')} -> ${f(4, 'fixed')} (its own region is a separate known gap, not this check's)`,
  );
  ok(
    [1, 2].every(
      (j) =>
        memb[j].fixed.out === memb[j].wedgeVertexDrop.out &&
        memb[j].fixed.miss === memb[j].wedgeVertexDrop.miss,
    ),
    `(b) round and bevel take neither branch and do not move: round ${f(1, 'fixed')}, bevel ${f(2, 'fixed')}`,
  );
  ok(
    [0, 3].every(
      (j) => memb[j].dropWedge.out === 0 && memb[j].dropWedge.miss >= memb[j].fixed.miss,
    ),
    `(b) a hard DROP reaches the same membership and no better: miter ${f(0, 'dropWedge')}, miter-clip ${f(3, 'dropWedge')}`,
  );
}

// ---- (c) AA, which is what separates the butt end from the drop ------------------------------------
{
  const set = makeCurveCases(0x2c17, 300)
    .filter((cs) => cs.segs.length >= 2 || cs.closed)
    .filter((cs) =>
      cs.segs.some(
        (s) => (!s.freeStart && s.startPrevReach < 1e8) || (!s.freeEnd && s.endNextReach < 1e8),
      ),
    )
    .slice(0, 40);
  const SS = 16;
  const report = [];
  let better = 0;
  for (const join of [0, 3]) {
    const err = { fixed: 0, wedgeVertexDrop: 0, dropWedge: 0 };
    let exact = 0,
      np = 0;
    for (const cs of set) {
      const verts = [];
      for (const s of cs.segs) {
        if (!s.freeStart) verts.push(s.p0);
        if (!s.freeEnd) verts.push(s.p2);
      }
      for (const c of pixelsCurve(cs)) {
        if (!verts.some((v) => Math.hypot(c[0] - v[0], c[1] - v[1]) <= 3 * cs.halfW + 2)) continue;
        let a = 0;
        for (let i = 0; i < SS; i++)
          for (let j = 0; j < SS; j++)
            if (
              svgInsideCurve(
                [c[0] - 0.5 + (i + 0.5) / SS, c[1] - 0.5 + (j + 0.5) / SS],
                cs.segs,
                cs.closed,
                cs.halfW,
                cs.cap,
                join,
                cs.miterLimit,
              )
            )
              a++;
        a /= SS * SS;
        exact += a;
        np++;
        for (const rule of Object.keys(err))
          err[rule] += Math.abs(
            coverageCurve(rule, c, cs.segs, cs.halfW, cs.cap, join, cs.miterLimit) - a,
          );
      }
    }
    if (err.fixed < err.wedgeVertexDrop && err.fixed < err.dropWedge) better++;
    report.push(
      `${JOINS[join]} ${err.wedgeVertexDrop.toFixed(1)} -> ${err.fixed.toFixed(1)} (a hard drop: ${err.dropWedge.toFixed(1)}; ${np} pixels, exact area ${exact.toFixed(1)})`,
    );
  }
  ok(
    better === 2,
    `(c) summed |coverage - exact| over the pixels near an interior vertex: ${report.join('; ')}`,
  );
}

// ---- (d) end to end: importSvg, then the cover quad and the band walk ------------------------------
{
  // Poly-quad paths with interior joins, at one em per pixel, so the emulator's bands and cover
  // quad are the renderer's own. Dashes and asymmetric caps are not modelled there, so neither is
  // used here.
  let rows = 0,
    n = 0,
    unpainted = 0,
    outsideQuad = 0,
    skipped = 0;
  for (const cs of cases.slice(0, 90)) {
    if (cs.joinStyle === 1 || cs.joinStyle === 2) continue;
    const reach = cs.halfW * Math.sqrt(Math.max(cs.miterLimit, 1) ** 2 + 1) + 2;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const [a, b, d] of cs.Q)
      for (const p of [a, b, d]) {
        x0 = Math.min(x0, p[0]);
        y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]);
        y1 = Math.max(y1, p[1]);
      }
    const vb = [x0 - reach, y0 - reach, x1 - x0 + 2 * reach, y1 - y0 + 2 * reach];
    const d =
      `M ${cs.Q[0][0][0]} ${cs.Q[0][0][1]} ` +
      cs.Q.map(([, b, e]) => `Q ${b[0]} ${b[1]} ${e[0]} ${e[1]}`).join(' ') +
      (cs.closed ? ' Z' : '');
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(' ')}"><path d="${d}" fill="none" stroke="#000" stroke-width="${2 * cs.halfW}"` +
      ` stroke-linecap="${['butt', 'round', 'square'][cs.cap]}" stroke-linejoin="${JOINS[cs.joinStyle]}" stroke-miterlimit="${cs.miterLimit}"/></svg>`;
    const b = await importSvg(svg);
    const row = strokeRowsOf(b)[0];
    if (row == null) continue;
    rows++;
    const emu = makeStrokeEmu(b, row, { kind: 'quad' });
    const eps = 1e-4 * cs.halfW;
    for (const c of pixelsCurve(cs)) {
      const inPort =
        minDistCurve('fixed', c, cs.segs, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit).minD <=
        cs.halfW;
      if (!inPort) continue;
      // skip centers sitting on the boundary: the bundle is float32 and the port is float64
      const near = [
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
          inPort,
      );
      if (near) {
        skipped++;
        continue;
      }
      n++;
      const r = emu.eval(c);
      if (!r.inQuad) outsideQuad++;
      else if (!(r.minD <= cs.halfW * (1 + 1e-5))) unpainted++;
    }
  }
  ok(
    rows >= 40 && n > 20000 && unpainted === 0 && outsideQuad === 0,
    `(d) end to end over ${rows} curve stroke rows: of ${n} centers the new rule inks, ${unpainted} are unreached by the band walk and ${outsideQuad} fall outside the cover quad (${skipped} on a boundary skipped)`,
  );
}

// ---- (e) the shader text ---------------------------------------------------------------------------
{
  const sm = readFileSync(path.join(ROOT, 'src/shaders/_strokeMath.glsl'), 'utf8');
  const sc = readFileSync(path.join(ROOT, 'src/shaders/_strokeCoverage.glsl'), 'utf8');
  const cv = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8');
  // One copy serves both ends (ep the end at hand, uOwn its outward direction).
  ok(
    /\} else if \(\(joinStyle == 0 \|\| joinStyle == 3 \|\| joinStyle == 4\) && outWedge\) \{/.test(
      sm,
    ),
    '(e) miter, miter-clip and arcs share ONE wedge test',
  );
  ok(
    /thisD = max\(thisD, halfW \+ dot\(-ep, uOwn\)\);/.test(sm),
    "(e) and outside it a butt end, the line branch's max(dist, halfW + aOut)",
  );
  ok(
    /if \(t < 1e-4 \|\| t > 1\.0 - 1e-4\) \{\s*bool atS = t < 1e-4;/.test(sm) &&
      /bool outWedge = atS \? dot\(-ep, inTan\) < 0\.0 : dot\(-ep, outTan\) > 0\.0;/.test(sm) &&
      /vec2 uOwn = atS \? -tOwn : tOwn;/.test(sm),
    '(e) at both vertices: the start takes the incoming side, the end the outgoing one',
  );
  const noComments = (t) => t.replace(/^\s*\/\/.*$/gm, '');
  ok(
    !/startPrevReach|endNextReach/.test(noComments(sm)),
    '(e) strokeCapsJoinsDash and the three accums take no reach at all',
  );
  ok(!/joinReach|1e9, 1e9/.test(noComments(cv)), '(e) and the main band walk passes none');
  ok(
    !/reachS|reachE/.test(noComments(sc)),
    '(e) nor the split-stroke route (no 0 at every interior join)',
  );
  for (const f of ['mantle.frag.glsl', 'splitStroke.frag.glsl', 'maskBake.frag.glsl']) {
    const g = readFileSync(path.join(ROOT, 'src/shaders/generated', f), 'utf8');
    ok(!/startPrevReach|endNextReach/.test(noComments(g)), `(e) generated/${f} is rebuilt from it`);
  }
}

console.log(
  `${fail ? 'STROKE-CURVE-WEDGE FAIL' : 'STROKE-CURVE-WEDGE PASS'} (${((Date.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(fail ? 1 : 0);
