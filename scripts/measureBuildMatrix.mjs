#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// measureBuildMatrix.mjs - the usage matrix: what each way of using Mantle costs in a bundle, against the ideal.
//
// Each row is a small consumer written with NAMED imports from the subpath entries (so the bundler's tree shaking is what
// is measured, not `import *`). For every row it records
//   gz        min+gzip -9 of the single-file esbuild bundle (browser, ESM, every dynamic import folded in)
//   modules   source modules in the bundle
//   held      modules the package.json "sideEffects" list (or an import-time registration) keeps alive that the ideal
//             build drops: the same row with every module treated as side-effect free. 0 means the row ships exactly what
//             its imports reach.
//   forbidden modules on the row's deny list that appear in the bundle (a minimal row names what it must not contain)
// and `--bundlers` also builds the minimal rows with rollup, webpack and Vite (whichever are installed) from a scratch
// consumer that resolves @kontek/mantle through package.json "exports", as an application would.
//
//   node scripts/measureBuildMatrix.mjs [--tools DIR] [--write] [--only a,b] [--bundlers]
//
// test/buildMatrixSmoke.mjs holds the regression thresholds recorded in test/data/buildMatrix.json.

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { resolveSelf, PKG } from './importGraph.mjs';

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? undefined : (process.argv[i + 1] ?? true);
}
export const MATRIX_FILE = path.join(PKG, 'test/data/buildMatrix.json');

export async function loadTool(name, toolsDir) {
  for (const dir of [PKG, path.resolve(PKG, '..'), ...(toolsDir ? [path.resolve(toolsDir)] : [])]) {
    try {
      return await import(
        pathToFileURL(createRequire(path.join(dir, 'noop.js')).resolve(name)).href
      );
    } catch {
      /* next */
    }
  }
  return null;
}

const M = '@kontek/mantle/';
const imp = (names, sub) => `import { ${names} } from '${M}${sub}';`;
const use = (names) => `console.log(${names});`;
const row = (parts) =>
  parts.map(([n, s]) => imp(n, s)).join('') + use(parts.map(([n]) => n).join(','));

const FILTERS = [
  'blur',
  'colorMatrix',
  'blend',
  'convolve',
  'displacementMap',
  'componentTransfer',
  'composite',
  'merge',
  'lighting',
  'image',
  'flood',
  'tile',
  'morphology',
  'turbulence',
  'offset',
];
const GL_STACK = [
  'src/renderer/renderer.js',
  'src/renderer/fillPass.js',
  'src/renderer/filterDraw.js',
  'src/renderer/morphDraw.js',
  'src/renderer/loopBlinn.js',
  'src/renderer/cpatchBuild.js',
  'src/shaders/',
  'src/filterGraph/filterGraph.js',
  'src/renderer/bundle.js',
];

