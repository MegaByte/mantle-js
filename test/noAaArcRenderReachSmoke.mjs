// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// noAaArcRenderReachSmoke — the no-AA arc branch is REACHABLE from an imported asset, and an asset can
// hide its own evidence under a stroke.
//
// THE QUESTION. `test/noAaArcRowSmoke.mjs` proves the rule: with an `arcOnRayTol` window, band-hard
// miscounts an arc's ray crossings wherever an endpoint falls inside it. What it does not decide is
// whether a RENDER can show that — it calls renderFillHardBand on shapes the route would never send
// there (its fixtures are fill-only, and band-hard needs an opaque covering stroke), and it samples rows
// the raster does not have. `examples/smoke/noAaArcRow__FAR.svg` is an asset for that gap, and on a GPU
// it scores 0 wrong solid with the window and without it, which leaves two readings open: the branch is
// unreachable from ordinary content, or the asset is the wrong asset.
//
// IT IS THE WRONG ASSET, and this test says so with the renderer's own encoder output on the
// render's own pixel grid. Both shader texts here are the SHIPPED assembled text; the window-rule one
// is that text with hardCrossArc's body swapped for the windowed body below, so nothing else moves.
//
//   (a) FAR reaches the branch after all: at 512 the two texts disagree at 29 pixel centers, in
//       runs of 5. Every one of the 29 lies within 0.71 em of the outline and the covering stroke
//       is 3 em wide, so all 29 are painted over. FAR is six closed ellipses, each two half-turn
//       arcs sharing both endpoints, so a miscount's run ends at the same shape's other side a few
//       pixels away — the flip has nowhere to go but under the stroke. That is the whole reason a
//       GPU reads 0 both ways, and it is a property of the asset, not of the kernel.
//   (b) `examples/smoke/noAaArcRow__GAP.svg` gives the run somewhere to go — a bar and two arc
//       lobes in one path, with open canvas between them. With the window: thousands of wrong centers
//       in runs of hundreds, the large majority farther from the outline than the stroke half-width,
//       so a render MUST show them. Shipped: none outside it.
//   (c) the route reaches it with nothing pinned: the bundle's own `noAaFill` is set, the arc bit is
//       in `segTypeMask`, the segment count is under band-hard's ceiling, and the stroke is over the
//       2-device-pixel floor at 512 — which is every static condition `preferNoAa` tests.
//
// WHAT THE BRANCH THEREFORE NEEDS FROM AN ASSET. The window is a width in EM, so it spans a pixel row
// only when 1e-5 * (|cy| + rx + ry) >= extent / N: a distance from the origin of about 1e5 / N
// times the drawing's own extent. GAP is 555x its extent from the origin at N = 512. That is a
// reachability CONDITION, not an impossibility: art authored in a large coordinate space carries it
// when its coordinates are STORED as authored.
//
// THE IMPORTER DOES NOT STORE THEM AS AUTHORED. Art far from the document origin compared to its own
// size (ORIGIN_RATIO = 64 extents) is stored relative to a bundle origin by default, so FAR and GAP
// import at their own size from zero, the window above is a few hundredths of a pixel, and both shader
// texts agree at every pixel center: (d) asserts exactly that, the bundle origin's coordinate precision
// reaching this case from the importer's side. (a)-(c) keep the claim about the KERNEL by importing with
// `origin: false`, the documented opt-out that stores absolute coordinates, which is also what an
// explicit origin far from the art (opts.origin) reproduces.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_HARD } from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP noAaArcRenderReachSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
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

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');

