// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// primitiveStartPointSmoke.mjs — <circle>, <ellipse> and <rect> start their contour where SVG says.
//
// SVG 2 (shapes, "Basic shapes" path equivalents) starts a circle/ellipse at (cx + rx, cy) and runs clockwise on
// screen, through (cx, cy + ry); a rect starts at (x + rx, y) (the top-left corner when rx = ry = 0) and runs along
// +x first. The start point owns the dash phase (stroke-dasharray, stroke-dashoffset) and the point pairing of a
// morph, so a primitive that starts elsewhere draws shifted dashes: shape.js began the circle at angle -PI,
// (cx - rx, cy), and a dashed circle came out half a circumference out of phase with Chrome (edge
// error 70.8, 3115 wrong px at 512, where the same circle as a path scored 0.3).
//
// The arc is checked as geometry, from its own angles, so the test does not depend on how the renderer draws it:
// p1/p4 and the point a quarter of the way along the sweep must be the spec's, the sweep must run +x -> +y.

import { parseShape } from '../src/svg/shape.js';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('  ok ' + m);
const el = (tagName, attrs) => ({
  tagName,
  getAttribute: (k) => (k in attrs ? String(attrs[k]) : null),
});
// A 1-ulp-scale check, relative to the radius: the points are exact, only cos/sin of a quarter turn round.
const near = (a, b, scale) => Math.abs(a - b) <= 4 * Number.EPSILON * Math.max(1, Math.abs(scale));
const nearPt = (p, q, scale) => near(p[0], q[0], scale) && near(p[1], q[1], scale);
const at = (s, t) => {
  // point at fraction t of the arc's own sweep (phi = 0)
  const th = s.theta_start + (s.theta_end - s.theta_start) * t;
  return [s.cx + s.rx * Math.cos(th), s.cy + s.ry * Math.sin(th)];
};

for (const [name, e, cx, cy, rx, ry] of [
  ['circle', el('circle', { cx: 30, cy: 30, r: 22 }), 30, 30, 22, 22],
  [
    'circle off-origin',
    el('circle', { cx: 1234.5, cy: -77.25, r: 0.125 }),
    1234.5,
    -77.25,
    0.125,
    0.125,
  ],
  ['ellipse', el('ellipse', { cx: 50, cy: 40, rx: 35, ry: 20 }), 50, 40, 35, 20],
]) {
  const segs = parseShape(e);
  if (segs.length !== 1) {
    fail(`${name}: ${segs.length} segments, expected one arc`);
    continue;
  }
  const s = segs[0];
  const scale = Math.max(Math.abs(cx), Math.abs(cy), rx, ry);
  const sweep = s.theta_end - s.theta_start;
  if (!nearPt(s.p1, [cx + rx, cy], scale))
    fail(`${name}: starts at (${s.p1}), spec says (${cx + rx}, ${cy})`);
  else ok(`${name}: starts at (cx + rx, cy)`);
  if (!nearPt(s.p4, [cx + rx, cy], scale))
    fail(`${name}: ends at (${s.p4}), a full turn ends on its start`);
  if (!(s.sweep_flag === 1 && near(sweep, 2 * Math.PI, 1)))
    fail(`${name}: sweep ${sweep} flag ${s.sweep_flag}, expected +2PI clockwise`);
  if (!nearPt(at(s, 0.25), [cx, cy + ry], scale))
    fail(
      `${name}: a quarter along is (${at(s, 0.25)}), clockwise on screen reaches (${cx}, ${cy + ry})`,
    );
  else ok(`${name}: runs clockwise on screen (start, then +y)`);
  if (!nearPt(at(s, 0.5), [cx - rx, cy], scale))
    fail(`${name}: half way is (${at(s, 0.5)}), expected (${cx - rx}, ${cy})`);
}

const end = (g) => g.p4 || g.p2; // a line carries p1/p2, an arc p1/p4
{
  // rect: sharp starts at (x, y) along +x; rounded starts at (x + rx, y) along +x, then the top-right arc
  const sharp = parseShape(el('rect', { x: 10, y: 20, width: 30, height: 40 }));
  if (!(
    sharp[0].p1[0] === 10 &&
    sharp[0].p1[1] === 20 &&
    end(sharp[0])[0] === 40 &&
    end(sharp[0])[1] === 20
  ))
    fail('rect: first edge is not (x,y) -> (x+w,y)');
  else if (!(end(sharp[1])[0] === 40 && end(sharp[1])[1] === 60))
    fail('rect: second edge is not down the right side');
  else ok('rect: (x,y) -> (x+w,y) -> (x+w,y+h) clockwise');
  const round = parseShape(el('rect', { x: 10, y: 20, width: 30, height: 40, rx: 5, ry: 6 }));
  if (!(
    round[0].p1[0] === 15 &&
    round[0].p1[1] === 20 &&
    end(round[0])[0] === 35 &&
    end(round[0])[1] === 20
  ))
    fail('rounded rect: first edge is not (x+rx,y) -> (x+w-rx,y)');
  else if (!(round[1].p1[0] === 35 && end(round[1])[0] === 40 && end(round[1])[1] === 26))
    fail('rounded rect: second piece is not the top-right corner arc');
  else ok('rounded rect: starts (x+rx, y), top edge first, then the top-right corner');
}

if (failures) {
  console.error(`primitiveStartPointSmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log('primitiveStartPointSmoke: PASS');
