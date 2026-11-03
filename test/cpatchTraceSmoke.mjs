// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Exercise the retained seam decomposition; complete-paint area is checked separately.
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__CP_NO_AREA = 1;
// cpatchTraceSmoke — the CPatch PREBAKE: the search's decision trace, replayed without the search.
//
// A converted contour's real output is a sequence of decisions -- which branch, which curve,
// which constructed candidate at each node -- and replaying those on the same geometry rebuilds
// the decomposition with no scoring, validation or leak test. The bake is therefore a few bytes
// per patch rather than the patch geometry, and a build from it is bit-identical.
//
// What this pins:
//   T1  convertContour(trace) -> replayContour reproduces the patches exactly (every control
//       point, seam flag and weight), on shapes that take line cuts, curve cuts, subdivision
//       and the terminal decomposition
//   T2  through the packer: traceOut on one build, encode -> decode, traces on the next; the
//       texel and vertex streams are byte-identical, and the graph front end's cuts bake too
//   T3  a bake that does not fit the geometry (recorded on another pose) is refused or
//       desyncs into a fallback, never a wrong decomposition: the build equals a plain build
import { convertContour, replayContour } from '../src/renderer/cpatchConvert.js';
import { packCPatchShape } from '../src/renderer/cpatchPack.js';
import { encodeTraceBake, decodeTraceBake } from '../src/renderer/cpatchTrace.js';

let pass = 0,
  fail = 0;
const ok = (m) => {
  console.log('ok ' + m);
  pass++;
};
const bad = (m) => {
  console.log('FAIL ' + m);
  fail++;
};

const line = (a, b) => ({ t: 'line', P: [a, b] });
const cubic = (a, b, c, d) => ({ t: 'cubic', P: [a, b, c, d] });
const quad = (a, b, c) => ({ t: 'quad', P: [a, b, c] });
// A circle of radius r about (cx, cy) as four cubics (the usual kappa), direction by `dir`.
const circle = (cx, cy, r, dir = 1) => {
  const k = 0.5522847498 * r,
    out = [];
  const pts = [
    [cx + r, cy],
    [cx, cy + r],
    [cx - r, cy],
    [cx, cy - r],
  ];
  const tan = [
    [0, k],
    [-k, 0],
    [0, -k],
    [k, 0],
  ];
  for (let i = 0; i < 4; i++) {
    const a = pts[i],
      b = pts[(i + 1) % 4],
      ta = tan[i],
      tb = tan[(i + 1) % 4];
    out.push(cubic(a, [a[0] + ta[0], a[1] + ta[1]], [b[0] - tb[0], b[1] - tb[1]], b));
  }
  if (dir < 0) return out.reverse().map((c) => ({ t: 'cubic', P: c.P.slice().reverse() }));
  return out;
};
const claw = [
  cubic([-122.3, 84.29], [-122.3, 84.29], [-122.2, 86.18], [-123.03, 86.16]),
  cubic([-123.03, 86.16], [-123.85, 86.14], [-140.3, 38.07], [-160.83, 40.31]),
  cubic([-160.83, 40.31], [-160.83, 40.31], [-143.05, 32.96], [-122.3, 84.29]),
];
// A wavy blob: mixed curve types, concavities, cubic bulges.
const blob = [
  cubic([0, 0], [30, -40], [70, 40], [100, 0]),
  quad([100, 0], [130, 30], [100, 60]),
  cubic([100, 60], [60, 90], [40, 20], [0, 60]),
  line([0, 60], [-20, 30]),
  line([-20, 30], [0, 0]),
];
// A figure-eight: one self-crossing path the graph front end has to split.
const eight = [
  cubic([0, 0], [60, -60], [60, 60], [0, 0]),
  cubic([0, 0], [-60, -60], [-60, 60], [0, 0]),
];
// A pentagram: five lines crossing each other.
const star = (() => {
  const p = [];
  for (let i = 0; i < 5; i++) {
    const a = Math.PI / 2 + (i * 2 * Math.PI * 2) / 5;
    p.push([50 * Math.cos(a), 50 * Math.sin(a)]);
  }
  return p.map((q, i) => line(q, p[(i + 1) % 5]));
})();
const shapes = {
  claw: [claw],
  blob: [blob],
  ring: [circle(0, 0, 50), circle(0, 0, 25, -1)], // a hole
  eight: [eight],
  star: [star],
};

// ---- fingerprint of a patch set: every number that reaches the packer ----
const f64 = new Float64Array(1),
  u32 = new Uint32Array(f64.buffer);
