// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _morphPairs — THE MORPH CORPUS the scale instrument runs on: pairs of poses, per shape.
//
// A morph is not a shape, it is a PAIR of them, so the stage probe's corpus (one shape per entry)
// does not describe one. Two poses of the same shape are matched positionally -- the renderer's own
// rule, and the one `toCurvesPair` and `buildLoopBlinnPartitionPair` both enforce -- so a pair is
// only usable when the two poses import to the same shape count and each shape to the same contour
// and segment structure. Everything that does not is dropped here rather than silently mis-paired.
//
// THREE SOURCES, because the defect classes they reach are different:
//   assets     the smoke corpus's SRC/DST (and POSE_A/POSE_B, pose_N, svg_A/svg_B, ring_/mk_) files
//   synthetic  the shapes the morph smokes and probes build in code: a growing/rotating blob in
//              quad, rational-quad and cubic form, a ring, a convex<->concave flip, a wobble
//   mixed      A PAIR WHOSE TWO POSES DIFFER IN SIZE. This is the case a flat tolerance gets wrong
//              in a way no uniform scaling can show: scale ONE pose and the bar that was right for
//              it is wrong for the other, and every shared decision (one split plan, one layout,
//              one certificate) is taken in whichever pose's units the constant happens to suit.
import { readFileSync, readdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  SEG_LINE,
  SEG_QUAD,
  SEG_CUBIC,
  mkLine,
  mkQuad,
  mkCubic,
  mkRQuad,
} from '../../src/primitives/seg.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/// Filename rules that turn one pose's name into its partner's. First match with a file wins.
const PAIR_RULES = [
  [/__SRC\.svg$/, '__DST.svg'],
  [/_SRC\.svg$/, '_DST.svg'],
  [/_SRCd_/, '_DSTd_'],
  [/__POSE_A\.svg$/, '__POSE_B.svg'],
  [/__svg_A_/, '__svg_A_'], // handled below (A -> B on the token after __svg_)
];

