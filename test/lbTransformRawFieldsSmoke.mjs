// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbTransformRawFieldsSmoke — transformLoopBlinnRaw must carry a cubic's END-TANGENT CLIP data
// through the similarity, not silently drop it.
//
// The canonical-similarity cache builds one LB mesh per similarity orbit and clones it through
// transformLoopBlinnRaw for every translated/rotated/uniformly-scaled instance. That clone
// rebuilds each cubic record field by field, and it must copy more than { hull, sign, klmn, F }:
// na/nb/a/b, the piece's own end-tangent clip planes, are what trim the DILATED cover hull so
// neighboring crescents tile; without them the dilation over-covers and the shape renders
// differently than the identical shape built fresh. No pixel gate catches that, because every LB
// gate draws its shape on the MISS (fresh-build) path.
//
// Pure math, no GL: the fields are the contract.
import { transformLoopBlinnRaw } from '../src/renderer/lbPack.js';

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));
const close = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// a 90deg rotation + 2x scale + translation
const th = Math.PI / 2,
  M = { s: 2, cos: Math.cos(th), sin: Math.sin(th), dx: 10, dy: -5 };
const TP = (x, y) => [M.s * (M.cos * x - M.sin * y) + M.dx, M.s * (M.sin * x + M.cos * y) + M.dy];

const mesh = {
  interior: new Float32Array([0, 0, 1, 0, 0, 1]),
  quads: [],
  edges: [],
  circles: [],
  annuli: [],
  cubics: [
    {
      hull: new Float32Array([0, 0, 4, 0, 0, 4]),
      klmn: new Float32Array([0, 0, 0, 1, 2, 3, 4, 5, 6]),
      sign: 1,
      na: [1, 0], // unit tangent at the piece's start (a DIRECTION)
      nb: [0, -1], // inward-facing end tangent (a DIRECTION)
      a: [0, 0], // the piece's start POINT
      b: [0, 4], // the piece's end POINT
    },
  ],
};

const out = transformLoopBlinnRaw(mesh, M);
const c = out.cubics[0];

ok(!!c.na && !!c.nb, 'cubic keeps its clip normals na/nb through the similarity');
ok(!!c.a && !!c.b, 'cubic keeps its clip points a/b through the similarity');

if (c.na && c.nb && c.a && c.b) {
  // directions ROTATE only — a 2x scale must not lengthen a unit normal
  const rot = (v) => [M.cos * v[0] - M.sin * v[1], M.sin * v[0] + M.cos * v[1]];
  const [nax, nay] = rot([1, 0]),
    [nbx, nby] = rot([0, -1]);
  ok(
    close(c.na[0], nax) && close(c.na[1], nay),
    `na rotates, not scales (${c.na.map((v) => v.toFixed(3))})`,
  );
  ok(
    close(c.nb[0], nbx) && close(c.nb[1], nby),
    `nb rotates, not scales (${c.nb.map((v) => v.toFixed(3))})`,
  );
  ok(
    close(Math.hypot(c.na[0], c.na[1]), 1) && close(Math.hypot(c.nb[0], c.nb[1]), 1),
    'clip normals stay unit length',
  );
  // points take the FULL similarity (scale + rotate + translate)
  const a = TP(0, 0),
    b = TP(0, 4);
  ok(
    close(c.a[0], a[0]) && close(c.a[1], a[1]),
    `a takes the full similarity (${c.a.map((v) => v.toFixed(3))})`,
  );
  ok(
    close(c.b[0], b[0]) && close(c.b[1], b[1]),
    `b takes the full similarity (${c.b.map((v) => v.toFixed(3))})`,
  );
  // the clip plane must still pass through the transformed curve endpoints: dot(a' - a', na') == 0
  // and the hull's transformed start vertex coincides with a'.
  ok(
    close(c.hull[0], a[0]) && close(c.hull[1], a[1]),
    'hull vertex 0 and clip point a agree after transform',
  );
}

console.log(fail ? `\nLB-TRANSFORM-RAW-FIELDS FAIL (${fail})` : '\nLB-TRANSFORM-RAW-FIELDS PASS');
process.exit(fail ? 1 : 0);
