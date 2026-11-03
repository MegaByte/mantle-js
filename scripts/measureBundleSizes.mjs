#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0
// measureBundleSizes.mjs - the reproducible source of every size the documentation quotes.
//
// Bundles each public entry (and a few combinations) from the SOURCE TREE with esbuild
// (--bundle --minify, browser platform, ESM, code splitting) and reports min+gzip -9 bytes of the entry's
// INITIAL closure: the entry chunk plus every chunk it imports statically. Lazy chunks (dynamic import(),
// for example the bundled shader module or the native-SVG fallback behind `chooseBackend`) are not in it;
// they are reported separately. The DOCUMENTED figure is `inline gz`: the same entry bundled WITHOUT splitting (every
// dynamic import folded in), which is what a default single-file build ships and what a reader can reproduce with
// `esbuild --bundle --minify --platform=browser`.
//
//   node scripts/measureBundleSizes.mjs [--tools DIR] [--write] [--only a,b] [--pkg DIR]
//
// esbuild is not a dependency of this package. It is found in node_modules when present, else in DIR/node_modules.
// `--write` records the numbers in test/data/bundleSizes.json; test/bundleSizeClaimsSmoke.mjs checks every size
// the README and STRIPPING.md state (marked `<!--size:KEY-->`) against that file, and re-measures when esbuild
// is available. Incremental rows ("+font/color") are gz(font/text + subpath) - gz(font/text).

import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? undefined : (process.argv[i + 1] ?? true);
}
const PKG = path.resolve(
  arg('pkg') || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
);
export const SIZES_FILE = path.join(PKG, 'test/data/bundleSizes.json');

export async function loadEsbuild(toolsDir) {
  const tries = [PKG, path.resolve(PKG, '..'), ...(toolsDir ? [path.resolve(toolsDir)] : [])];
  for (const dir of tries) {
    try {
      const r = createRequire(path.join(dir, 'noop.js')).resolve('esbuild');
      return await import(pathToFileURL(r).href);
    } catch {
      /* next */
    }
  }
  return null;
}

const SUB = (s) => `@kontek/mantle/${s}`;
const star = (spec) => `import * as M from '${spec}'; console.log(M);`;
const FONT_EXTRA = [
  'font/color',
  'font/color/svgInOtImport',
  'font/variations',
  'font/math',
  'font/formats/woff2',
  'font/typography/legacyKern',
  'font/typography/vertical',
  'font/typography/baseline',
  'font/scripts/arabic',
  'font/scripts/hangul',
  'font/scripts/indic',
  'font/scripts/math',
  'font/scripts/thai',
  'font/scripts/use',
  'font/scripts',
  'font/unicode',
];

export const ENTRIES = {
  root: star('@kontek/mantle'),
  'root:importSvg': "import { importSvg } from '@kontek/mantle'; console.log(importSvg);",
  bundle: star(SUB('bundle')),
  svg: star(SUB('svg')),
  renderer: star(SUB('renderer')),
  scene: star(SUB('scene')),
  hitTest: star(SUB('hitTest')),
  filterGraph: star(SUB('filterGraph')),
  fallback: star(SUB('fallback')),
  native: star(SUB('native')),
  'native+text': `import * as N from '${SUB('native')}'; import '${SUB('native/text')}'; console.log(N);`,
  shaders: star(SUB('shaders')),
  'font/text': star(SUB('font/text')),
  font: star(SUB('font')),
  // A Latin-only web app: SVG import, the renderer, and the lean text core. No root barrel.
  latinApp: `import * as A from '${SUB('svg')}'; import * as B from '${SUB('renderer')}'; import * as C from '${SUB('font/text')}'; console.log(A, B, C);`,
  // One named export of the bundled shader module: the rest must tree-shake away.
  'shaders/bundled:fillVert': `import { fillVert } from '${SUB('shaders/bundled')}'; console.log(fillVert.length);`,
  'shaders/bundled': star(SUB('shaders/bundled')),
};
for (const s of FONT_EXTRA)
  ENTRIES['font/text+' + s] =
    `import * as T from '${SUB('font/text')}'; import * as X from '${SUB(s)}'; console.log(T, X);`;

function exportsResolver(pkgJson) {
  const exp = pkgJson.exports;
  return (spec) => {
    if (spec === '@kontek/mantle') return exp['.'].default;
    const sub = './' + spec.slice('@kontek/mantle/'.length);
    if (exp[sub]) return typeof exp[sub] === 'string' ? exp[sub] : exp[sub].default;
    for (const [k, v] of Object.entries(exp)) {
      if (!k.includes('*')) continue;
      const [pre, post] = k.split('*');
      if (sub.startsWith(pre) && sub.endsWith(post)) {
        const mid = sub.slice(pre.length, sub.length - post.length);
        return (typeof v === 'string' ? v : v.default).replace('*', mid);
      }
    }
    return null;
  };
}

