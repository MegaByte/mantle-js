// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbKernelTwinFidelitySmoke — the CPU twin of the Loop-Blinn kernel IS the kernel, and the raster
// it runs on IS the raster the renderer fits.
//
// WHY this EXISTS. The LB antialiasing numbers are measured with `probes/lbAccuracy/_lbKernel.mjs`
// + `_lbRaster.mjs`, a CPU model of `src/shaders/_lbVertexSetup.glsl` + `_lbCoverage.glsl` and of
// the em->pixel map. A model is worth exactly its fidelity: one that keeps a superseded term
// invalidates every measurement written against it. `_gpuModelCheck.mjs` is the falsification test
// that needs a GPU; this is the half that does not, and it pins two faults a twin can have.
//
// (1) THE TWIN MUST CARRY `arcCov`. `_lbCoverage.glsl`'s DISC branch reads
//     `(cHalf < -1.5) ? curveCov(...) : arcCov(...)` — an ellipse's curvature varies along its
//     level set and keeps the centered kappa/24, while a circle's and an annulus's do not, so those
//     take the exact moment over the chord the pixel cuts. A twin that calls curveCov on both sides
//     has, against the exact disc-in-box area, 4.8x to 40x more coverage error, and it is
//     ONE-SIDED: the moment is at least 1/24 and up to 2/24 on a diagonal cut, so such a twin reads
//     MORE coverage than the shader on every convex arc.
//
//     Checked against the SHIPPED SHADER TEXT compiled to float32 C++ (`_glslEmu.mjs`), not against
//     a second reading of it, so this cannot drift the way a hand-written twin can.
//
// (2) THE RASTER MUST FIT THE RENDERER'S BOX. `_lbRaster.viewOf` builds the em->pixel map from the
//     box `_lbRaster.shapesOf` reports, and the renderer builds that map from
//     `bundle.globalBBox` (mantle.vert `uv = (em - uGlobalBBox.xy) / uGlobalBBox.zw`, bound in
//     fillPass.js from `b.globalBBox`, with uCanvasAR from `arScale` of the same box). An off-curve
//     control point lies outside the curve it steers, so the CONTROL-POINT hull of every shape is a
//     different box: on tiger the hull is 879.96 x 940.03 at (0.152, -21.844) against the bundle's
//     873.05 x 900 at (0, 0), and a model fit to the hull renders tiger 4.4% SMALLER, at a different
//     origin, before comparing it to the GPU's pixel for pixel.
//
// A STRUCTURAL GUARD comes last: every coverage function `_lbCoverage.glsl` calls must be called by
// the twin too, which catches a case like (1) the day a new one appears.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, K_CURVE_COV, K_ARC_COV } from './_glslEmu.mjs';
import { shapesOf, viewOf } from '../probes/lbAccuracy/_lbRaster.mjs';
// NAMESPACE IMPORT, deliberately: a missing named export is an ESM LINK error, which would make
// this smoke crash instead of reporting — and a crashed smoke prints no FAIL. A twin without
// `arcCov` must read as one failed assertion, not as a stack trace.
import * as TWIN from '../probes/lbAccuracy/_lbKernel.mjs';

const { lbCoverage, curveCov, arcCov, LBK } = TWIN;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

// ── 0. the twin exports arcCov at all ────────────────────────────────────────────────────────
const hasArc = typeof arcCov === 'function';
ok(hasArc, "the twin exports arcCov (the shader's constant-curvature form)");

