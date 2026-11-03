// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/perf/lbDrawEmission.mjs — what the Loop-Blinn draw actually emits, per kind, per segment, over
// the corpus — and which of five performance claims about it survive a count.
//
// GL-FREE. Every number is read off the PACKED VERTEX STREAM the renderer uploads, built by the
// real `buildLbBundle`. The stream is 24 floats a vertex: [0,1] position, [2,3,4] aTC, [5] kind
// (+0.25 when the blend tier is flagged), [6] sign. Kind and aTC.x are all this needs, and they
// are the same two values the fragment dispatch reads.
//
//   node probes/perf/lbDrawEmission.mjs            # corpus
//   only=tiger node probes/perf/lbDrawEmission.mjs # one asset, verbose
//
// ── THE CLAIMS, AND WHAT A COUNT CAN SAY ABOUT each ─────────────────────────────────────────
//
// A. "kind-12 axis-aligned bands". STRUCTURAL, confirmed by reading the packer: the kind-12
//    band's six vertices are placed at (bx0,by0)..(bx1,by1), an AXIS-ALIGNED box over the
//    curve's control points (lbPack.js, the sv12 emit). The alternative is an oriented band
//    following the chord.
//    What this probe contributes is the SIZE of the prize: the share of LB vertices that are
//    kind 12, below.
//
// B. "the fast path over-tessellates quads 4.8-5.8x". MEASURED HERE, and stated as what it is:
//    vertices emitted per source segment, by segment type, over shapes that contain ONE type.
//    A ratio needs a denominator, and the claim does not give one; this prints the whole
//    distribution so the claim can be checked against a stated baseline rather than recalled.
//
// C. "chainBoxCov is 60-70% of tiger's LB draw". NOT A COUNT — it is a share of frame time and
//    only a GPU can say it. What this prints is the share of VERTICES whose fragments reach
//    chainBoxCov at all (kind 0 in chain mode, plus every kind 13), which is the upper bound on
//    how much of the draw it could be. The GPU removal A/B below is the measurement.
//
// D. "no early-outs in the arc and band kernels". PARTLY FALSE AS WRITTEN: chainBoxCov opens
//    with an exact bbox early-out (unconditional; with it removed tiger's LB draw measured
//    11-33% slower), and the kind-12 band has its own span tests.
//
// E. "conicChainBoxCov compiled into every program". FALSE: there is no conic chain kernel in the
//    shaders.
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../..');
const REPO = path.resolve(JS, '..');

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(path.join(JS, 'src/svg/importer.js'));
const { parseMetaBin } = await import(path.join(JS, 'src/renderer/bundle.js'));
const { buildLbBundle } = await import(path.join(JS, 'src/renderer/lbBuildCore.js'));
const { curveRangeToContours } = await import(path.join(JS, 'src/geom/lbContour.js'));

const LB_VERT_FLOATS = 24;
const KIND_NAME = {
  0: 'INTERIOR',
  2: 'CUBIC',
  4: 'CUBIC_BEZ',
  5: 'ARC',
  6: 'DISC(legacy)',
  7: 'DISC',
  10: 'EDGE_STRIP',
  12: 'CURVE_BAND',
  13: 'CHAIN_STRIP',
  14: 'CPATCH',
};
const SEG_NAME = ['LINE', 'QUAD', 'CUBIC', 'RQUAD'];

const dirs = [path.join(REPO, 'MantleSamples/Assets/Mantle'), path.join(REPO, 'fixtures/svg')];
const files = [];
for (const d of dirs) {
  try {
    for (const f of readdirSync(d)) if (f.endsWith('.svg')) files.push(path.join(d, f));
  } catch {}
}
files.sort();
const only = process.env.ONLY ? files.filter((f) => f.includes(process.env.ONLY)) : files;
const VERBOSE = !!process.env.VERBOSE || !!process.env.ONLY;

const kindTot = new Map(); // kind -> verts, corpus-wide
let vertTot = 0;
let chainReach = 0; // verts whose fragments can reach chainBoxCov
let assetsWithLb = 0,
  assetsWithBand = 0;
// verts per source segment, for shapes whose segments are ALL one type
const perType = [[], [], [], []];

for (const f of only) {
  let sec, pm, res;
  try {
    sec = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
    pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
    res = buildLbBundle({
      curveFloats: new Float32Array(sec.curves),
      metaFloats: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      ranges: sec.curveRangesByShape,
      numShapes: sec.numShapes,
    });
  } catch {
    continue;
  }
  const curves = new Float32Array(sec.curves);
  let aV = 0,
    aBand = 0;
  const aKind = new Map();
  for (let s = 0; s < (sec.numShapes | 0); s++) {
    const pk = res.packed[s];
    if (!pk || pk.slug || !(pk.vertexCount | 0)) continue;
    const n = pk.vertexCount | 0,
      v = pk.verts;
    aV += n;
    vertTot += n;
    // which segment types does this shape hold?
    let segs = 0;
    const types = new Set();
    try {
      const r = sec.curveRangesByShape[s];
      const contours = curveRangeToContours(curves, r.begin, r.end);
      for (const c of contours || [])
        for (const sg of c) {
          segs++;
          types.add(sg.type | 0);
        }
    } catch {
      segs = 0;
    }
    for (let i = 0; i < n; i++) {
      const o = i * LB_VERT_FLOATS;
      const k = Math.floor(v[o + 5] + 0.5);
      aKind.set(k, (aKind.get(k) || 0) + 1);
      kindTot.set(k, (kindTot.get(k) || 0) + 1);
      if (k === 12) aBand++;
      if (k === 13) {
        chainReach++;
        continue;
      }
      if (k === 0 && v[o + 2] > 1.5) chainReach++;
    }
    if (segs > 0 && types.size === 1) {
      const t = [...types][0];
      if (t >= 0 && t < 4) perType[t].push(n / segs);
    }
  }
  if (!aV) continue;
  assetsWithLb++;
  if (aBand) assetsWithBand++;
  if (VERBOSE) {
    const parts = [...aKind.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, c]) => `${KIND_NAME[k] || k}:${c}`)
      .join(' ');
    console.log(`  ${path.basename(f).padEnd(30)} verts ${String(aV).padStart(7)}  ${parts}`);
  }
}

