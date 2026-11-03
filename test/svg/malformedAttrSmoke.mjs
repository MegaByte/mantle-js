// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// malformedAttrSmoke.mjs — a malformed geometry attribute must not produce
// non-finite values.
//
// Three attributes parse into numbers that everything downstream trusts: a
// path's `d`, an element's `transform`, and a polygon/polyline `points`. Emitting NaN
// when they run short spreads it — into the segment, the shape bbox, and (when nothing
// valid remains) the bundle's globalBBox, which the renderer divides by. The asset
// would then draw nothing, with no error anywhere. A bad `transform` is the worse of
// the two: it NaNs the element AND its entire subtree.
//
// SVG 1.1 §8.3.9 says a path with an error renders UP TO the error, and the
// parsers follow that rule, so a valid prefix still renders and positions.
//
// GL-free (fast node lane).

import { parsePathD } from '../../src/svg/path.js';
import { parseTransform } from '../../src/svg/transform.js';
import { DOMParser as DP } from '@xmldom/xmldom';
import * as shapeMod from '../../src/svg/shape.js';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const hasNonFinite = (segs) => {
  const walk = (v) => {
    if (typeof v === 'number') return !Number.isFinite(v);
    if (Array.isArray(v)) return v.some(walk);
    if (v && typeof v === 'object') return Object.values(v).some(walk);
    return false;
  };
  return segs.some(walk);
};

// ---- T1: every truncated command yields finite geometry ----------------
{
  const truncated = [
    'M 10 20 L 30', // line missing y
    'M 10 10 C 20 20 30', // cubic missing 3 numbers
    'M 5 5 Q 9', // quad missing 3
    'M 1 1 A 5 5 0 0 1', // arc missing the endpoint
    'M 1 1 H', // horizontal missing x
    'M 1 1 V', // vertical missing y
    'M 3 3 S 4 4 5', // smooth cubic missing y
    'M 3 3 T', // smooth quad missing both
    'M', // moveto with nothing
    'M 0 0 L 1 1 L 2', // valid prefix, truncated tail
  ];
  const bad = truncated.filter((d) => hasNonFinite(parsePathD(d)));
  if (!bad.length) ok(`T1 ${truncated.length} truncated paths all produce finite geometry`);
  else fail(`T1 non-finite coords from: ${JSON.stringify(bad)}`);
}

// ---- T2: what parsed before the error is KEPT --------------------------
// Truncating must not discard the valid prefix — that is the difference
// between "renders up to the error" and "renders nothing".
{
  const segs = parsePathD('M 0 0 L 10 10 L 20 20 L 30');
  if (segs.length === 2) ok('T2 the valid prefix survives (2 of 3 lines kept)');
  else fail(`T2 expected 2 segments before the error, got ${segs.length}`);
  const last = segs[segs.length - 1];
  if (last && last.p2 && last.p2[0] === 20 && last.p2[1] === 20)
    ok('T2b the kept prefix is the authored geometry, not a repaired guess');
  else fail(`T2b prefix geometry wrong: ${JSON.stringify(last)}`);
}

// ---- T3: valid paths are untouched -------------------------------------
// The guard must not change a single well-formed path, including the awkward
// ones — glued arc flags, implicit repeats, scientific notation.
{
  const valid = [
    ['M 0 0 L 10 10 L 20 5', 2],
    ['M 0 0 C 1 1 2 2 3 3 Z', 2],
    ['M 0 0 10 10 20 20', 2], // implicit lineto after M
    ['m 0 0 l 5 5 l 5 -5 z', 3],
    ['M 0 0 A 5 5 0 0110 10', 1], // flags glued to the number
    ['M 0 0 L 1e2 1E-2', 1], // scientific notation
    ['M 0 0 Q 1 1 2 2 T 4 4', 2],
    ['M 0 0 L 5 5 Z M 10 10 L 15 15 Z', 4], // two subpaths, both closed
  ];
  const wrong = valid.filter(([d, n]) => parsePathD(d).length !== n);
  if (!wrong.length)
    ok(`T3 ${valid.length} well-formed paths parse to the expected segment counts`);
  else {
    for (const [d, n] of wrong)
      fail(`T3 ${JSON.stringify(d)} expected ${n}, got ${parsePathD(d).length}`);
  }
}

// ---- T4: subpath markers survive truncation ----------------------------
// The authored-subpath marker is what keeps two touching subpaths distinct;
// a truncated tail must not cost the earlier subpaths theirs.
{
  const segs = parsePathD('M 0 0 L 5 5 Z M 10 10 L 15 15 L 20');
  const starts = segs.filter((s) => s.subStart === true).length;
  if (starts === 2) ok('T4 both authored subpath starts are still marked');
  else fail(`T4 expected 2 subStart markers, got ${starts}`);
}

