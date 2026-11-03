// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// makeGpuInputs.mjs — standalone SVGs for a GPU check of the line branch's miter-clip / arcs joins,
// the square cap's far plane and corner reach, and the miter band grid, with the ink each should render.
//
//   node probes/strokeCapJoin/makeGpuInputs.mjs --base-src <a js.kontek.mantle tree without those rules>
//
// Writes probes/strokeCapJoin/gpu/*.svg and gpu/manifest.json. For every SVG:
//   canvas      [W, H]: render at exactly this many device pixels (DPR 1). Two 1x1 black squares at
//               (0,0) and (W-1,H-1) make the content bbox the whole canvas, so the renderer's
//               fit-content-bbox is 1:1 and pixel centers sit at (i + 0.5, j + 0.5) in user units.
//               markers.svg is those squares alone: subtract its measured ink.
//   trueInk     area of the SVG 2 stroke shape (test/_strokeShapeRef.mjs svgInside), supersampled
//               32x32 per pixel wherever a 4x4 pass or the pixel's corners disagree. Markers excluded.
//   before/after  the ink the CPU predicts, markers excluded: sum over pixel centers of the coverage
//               from importSvg + the band-walk emulator (test/_strokeBandEmu.mjs: cover quad, band
//               pick, gates; the quad dilated half a pixel as the vertex shader does) + the line-branch
//               port. before = the --base-src importer, the port's 'base' rule (the join and
//               square-cap rules reverted), and the base shader's _reach; after = this tree.
//   moved       pixels whose predicted coverage changes by more than 1/255.
// Lines only: the curve probe (curve-square-cap) has a true area but no prediction.
import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { svgInside } from '../../test/_strokeShapeRef.mjs';
import { makeStrokeEmu, strokeRowsOf } from '../../test/_strokeBandEmu.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'gpu');
const arg = (k) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : null;
};
const BASE = arg('base-src');
if (!BASE)
  throw new Error(
    '--base-src <path to a js.kontek.mantle tree without the join and square-cap rules> is required',
  );
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importNew } = await import('../../src/svg/importer.js');
const { default: importBase } = await import(
  pathToFileURL(path.join(path.resolve(BASE), 'src/svg/importer.js')).href
);

const JOINS = { miter: 0, round: 1, bevel: 2, 'miter-clip': 3, arcs: 4 };
const CAPS = { butt: 0, round: 1, square: 2 };
// the base shader's _reach, in half-widths (no square-cap term, no sqrt(L^2 + 1) miter-clip term)
const baseReach = (join, L) => (join === 0 || join === 3 || join === 4 ? Math.max(L, 1) : 1);

function svgDoc(W, H, strokes) {
  const body = strokes
    .map(
      (s) =>
        `  <path d="${s.d}" fill="none" stroke="#000" stroke-width="${2 * s.hw}" stroke-linecap="${s.cap}" stroke-linejoin="${s.join}" stroke-miterlimit="${s.L}"/>`,
    )
    .join('\n');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">\n` +
    `  <rect x="0" y="0" width="1" height="1" fill="#000"/>\n  <rect x="${W - 1}" y="${H - 1}" width="1" height="1" fill="#000"/>\n${body}\n</svg>\n`
  );
}
const polyOf = (d) =>
  d
    .replace(/[ML]/g, ' ')
    .trim()
    .split(/\s+/)
    .map(Number)
    .reduce((a, v, i) => (i % 2 ? a[a.length - 1].push(v) : a.push([v]), a), []);

