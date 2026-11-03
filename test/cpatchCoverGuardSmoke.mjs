// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchCoverGuardSmoke — CPatch refuses a decomposition that cannot cover its shape.
//
// THE DEFECT CLASS. Loop-Blinn has a shape-level coverage guard: lbBuildCore.meshUnderCovers
// bounds a mesh's triangle area and refuses one under half the contour's, so a mesh that provably
// cannot cover its shape never draws. CPatch needs the equivalent, and its per-patch tests cannot
// stand in for one: validatePatch asks whether a patch admits territory outside its own loop and
// gridCheck compares a patch to THAT loop's spans, so a cut handing one side a loop with no interior
// yields a patch covering nothing and both tests pass it vacuously -- a 7-segment polygon can convert
// to 2 patches with every per-patch test clean and 55% of the shape unpainted.
//
// WHAT IS PINNED
//   refuses      a decomposition that reaches a fraction of its shape is refused, and the same
//                patches on the shape they DO decompose are not
//   opts out     a shape with too little interior to bound (a degenerate contour) is never refused.
//                The guard's contract is Loop-Blinn's: it fires on proof, never on absence of it
//   open         an OPEN subpath is filled AS IF CLOSED, so the guard has to close it before it
//                asks. Scored on the raw segments, tiger's #72 reads 89.3% of its interior missed
//                and 539% spilled; with the closing edge in, the same patches read 0.0% and 0.0%.
//                Seven of tiger's 298 shapes are open, and a guard that skipped this refuses them
//   rule         rowSpans is a NONZERO oracle and the even-odd region is a strict SUBSET of the
//                nonzero one, so an even-odd ring scored against nonzero spans is charged for its
//                own hole. The rule is a parameter, and this pins that passing it wrong refuses a
//                correct shape -- which is why coverageMiss and rowSpans carry it
//   inert        with the guard on, a healthy shape's packed wire is byte-identical to the guard
//                off. Over 1470 corpus shapes the guard refuses none, and it costs 1.043x on tiger's
//                conversion
const { packCPatchShape } = await import('../src/renderer/cpatchPack.js');
const { shapeUnderCovers } = await import('../src/renderer/cpatchCov.js');

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const _warn = console.warn;
console.warn = () => {};

