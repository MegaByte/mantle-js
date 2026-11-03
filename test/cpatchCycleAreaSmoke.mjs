// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchCycleAreaSmoke.mjs -- a paint whose contours cross (so the whole-paint certificate declines and the intersection
// graph extracts cycles) takes the complete-paint AREA when the extracted cycles certify, instead of a decomposition whose
// patch choice moves with sub-ulp input. The nodes of extracted cycles differ by the intersection solver's rounding; the cycles
// are snapped to a shared node coordinate (a few ulps of the paint's largest coordinate, never an absolute length) and the
// certificate runs unchanged on them, with exact shared endpoints allowed as joints between any two spans.
//
//   * overlapping closed cubic blobs and a self-crossing figure eight, at scales 2^-20, 1 and 2^20 and at a far origin
//   * the blobs must be ONE area paint (cpatchAreaOnly), not a decomposition; so is the eight, whose two lobes touch at one node
//   * the area's curves, wound as the pack reports them, must reproduce the authored fill (nonzero) at a dense grid of points
//     away from the boundary: the snap moves a boundary by at most a few ulps, never a region
import { packCPatchShape } from '../src/renderer/cpatchPack.js';

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const circle = (cx, cy, rx, ry, rot = 0, ccw = true) => {
  const k = 0.5522847498307936,
    pts = [];
  const q = [
    [1, 0],
    [1, k],
    [k, 1],
    [0, 1],
    [-k, 1],
    [-1, k],
    [-1, 0],
    [-1, -k],
    [-k, -1],
    [0, -1],
    [k, -1],
    [1, -k],
    [1, 0],
  ];
  const T = ([x, y]) => {
    const X = x * rx,
      Y = y * ry * (ccw ? 1 : -1);
    return [cx + X * Math.cos(rot) - Y * Math.sin(rot), cy + X * Math.sin(rot) + Y * Math.cos(rot)];
  };
  const p = q.map(T);
  for (let i = 0; i < 12; i += 3) pts.push({ t: 'cubic', P: [p[i], p[i + 1], p[i + 2], p[i + 3]] });
  return pts;
};
// a figure eight: one closed contour of two cubics that cross once (nonzero: both lobes filled, opposite windings)
const eight = (cx, cy, r) => {
  const P = (x, y) => [cx + x * r, cy + y * r];
  return [
    { t: 'cubic', P: [P(0, 0), P(1.5, 1.4), P(1.5, -1.4), P(0, 0)] },
    { t: 'cubic', P: [P(0, 0), P(-1.5, 1.4), P(-1.5, -1.4), P(0, 0)] },
  ];
};

const flatten = (c, n = 48) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / n,
      s = 1 - t,
      P = c.P;
    if (P.length === 4)
      out.push([
        s * s * s * P[0][0] +
          3 * s * s * t * P[1][0] +
          3 * s * t * t * P[2][0] +
          t * t * t * P[3][0],
        s * s * s * P[0][1] +
          3 * s * s * t * P[1][1] +
          3 * s * t * t * P[2][1] +
          t * t * t * P[3][1],
      ]);
    else if (P.length === 3)
      out.push([
        s * s * P[0][0] + 2 * s * t * P[1][0] + t * t * P[2][0],
        s * s * P[0][1] + 2 * s * t * P[1][1] + t * t * P[2][1],
      ]);
    else out.push([s * P[0][0] + t * P[1][0], s * P[0][1] + t * P[1][1]]);
  }
  return out;
};
const polyOf = (curves) => curves.flatMap((c) => flatten(c, 96));
const winding = (poly, x, y) => {
  let w = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length];
    if (a[1] <= y !== b[1] <= y) {
      const t = (y - a[1]) / (b[1] - a[1]);
      if (a[0] + t * (b[0] - a[0]) > x) w += b[1] > a[1] ? 1 : -1;
    }
  }
  return w;
};
const distToPoly = (poly, x, y) => {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i],
      b = poly[(i + 1) % poly.length],
      ex = b[0] - a[0],
      ey = b[1] - a[1];
    const L = ex * ex + ey * ey,
      t = L > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / L)) : 0;
    d = Math.min(d, Math.hypot(x - a[0] - t * ex, y - a[1] - t * ey));
  }
  return d;
};