const fingerprint = (patches) => {
  let h = 2166136261 >>> 0;
  const mix = (v) => {
    f64[0] = v;
    h = Math.imul(h ^ u32[0], 16777619) >>> 0;
    h = Math.imul(h ^ u32[1], 16777619) >>> 0;
  };
  for (const p of patches) {
    mix(p.curves.length);
    for (const c of p.curves) {
      mix(c.P.length);
      for (const q of c.P) {
        mix(q[0]);
        mix(q[1]);
      }
      if (c.w != null) mix(c.w);
      mix(c.cut ? 1 : 0);
    }
  }
  return h.toString(16);
};

// ---- T1: convert with a trace, replay, compare ----
{
  const ops = new Set();
  for (const [name, cs] of Object.entries(shapes)) {
    const contour = cs[0];
    const trace = [];
    let r = null;
    try {
      r = convertContour(contour, { maxCurves: 8, tolPx: 0.05, trace });
    } catch (e) {
      r = null;
    }
    if (!r) {
      if (name === 'eight' || name === 'star') continue;
      bad(`T1 ${name}: convertContour refused`);
      continue;
    } // self-crossing raw contours are the graph's job
    for (const t of trace) ops.add(t.op);
    let rr = null;
    try {
      rr = replayContour(contour, trace, {});
    } catch (e) {
      rr = null;
    }
    if (!rr) {
      bad(`T1 ${name}: replay failed`);
      continue;
    }
    if (
      rr.patches.length === r.patches.length &&
      fingerprint(rr.patches) === fingerprint(r.patches)
    )
      ok(
        `T1 ${name}: replay reproduces ${r.patches.length} patches exactly from ${trace.length} records`,
      );
    else bad(`T1 ${name}: replay differs (${rr.patches.length} vs ${r.patches.length} patches)`);
  }
  // The two decision families (a constructed line, a curve's extension) and the keep; the
  // fallbacks (own line, chord, subdivide, terminal, resolve) depend on which shapes need them.
  const want = ['keep', 'line', 'curve'];
  const seen = want.filter((o) => ops.has(o));
  if (seen.length === want.length) ok(`T1 the shapes exercised ${[...ops].sort().join(', ')}`);
  else
    bad(
      `T1 the shapes only exercised ${[...ops].sort().join(', ')} -- missing ${want.filter((o) => !ops.has(o)).join(', ')}`,
    );
}

// ---- T2: through the packer, via the byte form ----
const same = (a, b) =>
  a &&
  b &&
  a.texels.length === b.texels.length &&
  a.verts.length === b.verts.length &&
  a.texels.every((v, k) => v === b.texels[k]) &&
  a.verts.every((v, k) => v === b.verts[k]);
const bakes = {};
{
  for (const [name, cs] of Object.entries(shapes)) {
    const traceOut = new Map();
    let a = null;
    try {
      a = packCPatchShape(cs, 0, { maxCurves: 8, tolPx: 0.05, traceOut });
    } catch (e) {
      a = null;
    }
    if (!a) {
      bad(`T2 ${name}: the recording build produced nothing`);
      continue;
    }
    const bytes = encodeTraceBake(traceOut);
    const traces = decodeTraceBake(bytes);
    bakes[name] = { traces, bytes };
    const stats = {};
    let b = null;
    try {
      b = packCPatchShape(cs, 0, { maxCurves: 8, tolPx: 0.05, traces, traceStats: stats });
    } catch (e) {
      b = null;
    }
    const graphKeys = [...traceOut.keys()].filter((k) => k[0] === 'g' && k.length === 17).length;
    if (same(a, b) && (stats.hits | 0) > 0 && !(stats.misses | 0) && !(stats.misfits | 0))
      ok(
        `T2 ${name}: ${stats.hits | 0} contour trace(s) + ${graphKeys} graph entr${graphKeys === 1 ? 'y' : 'ies'}, ${bytes.length} bytes, streams byte-identical`,
      );
    else
      bad(
        `T2 ${name}: ${same(a, b) ? 'identical' : 'DIFFERENT'} streams, stats ${JSON.stringify(stats)}`,
      );
  }
}

