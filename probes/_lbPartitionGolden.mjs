// _lbPartitionGolden.mjs — buildLoopBlinnPartition parity goldens (channel-free
// shapes, so the thin-channel clip is inert and the C# identity-clip milestone
// matches). Drives real contours through the JS builder + serializes the mesh.
import { writeFileSync } from 'fs';
import { buildLoopBlinnPartition } from '../src/renderer/lbPartition.js';
import { packLoopBlinnMesh } from '../src/renderer/lbPack.js';
import { _kox, _koy, _koScale } from '../src/renderer/lbContour.js';
import { mkLine, mkQuad, mkCubic } from '../src/primitives/seg.js';

const cases = [];
function run(name, contours) {
  const m = buildLoopBlinnPartition(contours, { fillRule: 'nonzero' });
  const pk = m ? packLoopBlinnMesh(m) : null;
  cases.push({
    name,
    contours: contours.map(c => c.map(s => ({ t: s.type, p1: s.p1, p2: s.p2 || null, p3: s.p3 || null, p4: s.p4 || null, w: s.w ?? null }))),
    mesh: m ? {
      route: m._route,
      interior: Array.from(m.interior),
      interiorEdges: m.interiorEdges ? Array.from(m.interiorEdges) : null,
      quads: m.quads.map(q => ({ tri: Array.from(q.tri), sign: q.sign, w: q.w, fat: q._fat === undefined ? -1 : (q._fat ? 1 : 0), tc: Array.from(q.tc) })),
      cubics: m.cubics.map(c => ({ hull: Array.from(c.hull), klmn: c.klmn ? Array.from(c.klmn) : null, hasF: !c.klmn, sign: c.sign })),
      edges: m.edges.map(e => ({ p1: e.p1, p2: e.p2, nx: e.nx, ny: e.ny })),
      stripArcs: m.stripArcs.length, hulls9: m.hulls9.length, cubicRecs9: m.cubicRecs9.length,
      steiner9: m.steiner9.length, blendTier9: !!m._blendTier9,
    } : null,
    pack: pk ? { verts: Array.from(pk.verts), vertexCount: pk.vertexCount, hasBezout: !!pk.hasBezout } : null,
  });
}

// 1. square (lines only)
run('square', [[mkLine([0, 0], [30, 0]), mkLine([30, 0], [30, 30]), mkLine([30, 30], [0, 30]), mkLine([0, 30], [0, 0])]]);

// 2. one convex quad arc + 3 lines (a bump on the right side)
run('quad-bump', [[
  mkLine([0, 0], [30, 0]),
  mkQuad([30, 0], [42, 15], [30, 30]),
  mkLine([30, 30], [0, 30]),
  mkLine([0, 30], [0, 0]),
]]);

// 3. a convex cubic cap + closing lines (gentle, single-bulge — no fat subdivision)
run('cubic-cap', [[
  mkCubic([0, 20], [8, 4], [22, 4], [30, 20]),
  mkLine([30, 20], [30, 30]),
  mkLine([30, 30], [0, 30]),
  mkLine([0, 30], [0, 20]),
]]);

writeFileSync(new URL('../../csharp_tests/lb-parity/goldens/partition.json', import.meta.url),
  JSON.stringify({ version: 1, kox: _kox, koy: _koy, koScale: _koScale, cases }));
console.log('emitted partition goldens:', cases.map(c => `${c.name}=${c.mesh ? (c.mesh.interior.length / 6 + 'i/' + c.mesh.quads.length + 'q/' + c.mesh.cubics.length + 'c') : 'null'}`).join(' '));