/// Every (poseA, poseB) file pair in a directory, by the rules above plus the explicit odd ones.
export function pairFiles(dir = 'examples/smoke') {
  const full = path.join(ROOT, dir);
  if (!existsSync(full)) return [];
  const files = readdirSync(full)
    .filter((f) => f.endsWith('.svg'))
    .sort();
  const has = new Set(files);
  const out = [];
  const add = (a, b) => {
    if (has.has(a) && has.has(b) && a !== b) out.push([dir + '/' + a, dir + '/' + b]);
  };
  for (const f of files) {
    for (const [re, rep] of PAIR_RULES) {
      if (!re.test(f)) continue;
      if (rep === '__svg_A_') {
        add(f, f.replace('__svg_A_', '__svg_B_'));
        break;
      }
      add(f, f.replace(re, rep));
      break;
    }
  }
  // Explicit pairs whose names carry no direction token.
  add('morphRoute__ring_70_70_35_35.svg', 'morphRoute__ring_80_50_40_25.svg');
  add('morphOccupancyGuard__mk_8.svg', 'morphOccupancyGuard__mk_40.svg');
  add('nativeMaskGeometryMorph__pose_12.svg', 'nativeMaskGeometryMorph__pose_52.svg');
  add('nativeMorphAutoApply__pose_2.svg', 'nativeMorphAutoApply__pose_20.svg');
  add('nativeTextMaskMorph__pose_2.svg', 'nativeTextMaskMorph__pose_20.svg');
  // Deduplicate (a rule and an explicit entry can both fire).
  const seen = new Set();
  return out.filter(([a, b]) => {
    const k = a + '|' + b;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const strip = (s) =>
  s.replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"').replace(/stroke-width\s*=\s*"[^"]*"/g, '');

/// Import both poses and hand back every shape whose two poses correspond positionally.
/// `decode(plane, begin, end)` is the caller's decoder so the probe can decode at a scale.
export async function assetPairs(importSvg, parseMetaBin, curveRangeToContours, opts = {}) {
  const want = opts.files || pairFiles(opts.dir);
  const out = [];
  for (const [fa, fb] of want) {
    let A, B;
    try {
      A = await importSvg(strip(readFileSync(path.join(ROOT, fa), 'utf8')), {
        preserveViewport: true,
      });
      B = await importSvg(strip(readFileSync(path.join(ROOT, fb), 'utf8')), {
        preserveViewport: true,
      });
    } catch {
      continue;
    }
    if (!A || !B || !A.curves || !B.curves || A.numShapes !== B.numShapes) continue;
    const ma = parseMetaBin(A.meta, A.metaFloatsPerShape),
      mb = parseMetaBin(B.meta, B.metaFloatsPerShape);
    if (ma.floatsPerShape !== mb.floatsPerShape) continue;
    const pa = new Float32Array(A.curves),
      pb = new Float32Array(B.curves);
    const ra = A.curveRangesByShape || [],
      rb = B.curveRangesByShape || [];
    const fps = ma.floatsPerShape;
    for (let s = 0; s < ma.numShapes; s++) {
      const qa = ra[s],
        qb = rb[s];
      if (!qa || !qb || qa.end <= qa.begin || qb.end <= qb.begin) continue;
      if (!(ma.metaFloats[s * fps + 7] > 0)) continue; // no fill: nothing to build
      let ca, cb;
      try {
        ca = curveRangeToContours(pa, qa.begin, qa.end);
        cb = curveRangeToContours(pb, qb.begin, qb.end);
      } catch {
        continue;
      }
      if (!ca || !cb || ca.length !== cb.length) continue;
      let okStruct = ca.length > 0;
      for (let c = 0; c < ca.length && okStruct; c++) {
        if (ca[c].length !== cb[c].length) {
          okStruct = false;
          break;
        }
        for (let i = 0; i < ca[c].length; i++)
          if (ca[c][i].type !== cb[c][i].type) {
            okStruct = false;
            break;
          }
      }
      if (!okStruct) continue;
      const mf = ma.metaFloats,
        bb = s * fps;
      out.push({
        name: path.basename(fa, '.svg') + '#' + s,
        kind: 'asset',
        shape: s,
        evenOdd: mf[bb + 13] > 0.5,
        transSolid:
          mf[bb + 7] < 0.996 &&
          Math.floor(mf[bb + 28] + 0.5) === 0 &&
          (fps < 36 || Math.floor(mf[bb + 35] + 0.5) === 0),
        src: ca,
        dst: cb,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- synthetic pairs
const K = 0.5522847498;
export const ellipsePath = (cx, cy, rx, ry) =>
  `M ${cx + rx} ${cy} ` +
  `C ${cx + rx} ${cy - K * ry} ${cx + K * rx} ${cy - ry} ${cx} ${cy - ry} ` +
  `C ${cx - K * rx} ${cy - ry} ${cx - rx} ${cy - K * ry} ${cx - rx} ${cy} ` +
  `C ${cx - rx} ${cy + K * ry} ${cx - K * rx} ${cy + ry} ${cx} ${cy + ry} ` +
  `C ${cx + K * rx} ${cy + ry} ${cx + rx} ${cy + K * ry} ${cx + rx} ${cy} Z`;
const svgOf = (d, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path d="${d}" fill="#3366cc" ${extra}/></svg>`;
const ring = (a, b, c, d) =>
  svgOf(`${ellipsePath(100, 100, a, b)} ${ellipsePath(100, 100, c, d)}`, 'fill-rule="evenodd"');
const WOBBLE =
  'M100 40 C140 10 170 50 165 100 C160 150 140 170 100 165 C55 160 30 140 35 100 C40 50 60 10 100 40 Z';

/// The blob the morph smokes use, as a path string: K sides, each bowed, growing and rotating with t.
export function blobPath(t, phase, kind, NK = 6, R0 = 40, dR = 22, cx = 100, cy = 100) {
  const R = R0 + dR * t;
  const at = (j) => [
    cx + R * Math.cos((2 * Math.PI * j) / NK + phase * t),
    cy + R * Math.sin((2 * Math.PI * j) / NK + phase * t),
  ];
  let d = '';
  for (let j = 0; j < NK; j++) {
    const A = at(j),
      B = at(j + 1),
      bow = 0.3 + 0.14 * t;
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * bow,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * bow;
    if (j === 0) d += `M ${A[0]} ${A[1]} `;
    if (kind === 'cubic')
      d += `C ${A[0] + (mx - A[0]) * 0.9} ${A[1] + (my - A[1]) * 0.9} ${B[0] + (mx - B[0]) * 1.1} ${B[1] + (my - B[1]) * 1.1} ${B[0]} ${B[1]} `;
    else d += `Q ${mx} ${my} ${B[0]} ${B[1]} `;
  }
  return d + 'Z';
}

/// The synthetic pairs, as (name, svgA, svgB, mixed?) — `mixed` marks a pair whose poses differ in SIZE.
export function syntheticSvgs() {
  const out = [];
  const push = (name, a, b, mixed) => out.push({ name, a, b, mixed: !!mixed });
  push(
    'disc_to_ellipse',
    svgOf(ellipsePath(100, 100, 60, 60)),
    svgOf(ellipsePath(100, 100, 80, 40)),
  );
  push('ring_to_ring', ring(70, 70, 35, 35), ring(80, 50, 40, 25));
  push(
    'flip',
    svgOf('M 40 160 L 160 160 L 160 90 C 130 50 70 50 40 90 Z'),
    svgOf('M 40 160 L 160 160 L 160 90 C 130 120 70 120 40 90 Z'),
  );
  push('wobble', svgOf(ellipsePath(100, 100, 60, 60)), svgOf(WOBBLE));
  for (const kind of ['quad', 'cubic'])
    for (const phase of [0, 2.0])
      push(
        `blob_${kind}_${phase}`,
        svgOf(blobPath(0, phase, kind)),
        svgOf(blobPath(1, phase, kind)),
      );
  // MIXED SIZE. The same outline at two sizes, and a blob that grows by 16x: one plan, one split,
  // one certificate, two very different extents. A flat world-unit bar is a different fraction of
  // each pose, and which pose it suits is an accident of where the artwork was authored.
  push(
    'mixed_disc_x16',
    svgOf(ellipsePath(100, 100, 60, 60)),
    svgOf(ellipsePath(100, 100, 3.75, 3.75)),
    true,
  );
  push(
    'mixed_blob_x16',
    svgOf(blobPath(0, 0, 'cubic')),
    svgOf(blobPath(1, 0, 'cubic', 6, 2.5, 1.375)),
    true,
  );
  push(
    'mixed_blob_quad_x16',
    svgOf(blobPath(0, 0, 'quad')),
    svgOf(blobPath(1, 0, 'quad', 6, 2.5, 1.375)),
    true,
  );
  push(
    'mixed_flip_x8',
    svgOf('M 40 160 L 160 160 L 160 90 C 130 50 70 50 40 90 Z'),
    svgOf('M 55 65 L 70 65 L 70 56.25 C 66.25 65 61.25 65 55 56.25 Z'),
    true,
  );
  return out;
}

// ---------------------------------------------------------------- real geometry, paired with itself
/// every SHAPE OF A REAL ASSET, MORPHED TO A TRANSFORM OF ITSELF.
///
/// The smoke corpus's morph assets are five-segment test paths: they are what the renderer's morph
/// smokes need and they are nowhere near enough to audit a builder, because the guards in question
/// are about cubic pieces, near-degenerate chords and control points that all but coincide. A real
/// asset has hundreds of those. Pairing a shape with an AFFINE of itself gives an exact positional
/// correspondence by construction (same contours, same segment types, same order), so the pair is
/// always well-formed and every decision the builder makes is about the geometry rather than about
/// the pairing.
///
/// Two families:
///   grow   dst = src rotated a little and scaled 1.1 about its own centroid -- an ordinary morph
///   mixed  dst = src scaled by 1/16 about its centroid -- THE POSES DIFFER IN SIZE, which is the
///          case a flat world-unit bar cannot get right for both ends at once
export async function selfPairs(importSvg, parseMetaBin, curveRangeToContours, opts = {}) {
  const file = opts.file || '../MantleSamples/Assets/Mantle/tiger.svg';
  const step = opts.step || 1;
  let sec;
  try {
    sec = await importSvg(strip(readFileSync(path.join(ROOT, file), 'utf8')), {
      preserveViewport: true,
    });
  } catch {
    return [];
  }
  if (!sec || !sec.curves) return [];
  const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape),
    fps = meta.floatsPerShape;
  const plane = new Float32Array(sec.curves),
    ranges = sec.curveRangesByShape || [];
  const tag = path.basename(file, '.svg');
  const out = [];
  for (let s = 0; s < meta.numShapes; s += step) {
    const r = ranges[s];
    if (!r || r.end <= r.begin || !(meta.metaFloats[s * fps + 7] > 0)) continue;
    let cs;
    try {
      cs = curveRangeToContours(plane, r.begin, r.end);
    } catch {
      continue;
    }
    if (!cs || !cs.length) continue;
    let cx = 0,
      cy = 0,
      m = 0;
    for (const c of cs)
      for (const sg of c)
        for (const q of [sg.p1, sg.p2, sg.p3, sg.p4])
          if (q) {
            cx += q[0];
            cy += q[1];
            m++;
          }
    if (!m) continue;
    cx /= m;
    cy /= m;
    const mf = meta.metaFloats,
      bb = s * fps;
    const base = {
      evenOdd: mf[bb + 13] > 0.5,
      transSolid:
        mf[bb + 7] < 0.996 &&
        Math.floor(mf[bb + 28] + 0.5) === 0 &&
        (fps < 36 || Math.floor(mf[bb + 35] + 0.5) === 0),
    };
    // The transform is applied to the DECODED segments, so it keeps types, order and arity exactly.
    // REBUILT through the constructors, never spread: a spread copy carries the builders' memoised
    // implicit and packed forms under symbols, and those would then describe the PRE-transform curve.
    const xf = (k, a) => {
      const ca = Math.cos(a),
        sa = Math.sin(a);
      const P = (q) =>
        q && [
          cx + ((q[0] - cx) * ca - (q[1] - cy) * sa) * k,
          cy + ((q[0] - cx) * sa + (q[1] - cy) * ca) * k,
        ];
      return cs.map((c) =>
        c.map((sg) => {
          if (sg.type === SEG_LINE) return mkLine(P(sg.p1), P(sg.p2), sg.is_fill_only);
          if (sg.type === SEG_QUAD) return mkQuad(P(sg.p1), P(sg.p2), P(sg.p3));
          if (sg.type === SEG_CUBIC) return mkCubic(P(sg.p1), P(sg.p2), P(sg.p3), P(sg.p4));
          const c0 = sg.circle;
          return mkRQuad(
            P(sg.p1),
            P(sg.p2),
            P(sg.p3),
            sg.w,
            c0 ? { cx: cx + (c0.cx - cx) * k, cy: cy + (c0.cy - cy) * k, r: c0.r * k } : null,
          );
        }),
      );
    };
    out.push({
      ...base,
      name: `${tag}#${s}/grow`,
      kind: 'self',
      shape: s,
      src: cs,
      dst: xf(1.1, 0.05),
    });
    out.push({
      ...base,
      name: `${tag}#${s}/x16`,
      kind: 'selfMixed',
      shape: s,
      src: cs,
      dst: xf(1 / 16, 0),
    });
  }
  return out;
}

/// Synthetic pairs, imported through the real importer so they arrive as the renderer sees them.
export async function synthPairs(importSvg, parseMetaBin, curveRangeToContours) {
  const out = [];
  for (const { name, a, b, mixed } of syntheticSvgs()) {
    let A, B;
    try {
      A = await importSvg(a, { preserveViewport: true });
      B = await importSvg(b, { preserveViewport: true });
    } catch {
      continue;
    }
    if (!A || !B || A.numShapes !== B.numShapes) continue;
    const ma = parseMetaBin(A.meta, A.metaFloatsPerShape);
    const pa = new Float32Array(A.curves),
      pb = new Float32Array(B.curves);
    for (let s = 0; s < ma.numShapes; s++) {
      const qa = A.curveRangesByShape[s],
        qb = B.curveRangesByShape[s];
      if (!qa || !qb) continue;
      const ca = curveRangeToContours(pa, qa.begin, qa.end),
        cb = curveRangeToContours(pb, qb.begin, qb.end);
      if (!ca || !cb || ca.length !== cb.length) continue;
      out.push({
        name: name + '#' + s,
        kind: mixed ? 'mixed' : 'synth',
        shape: s,
        evenOdd: ma.metaFloats[s * ma.floatsPerShape + 13] > 0.5,
        transSolid: false,
        src: ca,
        dst: cb,
      });
    }
  }
  return out;
}
