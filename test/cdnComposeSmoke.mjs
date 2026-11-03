// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cdnComposeSmoke.mjs - builds COMPOSE: games that import different subsets of one CDN-served, unbundled package share one set of
// registries, caches and worker pools (node; HTTP server + import map; CPU only).
//
// The package is served over HTTP exactly as a CDN serves it. Node is given a module hook that resolves bare `@kontek/mantle/...`
// specifiers through the import map scripts/genImportMap.mjs generates and loads http modules by fetch, so module identity is the
// resolved URL, the browser's registry key. Then:
//   1. game A (svg + renderer + blur + Arabic shaping) loads: it fetched only what it uses, and none of what it does not.
//   2. game B (text + offset + Indic + the CPatch renderer feature), a DIFFERENT subset, loads LATER on the same page: the shared
//      registries now hold both games' registrations, and every registry/pool module was fetched exactly once.
//   3. a game that imports the registry through an unrelated specifier path (the root entry's relative graph) sees the same instance.
//   4. two SEPARATELY BUNDLED copies are independent: a registration in one is not in the other, and the second to load says so.
// test/cdnBrowserSmoke.mjs repeats the import-map part in Chrome (and the cross-origin worker recipe).
import module from 'node:module';
process.noDeprecation = true; // module.register is the only hook form that can load over HTTP asynchronously
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { startCdn } from './_cdnServer.mjs';
import { buildImportMap } from '../scripts/genImportMap.mjs';
import { loadTool } from '../scripts/measureBuildMatrix.mjs';
import { resolveSelf } from '../scripts/importGraph.mjs';

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('ok', name);
  else {
    failures++;
    console.error('FAIL', name, detail === undefined ? '' : String(detail).slice(0, 400));
  }
};

const x = await import('@xmldom/xmldom');
globalThis.DOMParser = x.DOMParser;
globalThis.XMLSerializer = x.XMLSerializer;

const GAME_A = `
import { importSvg } from '@kontek/mantle/svg';
import { createRenderer } from '@kontek/mantle/renderer';
import '@kontek/mantle/filterGraph/primitives/blur';
import { registerArabicShaping } from '@kontek/mantle/font/scripts/arabic';
registerArabicShaping();
export const uses = { importSvg, createRenderer };
`;
const GAME_B = `
import { MantleFontAsset, buildTextRun } from '@kontek/mantle/font/text';
import '@kontek/mantle/filterGraph/primitives/offset';
import { registerIndicShaping } from '@kontek/mantle/font/scripts/indic';
import '@kontek/mantle/renderer/features/cpatch';
registerIndicShaping();
export const uses = { MantleFontAsset, buildTextRun };
`;
const cdn = await startCdn({
  routes: {
    '/games/a.js': { type: 'text/javascript', body: GAME_A },
    '/games/b.js': { type: 'text/javascript', body: GAME_B },
  },
});
const map = buildImportMap({ base: cdn.origin + '/' });
module.register('./_httpEsmLoader.mjs', {
  parentURL: import.meta.url,
  data: { imports: map.imports },
}); // (registerHooks is sync-only; the loader is async)
let LOG = [];
const sync = async () => {
  LOG = await cdn.log();
  return LOG;
};
const once = (p) => LOG.filter((q) => q === p).length;

const warns = [];
const origWarn = console.warn;
console.warn = (...a) => {
  warns.push(a.join(' '));
};

