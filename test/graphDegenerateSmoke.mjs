// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// graphDegenerateSmoke — the CPatch graph front end must never hang, whatever a contour contains.
//
// flattenGraph's pairwise intersectSegments DOES NOT RETURN on a zero-length quad: such a segment is
// a spike that doubles back along itself, so the pair is coincident rather than crossing and the
// solver allocates for a continuum it cannot enumerate. It dies of memory, and the main thread
// blocks until it does.
//
// Two properties are pinned here, and they pull in opposite directions:
//
//   * degenerate input must not hang — a zero-area segment is skipped before the intersector, since
//     it has no isolated crossing to contribute;
//   * legitimate input must not be skipped — a CUBIC with coincident endpoints is a real loop with
//     area, and a spike that is merely SMALL is ordinary geometry the intersector handles.
//
// It runs against the graph directly, with no browser, because the failure is CPU-side.
import { flattenGraph } from '../src/geom/cpatchGraph.js';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const BUDGET_MS = 2000; // the OOM case ran for tens of seconds; anything healthy is ~1 ms

const box = (extra) => [
  {
    t: 'line',
    P: [
      [0, 0],
      [100, 0],
    ],
  },
  ...extra,
  {
    t: 'line',
    P: [
      [100, 100],
      [0, 100],
    ],
  },
  {
    t: 'line',
    P: [
      [0, 100],
      [0, 0],
    ],
  },
];
const run = (name, contour, wantEdges) => {
  const t0 = Date.now();
  let g = null,
    err = null;
  try {
    g = flattenGraph([contour]);
  } catch (e) {
    err = ((e && e.message) || String(e)).slice(0, 60);
  }
  const ms = Date.now() - t0;
  if (err) {
    fail(`${name}: threw (${err})`);
    return;
  }
  if (ms > BUDGET_MS) {
    fail(`${name}: took ${ms} ms — the hang is back`);
    return;
  }
  if (wantEdges && (!g || !g.edges.length)) {
    fail(`${name}: produced no edges — over-skipped`);
    return;
  }
  ok(`${name}: ${ms} ms, ${g.edges.length} edges`);
};

// THE FAILURE THAT STARTED this, in the exact coordinates it occurred at. Not a synthetic stand-in:
// a hand-written "zero-length quad" with a distinct control point does NOT reproduce it, and a test
// built on one passed with the guard removed — worthless. What the asset actually carries is a quad
// whose THREE control points are identical, a literal point, followed by an ordinary cubic starting
// at that same point. Either segment alone flattens in 1 ms. Together, without the guard, the pair
// exhausts memory.
const COLLAPSED_PAIR = [
  {
    t: 'quad',
    P: [
      [213.94000000000003, 20.89999999999999],
      [213.94000000000003, 20.89999999999999],
      [213.94000000000003, 20.89999999999999],
    ],
  },
  {
    t: 'cubic',
    P: [
      [213.94000000000003, 20.89999999999999],
      [212.91000000000003, 20.179999999999993],
      [211.87000000000003, 19.499999999999993],
      [210.81000000000003, 18.84999999999999],
    ],
  },
];
run('collapsed quad meeting a cubic (the real case)', COLLAPSED_PAIR, false);

// The same pair inside a closed contour, which is how a caller actually presents it.
run(
  'the real case, closed',
  box([
    ...COLLAPSED_PAIR,
    {
      t: 'line',
      P: [
        [210.81000000000003, 18.84999999999999],
        [100, 100],
      ],
    },
  ]),
  true,
);

// A SPIKE is not the same thing and is handled by the intersector unaided — kept so the difference
// stays documented: a test that assumes they are the same cannot fail.
// The same shape with a zero-length LINE, which callers drop already but the graph must survive.
run(
  'zero-length line',
  box([
    {
      t: 'line',
      P: [
        [100, 0],
        [100, 0],
      ],
    },
    {
      t: 'line',
      P: [
        [100, 0],
        [100, 100],
      ],
    },
  ]),
  true,
);

// A fully collapsed cubic: all four control points equal.
run(
  'collapsed cubic',
  box([
    {
      t: 'cubic',
      P: [
        [100, 0],
        [100, 0],
        [100, 0],
        [100, 0],
      ],
    },
    {
      t: 'line',
      P: [
        [100, 0],
        [100, 100],
      ],
    },
  ]),
  true,
);

// NOT degenerate and must still be intersected: a cubic loop, P0 = P3 with real area between.
run(
  'cubic loop (must be kept)',
  box([
    {
      t: 'cubic',
      P: [
        [100, 0],
        [160, 40],
        [40, 40],
        [100, 0],
      ],
    },
    {
      t: 'line',
      P: [
        [100, 0],
        [100, 100],
      ],
    },
  ]),
  true,
);

// Ordinary coincidence, which the intersector handles and which must not be mistaken for the above.
run(
  'collinear doubling',
  [
    {
      t: 'line',
      P: [
        [0, 0],
        [100, 0],
      ],
    },
    {
      t: 'line',
      P: [
        [100, 0],
        [50, 0],
      ],
    },
    {
      t: 'line',
      P: [
        [50, 0],
        [100, 0],
      ],
    },
    {
      t: 'line',
      P: [
        [100, 0],
        [100, 100],
      ],
    },
    {
      t: 'line',
      P: [
        [100, 100],
        [0, 100],
      ],
    },
    {
      t: 'line',
      P: [
        [0, 100],
        [0, 0],
      ],
    },
  ],
  true,
);

// The guard is an epsilon test, so walk across it: a spike that is merely SMALL is real geometry.
for (const eps of [1e-12, 1e-9, 1e-8, 1e-4]) {
  run(
    `near-degenerate spike eps=${eps}`,
    box([
      {
        t: 'quad',
        P: [
          [100, 0],
          [110, 10],
          [100 + eps, 0],
        ],
      },
      {
        t: 'line',
        P: [
          [100 + eps, 0],
          [100, 100],
        ],
      },
    ]),
    true,
  );
}

console.log('\ngraphDegenerateSmoke: the graph front end terminates on degenerate input');
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
