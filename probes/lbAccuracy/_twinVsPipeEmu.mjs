// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _twinVsPipeEmu — where does the LB CPU twin (_lbRaster.mjs + _lbKernel.mjs, the model behind
// _gpuModelCheck and every LB accuracy number) part from the kernel? Answered against the SHADER ITSELF, run end to end
// by test/_lbPipeEmu.mjs (vertex stage, rasterizer, fragment stage with real 2x2-quad derivatives), with no GPU.
//
// Four images of one asset at CANVAS px, coverage = OVER-composited alpha (tiger is opaque, so the renderer takes the
// no-claim path and this is what its alpha channel holds):
//   twinAll   the twin over every row with curves, meshed and filled (stroke rows included)
//   twinFill  the twin over the rows the fill pass meshes (shapesOf rows: 'fill')
//   emuFull   the unified draw as the renderer builds it: LB meshes for fill rows, cover quads for stroke rows
//   emuLb     the same draw, LB entries only
// and the comparisons that separate the causes:
//   emuFull vs twinAll    what _gpuModelCheck compares (the GPU stands where emuFull does)
//   emuLb   vs twinFill   the kernel, the raster and the composite, on the geometry the twin models
//   twinAll vs twinFill   the twin's stroke rows
//   emuFull vs emuLb      the strokes the twin does not draw
// then, fragment by fragment on the LB meshes (matched by shape, triangle and pixel), where the twin and the shader
// disagree, by the kernel branch that answered.
//
//   node probes/lbAccuracy/_twinVsPipeEmu.mjs [svg]      CANVAS=512   (logs to probes/_lbPipeOut/)
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { shapesOf, viewOf, buildMesh, rasterMesh, fragileMask } from './_lbRaster.mjs';
import { lbScene, renderScene, compositeAlpha } from '../../test/_lbPipeScene.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const N = +(process.env.CANVAS || 512);
const FILE = process.argv[2] || path.join(ROOT, 'examples/tiger.svg');
const OUT = path.join(ROOT, 'probes/_lbPipeOut');
mkdirSync(OUT, { recursive: true });
const warn = console.warn;
console.warn = () => {};
const t0 = Date.now();
const lap = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)} s] ${m}`);
const svg = readFileSync(FILE, 'utf8');

// ── the twin ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const xd = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || xd.DOMParser;
globalThis.XMLSerializer = globalThis.XMLSerializer || xd.XMLSerializer;
const { default: importSvg } = await import('../../src/svg/importer.js');
const { isStrokeRow } = await import('../../src/renderer/engineLedger.js');
const bundle = await importSvg(svg);
const { shapes, bbox } = await shapesOf(bundle);
const fillRows = new Set((await shapesOf(bundle, { rows: 'fill' })).shapes.map((x) => x.s));
const view = viewOf(bbox, N);
const meta = bundle.metaFloats || new Float32Array(bundle.meta, 32),
  st = bundle.metaFloatsPerShape | 0;
const twinAll = new Float64Array(N * N).fill(1),
  twinFill = new Float64Array(N * N).fill(1);
const twinFrag = new Map(); // `${s}:${tri}:${i}:${j}` -> { c, hit }
const twinPk = new Map();
let declined = 0;
for (const sh of shapes) {
  const built = await buildMesh(sh);
  if (!built) {
    declined++;
    continue;
  }
  twinPk.set(sh.s, built.pk);
  rasterMesh(built.pk, view, twinAll, {}, null, null, null);
  if (fillRows.has(sh.s))
    rasterMesh(
      built.pk,
      view,
      twinFill,
      {
        mirroredCornerFrame: process.env.TWIN_MIRRORED_FRAME === '1',
        coarseDeriv:
          (process.env.TWIN_DERIV || (process.env.COARSE === '1' ? 'coarse' : 'fine')) === 'coarse',
        onFrag: (t, i, j, c, hit) => twinFrag.set(`${sh.s}:${t}:${i}:${j}`, { c, hit }),
      },
      null,
      null,
      null,
    );
}
for (const a of [twinAll, twinFill]) for (let k = 0; k < a.length; k++) a[k] = 1 - a[k];
const fr = fragileMask(
  [...twinPk.values()],
  view,
  undefined,
  process.env.COARSE === '1' ? { coarseDeriv: true } : {},
);
lap(
  `twin: ${shapes.length} shapes (${declined} declined), ${twinFrag.size} fill-row fragments, knife-edge set ${fr.n} px`,
);

// ── the shader, end to end ───────────────────────────────────────────────────────────────────────────────────────────
const sc = await lbScene(svg, { N });
let meshSame = 0,
  meshDiff = 0;
for (const [s, pk] of twinPk) {
  const q = sc.lb.packed[s];
  const same =
    q &&
    q.verts &&
    q.vertexCount === pk.vertexCount &&
    q.verts.every((x, k) => Object.is(x, pk.verts[k]));
  if (same) meshSame++;
  else meshDiff++;
}
lap(
  `scene: ${sc.entries.length} entries (${sc.entries.filter((e) => e.kind === 'lb').length} LB, ${sc.entries.filter((e) => e.kind === 'cover').length} cover), ${sc.stream.vc} vertices; meshes identical to the twin's ${meshSame}, different ${meshDiff}`,
);
const vt = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
const ft = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const COARSE = process.env.COARSE === '1';
const r = renderScene(sc, vt, ft, [], { coarse: COARSE });
lap(
  `derivatives: ${COARSE ? 'COARSE (one per quad, at its top-left)' : 'fine (per row and column)'}`,
);
const recs = r.recs,
  nRec = recs.length / 9;
