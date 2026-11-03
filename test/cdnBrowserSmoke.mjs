// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cdnBrowserSmoke.mjs - the CDN recipe in a real browser (no WebGL; a small page, but a browser: run it through the scheduler).
//
// The unbundled package is served over HTTP with CORS from one origin (the "CDN"); pages are served from another. Each page carries the
// import map scripts/genImportMap.mjs generates. Checked in Chrome:
//   1. two <script type=module> in ONE page import different subsets, the second loaded later (a timer): one registry instance holds
//      both registrations, and every registry/pool module was requested exactly once.
//   2. the page is cross-origin to the CDN: the modules load (CORS), and the worker recipe works: a module worker cannot be built straight
//      from a cross-origin URL, but a same-origin Blob wrapper that imports the CDN worker script starts, and configureWorkers() accepts
//      it as the pool's source (the README recipe).
//   3. shader assets: bundleShaders.fromPackage() reaches bundledSources.js through the relative graph, and loadShaders(<cdn>/src/shaders/)
//      reads the raw .glsl files (the asset-URL recipe), both over the cross-origin CDN.
//   4. the same import map served same-origin gives the same answers.
import { startCdn } from './_cdnServer.mjs';
import { buildImportMap } from '../scripts/genImportMap.mjs';
import { launchBrowser } from './_launch.mjs';
import { closure, rel, PKG } from '../scripts/importGraph.mjs';
import path from 'node:path';
// A module worker has its own module map, so the worker graph is fetched a second time by design; the page's modules are not.
const WORKER_GRAPH = new Set(
  [...closure(path.join(PKG, 'src/renderer/lbBuild.worker.js'), { dynamic: true }).keys()].map(
    (f) => '/' + rel(f),
  ),
);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('ok', name);
  else {
    failures++;
    console.error('FAIL', name, detail === undefined ? '' : String(detail).slice(0, 500));
  }
};

const SCRIPT_A = `
import { registeredSvgFilters } from '@kontek/mantle/filterGraph/dispatchRegistry';
import '@kontek/mantle/filterGraph/primitives/blur';
import { registerArabicShaping } from '@kontek/mantle/font/scripts/arabic';
import { configureWorkers } from '@kontek/mantle/renderer';
registerArabicShaping();
window.__a = { registeredSvgFilters, configureWorkers };
`;
const SCRIPT_B = (base) => `
const reg = await import('@kontek/mantle/filterGraph/dispatchRegistry');
await import('@kontek/mantle/filterGraph/primitives/offset');
const sh = await import('@kontek/mantle/font/scripts/indic');
sh.registerIndicShaping();
const shapers = await import('${base}/src/font/shaperRegistry.js');
const rc = await import('@kontek/mantle/renderer');
window.__b = { reg, shapers, same: reg.registeredSvgFilters === window.__a.registeredSvgFilters, sameWorkers: rc.configureWorkers === window.__a.configureWorkers };
window.__done = true;
`;
const page = (map, base, extra = '') => `<!doctype html><meta charset="utf-8"><body>
<script type="importmap">${JSON.stringify(map)}</script>
<script type="module">${SCRIPT_A}</script>
<script type="module">await new Promise((r) => setTimeout(r, 300)); ${SCRIPT_B(base)}</script>
<script type="module">
${extra}
</script></body>`;

const EXTRA = (cdn) => `
const out = { workers: {}, shaders: {} };
try { new Worker('${cdn}/src/renderer/lbBuild.worker.js', { type: 'module' }); out.workers.direct = 'constructed'; } catch (e) { out.workers.direct = e.name; }
const blob = new Blob(["import '${cdn}/src/renderer/lbBuild.worker.js';"], { type: 'text/javascript' });
const w = new Worker(URL.createObjectURL(blob), { type: 'module' });
out.workers.blob = await new Promise((r) => { w.onerror = (e) => r('error: ' + (e.message || 'no message')); setTimeout(() => r('started'), 1200); });
w.terminate();
const rc = await import('@kontek/mantle/renderer');
out.workers.configured = JSON.stringify(rc.configureWorkers({ lb: () => new Worker(URL.createObjectURL(blob), { type: 'module' }) }));
rc.configureWorkers({ lb: null });
const { bundleShaders, loadShaders } = await import('@kontek/mantle/shaders');
const fp = await bundleShaders.fromPackage({ include: [] });
out.shaders.package = Object.keys(fp).length + ' keys, fillVert ' + (fp.fillVert || '').length;
const raw = await loadShaders('${cdn}/src/shaders/', { include: [] });
out.shaders.raw = Object.keys(raw).length + ' keys, fillVert ' + (raw.fillVert || '').length;
window.__extra = out;
`;

