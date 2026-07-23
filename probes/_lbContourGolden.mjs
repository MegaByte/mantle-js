// _lbContourGolden.mjs — lbContour parity goldens for the C# port.
import { writeFileSync } from 'fs';
import { mkLine, mkQuad, mkCubic, mkRQuad } from '../src/primitives/seg.js';
import {
  rayWinding, rayWindingDir, arcToRationalQuads, circleFromContours, fitCircle,
  extractAnnuli, segTangents, segCurvature, segPt, edgeEndMeta, fatArc,
  ringSignedArea, chordRing,
} from '../src/renderer/lbContour.js';

// serialize a seg to a plain record the C# harness rebuilds
const segObj = (s) => ({
  t: s.type, p1: s.p1, p2: s.p2 || null, p3: s.p3 || null, p4: s.p4 || null,
  w: s.w ?? null, circle: s.circle ? { cx: s.circle.cx, cy: s.circle.cy, r: s.circle.r } : null,
});
const contourObj = (segs) => segs.map(segObj);

// a closed square (lines), a rounded shape (cubic), and a full circle (arc→rquads)
const square = [mkLine([0, 0], [10, 0]), mkLine([10, 0], [10, 10]), mkLine([10, 10], [0, 10]), mkLine([0, 10], [0, 0])];
const cubicBlob = [
  mkCubic([0, 5], [3, -2], [7, -2], [10, 5]),
  mkCubic([10, 5], [7, 12], [3, 12], [0, 5]),
];
const circleSegs = arcToRationalQuads(20, 20, 8, 8, 0, 2 * Math.PI, 0);
const ellipseSegs = arcToRationalQuads(0, 0, 10, 6, 0, Math.PI, 0.3);

const queries = [[5, 5], [5, 0.5], [12, 5], [20, 20], [20, 27.5], [3, 5]];
const contours = { square, cubicBlob, circle: circleSegs };
const winding = {};
for (const [name, segs] of Object.entries(contours)) {
  winding[name] = queries.map(([x, y]) => ({
    x, y, w: rayWinding(segs, x, y),
    wd: [rayWindingDir(segs, x, y, 1, 0), rayWindingDir(segs, x, y, 0.6, 0.8)],
  }));
}

// arcToRationalQuads output
const arcs = {
  quarter: arcToRationalQuads(0, 0, 5, 5, 0, Math.PI / 2, 0).map(segObj),
  ellipseArc: ellipseSegs.map(segObj),
};

// circle / annulus
const twoRings = [
  ...arcToRationalQuads(0, 0, 10, 10, 0, 2 * Math.PI, 0),      // outer, CCW
  ...arcToRationalQuads(0, 0, 5, 5, 2 * Math.PI, 0, 0),        // inner, CW (hole)
];
// split into two contours (outer / inner) by circle
const outerRing = arcToRationalQuads(0, 0, 10, 10, 0, 2 * Math.PI, 0);
const innerRing = arcToRationalQuads(0, 0, 5, 5, 2 * Math.PI, 0, 0);
const annulusRes = extractAnnuli([outerRing, innerRing], 'evenodd');

const circleFit = fitCircle([[8, 0], [0, 8], [-8, 0], [0, -8], [5.657, 5.657]].map(p => [p[0] + 20, p[1] + 20]));

// per-seg geometry
const geomSegs = [square[0], cubicBlob[0], circleSegs[0]];
const segGeom = geomSegs.map((s) => ({
  seg: segObj(s),
  tangents: (() => { const t = segTangents(s); return { t0: t.t0, t1: t.t1, end: t.end, curve: t.curve }; })(),
  curv: [segCurvature(s, 0), segCurvature(s, 1)],
  pt: [segPt(s, 0.25), segPt(s, 0.5), segPt(s, 0.75)],
}));

// edgeEndMeta on the square (straight edges w/ straight neighbours)
const sqTangents = square.map(segTangents);
const eem = [0, 1, 2, 3].flatMap((si) => [0, 1].map((which) => {
  const m = edgeEndMeta(square, sqTangents, si, which, 1);
  return { si, which, nN: m.nN, k: m.k, type: m.type, curve: m.curve, tsign: m.tsign };
}));

const out = {
  version: 1,
  winding: { contours: Object.fromEntries(Object.entries(contours).map(([k, v]) => [k, contourObj(v)])), results: winding },
  arcs,
  circleFromContours: {
    circleContour: contourObj(circleSegs),
    result: circleFromContours([circleSegs]),
    squareResult: circleFromContours([square]),
  },
  fitCircle: circleFit,
  annuli: { outer: contourObj(outerRing), inner: contourObj(innerRing), result: annulusRes.annuli },
  segGeom,
  edgeEndMeta: { square: contourObj(square), results: eem },
  fatArc: [fatArc(0, 0, 5, 5, 10, 0), fatArc(0, 0, 5, 0.1, 10, 0)],
  ringSignedArea: ringSignedArea(square.map(s => s.p1)),
};
writeFileSync(new URL('../../csharp_tests/lb-parity/goldens/contour.json', import.meta.url), JSON.stringify(out));
console.log('emitted contour goldens: winding', Object.keys(winding).length, 'contours; arcs', Object.keys(arcs).length, '; annuli', annulusRes.annuli.length);
