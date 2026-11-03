// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeEntrySmoke.mjs - the NATIVE-only entry (@kontek/mantle/native) has no WebGL engine dependency (node, CPU only).
//
//   1. GRAPH: the module closure of the native entry (static and dynamic imports), alone and with the SVG importer and the text
//      feature, contains no module on the deny list: src/renderer/*, src/shaders/*, the GPU filter evaluator, the GL worker
//      pools, a Web Worker script, or any file whose text touches a WebGL context. With esbuild installed the same deny list is
//      checked against a real bundle's metafile, and the native size is recorded in test/data/buildMatrix.json with a threshold.
//   2. RUN: in a process with no WebGL global and no GL context, the entry loads and draws through the DOM-backed native scene.
//   3. THE REVERSE: backend:'webgl' from the native entry throws, naming the import to add; the root/fallback entry still offers
//      the auto chooser; the native entry does not import it.
//
// The native text bundle is a feature of its own (@kontek/mantle/native/text); asking for it without the import throws, naming it.

import fs from 'node:fs';
import path from 'node:path';
import { closure, chain, rel, PKG } from '../scripts/importGraph.mjs';
import { loadTool, measureMatrix } from '../scripts/measureBuildMatrix.mjs';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);
const check = (name, cond, detail) =>
  cond ? ok(name) : fail(name + (detail ? ': ' + detail : ''));

