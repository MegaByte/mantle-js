// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occlusionCullPerturbationSmoke -- the occlusion cull must not flip on input noise below the curve plane's own resolution.
//
// A shape drawn twice, the same outline under and over, is hidden by its copy; culling the lower one removes the AA-edge conflation
// fringe (the hidden fill bleeding through where both edges are partly covered). The cull samples the contained shape's boundary and
// nudges each sample a hair to both sides. Two traps make that answer ride on rounding:
//   1. a sample at t = 1 that takes its tangent from min(1, t + 0.01), the sample itself, nudges by the zero vector, and the test
//      point sits ON the vertex, where "inside the occluder" is decided by the last ulp of two outlines that differ by rounding;
//   2. a nudged point near a sharp corner is inside the contained shape and within a rounding of its other edge, so the occluder's
//      edge a few ulps away puts it outside.
// Real art with every coordinate scaled by 1 +- 6e-8 loses most of its culls that way, and its error against Chrome rises on every
// engine. The occluder and the hidden shape here carry independent noise of relative 1e-9..1e-6.
//
// Assertions, over leaves with sharp tips (cubic and quad edges), at 1, 2^-20 and 2^20, with and without a far origin:
//   1. the unperturbed lower copy is culled in both modes (the fixture can fail);
//   2. every perturbed pair culls the lower copy, in both modes;
//   3. a copy that really protrudes (a tip 1% of its size past the occluder) is still NOT culled, perturbed or not.
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/core/metaBin.js');
const { computeOccludedShapes, segTangentAt, segPointAt } =
  await import('../src/renderer/occlusionCull.js');

let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
const _warn = console.warn;
console.warn = () => {};

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}
const noisy = (nums, rel, r) => nums.map((v) => v * (1 + rel * (2 * r() - 1)));
// a leaf: two cubic edges meeting at sharp tips (x0,y0) and (x1,y1); `k` varies the shape, `bump` pushes the far tip out
const leaf = (k, bump = 0) => {
  const a = 10 + 11 * k,
    b = 20 + 7 * k;
  const x1 = a + 40 + 3 * k + bump,
    y1 = b + 55 - 2 * k;
  return [a, b, a + 30, b - 5, x1 - 25, y1 + 20, x1, y1, x1 - 40, y1 - 5, a - 8, b + 30, a, b];
};
const d = (n) =>
  `M${n[0]} ${n[1]} C${n[2]} ${n[3]} ${n[4]} ${n[5]} ${n[6]} ${n[7]} C${n[8]} ${n[9]} ${n[10]} ${n[11]} ${n[12]} ${n[13]} Z`;

const OFF = 16384;
async function culled(body, S, off) {
  const T = off ? OFF * S : 0,
    vb = [-10, -10, 190, 190];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${[vb[0] * S + T, vb[1] * S + T, vb[2] * S, vb[3] * S].join(' ')}">` +
    `<g transform="${off ? `translate(${T} ${T}) ` : ''}scale(${S})">${body}</g></svg>`;
  const sec = await importSvg(svg, { preserveViewport: true });
  const m = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
  const cv = new Float32Array(sec.curves),
    ranges = sec.curveRangesByShape.map((r) => ({ begin: r.begin | 0, end: r.end | 0 }));
  return {
    coincident: computeOccludedShapes(
      cv,
      ranges,
      m.metaFloats,
      m.numShapes,
      m.floatsPerShape,
      'coincident',
    ),
    full: computeOccludedShapes(cv, ranges, m.metaFloats, m.numShapes, m.floatsPerShape, 'full'),
  };
}
const K = 4;
// shapes 2k (lower, red) and 2k+1 (upper, black), the same leaf
const pairs = (rel, seed, bumpLower = 0) => {
  const r = rng(seed * 7919 + 13);
  let s = '';
  for (let k = 0; k < K; k++) {
    const base = leaf(k),
      low = bumpLower ? leaf(k, bumpLower * (40 + 3 * k)) : base;
    s += `<path fill="#f00" d="${d(rel ? noisy(low, rel, r) : low)}"/><path fill="#000" d="${d(rel ? noisy(base, rel, r) : base)}"/>`;
  }
  return s;
};

console.log("the tangent at t = 1 is the segment's own, not zero");
{
  const seg = { t: 0, x0: 0, y0: 0, x1: 3, y1: 4 };
  const t1 = segTangentAt(seg, 1),
    t0 = segTangentAt(seg, 0);
  check(
    t1 &&
      Math.abs(t1[0] - 0.6) < 1e-12 &&
      Math.abs(t1[1] - 0.8) < 1e-12 &&
      t0 &&
      Math.abs(t0[0] - 0.6) < 1e-12,
    'a line has the same unit tangent at t = 0 and t = 1',
  );
  check(
    segTangentAt({ t: 0, x0: 5, y0: 5, x1: 5, y1: 5 }, 1) === null,
    'a zero-length segment has no tangent',
  );
  check(segPointAt(seg, 1)[0] === 3, 'segPointAt still ends at the segment end');
}

const bad = [];
let n = 0;
for (const off of [false, true])
  for (const e of [0, -20, 20]) {
    const S = 2 ** e,
      tag = `2^${e}${off ? '+origin' : ''}`;
    const base = await culled(pairs(0, 1), S, off);
    for (const mode of ['coincident', 'full'])
      for (let k = 0; k < K; k++)
        if (!base[mode].has(2 * k)) bad.push(`unperturbed ${mode} ${tag} leaf ${k}`);
    for (const rel of [1e-9, 1e-8, 1e-7, 1e-6])
      for (let seed = 1; seed <= 3; seed++) {
        n++;
        const c = await culled(pairs(rel, seed), S, off);
        for (const mode of ['coincident', 'full'])
          for (let k = 0; k < K; k++)
            if (!c[mode].has(2 * k)) bad.push(`${mode} ${tag} rel ${rel} seed ${seed} leaf ${k}`);
      }
    // a tip 1% of the leaf's size past the occluder is real ink and stays
    for (const rel of [0, 1e-7]) {
      const c = await culled(pairs(rel, 5, 0.01), S, off);
      for (const mode of ['coincident', 'full'])
        for (let k = 0; k < K; k++)
          if (c[mode].has(2 * k))
            bad.push(`protruding ${mode} ${tag} rel ${rel} leaf ${k} was culled`);
    }
  }
check(
  bad.length === 0,
  `${n} perturbed leaf sets x ${K} keep their hidden copy culled in both modes at every size${bad.length ? ' -- ' + bad.length + ' failed, first: ' + bad.slice(0, 4).join('; ') : ''}`,
);

console.warn = _warn;
if (failures) {
  console.log(`occlusionCullPerturbationSmoke FAIL: ${failures}`);
  process.exit(1);
}
console.log('occlusionCullPerturbationSmoke PASS');
