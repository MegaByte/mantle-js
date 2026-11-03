// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterBboxReachSmoke.mjs — a filter node's RT must be big enough to hold
// everything the kernel can write.
//
// computeNodeBboxes sizes each node's render target. Undersize it and the
// output is silently truncated at the RT edge — no error, just a filter that
// stops early, which is exactly the kind of thing that gets mistaken for the
// filter "looking right" on centerd kernels and wrong on nothing anyone tests.
//
// Dilating feConvolveMatrix by floor(order/2) assumes the kernel is centerd.
// targetX/targetY move it, and both the importer and the shader
// honor them (convolve.frag.glsl samples in[x + i - target]), so the reach is
// asymmetric and floor(order/2) is too small on one side.
//
// The reference below is derived from the SHADER's sampling rule rather than
// restating the formula in bbox.js: for every output pixel, work out which
// input pixels it reads, and require the bbox to contain every output that can
// read a live input. That way the test fails if either side drifts from the
// other.
//
// GL-free (fast node lane).

import { computeNodeBboxes } from '../../src/filterGraph/bbox.js';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const CANVAS = 200;
const SRC = { x: 80, y: 80, w: 20, h: 20 };

const convolveGraph = (params) => ({
  nodes: [{ type: 'feConvolveMatrix', inputs: [-1], params }],
  rootOut: 0,
});

// What the shader actually does, per convolve.frag.glsl:
//   out(x) = sum over i in [0, order)  of  in[x + i - target]
// So out(x) reads in[x - target .. x - target + order - 1]. An output pixel is
// live if any input pixel it reads is inside the source bbox.
function shaderLiveSpan(lo, hi, order, target) {
  let minOut = Infinity,
    maxOut = -Infinity;
  for (let x = -CANVAS; x < 2 * CANVAS; x++) {
    for (let i = 0; i < order; i++) {
      const src = x + i - target;
      if (src >= lo && src <= hi) {
        if (x < minOut) minOut = x;
        if (x > maxOut) maxOut = x;
        break;
      }
    }
  }
  return [minOut, maxOut];
}

// ---- T1: centerd kernels are unchanged ---------------------------------
// The asymmetric reach must not re-size the common case; a change here is a
// silent fillrate cost on every existing filter.
{
  const bad = [];
  for (const order of [1, 2, 3, 4, 5]) {
    const target = Math.floor(order / 2);
    const { bboxes } = computeNodeBboxes(
      convolveGraph({ orderX: order, orderY: order, targetX: target, targetY: target }),
      SRC,
      CANVAS,
      CANVAS,
    );
    const want = Math.floor(order / 2);
    const gotPad = SRC.x - bboxes[0].x;
    if (gotPad !== want) bad.push(`order ${order}: pad ${gotPad}, want ${want}`);
  }
  if (!bad.length) ok('T1 centerd kernels allocate exactly floor(order/2) as before');
  else for (const b of bad) fail(`T1 ${b}`);
}

// ---- T2: off-center kernels contain the shader's whole output ----------
{
  const bad = [];
  let checked = 0;
  for (let order = 1; order <= 5; order++) {
    for (let target = 0; target < order; target++) {
      const { bboxes } = computeNodeBboxes(
        convolveGraph({ orderX: order, orderY: order, targetX: target, targetY: target }),
        SRC,
        CANVAS,
        CANVAS,
      );
      const bb = bboxes[0];
      const [loOut, hiOut] = shaderLiveSpan(SRC.x, SRC.x + SRC.w - 1, order, target);
      checked++;
      if (bb.x > loOut || bb.x + bb.w - 1 < hiOut) {
        bad.push(
          `order ${order} target ${target}: bbox x [${bb.x}, ${bb.x + bb.w - 1}] ` +
            `truncates shader output [${loOut}, ${hiOut}]`,
        );
      }
    }
  }
  if (checked !== 15) fail(`T2 checked ${checked} combinations, expected 15 — enumeration broke`);
  else if (!bad.length) ok(`T2 all ${checked} order/target combinations fit the shader's output`);
  else for (const b of bad) fail(`T2 ${b}`);
}

// ---- T3: the extreme target, the one a centered dilation truncates ------
// order 5, target 0 reaches 4px in one direction; floor(5/2) = 2 gave half of
// it. Called out on its own so a failure names the case.
{
  const { bboxes } = computeNodeBboxes(
    convolveGraph({ orderX: 5, orderY: 5, targetX: 0, targetY: 0 }),
    SRC,
    CANVAS,
    CANVAS,
  );
  const pad = SRC.x - bboxes[0].x;
  if (pad >= 4) ok(`T3 order-5 target-0 kernel gets its full 4px reach (pad ${pad})`);
  else fail(`T3 order-5 target-0 padded by ${pad}, needs 4 — output would be truncated`);
}

// ---- T4: a malformed target cannot blow up the RT -----------------------
// Out-of-range targets are a spec error; the bbox must stay bounded rather
// than scaling an allocation by a garbage index.
{
  const { bboxes } = computeNodeBboxes(
    convolveGraph({ orderX: 3, orderY: 3, targetX: 9999, targetY: -9999 }),
    SRC,
    CANVAS,
    CANVAS,
  );
  const bb = bboxes[0];
  if (bb.w <= CANVAS && bb.h <= CANVAS && bb.w > 0 && bb.h > 0) {
    ok(`T4 out-of-range target stays bounded (${bb.w}x${bb.h})`);
  } else {
    fail(`T4 out-of-range target produced a ${bb.w}x${bb.h} bbox`);
  }
}

// ---- T5: missing params still work -------------------------------------
// Nodes reaching bbox without an explicit target must fall back to centerd,
// not to NaN (which would poison the clamp and yield a 0-size RT).
{
  const { bboxes } = computeNodeBboxes(
    convolveGraph({ orderX: 3, orderY: 3 }),
    SRC,
    CANVAS,
    CANVAS,
  );
  const bb = bboxes[0];
  if (Number.isFinite(bb.x) && bb.w === SRC.w + 2 && bb.h === SRC.h + 2) {
    ok('T5 absent targetX/targetY default to a centerd kernel');
  } else {
    fail(`T5 absent target gave {x:${bb.x}, w:${bb.w}, h:${bb.h}}, want ${SRC.w + 2}x${SRC.h + 2}`);
  }
}

console.log();
console.log(failures === 0 ? 'FILTER-BBOX-REACH PASS' : `FILTER-BBOX-REACH FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
