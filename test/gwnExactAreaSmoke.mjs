// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnExactAreaSmoke — GWN+SDF integrates a pixel exactly where its half-plane model does not hold, on the
// per-piece ink sides that model reads.
//
// WHY.
//   the kernel's coverage is a model -- the winding at the pixel center and at most two boundary half-planes -- and
//   a shape drawn smaller than a pixel breaks it: the planes run on across a box the shape ends inside. Tiger #250 at 95
//   em a pixel: the model reads 0.62 (0.76 fused) where the exact coverage is 0.0157.
//   one ink side per CONTOUR, probed at a piece's `mid` -- for a passthrough quad the chord midpoint, a sagitta off
//   the curve -- against the other contours' CHORD polygons, fails twice. A lens's chords coincide, so a holed lens's
//   hole reads as ink (its tips 0.417 off exact); and one side per contour cannot describe a self-intersecting contour,
//   whose pieces lie where the winding steps 0 -> 1 on one stretch and 1 -> 2 on another (560 of tiger's 22,386 pieces).
//
// SO each piece's ink side is the fill rule's exact inside test on both sides of it at t = 1/4, 1/2 and 3/4
// (textures.js), +-2 where those differ, and the kernel integrates a pixel exactly -- AAC's integrands over the tree, far
// nodes by their chords, near pieces by their curves, folded -- when the walk meets a subtree wholly inside the pixel
// box, or when its model does not hold: its answer about the center is not the winding's, the nearest piece's side where
// it is nearest (from the exact winding: gwnLocalSide) is not the build's, a two-plane pixel has a piece of no one side,
// a corner's two pieces carry different ink sides, or its one plane is an end tangent at a vertex.
//
// The kernel runs from the shipped text in float32 (test/_glslEmu.mjs, MANTLE_GWN + MANTLE_GWN_SDF); the exact coverage
// is probes/fillperf/cellCoverage.mjs (the f64 box integral of the decoded outline):
// (a) the model's worst pixel: tiger #250 at 95 em a pixel reads the exact 0.0157, unfused and fused;
// (b) the exact pass is exact: forced on every pixel of lines, quads, cubics (one an S), arcs and a rotated ellipse, at
//     pixels 30, 12 and 7 units wide, at 2^-20, 1 and 2^20 -- every pixel within 1e-5 of the exact coverage;
// (c) tiger at 16 and 64 px (its shapes a few pixels across): pixels off the exact coverage by over half an 8-bit
//     level, the shipped kernel against the same kernel with the routing removed (the model everywhere);
// (d) every piece of tiger (and of any benchmark-corpus asset MANTLE_BENCH_NAMES names) whose side is one along it (a DIFFERENT exact test,
//     lbContour.js rayWindingExact, at 31 points of its float64 curve and a sixteenth of the encoder's offset) carries
//     that side; the pieces whose side changes where the build's three probes do not see it are counted;
// (e) ...and the kernel does not trust a side where it is not one: a pentagram drawn as one even-odd path, whose edges
//     cross AT their midpoints (a single midpoint probe reads "no boundary" on two of them, and a kernel that trusts it
//     drops them: 0 where the exact coverage is 0.375), has every edge marked mixed and is exact on every pixel at 2^-20, 1 and
//     2^20; around tiger's pieces whose change the probes miss, the nearest piece's local side check moves pixels to
//     exact (and removing it moves them back).
import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { benchNames, BENCH_UNSET } from './_assets.mjs';

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
const TIGER = path.join(ROOT, 'examples/tiger.svg');
if (!existsSync(TIGER)) {
  console.log('  SKIPPED: examples/tiger.svg absent (npm run fetch:fixtures)');
  process.exit(77);
}
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const importSvg = (await import('../src/svg/importer.js')).default;
globalThis.__MANTLE_DEBUG__ = true; // the per-piece ink-side hook (__GWN_SIGMA_AUDIT) is gated
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const { cellCoverage } = await import('../probes/fillperf/cellCoverage.mjs');
const { rayWindingExact } = await import('../src/geom/lbContour.js');
const f = Math.fround,
  DEF = ['MANTLE_GWN', 'MANTLE_GWN_SDF'];
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const ROUTING = '  if (!subPx && holds) return cov;',
  DETECT = 'bool subPx = false;';
ok(
  GLSL.includes(ROUTING) && GLSL.includes(DETECT),
  'the exact-pass routing is in the shipped shader text',
);
const emu = EMU.buildGlslEmu(ROOT, { defines: DEF });
const load = async (text) => {
  const b = await importSvg(text, { preserveViewport: true, gwnTree: true });
  return {
    b,
    band: new Float32Array(b.bands),
    curve: new Float32Array(b.curves),
    shapes: EMU.fillShapes(b, parseMetaBin, M).filter((s) => s.tree),
  };
};
const tigerText = readFileSync(TIGER, 'utf8');
const T = await load(tigerText);

