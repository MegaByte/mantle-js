// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeArcSectorSmoke — a circular arc's stroke is covered as the exact area of its ANNULUS SECTOR.
//
// THE HAZARD. The main pass takes a stroke's coverage from the winning feature's EDGE RECORD. If a segment's body
// recorded the offset curve's TANGENT PLANE at the closest point, an arc would lose: its offsets are circles, across
// a pixel the plane misses the circle's bulge, most on the inner side of a tight arc, and one plane cannot hold both
// sides of a stroke thinner than the pixel. At an end the tangent plane cut by the end's plane is not the arc's
// shape; about the center of an arc whose inner offset radius is under a pixel no plane is; and where the arc's
// radius is under halfW its normals run on through the center -- a stroked 0.6 px arc 5 px wide would leave pixels
// at its center at 15/255 for 255.
//
// THE RECORD (_coverage.glsl, the band walk's arc loop and strokeExactCov op 5):
//   * a circle's body is its annulus sector, the points R + s along the radius at each angle of the sweep, |s| <=
//     halfW -- and, with R < halfW, the opposite sector of the disc of radius halfW - R -- whose share of the pixel box
//     is closed form: each circle's segment areas over the box's edges clipped to the sector's two rays;
//   * where the pixel box lies wholly inside the sector the annulus alone (no ray crosses it); where it does not, the
//     sector is the stroke's whole shape when the arc's subpath has free BUTT ends, and with free ROUND ends where
//     each cap's half-disc lies beyond its ray clear of the other (R >= halfW, the gap wider than both): those caps are
//     added in closed form, as the exact-coverage round caps are.
//
// (a) THE KERNEL, against float64: strokeExactCov on sector records -- R and halfW from 0.3 to 300 px, sweeps from a
//     sliver to nearly a full turn, R above and below halfW, butt and round ends -- about every feature, under four
//     frames, at 2^-20, 1 and 2^20, against the region box-sampled 512 x 512;
// (b) END TO END, the main pass (test/_strokeMainCov.mjs mainCov: the shipped walk and main()'s choice, in float32)
//     against SVG 2's shape box-sampled (test/_strokeCubicArcRef.mjs svgInsideGeneric): 240-degree circular arcs of
//     radius 0.6 to 12 px, half-width 0.5 to 2.5 px, butt ends, and round ends where they are pieces of their own, at
//     2^-20, 1 and 2^20 and under rotate(30) scale(2): every partly covered pixel.
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import * as EMU from './_glslEmu.mjs';
import { strokeRowsOf, mainCov, refCov, hasExact } from './_strokeMainCov.mjs';
import { evalArc, arcSegs, svgInsideGeneric } from './_strokeCubicArcRef.mjs';

if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
if (!EMU.hasCxx()) {
  console.log('  SKIPPED: no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation');
  process.exit(0);
}
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const EXACT = hasExact(GLSL);
const emu = EMU.buildGlslEmu(ROOT, { stroke: true, glsl: GLSL });
const TWO_PI = 2 * Math.PI;
const f = (v) => +v.toPrecision(9);

