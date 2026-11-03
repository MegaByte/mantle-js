// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// layerStrokeArcsJoinSmoke — a stroke row inside a mask, a clip path or a pattern carries the arcs join's curvature
// texel, as a page shape's does.
//
// WHY. bundleFinalize emits a LAYER's stroke rows (mask, clip and pattern children) on a path of its own, and that path
// must ask the encoder for the curvature texel stroke-linejoin="arcs" needs. The walk and the hit test read it -- the
// shader at the join texel + 1, the hit test's decoder striding over it -- so without it an arcs-joined layer stroke
// takes the NEXT segment's header as its curvatures, and the hit test decodes its curve plane out of step.
//
// The same curved, arcs-joined path is drawn as a page shape and as a mask child, at the same coordinates:
// (a) the layer row's curve plane decodes (hitTest/curveGeom.js decodeSegs) to the same segments, curvatures included,
//     as the page row's;
// (b) the shipped walk in float32 (test/_glslEmu.mjs) gives the layer row the page row's distance at every pixel
//     around the path.
import path from 'path';
import { fileURLToPath } from 'url';
import * as EMU from './_glslEmu.mjs';
import { curveView, curveRangesOf, decodeSegs } from '../src/hitTest/curveGeom.js';

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

const D = 'M20 60 Q40 10 60 50 T100 50 C110 70 90 90 70 80 A20 12 0 0 1 30 80';
const STROKE = `fill="none" stroke-width="8" stroke-linejoin="arcs" stroke-miterlimit="3"`;
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="140" height="120" viewBox="0 0 140 120">` +
  `<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="140" height="120"><path d="${D}" stroke="#fff" ${STROKE}/></mask></defs>` +
  `<path d="${D}" stroke="#000" ${STROKE}/>` +
  `<rect x="0" y="0" width="140" height="120" fill="#08f" mask="url(#m)"/></svg>`;
const b = await importSvg(svg, { preserveViewport: true });
const meta = new Float32Array(b.meta, 32),
  cv = curveView(b),
  ranges = curveRangesOf(b, meta, b.numShapes, 48, cv.length);
let page = -1,
  layer = -1;
for (let i = 0; i < b.numShapes; i++) {
  const o = i * 48;
  if (!(meta[o + 12] > 0)) continue;
  if ((Math.round(meta[o + 27]) & 0x100) !== 0) layer = i;
  else page = i;
}
ok(
  page >= 0 && layer >= 0 && (meta[page * 48 + 25] | 0) === 4 && (meta[layer * 48 + 25] | 0) === 4,
  `a page stroke row (${page}) and a mask-child stroke row (${layer}), both arcs-joined`,
);

// ---- (a) the curve planes decode alike --------------------------------------------------------------------------------------
{
  const dec = (i) => decodeSegs(cv, ranges[i].begin, ranges[i].end, 4).filter((s) => !s.f);
  const A = dec(page),
    B = dec(layer);
  const key = (s) =>
    [s.t, s.x0, s.y0, s.x1, s.y1, s.kSS, s.kSE, s.kPE, s.kNS]
      .map((v) => (typeof v === 'number' ? v.toFixed(4) : v))
      .join(',');
  const same = A.length === B.length && A.every((s, k) => key(s) === key(B[k]));
  ok(
    same,
    `(a) the mask child's stroke decodes to the page stroke's ${A.length} segments and curvatures (it decoded ${B.length}${B.length ? ', first ' + key(B[0]) : ''})`,
  );
}

// ---- (b) the walk --------------------------------------------------------------------------------------------------------------
if (!EMU.hasCxx()) console.log('  SKIPPED (b): no C++ compiler');
else {
  const emu = EMU.buildGlslEmu(ROOT, { stroke: true });
  const q = (i) => {
    const o = i * 48,
      m = (k) => meta[o + k];
    return {
      GD: [m(16) | 0, m(17) | 0, m(18) | 0, m(19) | 0],
      bb: [m(0), m(1), m(2), m(3)],
      hw: m(12) * 0.5,
      cap: m(24) | 0,
      join: m(25) | 0,
      miter: m(26),
    };
  };
  const P = q(page),
    L = q(layer),
    qs = [];
  for (let y = 0; y < 120; y += 1)
    for (let x = 0; x < 140; x += 1)
      for (const r of [P, L])
        qs.push({
          k: EMU.K_STROKE_WALK,
          GD: r.GD,
          bb: r.bb,
          c: [x + 0.5, y + 0.5],
          ePx: [1, 1],
          ex: [r.hw, r.miter, r.cap, r.cap, r.join, 0, 0, 0, -1e20],
        });
  const out = emu.run(new Float32Array(b.bands), cv, qs);
  let bad = 0,
    n = 0,
    first = '';
  for (let k = 0; k < out.length; k += 2) {
    const a = Math.min(out[k], 50),
      c = Math.min(out[k + 1], 50);
    if (a > 8 && c > 8) continue; // far from both: nothing to compare
    n++;
    if (Math.abs(a - c) > 1e-4) {
      bad++;
      if (!first)
        first = `pixel ${(k / 2) % 140},${Math.floor(k / 2 / 140)}: ${c.toFixed(3)} for ${a.toFixed(3)}`;
    }
  }
  ok(
    bad === 0,
    `(b) the walk gives the mask child the page stroke's distance at ${n - bad} of ${n} pixels near the path${first ? ' -- first off ' + first : ''}`,
  );
}
console.log(fail ? `LAYER-STROKE-ARCS-JOIN FAIL (${fail})` : 'LAYER-STROKE-ARCS-JOIN PASS');
process.exit(fail ? 1 : 0);
