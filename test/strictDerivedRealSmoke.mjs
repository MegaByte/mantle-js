// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strictDerivedRealSmoke -- the derivation on REAL content: every SVG of a game's art (the games named on the command line or in MANTLE_GAMES) through the importer into a strict
// renderer; the loading call derives each bundle's breakpoints; the production answer is swept at 0.1% of fit scale (test only) and every flip must sit on an analytic
// breakpoint (the drift guard of strictDerivedRegionsSmoke, on content nobody wrote for the test). Lists the real bundles' breakpoints and regions and every
// unexplained flip (a gate with no bars). Needs the game art: MANTLE_GAMES_DIR (a directory of <game>/art trees); skips when it or the game list is absent.
//   node test/strictDerivedRealSmoke.mjs [game ...]     env: MAX (bundles per game, default 120), STEP (sweep step, default 1.001)
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { taggedShaderSources } = await import('./_fakeGl.mjs');
const { createPendingGl } = await import('./_pendingGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
const GAMES = process.env.MANTLE_GAMES_DIR || '';
if (!GAMES || !existsSync(GAMES)) {
  console.log('strictDerivedRealSmoke SKIP (no game art: set MANTLE_GAMES_DIR)');
  process.exit(0);
}
const games = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (process.env.MANTLE_GAMES || '').split(',').filter(Boolean);
if (!games.length) {
  console.log('strictDerivedRealSmoke SKIP (no games: pass names or set MANTLE_GAMES)');
  process.exit(0);
}
const MAX = +process.env.MAX || 120,
  STEP = +process.env.STEP || 1.001;
const walk = (d, out = []) => {
  for (const f of readdirSync(d)) {
    if (f === 'node_modules') continue;
    const p = join(d, f),
      st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (f.endsWith('.svg')) out.push(p);
  }
  return out;
};
let fail = 0,
  totalFlips = 0,
  totalUnexplained = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
for (const game of games) {
  const dir = join(GAMES, game, 'art');
  if (!existsSync(dir)) {
    console.log(`(${game}) no art dir`);
    continue;
  }
  let files = walk(dir).sort();
  const stride = Math.max(1, Math.ceil(files.length / MAX));
  files = files.filter((_, i) => i % stride === 0);
  console.log(`(${game}) ${files.length} SVGs (stride ${stride})`);
  const W = createPendingGl({ linkMs: 30, pipelineMs: 120 });
  const R = createRenderer(W.gl, taggedShaderSources(), {
    asyncShaderCompile: true,
    nonBlocking: true,
    strictPlay: true,
    aacPoints: false,
    glGuard: true,
    gpuShedMs: 40,
    strokeStrip: 'on',
  });
  R.ready.catch(() => {});
  setTimeout(() => W.release(), 40);
  await R.ready;
  R.setViewport(1024, 768);
  let made = 0;
  const names = [];
  for (const f of files) {
    try {
      const sec = await importSvg(readFileSync(f, 'utf8'), { preserveViewport: true });
      createBundle(W.gl, sec);
      names.push(f.slice(dir.length + 1));
      made++;
    } catch {
      /* an SVG the importer declines */
    }
  }
  const t0 = Date.now();
  await R.precompileFillsAsync({ maxViewportPx: 4096 });
  const dv = R.debugStats.viewportWarm.derived;
  console.log(
    `  ${made} bundles loaded in ${Date.now() - t0} ms; reachable ${dv.range.minW}x${dv.range.minH}..${dv.range.maxW}x${dv.range.maxH}; derivation ${dv.ms} ms; ${dv.sizes.length} extra warm viewport(s)`,
  );
  let flips = 0,
    unexplained = 0,
    withBreaks = 0;
  const narrow = [];
  dv.live.forEach((b, i) => {
    const r = dv.bundles[i];
    if (!r.bbox) return;
    if (r.breakpoints.length) {
      withBreaks++;
      console.log(
        `   bundle ${i} ${r.bbox.slice(0, 4).map((v) => +(+v).toFixed(1))} scale ${r.scaleRange.join('..')}: breaks [${r.breakpoints.join(', ')}] -> ${r.regions} region(s)`,
      );
    }
    const vw = Math.abs(r.bbox[2] - r.bbox[0]),
      vh = Math.abs(r.bbox[3] - r.bbox[1]);
    const at = (sc) =>
      dv.sigAt(b, Math.max(1, Math.round(sc * vw)), Math.max(1, Math.round(sc * vh)));
    const tol = (x) => 1e-3 + 1.5 / (x * Math.min(vw, vh));
    const [sLo, sHi] = r.scaleRange;
    let prevS = sLo,
      prev = at(sLo);
    for (let sc = sLo * STEP; ; sc *= STEP) {
      if (sc > sHi) sc = sHi;
      const cu = at(sc);
      if (cu !== prev) {
        let a0 = prevS,
          z0 = sc;
        while (z0 / a0 > 1.00001) {
          const m = Math.sqrt(a0 * z0);
          if (at(m) === prev) a0 = m;
          else z0 = m;
        }
        flips++;
        if (!r.breakpoints.some((bp) => Math.abs(z0 / bp - 1) < tol(bp))) {
          unexplained++;
          const sv = dv.sigStr(b, Math.round(prevS * vw), Math.round(prevS * vh)).split('\n'),
            sn = dv.sigStr(b, Math.round(sc * vw), Math.round(sc * vh)).split('\n');
          const added = sn
            .filter((k) => !sv.includes(k))
            .slice(0, 2)
            .map((k) => k.slice(0, 160));
          console.log(
            `   UNEXPLAINED flip: bundle ${i} (${names[i] || '?'}) at scale ${z0.toFixed(4)}; keys gained: ${JSON.stringify(added)}`,
          );
        }
      }
      prevS = sc;
      prev = cu;
      if (sc >= sHi) break;
    }
  });
  console.log(
    `  ${withBreaks} of ${made} bundles have analytic breakpoints; the sweep found ${flips} flip(s), ${unexplained} unexplained`,
  );
  totalFlips += flips;
  totalUnexplained += unexplained;
  R.dispose();
}
ok(
  totalUnexplained === 0,
  `real content: ${totalFlips} flip(s) of the production answer, ${totalUnexplained} not explained by an analytic breakpoint`,
);
console.log(fail ? `strictDerivedRealSmoke FAIL (${fail})` : 'strictDerivedRealSmoke PASS');
process.exit(fail ? 1 : 0);
