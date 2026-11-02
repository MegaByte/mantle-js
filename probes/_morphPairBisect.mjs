// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _morphPairBisect.mjs — does every smooth-cubic morph still build a GPU morph pair? For `git bisect run`.
//
// Exit 0 when fast (circle->ellipse), holed (ring->ring, even-odd) and the unifiedMorphSmoke solid morph (circle ->
// irregular 4-cubic) all get a morph mesh from buildMorphShape; 1 when any does not; 125 when this tree cannot run the
// check (a module or export it needs does not exist yet), so bisect skips the commit instead of blaming it.
//
//   node probes/_morphPairBisect.mjs
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = (p) => pathToFileURL(path.join(ROOT, p)).href;
const skip = (why) => {
  console.log('SKIP ' + why);
  process.exit(125);
};

let importSvg, parseMetaBin, curveRangeToContours, buildMorphShape;
try {
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  ({ default: importSvg } = await import(R('src/svg/importer.js')));
  ({ parseMetaBin } = await import(R('src/renderer/bundle.js')));
  ({ curveRangeToContours } = await import(R('src/renderer/loopBlinn.js')));
  ({ buildMorphShape } = await import(R('src/renderer/lbMorphCore.js')));
} catch (e) {
  skip('imports: ' + String((e && e.message) || e).slice(0, 160));
}
if (!importSvg || !parseMetaBin || !curveRangeToContours || !buildMorphShape)
  skip('missing export');

const K = 0.5522847498;
const ellipsePath = (cx, cy, rx, ry) =>
  `M ${cx + rx} ${cy} ` +
  `C ${cx + rx} ${cy - K * ry} ${cx + K * rx} ${cy - ry} ${cx} ${cy - ry} ` +
  `C ${cx - K * rx} ${cy - ry} ${cx - rx} ${cy - K * ry} ${cx - rx} ${cy} ` +
  `C ${cx - rx} ${cy + K * ry} ${cx - K * rx} ${cy + ry} ${cx} ${cy + ry} ` +
  `C ${cx + K * rx} ${cy + ry} ${cx + rx} ${cy + K * ry} ${cx + rx} ${cy} Z`;
const svg = (vb, d, extra = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><path d="${d}" fill="#3366cc" ${extra}/></svg>`;
const ring = (a, b, c, d) =>
  svg(
    '0 0 200 200',
    `${ellipsePath(100, 100, a, b)} ${ellipsePath(100, 100, c, d)}`,
    'fill-rule="evenodd"',
  );
const A = 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z';
const B = 'M20 8 C28 2 34 10 33 20 C32 30 28 34 20 33 C11 32 6 28 7 20 C8 10 12 2 20 8 Z';
const CASES = {
  fast: [
    svg('0 0 200 200', ellipsePath(100, 100, 60, 60)),
    svg('0 0 200 200', ellipsePath(100, 100, 80, 40)),
  ],
  holed: [ring(70, 70, 35, 35), ring(80, 50, 40, 25)],
  solid: [svg('0 0 40 40', A), svg('0 0 40 40', B)],
};

let bad = 0;
for (const [name, [s, d]] of Object.entries(CASES)) {
  let ok = false,
    note = '';
  try {
    const pose = async (x) => {
      const b = await importSvg(x, { preserveViewport: true });
      const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
      const cf = new Float32Array(b.curves),
        r = b.curveRangesByShape[0];
      return { pm, contours: curveRangeToContours(cf, r.begin, r.end) };
    };
    const S = await pose(s),
      D = await pose(d);
    const res = buildMorphShape(
      S.contours,
      D.contours,
      S.pm.metaFloats,
      D.pm.metaFloats,
      0,
      S.pm.floatsPerShape,
    );
    ok = !!(res && res.mesh);
    note = ok
      ? `${res.mesh.segments ? 'segmented' : 'pair'} ${res.mesh.vertexCount} verts`
      : 'no mesh';
  } catch (e) {
    note = 'threw ' + String((e && e.message) || e).slice(0, 120);
  }
  console.log(`${ok ? 'ok  ' : 'BAD '} ${name}: ${note}`);
  if (!ok) bad++;
}
process.exit(bad ? 1 : 0);
