// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// missingRegistrationSmoke.mjs - a feature used without its registration says exactly which import to add (node, CPU only).
//
// Optional features are opt-in subpaths. For each one this reaches the feature from content or from an explicit request WITHOUT
// importing it, and checks the outcome (a throw for an explicit request, one warning for content the library degrades) names the
// exact subpath and call; then it imports the feature and checks the message is gone and the feature works.
//
//   renderer features      cpatchFill / cpatchAuto / setFillEngine({route:'cpatch'}) / setFillPolicyOptions({cpatchAuto}) / exportFrameSVG()
//   filter + COLR nodes    a node type with no handler: the table maps every registered type to the module that registers it
//   script shapers, bidi   Arabic, Indic, Thai, Khmer/Myanmar, Hangul jamo and right-to-left text without their modules
//   table readers          a font that HAS COLR / SVG / fvar / MATH ... data and no reader for it
//   SVG-in-OT import       the reader is there and the importer seam is not
//   native text            scene.createTextBundle() on the native entry (nativeEntrySmoke holds that one)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeGl, taggedShaderSources } from './_fakeGl.mjs';
import { setDiagnostics } from '../src/core/diagnostics.js';
import { _resetMissingFeatureWarnings } from '../src/core/missingFeature.js';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('ok', name);
  else {
    failures++;
    console.error('FAIL', name, detail === undefined ? '' : String(detail).slice(0, 300));
  }
};

const x = await import('@xmldom/xmldom');
globalThis.DOMParser = x.DOMParser;
globalThis.XMLSerializer = x.XMLSerializer;

const warns = [];
setDiagnostics({ onWarn: (...a) => warns.push(a.join(' ')) });
const take = () => warns.splice(0);
const addsImport = (msg, sub, call) =>
  msg.includes(`Add: import '${sub}'`) && (!call || msg.includes(call));

// ---- renderer features: the minimal renderer imports none of them ----------------------------------------------------------
const { createRenderer } = await import('../src/renderer/renderer.js');
const { hasRendererFeature, registeredRendererFeatures } =
  await import('../src/renderer/featureRegistry.js');
check(
  'the renderer module alone registers no feature',
  registeredRendererFeatures().length === 0,
  registeredRendererFeatures().join(),
);

const mk = (o = {}) => createRenderer(createFakeGl().gl, taggedShaderSources(), o);
const throwsOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};
let e = throwsOf(() => mk({ cpatchFill: true }));
check(
  'createRenderer({ cpatchFill: true }) throws, naming the cpatch feature import',
  !!e && addsImport(e.message, '@kontek/mantle/renderer/features/cpatch'),
  e && e.message,
);
e = throwsOf(() => mk({ cpatchAuto: true }));
check(
  'createRenderer({ cpatchAuto: true }) throws the same way',
  !!e && addsImport(e.message, '@kontek/mantle/renderer/features/cpatch'),
  e && e.message,
);

const R = mk({ captureFrames: true });
check(
  'a renderer without options needs neither feature',
  !!R && typeof R.exportFrameSVG === 'function',
);
for (const sel of [{ route: 'cpatch' }, { route: 'cpatch-auto' }, { cpatch: true }]) {
  e = throwsOf(() => R.setFillEngine(sel));
  check(
    `setFillEngine(${JSON.stringify(sel)}) throws, naming the cpatch feature import`,
    !!e && addsImport(e.message, '@kontek/mantle/renderer/features/cpatch'),
    e && e.message,
  );
}
e = throwsOf(() => R.setFillPolicyOptions({ cpatchAuto: true }));
check(
  'setFillPolicyOptions({ cpatchAuto: true }) throws, naming the cpatch feature import',
  !!e && addsImport(e.message, '@kontek/mantle/renderer/features/cpatch'),
  e && e.message,
);
check(
  'the refused requests changed nothing',
  R.getFillEngine().route !== 'cpatch' && R.getFillPolicyOptions().cpatchAuto !== true,
);
R.setFrameCapture(true);
try {
  await R.exportFrameSVG();
  e = null;
} catch (err) {
  e = err;
}
check(
  'exportFrameSVG() without the frameExport feature rejects, naming its import',
  !!e && addsImport(e.message, '@kontek/mantle/renderer/features/frameExport'),
  e && e.message,
);
check(
  'the stats read works without the cpatch feature (zeros)',
  R.debugStats.cpatchConvStalled === 0,
);

