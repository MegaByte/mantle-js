// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// zeroRadiusArcSmoke — a zero-radius arc strokes and fills as SVG's straight line between its ends.
//
// SVG draws an arc with rx or ry 0 as its chord; segment.js arcEndpointToCenter keeps it as an arc record (for morph
// topology) that is a HALF-TURN of a degenerate ellipse, a segment along one axis traced from one end to the other.
// THE HAZARDS:
// (1) the stroke kernels (the band walk, _coverage.glsl, and the split-stroke pass, _strokeMath.glsl strokeArcAccum)
//     take the closest point's angle as atan(foot.y * rx, foot.x * ry), which a zero radius makes atan(0, 0): undefined
//     in GLSL, a NaN on a strict driver, and 0 or pi under libm -- neither of them the foot's, so the arc's body would be
//     out of its own range and only its ends measured;
// (2) the ellipse turns round AT its ends, so its end velocity is float32's rounding of sin(pi), pointing either way:
//     a butt cap facing it, and the encoder (segTangentAt) and the hit test, would find no direction there;
// (3) under ANY transform, a translate included, an arc rebuild (transform.js transformArcNative) that takes the conic
//     1 / r^2 = Infinity makes the segment NaN, dropped from the fill and the stroke.
// So the foot's angle is the one of its two mirror angles the arc reaches (_arcMath.glsl arcFootAngle), a zero-radius
// arc's ends run along its chord in the shaders, the encoder, the morph's join rebuild and the hit test, and the rebuild
// maps the degenerate ellipse's axis through the matrix.
//
// (a) the split-stroke pass (test/_glslEmu.mjs buildSplitStrokeEmu, both stages from their shipped text), zero-radius
//     arcs of every kind -- rx 0, ry 0, both; phi 0, 0.7, pi/2; partial sweeps both ways and full turns -- round capped:
//     every fragment agrees with the traced segment's stroke, under the default build and the one that makes atan(0, 0)
//     a NaN (fragments within 0.1 em of the outline skipped);
// (b) the band walk (mantle.frag.glsl's main-pass coverage, test/_strokeMainCov.mjs) on SVG `A` arcs with a zero
//     radius, butt and round caps, three chords, both sweep flags, at 2^-20, 1 and 2^20: every pixel of the cover box
//     within 3/255 of the chord's own stroke, box-sampled; and in a path, `L A L` with miter and round joins, the same
//     coverage as the path with the arc written as a straight quad (a CURVE: a line meeting a curve at a round join
//     paints its own way, and a line meeting a line another -- 0.414 and 0.393 at one pixel of this path, where the
//     exact coverage is 0.393; that is not this row's);
// (c) the importer: under translate, rotate, scale(2), scale(1 0.5) and 2^-20 / 2^20, the stroke's box is its chord's;
// (d) the hit test (fillHitShape, outline) on the arc answers as on its chord, butt caps, at 2^-20, 1 and 2^20;
// (e) FILLS: Slug, AAC, band-hard and GWN+SDF on a path whose edge is a zero-radius arc read what they read with that
//     edge as `L`, at 2^-20, 1 and 2^20, plain and rotated (the transform had dropped the edge: 300 to 1,631 of 4,096
//     pixels off under rotate(30), and at every scale but 1).
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { encodeSeg, makeTexelBuffer } from '../src/svg/textures.js';
import { strokeRowsOf, mainCov, refCov, hasExact } from './_strokeMainCov.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler');
  process.exit(0);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const importSvg = (await import('../src/svg/importer.js')).default;
const { fillHitShape } = await import('../src/hitTest/hitTest.js');
const f = Math.fround;