// ── 1. arcCov and curveCov agree with the SHIPPED shader text, in float32 ────────────────────
// The disc branch's own gradient and rank-1 Hessian for a circle of radius r at signed distance
// `s` px, with the level-set tangent at angle `th` — the same construction _lbCoverage.glsl builds
// from G7/W7/w7, so the six numbers handed to both sides are the kernel's own.
function discTerms(r, s, th, sign) {
  const L = r + s; // |p - C| in px
  const dh = [Math.cos(th), Math.sin(th)];
  const f = sign * (L - r);
  const G = [sign * dh[0], sign * dh[1]];
  const W = [-dh[1], dh[0]];
  const w = sign / L;
  // emx = (1,0), emy = (0,1): px units, so the chain rule through the em->px map is the identity.
  return [f, G[0], G[1], w * W[0] * W[0], w * W[1] * W[1], w * W[0] * W[1]];
}
if (!hasCxx()) {
  console.log('  SKIP the shipped-shader comparison: no C++ compiler ($CXX, clang++, g++, c++)');
} else if (!hasArc) {
  ok(false, "the shipped-shader comparison needs the twin's arcCov, which is absent");
} else {
  const emu = buildGlslEmu(ROOT, { curveCov: true });
  const EMPTY = new Float32Array(4);
  const qs = [],
    want = [];
  for (const r of [1.5, 3, 12, 48]) {
    for (let si = -12; si <= 12; si++) {
      const s = si / 12;
      for (let ti = 0; ti < 16; ti++) {
        const th = (ti / 16) * Math.PI * 2;
        for (const sign of [1, -1]) {
          const t = discTerms(r, s, th, sign);
          qs.push({
            k: K_ARC_COV,
            GD: [0, 0, 0, 0],
            bb: [t[0], t[1], t[2], t[3]],
            eo: false,
            c: [t[4], t[5]],
            ePx: [1, 1],
          });
          want.push(arcCov(t[0], t[1], t[2], t[3], t[4], t[5]));
          qs.push({
            k: K_CURVE_COV,
            GD: [0, 0, 0, 0],
            bb: [t[0], t[1], t[2], t[3]],
            eo: false,
            c: [t[4], t[5]],
            ePx: [1, 1],
          });
          want.push(curveCov(t[0], t[1], t[2], t[3], t[4], t[5]));
        }
      }
    }
  }
  const got = emu.run(EMPTY, EMPTY, qs);
  let maxA = 0,
    maxC = 0,
    spread = 0;
  for (let i = 0; i < qs.length; i++) {
    const d = Math.abs(got[i] - want[i]);
    if (qs[i].k === K_ARC_COV) maxA = Math.max(maxA, d);
    else maxC = Math.max(maxC, d);
    if (i % 2 === 0) spread = Math.max(spread, Math.abs(want[i] - want[i + 1])); // arcCov vs curveCov
  }
  // float64 twin against float32 shader: the two differ only by rounding, which for a coverage in
  // [0,1] built from ~20 float ops is a few ulps of 1.0. 2e-6 is ~0.0005/255.
  ok(
    maxA <= 2e-6,
    `the twin's arcCov matches the shipped arcCov (max ${(maxA * 255).toExponential(2)}/255 over ${qs.length / 2} cases)`,
  );
  ok(
    maxC <= 2e-6,
    `...and curveCov matches the shipped curveCov (max ${(maxC * 255).toExponential(2)}/255)`,
  );
  // ...and the two are not the same function, or the check above proves nothing.
  ok(
    spread > 4 / 255,
    `arcCov and curveCov genuinely differ (up to ${(spread * 255).toFixed(1)}/255 on these arcs)`,
  );
}