await import('../src/renderer/features/cpatch.js');
await import('../src/renderer/features/frameExport.js');
check(
  'importing the feature modules registers them',
  hasRendererFeature('cpatch') && hasRendererFeature('frameExport'),
);
check(
  'createRenderer({ cpatchFill: true }) then builds',
  throwsOf(() => mk({ cpatchFill: true })) === null,
);
check(
  'setFillEngine({ route: "cpatch" }) then succeeds',
  throwsOf(() => mk().setFillEngine({ route: 'cpatch' })) === null,
);
const R2 = mk({ captureFrames: true });
let svgOut = null;
try {
  svgOut = await R2.exportFrameSVG({ document: (await import('./_domShim.mjs')).doc });
} catch (err) {
  svgOut = String(err.message);
}
check(
  'exportFrameSVG() then reaches the exporter (no missing-feature error)',
  typeof svgOut === 'string' && !/Add: import/.test(svgOut),
  svgOut,
);

// ---- filter and COLR nodes -------------------------------------------------------------------------------------------------
const { warnUnregisteredNode, handlerModuleFor, registeredSvgFilters, registeredColrPaints } =
  await import('../src/filterGraph/dispatchRegistry.js');
_resetMissingFeatureWarnings();
take();
warnUnregisteredNode('feGaussianBlur');
let w = take();
check(
  'an unhandled feGaussianBlur warns once, naming primitives/blur',
  w.length === 1 && addsImport(w[0], '@kontek/mantle/filterGraph/primitives/blur'),
  w.join('|'),
);
warnUnregisteredNode('feGaussianBlur');
check('...and only once', take().length === 0);
warnUnregisteredNode('PaintSweepGradient');
w = take();
check(
  'an unhandled COLR paint warns, naming colr/paints',
  w.length === 1 && addsImport(w[0], '@kontek/mantle/filterGraph/colr/paints'),
  w.join('|'),
);
check(
  'a type Mantle has no module for stays silent',
  (warnUnregisteredNode('feBogus'), take().length === 0),
);

await import('../src/filterGraph/primitives/all.js');
await import('../src/filterGraph/colr/paints.js');
const srcOf = (f) => fs.readFileSync(path.join(PKG, f), 'utf8');
let tableOk = true,
  detail = '';
for (const type of registeredSvgFilters()) {
  const sub = handlerModuleFor(type);
  const file = sub && 'src/' + sub.replace('@kontek/mantle/', '') + '.js';
  if (!file || !new RegExp(`registerSvgFilter\\('${type}'`).test(srcOf(file))) {
    tableOk = false;
    detail += ` ${type}->${sub}`;
  }
}
check(
  `every one of the ${registeredSvgFilters().length} registered filter node types maps to the module that registers it`,
  tableOk,
  detail,
);
check(
  `every one of the ${registeredColrPaints().length} registered COLR paint types maps to colr/paints`,
  registeredColrPaints().every(
    (t) => handlerModuleFor(t) === '@kontek/mantle/filterGraph/colr/paints',
  ),
);

// ---- script shapers and bidi -------------------------------------------------------------------------------------------------
const { MantleFontAsset } = await import('../src/font/fontAsset.js');
const { buildTextRun } = await import('../src/font/textRun.js');
const roboto = new MantleFontAsset(
  new Uint8Array(fs.readFileSync(path.join(PKG, 'test/font/fixtures/roboto-regular.ttf'))),
);
const SCRIPT_CASES = [
  ['مرحبا', ['@kontek/mantle/font/typography/bidi', '@kontek/mantle/font/scripts/arabic']],
  ['שלום', ['@kontek/mantle/font/typography/bidi']],
  ['नमस्ते', ['@kontek/mantle/font/scripts/indic']],
  ['สวัสดี', ['@kontek/mantle/font/scripts/thai']],
  ['ខ្មែរ', ['@kontek/mantle/font/scripts/use']],
  ['한', ['@kontek/mantle/font/scripts/hangul']],
];
_resetMissingFeatureWarnings();
take();
for (const [text, subs] of SCRIPT_CASES) {
  _resetMissingFeatureWarnings();
  take();
  await buildTextRun(text, roboto, [0, 0, 0, 1]);
  w = take();
  check(
    `text '${text}' without its module warns, naming ${subs.map((s) => s.replace('@kontek/mantle/', '')).join(' + ')}`,
    subs.every((s) => w.some((m) => addsImport(m, s))),
    w.join(' | '),
  );
}
_resetMissingFeatureWarnings();
take();
await buildTextRun('hello world', roboto, [0, 0, 0, 1]);
check('Latin text never warns', take().length === 0);
const sc = await import('../src/font/scripts/index.js');
const bd = await import('../src/font/typography/bidi.js');
sc.registerAllScriptShapers();
bd.registerBidi();
_resetMissingFeatureWarnings();
take();
for (const [text] of SCRIPT_CASES) await buildTextRun(text, roboto, [0, 0, 0, 1]);
w = take();
check('with the modules registered, the same text never warns', w.length === 0, w.join(' | '));