/** key -> { code, minimal (threshold-bearing), forbid: path substrings that must not be in the bundle }. */
export const MATRIX = {
  // ── the base ──
  svg: {
    minimal: true,
    code: row([['importSvg', 'svg']]),
    forbid: ['src/font/', 'src/renderer/renderer.js', 'src/fallback/', 'src/shaders/'],
  },
  renderer: {
    minimal: true,
    code: row([['createRenderer, createBundle', 'renderer']]),
    forbid: [
      'src/renderer/cpatchBuild.js',
      'src/renderer/cpatchConvert.js',
      'src/renderer/cpatchPack.js',
      'src/fallback/',
      'src/shaders/',
      'src/font/',
    ],
  },
  'svg+renderer': {
    minimal: true,
    code: row([
      ['importSvg', 'svg'],
      ['createRenderer, createBundle', 'renderer'],
    ]),
    forbid: ['src/renderer/cpatchBuild.js', 'src/fallback/'],
  },
  hitTest: {
    minimal: true,
    code: row([['fillHitId', 'hitTest']]),
    forbid: ['src/font/', 'src/renderer/renderer.js'],
  },
  'bundle (introspection)': {
    minimal: true,
    code: row([['inspectAll, toNames', 'bundle']]),
    forbid: ['src/svg/', 'src/renderer/', 'src/font/'],
  },
  // ── native: no WebGL engine dependency ──
  native: {
    minimal: true,
    code: row([['createMantleScene', 'native']]),
    forbid: GL_STACK.concat(['src/renderer/', 'src/shaders/']),
  },
  'native+svg': {
    minimal: true,
    code: row([
      ['createMantleScene', 'native'],
      ['importSvg', 'svg'],
    ]),
    forbid: GL_STACK.concat(['src/renderer/', 'src/shaders/']),
  },
  'native+svg+text': {
    minimal: true,
    registers: true,
    code:
      row([
        ['createMantleScene', 'native'],
        ['importSvg', 'svg'],
        ['MantleFontAsset, buildTextRun', 'font/text'],
      ]) + `import '${M}native/text';`,
    forbid: GL_STACK.concat(['src/renderer/', 'src/shaders/']),
  },
  // ── text ──
  'text (latin)': {
    minimal: true,
    code: row([['MantleFontAsset, buildTextRun', 'font/text']]),
    forbid: ['src/svg/importer.js', 'src/renderer/', 'src/fallback/', 'src/filterGraph/'],
  },
  'svg+renderer+text': {
    minimal: true,
    code: row([
      ['importSvg', 'svg'],
      ['createRenderer, createBundle', 'renderer'],
      ['MantleFontAsset, buildTextRun', 'font/text'],
    ]),
    forbid: ['src/renderer/cpatchBuild.js'],
  },
  'text+arabic': {
    code: row([
      ['MantleFontAsset, buildTextRun', 'font/text'],
      ['registerArabicShaping', 'font/scripts/arabic'],
    ]),
  },
  'text+indic': {
    code: row([
      ['MantleFontAsset, buildTextRun', 'font/text'],
      ['registerIndicShaping', 'font/scripts/indic'],
    ]),
  },
  'text+all scripts': {
    code: row([
      ['MantleFontAsset, buildTextRun', 'font/text'],
      ['registerAllScriptShapers', 'font/scripts'],
    ]),
  },
  'text+bidi': {
    code: row([
      ['MantleFontAsset, buildTextRun', 'font/text'],
      ['registerBidi', 'font/typography/bidi'],
    ]),
  },
  'text+color (COLR/bitmap)': {
    code: row([
      ['MantleFontAsset, buildTextRun', 'font/text'],
      ['registerColorEmojiReaders', 'font/color'],
    ]),
    forbid: ['src/svg/importer.js'],
  },
  'text+color+svgInOt': {
    code: row([
      ['MantleFontAsset, buildTextRun', 'font/text'],
      ['registerColorEmojiReaders', 'font/color'],
      ['registerSvgInOtImport', 'font/color/svgInOtImport'],
    ]),
  },
  'text+variations': {
    code: row([
      ['MantleFontAsset, buildTextRun', 'font/text'],
      ['registerVariableFontReaders', 'font/variations'],
    ]),
  },
  'text+woff2': {
    code: row([
      ['MantleFontAsset, buildTextRun', 'font/text'],
      ['registerWoff2Reader', 'font/formats/woff2'],
    ]),
  },
  'text+unicode tables': {
    code: row([
      ['MantleFontAsset, buildTextRun', 'font/text'],
      ['registerUnicodeFallback', 'font/unicode'],
    ]),
  },
  // ── renderer features ──
  'renderer+frameExport': {
    code: row([
      ['createRenderer', 'renderer'],
      ['registerFrameExport', 'renderer/features/frameExport'],
    ]),
  },
  'renderer+cpatch': {
    code: row([
      ['createRenderer', 'renderer'],
      ['registerCpatch', 'renderer/features/cpatch'],
    ]),
  },
  'renderer+filterGraph': {
    code: row([
      ['createRenderer', 'renderer'],
      ['evaluateGraph', 'filterGraph'],
    ]),
  },
  'renderer+colr paints': {
    code: row([['createRenderer', 'renderer']]) + `import '${M}filterGraph/colr/paints';`,
  },
  // ── animation / scene ──
  animation: { code: row([['createShapeMorph, createOverrideTable', 'animation']]) },
  scene: { code: row([['createScene, sceneToBundle', 'scene']]) },
  // ── chooser and root ──
  'fallback (auto chooser)': { code: row([['createMantleScene', 'fallback']]) },
  'root importSvg': { code: "import { importSvg } from '@kontek/mantle'; console.log(importSvg);" },
  'root (everything)': { code: "import * as M from '@kontek/mantle'; console.log(M);" },
};
for (const f of FILTERS)
  MATRIX['svg+renderer+filter ' + f] = {
    code:
      row([
        ['importSvg', 'svg'],
        ['createRenderer', 'renderer'],
      ]) + `import '${M}filterGraph/primitives/${f}';`,
  };