// ---- (a) tiger #250's pixel ---------------------------------------------------------------------------------------------
{
  const sh = T.shapes.find((s) => s.s === 250),
    c = [389.9818115234375, 436.4416118011475],
    e = 95.16238403320312;
  const ex = cellCoverage(decodeSegs(T.curve, sh.range.begin, sh.range.end), c, [e, e], sh.eo);
  const q = [{ k: EMU.K_GWN, GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [e, e] }];
  const un = emu.run(T.band, T.curve, q)[0],
    fu = EMU.buildGlslEmu(ROOT, { defines: DEF, contract: true }).run(T.band, T.curve, q)[0];
  ok(
    Math.abs(un - ex) < 1e-4 && Math.abs(fu - ex) < 1e-4,
    `(a) tiger #250 at 95 em a pixel: ${un.toFixed(4)} unfused, ${fu.toFixed(4)} fused, exact ${ex.toFixed(4)} (it read 0.62 / 0.76)`,
  );
}

// ---- (b) the exact pass is exact ----------------------------------------------------------------------------------------
{
  const forced = EMU.buildGlslEmu(ROOT, {
    defines: DEF,
    glsl: GLSL.replace(DETECT, 'bool subPx = true;'),
  });
  const bodies = [
    '<path d="M10 10 L30 12 L22 30 Z"/>',
    '<path d="M10 20 Q20 0 30 20 Q20 40 10 20 Z"/>',
    '<path d="M10 20 C12 5 28 5 30 20 C28 35 12 35 10 20 Z"/>',
    '<path d="M10 10 C40 10 0 30 30 30 L10 30 Z"/>',
    '<path d="M10 20 A10 10 0 0 1 30 20 A10 10 0 0 1 10 20 Z"/>',
    '<path d="M10 20 A12 6 30 1 1 30 20 A12 6 30 1 1 10 20 Z"/>',
    '<path fill-rule="evenodd" d="M4 20 Q20 2 36 20 Q20 38 4 20 Z M12 20 Q20 13 28 20 Q20 27 12 20 Z"/>',
  ];
  for (const S of [2 ** -20, 1, 2 ** 20]) {
    let n = 0,
      worst = 0,
      at = '';
    for (const body of bodies) {
      const X = await load(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${40 * S} ${40 * S}"><g transform="scale(${S})">${body}</g></svg>`,
      );
      for (const sh of X.shapes) {
        const segs = decodeSegs(X.curve, sh.range.begin, sh.range.end);
        for (const E of [30, 12, 7]) {
          const qs = [],
            cs = [];
          for (let y = -2; y * E < 44; y++)
            for (let x = -2; x * E < 44; x++) {
              const c = [f(((x + 0.5) * E + 0.37) * S), f(((y + 0.5) * E + 0.61) * S)];
              cs.push(c);
              qs.push({
                k: EMU.K_GWN,
                GD: sh.GD,
                bb: sh.bb,
                eo: sh.eo,
                c,
                ePx: [f(E * S), f(E * S)],
              });
            }
          const r = forced.run(X.band, X.curve, qs);
          r.forEach((v, i) => {
            const d = Math.abs(v - cellCoverage(segs, cs[i], [f(E * S), f(E * S)], sh.eo));
            n++;
            if (d > worst) {
              worst = d;
              at = body.slice(9, 40);
            }
          });
        }
      }
    }
    ok(
      n > 800 && worst < 1e-5,
      `(b) at 2^${Math.log2(S)}: the exact pass on every pixel of 7 shapes of every piece type, ${n} pixels: worst |err| ${worst.toExponential(2)}${at ? ` (${at})` : ''}`,
    );
  }
}

