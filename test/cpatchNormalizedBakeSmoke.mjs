// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchNormalizedBakeSmoke — a contour converted in a NORMALIZED FRAME bakes and replays.
//
// WHY A FRAME. Every epsilon in cpatchConvert is absolute, so a contour a few units across would be
// judged by tolerances that are coarse relative to it while the same search sails through at another
// scale (a 14.7-unit blob blows the node budget unframed and converts to eleven patches framed). So
// every conversion is framed: the search runs in the contour's own frame, origin at its box corner and
// scale a power of two, and depends on the shape and not on where it sits.
//
// A trace records the cut LINES the search chose, in that frame, so replaying those coefficients
// against the caller's own geometry would cut in the wrong places; and a bake that skips such a
// contour converts it from scratch at full price, which a bake exists precisely to avoid (tiger,
// 3.4 s -> 0.11 s). So the trace opens with a `frame` record that carries nothing (the frame is a
// function of the curves, which the bake is keyed on exactly), and replayContour moves into the
// frame, replays and maps the patches back, so the replayed decomposition is the recorded one and
// not a near miss. The bake magic is 'CPT5'. A `norm` record (`{ op: 'norm', k, ox, oy }`, the
// explicit frame a 'CPT3' or 'CPT4' bake can hold) still replays, and a 'CPT2' bake still reads.
//
// WHAT IS PINNED
//   records      a conversion far from the origin and the tuned scale produces a trace, and it
//                starts with the frame
//   round-trips  encode -> decode -> replay reproduces the direct conversion's patches exactly,
//                control point for control point, in the CALLER's frame
//   bakes        packCPatchShape records an entry for such a shape and a build through that bake is
//                byte-identical to a build that searched
//   old bakes    a 'CPT2' bake still decodes, and a trace whose frame is a `norm` record replays
//   one byte     the frame record costs a byte, and every conversion carries it
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { convertContour, replayContour } from '../src/renderer/cpatchConvert.js';
import {
  encodeTrace,
  encodeTraceBake,
  decodeTraceBake,
  traceKeyHash,
} from '../src/renderer/cpatchTrace.js';
import { cpatchConvKey } from '../src/renderer/cpatchPack.js';

let fail = 0;
const check = (ok, msg) => {
  console.log(`  ${ok ? 'ok' : 'FAIL'} ${msg}`);
  if (!ok) fail++;
};
const _warn = console.warn;
console.warn = () => {};

const poly = (pts) => {
  const out = [];
  for (let i = 0; i < pts.length; i++)
    out.push({ t: 'line', P: [pts[i].slice(), pts[(i + 1) % pts.length].slice()] });
  return out;
};
/// Far from the tuned scale AND far from the origin: a blob a few units across at x = 20000 is the
/// shape of artwork the frame exists for, and the frame moves it furthest.
const blob = () => {
  const S = 3.1,
    X = 20000,
    Y = -8000;
  return [
    [
      {
        t: 'cubic',
        P: [
          [X, Y],
          [X + S, Y - S * 1.4],
          [X + S * 3, Y + S * 0.6],
          [X + S * 4, Y],
        ],
      },
      {
        t: 'cubic',
        P: [
          [X + S * 4, Y],
          [X + S * 3.2, Y + S * 1.7],
          [X + S * 1.1, Y + S * 2.2],
          [X, Y],
        ],
      },
    ],
  ];
};
const rect = () => [
  poly([
    [0, 0],
    [220, 0],
    [220, 160],
    [0, 160],
  ]),
];

const geomOf = (patches) =>
  patches
    .map((p) => p.curves.map((c) => c.t + ':' + c.P.map((q) => q.join(',')).join(' ')).join('|'))
    .sort()
    .join('\n');

// ---------------------------------------------------------------- the frame rides the trace
console.log('a framed conversion records its frame');
let trace = [],
  direct = null;
{
  const cs = blob();
  direct = convertContour(cs[0], { maxCurves: 8, trace });
  check(
    !!(direct && direct.patches && direct.patches.length),
    `the blob converts (${direct ? direct.patches.length : 0} patches)`,
  );
  check(
    trace.length > 1 && trace[0].op === 'frame',
    `the trace starts with the frame (${trace.length} records, first ${trace[0] && trace[0].op})`,
  );
  check(!trace.slice(1).some((r) => r.op === 'frame' || r.op === 'norm'), 'and carries it once');
}