// ---------------------------------------------------------------- geometry
const poly = (pts) => {
  const out = [];
  for (let i = 0; i < pts.length; i++)
    out.push({ t: 'line', P: [pts[i].slice(), pts[(i + 1) % pts.length].slice()] });
  return out;
};
const box = (x0, y0, x1, y1) =>
  poly([
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);
const boxCW = (x0, y0, x1, y1) =>
  poly([
    [x0, y0],
    [x0, y1],
    [x1, y1],
    [x1, y0],
  ]);
const convert = (contours, opts = {}) => {
  const patches = [];
  let m = null;
  try {
    m = packCPatchShape(contours, 0, {
      ...opts,
      onPatches: (a) => {
        for (const p of a) patches.push(p);
      },
    });
  } catch {
    m = null;
  }
  return { m, patches };
};

// ---------------------------------------------------------------- refuses
console.log('a decomposition that covers a fraction of its shape');
{
  // The patches of a small box, asked about a box nine times its area: the honest answer is that
  // they reach an eighth of it. Constructed rather than found, because the corpus has no such
  // decomposition -- which is the point of a guard.
  const small = box(0, 0, 100, 100);
  const big = box(0, 0, 300, 300);
  const { m, patches } = convert([small]);
  check(!!m && patches.length > 0, `the small box converts (${patches.length} patches)`);
  check(
    shapeUnderCovers([small], patches, false) === false,
    'the patches do not under-cover the box they decompose',
  );
  check(
    shapeUnderCovers([big], patches, false) === true,
    'the same patches under-cover a box nine times the area',
  );
  check(
    shapeUnderCovers([big], [], false) === true,
    'no patches at all under-covers a box with an interior',
  );
}

// ---------------------------------------------------------------- opts out
console.log('too little interior to bound is not a refusal');
{
  // A contour with no area: every sample is within half a pixel of the outline, nothing is left to
  // bound, and a guard that refused here would cost the engine over a measurement never taken.
  const hair = poly([
    [0, 0],
    [100, 0],
    [100, 0.0005],
    [0, 0.0005],
  ]);
  check(
    shapeUnderCovers([hair], [], false) === false,
    'a contour under a pixel across is never refused',
  );
  check(shapeUnderCovers([], [], false) === false, 'no contours is never refused');
  check(
    shapeUnderCovers(
      [
        [
          {
            t: 'line',
            P: [
              [0, 0],
              [10, 10],
            ],
          },
        ],
      ],
      [],
      false,
    ) === false,
    'a single segment that bounds nothing is never refused',
  );
}

// ---------------------------------------------------------------- open subpaths
console.log('an open subpath is filled as if closed, and the guard closes it');
{
  // Three sides of a square. The packer fills it as if closed and its patches cover that triangle-
  // topped region; a guard reading the raw segments sees a different region entirely.
  const open = [
    [
      {
        t: 'line',
        P: [
          [0, 0],
          [200, 0],
        ],
      },
      {
        t: 'line',
        P: [
          [200, 0],
          [200, 200],
        ],
      },
      {
        t: 'line',
        P: [
          [200, 200],
          [0, 200],
        ],
      },
    ],
  ];
  const { m, patches } = convert(open);
  check(!!m && patches.length > 0, `the open contour converts (${patches.length} patches)`);
  check(
    shapeUnderCovers(open, patches, false) === false,
    'the guard closes the contour and does not refuse it',
  );
}

// ---------------------------------------------------------------- the fill rule
console.log('the fill rule is a parameter, and the wrong one refuses a correct shape');
{
  // Two squares wound the same way: under even-odd the shape is the band between them, under
  // nonzero it is the whole outer square. A correct even-odd decomposition covers the band and
  // nothing else, so the nonzero oracle charges it for the hole -- 64% of the outer square here.
  const ring = [box(0, 0, 300, 300), box(30, 30, 270, 270)];
  const { m, patches } = convert(ring, { evenOdd: true });
  check(!!m && patches.length > 0, `the even-odd ring converts (${patches.length} patches)`);
  check(
    shapeUnderCovers(ring, patches, true) === false,
    'asked under even-odd, the ring is not refused',
  );
  check(
    shapeUnderCovers(ring, patches, false) === true,
    'asked under nonzero, the same ring IS refused (the hole reads as missed)',
  );
  // ...and a nonzero ring, whose hole is a hole because the inner contour runs the other way, is
  // the same shape under either rule and must be refused under neither.
  const nzRing = [box(0, 0, 300, 300), boxCW(30, 30, 270, 270)];
  const r2 = convert(nzRing, { evenOdd: false });
  check(
    !!r2.m && r2.patches.length > 0,
    `the nonzero ring converts (${r2.patches.length} patches)`,
  );
  check(shapeUnderCovers(nzRing, r2.patches, false) === false, 'the nonzero ring is not refused');
}

// ---------------------------------------------------------------- inert on healthy art
console.log('the guard changes no wire it does not refuse');
{
  const shapes = [
    [box(0, 0, 200, 120)],
    [
      poly([
        [0, 0],
        [160, 20],
        [200, 140],
        [60, 180],
        [10, 90],
      ]),
    ],
    [
      [
        {
          t: 'cubic',
          P: [
            [0, 0],
            [60, -80],
            [180, 80],
            [240, 0],
          ],
        },
        {
          t: 'cubic',
          P: [
            [240, 0],
            [180, 120],
            [60, 120],
            [0, 0],
          ],
        },
      ],
    ],
  ];
  let same = 0,
    moved = 0;
  for (const cs of shapes) {
    let a = null,
      b = null;
    try {
      a = packCPatchShape(cs, 0, { coverGuard: false });
    } catch {
      a = null;
    }
    try {
      b = packCPatchShape(cs, 0, { coverGuard: true });
    } catch {
      b = null;
    }
    const eq =
      !!a &&
      !!b &&
      a.texels.length === b.texels.length &&
      a.verts.length === b.verts.length &&
      a.texels.every((v, i) => v === b.texels[i]) &&
      a.verts.every((v, i) => v === b.verts[i]);
    if (eq) same++;
    else moved++;
  }
  check(
    moved === 0,
    `every healthy shape's wire is byte-identical with the guard on (${same} of ${shapes.length})`,
  );
}

console.warn = _warn;
if (fail) {
  console.log(`FAIL cpatchCoverGuardSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS cpatchCoverGuardSmoke');
