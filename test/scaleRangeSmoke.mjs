// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// scaleRangeSmoke -- the CPU half of the scale-range checks (scaleRangeRenderSmoke is the GPU half): art authored at
// 2^-20 .. 2^20 (and beyond, where a case says so) must import, serialize and resolve like the same art at scale 1.
//   *  the no-WebGL fallback's path data keeps its precision and its subpath breaks at any scale (an absolute 1e-4);
//   *  a huge stroke-miterlimit does not pad the cover box by that many half-widths (which makes the stroke vanish at 1e16);
//   *  a linear gradient whose endpoints differ by less than a float32 ulp is a (hard-step) vector, a zero one stays zero;
//   *  absolute epsilons: resolveSelfOverlap is canonicalized, the scene arc guard is relative.
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToPathD } from '../src/fallback/curveToPathD.js';
import * as reach from '../src/bundle/strokeReach.js';
const { strokeReachFactor, MAX_MITER_RATIO } = reach;
import { resolveSelfOverlap } from '../src/renderer/shapeResolve.js';
import { createScene, sceneToSvg, arcContour, arcSeg, rectContour } from '../src/scene/scene.js';

let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const check = (c, m) => (c ? ok(m) : fail(m));
const SVG = (inner, vb) =>
  '<' + 'svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb + '">' + inner + '</' + 'svg>';
const nums = (d) => (d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);

// ---- fallback path data at 2^-20, 2^-28, 2^20 vs the scale-1 path --------------------------------------------------------
{
  const TRI = (S) =>
    SVG(
      '<path d="M' +
        24 * S +
        ' ' +
        24 * S +
        ' L' +
        104 * S +
        ' ' +
        24 * S +
        ' L' +
        64 * S +
        ' ' +
        104 * S +
        'Z M' +
        50 * S +
        ' ' +
        50 * S +
        ' L' +
        78 * S +
        ' ' +
        50 * S +
        ' L' +
        64 * S +
        ' ' +
        74 * S +
        'Z" fill="red"/>',
      '0 0 ' + 128 * S + ' ' + 128 * S,
    );
  const dOf = async (S) => {
    const b = await importSvg(TRI(S), { preserveViewport: true });
    const r = b.curveRangesByShape[0];
    return curveRangeToPathD(new Float32Array(b.curves), r.begin, r.end);
  };
  const d1 = await dOf(1);
  for (const k of [-20, -28, 20]) {
    const S = 2 ** k,
      d = await dOf(S);
    const a = nums(d),
      b = nums(d1);
    let worst = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      worst = Math.max(worst, Math.abs(a[i] / S - b[i]));
    check(
      a.length === b.length &&
        (d.match(/M/g) || []).length === (d1.match(/M/g) || []).length &&
        worst < 1e-4,
      'fallback path data at 2^' +
        k +
        ': ' +
        a.length +
        ' numbers, ' +
        (d.match(/M/g) || []).length +
        ' subpaths, worst vertex error ' +
        worst.toExponential(2) +
        ' (units of 128)',
    );
  }
}

// ---- a huge miterlimit is no further reach than the largest ratio a join can have -------------------------------------------
{
  check(
    MAX_MITER_RATIO === 1e6,
    'the miter ratio ceiling is 1e6 (cos(phi/2) > 1e-6 in buildTexturesShape)',
  );
  for (const ml of [1e6, 1e16, 1e300, Infinity]) {
    const f = strokeReachFactor(0, ml);
    check(f === 1e6, 'strokeReachFactor(miter, ' + ml + ') = ' + f + ' (the ceiling)');
  }
  check(
    strokeReachFactor(0, 4) === 4 && strokeReachFactor(3, 1e300) === Math.sqrt(1e12 + 1),
    'an ordinary limit and miter-clip are unchanged / capped',
  );
  const PATH = 'M20 100 L60 20 L100 100';
  const bb = async (ml, S) => {
    const b = await importSvg(
      SVG(
        '<path d="' +
          PATH.replace(/\d+/g, (n) => +n * S) +
          '" fill="none" stroke="#c0392b" stroke-width="' +
          8 * S +
          '" stroke-miterlimit="' +
          ml +
          '"/>',
        '0 0 ' + 128 * S + ' ' + 128 * S,
      ),
      { preserveViewport: true },
    );
    return Array.from(new Float32Array(b.meta, 32, b.metaFloatsPerShape)); // the row after the 32-byte header
  };
  const finite = async (ml, S) => (await bb(ml, S)).every(Number.isFinite);
  check(
    (await finite(1e300, 1)) && (await finite(1e16, 1)),
    'the meta row of a 1e300 / 1e16 miterlimit stroke is finite',
  );
  const a = await bb(4, 1),
    c = await bb(1e300, 1);
  // The stroke's meta bbox (slots 0..3 hold the padded em box): the miterlimit-1e300 box reaches no further than the largest real ratio would.
  const ext = (r) => Math.max(r[2] - r[0], r[3] - r[1]);
  check(
    ext(c) < 1e8 * ext(a) && Number.isFinite(ext(c)),
    'the padded box of a 1e300 limit (' +
      ext(c).toExponential(2) +
      ') is finite and bounded by the 1e6 ceiling',
  );
}