// ---- the windowed hardCrossArc (the arcOnRayTol rule) ----------------------------------------------------------------
// ...with the window it reads, which the shipped text does not declare (Slug's walkers carry none either).
const PRE_FIX_ARC = `float arcOnRayTol(vec4 d1) { return 1e-5 * (abs(d1.y) + abs(d1.z) + abs(d1.w)); }
float hardCrossArc(vec2 c, vec4 d1, vec4 d2, vec4 ends) {   // (ends: the stored endpoints; the window rule rebuilds them from the angles)
  float sp = sin(d2.z), cp = cos(d2.z);
  float w = 0.0;
  float A = sp * d1.z, B = cp * d1.w, C = -(d1.y - c.y);
  float Rlen = sqrt(A * A + B * B);
  float arcDir = (d2.y >= d2.x) ? 1.0 : -1.0;
  bool tangent = (Rlen == 0.0) ? true : (abs(C / Rlen) >= 0.99999);
  vec2 pS, pE; float sx, sy, ex, ey;
  arcSample(d1, cp, sp, d2.x, pS, sx, sy);
  arcSample(d1, cp, sp, d2.y, pE, ex, ey);
  float aTol = arcOnRayTol(d1);
  bool sOn = abs(pS.y - c.y) < aTol, eOn = abs(pE.y - c.y) < aTol;
  if (sOn && (tangent ? C > 0.0 : arcDir * sy < 0.0) && pS.x > c.x) w -= 1.0;
  if (eOn && (tangent ? C > 0.0 : arcDir * ey > 0.0) && pE.x > c.x) w += 1.0;
  if (tangent) return w;
  float ang = atan(B, A), b2 = acos(clamp(C / Rlen, -1.0, 1.0));
  for (int k = 0; k < 2; k++) {
    float th = (k == 0) ? (ang + b2) : (ang - b2);
    bool own = (k == 0) ? ((sOn && sy < 0.0) || (eOn && ey < 0.0)) : ((sOn && sy >= 0.0) || (eOn && ey >= 0.0));
    if (own || !arcInRange(th, d2.x, d2.y)) continue;
    vec2 pnt; float ddx, ddy; arcSample(d1, cp, sp, th, pnt, ddx, ddy);
    if (pnt.x <= c.x) continue;
    w -= arcDir * ((ddy < 0.0) ? 1.0 : -1.0);
  }
  return w;
}`;
/// Replace hardCrossArc's whole definition in an assembled shader text, brace-matched.
function swapArc(text, body) {
  const i = text.indexOf('float hardCrossArc(vec2 c, vec4 d1, vec4 d2, vec4 ends) {');
  if (i < 0) throw new Error('hardCrossArc is not in the shader text');
  let d = 0;
  for (let k = text.indexOf('{', i); k < text.length; k++) {
    if (text[k] === '{') d++;
    else if (text[k] === '}' && --d === 0) return text.slice(0, i) + body + text.slice(k + 1);
  }
  throw new Error('hardCrossArc does not close');
}
const GLSL_PRE = swapArc(GLSL, PRE_FIX_ARC);
ok(
  GLSL_PRE !== GLSL && GLSL_PRE.includes('float aTol = arcOnRayTol(d1);'),
  'the windowed hardCrossArc swaps into the shipped text (and the shipped one carries no arcOnRayTol)',
);
ok(
  !/float hardCrossArc[\s\S]{0,2000}?arcOnRayTol/.test(GLSL),
  'the SHIPPED hardCrossArc has no tolerance window in it',
);

async function load(file, opts = { origin: false }) {
  const b = await importSvg(readFileSync(path.join(ROOT, file), 'utf8'), {
    preserveViewport: true,
    ...opts,
  });
  const shapes = fillShapes(b, parseMetaBin, M);
  const curve = new Float32Array(b.curves);
  for (const sh of shapes) {
    const cs = contoursToConverter(curveRangeToContours(curve, sh.range.begin, sh.range.end), null);
    sh.segs = cs ? cs.flat() : null;
  }
  return { b, shapes, band: new Float32Array(b.bands), curve };
}
const insideAt = (segs, x, y, eo) => {
  for (const s of rowSpans(segs, y, eo)) if (x >= s[0] && x < s[1]) return 1;
  return 0;
};

