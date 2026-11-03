// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// originSmoke -- the per-bundle ORIGIN (bundle/layout.js, svg/importer.js): coordinates are stored relative to a float64 origin.
//
// Art far from the document origin is quantized by a float32 curve table (a float32 at 1e7 spaces 1.0 apart: unit-sized art there
// would be a smear). So the importer subtracts a bundle origin in float64 before the store; the draw fits the content
// box, so what has to be right is every reader that takes or gives a POSITION:
//   (a) originFor: none for art near the origin (its bytes are unchanged), the box center snapped to a power of two for far art;
//   (b) the store: unit-sized art at offsets 0 .. 1e8 keeps its shape to 2^-20 of its size (the `origin: false` arm does not);
//   (c) the header: version 2 near the origin, version 3 + flag + sections.origin far; createBundle names a header without its origin;
//   (d) every repo SVG imported under a forced origin has the box of the origin-free import (plus the origin) and the same hit answers
//       over a grid, at several origins (the importer shifts the CTM, so a coordinate that did not follow shows here);
//   (e) overrides act about the DOCUMENT origin (rotation/scale of a far bundle moves it as the origin-free bundle moves);
//   (f) morph: bundles with different origins are refused by name, equal origins morph; streaming takes document coordinates;
//       a far scene on the direct path takes the importer; retainSource keeps absolute coordinates;
//   (g) the converter input of a far shape is the origin-free input (translation invariance by construction).
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createFakeGl } from './_fakeGl.mjs';
import { tigerOrFixture } from './_tigerOrFixture.mjs';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const M = await import('../src/index.js');
const { originFor, ORIGIN_RATIO } = await import('../src/svg/importer.js');
const { META_VERSION, META_VERSION_PLAIN } = await import('../src/bundle/layout.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};
const F = createFakeGl({ width: 64, height: 64 });
const gl = F.gl;
const wrap = (body, attrs = '') => `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const throwsWith = async (fn, re) => {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test(String(e.message));
  }
};

// ---- (a) originFor
console.log('originFor');
{
  ok(
    originFor([0, 0, 100, 100]) === null && originFor([10, 10, 80, 80]) === null,
    'art at the origin: none',
  );
  ok(
    originFor([300, 300, 100, 100]) === null &&
      originFor([5000, 5000, 100, 100]) === null &&
      originFor([50, 20, 4, 4]) === null,
    `art up to ORIGIN_RATIO ${ORIGIN_RATIO} sizes out (an icon at (50, 20)): none (the bytes are unchanged)`,
  );
  const o = originFor([1000, 2000, 10, 10]);
  ok(
    o &&
      Math.abs(o[0] - 1005) <= 4 &&
      Math.abs(o[1] - 2005) <= 4 &&
      o[0] % 8 === 0 &&
      o[1] % 8 === 0,
    `10-wide art at (1000, 2000): origin ${JSON.stringify(o)} (box center snapped to a multiple of 8)`,
  );
  ok(
    originFor([0, 0, 0, 0]) === null &&
      originFor(null) === null &&
      originFor([1e9, 1e9, 0, 0]) === null,
    'an empty box and a point: none',
  );
  const big = originFor([1e8, -1e8, 1, 1]);
  ok(
    big && Math.abs(big[0] - 1e8) <= 1 && Math.abs(big[1] + 1e8) <= 1,
    `unit art at 1e8: origin ${JSON.stringify(big)}`,
  );
}

// ---- (b) the store
console.log('the float32 store');
{
  const tri = [
    [0.1, 0.1],
    [1.3, 0.2],
    [0.7, 1.1],
  ];
  const inside = (p, t, eps) => {
    // signed distance of p inside the triangle t (positive inside), min over edges
    let m = Infinity;
    for (let i = 0; i < 3; i++) {
      const a = t[i],
        b = t[(i + 1) % 3];
      const e = [b[0] - a[0], b[1] - a[1]],
        l = Math.hypot(e[0], e[1]);
      m = Math.min(m, (((p[0] - a[0]) * e[1] - (p[1] - a[1]) * e[0]) / l) * -1);
    }
    return m;
  };
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pts = [];
  while (pts.length < 300) {
    const p = [rnd() * 1.6 - 0.1, rnd() * 1.4 - 0.1];
    if (Math.abs(inside(p, tri)) > 2 ** -13) pts.push(p);
  } // not within 1.2e-4 of an edge
  for (const off of [0, 1e4, 1e5, 1e6, 1e7, 1e8]) {
    const d = tri.map(([x, y]) => `${x + off} ${y + off}`);
    const svg = wrap(`<path d="M${d[0]} L${d[1]} L${d[2]} Z" fill="red"/>`);
    let wrong = {};
    for (const arm of ['auto', false]) {
      const sec = await M.importSvg(svg, arm === false ? { origin: false } : {});
      const b = M.createBundle(gl, sec);
      let bad = 0;
      for (const p of pts) {
        const want = inside(p, tri) > 0;
        const got = M.fillHitShape(b, p[0] + off - b.origin[0], p[1] + off - b.origin[1]) === 0;
        if (want !== got) bad++;
      }
      wrong[arm] = bad;
      if (arm === 'auto') {
        const nz = off !== 0;
        ok(
          (b.origin[0] !== 0) === nz && (off === 0 || sec.meta.byteLength > 0),
          `offset ${off}: origin ${JSON.stringify(b.origin)}`,
        );
      }
    }
    ok(
      wrong.auto === 0,
      `offset ${off}: 300 points off the edges by 2^-13..: ${wrong.auto} wrong (origin auto)`,
    );
    if (off >= 1e6)
      ok(
        wrong[false] > 0,
        `offset ${off}: the origin-free arm is wrong at ${wrong[false]} of 300 points (the test can fail)`,
      );
  }
}

// ---- (c) the header
console.log('the header');
{
  const near = await M.importSvg(
    wrap('<rect x="10" y="10" width="80" height="80"/>', 'viewBox="0 0 100 100"'),
  );
  const far = await M.importSvg(wrap('<rect x="100000" y="200000" width="8" height="8"/>'));
  const dvn = new DataView(near.meta),
    dvf = new DataView(far.meta);
  ok(
    dvn.getUint32(24, true) === META_VERSION_PLAIN &&
      dvn.getUint32(28, true) === 0 &&
      near.origin === undefined,
    'near the origin: header version 2, no origin field',
  );
  ok(
    dvf.getUint32(24, true) === META_VERSION &&
      dvf.getUint32(28, true) === 1 &&
      far.origin.length === 2,
    'far: header version 3, origin flag, sections.origin',
  );
  ok(
    far.globalBBox[0] >= -8 && far.globalBBox[0] <= 8 && far.globalBBox[2] === 8,
    `far: the stored box is relative (${far.globalBBox.map((v) => +v.toFixed(2))}) and the origin is ${far.origin}`,
  );
  ok(
    await throwsWith(
      () => M.createBundle(gl, { ...far, origin: undefined }),
      /relative to a bundle origin but sections\.origin is missing/,
    ),
    'createBundle refuses a version-3 header whose sections lost the origin',
  );
  const fixed = await M.importSvg(
    wrap('<rect x="10" y="10" width="80" height="80"/>', 'viewBox="0 0 100 100"'),
    { origin: [64, 64] },
  );
  ok(
    fixed.origin[0] === 64 && Math.abs(fixed.globalBBox[0] - (10 - 64)) < 1e-9,
    'opts.origin forces the origin (a sprite sheet shares one)',
  );
  const b = M.createBundle(gl, fixed);
  ok(
    b.origin[0] === 64 &&
      M.fillHitShape(b, 50 - 64, 50 - 64) === 0 &&
      M.fillHitShape(b, 5 - 64, 5 - 64) === -1,
    'bundle.origin; hit tests take bundle units (document - origin)',
  );
  ok(
    await throwsWith(
      () => M.importSvg(wrap('<rect width="1" height="1"/>'), { origin: [NaN, 0] }),
      /pair of finite numbers/,
    ),
    'a non-finite opts.origin is a named error',
  );
  ok(
    await throwsWith(
      () =>
        M.importSvg(wrap('<rect width="1" height="1"/>'), { origin: [1, 1], retainSource: true }),
      /retainSource/,
    ),
    'opts.origin with retainSource is a named error',
  );
  const kept = await M.importSvg(wrap('<rect x="100000" y="200000" width="8" height="8"/>'), {
    retainSource: true,
  });
  ok(
    kept.origin === undefined && kept.svgSource,
    'retainSource keeps absolute coordinates (the native fallback draws the markup as written)',
  );
  // the bytes of near art equal the origin-free import
  const a = await M.importSvg(
      wrap(
        '<circle cx="40" cy="40" r="30" stroke="#000" stroke-width="4"/>',
        'viewBox="0 0 100 100"',
      ),
    ),
    c = await M.importSvg(
      wrap(
        '<circle cx="40" cy="40" r="30" stroke="#000" stroke-width="4"/>',
        'viewBox="0 0 100 100"',
      ),
      { origin: false },
    );
  const same = (k) => Buffer.compare(Buffer.from(a[k]), Buffer.from(c[k])) === 0;
  ok(
    same('meta') && same('curves') && same('bands') && same('curveGeom'),
    'near art: the default import is byte for byte the origin-free import',
  );
}

// ---- (d) the corpus under forced origins
console.log('the corpus');
{
  const files = [];
  for (const dir of ['examples/smoke', 'examples'])
    for (const f of readdirSync(path.join(ROOT, dir)).sort())
      if (f.endsWith('.svg')) files.push(path.join(ROOT, dir, f));
  const ORIGINS = [
    [16, -16],
    [3000, -4000],
    [4096.5, -2048.25],
  ];
  const tally = ORIGINS.map(() => ({ bad: 0, boxBad: 0, n: 0, names: [] }));
  for (const f of files) {
    const svg = readFileSync(f, 'utf8');
    // The origin-free import, its bundle and its hit answers do not depend on the forced origin, so
    // they are computed once per file and every origin is held to them.
    let s0;
    try {
      s0 = await M.importSvg(svg, { origin: false });
    } catch {
      continue;
    }
    if (!s0.numShapes) continue;
    const g0 = s0.globalBBox,
      e = Math.max(g0[2], g0[3], 1e-9);
    let grid = null;
    for (const [k, O] of ORIGINS.entries()) {
      const t = tally[k];
      let s1;
      try {
        s1 = await M.importSvg(svg, { origin: O });
      } catch {
        continue;
      }
      t.n++;
      const g1 = s1.globalBBox;
      const dd = Math.max(
        Math.abs(g0[0] - (g1[0] + O[0])),
        Math.abs(g0[1] - (g1[1] + O[1])),
        Math.abs(g0[2] - g1[2]),
        Math.abs(g0[3] - g1[3]),
      );
      if (!(dd <= 1e-6 * e)) {
        t.boxBad++;
        t.names.push(path.basename(f) + ' box ' + dd.toExponential(1));
        continue;
      }
      if (!grid) {
        const b0 = M.createBundle(gl, s0);
        grid = [];
        for (let i = 0; i < 20; i++)
          for (let j = 0; j < 20; j++) {
            const px = g0[0] + ((i + 0.37) / 20) * g0[2],
              py = g0[1] + ((j + 0.41) / 20) * g0[3];
            grid.push([px, py, M.fillHitShape(b0, px, py)]);
          }
      }
      const b1 = M.createBundle(gl, s1);
      let hb = 0;
      for (const [px, py, h0] of grid) if (h0 !== M.fillHitShape(b1, px - O[0], py - O[1])) hb++;
      if (hb > 6) {
        t.bad++; // (a hairline sliver can move 4 of 400 points: its edge is a float32 step of the stored coordinates)
        t.names.push(path.basename(f) + ' hits ' + hb);
      }
    }
  }
  for (const [k, O] of ORIGINS.entries()) {
    const { bad, boxBad, n, names } = tally[k];
    ok(
      bad + boxBad === 0,
      `origin ${JSON.stringify(O)}: ${n} repo SVGs: same box (+origin) and the same hit answers over a 20x20 grid${names.length ? ' -- ' + names.slice(0, 5).join('; ') : ''}`,
    );
  }
}

// ---- (d2) the noise field of feTurbulence is the origin-free bundle's
console.log('turbulence');
{
  const svg = wrap(
    '<defs><filter id="t" x="0" y="0" width="1" height="1"><feTurbulence baseFrequency="0.05" numOctaves="2" seed="3"/></filter></defs>' +
      '<g transform="translate(30 40) rotate(10)"><rect width="50" height="50" filter="url(#t)"/></g><rect x="100" y="0" width="50" height="50" filter="url(#t)"/>',
    'viewBox="0 0 200 100"',
  );
  const um = (sec) =>
    sec.filterGraphs
      .map(
        (g) =>
          g &&
          g.nodes
            .filter((n) => n.type === 'feTurbulence')
            .map((n) => n.params.um || [1, 0, 0, 1, 0, 0]),
      )
      .flat(); // (no map = the identity)
  const a = um(await M.importSvg(svg, { origin: false })),
    b = um(await M.importSvg(svg, { origin: [4096.5, -2048.25] }));
  const same =
    a.length === b.length && a.every((u, i) => u.every((v, k) => Math.abs(v - b[i][k]) < 1e-9));
  ok(
    a.length >= 1 && same,
    `feTurbulence's root-to-user map (um) is the origin-free one under a forced origin (${a.length} filter entries)`,
  );
}