const cdn = await startCdn({ cors: true });
const mapCross = buildImportMap({ base: cdn.origin + '/' });
const mapSame = buildImportMap({ base: '/' });
// Origin B serves the pages for the cross-origin case; origin C serves the same-origin case itself (the package AND the page).
const host = await startCdn({
  routes: { '/cross.html': { body: page(mapCross, cdn.origin, EXTRA(cdn.origin)) } },
});
const same = await startCdn({ cors: false, routes: { '/same.html': { body: page(mapSame, '') } } });

const browser = await launchBrowser({ headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
try {
  for (const [label, origin, file, logOf] of [
    ['cross-origin CDN', host.origin, '/cross.html', cdn],
    ['same-origin', same.origin, '/same.html', same],
  ]) {
    const pg = await browser.newPage();
    const msgs = [];
    pg.on('console', (m) => msgs.push(m.type() + ': ' + m.text()));
    pg.on('pageerror', (e) => msgs.push('pageerror: ' + e.message));
    const bad = [];
    pg.on('response', (r) => {
      if (r.status() >= 400 && !/favicon\.ico$/.test(r.url())) bad.push(r.status() + ' ' + r.url());
    });
    await pg.goto(origin + file, { waitUntil: 'load' });
    await pg
      .waitForFunction(
        'window.__done === true && (window.__extra !== undefined || ' +
          (label === 'same-origin') +
          ')',
        { timeout: 30000 },
      )
      .catch(() => {});
    const r = await pg.evaluate(() => ({
      done: window.__done === true,
      filters: window.__a ? window.__a.registeredSvgFilters() : null,
      arabic: !!(window.__b && window.__b.shapers.getArabicShaping()),
      indic: !!(window.__b && window.__b.shapers.getIndicShaping()),
      same: window.__b && window.__b.same,
      sameWorkers: window.__b && window.__b.sameWorkers,
      extra: window.__extra || null,
    }));
    const log = await logOf.log();
    const tag = `[${label}]`;
    check(`${tag} both scripts ran`, r.done, msgs.join(' | '));
    check(
      `${tag} one registry holds blur and offset`,
      r.filters && r.filters.includes('feGaussianBlur') && r.filters.includes('feOffset'),
      JSON.stringify(r.filters),
    );
    check(`${tag} one script registry holds Arabic and Indic`, r.arabic && r.indic);
    check(
      `${tag} the second script's import is the first script's instance`,
      r.same === true && r.sameWorkers === true,
    );
    for (const f of [
      'filterGraph/dispatchRegistry.js',
      'font/shaperRegistry.js',
      'renderer/workerConfig.js',
    ])
      check(
        `${tag} ${f} requested exactly once`,
        log.filter((p) => p === '/src/' + f).length === 1,
        log.filter((p) => p === '/src/' + f).length,
      );
    const twice = log.filter((p, i) => log.indexOf(p) !== i && !WORKER_GRAPH.has(p));
    check(
      `${tag} no page module requested twice (the Blob worker's own graph may be)`,
      twice.length === 0,
      twice.slice(0, 4).join(' '),
    );
    check(
      `${tag} nothing outside the two subsets was fetched (no CPatch, no native scene)`,
      !log.some((p) => /cpatchBuild|nativeSvgFallback|features\/cpatch/.test(p)),
    );
    const errs = msgs.filter(
      (m) => /^(error|pageerror)/.test(m) && !/Failed to load resource/.test(m),
    );
    check(
      `${tag} no console error and no failed request (the browser's own /favicon.ico probe aside)`,
      errs.length === 0 && bad.length === 0,
      errs.concat(bad).join(' | '),
    );
    if (label === 'cross-origin CDN') {
      const e = r.extra;
      check(
        `${tag} a module worker straight from the CDN URL is refused (${e && e.workers.direct})`,
        e && e.workers.direct === 'SecurityError',
        e && e.workers.direct,
      );
      check(
        `${tag} the Blob-wrapper worker recipe starts the CDN worker (${e && e.workers.blob})`,
        e && e.workers.blob === 'started',
        e && e.workers.blob,
      );
      check(
        `${tag} configureWorkers accepts the factory as the lb source`,
        e && /"lb":true/.test(e.workers.configured),
        e && e.workers.configured,
      );
      check(
        `${tag} bundleShaders.fromPackage() loads over the CDN (${e && e.shaders.package})`,
        (e && /fillVert [1-9]\d{2,}/.test(e.shaders.package)) ||
          (e && /^0 keys/.test(e.shaders.package) === false),
        e && e.shaders.package,
      );
      check(
        `${tag} loadShaders(<cdn>/src/shaders/) reads the raw .glsl files (${e && e.shaders.raw})`,
        e && /fillVert [1-9]\d{2,}/.test(e.shaders.raw),
        e && e.shaders.raw,
      );
    }
    await pg.close();
  }
} finally {
  await browser.close();
  await cdn.close();
  await host.close();
  await same.close();
}

if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('cdnBrowserSmoke: PASS');