lap(`emulated ${nRec} fragments`);
const entryOf = (t) => sc.entries[sc.entryOfTri[t]];
const emuFull = compositeAlpha(recs, N),
  emuLb = compositeAlpha(recs, N, (t) => entryOf(t) && entryOf(t).kind === 'lb');
writeFileSync(
  path.join(OUT, `images_${N}.json`),
  JSON.stringify({
    N,
    twinAll: Array.from(twinAll),
    twinFill: Array.from(twinFill),
    emuFull: Array.from(emuFull),
    emuLb: Array.from(emuLb),
    fragile: Array.from(fr.mask),
  }),
);

// ── image comparisons ────────────────────────────────────────────────────────────────────────────────────────────────
function cmp(label, a, b) {
  let bad = 0,
    badOut = 0,
    max = 0,
    maxOut = 0,
    aHigh = 0,
    sum = 0;
  for (let k = 0; k < a.length; k++) {
    const d = Math.abs(a[k] - b[k]) * 255;
    sum += d;
    if (d > max) max = d;
    if (d > 4) {
      bad++;
      if (a[k] > b[k]) aHigh++;
    }
    if (!fr.mask[k]) {
      if (d > maxOut) maxOut = d;
      if (d > 4) badOut++;
    }
  }
  console.log(
    `  ${label.padEnd(24)} mean ${(sum / a.length).toFixed(3)}/255  off>4/255 ${String(bad).padStart(6)} px (first higher on ${aHigh})  max ${max.toFixed(1)}  OUTSIDE knife-edge: ${String(badOut).padStart(6)} px, max ${maxOut.toFixed(1)}`,
  );
}
console.log(`\n${path.basename(FILE)} @ ${N} px`);
cmp('emuFull vs twinAll', emuFull, twinAll);
cmp('emuLb   vs twinFill', emuLb, twinFill);
cmp('twinAll vs twinFill', twinAll, twinFill);
cmp('emuFull vs emuLb', emuFull, emuLb);

// ── fragment by fragment, LB fill meshes ─────────────────────────────────────────────────────────────────────────────
const kindOut = r.vert.io.outs.findIndex((o) => o.name === 'vKind'),
  kOff = r.vert.outOff[kindOut];