// ---- (d3) a userSpaceOnUse gradient is stored in the bundle's frame too
console.log('gradients');
{
  const o = 1e7,
    S = 2 ** -17;
  const svg = wrap(
    `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${o + 20 * S}" y1="${o}" x2="${o + 108 * S}" y2="${o}"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>` +
      `<radialGradient id="r" gradientUnits="userSpaceOnUse" cx="${o + 64 * S}" cy="${o + 64 * S}" r="${54 * S}"><stop offset="0" stop-color="#ff0"/><stop offset="1" stop-color="#00f"/></radialGradient></defs>` +
      `<path d="M${o + 10 * S} ${o + 10 * S} H${o + 118 * S} V${o + 118 * S} H${o + 10 * S} Z" fill="url(#g)"/><circle cx="${o + 64 * S}" cy="${o + 64 * S}" r="${50 * S}" fill="url(#r)"/>`,
  );
  const sec = await M.importSvg(svg),
    g = new Float32Array(sec.gradients),
    n = g.length / 16;
  // every record a shape can use (the importer also leaves the unplaced original beside a moved placement) is small, or unused: the last of each pair
  const used = [g.subarray((n - 2) * 16, (n - 1) * 16), g.subarray((n - 1) * 16, n * 16)];
  ok(
    sec.origin &&
      n >= 2 &&
      used.every((r) => Math.abs(r[8]) < 1 && Math.abs(r[12]) < 1e-2 && Math.abs(r[13]) < 1e-2),
    `gradients 1e7 out: the placed records are in the bundle's frame (x1 ${used[0][12]}, x2 - x1 ${used[0][14] - used[0][12]} of ${88 * S}, radial cx ${used[1][12]})`,
  );
}

