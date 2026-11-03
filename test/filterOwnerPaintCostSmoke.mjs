// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Filter owner paint inputs cost nothing unless a graph names FillPaint/StrokePaint: a graph without
// them acquires exactly one target per node and leaves no paint scratch or context state behind; a graph with
// solid owner paints acquires one constant 1x1 target per distinct paint (not per use, not canvas-sized) and
// releases every one, including when a handler throws and when evaluations nest.
import assert from 'node:assert/strict';
import {
  evaluateGraph,
  SRC_GRAPHIC,
  SRC_FILL_PAINT,
  SRC_STROKE_PAINT,
} from '../src/filterGraph/filterGraph.js';
import {
  resolveInputTex,
  rectOf,
  texelOf,
  solidPaintOf,
  gradientPaintOf,
} from '../src/filterGraph/svgFilterShared.js';

const gl = new Proxy(
  {},
  {
    get: (_t, k) =>
      k === 'getError' ? () => 0 : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 1 : () => {},
  },
);
function makePool() {
  const live = new Set(),
    log = [];
  let next = 0;
  const targets = new Map();
  return {
    log,
    live,
    targets,
    ensureSize() {},
    acquire(w, h) {
      const i = next++;
      live.add(i);
      log.push([w, h]);
      targets.set(i, { tex: { i }, fbo: { i }, size: [w, h] });
      return i;
    },
    release(i) {
      assert(live.has(i), 'double release of ' + i);
      live.delete(i);
    },
    get: (i) => targets.get(i),
  };
}
const node = (type, ...inputs) => ({ type, inputs, params: {} });
const handlers = (probe) =>
  new Proxy({}, { get: (_t, type) => (n, inputs, out, ctx) => probe?.(n, inputs, out, ctx) });

// 1. No owner paint input: one acquire per node, no scratch, context untouched.
{
  const pool = makePool(),
    ctx = { gl, pool, fillPaint: 'keep', strokePaint: 'keep' };
  evaluateGraph(
    gl,
    { nodes: [node('feA', SRC_GRAPHIC), node('feB', 0)], rootOut: 1 },
    pool,
    handlers(),
    ctx,
    64,
    64,
  );
  assert.equal(pool.log.length, 2, 'one target per node');
  assert(!ctx._solidPaintRTs && !ctx._solidPaintRTIdx);
  assert.equal(ctx.fillPaint, 'keep');
  assert.equal(ctx.strokePaint, 'keep');
}

// 2. Solid owner paints: one constant target per distinct paint, however often it is read; infinite extent.
{
  const pool = makePool(),
    ctx = { gl, pool };
  const graph = {
    ownerPaints: { fill: [0, 1, 0, 1], stroke: [0, 0, 1, 0.5] },
    nodes: [
      node('feA', SRC_FILL_PAINT, SRC_FILL_PAINT),
      node('feB', SRC_STROKE_PAINT, 0),
      node('feC', SRC_FILL_PAINT, 1),
    ],
    rootOut: 2,
  };
  const seen = [];
  evaluateGraph(
    gl,
    graph,
    pool,
    handlers((n, inputs, out, c) => {
      for (const input of inputs)
        if (input.kind === 'source') {
          assert(solidPaintOf(input, c));
          assert(resolveInputTex(input, pool, c));
          assert.deepEqual(rectOf(input, c), [0, 0, Infinity, Infinity]);
          assert.deepEqual(texelOf(input, c), [0, 0]);
          seen.push(input.tag);
        }
    }),
    ctx,
    64,
    64,
  );
  const constants = pool.log.filter(([w, h]) => w === 1 && h === 1).length;
  assert.equal(constants, 2, 'fill and stroke each get one 1x1 target');
  assert.equal(pool.log.length, 3 + 2);
  assert.equal(ctx.fillPaint, undefined);
  assert(!ctx._solidPaintRTs && !ctx._solidPaintRTIdx);
  assert.equal(seen.length, 4);
}

// 3. A throwing handler and a nested evaluation release every scratch target.
{
  const pool = makePool(),
    ctx = { gl, pool };
  const graph = {
    ownerPaints: { fill: [1, 0, 0, 1], stroke: [0, 0, 0, 0] },
    nodes: [node('feA', SRC_FILL_PAINT)],
    rootOut: 0,
  };
  assert.throws(
    () =>
      evaluateGraph(
        gl,
        graph,
        pool,
        handlers((n, i, o, c) => {
          resolveInputTex(i[0], pool, c);
          throw new Error('boom');
        }),
        ctx,
        8,
        8,
      ),
    /boom/,
  );
  assert.equal(pool.live.size, 0, 'no target leaked after a throw');
  const outer = makePool(),
    octx = { gl, pool: outer };
  evaluateGraph(
    gl,
    graph,
    outer,
    handlers((n, i, o, c) => {
      const before = resolveInputTex(i[0], outer, c);
      evaluateGraph(
        gl,
        graph,
        outer,
        handlers((n2, i2, o2, c2) => resolveInputTex(i2[0], outer, c2)),
        c,
        8,
        8,
      );
      assert.equal(
        resolveInputTex(i[0], outer, c),
        before,
        'the outer paint target survives a nested evaluation',
      );
    }),
    octx,
    8,
    8,
  );
  assert.equal(outer.live.size, 2, 'the two roots remain live; every paint target is released');
}