function trueInk(W, H, strokes) {
  let ink = 0;
  for (const s of strokes) {
    const P = s.P || polyOf(s.d),
      J = JOINS[s.join],
      C = CAPS[s.cap];
    const inside = (x, y) => svgInside([x, y], P, false, s.hw, C, J, s.L);
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) {
        let k = 0;
        for (let a = 0; a < 4; a++)
          for (let b = 0; b < 4; b++) if (inside(i + (a + 0.5) / 4, j + (b + 0.5) / 4)) k++;
        if (k === 0 || k === 16) {
          // a 4x4 pass can miss an edge crossing a pixel corner; call a pixel uniform only if its four
          // corners agree too
          const want = k === 16;
          if (
            inside(i, j) === want &&
            inside(i + 1, j) === want &&
            inside(i, j + 1) === want &&
            inside(i + 1, j + 1) === want
          ) {
            if (want) ink += 1;
            continue;
          }
        }
        let m = 0;
        for (let a = 0; a < 32; a++)
          for (let b = 0; b < 32; b++) if (inside(i + (a + 0.5) / 32, j + (b + 0.5) / 32)) m++;
        ink += m / 1024;
      }
  }
  return ink;
}

async function predict(importer, svg, W, H, strokes, which) {
  const b = await importer(svg);
  const rows = strokeRowsOf(b);
  if (rows.length !== strokes.length)
    throw new Error(`expected ${strokes.length} stroke rows, got ${rows.length}`);
  const cov = new Float64Array(W * H);
  rows.forEach((row, k) => {
    const s = strokes[k];
    const emu =
      which === 'base'
        ? makeStrokeEmu(b, row, {
            rule: 'base',
            gates: true,
            reachFactor: baseReach(JOINS[s.join], s.L),
            dilate: 0.5,
          })
        : makeStrokeEmu(b, row, { rule: 'fixed', gates: true, dilate: 0.5 });
    for (let j = 0; j < H; j++)
      for (let i = 0; i < W; i++) cov[j * W + i] += emu.eval([i + 0.5, j + 0.5]).cov;
  });
  return cov;
}