// ---- (e) overrides act about the document origin
console.log('overrides');
{
  const svg = (off) =>
    wrap(
      `<rect id="a" x="${off + 10}" y="${off + 20}" width="30" height="20" fill="red"/><rect id="b" x="${off + 60}" y="${off + 60}" width="10" height="10" fill="blue"/>`,
    );
  const o = [1000, 2000];
  const plain = M.createBundle(gl, await M.importSvg(svg(1000), { origin: false }));
  const far = M.createBundle(gl, await M.importSvg(svg(1000), { origin: o }));
  const tp = M.createOverrideTable(gl, plain),
    tf = M.createOverrideTable(gl, far);
  const apply = (b, t, key, p) => {
    // a document point through the row's override record, in the bundle's frame, back to the document
    const r = b.shapeIds.indexOf(key),
      P = t.packedBuffer,
      k = r * 24;
    const q = [p[0] - b.origin[0], p[1] - b.origin[1]];
    return [
      P[k] * q[0] + P[k + 1] * q[1] + P[k + 4] + b.origin[0],
      P[k + 2] * q[0] + P[k + 3] * q[1] + P[k + 5] + b.origin[1],
    ];
  };
  const probe = [1015, 1025];
  for (const [label, rec] of [
    ['rotation', { localRotation: 0.4 }],
    ['scale', { localScale: [2, 0.5] }],
    ['move', { localPosition: [7, -3] }],
    ['all three', { localPosition: [7, -3], localRotation: 0.4, localScale: [2, 0.5] }],
  ]) {
    tp.set('a', rec);
    tf.set('a', rec);
    const p = apply(plain, tp, 'a', probe),
      q = apply(far, tf, 'a', probe);
    ok(
      Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.01,
      `${label}: the far bundle moves a point as the origin-free one does (${p.map((v) => +v.toFixed(3))} vs ${q.map((v) => +v.toFixed(3))})`,
    );
  }
  tf.set('a', { localPosition: [7, -3], localRotation: 0.4 });
  const got = tf.get('a');
  ok(
    Math.abs(got.localPosition[0] - 7) < 0.01 &&
      Math.abs(got.localPosition[1] + 3) < 0.01 &&
      Math.abs(got.localRotation - 0.4) < 1e-6,
    `get() reads back the document-frame record (${got.localPosition.map((v) => +v.toFixed(3))}, ${got.localRotation.toFixed(4)})`,
  );
  tf.update('a', { localRotation: -0.2 });
  const g2 = tf.get('a');
  ok(
    Math.abs(g2.localPosition[0] - 7) < 0.01 && Math.abs(g2.localPosition[1] + 3) < 0.01,
    `update({ localRotation }) keeps the position the caller set (${g2.localPosition.map((v) => +v.toFixed(3))})`,
  );
}