const FRAMES = [
  [1, 0, 0],
  [2 ** -20, 0, 0],
  [2 ** 20, 0, 0],
  [1, 3000, -4000],
];
const scene = (name, build, mustArea = true, frames = FRAMES) => {
  for (const [scale, ox, oy] of frames) {
    const contours = build(scale, ox, oy);
    let area = null;
    const r = packCPatchShape(contours, 0, {
      evenOdd: false,
      onPatches: (ps) => {
        if (ps.length === 1 && ps[0].curves) area = ps[0];
      },
    });
    const tag = `${name} scale ${scale} origin (${ox},${oy})`;
    if (mustArea) ok(r && r.cpatchAreaOnly === true, `${tag}: one complete-paint area`);
    if (!(r && r.cpatchAreaOnly && area)) continue;
    // reference: the authored contours, nonzero, flattened per contour
    const polys = contours.map(polyOf);
    // the area's curves arrive loop after loop; each loop closes where a curve ends at the first curve's start
    const loops = [];
    {
      let cur = [];
      for (const c of area.curves) {
        cur.push(c);
        const e = c.P[c.P.length - 1],
          b = cur[0].P[0];
        if (e[0] === b[0] && e[1] === b[1]) {
          loops.push(cur);
          cur = [];
        }
      }
      if (cur.length) loops.push(cur);
    }
    ok(
      loops.every((l) => {
        const e = l[l.length - 1].P;
        const b = l[0].P[0];
        return e[e.length - 1][0] === b[0] && e[e.length - 1][1] === b[1];
      }),
      `${tag}: every reported loop closes exactly`,
    );
    const areaPolys = loops.map(polyOf);
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (const p of polys)
      for (const q of p) {
        x0 = Math.min(x0, q[0]);
        x1 = Math.max(x1, q[0]);
        y0 = Math.min(y0, q[1]);
        y1 = Math.max(y1, q[1]);
      }
    const ext = Math.max(x1 - x0, y1 - y0),
      G = 90;
    let n = 0,
      bad = 0;
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const x = x0 + ((i + 0.5) / G) * (x1 - x0),
          y = y0 + ((j + 0.5) / G) * (y1 - y0);
        let near = Infinity;
        for (const p of polys) near = Math.min(near, distToPoly(p, x, y));
        if (near < 2e-3 * ext) continue;
        n++;
        const want = polys.reduce((s, p) => s + winding(p, x, y), 0) !== 0;
        // the area's curves are wound so that the region they bound is the fill: nonzero of the reported curves
        const got = areaPolys.reduce((a, p) => a + winding(p, x, y), 0) !== 0;
        if (want !== got) bad++;
      }
    ok(
      n > 1500 && bad === 0,
      `${tag}: area region equals the authored nonzero fill at ${n} interior/exterior samples (${bad} differ)`,
    );
  }
};

// Real tiger paints whose cycle certificate declined (cubic control points, the importer's own numbers).
const TIGER = {
  // shape 41
  41: [
    [
      [
        [441.08668654, 435.1053426],
        [441.08668654, 435.1053426],
        [472.33509475739993, 482.459976366],
        [471.27923826999995, 490.89976568],
      ],
      [
        [471.27923826999995, 490.89976568],
        [468.98389808, 509.2624872],
        [468.63076881999996, 526.21269168],
        [474.28083698, 533.27527688],
      ],
      [
        [474.28083698, 533.27527688],
        [479.9326707863, 540.33786208],
        [495.4703582263, 598.9573192400001],
        [495.4703582263, 598.9573192400001],
      ],
      [
        [495.4703582263, 598.9573192400001],
        [495.4703582263, 598.9573192400001],
        [494.7640997063, 601.0760948],
        [516.65634818, 533.9815354],
      ],
      [
        [516.65634818, 533.9815354],
        [516.65634818, 533.9815354],
        [537.13784526, 505.7311946],
        [501.82491926, 473.24330268],
      ],
      [
        [501.82491926, 473.24330268],
        [501.82491926, 473.24330268],
        [439.67416949999995, 422.39268924],
        [441.08668654, 435.1053426],
      ],
    ],
  ],
  // shape 148 (a spike whose two curves leave the tip 2e-4 radians apart)
  148: [
    [
      [
        [217.18684488329995, 275.1430847589],
        [216.7122344939293, 275.31009687809944],
        [216.796401455653, 273.547017354221],
        [216.8737253355736, 271.92728264355924],
      ],
      [
        [216.8737253355736, 271.92728264355924],
        [216.92556098285243, 270.84146029173974],
        [216.9743213724765, 269.8200566107471],
        [216.84960643999997, 269.48771966],
      ],
      [
        [216.84960643999997, 269.48771966],
        [215.04511592139997, 264.67456784620003],
        [198.84001417999997, 261.89544057],
        [198.84001417999997, 261.89544057],
      ],
      [
        [198.84001417999997, 261.89544057],
        [198.43921246989996, 264.3055477695],
        [198.34210192339998, 267.1235192643],
        [198.52926043119996, 270.0156479037],
      ],
      [
        [198.52926043119996, 270.0156479037],
        [198.52926043119996, 270.0156479037],
        [206.06503883959996, 279.0539913134],
        [217.18684488329995, 275.1430847589],
      ],
    ],
  ],
  // shape 129
  129: [
    [
      [
        [841.35870275, 673.4675931],
        [841.35870275, 673.4675931],
        [731.005809, 568.41163825],
        [728.35733955, 563.9975225000001],
      ],
      [
        [728.35733955, 563.9975225000001],
        [728.35733955, 563.9975225000001],
        [835.1789407, 680.5301783],
        [840.4758796, 693.77252555],
      ],
      [
        [840.4758796, 693.77252555],
        [840.4758796, 693.77252555],
        [836.944587, 677.88170885],
        [841.35870275, 673.4675931],
      ],
    ],
  ],
  // shape 107
  107: [
    [
      [
        [422.72396502, 289.61608748000003],
        [422.72396502, 289.61608748000003],
        [414.9551213, 283.96601932],
        [414.9551213, 287.85044118],
      ],
      [
        [414.9551213, 287.85044118],
        [414.9551213, 287.85044118],
        [421.31144797999997, 295.6192849],
        [422.72396502, 289.61608748000003],
      ],
    ],
  ],
  // shape 294
  294: [
    [
      [
        [246.51246428, 807.6567119],
        [246.51246428, 807.6567119],
        [266.99396135999996, 768.10623478],
        [228.50287201999998, 813.6599093199999],
      ],
      [
        [228.50287201999998, 813.6599093199999],
        [228.50287201999998, 813.6599093199999],
        [247.92498131999997, 796.3565755799999],
        [246.51246428, 807.6567119],
      ],
    ],
  ],
  // (the perturbed copies of the same shape: each holds the crossing as a different root of the composition)
  // shape 41 of the perturbed copy p12
  '41p12': [
    [
      [
        [441.0866502038481, 435.10532045628383],
        [441.0866502038481, 435.10532045628383],
        [472.3350620932997, 482.4599572925805],
        [471.27920447023314, 490.899738457898],
      ],
      [
        [471.27920447023314, 490.899738457898],
        [468.9838643024002, 509.2624570639739],
        [468.6307348398169, 526.2126689461313],
        [474.28080284019256, 533.275248476144],
      ],
      [
        [474.28080284019256, 533.275248476144],
        [479.93263537243365, 540.3378342193187],
        [495.470321392218, 598.9573019329436],
        [495.470321392218, 598.9573019329436],
      ],
      [
        [495.470321392218, 598.9573019329436],
        [495.470321392218, 598.9573019329436],
        [494.76406300409326, 601.0760772775317],
        [516.6563066089606, 533.9815225921667],
      ],
      [
        [516.6563066089606, 533.9815225921667],
        [516.6563066089606, 533.9815225921667],
        [537.137808331264, 505.7311808085874],
        [501.82487679113825, 473.24327482964463],
      ],
      [
        [501.82487679113825, 473.24327482964463],
        [501.82487679113825, 473.24327482964463],
        [439.67413490122226, 422.3926532748502],
        [441.0866502038481, 435.10532045628383],
      ],
    ],
  ],
};
const fromTiger = (key) => (s, ox, oy) =>
  TIGER[key].map((loop) =>
    loop.map((P) => ({ t: 'cubic', P: P.map(([x, y]) => [ox + x * s, oy + y * s]) })),
  );

