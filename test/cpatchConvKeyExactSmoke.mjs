// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchConvKeyExactSmoke — the CPatch conversion cache serves an entry only to the same inputs, at any
// scale.
//
// THE TRAP. A key that prints every coordinate to four decimals -- an ABSOLUTE 1e-4 quantum in authored
// units, the absolute-epsilon defect class -- and carries a hole COUNT and no conic weight collapses
// distinct contours of artwork authored small onto one key, and the conversion made for one is drawn
// for the other. The same key (hashed) keys the bake's traces, the per-shape cycle cache and the
// graph-cut bake entries, and the cycle cache's answer depends on the fill rule, so the key carries it.
// noAaArcRow__FAR carries one arc ring twice, 2e-14 apart.
//
// WHAT this PINS, at 2^-20, 1 and 2^20 (the keys are the float64 bits, so the scale must not matter):
//   K. the keys: a copy keys the same; one ulp on one coordinate, one ulp on a conic weight, other
//      holes or another setting key apart; a shape's cycle key moves with its fill rule;
//   B. the build: through one conversion cache, an exact duplicate contour HITS (and packs to the same
//      bytes), and a contour one ulp away MISSES and packs exactly as it does alone -- a quantized key
//      would serve it its neighbour's conversion;
//   F. noAaArcRow__FAR's two rings are the same inputs: 2e-14 apart in the path, they are one
//      float32 plane apart from nothing, and the only difference their contours carried was the rounding of each
//      arc's endpoint REBUILT from its center form (119.99999999999997 against ...99999). With the endpoints stored
//      they key alike and share one conversion, which is each one's own; and the bake still replays the build byte
//      for byte.
// A quantized key FAILS: the ulp neighbours share a key at 2^20, everything under 1e-4 collides at
// 2^-20, the weight and the hole geometry are not in the key, and FAR's second ring takes the first's.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PK = await import('../src/renderer/cpatchPack.js');
const { packCPatchShape, cpatchConvKey } = PK;
const settingsOf = PK.cpatchConvSettings || (() => '');
const shapeKeyOf = PK.cpatchShapeKey || null;
const { convertContour } = await import('../src/renderer/cpatchConvert.js');
const { default: importSvg } = await import('../src/svg/importer.js');
const cb = await import('../src/renderer/cpatchBuild.js');
const { curveRangeToContours } = await import('../src/geom/lbContour.js');
const { encodeTraceBake, decodeTraceBake } = await import('../src/renderer/cpatchTrace.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const nextUp = (x) => {
  const f = new Float64Array([x]),
    u = new BigInt64Array(f.buffer);
  u[0] += x >= 0 ? 1n : -1n;
  return f[0];
};

/// A six-cubic blob, scaled, with a conic spliced in so a weight is part of the input.
function blob(s) {
  const K = 6,
    out = [];
  const at = (j) => [
    s * (100 + 40 * Math.cos((2 * Math.PI * j) / K)),
    s * (100 + 40 * Math.sin((2 * Math.PI * j) / K)),
  ];
  for (let j = 0; j < K; j++) {
    const A = at(j),
      B = at(j + 1);
    const mx = (A[0] + B[0]) / 2 + (B[1] - A[1]) * 0.35,
      my = (A[1] + B[1]) / 2 - (B[0] - A[0]) * 0.35;
    if (j === 3) out.push({ t: 'rquad', P: [A, [mx, my], B], w: 0.8 });
    else
      out.push({
        t: 'cubic',
        P: [
          A,
          [A[0] + (mx - A[0]) * 0.9, A[1] + (my - A[1]) * 0.9],
          [B[0] + (mx - B[0]) * 1.1, B[1] + (my - B[1]) * 1.1],
          B,
        ],
      });
  }
  return out;
}
const clone = (cs) => cs.map((c) => ({ ...c, P: c.P.map((p) => p.slice()) }));
const bytesOf = (m) => (m ? JSON.stringify([Array.from(m.texels), Array.from(m.verts)]) : 'null');
class CountMap extends Map {
  constructor() {
    super();
    this.hits = 0;
  }
  get(k) {
    const v = super.get(k);
    if (v !== undefined) this.hits++;
    return v;
  }
}

