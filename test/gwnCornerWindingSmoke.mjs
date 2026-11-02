// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// gwnCornerWindingSmoke — the GWN+SDF two-edge combine cannot contradict the winding it just
// computed.
//
// THE DEFECT. At a pixel the outline runs near, the GWN AA kernel keeps the two nearest candidate
// segments and combines their coverage half-planes: intersection at a convex corner, union at a
// reflex one, classified from the polyline's turn against the contour handedness. Where the two
// candidates' normals come out very nearly OPPOSITE the wedge between them has no width, `turn` is
// the sign of a number that is zero, and a coin-flip "reflex" unions two anti-parallel half-planes
// into a FULL pixel of ink where the outline is nowhere near.
//
// THE RULE IS A CONSISTENCY CONDITION, not a threshold. The intersection contains the pixel center
// iff both half-planes do; the union iff EITHER does. So where exactly one contains it, the two
// combines give opposite answers about the center — and the exact crossing count has already
// settled that question, for free, in the same traversal. `reflex` is a model of the vertex;
// `inside` is not.
//
// THE REFERENCE IS THE PATH. rowSpans gives a scanline's filled spans exactly, so a pixel center's
// membership is exact and so is a pixel's box coverage (exact in x, sliced in y). A pixel whose
// membership matches all eight neighbours' is one the outline does not run through, so a
// disagreement there is ink in the wrong place; the rest are scored as AA. The kernel side is the
// SHIPPED shader text in float32 on the CPU (test/_glslEmu.mjs), not a port.
//
//   (a) on the tiger shapes that carry it, wrong solid pixels (~125 without the protection -> at most 1), and
//       pixels whose AA error exceeds 0.5 coverage (~143 -> at most 10);
//   (b) the mean AA error does not rise: the rule fires only where the two combines disagree;
//   (c) on stars, a comb, a ring, petals, a cusp and a loop, the protection is not a trade of one asset against
//       another: no fixture's summed edge error rises (the rule alone moved no pixel there);
//   (d) removing the protection reproduces the defect, so the smoke is load-bearing.
//
// THE PROTECTION IS TWO THINGS. The kernel's ink sides are the encoder's per PIECE, and a pixel
// where the model does not hold -- its answer about the center not the winding's, a corner whose two pieces carry
// different ink sides, a lone plane at a vertex -- takes the exact-area pass (`holds`). The consistency rule still moves 4
// pixels by itself; the routing, the rest. So the mutation removes both, and the defect it reproduces is ~125 wrong solid
// pixels on these shapes.
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { hasCxx, buildGlslEmu, fillShapes, K_GWN } from './_glslEmu.mjs';
import { requireAsset, PKG_ROOT } from './_assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!hasCxx()) {
  console.log('SKIP gwnCornerWindingSmoke: no C++ compiler ($CXX, clang++, g++, c++)');
  process.exit(0);
}
const TIGER = requireAsset(path.join(PKG_ROOT, 'examples/tiger.svg'));
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
const { decodeSegs } = await import('../src/hitTest/curveGeom.js');
const { cellCoverage } = await import('../probes/fillperf/cellCoverage.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const GLSL = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const RULE = '  if (anyIn != bothIn) reflex = inside > 0.5;';
const ROUTING = '  if (!subPx && holds) return cov;';
const WITHOUT = GLSL.replace(RULE, '  // (rule removed by the smoke)').replace(
  ROUTING,
  '  if (!subPx) return cov;   // (routing removed by the smoke)',
);
const SLICES = 8;

const emuOn = buildGlslEmu(ROOT, { defines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'] });
const emuOff = buildGlslEmu(ROOT, { defines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'], glsl: WITHOUT });
ok(
  GLSL.includes(RULE) && GLSL.includes(ROUTING),
  'the center-consistency rule and the exact-pass routing are in the shipped shader text',
);

async function load(svg) {
  const b = await importSvg(svg, { preserveViewport: true, gwnTree: true });
  const shapes = fillShapes(b, parseMetaBin, M);
  const curve = new Float32Array(b.curves);
  for (const sh of shapes) {
    const cs = contoursToConverter(curveRangeToContours(curve, sh.range.begin, sh.range.end), null);
    sh.segs = cs ? cs.flat() : null;
  }
  return { shapes, band: new Float32Array(b.bands), curve };
}
function rowInside(segs, y, eo, xs) {
  const spans = rowSpans(segs, y, eo),
    out = new Uint8Array(xs.length);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    for (const s of spans)
      if (x >= s[0] && x < s[1]) {
        out[i] = 1;
        break;
      }
  }
  return out;
}
function rowBoxCov(segs, y0, eo, xs, px, slices) {
  const acc = new Float64Array(xs.length);
  for (let s = 0; s < slices; s++) {
    const spans = rowSpans(segs, y0 + (px * (s + 0.5)) / slices, eo);
    for (let i = 0; i < xs.length; i++) {
      const lo0 = xs[i] - px / 2,
        hi0 = xs[i] + px / 2;
      let a = 0;
      for (const sp of spans) {
        const lo = Math.max(sp[0], lo0),
          hi = Math.min(sp[1], hi0);
        if (hi > lo) a += hi - lo;
      }
      acc[i] += a;
    }
  }
  for (let i = 0; i < xs.length; i++) acc[i] /= px * slices;
  return acc;
}
/// Score every arm on ONE cached exact reference, so the y quadrature cancels in the delta.
function score(loaded, N, only) {
  const { shapes, band, curve } = loaded;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const s of shapes) {
    x0 = Math.min(x0, s.bb[0]);
    y0 = Math.min(y0, s.bb[1]);
    x1 = Math.max(x1, s.bb[2]);
    y1 = Math.max(y1, s.bb[3]);
  }
  const px = Math.max(x1 - x0, y1 - y0) / N;
  const out = {
    on: { solid: 0, abs: 0, n: 0, big: 0 },
    off: { solid: 0, abs: 0, n: 0, big: 0 },
    differ: 0,
  };
  for (const sh of shapes) {
    if (!sh.segs || !sh.segs.length) continue;
    if (only && !only.has(sh.s)) continue;
    const i0 = Math.floor((sh.bb[0] - x0) / px) - 2,
      i1 = Math.ceil((sh.bb[2] - x0) / px) + 2;
    const j0 = Math.floor((sh.bb[1] - y0) / px) - 2,
      j1 = Math.ceil((sh.bb[3] - y0) / px) + 2;
    const W = i1 - i0 + 1,
      H = j1 - j0 + 1;
    if (W * H > 4e6) continue;
    const xs = new Float64Array(W);
    for (let i = 0; i < W; i++) xs[i] = x0 + (i0 + i + 0.5) * px;
    const inside = new Uint8Array(W * H);
    for (let j = 0; j < H; j++)
      inside.set(rowInside(sh.segs, y0 + (j0 + j + 0.5) * px, sh.eo, xs), j * W);
    const edge = new Uint8Array(W * H),
      solid = new Uint8Array(W * H),
      ref = new Float64Array(W * H);
    for (let j = 1; j < H - 1; j++)
      for (let i = 1; i < W - 1; i++) {
        const k = j * W + i,
          v = inside[k];
        let same = true;
        for (let dj = -1; dj <= 1 && same; dj++)
          for (let di = -1; di <= 1; di++)
            if (inside[(j + dj) * W + i + di] !== v) {
              same = false;
              break;
            }
        if (same) solid[k] = 1;
        else edge[k] = 1;
      }
    for (let j = 0; j < H; j++) {
      let any = false;
      for (let i = 0; i < W; i++)
        if (edge[j * W + i]) {
          any = true;
          break;
        }
      if (any) ref.set(rowBoxCov(sh.segs, y0 + (j0 + j) * px, sh.eo, xs, px, SLICES), j * W);
    }
    const qs = [];
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++)
        qs.push({
          k: K_GWN,
          GD: sh.GD,
          bb: sh.bb,
          eo: sh.eo,
          c: [xs[i], y0 + (j0 + j + 0.5) * px],
          ePx: [px, px],
        });
    const rOn = emuOn.run(band, curve, qs),
      rOff = emuOff.run(band, curve, qs);
    let dsegs = null;
    for (let m = 0; m < rOn.length; m++) {
      // where the arms differ, both are scored against the exact box coverage (the sliced reference's y quadrature is
      // off at a corner by more than the exact pass moves a straight-edged pixel)
      let rf = ref[m];
      if (rOn[m] !== rOff[m]) {
        out.differ++;
        if (edge[m]) {
          dsegs = dsegs || decodeSegs(curve, sh.range.begin, sh.range.end);
          rf = cellCoverage(dsegs, qs[m].c, [px, px], sh.eo);
        }
      }
      for (const [tag, r] of [
        ['on', rOn],
        ['off', rOff],
      ]) {
        const t = out[tag];
        if (solid[m]) {
          if (Math.abs(r[m] - inside[m]) > 0.5) t.solid++;
        } else if (edge[m]) {
          const d = Math.abs(r[m] - rf);
          t.abs += d;
          t.n++;
          if (d > 0.5) t.big++;
        }
      }
    }
  }
  return out;
}

// ---- (a), (b), (d) ---------------------------------------------------------------------------------------------------
{
  // The tiger shapes that carried the defect, and nothing else: the whole asset at 512 is 1.5M
  // pixel centers and the answer is the same.
  const ONLY = new Set([
    12, 90, 93, 96, 97, 104, 105, 113, 120, 152, 153, 154, 159, 171, 173, 176, 187, 192, 215, 223,
  ]);
  const svg = readFileSync(TIGER, 'utf8')
    .replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
    .replace(/stroke-width\s*=\s*"[^"]*"/g, '')
    .replace(/(^|[;{\s"'])stroke\s*:\s*[^;}"']+/g, '$1stroke:none');
  const r = score(await load(svg), 512, ONLY);
  ok(
    r.off.solid >= 20,
    `(d) with the protection removed, ${r.off.solid} wrong solid pixels on ${ONLY.size} tiger shapes at 512 (the defect)`,
  );
  ok(r.on.solid <= 1, `(a) with it, ${r.on.solid} wrong solid`);
  ok(
    r.on.big <= 10 && r.on.big < r.off.big,
    `(a) pixels whose AA error exceeds 0.5 coverage: ${r.off.big} -> ${r.on.big}`,
  );
  ok(
    r.on.abs <= r.off.abs,
    `(b) mean AA error over ${r.on.n} edge pixels: ${(r.off.abs / r.off.n).toFixed(5)} -> ${(r.on.abs / r.on.n).toFixed(5)}`,
  );
}

// ---- (c) -------------------------------------------------------------------------------------------------------------
{
  const star = (n, R, r, cx, cy) => {
    let d = '';
    for (let i = 0; i < 2 * n; i++) {
      const a = (Math.PI * i) / n,
        rad = i % 2 ? r : R;
      d +=
        (i ? 'L ' : 'M ') +
        (cx + rad * Math.cos(a)).toFixed(4) +
        ' ' +
        (cy + rad * Math.sin(a)).toFixed(4) +
        ' ';
    }
    return d + 'Z';
  };
  let cmb = 'M 110 260 ';
  for (let i = 0; i < 9; i++)
    cmb += `L ${110 + i * 20} 140 L ${120 + i * 20} 140 L ${120 + i * 20} 220 L ${130 + i * 20} 220 `;
  cmb += 'L 290 260 Z';
  const wrap = (d, eo) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path ${eo ? 'fill-rule="evenodd" ' : ''}d="${d}" fill="#000"/></svg>`;
  const FIX = {
    star8: wrap(star(8, 160, 60, 200, 200)),
    star16: wrap(star(16, 170, 40, 200, 200)),
    comb: wrap(cmb),
    ring: wrap(
      'M 200 200 m -150 0 a 150 150 0 1 0 300 0 a 150 150 0 1 0 -300 0 Z M 200 200 m -80 0 a 80 80 0 1 0 160 0 a 80 80 0 1 0 -160 0 Z',
      true,
    ),
    petals: wrap(
      (() => {
        const K = 10,
          c = 200,
          r = 150,
          P = (j) => [
            c + r * Math.cos((2 * Math.PI * j) / K),
            c + r * Math.sin((2 * Math.PI * j) / K),
          ];
        let d = `M ${P(0)[0].toFixed(3)} ${P(0)[1].toFixed(3)} `;
        for (let j = 1; j <= K; j++) {
          const m = [
            c + r * 1.7 * Math.cos((2 * Math.PI * (j - 0.5)) / K),
            c + r * 1.7 * Math.sin((2 * Math.PI * (j - 0.5)) / K),
          ];
          d += `Q ${m[0].toFixed(3)} ${m[1].toFixed(3)} ${P(j % K)[0].toFixed(3)} ${P(j % K)[1].toFixed(3)} `;
        }
        return d + 'Z';
      })(),
    ),
    cusp: wrap('M 120 280 C 340 60, 120 60, 200 300 Z'),
    loop: wrap('M 120 260 C 380 80, 20 80, 280 260 Z'),
  };
  const worse = [];
  let solidOn = 0,
    moved = 0,
    onAbs = 0,
    offAbs = 0;
  for (const [name, svg] of Object.entries(FIX)) {
    const loaded = await load(svg);
    for (const N of [256, 512]) {
      const r = score(loaded, N, null);
      solidOn += r.on.solid;
      moved += r.differ;
      onAbs += r.on.abs;
      offAbs += r.off.abs;
      // (a straight-edged pixel is exact both ways, to float32 rounding: 1e-5 of coverage a moved pixel is that, not a trade)
      if (r.on.abs > r.off.abs + 1e-5 * r.differ)
        worse.push(`${name}@${N}: ${r.off.abs.toFixed(6)} -> ${r.on.abs.toFixed(6)}`);
    }
  }
  // (The rule alone moves NO pixel here. The routing moves the corner and vertex pixels into the exact pass,
  // so the bar is that every fixture's summed edge error goes down, not that nothing moves.)
  ok(
    worse.length === 0,
    `(c) on ${Object.keys(FIX).length} corner and curve fixtures at 256 and 512 the protection moves ${moved} pixels and no fixture's summed edge error rises (${offAbs.toFixed(2)} -> ${onAbs.toFixed(2)})` +
      (worse.length ? `: ${worse.join(', ')}` : ''),
  );
  ok(solidOn === 0, `(c) and none of them has a wrong solid pixel (${solidOn})`);
}

console.log(fail ? `gwnCornerWindingSmoke FAIL (${fail})` : 'gwnCornerWindingSmoke PASS');
process.exit(fail ? 1 : 0);