/// Distance from (x, y) to the shape's own outline, as the nearest filled-span END over a ladder of
/// rows through it. Span ends ARE the outline, so this needs no curve distance solve.
function outlineDist(sh, x, y, px, reach) {
  let best = Infinity;
  for (let dy = -reach; dy <= reach; dy += px / 4) {
    for (const s of rowSpans(sh.segs, y + dy, sh.eo))
      best = Math.min(best, Math.hypot(x - s[0], dy), Math.hypot(x - s[1], dy));
  }
  return best;
}

/// Score both texts over the whole render grid, and say how far each disagreement is from the
/// outline the covering stroke is centered on.
function scan(F, N, halfW) {
  const eA = buildGlslEmu(ROOT, { defines: ['MANTLE_HARD'], glsl: GLSL });
  const eB = buildGlslEmu(ROOT, { defines: ['MANTLE_HARD'], glsl: GLSL_PRE });
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of F.shapes) {
    x0 = Math.min(x0, s.bb[0]);
    y0 = Math.min(y0, s.bb[1]);
    x1 = Math.max(x1, s.bb[2]);
    y1 = Math.max(y1, s.bb[3]);
  }
  const px = Math.max(x1 - x0, y1 - y0) / N;
  const r = {
    px,
    tot: 0,
    badPre: 0,
    badShip: 0,
    runPre: 0,
    diff: 0,
    outPre: 0,
    outShip: 0,
    worstShip: 0,
  };
  for (const sh of F.shapes) {
    if (!sh.segs) continue;
    const qs = [],
      meta = [];
    const i0 = Math.floor((sh.bb[0] - x0) / px) - 2,
      i1 = Math.ceil((sh.bb[2] - x0) / px) + 2;
    const j0 = Math.floor((sh.bb[1] - y0) / px) - 2,
      j1 = Math.ceil((sh.bb[3] - y0) / px) + 2;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const c = [x0 + (i + 0.5) * px, y0 + (j + 0.5) * px];
        qs.push({ k: K_HARD, GD: sh.GD, bb: sh.bb, eo: sh.eo, c, ePx: [px, px] });
        meta.push(c);
      }
    const ra = eA.run(F.band, F.curve, qs),
      rb = eB.run(F.band, F.curve, qs);
    const w = i1 - i0 + 1;
    let run = 0;
    for (let i = 0; i < meta.length; i++) {
      r.tot++;
      const ex = insideAt(sh.segs, meta[i][0], meta[i][1], sh.eo);
      const bs = Math.abs(ra[i] - ex) > 0.5,
        bp = Math.abs(rb[i] - ex) > 0.5;
      if (bp) {
        r.badPre++;
        run = i % w === 0 ? 1 : run + 1;
        if (run > r.runPre) r.runPre = run;
      } else run = 0;
      if (bs) {
        r.badShip++;
        const d = outlineDist(sh, meta[i][0], meta[i][1], px, halfW * 2);
        if (d > r.worstShip) r.worstShip = d;
        if (d > halfW) r.outShip++;
      }
      if (Math.abs(ra[i] - rb[i]) > 0.5) {
        r.diff++;
        if (outlineDist(sh, meta[i][0], meta[i][1], px, halfW * 2) > halfW) r.outPre++;
      }
    }
  }
  return r;
}

// ---- (a) FAR reaches the branch; its stroke covers every pixel the branch gets wrong ---------------------------------
{
  const F = await load('examples/smoke/noAaArcRow__FAR.svg');
  const r = scan(F, 512, 1.5); // stroke-width 3 em
  ok(
    r.diff >= 20,
    `(a) noAaArcRow__FAR DOES reach hardCrossArc's changed branch: the two texts disagree at ${r.diff} of ${r.tot} pixel centers at 512 (window rule ${r.badPre} wrong, longest run ${r.runPre}; shipped ${r.badShip})`,
  );
  ok(
    r.outPre === 0,
    `(a) ...and ${r.diff - r.outPre} of ${r.diff} lie INSIDE the 1.5 em stroke half-width, so an opaque stroke paints every one of them — which is why a GPU reads 0 wrong solid with the window and without it (${r.outPre} outside)`,
  );
}

