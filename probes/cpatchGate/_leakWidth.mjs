// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _leakWidth — the leak's WIDTH, beside its depth.
//
// THE PROPERTY. `leakOfInner` reports how far past its own arcs a patch's half-space conjunction
// reaches (`depth`) and, now, how much of the conjunction stands behind it there (`width`). The two
// are independent: the morph blob carries leaks 8 to 15 DEEP that are 0.004 to 0.025 WIDE, and a
// caller reading only the depth cannot tell a wedge of wrong ink from a hairline that rounds away.
// Before this, the width was not a number at all -- it was a yes/no the caller got back by handing
// in a probe step (`nudgePx`) that defaulted to the caller's own tolerance, so the only thing
// anyone could learn was a verdict about a width they had already chosen.
//
// What this measures:
//   (a) the (depth, width) distribution over the corpus, so the two can be seen not to track;
//   (b) the width is SCALE-EQUIVARIANT -- scale the artwork, the width scales with it;
//   (c) how much the MEASURED-width predicate (`measuredWidth: true`) would move decompositions
//       against the default single probe, which is the number that decides whether the search can
//       adopt it.
//
//   node probes/cpatchGate/_leakWidth.mjs [file.svg]     SHAPES=40 ROWS=20
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const x = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || x.DOMParser;
globalThis.XMLSerializer = globalThis.XMLSerializer || x.XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { headlessCPatchBundle, contoursToConverter, shapeEvenOdd, cpatchCurvePlane } =
  await import('../../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../../src/geom/lbContour.js');
const { circleFromContours, ellipseFromContours } =
  await import('../../src/geom/shapeRecognize.js');
const { packCPatchShape } = await import('../../src/renderer/cpatchPack.js');
const { leakOfInner } = await import('../../src/renderer/cpatchConvert.js');
const { SEG_LINE, SEG_QUAD, SEG_CUBIC, mkLine, mkQuad, mkCubic, mkRQuad } =
  await import('../../src/primitives/seg.js');

const file = process.argv[2] || '../MantleSamples/Assets/Mantle/tiger.svg';
const MAXS = +(process.env.SHAPES || 60);
const TOL = +(process.env.TOL || 0.05);
const _w = console.warn;
console.warn = () => {};
const bundle = headlessCPatchBundle(
  await importSvg(readFileSync(path.resolve(ROOT, file), 'utf8')),
);
const cf = cpatchCurvePlane(bundle);
const ranges = bundle.curveRangesByShape || [];
const cycleCache = new Map();

const scaleContours = (cs, S) =>
  cs.map((c) =>
    c.map((sg) => {
      const P = (q) => q && [q[0] * S, q[1] * S];
      if (sg.type === SEG_LINE) return mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
      if (sg.type === SEG_QUAD) return mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
      if (sg.type === SEG_CUBIC) return mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
      const c0 = sg.circle;
      return mkRQuad(
        P(sg.p1),
        P(sg.p2),
        P(sg.p3),
        sg.w,
        c0 ? { cx: c0.cx * S, cy: c0.cy * S, r: c0.r * S } : null,
      );
    }),
  );

function patchesOf(contours, s) {
  const cs = contoursToConverter(contours, null);
  if (!cs) return [];
  const patches = [];
  try {
    packCPatchShape(cs, 0, {
      evenOdd: shapeEvenOdd(bundle, s),
      cycleCache: new Map(),
      search: 'full',
      onPatches: (a) => patches.push(...a),
    });
  } catch {
    return [];
  }
  return patches;
}

let nShape = 0,
  nPatch = 0,
  nLeak = 0,
  nFlip = 0,
  nSearchLeak = 0;
const leaks = [],
  flips = [];
