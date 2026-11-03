// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// maskChildStrokeOmitSmoke -- a bundle with no stroked row anywhere (MANTLE_NO_STROKE) compiles out the inline mask walk's child STROKE
// solve, which is shared with the top-level pass (strokeMinDist) and would otherwise be compiled into every mask-bearing program (a
// large share of the frame on a mask-heavy asset with no strokes, for identical output).
//   * the shader text carries the guard;
//   * the renderer defines MANTLE_NO_STROKE for a masked bundle with NO stroked row, and does NOT for one whose mask child is stroked;
//   * through the float32 pipe emulation of the shipped shader, the stroke-free masked bundle draws the same pixels with and without the
//     define, and the stroked-child bundle draws DIFFERENT pixels without it (the code is live exactly where it must be).
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';
import { createRenderer } from '../src/renderer/renderer.js';
import { createBundle } from '../src/renderer/bundle.js';
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { default: importSvg } = await import('../src/svg/importer.js');
const { lbScene, renderScene, compositeAlpha } = await import('./_lbPipeScene.mjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEN = path.join(ROOT, 'src/shaders/generated');
const vert = readFileSync(path.join(GEN, 'mantle.vert.glsl'), 'utf8'),
  frag = readFileSync(path.join(GEN, 'mantle.frag.glsl'), 'utf8');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

ok(
  /#ifdef MANTLE_NO_STROKE\s*\n\s*const bool cIsStroke = false;\s*\n#else\s*\n\s*bool cIsStroke = cSW > 0\.0/.test(
    frag,
  ),
  'the shader guards the mask child stroke test with MANTLE_NO_STROKE',
);

const ANCH =
  '<rect x="0" y="0" width="0.5" height="0.5" fill="#000"/><rect x="99.5" y="99.5" width="0.5" height="0.5" fill="#000"/>';
const doc = (maskKids) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">${maskKids}</mask></defs>${ANCH}<rect id="t" x="20" y="20" width="60" height="60" fill="#000" mask="url(#m)"/></svg>`;
const FILL_KIDS =
  '<circle cx="40" cy="45" r="18" fill="#fff"/><rect x="45" y="40" width="30" height="25" fill="#fff"/>';
const STROKE_KIDS =
  '<circle cx="40" cy="45" r="18" fill="#fff"/><circle cx="62" cy="55" r="14" fill="none" stroke="#fff" stroke-width="7"/>';
const noStroke = doc(FILL_KIDS),
  stroked = doc(STROKE_KIDS);

// ---- the renderer's defines ----
const { gl } = createFakeGl();
const R = createRenderer(gl, taggedShaderSources(), { cpatchFill: false, psoWarmIdle: () => true });
const defs = async (svg) => R._variantDefinesNow(createBundle(gl, await importSvg(svg)));
const dNo = await defs(noStroke),
  dSt = await defs(stroked);
ok(
  dNo.includes('MANTLE_NO_STROKE') && !dNo.includes('MANTLE_NO_MASK'),
  'a masked bundle with no stroked row gets MANTLE_NO_STROKE and keeps its mask code',
);
ok(
  !dSt.includes('MANTLE_NO_STROKE'),
  'a masked bundle whose mask child is stroked does NOT get MANTLE_NO_STROKE',
);

// ---- the pixels ----
const N = 100;
async function cov(svg, defines) {
  const sc = await lbScene(svg, { N, rows: () => 'cover' });
  const row = (sc.sec.shapeIds || []).findIndex((id) => id === 't' || /^t_/.test(id));
  const ent = new Set(
    sc.entries.map((e, k) => (e.shapeIdx === row ? k : -1)).filter((k) => k >= 0),
  );
  return compositeAlpha(renderScene(sc, vert, frag, defines).recs, N, (tri) =>
    ent.has(sc.entryOfTri[tri]),
  );
}
const diff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const sum = (a) => a.reduce((s, v) => s + v, 0);
const a0 = await cov(noStroke, []),
  a1 = await cov(noStroke, ['MANTLE_NO_STROKE']);
ok(
  sum(a0) > 200 && diff(a0, a1) === 0,
  `stroke-free masked bundle: identical pixels with and without MANTLE_NO_STROKE (ink ${sum(a0).toFixed(1)}, max |diff| ${diff(a0, a1)})`,
);
const b0 = await cov(stroked, []),
  b1 = await cov(stroked, ['MANTLE_NO_STROKE']);
ok(
  sum(b0) > 200 && diff(b0, b1) > 0.2,
  `stroked-child bundle: dropping the stroke solve changes the pixels (max |diff| ${diff(b0, b1).toFixed(3)}), so the code is live where the define is absent`,
);
if (fail) {
  console.error(`FAIL maskChildStrokeOmitSmoke: ${fail}`);
  process.exit(1);
}
console.log('maskChildStrokeOmitSmoke PASS');