// ---- T3: a bake from another pose must not produce a different decomposition ----
{
  const cs = shapes.blob;
  const moved = cs.map((c) =>
    c.map((s) => ({ ...s, P: s.P.map((q) => [q[0] * 1.07 + 3, q[1] * 0.93 - 2]) })),
  );
  const traceOut = new Map();
  let src = null;
  try {
    src = packCPatchShape(moved, 0, { maxCurves: 8, tolPx: 0.05, traceOut });
  } catch {
    src = null;
  }
  const traces = decodeTraceBake(encodeTraceBake(traceOut));
  // the same keys, forced onto the other pose: hash the real geometry's keys to the moved bake
  const forced = new Map();
  const probe = new Map();
  try {
    packCPatchShape(cs, 0, { maxCurves: 8, tolPx: 0.05, traceOut: probe });
  } catch {
    /* */
  }
  const srcVals = [...traces.values()],
    dstKeys = [...probe.keys()];
  for (let i = 0; i < dstKeys.length && i < srcVals.length; i++) forced.set(dstKeys[i], srcVals[i]);
  const stats = {};
  let plain = null,
    viaBad = null;
  try {
    plain = packCPatchShape(cs, 0, { maxCurves: 8, tolPx: 0.05 });
  } catch {
    plain = null;
  }
  try {
    viaBad = packCPatchShape(cs, 0, {
      maxCurves: 8,
      tolPx: 0.05,
      traces: forced,
      traceStats: stats,
    });
  } catch {
    viaBad = null;
  }
  if (src && plain && viaBad && same(plain, viaBad))
    ok(
      `T3 a mismatched bake falls back to the search (${JSON.stringify(stats)}); the build equals a plain build`,
    );
  else
    bad(
      `T3 mismatched bake: plain ${plain ? plain.texels.length : null} texels, via bake ${viaBad ? viaBad.texels.length : null}, ${same(plain, viaBad) ? 'same' : 'DIFFERENT'} (${JSON.stringify(stats)})`,
    );
}

// ---- T4: the whole route -- importSvg, a headless bundle, bakeCPatchBundle, the build's loop ----
{
  const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
  globalThis.DOMParser = globalThis.DOMParser || DP;
  globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
  const { default: importSvg } = await import('../src/svg/importer.js');
  const {
    headlessCPatchBundle,
    bakeCPatchBundle,
    contoursToConverter,
    shapeEvenOdd,
    cpatchCurvePlane,
  } = await import('../src/renderer/cpatchBuild.js');
  const { curveRangeToContours } = await import('../src/geom/lbContour.js');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
    <path d="M20 20 C 60 -20 100 60 140 20 Q 170 50 140 80 C 100 110 80 40 40 80 L 20 50 Z" fill="#c33"/>
    <path fill-rule="evenodd" d="M100 100 m-40 0 a40 40 0 1 0 80 0 a40 40 0 1 0 -80 0 M100 100 m-20 0 a20 20 0 1 1 40 0 a20 20 0 1 1 -40 0" fill="#3c3"/>
    <path d="M150 150 C 190 110 190 190 150 150 C 110 110 110 190 150 150 Z" fill="#33c"/>
  </svg>`;
  const sections = await importSvg(svg);
  const bundle = headlessCPatchBundle(sections);
  const bytes = bakeCPatchBundle(bundle, { maxCurves: 8, tolPx: 0.05 });
  const traces = decodeTraceBake(bytes);
  const build = (extra) => {
    const cf = cpatchCurvePlane(bundle),
      out = [];
    for (let s = 0; s < bundle.curveRangesByShape.length; s++) {
      const r = bundle.curveRangesByShape[s];
      let contours = null;
      try {
        contours = curveRangeToContours(cf, r.begin, r.end);
      } catch {
        contours = null;
      }
      const cs = contours && contours.length ? contoursToConverter(contours, null) : null;
      let m = null;
      if (cs) {
        try {
          m = packCPatchShape(cs, 0, {
            maxCurves: 8,
            tolPx: 0.05,
            evenOdd: shapeEvenOdd(bundle, s),
            ...extra,
          });
        } catch {
          m = null;
        }
      }
      out.push(m);
    }
    return out;
  };
  const stats = {};
  const plain = build({}),
    baked = build({ traces, traceStats: stats });
  let shapes = 0,
    identical = 0;
  for (let i = 0; i < plain.length; i++) {
    if (!plain[i] && !baked[i]) continue;
    shapes++;
    if (same(plain[i], baked[i])) identical++;
  }
  if (
    shapes >= 3 &&
    identical === shapes &&
    (stats.hits | 0) >= 3 &&
    !(stats.misses | 0) &&
    !(stats.misfits | 0)
  )
    ok(
      `T4 importSvg -> bake (${bytes.length} bytes, ${bytes.entries} entries) -> build: ${shapes} shapes byte-identical, ${stats.hits} trace hits`,
    );
  else
    bad(
      `T4 route: ${identical}/${shapes} identical, stats ${JSON.stringify(stats)}, bake ${bytes.length} bytes / ${bytes.entries} entries`,
    );
}

console.log(`CPATCH TRACE ${fail ? 'FAIL' : 'PASS'} (${pass} ok, ${fail} failed)`);
process.exit(fail ? 1 : 0);