for (let s = 0; s < ranges.length && nShape < MAXS; s++) {
  const r = ranges[s];
  if (!r) continue;
  let contours = null;
  try {
    contours = curveRangeToContours(cf, r.begin, r.end);
  } catch {
    continue;
  }
  if (!contours || !contours.length) continue;
  if (circleFromContours(contours) || ellipseFromContours(contours)) continue;
  const patches = patchesOf(contours, s);
  if (!patches.length) continue;
  nShape++;
  for (let pi = 0; pi < patches.length; pi++) {
    const p = patches[pi];
    nPatch++;
    const ext = Math.max(p.bbox[2] - p.bbox[0], p.bbox[3] - p.bbox[1]);
    // (c) THE SEARCH'S ASK -- the emptiness escape is live here, which is the only place the width
    // policy is consulted -- but asked against the patch's BOX, because against its COVER HULL a
    // FINISHED patch is valid by construction and both arms return null. Comparing null with null
    // is the vacuous A/B this repo has been caught by before.
    let a = null,
      b = null;
    try {
      a = leakOfInner(p, TOL, 0, { box: true });
    } catch {
      a = null;
    } // default: single probe
    try {
      b = leakOfInner(p, TOL, 0, { box: true, measuredWidth: true });
    } catch {
      b = null;
    } // measured width
    if (a || b) nSearchLeak++;
    if (!!a !== !!b) {
      nFlip++;
      flips.push(
        `#${s} patch ${pi} (ext ${ext.toFixed(4)}): probe ${a ? `leak d=${a.depth.toFixed(4)} w=${a.width.toExponential(3)}` : 'none'} -> measured ${b ? `leak d=${b.depth.toFixed(4)} w=${b.width.toExponential(3)}` : 'none'}`,
      );
    } else if (a && b && (a.t !== b.t || a.depth !== b.depth)) {
      nFlip++;
      flips.push(
        `#${s} patch ${pi}: probe reports t=${a.t.toFixed(5)} d=${a.depth.toFixed(5)} -> measured t=${b.t.toFixed(5)} d=${b.depth.toFixed(5)}`,
      );
    }
    // THE DISTRIBUTION IS TAKEN AT THE GATE'S QUESTION, not the search's. A patch the search has
    // finished with is valid against its COVER HULL by construction, so the search's own leak call
    // returns nothing on a packed patch and there is no distribution to look at. The row gate asks
    // the same machinery about the patch's BOX, which is looser than the hull and is where the
    // renderer's fence actually sits -- that is where the leaks the width has to describe live.
    let g = null;
    try {
      g = leakOfInner(p, TOL, 0, {
        nudgePx: ext > 0 ? (0.02 / 256) * ext : TOL,
        monotone: true,
        anyStretch: true,
        box: true,
      });
    } catch {
      g = null;
    }
    if (g) {
      nLeak++;
      leaks.push({ s, pi, ext, depth: g.depth, width: g.width });
    }
  }
}
console.warn = _w;

