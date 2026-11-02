// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// buildMatrixSmoke.mjs - the usage matrix holds: each minimal entry ships only what it uses, and the root still keeps everything.
//
// Two layers, so the first runs wherever node does:
//
//   STRUCTURE (no bundler): the module closure (static + dynamic imports) of each entry. An entry may not reach what it does not
//   use: svg reaches no font or renderer, text no SVG importer or renderer, the renderer no CPatch engine or frame exporter, a
//   filter primitive no other primitive, a script shaper no other script, COLR/bitmap fonts no SVG importer. The root's closure
//   contains every feature module (it "keeps everything"), and every feature module is listed in package.json "sideEffects" or
//   is an explicit register*() function.
//
//   SIZE (esbuild, found in node_modules or MANTLE_BUNDLER_TOOLS): scripts/measureBuildMatrix.mjs builds every row of the usage
//   matrix with NAMED imports. Each row must stay within 8% of test/data/buildMatrix.json, hold no module that only a sideEffects
//   flag keeps alive (the minimal rows), contain no module on its deny list, and keep the relations the design promises (the
//   renderer is much smaller than the renderer with CPatch or the frame exporter; one filter primitive costs a few KB, not the
//   whole set). With rollup, webpack and Vite installed the minimal rows are also built by each and must succeed within 20% of esbuild.
//
// Regenerate the recorded numbers (after a deliberate change) with: node scripts/measureBuildMatrix.mjs --write

import fs from 'node:fs';
import path from 'node:path';
import { closure, chain, rel, PKG, resolveSelf } from '../scripts/importGraph.mjs';
import {
  loadTool,
  measureMatrix,
  measureBundlers,
  matrixMarkdown,
  MATRIX,
  MATRIX_FILE,
} from '../scripts/measureBuildMatrix.mjs';

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);
const check = (name, cond, detail) =>
  cond ? ok(name) : fail(name + (detail ? ': ' + detail : ''));

// ---- STRUCTURE -----------------------------------------------------------------------------------------------------------------
const reach = (spec) => {
  const all = new Map();
  for (const s of [].concat(spec))
    for (const [k, v] of closure(s.startsWith('@kontek/') ? resolveSelf(s) : path.join(PKG, s), {
      dynamic: true,
    }))
      if (!all.has(k)) all.set(k, v);
  return all;
};
const names = (all) => [...all.keys()].map(rel);
const notReached = (label, spec, forbidden) => {
  const all = reach(spec);
  const hit = names(all).filter((r) =>
    forbidden.some((f) => (f instanceof RegExp ? f.test(r) : r === f || r.startsWith(f))),
  );
  check(
    `${label}: ${all.size} modules, none of ${forbidden.map(String).join(' ')}`,
    hit.length === 0,
    hit
      .slice(0, 3)
      .map((h) => chain(all, path.join(PKG, h)).join(' > '))
      .join(' ;; '),
  );
};
const M = (s) => '@kontek/mantle/' + s;

notReached('svg', M('svg'), [
  'src/font/',
  'src/renderer/',
  'src/fallback/',
  'src/shaders/',
  'src/filterGraph/filterGraph.js',
  'src/filterGraph/primitives/',
]);
notReached('font/text', M('font/text'), [
  'src/svg/importer.js',
  'src/renderer/',
  'src/fallback/',
  'src/filterGraph/',
  'src/shaders/',
]);
notReached('renderer', M('renderer'), [
  'src/renderer/cpatchBuild.js',
  'src/renderer/cpatchConvert.js',
  'src/renderer/cpatchPack.js',
  'src/renderer/cpatchMorphBuild.js',
  'src/renderer/cpatchWorkerPool.js',
  'src/fallback/',
  'src/shaders/',
  'src/font/',
  'src/filterGraph/primitives/',
  'src/filterGraph/colr/',
]);
notReached('hitTest', M('hitTest'), ['src/font/', 'src/renderer/renderer.js', 'src/fallback/']);
notReached('bundle', M('bundle'), ['src/svg/', 'src/renderer/', 'src/font/']);
notReached('animation', M('animation'), [
  'src/font/',
  'src/fallback/autoScene.js',
  'src/fallback/nativeSvgFallback.js',
  'src/shaders/',
  'src/renderer/cpatchBuild.js',
  'src/renderer/cpatchConvert.js',
]);
notReached(
  'font/color (COLR, bitmaps)',
  [M('font/text'), M('font/color')],
  ['src/svg/importer.js', 'src/font/color/svgInOtImport.js'],
);
notReached('native', M('native'), ['src/renderer/', 'src/shaders/', 'src/font/']);