try {
  // 1. game A ---------------------------------------------------------------------------------------------------------------
  await sync();
  const mark = LOG.length;
  await import(cdn.origin + '/games/a.js');
  await sync();
  const fetchedA = new Set(LOG.slice(mark));
  check(`game A loaded over HTTP: ${fetchedA.size} modules fetched`, fetchedA.size > 50);
  check(
    'game A fetched the blur primitive and the Arabic shaper',
    fetchedA.has('/src/filterGraph/primitives/blur.js') &&
      fetchedA.has('/src/font/scripts/arabic.js'),
  );
  const notYet = [
    '/src/filterGraph/primitives/offset.js',
    '/src/font/scripts/indic.js',
    '/src/renderer/cpatchBuild.js',
    '/src/renderer/features/cpatch.js',
    '/src/font/textRun.js',
    '/src/fallback/nativeSvgFallback.js',
  ];
  check(
    'game A fetched none of what only game B uses (nor the native scene)',
    notYet.every((p) => !fetchedA.has(p)),
    notYet.filter((p) => fetchedA.has(p)).join(' '),
  );

  // The registries, reached by the same specifiers the games use.
  const dispatch = await import('@kontek/mantle/filterGraph/dispatchRegistry');
  const shapers = await import(cdn.origin + '/src/font/shaperRegistry.js'); // the same URL by another spelling
  const { hasRendererFeature } = await import(cdn.origin + '/src/renderer/featureRegistry.js');
  check(
    'after game A the filter registry holds blur only',
    dispatch.hasSvgFilter('feGaussianBlur') && !dispatch.hasSvgFilter('feOffset'),
    dispatch.registeredSvgFilters().join(),
  );
  check(
    'after game A the script registry holds Arabic only',
    !!shapers.getArabicShaping() && !shapers.getIndicShaping(),
  );
  check('after game A the CPatch feature is absent', !hasRendererFeature('cpatch'));

  // 2. game B, a different subset, later on the same page ---------------------------------------------------------------------
  const markB = LOG.length;
  await import(cdn.origin + '/games/b.js');
  await sync();
  const fetchedB = new Set(LOG.slice(markB));
  check(
    'game B fetched its own subset (offset, Indic, CPatch, the text engine)',
    [
      '/src/filterGraph/primitives/offset.js',
      '/src/font/scripts/indic.js',
      '/src/renderer/features/cpatch.js',
      '/src/font/textRun.js',
    ].every((p) => fetchedB.has(p)),
  );
  const reused = [...fetchedA].filter((p) => fetchedB.has(p));
  check(
    'game B refetched nothing game A already loaded (one instance per URL)',
    reused.length === 0,
    reused.slice(0, 5).join(' '),
  );
  check(
    'after game B the filter registry holds blur AND offset: one registry, both games',
    dispatch.hasSvgFilter('feGaussianBlur') && dispatch.hasSvgFilter('feOffset'),
    dispatch.registeredSvgFilters().join(),
  );
  check(
    '...and the script registry holds Arabic AND Indic',
    !!shapers.getArabicShaping() && !!shapers.getIndicShaping(),
  );
  check(
    '...and the CPatch feature registered by game B is visible to everyone',
    hasRendererFeature('cpatch'),
  );
  for (const f of [
    'filterGraph/dispatchRegistry.js',
    'font/shaperRegistry.js',
    'renderer/featureRegistry.js',
    'renderer/workerConfig.js',
    'core/diagnostics.js',
    'font/readerRegistry.js',
    'font/bidiRegistry.js',
    'core/missingFeature.js',
  ])
    check(`${f} was fetched exactly once`, once('/src/' + f) === 1, once('/src/' + f));

  // The shared worker policy and the shared diagnostics sink are the same two modules both games reach.
  const wcA = await import('@kontek/mantle/renderer');
  const wcB = await import(cdn.origin + '/src/renderer/workerConfig.js');
  check(
    'configureWorkers from the entry is the instance the pools read',
    wcA.configureWorkers === wcB.configureWorkers,
  );
  const before = wcB.workersEnabled();
  wcA.configureWorkers({ enabled: false });
  check(
    'a worker policy set through one entry is the policy the other sees',
    before === true && wcB.workersEnabled() === false,
  );
  wcA.configureWorkers({ enabled: true });

  // 3. the root entry's relative graph reaches the same modules ------------------------------------------------------------------
  const markR = LOG.length;
  const root = await import('@kontek/mantle');
  await sync();
  const refetched = LOG.slice(markR).filter((p) => new Set([...fetchedA, ...fetchedB]).has(p));
  check(
    'the root entry reuses every module the games loaded (zero refetches)',
    refetched.length === 0,
    refetched.slice(0, 5).join(' '),
  );
  check(
    'the root entry registers into the same filter registry',
    dispatch.registeredSvgFilters().length >= 15 && typeof root.createRenderer === 'function',
    dispatch.registeredSvgFilters().length,
  );
  check(
    'the games never loaded a module twice over the whole run',
    new Set(LOG).size === LOG.length,
    LOG.filter((p, i) => LOG.indexOf(p) !== i)
      .slice(0, 5)
      .join(' '),
  );

  // 4. separately bundled copies ------------------------------------------------------------------------------------------------
  const esbuild = await loadTool('esbuild', process.env.MANTLE_BUNDLER_TOOLS);
  if (!esbuild)
    console.log('note: esbuild is not installed; the separately-bundled-copy part was skipped');
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-copy-'));
    try {
      const entry = path.join(dir, 'copy.mjs');
      fs.writeFileSync(
        entry,
        `import '@kontek/mantle/filterGraph/primitives/composite'; export * from '@kontek/mantle/filterGraph/dispatchRegistry'; export * from '@kontek/mantle/core/diagnostics';`,
      );
      await esbuild.build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        outfile: path.join(dir, 'copy.out.mjs'),
        logLevel: 'silent',
        platform: 'browser',
        plugins: [
          {
            name: 'self',
            setup(b) {
              b.onResolve({ filter: /^@kontek\/mantle\// }, (a) => ({ path: resolveSelf(a.path) }));
            },
          },
        ],
      });
      warns.length = 0;
      const copy = await import(pathToFileURL(path.join(dir, 'copy.out.mjs')).href);
      check(
        `the separately bundled copy has its own registry: ${copy.registeredSvgFilters().join()} only, against ${dispatch.registeredSvgFilters().length} in the shared one`,
        copy.registeredSvgFilters().length === 1 &&
          copy.hasSvgFilter('feComposite') &&
          dispatch.registeredSvgFilters().length >= 15,
      );
      check(
        '...and what the CDN games registered is not visible in the copy',
        !copy.hasSvgFilter('feGaussianBlur') && !copy.hasSvgFilter('feOffset'),
      );
      check(
        'the second copy to load says so, once, naming the remedy',
        warns.filter((w) => /second copy of Mantle/.test(w)).length === 1 &&
          /import map/.test(warns.join(' ')),
        warns.join(' | '),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
} finally {
  console.warn = origWarn;
  await cdn.close();
}

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('cdnComposeSmoke: PASS');