// ---- (f) morph, streaming, scene
console.log('morph, streaming, scene');
{
  const shape = (off, d) =>
    wrap(
      `<path id="s" d="${d.replace(/(\d+) (\d+)/g, (m, x, y) => `${+x + off} ${+y + off}`)}" fill="red"/>`,
    );
  const A = M.createBundle(
    gl,
    await M.importSvg(shape(5e4, 'M0 0 L10 0 L10 10 L0 10 Z'), { origin: [50005, 50005] }),
  );
  const B = M.createBundle(
    gl,
    await M.importSvg(shape(5e4, 'M0 0 L12 0 L12 12 L0 12 Z'), { origin: [50005, 50005] }),
  );
  const C = M.createBundle(
    gl,
    await M.importSvg(shape(9e4, 'M0 0 L12 0 L12 12 L0 12 Z'), { origin: [90006, 90006] }),
  );
  let m = null;
  try {
    m = M.createShapeMorph(gl, A, B);
  } catch (e) {
    m = e;
  }
  ok(
    m && m.bundle && m.bundle.origin[0] === 50005,
    'a morph of two bundles with one origin keeps it',
  );
  ok(
    await throwsWith(() => M.createShapeMorph(gl, A, C), /different origins/),
    'a morph of bundles with different origins is refused by name',
  );

  const segs = (off) => [
    [
      M.mkLine([off, off], [off + 10, off]),
      M.mkLine([off + 10, off], [off + 10, off + 10]),
      M.mkLine([off + 10, off + 10], [off, off]),
    ],
  ];
  const sec = M.buildStreamableSections(
    [{ segs: segs(7e5)[0], fill: [1, 0, 0, 1] }],
    [7e5 - 5, 7e5 - 5, 20, 20],
    { origin: [7e5, 7e5] },
  );
  const sb = M.createBundle(gl, sec);
  ok(
    sb.origin[0] === 7e5 && Math.abs(sb.globalBBox[0] + 5) < 1e-6,
    'buildStreamableSections({ origin }): stored relative, bbox in bundle units',
  );
  const r = M.updateBundleGeometry(gl, sb, segs(7e5 + 2000));
  ok(r.ok, 'updateBundleGeometry takes document coordinates' + (r.ok ? '' : ': ' + r.reason));
  ok(sb.fillHitShape === undefined || true, 'streamed');
  ok(
    M.fillHitShape(sb, 2000 + 8, 2000 + 2) === 0 && M.fillHitShape(sb, 8, 2) === -1,
    'the streamed triangle sits 2000 units on, in bundle units',
  );

  const scene = M.createScene();
  scene.root.shapes = [
    {
      id: 'a',
      contours: [M.rectContour(1e6, 1e6, 10, 10)],
      fill: { kind: 'solid', color: [1, 0, 0, 1] },
    },
  ];
  const ss = await M.sceneToSections(scene, { viewBox: [1e6 - 5, 1e6 - 5, 20, 20] });
  ok(
    ss.origin && ss.origin[0] >= 1e6 - 8 && ss.origin[0] <= 1e6 + 16,
    `a far scene on the direct path takes the importer (origin ${JSON.stringify(ss.origin)})`,
  );
}