// ---- (c) tiger at a few pixels a shape ----------------------------------------------------------------------------------
{
  const modelOnly = EMU.buildGlslEmu(ROOT, {
    defines: DEF,
    glsl: GLSL.replace(ROUTING, '  return cov;'),
  });
  const vb = T.b.viewBox;
  for (const N of [16, 64]) {
    const e = f(Math.max(vb[2], vb[3]) / N);
    let n = 0,
      bShip = 0,
      bModel = 0,
      worst = 0;
    for (const sh of T.shapes) {
      const qs = [],
        cs = [];
      for (
        let y = Math.floor((sh.bb[1] - vb[1]) / e) - 1;
        y <= Math.ceil((sh.bb[3] - vb[1]) / e);
        y++
      )
        for (
          let x = Math.floor((sh.bb[0] - vb[0]) / e) - 1;
          x <= Math.ceil((sh.bb[2] - vb[0]) / e);
          x++
        ) {
          const c = [f(vb[0] + (x + 0.5) * e), f(vb[1] + (y + 0.5) * e)];
          cs.push(c);
          qs.push({ k: EMU.K_GWN, GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [e, e] });
        }
      const a = emu.run(T.band, T.curve, qs),
        m = modelOnly.run(T.band, T.curve, qs);
      let segs = null;
      for (let i = 0; i < cs.length; i++) {
        if (a[i] === m[i] && (i & 7) !== 3) continue; // where they agree, one in 8 is scored (the model's own)
        segs = segs || decodeSegs(T.curve, sh.range.begin, sh.range.end);
        const ex = cellCoverage(segs, cs[i], [e, e], sh.eo);
        n++;
        if (Math.abs(a[i] - ex) > 1 / 510) bShip++;
        if (Math.abs(m[i] - ex) > 1 / 510) bModel++;
        if (a[i] !== m[i]) worst = Math.max(worst, Math.abs(a[i] - ex));
      }
    }
    ok(
      bShip < 0.25 * bModel && worst < 0.1,
      `(c) tiger at ${N} px, ${n} pixels scored: off the exact coverage by over half a level, the model everywhere ${bModel} -> shipped ${bShip}; the pixels the routing moves are within ${worst.toFixed(3)} of exact`,
    );
  }
}

// ---- (d) every piece's ink side, by an independent exact test ------------------------------------------------------------
const missed = []; // tiger's pieces whose side change the build's probes miss
{
  if (!benchNames().length) console.log(`  (d) ${BENCH_UNSET}`);
  for (const file of [
    TIGER,
    ...benchNames().map((n) => path.join(ROOT, 'examples/_bench', n + '.svg')),
  ]) {
    if (!existsSync(file)) {
      console.log(`  (d) ${path.basename(file)} absent -- skipped`);
      continue;
    }
    let n = 0,
      bad = 0,
      mixed = 0,
      und = 0,
      first = '';
    globalThis.__GWN_SIGMA_AUDIT = (pieces, segs, eo) => {
      if (segs.some((s) => s.type === 3)) return; // arcs: rayWindingExact has none, so a shape with arcs is left out
      const inside = (x, y) => {
        const w = rayWindingExact(segs, x, y);
        return eo ? (w & 1) !== 0 : w !== 0;
      };
      // closer than the encoder probes (2^-16 of half the speed): the side AT the curve is the limit as the offset
      // shrinks, and a probe farther out can cross a neighbour running within a hair of it
      const side = (ev, t) => {
        const [x, y, dx, dy] = ev(t),
          L = 0.5 * Math.hypot(dx, dy);
        if (!(L > 2 ** -26 * Math.max(Math.abs(x), Math.abs(y)))) return null; // no direction here
        const a = inside(x - dy * 2 ** -21, y + dx * 2 ** -21),
          b = inside(x + dy * 2 ** -21, y - dx * 2 ** -21);
        return a === b ? 0 : a ? 1 : -1;
      };
      for (const p of pieces) {
        if (!p.ev) continue;
        n++;
        const all = [];
        for (let k = 1; k < 32; k++) {
          const v = side(p.ev, k / 32);
          if (v !== null) all.push(v);
        }
        if (Math.abs(p.sigma) === 2) {
          mixed++;
          continue;
        }
        if (!all.length) {
          if (p.sigma !== 0) bad++;
          continue;
        } // no direction anywhere: no side
        if (all.some((v) => v !== all[0])) {
          und++;
          missed.push(p.ev(0.5));
          continue;
        }
        if (all[0] !== p.sigma) {
          bad++;
          if (!first)
            first = ` -- first at (${p
              .ev(0.5)
              .slice(0, 2)
              .map((v) => v.toFixed(3))}): ${p.sigma} for ${all[0]}`;
        }
      }
    };
    await importSvg(readFileSync(file, 'utf8'), { preserveViewport: true, gwnTree: true });
    globalThis.__GWN_SIGMA_AUDIT = null;
    ok(
      n > 900 && bad === 0 && und <= 0.005 * n,
      `(d) ${path.basename(file)}: ${bad} of ${n} pieces carry an ink side the symbolic exact test does not (${mixed} marked mixed; ${und} change side between the build's probes)${first}`,
    );
  }
}

