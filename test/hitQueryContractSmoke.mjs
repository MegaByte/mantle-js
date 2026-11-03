// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Hit-query contracts for empty inputs, geometry boundaries, handles and morphs.
// Actual CPU APIs; the GL recorders evaluate no shader arithmetic.
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const eq = (got, want, m) =>
  ok(
    JSON.stringify(got) === JSON.stringify(want),
    `${m} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`,
  );

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const {
  importSvg,
  createBundle,
  createRenderer,
  createShapeMorph,
  createShapeTimeline,
  createOverrideTable,
  fillHitShape,
  fillHits,
  fillHitId,
  fillHitHref,
} = await import('../src/index.js');

const svg = (body, vb = '0 0 100 100') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}">${body}</svg>`;
const M = (s) => [s, 0, 0, 0, s, 0, 0, 0, 1];
const MODES = ['bbox', 'coverage', 'outline', 'auto'];

// ── empty bundles ─────────────────────────────────────────────────────
console.log('empty bundle');
for (const body of [
  '<rect width="10" height="10" display="none"/>',
  '',
  '<g/>',
  '<rect width="9" height="9" fill="none"/>',
]) {
  const b = await importSvg(svg(body));
  let threw = null;
  try {
    for (const mode of MODES) {
      if (fillHitShape(b, 5, 5, mode) !== -1) throw new Error('fillHitShape ' + mode);
      if (fillHits(b, 5, 5, mode).length !== 0) throw new Error('fillHits ' + mode);
      if (fillHitId(b, 5, 5, mode) !== null) throw new Error('fillHitId ' + mode);
      if (fillHitHref(b, 5, 5, mode) !== null) throw new Error('fillHitHref ' + mode);
    }
  } catch (e) {
    threw = e.message;
  }
  ok(
    threw === null,
    `${JSON.stringify(body)}: all four queries miss in every mode${threw ? ' — ' + threw : ''}`,
  );
}

{
  // the feature inspector reads the same empty meta
  const { inspect } = await import('../src/bundle/featureSet.js');
  let threw = null,
    f = null;
  try {
    f = inspect(await importSvg(svg('')));
  } catch (e) {
    threw = e.message;
  }
  ok(
    threw === null && f === 0n,
    `inspect(an empty bundle) is the empty feature set${threw ? ' — ' + threw : ''}`,
  );
}

// ── non-finite coordinates ────────────────────────────────────────────
console.log('non-finite query points');
{
  const b = await importSvg(
    svg(
      '<circle cx="30" cy="30" r="20" fill="red"/><path d="M70 10H90" stroke="blue" stroke-width="6" fill="none"/><rect x="0" y="60" width="30" height="30" fill="green"/>',
    ),
  );
  let bad = 0;
  for (const mode of MODES)
    for (const [x, y] of [
      [NaN, NaN],
      [NaN, 30],
      [30, NaN],
      [Infinity, Infinity],
      [-Infinity, 0],
      [undefined, 30],
      ['30', NaN],
    ]) {
      if (
        fillHitShape(b, x, y, mode) !== -1 ||
        fillHits(b, x, y, mode).length !== 0 ||
        fillHitId(b, x, y, mode) !== null
      )
        bad++;
    }
  eq(bad, 0, 'every mode misses at NaN, +-Infinity and undefined');
  ok(fillHitShape(b, 30, 30, 'coverage') === 0, 'a finite point still hits');
}

// ── no worldMatrix = point-in-fill at any scale ───────────────────────
console.log('no worldMatrix, scale-free');
for (const e of [-20, -10, -3, 0, 3, 10, 20]) {
  const k = 2 ** e,
    f = (v) => v * k;
  const d = `M${f(0.4)} ${f(0.4)}H${f(0.6)}V${f(0.6)}H${f(0.4)}Z`;
  const b = await importSvg(svg(`<path d="${d}" fill="red"/>`, `0 0 ${k} ${k}`));
  const hit = (x, y, mode = 'coverage') => fillHitShape(b, f(x), f(y), mode);
  ok(
    hit(0.5, 0.5) === 0 && hit(0.5, 0.5, 'auto') === 0,
    `2^${e}: a path 0.2 across hits at its center (coverage and auto)`,
  );
  ok(
    hit(0.45, 0.55) === 0 && hit(0.3, 0.5) === -1 && hit(0.7, 0.5) === -1 && hit(0.5, 0.3) === -1,
    `2^${e}: inside hits, outside misses`,
  );
}
{
  // with a worldMatrix the pixel box is real: a 0.2-pixel square covers 0.04 of it
  const b = await importSvg(svg('<path d="M.4 .4H.6V.6H.4Z" fill="red"/>', '0 0 1 1'));
  eq(
    fillHitShape(b, 0.5, 0.5, { mode: 'coverage', worldMatrix: M(1) }),
    -1,
    'worldMatrix scale 1: a 0.2-pixel square is below half coverage',
  );
  eq(
    fillHitShape(b, 50, 50, { mode: 'coverage', worldMatrix: M(100) }),
    0,
    'worldMatrix scale 100: the same square is 20 pixels across',
  );
}
{
  // an em-sized glyph-like outline (an "I" stem, 0.1 em wide) is hittable with no matrix
  const b = await importSvg(svg('<path d="M.7 0H.8V.7H.7Z" fill="black"/>', '0 0 1 1'));
  eq(fillHitShape(b, 0.75, 0.3, 'auto'), 0, 'a 0.1 x 0.7 em stem hits at (0.75, 0.3) in auto mode');
}