// ── 2. the DISC branch calls arcCov, and the ELLIPSE branch does not ──────────────────────────
// A synthetic kind-7 fragment, built exactly as lbPack writes one: aC3 = (cx, cy, r, mode) with
// mode < 0 for a plain disc and < -1.5 for an ellipse.
function discFragment(r, s, th, mode, basePx) {
  const c = [100, 100];
  const em = [c[0] + (r + s) * basePx * Math.cos(th), c[1] + (r + s) * basePx * Math.sin(th)];
  return {
    kind: LBK.DISC,
    sign: 1,
    seam: 0,
    emPerPx: basePx,
    LB0: [0, 0, 0, 0],
    LB1: [0, 0, 0, 0],
    LB2: [0, 0, 0, 0],
    LB3: [c[0], c[1], r * basePx, mode],
    tc: [0, 0, 0],
    em,
    dtcx: [0, 0, 0],
    dtcy: [0, 0, 0],
    demx: [basePx, 0],
    demy: [0, basePx],
    emQuad: null,
  };
}
{
  const basePx = 0.25; // an arbitrary em-per-pixel: coverage must not depend on it
  let moved = 0,
    worst = 0,
    matchedArc = 0,
    n = 0;
  for (const r of [2, 4, 16]) {
    for (let si = -8; si <= 8; si++) {
      for (let ti = 0; ti < 12; ti++) {
        const s = si / 10,
          th = (ti / 12) * Math.PI * 2;
        const got = lbCoverage(discFragment(r, s, th, -1, basePx), {});
        const old = lbCoverage(discFragment(r, s, th, -1, basePx), { noArcMoment: true });
        if (got === null || old === null) continue;
        n++;
        const t = discTerms(r, s, th, 1);
        if (hasArc && Math.abs(got - arcCov(t[0], t[1], t[2], t[3], t[4], t[5])) <= 1e-9)
          matchedArc++;
        const d = Math.abs(got - old);
        if (d > 1 / 255) moved++;
        worst = Math.max(worst, d);
      }
    }
  }
  ok(n > 0 && matchedArc === n, `every DISC fragment takes arcCov (${matchedArc}/${n})`);
  ok(
    moved > 0,
    `...and that is not a no-op: ${moved} of ${n} move by more than 1/255, worst ${(worst * 255).toFixed(2)}/255`,
  );
}
{
  // Ellipse (mode < -1.5): aC0.x = ry, aC0.y = cos(phi), aC1.x = sin(phi). A circle written as an
  // ellipse must still take the CENTERED kappa/24, because the branch is chosen by the slot, not by
  // the geometry — that is the thing arcCov must not be over-applied to.
  const basePx = 0.25,
    r = 4;
  let same = 0,
    n = 0;
  for (let si = -8; si <= 8; si++) {
    const F = discFragment(r, si / 10, 0.7, -2, basePx);
    F.LB0 = [r * basePx, 1, 0, 0]; // vNa = (ry, cos phi)
    F.LB1 = [0, 0, 0, 0]; // vNb.x = sin phi
    const got = lbCoverage(F, {});
    const old = lbCoverage(F, { noArcMoment: true });
    if (got === null || old === null) continue;
    n++;
    if (Math.abs(got - old) <= 1e-12) same++;
  }
  ok(
    n > 0 && same === n,
    `an ELLIPSE fragment still takes curveCov (${same}/${n} unmoved by the arc moment)`,
  );
}

// ── 3. the raster fits the box the renderer fits ─────────────────────────────────────────────
// mirrors renderer.js `arScale` — the only thing that turns globalBBox into the
// canvasAR the fill shader's basePx divides by.
function arScale(g, vw, vh) {
  const cAR = vw / vh,
    sAR = g[2] / g[3];
  return sAR > cAR ? [1, cAR / sAR] : [sAR / cAR, 1];
}
{
  const xd = await import('@xmldom/xmldom');
  globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
  globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
  const { default: importSvg } = await import('../src/svg/importer.js');
  const warn = console.warn;
  console.warn = () => {};
  // A cubic whose control points bulge well outside the curve, plus a tall box so the two axes of
  // arScale are both exercised. tiger is used when present.
  const SYNTH =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200">' +
    '<path d="M 20 20 C 20 -60 80 -60 80 20 C 80 180 20 180 20 20 Z" fill="#000"/></svg>';
  const cases = [['synthetic bulging cubic', SYNTH]];
  const TIGER = path.resolve(ROOT, 'examples/tiger.svg');
  try {
    cases.push(['tiger', readFileSync(TIGER, 'utf8')]);
  } catch {
    /* corpus asset absent */
  }
  const N = 256;
  for (const [name, svg] of cases) {
    const bundle = await importSvg(svg);
    const got0 = await shapesOf(bundle);
    const bbox = got0.bbox;
    // A `shapesOf` that returns no hull box at all: report that rather than throwing on it.
    const hullBbox = got0.hullBbox || [NaN, NaN, NaN, NaN];
    const g = bundle.globalBBox;
    const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
    ok(
      near(bbox[0], g[0]) &&
        near(bbox[1], g[1]) &&
        near(bbox[2], g[0] + g[2]) &&
        near(bbox[3], g[1] + g[3]),
      `${name}: the fitted box IS the bundle's globalBBox`,
    );
    // teeth: the control-point hull is a DIFFERENT box on this asset.
    const hullDiff = Math.max(
      Math.abs(hullBbox[0] - bbox[0]),
      Math.abs(hullBbox[1] - bbox[1]),
      Math.abs(hullBbox[2] - bbox[2]),
      Math.abs(hullBbox[3] - bbox[3]),
    );
    ok(
      hullDiff > 1e-6,
      `${name}: ...and the control hull is not that box (differs by ${hullDiff.toFixed(3)} em)`,
    );
    // the fragment shader's own basePx, from the same two uniforms.
    const shaderBasePx = g[2] / Math.max(arScale(g, N, N)[0] * N, 1);
    const view = viewOf(bbox, N);
    ok(
      Math.abs(view.basePx - shaderBasePx) <= 1e-12 * shaderBasePx + 1e-15,
      `${name}: viewOf's basePx is the shader's uGlobalBBox.z/(uCanvasAR.x*uViewportSize.x) (${view.basePx.toFixed(8)})`,
    );
    // the center of the box lands at the center of the canvas, as plane = (uv*2-1)*canvasAR does.
    const cx = g[0] + g[2] / 2,
      cy = g[1] + g[3] / 2;
    ok(
      Math.abs((cx - view.ox) / view.basePx - N / 2) <= 1e-9 &&
        Math.abs((cy - view.oy) / view.basePx - N / 2) <= 1e-9,
      `${name}: ...and the box center lands on the canvas center`,
    );
    // FIT=hull stays reachable, to reproduce a hull-fit measurement.
    const { bbox: hb } = await shapesOf(bundle, { fit: 'hull' });
    ok(
      !!hb && hb[0] === hullBbox[0] && hb[3] === hullBbox[3],
      `${name}: fit:'hull' returns the control-point hull box`,
    );
  }
  console.warn = warn;
}

