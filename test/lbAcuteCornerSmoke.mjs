// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbAcuteCornerSmoke — a Loop-Blinn line face at a convex corner carries both of the corner's edges.
//
// A straight outline's interior faces ramp their pixels with line rows: the kernel's two-line branch computes the box's
// share of two half-planes exactly (exactBoxCov2). A face that owns an edge along one side and has that edge's end as a
// vertex sits in the corner's wedge, and near the corner a pixel box is cut by both edges. So the splitter takes the
// corner's other edge as the second line, not only a near-antiparallel partner (a thin stroke's opposite wall): with one
// line a star's 38-degree tip paints a whole half-plane, 0.633 of the tip pixel where the path covers 0.494, at both
// lower tips of the star below (384 px, identity).
//
// No GPU. Through the kernel's CPU twin on that star: no pixel of the star is off its exact coverage by more than
// 32/255, and the two lower tip pixels are within it.
import { writeFileSync, mkdtempSync } from 'fs';
import os from 'os';
import path from 'path';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const R = await import('../probes/lbAccuracy/_lbRaster.mjs');
const REF = await import('../probes/lbAccuracy/_lbAaRef.mjs');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const warn = console.warn;
console.warn = () => {};

const N = 384;
const STAR =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  '<path d="M250 60 L280 150 L370 150 L300 205 L325 295 L250 240 L175 295 L200 205 L130 150 L220 150 Z" fill="#000"/></svg>';
const dir = mkdtempSync(path.join(os.tmpdir(), 'lbacute-')),
  file = path.join(dir, 'star.svg');
writeFileSync(file, STAR);
const prev = process.env.PRESERVE_VIEWPORT;
process.env.PRESERVE_VIEWPORT = '1';
const bundle = await R.loadSvg(file);
if (prev === undefined) delete process.env.PRESERVE_VIEWPORT;
else process.env.PRESERVE_VIEWPORT = prev;
const { shapes, bbox } = await R.shapesOf(bundle),
  view = R.viewOf(bbox, N);
const sh = shapes[0],
  built = await R.buildMesh(sh);
const acc = new Float64Array(N * N).fill(1);
R.rasterMesh(built.pk, view, acc, {});
const { rowSpans, contoursToConverter, closed } = await REF.refKit();
const curves = closed(contoursToConverter(sh.contours, null));
let off = 0,
  worst = 0;
const tips = {};
for (let j = 0; j < N; j++) {
  const rc = new Map();
  for (let i = 0; i < N; i++) {
    const mo = 1 - acc[j * N + i],
      ex = REF.exactCov(rowSpans, curves, i, j, view, 64, sh.evenOdd, rc);
    const d = Math.abs(mo - ex);
    if (d > 32 / 255) off++;
    worst = Math.max(worst, d);
    if ((i === 175 || i === 324) && j === 294) tips[i] = { ex, mo };
  }
}
ok(
  Math.abs(tips[175].mo - tips[175].ex) <= 32 / 255 &&
    Math.abs(tips[324].mo - tips[324].ex) <= 32 / 255,
  `the lower tips: (175,294) path ${tips[175].ex.toFixed(3)} drawn ${tips[175].mo.toFixed(3)}; (324,294) path ${tips[324].ex.toFixed(3)} drawn ${tips[324].mo.toFixed(3)}`,
);
ok(
  off === 0,
  `${off} pixels of the star off exact by more than 32/255 (worst ${(worst * 255).toFixed(1)}/255)`,
);

console.warn = warn;
console.log(fail ? `LB-ACUTE-CORNER FAIL (${fail})` : 'LB-ACUTE-CORNER PASS');
process.exit(fail ? 1 : 0);