const PRIMS = fs
  .readdirSync(path.join(PKG, 'src/filterGraph/primitives'))
  .filter((f) => f.endsWith('.js') && f !== 'all.js')
  .map((f) => f.slice(0, -3));
for (const p of PRIMS) {
  const others = PRIMS.filter((q) => q !== p).map((q) => `src/filterGraph/primitives/${q}.js`);
  // image.js and lighting.js lean on shared helpers, not on each other; a primitive importing another would defeat per-primitive splitting.
  notReached(`primitive ${p}`, `src/filterGraph/primitives/${p}.js`, others);
}
const SCRIPTS = ['arabic', 'hangul', 'indic', 'math', 'thai', 'use'];
for (const s of SCRIPTS)
  notReached(
    `script ${s}`,
    M(`font/scripts/${s}`),
    SCRIPTS.filter((t) => t !== s)
      .map((t) => `src/font/scripts/${t}.js`)
      .concat(['src/svg/importer.js', 'src/renderer/']),
  );

// The root keeps everything: every registration module is in its closure.
const rootAll = reach('@kontek/mantle');
const mustHave = [
  ...fs
    .readdirSync(path.join(PKG, 'src/renderer/features'))
    .map((f) => 'src/renderer/features/' + f),
  ...fs
    .readdirSync(path.join(PKG, 'src/filterGraph/primitives'))
    .map((f) => 'src/filterGraph/primitives/' + f),
  'src/filterGraph/colr/paints.js',
  'src/font/color/svgInOtImport.js',
  'src/font/color/index.js',
  'src/font/variations/index.js',
  'src/font/math/index.js',
  'src/font/formats/cff.js',
  'src/font/formats/woff2.js',
  'src/font/typography/bidi.js',
  'src/font/typography/aat.js',
  'src/font/typography/legacyKern.js',
  ...SCRIPTS.map((s) => `src/font/scripts/${s}.js`),
  'src/fallback/autoScene.js',
  'src/fallback/nativeText.js',
];
const missing = mustHave.filter((f) => !rootAll.has(path.join(PKG, f)));
check(
  `the root entry reaches all ${mustHave.length} feature modules`,
  missing.length === 0,
  missing.join(' '),
);