// ── inclusive ties ────────────────────────────────────────────────────
console.log('inclusive ties');
{
  const b = await importSvg(svg('<path d="M10 10H60V60H10Z" fill="red"/>'));
  for (const S of [1, 2, 4, 8, 3, 0.5, 16]) {
    const q = (x, y) => fillHitShape(b, x * S, y * S, { mode: 'coverage', worldMatrix: M(S) });
    eq(
      [q(10, 35), q(60, 35), q(35, 10), q(35, 60)],
      [0, 0, 0, 0],
      `scale ${S}: all four edge midpoints hit`,
    );
    eq(
      [q(9.9, 35), q(60.1, 35), q(35, 9.9), q(35, 60.1)],
      [-1, -1, -1, -1],
      `scale ${S}: a point 0.1 outside each edge misses`,
    );
  }
  const q0 = (x, y) => fillHitShape(b, x, y, 'coverage');
  eq(
    [q0(10, 35), q0(60, 35), q0(35, 10), q0(35, 60)],
    [0, 0, 0, 0],
    'no matrix: all four edge midpoints hit',
  );
  eq(
    [q0(9.99, 35), q0(60.01, 35), q0(35, 9.99), q0(35, 60.01)],
    [-1, -1, -1, -1],
    'no matrix: just outside misses',
  );
  const c = await importSvg(
    svg('<path d="M10 10H40V60H10Z" fill="red"/><path d="M40 10H70V60H40Z" fill="blue"/>'),
  );
  for (const S of [0, 1, 4]) {
    const hits = fillHits(
      c,
      40 * (S || 1),
      35 * (S || 1),
      S ? { mode: 'coverage', worldMatrix: M(S) } : 'coverage',
    );
    eq(
      hits,
      [1, 0],
      `${S ? 'scale ' + S : 'no matrix'}: abutting rects both answer on the shared edge (no gap)`,
    );
  }
  // a curved edge: the circle (as arcs) at (cx + r, cy) with no matrix
  const d = await importSvg(
    svg('<path d="M30 50A20 20 0 1 1 70 50A20 20 0 1 1 30 50Z" fill="red"/>'),
  );
  eq(
    [
      fillHitShape(d, 70, 50, 'coverage'),
      fillHitShape(d, 30, 50, 'coverage'),
      fillHitShape(d, 50, 30, 'coverage'),
      fillHitShape(d, 50, 70, 'coverage'),
    ],
    [0, 0, 0, 0],
    'a curved boundary is inclusive at the four extremes',
  );
  eq(fillHitShape(d, 70.01, 50, 'coverage'), -1, 'and a hundredth outside misses');
}