// ---- (a) the distribution ------------------------------------------------------------------------
console.log(
  `${file}: ${nShape} shapes, ${nPatch} patches, ${nLeak} leaking at the GATE's question (patch box) at tol ${TOL}`,
);
if (leaks.length) {
  const ws = leaks.map((l) => l.width).sort((p, q) => p - q);
  const ds = leaks.map((l) => l.depth).sort((p, q) => p - q);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.floor(f * arr.length))];
  console.log(
    `  depth  min ${ds[0].toExponential(3)}  median ${q(ds, 0.5).toExponential(3)}  max ${ds[ds.length - 1].toExponential(3)}`,
  );
  console.log(
    `  width  min ${ws[0].toExponential(3)}  median ${q(ws, 0.5).toExponential(3)}  max ${ws[ws.length - 1].toExponential(3)}`,
  );
  // Do they track? Spearman-free: count leaks that are DEEP and NARROW, which is the pair the policy hides.
  const deep = q(ds, 0.5);
  const dn = leaks.filter((l) => l.depth > deep && l.width < TOL).length;
  console.log(
    `  DEPTH AND WIDTH DO NOT TRACK: of the ${leaks.filter((l) => l.depth > deep).length} leaks deeper than the median (${deep.toFixed(3)}), ${dn} are NARROWER than the search's own bar ${TOL} -- deep hairlines a depth-only reading cannot tell from a wedge`,
  );
  console.log(
    `  leaks narrower than ${TOL} in all: ${leaks.filter((l) => l.width < TOL).length} of ${leaks.length}; exactly zero width (no area at all just inside the curve): ${leaks.filter((l) => l.width === 0).length}`,
  );
  console.log(
    `  leaks WIDER than ${TOL}: ${leaks.filter((l) => l.width >= TOL).length}, widest ${ws[ws.length - 1].toFixed(3)} on a patch whose extent is ${(leaks.find((l) => l.width === ws[ws.length - 1]) || {}).ext}`,
  );
  for (const l of leaks.slice(0, +(process.env.ROWS || 8)))
    console.log(
      `    #${l.s} p${l.pi}: depth ${l.depth.toExponential(3)}  width ${l.width.toExponential(3)}  (patch extent ${l.ext.toExponential(3)})`,
    );
}

// ---- (b) the width scales with the artwork --------------------------------------------------------
{
  let checked = 0,
    bad = 0,
    worst = 0,
    worstRow = '';
  for (let s = 0; s < ranges.length && checked < 12; s++) {
    const r = ranges[s];
    if (!r) continue;
    let contours = null;
    try {
      contours = curveRangeToContours(cf, r.begin, r.end);
    } catch {
      continue;
    }
    if (!contours || !contours.length) continue;
    if (circleFromContours(contours) || ellipseFromContours(contours)) continue;
    const base = patchesOf(contours, s);
    if (!base.length) continue;
    for (const S of [Math.pow(2, -8), Math.pow(2, 8)]) {
      const sc = patchesOf(scaleContours(contours, S), s);
      if (sc.length !== base.length) continue;
      for (let pi = 0; pi < base.length; pi++) {
        let a = null,
          c = null;
        const eA = Math.max(
          base[pi].bbox[2] - base[pi].bbox[0],
          base[pi].bbox[3] - base[pi].bbox[1],
        );
        const eC = Math.max(sc[pi].bbox[2] - sc[pi].bbox[0], sc[pi].bbox[3] - sc[pi].bbox[1]);
        try {
          a = leakOfInner(base[pi], TOL, 0, {
            nudgePx: (0.02 / 256) * eA,
            monotone: true,
            anyStretch: true,
            box: true,
          });
        } catch {
          a = null;
        }
        try {
          c = leakOfInner(sc[pi], TOL * S, 0, {
            nudgePx: (0.02 / 256) * eC,
            monotone: true,
            anyStretch: true,
            box: true,
          });
        } catch {
          c = null;
        }
        if (!a || !c || !(a.width > 0)) continue;
        checked++;
        const rel = Math.abs(c.width / S - a.width) / a.width;
        if (rel > worst) {
          worst = rel;
          worstRow = `#${s} p${pi} at 2^${Math.round(Math.log2(S))}: ${a.width.toExponential(6)} vs ${(c.width / S).toExponential(6)}`;
        }
        if (rel > 1e-6) bad++;
      }
    }
  }
  console.log(
    `\n  (b) width scales with the artwork: ${checked} leaks compared at 2^-8 and 2^8, ${bad} off by more than 1e-6 relative; worst ${worst.toExponential(3)} ${worstRow}`,
  );
}

// ---- (c) what the measured predicate would cost ----------------------------------------------------
console.log(
  `\n  (c) measured-width predicate vs the default single probe, at the search's ask: ${nSearchLeak} of ${nPatch} patches leak at all (so the comparison is not vacuous), ${nFlip} change`,
);
for (const f of flips.slice(0, +(process.env.ROWS || 12))) console.log(`    ${f}`);