// ---- (a) the kernel ---------------------------------------------------------------------------------------------------
{
  if (!/P\.w >= 5\.0/.test(GLSL)) ok(false, '(a) strokeExactCov has no sector record (op 5)');
  else {
    // The region, relative to the center: the annulus sector, the opposite sector where R < hw, and round caps.
    const inRegion = (p, R, hw, a0, sw, caps) => {
      const rho = Math.hypot(p[0], p[1]),
        th = Math.atan2(p[1], p[0]);
      const inW = (t) => (((t - a0) % TWO_PI) + TWO_PI) % TWO_PI <= sw;
      if (rho <= R + hw && rho >= R - hw && inW(th)) return true;
      if (R < hw && rho <= hw - R && inW(th + Math.PI)) return true;
      for (const [bit, a, s] of [
        [1, a0, -1],
        [2, a0 + sw, 1],
      ]) {
        if (!(caps & bit)) continue;
        const r = [Math.cos(a), Math.sin(a)],
          c = [R * r[0], R * r[1]],
          q = [p[0] - c[0], p[1] - c[1]];
        const ub = s < 0 ? [r[1], -r[0]] : [-r[1], r[0]];
        if (Math.hypot(q[0], q[1]) <= hw && q[0] * ub[0] + q[1] * ub[1] >= 0) return true;
      }
      return false;
    };
    const FRAMES = [
      [1, 0, 0, 1],
      [0.866, 0.5, -0.5, 0.866],
      [2, 0, 0, 2],
      [1, 0, 0, -1],
    ]; // conformal: circles stay circles
    let seed = 0x5ec7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const qs = [],
      want = [],
      what = [];
    for (let k = 0; k < 420; k++) {
      const N = FRAMES[k % FRAMES.length],
        e = [2 ** -20, 1, 2 ** 20][k % 3];
      const R = e * 0.3 * 2 ** (rnd() * 10),
        hw = e * 0.3 * 2 ** (rnd() * 6);
      const sw = Math.min(
          [0.05, 1, 2.5, Math.PI, 4.2, 6][k % 6] * (0.9 + 0.2 * rnd()),
          TWO_PI - 0.05,
        ),
        a0 = rnd() * TWO_PI - Math.PI;
      // round caps only where they are pieces of their own (the walk's rule)
      const capOk = R >= hw && TWO_PI - sw >= 2 * Math.asin(hw / R);
      const caps = capOk ? Math.floor(rnd() * 4) : 0;
      // the fragment: near the circles, a ray, the center or a cap
      const pick = rnd(),
        ph =
          pick < 0.4
            ? a0 + (rnd() * 1.2 - 0.1) * sw
            : pick < 0.7
              ? a0 + (rnd() < 0.5 ? 0 : sw) + (rnd() - 0.5) * 0.4
              : rnd() * TWO_PI;
      const D = pick > 0.9 ? e * rnd() * 2 : Math.max(0, R + (rnd() * 2 - 1) * (hw + 2 * e));
      const u = [Math.cos(ph), Math.sin(ph)];
      const P = [u[0], u[1], Math.abs(D - R) - hw, 5 + caps],
        Q = [R, D, a0, sw];
      qs.push({
        k: EMU.K_STROKE_EXACT,
        bb: P,
        ePx: [e, e],
        ex: [...Q, ...N, hw],
        GD: [1, 0, 0, 0],
      });
      const n = 512;
      let c = 0;
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const qx = e * ((i + 0.5) / n - 0.5),
            qy = e * ((j + 0.5) / n - 0.5);
          if (
            inRegion(
              [u[0] * D + N[0] * qx + N[2] * qy, u[1] * D + N[1] * qx + N[3] * qy],
              R,
              hw,
              a0,
              sw,
              caps,
            )
          )
            c++;
        }
      want.push(c / (n * n));
      what.push(
        `R ${(R / e).toFixed(2)} hw ${(hw / e).toFixed(2)} px, sweep ${sw.toFixed(2)}, caps ${caps}, D ${(D / e).toFixed(2)} px, 2^${Math.log2(e)}`,
      );
    }
    const got = emu.run(new Float32Array(4), new Float32Array(4), qs);
    let worst = 0,
      at = '';
    got.forEach((g, i) => {
      const d = Math.abs(g - want[i]);
      if (d > worst) {
        worst = d;
        at = `${what[i]}: ${(g * 255).toFixed(2)} for ${(want[i] * 255).toFixed(2)}`;
      }
    });
    ok(
      worst <= 1.5 / 255,
      `(a) the sector kernel against float64 over ${got.length} records: worst ${(worst * 255).toFixed(3)}/255${at ? ' -- ' + at : ''}`,
    );
  }
}

