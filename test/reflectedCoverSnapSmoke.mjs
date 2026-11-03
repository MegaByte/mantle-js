// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// reflectedCoverSnapSmoke -- a mirrored or anisotropic axis-aligned map is no less accurate under the exact-cover reach
// than under the baseline margin policy (no vertex rounding), against an independent exact pixel-box reference.
//
// The sign of the determinant does not matter. A rasterizer rounds each vertex to a 1/256 px grid while vEmCoord stays an
// exact function of the unrounded vertex, so an edge pixel's coverage moves with where the dilated corner lands on the grid.
// A half-pixel dilation (an isotropic axis-aligned map) lands on the corner's own fraction and rounds the same under
// both margins; the wider anisotropic margin of a mirrored map lands elsewhere, and the pixels it moves can move away from
// the reference. The vertex stage rounds a plain cover vertex onto the grid itself and moves vEmCoord by
// the same displacement, so the rasterizer's rounding is the identity and the margin cannot matter.
//
// The vertex and fragment stages are the generated texts run on the CPU (test/_lbPipeEmu.mjs) with the rasterizer's vertex
// rounding enabled (snap 256), the plain cover draw the fill program issues. Contract:
//   (a) for every (shape, kernel, map) the current margin is no worse than the baseline one in mean AND maximum error
//       against test/_boxCoverageReference.mjs, with ZERO slack;
//   (b) under a non-similarity map every plain cover vertex the current vertex stage emits lies on the 1/256 px grid;
//   (b') a similarity (the axis map) is left to the rasterizer: its output is the vertex stage without the rounding, bit for bit;
//   (c) mutation: with the rounding removed the mirrored map is measurably worse than the baseline margin.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { hasLbPipeEmu, buildVert, runVert, buildFrag, runRaster } = await import('./_lbPipeEmu.mjs');
if (!hasLbPipeEmu()) {
  console.log('SKIP reflectedCoverSnapSmoke: needs a C++17 compiler and clang');
  process.exit(77);
}
const { lbScene, attrsOf } = await import('./_lbPipeScene.mjs');
const { edgeSamples } = await import('./_boxCoverageReference.mjs');
console.warn = () => {};
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const GEN = path.join(ROOT, 'src/shaders/generated');
const VERT = readFileSync(path.join(GEN, 'mantle.vert.glsl'), 'utf8');
const FRAG = readFileSync(path.join(GEN, 'mantle.frag.glsl'), 'utf8');
const fixture = JSON.parse(
  readFileSync(path.join(ROOT, 'test/fixtures/cover-projection-scales.json')),
);
// The baseline margin policy, as test/coverProjectionScaleGpuSmoke.mjs restores it: the Slug support only under AAC, and
// the exact-cover reach (uCoverAaReach) only for AAC under a rotated map.
const guard = VERT.split('\n').find((l) =>
  l.startsWith('#if defined(MANTLE_AAC) || (!defined(MANTLE_NO_COVER_FILL)'),
);
const SNAP_GATE = 'if (plainCover && clip3.z > 0.0 &&';
const NOSNAP = VERT.replace(SNAP_GATE, 'if (false &&');
// The baseline policy rounds no vertex either.
const HIST = NOSNAP.replace(
  /if \(abs\(denom\) <= [^;]+;/,
  'if (abs(denom) < 1e-12) return vec2(0.0);',
).replace(guard, '#ifdef MANTLE_AAC');
if (!VERT.includes(SNAP_GATE) || HIST === VERT) {
  ok(false, 'the shipped vertex text carries the rounding and the baseline rewrite applies');
  process.exit(1);
}

const MAPS = {
  axis: null,
  scaled: [0.8, 0, 0, 0, 0.8, 0, 0, 0, 1],
  reflected: [-0.94, 0, 0, 0, 0.87, 0, 0, 0, 1],
  anisotropic: [0.94, 0, 0, 0, 0.87, 0, 0, 0, 1],
  'mirrored-y': [0.94, 0, 0, 0, -0.87, 0, 0, 0, 1],
};

/// Alpha per pixel (row 0 = top) of the plain cover draw: one scene, the given vertex text, kernel and reach; the vertex
/// outputs come back too so the grid can be inspected.
async function draw(svg, N, world, vertText, kernel, reach) {
  const sc = await lbScene(svg, {
    layout: 'wide',
    N,
    rows: () => 'cover',
    importOpts: { preserveViewport: true },
    world,
  });
  const defs = [];
  if (kernel === 'AAC') {
    defs.push('MANTLE_AAC');
    if ((sc.sec.flags | 0) & 8) defs.push('MANTLE_AAC_PAIR_BANDS');
  }
  sc.uniforms.set('uCoverAaReach', reach);
  const st = sc.stream,
    attrs = attrsOf(st.verts, st.vc, st.stride, st.attribs);
  const vert = buildVert(vertText, defs),
    vOut = runVert(vert, sc.textures, sc.uniforms, attrs, st.vc);
  const n = (st.vc / 3) | 0,
    tris = new Int32Array(n * 3);
  for (let i = 0; i < n * 3; i++) tris[i] = i;
  const r = runRaster(
    buildFrag(FRAG, defs, { snap: 256 }),
    vert,
    vOut,
    tris,
    sc.textures,
    sc.uniforms,
    N,
    N,
    null,
  );
  const a = new Float64Array(N * N);
  for (let q = 0; q < r.recs.length / 9; q++) {
    const o = q * 9;
    if (r.recs[o + 7] === 1) continue;
    const k = (r.recs[o + 2] | 0) * N + (r.recs[o + 1] | 0);
    a[k] = 1 - (1 - a[k]) * (1 - r.recs[o + 6]);
  }
  return { a, vOut, vert, vc: st.vc };
}

/// Mean and maximum alpha-byte error over the reference's edge pixels and neighbors (the readback is 8-bit).
function error(a, samples, N) {
  let sum = 0,
    max = 0;
  for (const s of samples) {
    const e = Math.abs(Math.round(a[s.y * N + s.x] * 255) / 255 - s.area) * 255;
    sum += e;
    max = Math.max(max, e);
  }
  return { mean: sum / samples.length, max };
}

const results = [];
for (const shape of ['rect', 'circle']) {
  const c = fixture.cases.find((x) => x.name === shape + '-0-axis');
  const opacity = +/fill-opacity="([^"]+)"/.exec(c.svg)[1];
  for (const [mapName, W] of Object.entries(MAPS)) {
    const samples = edgeSamples(c.svg, c.size, W, opacity);
    for (const kernel of ['Slug', 'AAC']) {
      const hist = await draw(
        c.svg,
        c.size,
        W,
        HIST,
        kernel,
        kernel === 'AAC' && W && (W[1] || W[3]) ? 1 : 0,
      );
      const cur = await draw(c.svg, c.size, W, VERT, kernel, 1);
      const h = error(hist.a, samples, c.size),
        q = error(cur.a, samples, c.size);
      if (kernel === 'Slug' && (mapName === 'axis' || mapName === 'scaled')) {
        const ns = await draw(c.svg, c.size, W, NOSNAP, kernel, 1);
        ok(
          cur.a.every((v, i) => v === ns.a[i]),
          `${shape} ${mapName}: a similarity is drawn exactly as without the rounding`,
        );
      }
      results.push({ shape, mapName, kernel, h, q });
      ok(
        q.mean <= h.mean && q.max <= h.max,
        `${shape} ${mapName} ${kernel}: mean ${q.mean.toFixed(4)} (hist ${h.mean.toFixed(4)}), max ${q.max.toFixed(4)} (hist ${h.max.toFixed(4)})`,
      );
      // (b) the quad's vertices on the grid. gl_Position is window-normalized: x_win = (ndc + 1) * N / 2.
      const stride = cur.vert.outN;
      let off = 0;
      for (let v = 0; v < cur.vc; v++) {
        const w = cur.vOut[v * stride + 3];
        for (let k = 0; k < 2; k++) {
          const win = (cur.vOut[v * stride + k] / w + 1) * 0.5 * c.size,
            g = win * 256;
          if (Math.abs(g - Math.round(g)) > 1e-3) off++;
        }
      }
      if (kernel === 'Slug' && shape === 'rect' && mapName !== 'axis' && mapName !== 'scaled')
        ok(off === 0, `${mapName}: every cover vertex lies on the 1/256 px grid (${off} off)`);
    }
  }
}

// (c) mutation: remove the rounding and the mirrored rect is worse than the baseline margin.
{
  const c = fixture.cases.find((x) => x.name === 'rect-0-axis'),
    W = MAPS.reflected;
  const samples = edgeSamples(c.svg, c.size, W, 0.45);
  const h = error((await draw(c.svg, c.size, W, HIST, 'Slug', 0)).a, samples, c.size);
  const m = error((await draw(c.svg, c.size, W, NOSNAP, 'Slug', 1)).a, samples, c.size);
  ok(
    m.mean > h.mean && m.max > h.max,
    `mutation (no vertex rounding): mirrored rect mean ${m.mean.toFixed(4)} max ${m.max.toFixed(4)} vs baseline ${h.mean.toFixed(4)} / ${h.max.toFixed(4)}`,
  );
}
console.log(
  fail
    ? `\nREFLECTED COVER SNAP FAIL (${fail})`
    : `\nreflectedCoverSnapSmoke PASS (${results.length} shape x map x kernel comparisons, zero slack)`,
);
process.exit(fail ? 1 : 0);