MATRIX['svg+renderer+all filters'] = {
  code:
    row([
      ['importSvg', 'svg'],
      ['createRenderer', 'renderer'],
    ]) + `import '${M}filterGraph/primitives/all';`,
};

/** What each row IS, for the documentation table. Rows missing here fall back to their key. */
export const ROW_DOCS = {
  'bundle (introspection)': 'inspect an asset (build scripts)',
  svg: 'import SVG',
  renderer: 'draw prebuilt bundles with WebGL',
  'svg+renderer': 'import SVG and draw it',
  hitTest: 'hit tests',
  native: 'native-SVG scene, no WebGL code',
  'native+svg': 'native scene + SVG import',
  'native+svg+text': 'native scene + SVG import + text',
  'text (latin)': 'Latin text shaping and layout',
  'svg+renderer+text': 'import SVG, draw it, set Latin text',
  'text+arabic': 'Latin text + Arabic shaping',
  'text+indic': 'Latin text + Indic shaping',
  'text+all scripts': 'Latin text + all six script shapers',
  'text+bidi': 'Latin text + right-to-left order',
  'text+color (COLR/bitmap)': 'Latin text + COLR / sbix / CBDT emoji',
  'text+color+svgInOt': 'Latin text + emoji + SVG-in-OpenType glyphs',
  'text+variations': 'Latin text + variable fonts',
  'text+woff2': 'Latin text + WOFF2',
  'text+unicode tables': 'Latin text + table-driven Unicode fallback',
  'renderer+frameExport': 'renderer + exportFrameSVG()',
  'renderer+cpatch': 'renderer + the CPatch engine',
  'renderer+filterGraph': 'renderer + filter-graph evaluator',
  'renderer+colr paints': 'renderer + COLRv1 paint handlers',
  animation: 'overrides + shape morph',
  scene: 'programmatic scene tree',
  'fallback (auto chooser)':
    'WebGL-or-native chooser (loads both lazily; single-file builds fold both in)',
  'root importSvg': "`import { importSvg } from '@kontek/mantle'`",
  'root (everything)': "`import * from '@kontek/mantle'`",
};

/** The markdown table of the recorded matrix (what STRIPPING.md embeds; buildMatrixSmoke fails when the document drifts). */
export function matrixMarkdown(rec = JSON.parse(fs.readFileSync(MATRIX_FILE, 'utf8'))) {
  const kb = (n) => (n / 1024).toFixed(1);
  const lines = [
    '| Row (named imports from the subpaths) | What it is | gzip KB | ideal KB | modules kept alive only by registration |',
    '|---|---|--:|--:|--:|',
  ];
  for (const [k, r] of Object.entries(rec.rows)) {
    if (k.startsWith('svg+renderer+filter ')) continue;
    lines.push(`| \`${k}\` | ${ROW_DOCS[k] || ''} | ${kb(r.gz)} | ${kb(r.ideal)} | ${r.held} |`);
  }
  const f = Object.entries(rec.rows).filter(([k]) => k.startsWith('svg+renderer+filter '));
  const base = rec.rows['svg+renderer'].gz;
  lines.push(
    `| \`svg+renderer\` + one filter primitive | each of the ${f.length} primitives, over \`svg+renderer\` | +${kb(Math.min(...f.map(([, r]) => r.gz - base)))} to +${kb(Math.max(...f.map(([, r]) => r.gz - base)))} | | |`,
  );
  return lines.join('\n');
}