// ---- table readers and the SVG-in-OT seam ---------------------------------------------------------------------------------------
const { buildSvgInOtTestFont } = await import('./font/_svgInOtFontFixture.mjs');
_resetMissingFeatureWarnings();
take();
const svgFont = new MantleFontAsset(buildSvgInOtTestFont());
void svgFont.hasSvgGlyphs;
w = take();
check(
  "a font with an 'SVG ' table and no reader warns, naming font/color",
  w.length === 1 && addsImport(w[0], '@kontek/mantle/font/color', 'registerColorEmojiReaders()'),
  w.join(' | '),
);
const { registerColorEmojiReaders } = await import('../src/font/color/index.js');
registerColorEmojiReaders();
_resetMissingFeatureWarnings();
take();
const svgFont2 = new MantleFontAsset(buildSvgInOtTestFont());
await buildTextRun('A', svgFont2, [0, 0, 0, 1]);
w = take();
check(
  'with the reader but not the importer seam, the glyph warns once, naming font/color/svgInOtImport',
  w.length === 1 &&
    addsImport(w[0], '@kontek/mantle/font/color/svgInOtImport', 'registerSvgInOtImport()'),
  w.join(' | '),
);
const { registerSvgInOtImport } = await import('../src/font/color/svgInOtImport.js');
registerSvgInOtImport();
_resetMissingFeatureWarnings();
take();
const bundle = await buildTextRun('A', new MantleFontAsset(buildSvgInOtTestFont()), [0, 0, 0, 1]);
check(
  'with the seam registered the SVG glyph is imported and nothing warns',
  take().length === 0 && bundle && bundle.numShapes >= 1,
);

const { nullObjectFor } = await import('../src/font/readerRegistry.js');
const TABLE_CASES = [
  ['fvar', 'fvar', '@kontek/mantle/font/variations'],
  ['math', 'math', '@kontek/mantle/font/math'],
  ['morx', 'morx', '@kontek/mantle/font/typography/aat'],
  ['vorg', 'vorg', '@kontek/mantle/font/typography/vertical'],
  ['base', 'base', '@kontek/mantle/font/typography/baseline'],
  ['jstf', 'jstf', '@kontek/mantle/font/typography/justification'],
  ['stat', 'stat', '@kontek/mantle/font/variations'],
];
for (const [name, table, sub] of TABLE_CASES) {
  _resetMissingFeatureWarnings();
  take();
  nullObjectFor(name, { [table]: [0, 4] });
  w = take();
  check(
    `a font with a '${table}' table and no reader warns, naming ${sub.replace('@kontek/mantle/', '')}`,
    w.length === 1 && addsImport(w[0], sub),
    w.join(' | '),
  );
  nullObjectFor(name, {});
  check(`...and a font without the table does not`, take().length === 0);
}
_resetMissingFeatureWarnings();
take();
nullObjectFor('legacyKern', { kern: [0, 4], gpos: [0, 4] });
check("a legacy 'kern' next to GPOS stays silent (GPOS kerns)", take().length === 0);

// ---- the same names are real exports ------------------------------------------------------------------------------------------
const pj = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
const fromRegistry = [
  ...fs
    .readFileSync(path.join(PKG, 'src/renderer/featureRegistry.js'), 'utf8')
    .matchAll(/'(@kontek\/mantle\/[^']+)'/g),
].map((m) => m[1]);
const listed = [
  'filterGraph/primitives/blur',
  'filterGraph/colr/paints',
  'font/scripts/arabic',
  'font/scripts/indic',
  'font/scripts/thai',
  'font/scripts/use',
  'font/scripts/hangul',
  'font/typography/bidi',
  'font/color',
  'font/color/svgInOtImport',
  'font/variations',
  'font/math',
  'font/typography/aat',
  'font/typography/vertical',
  'font/typography/baseline',
  'font/typography/justification',
  'native/text',
].map((s) => '@kontek/mantle/' + s);
const all = [...new Set([...fromRegistry, ...listed])];
const unexported = all.filter((s) => {
  const sub = './' + s.slice('@kontek/mantle/'.length);
  return (
    !pj.exports[sub] &&
    !Object.keys(pj.exports).some((k) => k.includes('*') && sub.startsWith(k.split('*')[0]))
  );
});
check(
  `every subpath a message names is exported (${all.length} checked)`,
  unexported.length === 0,
  unexported.join(' '),
);

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('missingRegistrationSmoke: PASS');