// ---- T5: no transform attribute yields a non-finite matrix -------------
{
  const malformed = [
    'translate()',
    'scale()',
    'rotate()',
    'skewX()',
    'skewY()',
    'matrix(1,2,3)',
    'matrix()',
    'translate(5 5) scale()',
    'rotate(45 10)',
    'scale(2) matrix(1,2)',
    'translate(,)',
  ];
  const bad = malformed.filter((t) => parseTransform(t).some((v) => !Number.isFinite(v)));
  if (!bad.length) ok(`T5 ${malformed.length} malformed transforms all yield finite matrices`);
  else fail(`T5 non-finite matrix from: ${JSON.stringify(bad)}`);
}

// ---- T6: a transform list with an error anywhere is ignored -----------
// The list is one value: an error makes the attribute invalid (CSS Transforms 1 §6), so the element is untransformed
// rather than moved by the part before the error.
{
  const m = parseTransform('translate(5 7) scale()');
  if (m.every((v, i) => v === [1, 0, 0, 1, 0, 0][i]))
    ok('T6 a malformed function anywhere makes the whole transform the identity');
  else fail(`T6 expected the identity, got ${JSON.stringify(m)}`);
}

// ---- T7: well-formed transforms are unchanged ---------------------------
{
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const checks = [
    ['translate(10 20)', (m) => near(m[4], 10) && near(m[5], 20)],
    ['scale(2)', (m) => near(m[0], 2) && near(m[3], 2)], // sy defaults to sx
    ['scale(2 3)', (m) => near(m[0], 2) && near(m[3], 3)],
    ['translate(10,)', (m) => near(m[4], 10) && near(m[5], 0)], // trailing comma, ty = 0
    ['translate(1 2 3)', (m) => near(m[4], 0) && near(m[5], 0)], // too many arguments: the whole value is invalid
    ['matrix(1,0,0,1,4,5)', (m) => near(m[4], 4) && near(m[5], 5)],
    ['rotate(90)', (m) => near(m[0], 0) && near(m[1], 1)],
    // Composition order: leftmost is outermost, so this scales THEN translates
    // in local space — tx ends up scaled by 2.
    ['scale(2) translate(5)', (m) => near(m[0], 2) && near(m[4], 10)],
  ];
  const wrong = checks.filter(([t, f]) => !f(parseTransform(t)));
  if (!wrong.length)
    ok(`T7 ${checks.length} well-formed transforms unchanged (incl. composition order)`);
  else
    for (const [t] of wrong)
      fail(`T7 ${JSON.stringify(t)} -> ${JSON.stringify(parseTransform(t))}`);
}

// ---- T8: polygon/polyline `points` stops at the first error ------------
// SVG processes the points list UP TO the first error: an odd count and a
// non-numeric token both end it, with no NaN endpoints.
{
  globalThis.DOMParser = globalThis.DOMParser || DP;
  const toSegs =
    shapeMod.shapeToSegs ||
    shapeMod.default ||
    Object.values(shapeMod).find((v) => typeof v === 'function');
  const parse = (tag, pts) => {
    const d = new DP().parseFromString(
      `<svg xmlns="http://www.w3.org/2000/svg"><${tag} points="${pts}"/></svg>`,
      'image/svg+xml',
    );
    return toSegs(d.documentElement.getElementsByTagName(tag)[0], {});
  };
  const bad = [
    ['polygon', '10,10 20,abc 30,30'],
    ['polygon', 'x,y'],
    ['polyline', '0,0 nope 5,5'],
    ['polygon', '1,1 2,2 3'],
  ].filter(([t, p]) => hasNonFinite(parse(t, p)));
  if (!bad.length) ok('T8 malformed `points` never yields NaN endpoints');
  else fail(`T8 non-finite from: ${JSON.stringify(bad)}`);

  const good = [
    ['polygon', '10,10 20,20 30,30', 3],
    ['polyline', '0,0 5,5 10,10', 2],
    ['polyline', '0,0 1,1', 1],
  ];
  const wrong = good.filter(([t, p, n]) => parse(t, p).length !== n);
  if (!wrong.length) ok('T8b well-formed polygons/polylines are unchanged');
  else
    for (const [t, p, n] of wrong) fail(`T8b ${t} "${p}" expected ${n}, got ${parse(t, p).length}`);
}

console.log();
console.log(failures === 0 ? 'MALFORMED-ATTR PASS' : `MALFORMED-ATTR FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