function selfPlugin(entries, sideEffectsFalse) {
  return {
    name: 'self',
    setup(b) {
      b.onResolve({ filter: /^@kontek\/mantle(\/|$)/ }, (a) => {
        const f = resolveSelf(a.path);
        return f
          ? { path: f, sideEffects: sideEffectsFalse ? false : undefined }
          : { errors: [{ text: 'no export for ' + a.path }] };
      });
      if (sideEffectsFalse)
        b.onResolve({ filter: /^\.\.?\// }, async (a) => {
          if (a.pluginData === 'r' || a.namespace === 'entry') return undefined;
          const r = await b.resolve(a.path, {
            resolveDir: a.resolveDir,
            kind: a.kind,
            pluginData: 'r',
          });
          return { ...r, sideEffects: false };
        });
      b.onResolve({ filter: /^entry:/ }, (a) => ({ path: a.path.slice(6), namespace: 'entry' }));
      b.onLoad({ filter: /.*/, namespace: 'entry' }, (a) => ({
        contents: entries[a.path],
        resolveDir: PKG,
        loader: 'js',
      }));
    },
  };
}

async function buildOne(esbuild, key, code, pure) {
  const r = await esbuild.build({
    entryPoints: ['entry:' + key],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    metafile: true,
    logLevel: 'silent',
    plugins: [selfPlugin({ [key]: code }, pure)],
    absWorkingDir: PKG,
    outfile: 'out/inline.js',
  });
  const mods = {};
  for (const [k, v] of Object.entries(r.metafile.outputs['out/inline.js'].inputs))
    if (!k.startsWith('entry:')) mods[k] = v.bytesInOutput;
  return {
    gz: zlib.gzipSync(r.outputFiles[0].contents, { level: 9 }).length,
    raw: r.outputFiles[0].contents.length,
    mods,
  };
}

export async function measureMatrix(esbuild, { only } = {}) {
  const out = {};
  for (const [key, spec] of Object.entries(MATRIX)) {
    if (only && !only.includes(key)) continue;
    const a = await buildOne(esbuild, key, spec.code, false);
    const b = await buildOne(esbuild, key, spec.code, true);
    const held = Object.keys(a.mods).filter(
      (m) => !(m in b.mods) || (b.mods[m] > 0 && b.mods[m] < a.mods[m]),
    );
    const forbidden = (spec.forbid || []).flatMap((f) =>
      Object.keys(a.mods).filter((m) => m.includes(f)),
    );
    out[key] = {
      gz: a.gz,
      raw: a.raw,
      modules: Object.keys(a.mods).length,
      ideal: b.gz,
      held: held.map((h) => h.replace(/^.*?(src\/)/, '$1')),
      forbidden: [...new Set(forbidden)].map((h) => h.replace(/^.*?(src\/)/, '$1')),
    };
  }
  return out;
}