// ---- (a) the split-stroke pass --------------------------------------------------------------------------------------
{
  const mkArc = (rx, ry, phi, th0, th1) => {
    const ev = (th) => [
      rx * Math.cos(phi) * Math.cos(th) - ry * Math.sin(phi) * Math.sin(th),
      rx * Math.sin(phi) * Math.cos(th) + ry * Math.cos(phi) * Math.sin(th),
    ];
    return {
      type: 3,
      cx: 0,
      cy: 0,
      rx,
      ry,
      phi,
      theta_start: th0,
      theta_end: th1,
      p1: ev(th0),
      p4: ev(th1),
    };
  };
  // the traced set: a segment along the axis whose radius is not zero, over the extremes of cos (ry 0) or sin (rx 0)
  // across the sweep -- its ends, and every multiple of pi / 2 inside it
  const distTo = (s, x, y) => {
    const lo = Math.min(s.theta_start, s.theta_end),
      hi = Math.max(s.theta_start, s.theta_end),
      ts = [lo, hi];
    for (let k = Math.ceil(lo / (Math.PI / 2)); (k * Math.PI) / 2 <= hi; k++)
      ts.push((k * Math.PI) / 2);
    const u = ts.map((t) => (s.rx !== 0 ? s.rx * Math.cos(t) : s.ry * Math.sin(t))),
      a = Math.min(...u),
      b = Math.max(...u);
    const c = Math.cos(s.phi),
      sn = Math.sin(s.phi),
      lx = x * c + y * sn,
      ly = -x * sn + y * c;
    const [along, across] = s.rx !== 0 ? [lx, ly] : [ly, lx];
    return Math.hypot(along - Math.min(Math.max(along, a), b), across);
  };
  for (const [tag, emu] of [
    ['default', EMU.buildSplitStrokeEmu(ROOT)],
    ['atan(0, 0) a NaN', EMU.buildSplitStrokeEmu(ROOT, { nanPoison: true })],
  ]) {
    let n = 0,
      bad = 0,
      arcs = 0,
      first = '';
    for (const [rx, ry] of [
      [0, 6],
      [6, 0],
      [0, 0],
    ])
      for (const phi of [0, 0.7, Math.PI / 2])
        for (const [th0, sw] of [
          [0.4, 1.0],
          [0.4, -1.0],
          [-0.5, 1.0],
          [2.0, 2.5],
          [Math.PI, Math.PI],
          [0.4, 2 * Math.PI],
          [0.4, 3 * Math.PI],
        ]) {
          const s = mkArc(rx, ry, phi, th0, th0 + sw),
            buf = makeTexelBuffer();
          const base = encodeSeg(s, buf, true, true, [0, 0], [0, 0], 0);
          const prim = new Float32Array(buf.floats.subarray(0, buf.count * 4));
          const qs = [],
            want = [];
          for (let y = -7.95; y < 8; y += 0.1)
            for (let x = -7.95; x < 8; x += 0.1) {
              const d = distTo(s, x, y);
              if (Math.abs(d - 0.5) < 0.1) continue;
              qs.push({
                base,
                c: [f(x), f(y)],
                ePx: [0.05, 0.05],
                halfW: 0.5,
                cap: 1,
                join: 1,
                miterLimit: 4,
              });
              want.push(d < 0.5);
            }
          const cov = emu.run(prim, qs);
          let b = 0;
          cov.forEach((v, i) => {
            if (!(v > 0.5 === want[i])) b++;
          });
          n += qs.length;
          bad += b;
          arcs++;
          if (b && !first)
            first = ` -- first rx ${rx} ry ${ry} phi ${phi.toFixed(2)} from ${th0} by ${sw.toFixed(2)}: ${b} wrong`;
        }
    ok(
      bad === 0 && n > 1e6,
      `(a) split stroke, ${tag}: ${arcs} zero-radius arcs, ${bad} of ${n} fragments off the traced segment's stroke${first}`,
    );
  }
}

// ---- (b) the band walk ------------------------------------------------------------------------------------------------
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const semu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl: GLSL }),
  EXACT = hasExact(GLSL);
const svgOf = (d, S, cap, join = 'miter') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${50 * S}" height="${50 * S}" viewBox="0 0 ${50 * S} ${50 * S}">` +
  `<g transform="scale(${S})"><path d="${d}" fill="none" stroke="#000" stroke-width="3" stroke-linecap="${cap}" stroke-linejoin="${join}"/></g></svg>`;