// Every feature module is a sideEffects entry (import = registration) or exports a register*() function (call = registration).
const pj = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
const globToRe = (g) =>
  new RegExp(
    '^' +
      g
        .replace(/^\.\//, '')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[^/]*') +
      '$',
  );
const sideRes = pj.sideEffects.map(globToRe);
const unmarked = fs
  .readdirSync(path.join(PKG, 'src/renderer/features'))
  .map((f) => 'src/renderer/features/' + f)
  .concat(
    PRIMS.map((p) => `src/filterGraph/primitives/${p}.js`),
    ['src/filterGraph/colr/paints.js', 'src/fallback/nativeText.js'],
  )
  .filter((f) => !sideRes.some((re) => re.test(f)));
check(
  'every import-is-registration module is in package.json sideEffects',
  unmarked.length === 0,
  unmarked.join(' '),
);
const regFns = [
  'src/font/color/svgInOtImport.js:registerSvgInOtImport',
  'src/font/color/index.js:registerColorEmojiReaders',
  'src/font/scripts/arabic.js:registerArabicShaping',
  'src/font/typography/bidi.js:registerBidi',
  'src/font/variations/index.js:registerVariableFontReaders',
];
const noFn = regFns.filter((x) => {
  const [f, fn] = x.split(':');
  return !new RegExp(`export function ${fn}\\b`).test(fs.readFileSync(path.join(PKG, f), 'utf8'));
});
check(
  'the explicit-call registrations export their register*() function',
  noFn.length === 0,
  noFn.join(' '),
);

// ---- SIZE ------------------------------------------------------------------------------------------------------------------------
const esbuild = await loadTool('esbuild', process.env.MANTLE_BUNDLER_TOOLS);
const rec = JSON.parse(fs.readFileSync(MATRIX_FILE, 'utf8'));
check(
  `the recorded matrix covers all ${Object.keys(MATRIX).length} rows`,
  Object.keys(MATRIX).every((k) => rec.rows[k]),
  Object.keys(MATRIX)
    .filter((k) => !rec.rows[k])
    .join(', '),
);
const doc = fs.readFileSync(path.join(PKG, '../STRIPPING.md'), 'utf8');
const embedded = /<!-- matrix:begin -->\n([\s\S]*?)\n<!-- matrix:end -->/.exec(doc);
check(
  'STRIPPING.md embeds the recorded matrix table, unedited (node scripts/measureBuildMatrix.mjs --markdown)',
  !!embedded && embedded[1].trim() === matrixMarkdown(rec).trim(),
);
if (!esbuild) {
  console.log(
    'note: esbuild is not installed; sizes were not re-measured (set MANTLE_BUNDLER_TOOLS to a dir with esbuild)',
  );
} else {
  const now = await measureMatrix(esbuild);
  const kb = (n) => (n / 1024).toFixed(1);
  for (const [k, spec] of Object.entries(MATRIX)) {
    const r = rec.rows[k],
      v = now[k];
    if (!r) continue;
    check(
      `${k}: ${kb(v.gz)} KB gzip within 8% of the recorded ${kb(r.gz)} KB`,
      v.gz <= Math.ceil(r.gz * 1.08),
      `${v.gz} > ${Math.ceil(r.gz * 1.08)}`,
    );
    if (spec.forbid)
      check(
        `${k}: no denied module in the bundle`,
        v.forbidden.length === 0,
        v.forbidden.slice(0, 3).join(', '),
      );
    if (spec.minimal && !spec.registers)
      check(
        `${k}: nothing kept alive only by sideEffects`,
        v.held.length === 0,
        v.held.slice(0, 3).join(', '),
      );
    check(
      `${k}: no more modules kept alive by sideEffects/registration than recorded (${r.held})`,
      v.held.length <= r.held,
      v.held.join(', '),
    );
  }
  const g = (k) => now[k].gz;
  check(
    'relation: the renderer is 40 KB or more smaller than the renderer with CPatch',
    g('renderer+cpatch') - g('renderer') >= 40 * 1024,
    kb(g('renderer+cpatch') - g('renderer')),
  );
  check(
    'relation: the renderer is 40 KB or more smaller than the renderer with frame export',
    g('renderer+frameExport') - g('renderer') >= 40 * 1024,
    kb(g('renderer+frameExport') - g('renderer')),
  );
  check(
    'relation: latin text is under 110 KB (the SVG importer is not in it)',
    g('text (latin)') < 110 * 1024,
    kb(g('text (latin)')),
  );
  check(
    'relation: COLR/bitmap emoji adds under 10 KB over latin text',
    g('text+color (COLR/bitmap)') - g('text (latin)') < 10 * 1024,
    kb(g('text+color (COLR/bitmap)') - g('text (latin)')),
  );
  check(
    'relation: SVG-in-OT is the part that costs the importer (over 50 KB)',
    g('text+color+svgInOt') - g('text+color (COLR/bitmap)') > 50 * 1024,
    kb(g('text+color+svgInOt') - g('text+color (COLR/bitmap)')),
  );
  check(
    'relation: a single filter primitive costs under 10 KB, the full set under 20 KB',
    Math.max(...PRIMS.map((p) => g('svg+renderer+filter ' + p) - g('svg+renderer'))) < 10 * 1024 &&
      g('svg+renderer+all filters') - g('svg+renderer') < 20 * 1024,
  );
  check(
    'relation: the native entry is the smallest scene (under 80 KB) and under half the renderer',
    g('native') < 80 * 1024 && g('native') * 2 < g('renderer'),
    kb(g('native')),
  );
  check(
    'relation: the root is larger than every row (it keeps everything)',
    Object.keys(now)
      .filter((k) => k !== 'root (everything)' && k !== 'root importSvg')
      .every((k) => g('root (everything)') > g(k)),
  );
  check(
    'relation: a one-symbol root import costs more than the svg subpath (the root keeps its registrations)',
    g('root importSvg') > g('svg'),
  );

  const tools = process.env.MANTLE_BUNDLER_TOOLS;
  const [rollup, webpack, vite] = await Promise.all(
    ['rollup', 'webpack', 'vite'].map((n) => loadTool(n, tools)),
  );
  if (!(rollup && webpack && vite))
    console.log(
      'note: rollup/webpack/vite are not all installed; the multi-bundler build was skipped',
    );
  else {
    const keys = ['svg', 'renderer', 'text (latin)', 'native', 'hitTest'];
    const by = await measureBundlers(keys, tools);
    for (const k of keys)
      for (const b of ['rollup', 'webpack', 'vite']) {
        const v = by[k][b];
        check(
          `${k} bundles with ${b}: ${typeof v === 'number' ? kb(v) + ' KB' : v}, within 20% of esbuild`,
          typeof v === 'number' && Math.abs(v - now[k].gz) <= 0.2 * now[k].gz,
          `${v} vs ${now[k].gz}`,
        );
      }
  }
}

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('buildMatrixSmoke: PASS');