const PROBES = [
  {
    name: 'miter-clip',
    W: 200,
    H: 140,
    note: 'a 32-degree V past its limit (ratio 3.64 > 2): the spike is cut at 2 * halfW. Base draws it round inside the wedge, and its cover quad stops halfW past the apex.',
    strokes: [{ d: 'M 30 30 L 170 70 L 30 110', hw: 8, cap: 'butt', join: 'miter-clip', L: 2 }],
  },
  {
    name: 'arcs',
    W: 200,
    H: 140,
    note: 'the same V with stroke-linejoin arcs, which SVG 2 sends to miter-clip on straight segments. Base draws it round past the limit.',
    strokes: [{ d: 'M 30 30 L 170 70 L 30 110', hw: 8, cap: 'butt', join: 'arcs', L: 2 }],
  },
  {
    name: 'miter-clip-within-limit',
    W: 200,
    H: 160,
    note: 'miter-clip inside the limit: a 76-degree V (ratio 1.63 <= 4) is a full miter. Base draws miter-clip round inside the wedge even here, so this one moves too; its arcs twin (control-arcs-within-limit) must not.',
    strokes: [{ d: 'M 30 130 L 100 40 L 170 130', hw: 10, cap: 'butt', join: 'miter-clip', L: 4 }],
  },
  {
    name: 'control-arcs-within-limit',
    W: 200,
    H: 160,
    note: 'CONTROL: arcs within its limit is a miter in base too; predicted to move 0 pixels.',
    strokes: [{ d: 'M 30 130 L 100 40 L 170 130', hw: 10, cap: 'butt', join: 'arcs', L: 4 }],
  },
  {
    name: 'square-cap-far-plane',
    W: 170,
    H: 120,
    note: 'square caps whose far planes cut pixel columns/rows at .25 and .75: base drops past halfW (hard edge), fixed ramps.',
    strokes: [
      { d: 'M 30.25 40 L 120.75 40', hw: 15, cap: 'square', join: 'bevel', L: 4 },
      { d: 'M 155 20.75 L 155 100.25', hw: 8, cap: 'square', join: 'bevel', L: 4 },
    ],
  },
  {
    name: 'square-cap-corners',
    W: 170,
    H: 110,
    note: 'a V of two 45-degree segments with square caps under a bevel join: the cap corners lead along the axes, sqrt(2) * halfW from the endpoints, past the base cover quad (padded by halfW).',
    strokes: [{ d: 'M 30 25 L 85 80 L 140 25', hw: 12, cap: 'square', join: 'bevel', L: 4 }],
  },
  {
    name: 'control-round',
    W: 200,
    H: 160,
    note: 'CONTROL: round caps and joins; predicted to move 0 pixels.',
    strokes: [{ d: 'M 30 130 L 100 40 L 170 130', hw: 10, cap: 'round', join: 'round', L: 4 }],
  },
  {
    name: 'control-miter-butt',
    W: 200,
    H: 160,
    note: 'CONTROL: a miter within its limit, butt caps, few bands; predicted to move 0 pixels.',
    strokes: [{ d: 'M 30 130 L 100 40 L 170 130', hw: 10, cap: 'butt', join: 'miter', L: 4 }],
  },
];
// the miter band grid: a rising sawtooth under limit 10
{
  const P = [];
  for (let k = 0; k <= 80; k++)
    P.push([12 + k * 6, 1680 - ((k % 2) * 60 + Math.floor(k / 2) * 40) - 12]);
  PROBES.push({
    name: 'grid-miter-sawtooth',
    W: 510,
    H: 1760,
    note: "a rising sawtooth, 80 teeth, miterlimit 10 (51 bands): base bins a miter row's bands through path + limit * halfW while the shader indexes them through path + halfW, and some spike centers find no segment.",
    strokes: [
      {
        d: 'M ' + P.map((p) => `${p[0]} ${p[1]}`).join(' L '),
        P,
        hw: 6,
        cap: 'butt',
        join: 'miter',
        L: 10,
      },
    ],
  });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(path.join(OUT, 'markers.svg'), svgDoc(200, 140, []));
const manifest = {
  how: 'see makeGpuInputs.mjs header; ink = sum of alpha / 255 over the canvas',
  markersInk: 2,
  probes: [],
};
for (const pr of PROBES) {
  const t0 = performance.now();
  for (const s of pr.strokes) s.P = s.P || polyOf(s.d);
  const svg = svgDoc(pr.W, pr.H, pr.strokes);
  writeFileSync(path.join(OUT, `${pr.name}.svg`), svg);
  const before = await predict(importBase, svg, pr.W, pr.H, pr.strokes, 'base');
  const after = await predict(importNew, svg, pr.W, pr.H, pr.strokes, 'new');
  let inkB = 0,
    inkA = 0,
    moved = 0;
  for (let i = 0; i < before.length; i++) {
    inkB += before[i];
    inkA += after[i];
    if (Math.abs(before[i] - after[i]) > 1 / 255) moved++;
  }
  // the sawtooth's 160 segments over 900k pixels are too slow for the supersampled truth here
  const truth = pr.strokes.every((st) => st.P.length <= 10)
    ? trueInk(pr.W, pr.H, pr.strokes)
    : null;
  const row = {
    file: `${pr.name}.svg`,
    canvas: [pr.W, pr.H],
    trueInk: truth == null ? null : +truth.toFixed(1),
    predictedBefore: +inkB.toFixed(1),
    predictedAfter: +inkA.toFixed(1),
    movedPixels: moved,
    note: pr.note,
  };
  manifest.probes.push(row);
  console.log(
    `${pr.name.padEnd(30)} ${pr.W}x${pr.H}  true ${row.trueInk}  before ${row.predictedBefore}  after ${row.predictedAfter}  moved ${moved}  (${((performance.now() - t0) / 1000).toFixed(1)} s)`,
  );
}
// the curve twin (_strokeMath.glsl): true area only
{
  const W = 170,
    H = 110,
    N = 2000,
    P = [],
    hw = 12;
  const B = (t) => {
    const u = 1 - t;
    return [
      u * u * 30.25 + 2 * u * t * 85 + t * t * 139.75,
      u * u * 70 + 2 * u * t * 10 + t * t * 70,
    ];
  };
  for (let k = 0; k <= N; k++) P.push(B(k / N));
  const svg = svgDoc(W, H, []).replace(
    '</svg>',
    `  <path d="M 30.25 70 Q 85 10 139.75 70" fill="none" stroke="#000" stroke-width="${2 * hw}" stroke-linecap="square" stroke-linejoin="round"/>\n</svg>`,
  );
  writeFileSync(path.join(OUT, 'curve-square-cap.svg'), svg);
  // The curve's radius of curvature is >= 49.96 > halfW, so its SVG 2 stroke is the set of points within
  // halfW of the curve whose nearest curve point is not an END, plus the two halfW-deep square caps.
  // Nearest point on a 2000-segment flattening, from per-pixel candidate lists.
  const cand = Array.from({ length: W * H }, () => []);
  for (let k = 0; k < N; k++) {
    const [ax, ay] = P[k],
      [bx, by] = P[k + 1];
    const r = (k === 0 || k === N - 1 ? Math.SQRT2 * hw : hw) + 2; // an end segment carries its cap's corners
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)),
      x1 = Math.min(W - 1, Math.floor(Math.max(ax, bx) + r));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)),
      y1 = Math.min(H - 1, Math.floor(Math.max(ay, by) + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) cand[y * W + x].push(k);
  }
  const t0v = [P[1][0] - P[0][0], P[1][1] - P[0][1]],
    t1v = [P[N][0] - P[N - 1][0], P[N][1] - P[N - 1][1]];
  const nrm = (v) => {
    const l = Math.hypot(v[0], v[1]);
    return [v[0] / l, v[1] / l];
  };
  const tS = nrm(t0v),
    tE = nrm(t1v);
  const inCap = (x, y, E, t, sgn) => {
    const qx = x - E[0],
      qy = y - E[1],
      a = sgn * (qx * t[0] + qy * t[1]);
    return a >= 0 && a <= hw && Math.abs(-qx * t[1] + qy * t[0]) <= hw;
  };
  const inside = (x, y, list) => {
    let best = Infinity,
      end = false;
    for (const k of list) {
      const [ax, ay] = P[k],
        [bx, by] = P[k + 1],
        dx = bx - ax,
        dy = by - ay;
      let u = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
      const clampedEnd = (k === 0 && u < 0) || (k === N - 1 && u > 1);
      u = Math.max(0, Math.min(1, u));
      const d = Math.hypot(x - ax - u * dx, y - ay - u * dy);
      if (d < best) {
        best = d;
        end = clampedEnd;
      }
    }
    if (best <= hw && !end) return true;
    return inCap(x, y, P[0], tS, -1) || inCap(x, y, P[N], tE, 1);
  };
  let truth = 0;
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const list = cand[j * W + i];
      if (!list.length) continue;
      let k = 0;
      for (let a = 0; a < 4; a++)
        for (let b = 0; b < 4; b++) if (inside(i + (a + 0.5) / 4, j + (b + 0.5) / 4, list)) k++;
      if (
        (k === 16 || k === 0) &&
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ].every(([a, b]) => inside(i + a, j + b, list) === (k === 16))
      ) {
        truth += k === 16 ? 1 : 0;
        continue;
      }
      let m = 0;
      for (let a = 0; a < 32; a++)
        for (let b = 0; b < 32; b++) if (inside(i + (a + 0.5) / 32, j + (b + 0.5) / 32, list)) m++;
      truth += m / 1024;
    }
  manifest.probes.push({
    file: 'curve-square-cap.svg',
    canvas: [W, H],
    trueInk: +truth.toFixed(1),
    predictedBefore: null,
    predictedAfter: null,
    movedPixels: null,
    note: 'the square-cap far plane in the curve twin (_strokeMath.glsl): a quadratic whose ends leave at about 48 degrees, with square caps. No CPU prediction (the port is lines only). True area: points within halfW of a 2000-segment flattening whose nearest point is not an end, plus the two cap boxes (valid: the radius of curvature, >= 49.96, exceeds halfW).',
  });
  console.log(`curve-square-cap          ${W}x${H}  true ${truth.toFixed(1)}  (no prediction)`);
}
writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${manifest.probes.length} probes + markers.svg to ${OUT}`);