// ---- 1. the graph ----------------------------------------------------------------------------------------------------------
const DENY_PATH = [
  /^src\/renderer\//,
  /^src\/shaders\//,
  /^src\/filterGraph\/filterGraph\.js$/,
  /^src\/filterGraph\/primitives\//,
  /^src\/filterGraph\/colr\//,
  /\.worker\.js$/,
  /^src\/animation\/(overrides|shapeMorph|shapeAnimation|colorPalette|filterParams)\.js$/,
  /^src\/textBundle\.js$/,
  /^src\/core\/glEpoch\.js$/,
  /^src\/hitTest\//,
];
// A GL context call or type in the file's own text (comments stripped) means the file talks to WebGL.
const GL_TEXT =
  /\b(?:getContext\s*\(\s*['"](?:webgl|experimental-webgl)|WebGL2?RenderingContext|createShader\s*\(|compileShader\s*\(|bindFramebuffer\s*\(|texImage2D\s*\()/;
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

const ENTRIES = {
  native: 'src/fallback/native.js',
  'native/text': 'src/fallback/nativeText.js',
  'native + svg importer': ['src/fallback/native.js', 'src/svg/importer.js'],
};
for (const [name, spec] of Object.entries(ENTRIES)) {
  const all = new Map();
  for (const e of [].concat(spec))
    for (const [k, v] of closure(path.join(PKG, e), { dynamic: true }))
      if (!all.has(k)) all.set(k, v);
  const bad = [];
  for (const f of all.keys()) {
    const r = rel(f);
    if (DENY_PATH.some((re) => re.test(r)))
      bad.push(`${r} (denied path; via ${chain(all, f).join(' > ')})`);
    else if (GL_TEXT.test(stripComments(fs.readFileSync(f, 'utf8'))))
      bad.push(`${r} (touches a WebGL context)`);
  }
  check(
    `${name}: ${all.size} modules reachable, none on the GL deny list`,
    bad.length === 0,
    bad.slice(0, 4).join('; '),
  );
}
const nativeText = fs.readFileSync(path.join(PKG, 'src/fallback/native.js'), 'utf8');
check(
  'the native entry does not import autoScene (the GL-aware chooser)',
  !/autoScene/.test(stripComments(nativeText)),
);

// The package exports name it, with types.
const pj = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
check(
  "package.json exports './native' and './native/text'",
  !!pj.exports['./native'] && !!pj.exports['./native/text'],
);
check(
  'the native text module is in sideEffects (importing it is the registration)',
  pj.sideEffects.includes('./src/fallback/nativeText.js'),
);

// A bundle, when esbuild is present: the same deny list on the metafile, and the recorded size.
const esbuild = await loadTool('esbuild', process.env.MANTLE_BUNDLER_TOOLS);
if (!esbuild)
  console.log(
    'note: esbuild is not installed; the bundle metafile check was skipped (set MANTLE_BUNDLER_TOOLS to a dir with esbuild)',
  );
else {
  const rows = await measureMatrix(esbuild, { only: ['native', 'native+svg', 'native+svg+text'] });
  for (const [k, v] of Object.entries(rows))
    check(
      `bundle '${k}': ${(v.gz / 1024).toFixed(1)} KB gzip, no denied module in the metafile`,
      v.forbidden.length === 0,
      v.forbidden.slice(0, 3).join(', '),
    );
  const rec = JSON.parse(
    fs.readFileSync(path.join(PKG, 'test/data/buildMatrix.json'), 'utf8'),
  ).rows;
  for (const k of ['native', 'native+svg']) {
    const limit = Math.ceil(rec[k].gz * 1.08);
    check(
      `bundle '${k}' stays within 8% of the recorded ${(rec[k].gz / 1024).toFixed(1)} KB`,
      rows[k].gz <= limit,
      `${rows[k].gz} > ${limit}`,
    );
  }
}

// ---- 2. a run with no WebGL --------------------------------------------------------------------------------------------------
check(
  'this process has no WebGL global',
  typeof globalThis.WebGL2RenderingContext === 'undefined' &&
    typeof globalThis.WebGLRenderingContext === 'undefined',
);
const { xmldom, doc } = await import('./_domShim.mjs');
globalThis.DOMParser = xmldom.DOMParser;
globalThis.XMLSerializer = xmldom.XMLSerializer;
if (!globalThis.document) globalThis.document = doc;

const native = await import('../src/fallback/native.js');
const { default: importSvg } = await import('../src/svg/importer.js');
check(
  'the entry exports the scene, override table, morph, timeline, stream, curve decode and chooser',
  [
    'createNativeScene',
    'createNativeOverrideTable',
    'createNativeMorph',
    'createNativeTimeline',
    'updateNativeBundleGeometry',
    'curveRangeToPathD',
    'chooseBackend',
    'createMantleScene',
  ].every((n) => typeof native[n] === 'function'),
);

const sections = await importSvg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect id="r" x="10" y="10" width="40" height="30" fill="#f00"/><circle id="c" cx="70" cy="70" r="15" fill="#00f"/></svg>',
  { retainSource: true },
);
const host = doc.createElement('div');
const scene = await native.createMantleScene(host, { backend: 'native', document: doc });
check(
  'createMantleScene resolves to the native backend with no gl',
  scene.backend === 'native' && scene.gl === null && scene.renderer === null,
);
check(
  'the shared draw surface is there',
  [
    'setViewport',
    'beginFrame',
    'drawBundle',
    'endFrame',
    'toScene',
    'createOverrideTable',
    'createMorph',
    'createTimeline',
    'createTextBundle',
    'createPalette',
    'dispose',
  ].every((n) => typeof scene[n] === 'function'),
);
scene.setViewport(200, 200);
scene.beginFrame([1, 1, 1, 1]);
const table = scene.createOverrideTable(sections);
table.set('r', { tint: [0, 1, 0, 1] });
scene.drawBundle(scene.toScene(sections), { overrides: table });
scene.endFrame();
const svg = new xmldom.XMLSerializer().serializeToString(scene.svg || host);
check(
  'the frame drew the retained shapes as SVG',
  /<rect/.test(svg) && /<circle/.test(svg),
  svg.slice(0, 160),
);
check(
  'hit tests work on the bundle without a renderer',
  (await import('../src/hitTest/hitTest.js')).fillHitId(sections, 20, 20) != null,
);
scene.dispose();

const chosen = native.chooseBackend(host, {});
check(
  'chooseBackend() in the native entry is always native',
  chosen.backend === 'native' && chosen.gl === null,
);

// ---- 3. the reverse ------------------------------------------------------------------------------------------------------------
let err = null;
try {
  await native.createMantleScene(host, { backend: 'webgl' });
} catch (e) {
  err = e;
}
check(
  "backend:'webgl' from the native entry throws, naming the import to add",
  !!err && /@kontek\/mantle\/fallback/.test(err.message) && /native-only/.test(err.message),
  err && err.message,
);
try {
  native.chooseBackend(host, { backend: 'webgl' });
  err = null;
} catch (e) {
  err = e;
}
check(
  "chooseBackend({ backend: 'webgl' }) throws the same way",
  !!err && /@kontek\/mantle\/fallback/.test(err.message),
);

const s2 = await native.createMantleScene(host, { backend: 'native', document: doc });
err = null;
try {
  await s2.createTextBundle({});
} catch (e) {
  err = e;
}
check(
  "scene.createTextBundle() without the text feature throws, naming '@kontek/mantle/native/text'",
  !!err && /@kontek\/mantle\/native\/text/.test(err.message),
  err && err.message,
);
await import('../src/fallback/nativeText.js');
err = null;
try {
  await s2.createTextBundle({});
} catch (e) {
  err = e;
}
check(
  'after importing the text feature the request reaches the text engine (its own validation answers, not the missing-feature error)',
  !err || !/native\/text/.test(err.message),
  err && err.message,
);
s2.dispose();

// The full entry still has the chooser and loads the GL backend lazily (a dynamic import), so a native-only app never reaches it.
const full = fs.readFileSync(path.join(PKG, 'src/fallback/autoScene.js'), 'utf8');
check(
  'the auto chooser reaches the WebGL renderer only through dynamic import()',
  /import\('\.\.\/renderer\/renderer\.js'\)/.test(full) && !/^import .*renderer\//m.test(full),
);
const fallbackIdx = await import('../src/fallback/index.js');
check(
  "'@kontek/mantle/fallback' still exports the auto chooser",
  typeof fallbackIdx.createMantleScene === 'function' &&
    typeof fallbackIdx.chooseBackend === 'function',
);
check(
  'the two choosers are different functions (the native one never probes WebGL)',
  fallbackIdx.createMantleScene !== native.createMantleScene,
);

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('nativeEntrySmoke: PASS');