// ---- (b) the same defect, with the flipped run in open canvas --------------------------------------------------------
{
  const F = await load('examples/smoke/noAaArcRow__GAP.svg');
  const r = scan(F, 512, 1.5);
  ok(
    r.badPre > 1000 && r.runPre > 100,
    `(b) noAaArcRow__GAP under the window rule: ${r.badPre} wrong pixel centers of ${r.tot} at 512, longest run ${r.runPre} px (FAR's longest is 5)`,
  );
  ok(
    r.outPre > 1000,
    `(b) ...and ${r.outPre} of the ${r.diff} disagreements are FARTHER from the outline than the 1.5 em stroke half-width, so no covering stroke can hide them`,
  );
  ok(
    r.outShip === 0,
    `(b) shipped: ${r.badShip} wrong, ${r.outShip} of them outside the stroke half-width; the residue is lone centers on the outline (worst ${r.worstShip.toFixed(3)} em = ${(r.worstShip / r.px).toFixed(2)} px from it)`,
  );
}

// ---- (c) the route gets there with nothing pinned ---------------------------------------------------------------------
{
  const { b } = await load('examples/smoke/noAaArcRow__GAP.svg');
  const NOAA_BANDHARD_MAX_SEGS = 64; // fillPass.js / bundleFinalize.js
  // `meanSegsPerShape` is derived in parseBundle, not carried by the import; form it the same way.
  const meanSegs = b.numShapes ? (b.totalSegments | 0) / b.numShapes : 0;
  const scalePx = 512 / Math.max(b.globalBBox[2], b.globalBBox[3]);
  ok(
    b.noAaFill === true,
    '(c) the bundle is whole-bundle no-AA eligible (every fill under an opaque covering stroke)',
  );
  ok(
    ((b.segTypeMask || 0) & (1 << 3)) !== 0,
    `(c) ...and its segment mask carries ARC (${b.segTypeMask}), so the fill walks hardCrossArc`,
  );
  ok(
    meanSegs > 0 && meanSegs <= NOAA_BANDHARD_MAX_SEGS,
    `(c) ...under band-hard's segment ceiling (${meanSegs} <= ${NOAA_BANDHARD_MAX_SEGS}), so preferNoAa does not hand it back to AA`,
  );
  ok(
    (b.minStrokeEmW || 0) * scalePx >= 2,
    `(c) ...and the covering stroke is ${((b.minStrokeEmW || 0) * scalePx).toFixed(2)} device px at 512, over preferNoAa's 2 px floor`,
  );
}

// ---- (d) the importer's default stores FAR and GAP near the origin, and then the window cannot reach a pixel -----------------
for (const f of ['FAR', 'GAP']) {
  const F = await load(`examples/smoke/noAaArcRow__${f}.svg`, {});
  const r = scan(F, 512, 1.5);
  ok(
    Array.isArray(F.b.origin) && F.b.origin.length === 2,
    `(d) noAaArcRow__${f} imported by default carries a bundle origin (${JSON.stringify(F.b.origin)}), so its coordinates are stored near zero`,
  );
  ok(
    r.diff === 0 && r.badPre === 0 && r.badShip === 0,
    `(d) ...and at 512 the two shader texts agree at all ${r.tot} pixel centers, each exact (disagree ${r.diff}, window rule wrong ${r.badPre}, shipped wrong ${r.badShip}): the condition (a) and (b) need is gone from the default import`,
  );
}

console.log(fail ? `noAaArcRenderReachSmoke FAIL (${fail})` : 'noAaArcRenderReachSmoke PASS');
process.exit(fail ? 1 : 0);
