// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpSimdCost -- _lbSimdCost's fragment dump for CPATCH: the unified fill draw with every shape's CPatch mesh (tag 14 on the
// shared stream, its curve blocks appended to the curve plane), through test/_lbPipeEmu.mjs's ALU-counting mode. The dump
// is the same [entry, x, row, ops, kind, flavour, tri] rows _lbSimdCost writes (kind 14, flavour 0), so the lockstep
// model and its variants (_lbSimdPartition.mjs) read both engines alike.
//
// The build is the renderer's (cpatchBuild.buildCPatchBundle, unpooled, a stand-in GL that keeps the uploaded plane);
// stroke rows take their cover quads, as on the unified route, and are not in the dump.
//
//   node probes/lbAccuracy/_cpSimdCost.mjs file.svg [N=512] [OUT.json]     DEFINES=MANTLE_CPATCH_HARD (extra defines)
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import(path.join(ROOT, 'src/svg/importer.js'));
const { headlessCPatchBundle, buildCPatchBundle } = await import(
  path.join(ROOT, 'src/renderer/cpatchBuild.js')
);
const { lbScene, renderScene } = await import(path.join(ROOT, 'test/_lbPipeScene.mjs'));
console.warn = () => {};
const FILE = process.argv[2],
  N = +(process.argv[3] || 512),
  OUT = process.argv[4];
const svg = readFileSync(FILE, 'utf8');
const b = headlessCPatchBundle(await importSvg(svg));
let plane = null;
const gl = {
  TEXTURE_2D: 1,
  RGBA32F: 2,
  RGBA: 3,
  FLOAT: 4,
  TEXTURE_MIN_FILTER: 5,
  TEXTURE_MAG_FILTER: 6,
  NEAREST: 7,
  TEXTURE_WRAP_S: 8,
  TEXTURE_WRAP_T: 9,
  CLAMP_TO_EDGE: 10,
  bindTexture() {},
  texParameteri() {},
  texImage2D(...a) {
    plane = a[8];
  },
};
b.curveTex = {};
if (!buildCPatchBundle(gl, b, { pool: false }))
  throw new Error('CPatch built nothing: ' + b._cpatchBail);
const sc = await lbScene(svg, {
  N,
  lb: {
    packed: b._lbMeshes.map((m) => (m ? { verts: m.verts, vertexCount: m.vertexCount } : null)),
  },
});
sc.textures[sc.uniforms.get('uCurveData')] = {
  w: 4096,
  h: plane.length / 16384,
  l: 1,
  data: plane,
};
const vt = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.vert.glsl'), 'utf8');
const ft = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
const r = renderScene(
  sc,
  vt,
  ft,
  ['MANTLE_CPATCH', ...(process.env.DEFINES || '').split(',').filter(Boolean)],
  { alu: true },
);
const frag = [];
for (let q = 0; q < r.recs.length / 9; q++) {
  const t = r.recs[q * 9] | 0,
    e = sc.entries[sc.entryOfTri[t]];
  if (!e || e.kind !== 'lb') continue;
  const f = r.recs[q * 9 + 8];
  frag.push([
    sc.entryOfTri[t],
    r.recs[q * 9 + 1] | 0,
    r.recs[q * 9 + 2] | 0,
    (f % 65536) + 4 * Math.floor(f / 65536),
    14,
    0,
    t,
  ]);
}
if (OUT) writeFileSync(OUT, JSON.stringify(frag));
console.log(
  `${path.basename(FILE)} @ ${N} cpatch (${b._cpatchBuilt} shapes): ${frag.length} fragments${OUT ? ' -> ' + OUT : ''}`,
);