// ── animation handles ─────────────────────────────────────────────────
console.log('handles');
{
  const F = createFakeGl({ width: 128, height: 128 });
  const gl = F.gl;
  const R = createRenderer(gl, taggedShaderSources(), {});
  if (R.ready) await R.ready;
  R.setViewport(128, 128);
  const mk = async (d) =>
    createBundle(
      gl,
      await importSvg(
        svg(
          `<path id="s" d="${d}" fill="red"/><circle id="c" cx="50" cy="50" r="8" fill="blue" stroke="#000" stroke-width="3"/>`,
        ),
      ),
    );
  const A = await mk('M10 10H30V30H10Z'),
    B = await mk('M40 40H60V60H40Z');
  const m = createShapeMorph(gl, A, B);
  m.setT(0.5);
  const tl = createShapeTimeline(
    gl,
    [A, B],
    [
      { time: 0, bundleIndex: 0 },
      { time: 1, bundleIndex: 1 },
    ],
  );
  tl.setTime(0.5);
  for (const [name, h] of [
    ['morph', m],
    ['timeline', tl],
  ]) {
    eq(
      fillHitShape(h, 55, 55, 'coverage'),
      fillHitShape(h.bundle, 55, 55, 'coverage'),
      `${name}: fillHitShape(handle) = fillHitShape(handle.bundle)`,
    );
    ok(fillHitShape(h, 55, 55, 'coverage') >= 0, `${name}: and it hits`);
    eq(
      fillHits(h, 55, 55, 'coverage'),
      fillHits(h.bundle, 55, 55, 'coverage'),
      `${name}: fillHits`,
    );
    eq(
      fillHitId(h, 55, 55, 'coverage'),
      fillHitId(h.bundle, 55, 55, 'coverage'),
      `${name}: fillHitId`,
    );
    eq(
      fillHitHref(h, 55, 55, 'coverage'),
      fillHitHref(h.bundle, 55, 55, 'coverage'),
      `${name}: fillHitHref`,
    );
    const bytes = R.estimateRouteBytes([h]).total.cover;
    ok(
      bytes > 0 && bytes === R.estimateRouteBytes([h.bundle]).total.cover,
      `${name}: estimateRouteBytes([handle]) prices the bundle (${bytes} B)`,
    );
    ok(
      R.prepareBundle(h) === R.prepareBundle(h.bundle) && R.prepareBundle(h) === true,
      `${name}: prepareBundle(handle) prepares the bundle`,
    );
    const t = createOverrideTable(gl, h);
    eq(t.numShapes, h.bundle.numShapes, `${name}: createOverrideTable(handle) sizes to the bundle`);
    t.dispose();
    R.prewarmBundle(h);
    ok(
      R.setSceneUnion([h, h.bundle]) === undefined,
      `${name}: setSceneUnion and prewarmBundle accept the handle`,
    );
    R.setSceneUnion(null);
    ok((await R.awaitEngine(h, 'slug', 10)) === true, `${name}: awaitEngine(handle)`);
  }
  R.dispose();
}

// Group thresholds use the current morph pose and carried paint order.
{
  const { makeFakeWebgl2 } = await import('./_fakeWebgl2.mjs');
  const leaf = (o) =>
    `<rect id="a" x="10" y="10" width="30" height="30" fill="red" stroke="blue" stroke-width="4" opacity="${o}"/>`;
  const hitsAt = (b, mode, alpha) => fillHitShape(b, 25, 25, { mode, minAlpha: alpha }) >= 0;
  for (const [body, alpha] of [
    [`<g opacity=".5">${leaf(1)}</g>`, 0.5],
    [`<g opacity=".5"><g opacity=".5">${leaf(1)}</g></g>`, 0.25],
    [leaf(0.5), 0.5],
    [
      '<g opacity=".5"><rect x="10" y="10" width="30" height="30" fill="red" fill-opacity=".5"/></g>',
      0.25,
    ],
  ]) {
    const b = await importSvg(svg(body));
    for (const mode of ['coverage', 'bbox']) {
      ok(hitsAt(b, mode, alpha - 0.02), mode + ': below enclosing opacity hits');
      ok(!hitsAt(b, mode, alpha + 0.02), mode + ': above enclosing opacity misses');
    }
    ok(hitsAt(b, 'auto', 0.99), 'auto retains paint-independent hit semantics');
  }
  {
    const b = await importSvg(
      svg(
        '<g opacity=".5"><rect x="10" y="10" width="20" height="20" fill="red"/></g><rect x="50" y="50" width="20" height="20" fill="blue"/>',
      ),
    );
    ok(
      fillHitShape(b, 60, 60, { mode: 'coverage', minAlpha: 0.99 }) >= 0,
      'opacity restores after a group',
    );
    eq(
      fillHitShape(b, 20, 20, { mode: 'coverage', minAlpha: 0.99 }),
      -1,
      'grouped paint retains its opacity threshold',
    );
  }
  for (const [a, b] of [
    [0.8, 0.2],
    [1, 0.2],
    [0.2, 1],
  ]) {
    const { gl } = makeFakeWebgl2(64, 64);
    const A = createBundle(gl, await importSvg(svg(leaf(a))));
    const B = createBundle(gl, await importSvg(svg(leaf(b))));
    const m = createShapeMorph(gl, A, B, { cpuLerp: true });
    try {
      for (const t of [0.25, 0.75, 0.5, 1, 0, 0.75]) {
        m.setT(t);
        const alpha = a + (b - a) * t;
        for (const mode of ['coverage', 'bbox']) {
          ok(hitsAt(m.bundle, mode, alpha - 0.02), `${a}->${b}@${t} ${mode}: below threshold hits`);
          ok(
            !hitsAt(m.bundle, mode, alpha + 0.02),
            `${a}->${b}@${t} ${mode}: above threshold misses`,
          );
          eq(
            fillHits(m.bundle, 25, 25, { mode, minAlpha: alpha + 0.02 }),
            [],
            mode + ': all hits use current group alpha',
          );
        }
      }
    } finally {
      m.dispose();
      A.dispose();
      B.dispose();
    }
  }
}

console.log(fail ? `\nHIT-QUERY-CONTRACT FAIL (${fail})` : '\nHIT-QUERY-CONTRACT PASS');
process.exit(fail ? 1 : 0);