// ── 4. the structural guard: no coverage function the shader calls is missing from the twin ──
{
  const glsl = readFileSync(path.join(ROOT, 'src/shaders/_lbCoverage.glsl'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
  // The twin is _lbKernel.mjs and the box-clip kernels it imports, _lbBoxCov.mjs -- where the cubic chain kernel, which
  // _lbCoverage.glsl defines, and its helpers live.
  const twin = ['probes/lbAccuracy/_lbKernel.mjs', 'probes/lbAccuracy/_lbBoxCov.mjs']
    .map((f) => readFileSync(path.join(ROOT, f), 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
  // Every *Cov-shaped callee in the kernel's own dispatch. Names, not bodies: a body is what
  // _glslEmu and _kernelSelfTest check, and a name is what can silently go missing.
  const called = new Set();
  for (const m of glsl.matchAll(/\b(\w*[Cc]ov\w*)\s*\(/g)) called.add(m[1]);
  called.delete('lbCoverage');
  called.delete('cpatchCoverage');
  const missing = [...called].filter((n) => !new RegExp(`\\b${n}\\s*\\(`).test(twin));
  ok(
    called.size >= 5,
    `_lbCoverage.glsl calls ${called.size} coverage kernels: ${[...called].sort().join(', ')}`,
  );
  ok(
    missing.length === 0,
    `the twin calls every one of them${missing.length ? ' — MISSING: ' + missing.join(', ') : ''}`,
  );
  // ...and every HELPER _lbCoverage.glsl defines. A gate helper is not *Cov-shaped and can go missing all the same:
  // lbTangentTriDist puts the curve band's ribbon gate on the arc's triangle, not the chord, and a twin that keeps the
  // chord discards band fragments the shader paints.
  // Exempt, and why: lbCoverage is the entry itself; lbChainCellMap / lbChainCell are the em -> pixel map under a
  // WORLD MATRIX, which the twin does not model (without one it is (p - vEm) * invE, which the twin inlines).
  const defined = [
    ...glsl.matchAll(/^\s*(?:float|vec2|vec3|vec4|mat2|bool|int)\s+(\w+)\s*\([^;{]*\)\s*\{/gm),
  ].map((m) => m[1]);
  const exempt = new Set(['lbCoverage', 'lbChainCellMap', 'lbChainCell']);
  const helpers = defined.filter((n) => !exempt.has(n));
  const lost = helpers.filter((n) => !new RegExp(`\\b${n}\\s*\\(`).test(twin));
  ok(
    helpers.length >= 4,
    `_lbCoverage.glsl defines ${helpers.length} helpers besides the exempt ones: ${helpers.join(', ')}`,
  );
  ok(
    lost.length === 0,
    `the twin ports every one of them${lost.length ? ' — MISSING: ' + lost.join(', ') : ''}`,
  );
}

console.log(fail ? `LB-KERNEL-TWIN-FIDELITY FAIL (${fail})` : 'LB-KERNEL-TWIN-FIDELITY OK');
process.exit(fail ? 1 : 0);