export async function measure(esbuild, { only } = {}) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  const resolveSpec = exportsResolver(pkgJson);
  const plugin = {
    name: 'self-exports',
    setup(b) {
      b.onResolve({ filter: /^@kontek\/mantle(\/|$)/ }, (a) => {
        const rel = resolveSpec(a.path);
        if (!rel) return { errors: [{ text: `no export for ${a.path}` }] };
        return { path: path.join(PKG, rel) };
      });
      b.onResolve({ filter: /^entry:/ }, (a) => ({ path: a.path.slice(6), namespace: 'entry' }));
      b.onLoad({ filter: /.*/, namespace: 'entry' }, (a) => ({
        contents: ENTRIES[a.path],
        resolveDir: PKG,
        loader: 'js',
      }));
    },
  };
  const out = {};
  for (const key of Object.keys(ENTRIES)) {
    if (only && !only.includes(key)) continue;
    const common = {
      entryPoints: ['entry:' + key],
      bundle: true,
      minify: true,
      format: 'esm',
      platform: 'browser',
      write: false,
      metafile: true,
      logLevel: 'silent',
      plugins: [plugin],
      absWorkingDir: PKG,
    };
    const split = await esbuild.build({ ...common, splitting: true, outdir: 'out' });
    const outs = split.metafile.outputs;
    const entryKey = Object.keys(outs).find((k) => outs[k].entryPoint === 'entry:' + key);
    const seen = new Set();
    const q = [entryKey];
    while (q.length) {
      const k = q.pop();
      if (seen.has(k)) continue;
      seen.add(k);
      for (const i of outs[k].imports)
        if (i.kind === 'import-statement' && outs[i.path]) q.push(i.path);
    }
    // Source bytes of the modules the entry reaches through static imports only (what `import` alone pulls in).
    const inputs = split.metafile.inputs;
    const staticSeen = new Set();
    const sq = Object.keys(inputs).filter((k) => k.startsWith('entry:'));
    while (sq.length) {
      const k = sq.pop();
      if (staticSeen.has(k) || !inputs[k]) continue;
      staticSeen.add(k);
      for (const i of inputs[k].imports) if (i.kind === 'import-statement') sq.push(i.path);
    }
    let staticSrc = 0;
    for (const k of staticSeen) staticSrc += inputs[k].bytes;
    let raw = 0,
      gz = 0,
      lazyGz = 0;
    for (const f of split.outputFiles) {
      const rel = path.relative(PKG, f.path);
      const g = zlib.gzipSync(f.contents, { level: 9 }).length;
      if (seen.has(rel)) {
        raw += f.contents.length;
        gz += g;
      } else lazyGz += g;
    }
    const inl = await esbuild.build({ ...common, outfile: 'out/inline.js' });
    const inlineGz = zlib.gzipSync(inl.outputFiles[0].contents, { level: 9 }).length;
    out[key] = { gz, raw, lazyGz, inlineGz, staticSrc, staticModules: staticSeen.size };
  }
  return out;
}

/// The documented size of a key, in gz bytes: the single-file figure (`inlineGz`: every dynamic import folded in), which
/// is what `esbuild --bundle --minify` ships by default. "+sub" = gz(font/text + sub) - gz(font/text).
export function sizeOf(sizes, key) {
  if (key.startsWith('+'))
    return sizes['font/text+' + key.slice(1)].inlineGz - sizes['font/text'].inlineGz;
  return sizes[key].inlineGz;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const esbuild = await loadEsbuild(arg('tools'));
  if (!esbuild) {
    console.error(
      'measureBundleSizes: esbuild not found (npm i esbuild somewhere and pass --tools DIR)',
    );
    process.exit(2);
  }
  const only = arg('only');
  const sizes = await measure(esbuild, { only: only ? String(only).split(',') : undefined });
  const kb = (n) => (n / 1024).toFixed(1).padStart(7);
  console.log('entry'.padEnd(34), '  initial gz   raw       lazy gz   inline gz   static source');
  for (const [k, v] of Object.entries(sizes))
    console.log(
      k.padEnd(34),
      kb(v.gz),
      'KB',
      kb(v.raw),
      'KB',
      kb(v.lazyGz),
      'KB',
      kb(v.inlineGz),
      'KB',
      kb(v.staticSrc),
      'KB',
    );
  if (!only) {
    console.log('\ndocumented sizes (single-file gz); incremental rows over font/text:');
    for (const s of FONT_EXTRA) console.log('  +' + s.padEnd(30), kb(sizeOf(sizes, '+' + s)), 'KB');
  }
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.dirname(SIZES_FILE), { recursive: true });
    fs.writeFileSync(
      SIZES_FILE,
      JSON.stringify(
        {
          note: 'min+gzip -9 bytes from scripts/measureBundleSizes.mjs (esbuild, browser, ESM, splitting; initial closure). Regenerate with --write.',
          esbuild: esbuild.version,
          sizes,
        },
        null,
        1,
      ) + '\n',
    );
    console.log('wrote', path.relative(PKG, SIZES_FILE));
  }
}