const coverPix = (B, S) => {
  // the pixels of the row's cover box and one around it
  const rb = B.rows[0].bb.map((v) => v / S),
    pix = [];
  for (let y = 0; y < 50; y++)
    for (let x = 0; x < 50; x++)
      if (x + 1 >= rb[0] - 1 && x <= rb[2] + 1 && y + 1 >= rb[1] - 1 && y <= rb[3] + 1)
        pix.push([x, y]);
  return pix;
};
for (const S of [2 ** -20, 1, 2 ** 20]) {
  let n = 0,
    bad = 0,
    worst = 0,
    at = '';
  for (const [rx, ry] of [
    [0, 5],
    [5, 0],
    [0, 0],
  ])
    for (const cap of ['butt', 'round'])
      for (const sweep of [0, 1])
        for (const [P, Q] of [
          [
            [6, 20],
            [44, 20],
          ],
          [
            [8, 9],
            [41, 33],
          ],
          [
            [40, 30],
            [9, 12],
          ],
        ]) {
          const B = strokeRowsOf(
            await importSvg(
              svgOf(`M ${P[0]} ${P[1]} A ${rx} ${ry} 20 0 ${sweep} ${Q[0]} ${Q[1]}`, S, cap),
              { preserveViewport: true },
            ),
          );
          const L = Math.hypot(Q[0] - P[0], Q[1] - P[1]),
            u = [(Q[0] - P[0]) / L, (Q[1] - P[1]) / L];
          const inside = (p) => {
            const dx = p[0] - P[0],
              dy = p[1] - P[1],
              a = dx * u[0] + dy * u[1],
              b = -dx * u[1] + dy * u[0];
            if (cap === 'butt') return a >= 0 && a <= L && Math.abs(b) <= 1.5;
            return Math.hypot(a - Math.min(Math.max(a, 0), L), b) <= 1.5;
          };
          const pix = coverPix(B, S),
            cov = mainCov(semu, B, B.rows[0], pix, S, EXACT);
          pix.forEach(([x, y], i) => {
            const e = Math.abs(cov[i] - refCov(inside, (a, b) => [a, b], x, y));
            n++;
            if (e > 3 / 255) bad++;
            if (e > worst) {
              worst = e;
              at = ` (A ${rx} ${ry}, ${cap}, px ${x},${y})`;
            }
          });
        }
  ok(
    bad === 0 && n > 20000,
    `(b) band walk at 2^${Math.log2(S)}: 18 zero-radius SVG arcs, ${bad} of ${n} pixels off the chord's stroke by over 3/255, worst ${(worst * 255).toFixed(2)}/255${bad ? at : ''}`,
  );
  let jn = 0,
    jbad = 0;
  for (const join of ['miter', 'round'])
    for (const cap of ['butt', 'square']) {
      const arc = strokeRowsOf(
        await importSvg(svgOf('M 6 40 L 12 22 A 0 0 0 0 1 36 22 L 44 6', S, cap, join), {
          preserveViewport: true,
        }),
      );
      const line = strokeRowsOf(
        await importSvg(svgOf('M 6 40 L 12 22 Q 24 22 36 22 L 44 6', S, cap, join), {
          preserveViewport: true,
        }),
      );
      const pix = coverPix(line, S),
        a = mainCov(semu, arc, arc.rows[0], pix, S, EXACT),
        l = mainCov(semu, line, line.rows[0], pix, S, EXACT);
      pix.forEach((_, i) => {
        jn++;
        if (Math.abs(a[i] - l[i]) > 3 / 255) jbad++;
      });
    }
  ok(
    jbad === 0 && jn > 2000,
    `(b) band walk at 2^${Math.log2(S)}: \`L A L\` joined (miter, round; butt, square) against the same path with the arc as a straight \`Q\`: ${jbad} of ${jn} pixels differ by over 3/255`,
  );
}

// ---- (c) the importer under a transform ------------------------------------------------------------------------------
{
  let bad = 0,
    n = 0,
    first = '';
  const box = async (d, tr, S) => {
    const b = await importSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${100 * S} ${100 * S}"><g transform="scale(${S}) ${tr}"><path d="${d}" fill="none" stroke="#000" stroke-width="3"/></g></svg>`,
      { preserveViewport: true },
    );
    return Array.from(new Float32Array(b.meta, 32).slice(0, 4));
  };
  for (const S of [2 ** -20, 1, 2 ** 20])
    for (const tr of [
      'translate(3 2)',
      'rotate(30 25 25)',
      'scale(2)',
      'scale(1 0.5)',
      'matrix(1 0.3 -0.2 0.9 4 5)',
    ])
      for (const a of ['A 5 0 20 0 1', 'A 0 5 20 0 0', 'A 0 0 0 0 1']) {
        const got = await box(`M 6 20 ${a} 44 20`, tr, S),
          want = await box('M 6 20 L 44 20', tr, S);
        n++;
        if (
          !got.every(
            (v, i) =>
              Number.isFinite(v) &&
              Math.abs(v - want[i]) <= 1e-5 * Math.abs(want[i]) + 1e-5 * 50 * S,
          )
        ) {
          bad++;
          if (!first)
            first = ` -- first ${a} under ${tr} at 2^${Math.log2(S)}: ${got.map((v) => v.toPrecision(4))} for ${want.map((v) => v.toPrecision(4))}`;
        }
      }
  ok(
    bad === 0,
    `(c) ${n} zero-radius arcs under a transform: ${bad} whose stroke box is not the chord's${first}`,
  );
}