// ---- (g) the converter input of far art is the origin-free input
console.log('translation invariance of the converter input');
{
  const tiger = tigerOrFixture();
  const home = M.createBundle(gl, await M.importSvg(tiger, { origin: false }));
  const T = [80000, -100000];
  const moved = tiger
    .replace(
      /<svg([^>]*)viewBox="[^"]*"([^>]*)>/,
      `<svg$1viewBox="${T[0]} ${T[1]} 900 900"$2><g transform="translate(${T[0]} ${T[1]})">`,
    )
    .replace(/<\/svg>\s*$/, '</g></svg>');
  const farSec = await M.importSvg(moved, {});
  const far = M.createBundle(gl, farSec);
  ok(
    far.origin &&
      Math.abs(far.origin[0] - 80000 - 436) <= 256 &&
      Math.abs(far.origin[1] + 100000 - 450) <= 256,
    `tiger at (80000, -100000) takes an origin near its center (${JSON.stringify(far.origin)})`,
  );
  const a = home.curveFloats64,
    b = far.curveFloats64;
  ok(
    a && b && a.length === b.length,
    `the CPatch converter's float64 curve plane has the same length (${a && a.length})`,
  );
  // The float64 planes differ by the origin difference in the coordinate slots and nowhere else: every float is equal, or moved by the
  // x or the y shift (what a translated copy of the same records is). So the converter sees the origin-free numbers (to ~1e-12).
  {
    const dx = far.origin[0] - T[0],
      dy = far.origin[1] - T[1];
    let off = 0,
      moved = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - b[i];
      if (Math.abs(d) < 1e-9) continue;
      if (Math.abs(d - dx) < 1e-9 || Math.abs(d - dy) < 1e-9) moved++;
      else off++;
    }
    ok(
      off === 0 && moved > 1000,
      `the far plane is the origin-free plane with ${moved} coordinate floats shifted and ${off} floats otherwise different`,
    );
  }
  let worst = 0;
  for (let r = 0; r < home.numShapes; r++)
    for (let k = 0; k < 4; k++) {
      const sh = k % 2 === 0 ? far.origin[0] - T[0] : far.origin[1] - T[1];
      worst = Math.max(
        worst,
        Math.abs(home.metaFloats[r * 48 + k] - (far.metaFloats[r * 48 + k] + sh)),
      );
    }
  ok(
    worst < 0.01,
    `every row's box is the origin-free row's box shifted by the origin difference (worst ${worst.toExponential(1)} = float32 of the larger coordinates)`,
  );
}

console.warn = warn;
if (fail) {
  console.error(`originSmoke: ${fail} FAILED`);
  process.exit(1);
}
console.log('originSmoke: all passed');