// ---- (e) the kernel's own check of the nearest piece's side ----------------------------------------------------------------
{
  const LOCAL = 'float loc = c1.endNear == 0.0 ? gwnLocalSide(c1, w, evenOdd, inside) : 9.0;';
  ok(
    GLSL.includes(LOCAL),
    "(e) the nearest piece's local side check is in the shipped shader text",
  );
  const noLocal = EMU.buildGlslEmu(ROOT, {
    defines: DEF,
    glsl: GLSL.replace(LOCAL, 'float loc = c1.endNear == 0.0 ? sign(c1.sg) : 9.0;'),
  });
  const score = (X, E, qsOf) => {
    // pixels off exact by over half a level: shipped, mutated
    let n = 0,
      bS = 0,
      bM = 0;
    for (const sh of X.shapes) {
      const { qs, cs } = qsOf(sh);
      if (!qs.length) continue;
      const segs = decodeSegs(X.curve, sh.range.begin, sh.range.end);
      const a = emu.run(X.band, X.curve, qs),
        m = noLocal.run(X.band, X.curve, qs);
      for (let i = 0; i < cs.length; i++) {
        const ex = cellCoverage(segs, cs[i], [E, E], sh.eo);
        n++;
        if (Math.abs(a[i] - ex) > 1 / 510) bS++;
        if (Math.abs(m[i] - ex) > 1 / 510) bM++;
      }
    }
    return { n, bS, bM };
  };
  const star =
    '<path fill-rule="evenodd" d="M 0,0 L 10,-20 L 20,0 L 0,-15 L 20,-15 Z" transform="translate(10,30)"/>';
  for (const S of [2 ** -20, 1, 2 ** 20]) {
    const sides = [];
    globalThis.__GWN_SIGMA_AUDIT = (pieces) => {
      for (const p of pieces) if (p.ev) sides.push(p.sigma);
    };
    const X = await load(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${40 * S} ${40 * S}"><g transform="scale(${S})">${star}</g></svg>`,
    );
    globalThis.__GWN_SIGMA_AUDIT = null;
    const edges = sides.filter((v) => v !== 0); // the closing line is zero length
    let n = 0,
      bS = 0,
      bM = 0;
    for (const N of [16, 64]) {
      const E = f((40 * S) / N);
      const r = score(X, E, () => {
        const qs = [],
          cs = [];
        for (let y = 0; y < N; y++)
          for (let x = 0; x < N; x++) {
            const c = [f((x + 0.5) * E), f((y + 0.5) * E)];
            cs.push(c);
            qs.push({
              k: EMU.K_GWN,
              GD: X.shapes[0].GD,
              bb: X.shapes[0].bb,
              eo: X.shapes[0].eo,
              c,
              ePx: [E, E],
            });
          }
        return { qs, cs };
      });
      n += r.n;
      bS += r.bS;
      bM += r.bM;
    }
    ok(
      edges.length === 5 && edges.every((v) => Math.abs(v) === 2) && bS === 0,
      `(e) the even-odd pentagram at 2^${Math.log2(S)}: edge sides ${edges.join(' ')}; at 16 and 64 px off exact by over half a level, ${bS} of ${n} (${bM} with the local check removed)`,
    );
  }
  {
    // tiger, 24 px around each piece the probes missed, 8 across it
    let n = 0,
      bS = 0,
      bM = 0;
    for (const P of missed.slice(0, 29)) {
      const E = f(Math.max(Math.abs(P[2]), Math.abs(P[3])) / 8 || 1);
      const r = score(T, E, (sh) => {
        const qs = [],
          cs = [];
        if (
          P[0] < sh.bb[0] - 24 * E ||
          P[0] > sh.bb[2] + 24 * E ||
          P[1] < sh.bb[1] - 24 * E ||
          P[1] > sh.bb[3] + 24 * E
        )
          return { qs, cs };
        for (let y = -12; y < 12; y++)
          for (let x = -12; x < 12; x++) {
            const c = [f(P[0] + (x + 0.5) * E), f(P[1] + (y + 0.5) * E)];
            cs.push(c);
            qs.push({ k: EMU.K_GWN, GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [E, E] });
          }
        return { qs, cs };
      });
      n += r.n;
      bS += r.bS;
      bM += r.bM;
    }
    ok(
      missed.length > 0 && bS < bM,
      `(e) tiger around the ${missed.length} pieces whose side change the build's probes miss: off exact by over half a level, ${bS} of ${n} (with the check removed ${bM})`,
    );
  }
}
console.log(fail ? `GWN-EXACT-AREA FAIL (${fail})` : 'GWN-EXACT-AREA PASS');
process.exit(fail ? 1 : 0);