// ---- endpoints that differ by less than a float32 ulp --------------------------------------------------------------------
{
  const G = (x1, x2) =>
    SVG(
      '<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="' +
        x1 +
        '" y1="0" x2="' +
        x2 +
        '" y2="0"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect width="128" height="128" fill="url(#g)"/>',
      '0 0 128 128',
    );
  const rec = async (x1, x2) => {
    const b = await importSvg(G(x1, x2), { preserveViewport: true });
    return Array.from(new Float32Array(b.gradients).subarray(12, 16)); // the first record's (x1, y1, x2, y2)
  };
  for (const [x1, x2] of [
    [64, 64 + 1e-6],
    [64, 64 - 1e-6],
    [64, 64 + 1e-9],
    [1e4, 1e4 + 1e-5],
  ]) {
    const r = await rec(x1, x2);
    check(
      r[0] !== r[2] && Math.sign(r[2] - r[0]) === Math.sign(x2 - x1),
      'endpoints ' +
        x1 +
        ' / ' +
        x2 +
        ' differ in the record (' +
        r[0] +
        ', ' +
        r[2] +
        '): a hard step, not the solid last stop',
    );
  }
  const z = await rec(64, 64);
  check(z[0] === z[2] && z[1] === z[3], 'an exactly zero-length vector stays zero (the last stop)');
  const t = await rec(0, 1e-20);
  check(t[0] !== t[2] && t[2] > 0, 'x1 = 0, x2 = 1e-20 stays a vector');
}

// ---- resolveSelfOverlap is scale-canonical; the scene arc guard is relative ---------------------------------------------------
{
  const line = (a, b) => ({ type: 0, p1: a, p2: b });
  const bow = (S) => [
    [
      line([0, 0], [2 * S, 2 * S]),
      line([2 * S, 2 * S], [2 * S, 0]),
      line([2 * S, 0], [0, 2 * S]),
      line([0, 2 * S], [0, 0]),
    ],
  ];
  const counts = [];
  for (const k of [0, -40, -20, 20, 40]) {
    const c = bow(2 ** k),
      out = resolveSelfOverlap(c, 'nonzero');
    counts.push(out === c ? -1 : out.reduce((n, x) => n + x.length, 0));
  }
  check(
    counts[0] > 0 && counts.every((n) => n === counts[0]),
    'resolveSelfOverlap cuts a bow tie the same at 2^0, +-20, +-40: ' + counts.join(' '),
  );

  const sceneWith = (m) => {
    const scene = createScene();
    scene.root.shapes.push({
      contours: [{ segments: [], closed: true }],
      fill: { kind: 'solid', color: [1, 0, 0, 1] },
    });
    scene.root.shapes[0].contours = [rectContour(0, 0, 10, 10)];
    scene.root.clipper = {
      transform: m,
      shapes: [
        {
          contours: [
            arcContour([
              arcSeg([1, 0], 1, 1, 0, false, true),
              arcSeg([-1, 0], 1, 1, 0, false, true),
            ]),
          ],
        },
      ],
    };
    return scene;
  };
  const throws = (m) => {
    try {
      sceneToSvg(sceneWith(m));
      return false;
    } catch (e) {
      return /non-uniform/.test(e.message);
    }
  };
  check(throws([1, 0, 0, 2, 0, 0]), 'a non-uniform clip transform throws at scale 1');
  check(
    throws([1e-8, 0, 0, 3e-8, 0, 0]),
    '... and at 1e-8 (an absolute 1e-7 would let it through as uniform)',
  );
  check(
    throws([1e-9 * 0.7071, 1e-9 * 0.7071, -1e-9 * 0.7071, 1e-9 * 0.7071, 0, 0]),
    '... a rotated arc clip at 1e-9 throws too',
  );
  check(
    !throws([1e-9, 0, 0, 1e-9, 0, 0]) && !throws([2, 0, 0, 2, 0, 0]),
    'a uniform clip transform is accepted at 1e-9 and 2',
  );
}

if (failures) {
  console.error('SCALE RANGE (CPU) FAIL (' + failures + ')');
  process.exit(1);
}
console.log('SCALE RANGE (CPU) PASS');
