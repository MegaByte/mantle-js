// _lbPairGolden.mjs — buildLoopBlinnPartitionPair parity goldens. Morphs
// channel-free shapes of identical structure; the DST mesh is the transform
// output (SRC = a verified static build). Emits the dst mesh for byte-diff.
import { writeFileSync } from 'fs';
import { buildLoopBlinnPartitionPair } from '../src/renderer/lbPartitionPair.js';
import { mkLine, mkQuad } from '../src/primitives/seg.js';

const cases = [];
function run(name, src, dst) {
  const pr = buildLoopBlinnPartitionPair(src, dst, 'nonzero');
  cases.push({
    name,
    src: src.map(c => c.map(s => ({ t: s.type, p1: s.p1, p2: s.p2 || null, p3: s.p3 || null, p4: s.p4 || null, w: s.w ?? null }))),
    dst: dst.map(c => c.map(s => ({ t: s.type, p1: s.p1, p2: s.p2 || null, p3: s.p3 || null, p4: s.p4 || null, w: s.w ?? null }))),
    pair: pr ? {
      interior: Array.from(pr.dst.interior),
      interiorEdges: pr.dst.interiorEdges ? Array.from(pr.dst.interiorEdges) : null,
      quads: pr.dst.quads.map(q => ({ tri: Array.from(q.tri), sign: q.sign, w: q.w, fat: q._fat === undefined ? -1 : (q._fat ? 1 : 0), tc: Array.from(q.tc) })),
      cubics: pr.dst.cubics.map(c => ({ hull: Array.from(c.hull), klmn: c.klmn ? Array.from(c.klmn) : null, hasF: !c.klmn, sign: c.sign })),
      edges: pr.dst.edges.map(e => ({ p1: e.p1, p2: e.p2, nx: e.nx, ny: e.ny })),
      stripArcs: pr.dst.stripArcs.length,
    } : null,
  });
}

// 1. square → wider rectangle (lines only)
run('square-rect',
  [[mkLine([0, 0], [30, 0]), mkLine([30, 0], [30, 30]), mkLine([30, 30], [0, 30]), mkLine([0, 30], [0, 0])]],
  [[mkLine([0, 0], [40, 0]), mkLine([40, 0], [40, 24]), mkLine([40, 24], [0, 24]), mkLine([0, 24], [0, 0])]]);

// 2. quad-bump → quad-bump with a gentler arc (same structure, no flip/fat change)
run('bump-morph',
  [[mkLine([0, 0], [30, 0]), mkQuad([30, 0], [42, 15], [30, 30]), mkLine([30, 30], [0, 30]), mkLine([0, 30], [0, 0])]],
  [[mkLine([0, 0], [32, 0]), mkQuad([32, 0], [40, 14], [32, 28]), mkLine([32, 28], [0, 28]), mkLine([0, 28], [0, 0])]]);

writeFileSync(new URL('../../csharp_tests/lb-parity/goldens/pair.json', import.meta.url), JSON.stringify({ version: 1, cases }));
console.log('emitted pair goldens:', cases.map(c => `${c.name}=${c.pair ? (c.pair.interior.length / 6 + 'i/' + c.pair.quads.length + 'q') : 'null'}`).join(' '));