// ---------------------------------------------------------------- round trip
console.log('the frame survives the codec, and the replay lands where the search did');
{
  const cs = blob();
  const bytes = encodeTrace(trace).done();
  // Through the BAKE, which is the path the renderer takes; decodeTrace alone wants a byte reader
  // the module does not export.
  const key = cpatchConvKey(cs[0], null);
  const map = new Map([[key, trace]]);
  const baked = decodeTraceBake(encodeTraceBake(map));
  const tr = baked.get(traceKeyHash(key));
  check(!!tr, `the bake holds the contour (${bytes.length} raw trace bytes)`);
  check(
    !!(tr && tr[0] && tr[0].op === 'frame'),
    'and the decoded trace still starts with the frame',
  );
  const stats = {};
  const rp = tr ? replayContour(cs[0], tr, { stats }) : null;
  check(
    !!(rp && rp.patches && rp.patches.length),
    `the replay produces patches (${rp ? rp.patches.length : 0}; ${stats.fail || 'no failure'})`,
  );
  check(
    !!rp && rp.patches.length === direct.patches.length,
    `the same number the search produced (${direct.patches.length})`,
  );
  check(
    !!rp && geomOf(rp.patches) === geomOf(direct.patches),
    "and the same geometry, control point for control point, in the caller's own frame",
  );
}

// ---------------------------------------------------------------- the packer bakes it
console.log('the packer records the contour, and a build through the bake matches');
{
  // the blob is a cubic lens, which the cycle certificate takes as one area paint (no search, no trace): this is about the search
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__CP_NO_CYCLE_AREA = 1;
  const cs = blob();
  const traceOut = new Map();
  let a = null;
  try {
    a = packCPatchShape(cs, 0, { maxCurves: 8, traceOut });
  } catch {
    a = null;
  }
  check(!!a, 'the shape packs');
  check(traceOut.size > 0, `and the bake gets an entry for it (${traceOut.size})`);
  const traces = decodeTraceBake(encodeTraceBake(traceOut));
  const st = {};
  let b = null;
  try {
    b = packCPatchShape(cs, 0, { maxCurves: 8, traces, traceStats: st });
  } catch {
    b = null;
  }
  check(!!b, 'and it packs again through the bake');
  const eq =
    !!a &&
    !!b &&
    a.texels.length === b.texels.length &&
    a.verts.length === b.verts.length &&
    a.texels.every((v, i) => v === b.texels[i]) &&
    a.verts.every((v, i) => v === b.verts[i]);
  check(eq, `the two wires are byte-identical (${JSON.stringify(st)})`);
  check(
    (st.hits | 0) > 0 && !(st.misfits | 0),
    `and the trace HIT rather than misfitting (${JSON.stringify(st)})`,
  );
  delete globalThis.__CP_NO_CYCLE_AREA;
  delete globalThis.__MANTLE_DEBUG__;
}

// ---------------------------------------------------------------- every conversion, one byte
console.log('every conversion is framed, for one byte');
{
  const t2 = [];
  const r = convertContour(rect()[0], { maxCurves: 8, trace: t2 });
  check(!!(r && r.patches && r.patches.length), 'the rectangle converts');
  check(t2.length > 0 && t2[0].op === 'frame', 'and its trace opens with the frame too');
  check(encodeTrace([{ op: 'frame' }]).done().length === 1, 'which is one byte');
  const bytes = encodeTraceBake(new Map([['k', t2]]));
  check(bytes[3] === 53, `and a bake is written as 'CPT5' ('CPT${String.fromCharCode(bytes[3])}')`);
}

console.log('an old bake still reads');
{
  // A CPT2 bake, byte for byte what the previous codec wrote for an empty map.
  const cpt2 = new Uint8Array([67, 80, 84, 50, 0]);
  let m = null,
    threw = null;
  try {
    m = decodeTraceBake(cpt2);
  } catch (e) {
    threw = e;
  }
  check(!!m && m.size === 0, `a 'CPT2' bake decodes (${threw ? threw.message : 'no throw'})`);
  let bad = null;
  try {
    decodeTraceBake(new Uint8Array([67, 80, 84, 49, 0]));
    bad = 'accepted';
  } catch {
    bad = 'refused';
  }
  check(bad === 'refused', "and a 'CPT1' bake is still refused");
  // A CPT3/CPT4 bake carries its frame as a `norm` record with the frame's numbers. The same frame
  // written that way replays to the same patches as the `frame` record.
  const cs = blob()[0];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const c of cs)
    for (const p of c.P) {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]);
      y1 = Math.max(y1, p[1]);
    }
  const ext = Math.max(x1 - x0, y1 - y0),
    E = Math.floor(Math.log2(ext)),
    mant = ext / 2 ** E;
  const k = 2 ** ((mant <= Math.SQRT2 ? 8 : 7) - E);
  const old = [{ op: 'norm', k, ox: x0, oy: y0 }, ...trace.slice(1)];
  const st = {};
  const rp = replayContour(cs, old, { stats: st });
  check(
    !!rp && geomOf(rp.patches) === geomOf(direct.patches),
    `a trace whose frame is a 'norm' record replays to the same patches (${st.fail || 'no failure'})`,
  );
}

console.warn = _warn;
if (fail) {
  console.log(`FAIL cpatchNormalizedBakeSmoke: ${fail} check(s)`);
  process.exit(1);
}
console.log('PASS cpatchNormalizedBakeSmoke');