scene('two overlapping blobs', (s, ox, oy) => [
  circle(ox + 0 * s, oy + 0 * s, 10 * s, 7 * s, 0.3),
  circle(ox + 9 * s, oy + 2 * s, 8 * s, 9 * s, -0.5),
]);
scene('three chained blobs', (s, ox, oy) => [
  circle(ox, oy, 9 * s, 6 * s, 0.1),
  circle(ox + 8 * s, oy + 1 * s, 7 * s, 7 * s, 0.7),
  circle(ox + 15 * s, oy - 2 * s, 8 * s, 5 * s, -0.2),
]);
scene('figure eight', (s, ox, oy) => [eight(ox, oy, 10 * s)]);

// remainder: real paints whose extracted cycles hold a LENS (two curves between the same two nodes: tiger shapes 129, 107,
// 294, whose hulls touch at both nodes and cannot be separated at any depth) or a crossing a hair from a shared vertex that the
// probe cannot orient (shape 41: the end of a curve 6e-4 long, shorter than the probe's offset, which a probe would read as no
// boundary, leaving the cycle open by that gap). Each is one complete-paint area, at every scale and origin.
scene('tiger shape 129 (a spike lens)', fromTiger('129'));
// two curves that leave a node 2e-4 radians apart: the control hulls separate only after the cut to a thousandth of that
scene(
  'tiger shape 148 (a spike, curves 2e-4 radians apart at the tip)',
  fromTiger('148'),
  true,
  FRAMES.slice(0, 3),
);
scene('tiger shape 107 (a two-curve lens)', fromTiger('107'));
scene('tiger shape 294 (a two-curve lens)', fromTiger('294'));
// (at a far origin the 6e-4 crossing is 1.5e-7 of the coordinates, which the intersector does not resolve: the cycle then crosses itself
// and the certificate rightly declines, so that frame is not asked of this shape)
scene('tiger shape 41 (a micro lens at a vertex)', fromTiger('41'), true, FRAMES.slice(0, 3));
// a copy whose crossing the composition's roots pair with the vertex's own root, so an unpolished crossing would make the cycle through it cross itself
scene(
  'perturbed tiger shape 41 (the crossing beside the vertex)',
  fromTiger('41p12'),
  true,
  FRAMES.slice(0, 3),
);

console.log(`\ncpatchCycleAreaSmoke: ${fail ? 'FAIL' : 'PASS'}`);
process.exit(fail ? 1 : 0);