const byHit = new Map();
const bump = (h, f) => {
  const e =
    byHit.get(h) ||
    byHit
      .set(h, {
        n: 0,
        both: 0,
        diff: 0,
        d8: 0,
        twinOnly: 0,
        emuOnly: 0,
        discTwin: 0,
        discEmu: 0,
        max: 0,
        at: null,
        ex: [],
        emuKinds: {},
      })
      .get(h);
  f(e);
};
// A visible disagreement, recorded with both answers and the shader's kind (twin coverage null = discarded).
const note = (x, key, tc, ec, kind) => {
  x.emuKinds[kind] = (x.emuKinds[kind] || 0) + 1;
  if (x.ex.length < 12)
    x.ex.push(
      `${key} twin ${tc === null ? 'discard' : (tc * 255).toFixed(1)} shader ${ec === null ? 'discard' : (ec * 255).toFixed(1)} kind ${kind}`,
    );
};
const seen = new Set();
for (let q = 0; q < nRec; q++) {
  const t = recs[q * 9] | 0,
    e = entryOf(t);
  if (!e || e.kind !== 'lb') continue;
  const lt = ((t * 3 - e.vStart) / 3) | 0,
    i = recs[q * 9 + 1] | 0,
    j = recs[q * 9 + 2] | 0;
  const key = `${e.shapeIdx}:${lt}:${i}:${j}`;
  seen.add(key);
  const tw = twinFrag.get(key);
  const ed = recs[q * 9 + 7] === 1,
    ec = ed ? null : recs[q * 9 + 6];
  const kind = Math.round(r.vOut[(t * 3 + 2) * r.vert.outN + kOff] * 4) / 4;
  const hit = tw ? tw.hit || 'OTHER' : `(raster: kind ${kind})`;
  bump(hit, (x) => {
    x.n++;
    if (!tw) {
      x.emuOnly++;
      if ((ec || 0) * 255 > 4) note(x, key, null, ec, kind);
      return;
    }
    if (tw.c === null && ed) return;
    if (tw.c === null) {
      x.discTwin++;
      if ((ec || 0) * 255 > 4) {
        x.d8++;
        note(x, key, null, ec, kind);
      }
      return;
    }
    if (ed) {
      x.discEmu++;
      if (tw.c * 255 > 4) {
        x.d8++;
        note(x, key, tw.c, null, kind);
      }
      return;
    }
    x.both++;
    const d = Math.abs(Math.min(1, Math.max(0, tw.c)) - ec);
    if (d > 1e-5) x.diff++;
    if (d * 255 > 4) {
      x.d8++;
      note(x, key, tw.c, ec, kind);
    }
    if (d > x.max) {
      x.max = d;
      x.at = key;
    }
  });
}
for (const [key, tw] of twinFrag)
  if (!seen.has(key))
    bump(tw.hit || 'OTHER', (x) => {
      x.n++;
      x.twinOnly++;
      if (tw.c !== null && tw.c * 255 > 4) x.d8++;
    });
console.log('\nLB fill fragments, twin vs shader, by the branch that answered in the twin:');
console.log(
  '  branch              frags    both   differ  >4/255  twin-only emu-only twin-disc emu-disc   max    at (shape:tri:x:row)',
);
for (const [h, x] of [...byHit].sort((a, b) => b[1].d8 - a[1].d8)) {
  console.log(
    `  ${h.padEnd(18)} ${String(x.n).padStart(7)} ${String(x.both).padStart(7)} ${String(x.diff).padStart(7)} ${String(x.d8).padStart(7)} ${String(x.twinOnly).padStart(9)} ${String(x.emuOnly).padStart(8)} ${String(x.discTwin).padStart(9)} ${String(x.discEmu).padStart(8)} ${(x.max * 255).toFixed(1).padStart(7)}   ${x.at || ''}`,
  );
}
console.log('\nVisible disagreements (>4/255), by twin branch: the shader kinds, and examples');
for (const [h, x] of byHit)
  if (x.ex.length)
    console.log(`  ${h}: shader kinds ${JSON.stringify(x.emuKinds)}\n    ${x.ex.join('\n    ')}`);
console.warn = warn;
lap('done');