// ---- (d) the hit test -------------------------------------------------------------------------------------------------
{
  let n = 0,
    bad = 0,
    first = '';
  for (const S of [2 ** -20, 1, 2 ** 20])
    for (const a of ['A 5 0 20 0 1', 'A 0 5 20 0 0', 'A 0 0 0 0 1']) {
      const arc = await importSvg(svgOf(`M 8 9 ${a} 41 33`, S, 'butt'), { preserveViewport: true });
      const line = await importSvg(svgOf('M 8 9 L 41 33', S, 'butt'), { preserveViewport: true });
      for (let y = 0.37; y < 50; y += 0.9)
        for (let x = 0.61; x < 50; x += 0.9) {
          const h = fillHitShape(arc, x * S, y * S, 'outline'),
            w = fillHitShape(line, x * S, y * S, 'outline');
          n++;
          if (h !== w) {
            bad++;
            if (!first)
              first = ` -- first ${a} at 2^${Math.log2(S)} (${x.toFixed(2)}, ${y.toFixed(2)}): ${h} for ${w}`;
          }
        }
    }
  ok(
    bad === 0 && n > 5000,
    `(d) hit test: ${n} points on and around zero-radius arcs, butt capped, ${bad} answered unlike the chord${first}`,
  );
}
// ---- (e) fills --------------------------------------------------------------------------------------------------------
{
  const { parseMetaBin } = await import('../src/renderer/bundle.js');
  const M = await import('../src/bundle/layout.js');
  const K = {
    Slug: [EMU.K_SLUG, []],
    AAC: [EMU.K_AAC, ['MANTLE_AAC', 'MANTLE_AAC_PAIR_BANDS']],
    'band-hard': [EMU.K_HARD, ['MANTLE_HARD']],
    'GWN+SDF': [EMU.K_GWN, ['MANTLE_GWN', 'MANTLE_GWN_SDF']],
  };
  for (const [k, [kid, defs]] of Object.entries(K)) {
    const emu = EMU.buildGlslEmu(ROOT, { defines: defs, glsl: GLSL }),
      gwnTree = kid === EMU.K_GWN;
    let n = 0,
      bad = 0,
      first = '';
    for (const tr of ['', 'rotate(30 25 25)'])
      for (const S of [2 ** -20, 1, 2 ** 20])
        for (const arc of ['A 0 0 0 0 1', 'A 5 0 20 0 0']) {
          const ld = async (edge) => {
            const b = await importSvg(
              `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${50 * S} ${50 * S}"><g transform="scale(${S}) ${tr}"><path d="M 10 10 L 40 12 L 38 40 ${edge} 10 10 Z" fill="#000"/></g></svg>`,
              { preserveViewport: true, gwnTree },
            );
            return {
              band: new Float32Array(b.bands),
              curve: new Float32Array(b.curves),
              sh: EMU.fillShapes(b, parseMetaBin, M)[0],
            };
          };
          const A = await ld(arc),
            L = await ld('L');
          const e = f((S * 50) / 64),
            q = (X) => {
              const out = [];
              for (let y = 0; y < 64; y++)
                for (let x = 0; x < 64; x++)
                  out.push({
                    k: kid,
                    GD: X.sh.GD,
                    bb: X.sh.bb,
                    eo: X.sh.eo,
                    c: [f((x + 0.5) * e), f((y + 0.5) * e)],
                    ePx: [e, e],
                  });
              return out;
            };
          const ra = emu.run(A.band, A.curve, q(A)),
            rl = emu.run(L.band, L.curve, q(L));
          ra.forEach((v, i) => {
            n++;
            if (!(Math.abs(v - rl[i]) <= 1 / 255)) {
              bad++;
              if (!first) first = ` -- first ${arc} ${tr || 'plain'} at 2^${Math.log2(S)}`;
            }
          });
        }
    ok(
      bad === 0 && n > 40000,
      `(e) ${k}: a fill edge that is a zero-radius arc, ${bad} of ${n} pixels off the same edge as \`L\` by over 1/255${first}`,
    );
  }
}
console.log(fail ? `ZERO-RADIUS-ARC FAIL (${fail})` : 'ZERO-RADIUS-ARC PASS');
process.exit(fail ? 1 : 0);