/** Build a row with rollup, webpack and Vite from a scratch consumer; returns { rollup, webpack, vite } gz bytes (null when absent). */
export async function measureBundlers(keys, toolsDir) {
  const [rollup, rollupNode, webpack, vite] = await Promise.all(
    ['rollup', '@rollup/plugin-node-resolve', 'webpack', 'vite'].map((n) => loadTool(n, toolsDir)),
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-matrix-'));
  try {
    fs.mkdirSync(path.join(dir, 'node_modules/@kontek'), { recursive: true });
    fs.symlinkSync(PKG, path.join(dir, 'node_modules/@kontek/mantle'), 'dir');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    const gz = (s) => zlib.gzipSync(s, { level: 9 }).length;
    const res = {};
    for (const key of keys) {
      const file = path.join(dir, 'e.mjs');
      fs.writeFileSync(file, MATRIX[key].code);
      const r = {};
      if (rollup && rollupNode) {
        try {
          const b = await rollup.rollup({
            input: file,
            onwarn() {},
            plugins: [(rollupNode.default || rollupNode.nodeResolve)({ browser: true })],
            external: [/^node:/, 'zlib'],
          });
          const { output } = await b.generate({
            format: 'es',
            inlineDynamicImports: true,
            compact: true,
          });
          const mini =
            (await loadTool('esbuild', toolsDir))?.transformSync(output[0].code, {
              minify: true,
              format: 'esm',
            }).code ?? output[0].code;
          r.rollup = gz(mini);
        } catch (e) {
          r.rollup = 'ERR ' + String(e.message).split('\n')[0];
        }
      }
      if (webpack) {
        try {
          const wp = webpack.default || webpack;
          const stats = await new Promise((ok, no) =>
            wp(
              {
                mode: 'production',
                entry: file,
                context: dir,
                target: 'web',
                output: {
                  path: path.join(dir, 'wp'),
                  filename: 'o.js',
                  library: { type: 'module' },
                },
                experiments: { outputModule: true },
                resolve: { fallback: { zlib: false } },
                optimization: { splitChunks: false },
                performance: { hints: false },
              },
              (e, s) => (e ? no(e) : ok(s)),
            ),
          );
          if (stats.hasErrors())
            throw new Error(stats.toJson({ errors: true }).errors[0].message.split('\n')[0]);
          r.webpack = gz(fs.readFileSync(path.join(dir, 'wp/o.js')));
        } catch (e) {
          r.webpack = 'ERR ' + String(e.message).split('\n')[0];
        }
      }
      if (vite) {
        try {
          const out = path.join(dir, 'vite');
          await vite.build({
            root: dir,
            logLevel: 'silent',
            configFile: false,
            build: {
              outDir: out,
              emptyOutDir: true,
              minify: 'esbuild',
              lib: { entry: file, formats: ['es'], fileName: 'o' },
              rollupOptions: { external: [/^node:/, 'zlib'] },
            },
          });
          const files = fs.readdirSync(out).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
          r.vite = files.reduce((n, f) => n + gz(fs.readFileSync(path.join(out, f))), 0);
        } catch (e) {
          r.vite = 'ERR ' + String(e.message).split('\n')[0];
        }
      }
      res[key] = r;
    }
    return res;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) &&
  process.argv.includes('--markdown')
) {
  console.log(matrixMarkdown());
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const esbuild = await loadTool('esbuild', arg('tools'));
  if (!esbuild) {
    console.error(
      'measureBuildMatrix: esbuild not found (npm i esbuild somewhere and pass --tools DIR)',
    );
    process.exit(2);
  }
  const only = arg('only') ? String(arg('only')).split(',') : undefined;
  const sizes = await measureMatrix(esbuild, { only });
  const kb = (n) => (n / 1024).toFixed(1).padStart(7);
  console.log('row'.padEnd(36), '     gz KB', '  ideal KB', ' held', ' forbidden');
  for (const [k, v] of Object.entries(sizes))
    console.log(
      k.padEnd(36),
      kb(v.gz),
      kb(v.ideal),
      String(v.held.length).padStart(5),
      v.forbidden.length ? ' ' + v.forbidden.length + ' ' + v.forbidden.slice(0, 2).join(' ') : '',
    );
  let bundlers;
  if (process.argv.includes('--bundlers')) {
    const keys = Object.keys(sizes).filter((k) => MATRIX[k].minimal);
    bundlers = await measureBundlers(keys, arg('tools'));
    console.log('\nminimal rows by bundler (gz KB):');
    for (const [k, v] of Object.entries(bundlers))
      console.log(
        k.padEnd(36),
        ...['rollup', 'webpack', 'vite'].map((b) =>
          typeof v[b] === 'number' ? kb(v[b]) : String(v[b] ?? '-').padStart(7),
        ),
      );
  }
  if (process.argv.includes('--write')) {
    const prior = fs.existsSync(MATRIX_FILE)
      ? JSON.parse(fs.readFileSync(MATRIX_FILE, 'utf8'))
      : {};
    const rows = Object.fromEntries(
      Object.entries(sizes).map(([k, v]) => [
        k,
        { gz: v.gz, ideal: v.ideal, modules: v.modules, held: v.held.length, heldModules: v.held },
      ]),
    );
    fs.writeFileSync(
      MATRIX_FILE,
      JSON.stringify(
        {
          note: 'min+gzip -9 bytes from scripts/measureBuildMatrix.mjs (esbuild, browser, ESM, single file). held = modules kept alive only by sideEffects/registration; regenerate with --write. Thresholds are in test/buildMatrixSmoke.mjs.',
          esbuild: esbuild.version,
          rows: { ...prior.rows, ...rows },
          ...(bundlers
            ? { bundlers: { ...prior.bundlers, ...bundlers } }
            : { bundlers: prior.bundlers }),
        },
        null,
        1,
      ) + '\n',
    );
    console.log('wrote', path.relative(PKG, MATRIX_FILE));
  }
}