console.log(`\n== corpus vertex survey (${assetsWithLb} assets with Loop-Blinn meshes) ==`);
const rows = [...kindTot.entries()].sort((a, b) => b[1] - a[1]);
for (const [k, c] of rows) {
  console.log(
    `  kind ${String(k).padStart(2)} ${(KIND_NAME[k] || '?').padEnd(14)} ${String(c).padStart(9)} verts  ${((100 * c) / vertTot).toFixed(1)}%`,
  );
}
console.log(`  total ${vertTot} verts`);

console.log('\n== A: how much of the stream is the axis-aligned kind-12 band ==');
{
  const band = kindTot.get(12) || 0;
  console.log(
    `  kind 12: ${band} verts, ${((100 * band) / vertTot).toFixed(1)}% of the corpus stream,` +
      ` present on ${assetsWithBand} of ${assetsWithLb} assets.`,
  );
  console.log('  Its six vertices are an AXIS-ALIGNED box over the curve (lbPack sv12), so its');
  console.log("  fragment count is the box area, not the band area. An oriented band's prize is");
  console.log('  bounded by the share above.');
}

console.log('\n== B: vertices emitted per source segment, single-type shapes only ==');
for (let t = 0; t < 4; t++) {
  const a = perType[t];
  if (!a.length) {
    console.log(`  ${SEG_NAME[t].padEnd(6)} (no single-type shapes in the corpus)`);
    continue;
  }
  a.sort((x, y) => x - y);
  const mean = a.reduce((s, x) => s + x, 0) / a.length;
  const med = a[a.length >> 1];
  console.log(
    `  ${SEG_NAME[t].padEnd(6)} shapes ${String(a.length).padStart(4)}   verts/segment` +
      `  min ${a[0].toFixed(1)}  median ${med.toFixed(1)}  mean ${mean.toFixed(1)}  max ${a[a.length - 1].toFixed(1)}`,
  );
}
console.log('  READ THIS AS A RATIO ONLY AGAINST A STATED BASELINE. The minimum a quadratic');
console.log('  crescent needs is 3 vertices (one control triangle); the builder also emits the');
console.log('  interior it ramps against, the exterior band, and the chain strips, which are');
console.log('  different geometry rather than a finer tessellation of the same geometry. The');
console.log('  claim of "4.8-5.8x" has no denominator, so it is neither confirmed nor refuted');
console.log('  here — it is replaced by the distribution above.');

console.log('\n== C: what can reach the chain kernels at all ==');
console.log(
  `  chainBoxCov reachable from ${chainReach} verts (${((100 * chainReach) / vertTot).toFixed(1)}% of the stream)`,
);

console.log(`
== WHAT NEEDS A GPU, AND EXACTLY WHAT TO FILL IN =============================================

GPU  Is chainBoxCov really 60-70% of tiger's LB draw?
  The share of a draw a FUNCTION takes cannot be counted, and it cannot be read off a GPU timer
  either (a timer cannot see which instructions ran). Measure it by REMOVAL, which is what the
  kernel's own switches are for:
    arm A: default.
    arm C: a build with the chain branch replaced by return 1.0 — renders WRONG on purpose,
           read the timer only, and CHECK debugStats.engines.draws is unchanged (a shader that
           failed to compile falls back to Slug and would read as a triumph).
  asset:  tiger.svg, 512 and 1024, REPEAT>=8, pinned with setFillEngine({route:'lb'}) — never
          fillDefines, which rides a different route.
  control: A/A first; interleaved arms; only within-run ratios count.
  PREDICTION: C - A is the kernel's share. If it comes out near 60-70% the figure stands;
  if it comes out under 30% the figure predates chainBoxCov's bbox early-out in _boxCov.glsl.
  fill in: A/A ____ %  |  C/A ____ x  |  verdict ____

GPU  An oriented kind-12 band.
  The axis-aligned band's cost is (box area - band area) x its fragment cost, and the survey
  above says kind 12 is a large share of the stream. Arms: default vs a build with an oriented
  band. Assets: the ones the survey shows with the highest kind-12 share. Gate: this one is NOT byte-identical by
  construction (different geometry), so it needs the AA metric, not byte identity — run it
  through probes/_zzEnginePaint.mjs and report wrong-solid and AA mean as well as the time.
  fill in: A/A ____ %  |  ____ x  |  wrong solid A ____ B ____  |  AA mean A ____ B ____
`);