// 4. Gradient owner paints (ctx.ownerPaint is the renderer's hook): one target per role, drawn at the hook's rect on first read and not before,
//    shared by every reader, released with the evaluation; a record the build cannot draw (no hook, frame unknown, no gradient row) reads as before.
{
  const grad = { kind: 'gradient', gradientId: 3, frameKnown: true };
  const drawn = [];
  const hook = {
    rect: () => [8, 4, 40, 24],
    draw: (paint, rt) => {
      drawn.push([paint.gradientId, rt.size.slice()]);
      return true;
    },
  };
  const pool = makePool(),
    ctx = { gl, pool, ownerPaint: hook };
  const graph = {
    ownerPaints: { fill: grad, stroke: [0, 0, 1, 1] },
    nodes: [
      node('feA', SRC_GRAPHIC),
      node('feB', SRC_FILL_PAINT, 0),
      node('feC', SRC_FILL_PAINT, 1),
    ],
    rootOut: 2,
  };
  let reads = 0;
  evaluateGraph(
    gl,
    graph,
    pool,
    handlers((n, inputs, out, c) => {
      if (n.type !== 'feB' && n.type !== 'feC') return;
      const input = inputs[0];
      assert(!solidPaintOf(input, c) && gradientPaintOf(input, c));
      assert.deepEqual(rectOf(input, c), [8, 4, 40, 24]);
      assert.deepEqual(texelOf(input, c), [1 / 40, 1 / 24]);
      assert(resolveInputTex(input, pool, c));
      reads++;
    }),
    ctx,
    64,
    64,
  );
  assert.equal(reads, 2);
  assert.equal(drawn.length, 1, 'both readers share one paint target');
  assert.deepEqual(drawn[0], [3, [40, 24]], "the target is the hook's rect");
  assert.equal(pool.log.filter(([w, h]) => w === 40 && h === 24).length, 1);
  assert(!ctx._solidPaintRTs && !ctx._solidPaintRTIdx);
  assert.equal(pool.live.size, 1, 'only the root is live');
  // nothing reads the paint: nothing is drawn
  const pool2 = makePool(),
    drawn2 = [];
  evaluateGraph(
    gl,
    {
      ownerPaints: { fill: grad, stroke: [0, 0, 0, 0] },
      nodes: [node('feA', SRC_GRAPHIC)],
      rootOut: 0,
    },
    pool2,
    handlers(),
    {
      gl,
      pool: pool2,
      ownerPaint: {
        rect: () => [0, 0, 8, 8],
        draw: () => {
          drawn2.push(1);
          return true;
        },
      },
    },
    16,
    16,
  );
  assert.equal(drawn2.length, 0, 'an unread paint costs nothing');
  // the unusable records
  const input = { kind: 'source', tag: SRC_FILL_PAINT };
  assert.equal(gradientPaintOf(input, { fillPaint: grad }), null, 'no hook: as before');
  assert.equal(
    gradientPaintOf(input, { fillPaint: { ...grad, frameKnown: false }, ownerPaint: hook }),
    null,
    'frame unknown: as before',
  );
  assert.equal(
    gradientPaintOf(input, { fillPaint: { ...grad, gradientId: 0 }, ownerPaint: hook }),
    null,
    'no gradient row: as before',
  );
  assert.equal(
    gradientPaintOf(input, { fillPaint: [0, 1, 0, 1], ownerPaint: hook }),
    null,
    'a solid paint is not a gradient',
  );
  // a failed draw reads transparent, and the target is still released
  const pool3 = makePool();
  evaluateGraph(
    gl,
    graph,
    pool3,
    handlers((n, inputs, out, c) => {
      if (n.type === 'feB') assert(resolveInputTex(inputs[0], pool3, c));
    }),
    { gl, pool: pool3, ownerPaint: { rect: () => [0, 0, 8, 8], draw: () => false } },
    64,
    64,
  );
  assert.equal(pool3.live.size, 1);
}
console.log('filterOwnerPaintCostSmoke PASS');
