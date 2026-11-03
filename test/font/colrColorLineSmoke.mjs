// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrColorLineSmoke.mjs — a COLR color line is defined over the interval from its least stop offset to its greatest (OpenType COLR), and
// the stop LUT stores [0, 1]. So a line off [0, 1] renormalizes and its gradient's geometry moves with it, the color at every point staying
// where the font put it; and the gradients the spec says must not be rendered reach the graph as nothing.
import { colrPaintToGraph, colorLineInterval } from '../../src/font/color/colrPaintToGraph.js';
import { packStopList } from '../../src/core/gradientStops.js';

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log('ok ' + msg);
  else {
    failures++;
    console.error('FAIL: ' + msg);
  }
};
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const stop = (offset, c) => ({ offset, paletteIndex: 0, alpha: 1, rgba: c });
const R = [1, 0, 0, 1],
  B = [0, 0, 1, 1];
const graphOf = (paint) => colrPaintToGraph(paint, {}).nodes[0];
const isNothing = (n) => n.type === 'PaintSolid' && n.params.rgba[3] === 0;

// The specification's own example interval: [0.2, 1.5] on a line from x = 0 to x = 100, so the first stop sits at x = 20, the last at x = 150.
const lin = graphOf({
  format: 4,
  stops: [stop(0.2, R), stop(1.5, B)],
  p0: [0, 0],
  p1: [100, 0],
  p2: [0, 100],
  extend: 0,
});
check(lin.type === 'PaintLinearGradient', 'a line on [0.2, 1.5] is a gradient');
check(
  near(lin.params.p0[0], 20) && near(lin.params.p1[0], 150),
  `the gradient's ends move to the interval's ends (x ${lin.params.p0[0]} to ${lin.params.p1[0]})`,
);
check(
  near(lin.params.p2[0] - lin.params.p0[0], 0) && near(lin.params.p2[1] - lin.params.p0[1], 100),
  "p2 keeps the gradient's direction",
);
check(
  near(lin.params.stops[0].offset, 0) && near(lin.params.stops[1].offset, 1),
  'its stops span [0, 1]',
);
// What the LUT stores of it: an offset above 1 clamps to 1, which ends the gradient at p1 and not at the last stop.
const packed = packStopList(lin.params.stops.map((s) => ({ offset: s.offset, color: s.rgba })));
check(
  packed.count === 2 || packed.count === -2,
  `the LUT adds no sentinel stop, so REPEAT's period is the interval (count ${packed.count})`,
);

const below = graphOf({
  format: 4,
  stops: [stop(-0.5, R), stop(0.5, B)],
  p0: [0, 0],
  p1: [100, 0],
  p2: [0, 100],
  extend: 1,
});
check(near(below.params.p0[0], -50) && near(below.params.p1[0], 50), 'a line below 0 too');
const inner = graphOf({
  format: 4,
  stops: [stop(0.25, R), stop(0.75, B)],
  p0: [0, 0],
  p1: [100, 0],
  p2: [0, 100],
  extend: 1,
});
check(
  near(inner.params.p0[0], 25) && near(inner.params.p1[0], 75),
  "REPEAT's period is the stops' interval, not [0, 1] with pad sentinels",
);

const rad = graphOf({
  format: 6,
  stops: [stop(0.5, R), stop(2, B)],
  c0: [0, 0],
  r0: 10,
  c1: [100, 0],
  r1: 30,
  extend: 0,
});
check(
  near(rad.params.c0[0], 50) &&
    near(rad.params.r0, 20) &&
    near(rad.params.c1[0], 200) &&
    near(rad.params.r1, 50),
  'a radial line takes the circles at its ends',
);
const sw = graphOf({
  format: 8,
  stops: [stop(0.5, R), stop(1.5, B)],
  center: [0, 0],
  startAngle: 0,
  endAngle: 180,
  extend: 0,
});
check(
  near(sw.params.startAngle, 90) && near(sw.params.endAngle, 270),
  'a sweep line takes the angles at its ends',
);

// A line already on [0, 1] is untouched: the same stops, the same points.
const same = [stop(0, R), stop(0.5, B), stop(1, R)];
const plain = graphOf({ format: 4, stops: same, p0: [1, 2], p1: [3, 4], p2: [5, 2], extend: 0 });
check(
  plain.params.stops === same &&
    plain.params.p0[0] === 1 &&
    plain.params.p1[1] === 4 &&
    plain.params.p2[0] === 5,
  'a [0, 1] line passes through bit for bit',
);

// One offset: two colors at pad, nothing at repeat or reflect.
const one = colorLineInterval([stop(0.5, R), stop(0.5, B)], 0);
check(
  one && near(one.stops[0].offset, 0) && near(one.stops[1].offset, 0) && one.lo === 0.5,
  'all stops at one offset under pad keep a hard edge there',
);
for (const extend of [1, 2])
  check(
    isNothing(
      graphOf({
        format: 4,
        stops: [stop(0.5, R), stop(0.5, B)],
        p0: [0, 0],
        p1: [1, 0],
        p2: [0, 1],
        extend,
      }),
    ),
    `all stops at one offset under extend ${extend} paint nothing`,
  );

// Ill-formed gradients.
const LINE = (p0, p1, p2) =>
  graphOf({ format: 4, stops: [stop(0, R), stop(1, B)], p0, p1, p2, extend: 0 });
check(isNothing(LINE([0, 0], [0, 0], [0, 1])), 'p1 = p0 paints nothing');
check(isNothing(LINE([0, 0], [1, 0], [0, 0])), 'p2 = p0 paints nothing');
check(isNothing(LINE([0, 0], [1, 0], [5, 0])), 'p2 on line p0p1 paints nothing');
check(
  isNothing(LINE([0, 0], [1e-5, 0], [5e-5, 0])) && !isNothing(LINE([0, 0], [1e-5, 0], [0, 1e-5])),
  'that test means the same at any scale',
);
check(!isNothing(LINE([0, 0], [1, 0], [1, 1])), 'a skewed p2 is well-formed');
for (const extend of [1, 2])
  check(
    isNothing(
      graphOf({
        format: 8,
        stops: [stop(0, R), stop(1, B)],
        center: [0, 0],
        startAngle: 90,
        endAngle: 90,
        extend,
      }),
    ),
    `a sweep of equal angles under extend ${extend} paints nothing`,
  );
check(
  !isNothing(
    graphOf({
      format: 8,
      stops: [stop(0, R), stop(1, B)],
      center: [0, 0],
      startAngle: 90,
      endAngle: 90,
      extend: 0,
    }),
  ),
  'under pad it is not ruled out',
);

if (failures) {
  console.error(`COLR-COLOR-LINE FAIL (${failures})`);
  process.exit(1);
}
console.log('COLR-COLOR-LINE PASS');