for (const [label, s] of [
  ['2^-20', 2 ** -20],
  ['1', 1],
  ['2^20', 2 ** 20],
]) {
  console.log(`\n-- at ${label} --`);
  const A = blob(s),
    same = clone(A);
  const ulp = clone(A);
  ulp[2].P[1][0] = nextUp(ulp[2].P[1][0]);
  const wulp = clone(A);
  wulp[3].w = nextUp(wulp[3].w);
  const S = settingsOf({});
  const key = (c, h, st = S) => cpatchConvKey(c, h, st);
  ok(key(A, null) === key(same, null), 'K. a copy of a contour keys the same');
  ok(key(A, null) !== key(ulp, null), 'K. one ulp on one control point keys apart');
  ok(key(A, null) !== key(wulp, null), 'K. one ulp on a conic weight keys apart');
  const h1 = [blob(s * 0.25)],
    h2 = [clone(h1[0])];
  h2[0][0].P[0][1] = nextUp(h2[0][0].P[0][1]);
  ok(
    key(A, h1) !== key(A, h2),
    'K. the same contour with other holes (one ulp on a hole) keys apart',
  );
  ok(
    key(A, null, settingsOf({ maxCurves: 8 })) !== key(A, null, settingsOf({ maxCurves: 12 })),
    'K. and so does another setting (maxCurves 8 / 12)',
  );
  ok(
    !!shapeKeyOf &&
      shapeKeyOf([A], 'cn') !== shapeKeyOf([A], 'ce') &&
      shapeKeyOf([A], 'cn') !== shapeKeyOf([ulp], 'cn'),
    "K. a shape's cycle key carries its fill rule and its exact curves",
  );

  // B. through ONE conversion cache, as a build packs its shapes.
  const cache = new CountMap();
  const mA = packCPatchShape([A], 0, { convCache: cache });
  const hits0 = cache.hits;
  const mSame = packCPatchShape([same], 0, { convCache: cache });
  const hitDup = cache.hits - hits0;
  const hits1 = cache.hits;
  const mUlp = packCPatchShape([ulp], 0, { convCache: cache });
  const hitUlp = cache.hits - hits1;
  const alone = packCPatchShape([ulp], 0, { convCache: new Map() });
  ok(
    hitDup >= 1 && bytesOf(mSame) === bytesOf(mA),
    `B. an exact duplicate hits the cache (${hitDup}) and packs to the same bytes`,
  );
  ok(
    hitUlp === 0 && bytesOf(mUlp) === bytesOf(alone),
    `B. a contour one ulp away misses (${hitUlp} hits) and packs exactly as it does alone`,
  );
}

console.log('\n-- noAaArcRow__FAR --');
{
  const sec = await importSvg(
    readFileSync(path.join(ROOT, 'examples/smoke/noAaArcRow__FAR.svg'), 'utf8'),
  );
  const b = cb.headlessCPatchBundle(sec);
  const cf = cb.cpatchCurvePlane(b);
  const shapeCs = (s) => {
    const r = b.curveRangesByShape[s];
    return cb.contoursToConverter(curveRangeToContours(cf, r.begin, r.end), null);
  };
  const cache = new CountMap(),
    cyc = new Map();
  const m10 = packCPatchShape(shapeCs(10), 0, {
    evenOdd: cb.shapeEvenOdd(b, 10),
    convCache: cache,
    cycleCache: cyc,
  });
  const h10 = cache.hits;
  const m11 = packCPatchShape(shapeCs(11), 0, {
    evenOdd: cb.shapeEvenOdd(b, 11),
    convCache: cache,
    cycleCache: cyc,
  });
  const alone11 = packCPatchShape(shapeCs(11), 0, {
    evenOdd: cb.shapeEvenOdd(b, 11),
    convCache: new Map(),
  });
  // The cycles the packer converts (the graph front end's), converted as the packer converts them.
  const cycleOf = (s) => {
    const got = [];
    packCPatchShape(shapeCs(s), 0, { evenOdd: cb.shapeEvenOdd(b, s), collect: got });
    return got[0].curves;
  };
  const CO = { maxCurves: 8, search: 'full' };
  const c10 = cycleOf(10),
    c11 = cycleOf(11);
  const conv10 = convertContour(c10, CO),
    conv11 = convertContour(c11, CO);
  // THEY CONVERT ALIKE. A search on the caller's coordinates gives 8 patches and 4: at y = 1e5 the
  // rounding decides a tie between two equally deep violations, and the 2e-14 between the rings is
  // enough to decide it differently. In the contour's own frame it is not.
  ok(
    JSON.stringify(c10) === JSON.stringify(c11) &&
      cpatchConvKey(c10, null, settingsOf(CO)) === cpatchConvKey(c11, null, settingsOf(CO)) &&
      conv10 &&
      conv11 &&
      conv10.patches.length === conv11.patches.length,
    `F. the two rings are the same cycles (their endpoints stored), key alike and convert alike (${conv10 && conv10.patches.length} and ${conv11 && conv11.patches.length} patches)`,
  );
  ok(
    cache.hits > h10 && bytesOf(m11) === bytesOf(alone11) && !!m10,
    `F. the second ring, packed after the first through one cache, hits (${cache.hits - h10} hits) and packs exactly as it does alone`,
  );
  // The bake records and replays the whole file.
  const g = () => {
    const o = { plane: null, TEXTURE_2D: 1, bindTexture() {}, texParameteri() {} };
    o.texImage2D = (...a) => {
      o.plane = a[8];
    };
    return o;
  };
  const gA = g();
  cb.buildCPatchBundle(gA, cb.headlessCPatchBundle(sec), { pool: false });
  const bytes = cb.bakeCPatchBundle(cb.headlessCPatchBundle(sec), {});
  const rb = cb.headlessCPatchBundle(sec);
  rb._cpatchTraces = decodeTraceBake(bytes);
  const st = {},
    gB = g();
  cb.buildCPatchBundle(gB, rb, { pool: false, traceStats: st });
  const same =
    gA.plane &&
    gB.plane &&
    gA.plane.length === gB.plane.length &&
    gA.plane.every((v, i) => Object.is(v, gB.plane[i]));
  ok(
    same && (st.misfits | 0) === 0,
    `F. the bake replays the build byte for byte (${st.hits | 0} hits, ${st.misfits | 0} misfits, ${st.misses | 0} misses)`,
  );
  void encodeTraceBake;
}

console.log(fail ? `\ncpatchConvKeyExactSmoke FAIL (${fail})` : '\ncpatchConvKeyExactSmoke PASS');
process.exit(fail ? 1 : 0);