// ---- (b) end to end: circular arcs --------------------------------------------------------------------------------------
{
  const th0 = 0.4,
    th1 = th0 + 4.2;
  const stats = {};
  for (const cap of ['butt', 'round'])
    for (const [cname, M, S] of [
      ['plain', [1, 0, 0, 1], 2 ** -20],
      ['plain', [1, 0, 0, 1], 1],
      ['plain', [1, 0, 0, 1], 2 ** 20],
      ['rotate(30) scale(2)', [1.732, 1, -1, 1.732], 1],
    ]) {
      const key = `${cap} ends, ${cname}, 2^${Math.log2(S)}`;
      const st = (stats[key] = { n: 0, worst: 0, at: '' });
      for (const R of [0.6, 1.5, 3, 12])
        for (const hw of [0.5, 1, 2.5]) {
          // round ends only where each cap is a piece of its own (the rest keep their cap records)
          if (cap === 'round' && !(R >= hw && TWO_PI - 4.2 >= 2 * Math.asin(hw / R))) continue;
          const k = Math.hypot(M[0], M[1]),
            Rd = R / k,
            hwd = hw / k; // local sizes: R and hw on screen
          const ext = R + hw + 3,
            W = Math.ceil(2 * ext) + 2,
            T = [ext + 0.31, ext + 0.43];
          const a = { cx: 0, cy: 0, rx: Rd, ry: Rd, phi: 0, th0, th1 };
          const s = evalArc(0, 0, Rd, Rd, 0, th0),
            e = evalArc(0, 0, Rd, Rd, 0, th1);
          const d = `M ${f(s[0])} ${f(s[1])} A ${f(Rd)} ${f(Rd)} 0 1 1 ${f(e[0])} ${f(e[1])}`;
          const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" width="${W * S}" height="${W * S}" viewBox="0 0 ${W * S} ${W * S}">` +
            `<g transform="scale(${S}) translate(${T[0]} ${T[1]}) matrix(${M.join(' ')} 0 0)"><path d="${d}" fill="none" stroke="#000"` +
            ` stroke-width="${2 * hwd}" stroke-linecap="${cap}"/></g></svg>`;
          const B = strokeRowsOf(await importSvg(svg, { preserveViewport: true }));
          const segs = arcSegs([a], false),
            capI = cap === 'butt' ? 0 : 1;
          const det = M[0] * M[3] - M[1] * M[2],
            inv = [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det];
          const toLocal = (x, y) => {
            const dx = x - T[0],
              dy = y - T[1];
            return [inv[0] * dx + inv[2] * dy, inv[1] * dx + inv[3] * dy];
          };
          const inside = (p) => svgInsideGeneric(p, segs, false, hwd, capI, 0, 4);
          const pix = [];
          for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) pix.push([x, y]);
          const cov = mainCov(emu, B, B.rows[0], pix, S, EXACT);
          pix.forEach(([x, y], i) => {
            const r = refCov(inside, toLocal, x, y);
            if (!(r > 0 && r < 1) && !(cov[i] > 0 && cov[i] < 1)) return;
            st.n++;
            const err = Math.abs(cov[i] - r);
            if (err > st.worst) {
              st.worst = err;
              st.at = `R ${R} hw ${hw} px (${x},${y}): ${(cov[i] * 255).toFixed(1)} for ${(r * 255).toFixed(1)}`;
            }
          });
        }
    }
  for (const [key, st] of Object.entries(stats))
    ok(
      st.worst <= 3 / 255,
      `(b) circular arcs, ${key}: ${st.n} partly covered pixels, worst ${(st.worst * 255).toFixed(2)}/255 (bar 3)${st.at ? ' -- ' + st.at : ''}`,
    );
}

if (fail) {
  console.error(`strokeArcSectorSmoke: ${fail} FAILED`);
  process.exit(1);
}
console.log('strokeArcSectorSmoke: PASS');
