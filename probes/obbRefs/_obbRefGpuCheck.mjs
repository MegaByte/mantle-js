// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _obbRefGpuCheck — put the three objectBoundingBox cases (gradients, filter regions, the silhouette of a
// clipped shape) in front of a real GPU and decide them against _obbRefPredict's numbers, rather than looking at a picture.
//
//   JSON=/tmp/obb.json node probes/obbRefs/_obbRefPredict.mjs
//   GPU=1 JSON=/tmp/obb.json node probes/obbRefs/_obbRefGpuCheck.mjs
//
// The predictor writes, in DOCUMENT units, what this tree's bundle says the GPU must draw (WANT) and what the
// naive document-space rule gives (WAS). This renders the same three assets and classifies each sampled pixel as WANT, WAS
// or NEITHER, so "the bundle's rule reached the draw" is a count and not an impression.
//
// Document -> pixel goes through renderer.bundleDrawMatrix, NOT through the viewBox: setViewport + drawBundle
// fit the bundle's inked CONTENT bbox. Each asset is rendered by all three
// fill engines with the draw tally read back, because a variant that fails to link falls back to Slug and a
// probe that does not look at debugStats reads that fallback as a triumph.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const N = +(process.env.N || 768);
const PRED = JSON.parse(readFileSync(process.env.JSON || '/tmp/obb.json', 'utf8'));
const A = (f) => readFileSync(path.join(ROOT, 'examples', 'smoke', f), 'utf8');
const ASSETS = {
  obbGradient: A('objectBoundingBoxGradient__OBB_GRADIENT_DEMO.svg'),
  filterRegion: A('filterRegionTransform__FILTER_REGION_DEMO.svg'),
  clippedSilhouette: A('silhouetteClippedExtent__CLIPPED_SILHOUETTE_DEMO.svg'),
};
const SIL_OPTS = { computeSilhouette: true, outlineWidth: 6, outlineColor: [1, 1, 1, 1] };

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N};
// One renderer per engine. setFillEngine is the only pin that survives the route; the draw tally below proves which one actually painted.
const ROUTE = { slug: 'none', lb: 'lb', cpatch: 'cpatch' };
function mk(engine) {
  const r = createRenderer(gl, shaders, { cpatchFill: engine === 'cpatch' });
  r.setFillEngine({ route: ROUTE[engine] });
  return r;
}
const engines = { slug: mk('slug'), lb: mk('lb'), cpatch: mk('cpatch') };
window.__render = async (svg, opts, engine, clear) => {
  const r = engines[engine];
  const sec = await importSvg(svg, Object.assign({ preserveViewport: true }, opts || {}));
  const b = createBundle(gl, sec);
  if (r.prepareBundle) r.prepareBundle(b);
  if (r.awaitLbReady) await r.awaitLbReady(b);
  r.setViewport(N, N); gl.viewport(0, 0, N, N);
  r.beginFrame(clear); r.drawBundle(b); r.endFrame();
  const p = new Uint8Array(N * N * 4);
  gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, p);
  // em -> pixel for THIS draw, from the renderer itself rather than an assumed viewBox fit.
  const M = r.bundleDrawMatrix ? Array.from(r.bundleDrawMatrix(b, undefined) || []) : null;
  const st = r.debugStats || {};
  const tally = { engines: st.engines ? (st.engines.draws || null) : null,
    last: st.engines ? st.engines.last : null, lbRoute: st.loopBlinnRouteCount | 0,
    requested: r.getFillEngine ? r.getFillEngine() : null };
  const bb = Array.from(b.globalBBox || []);
  b.dispose();
  return { px: Array.from(p), M, tally, bb };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser(
  process.env.GPU === '1'
    ? { headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
    : { headless: 'new', args: ['--no-sandbox'] },
);
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 200)));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 50 });

// --- pixel access -------------------------------------------------------------------------------------------
// readPixels is y-UP from the bottom-left; document space is y-DOWN from the top-left.
const mk = (R) => {
  const { px, M } = R;
  const map = (x, y) => {
    // bundleDrawMatrix is a 3x3 column-major em->pixel map (y-down pixels, origin top-left).
    if (!M) return null;
    const sx = M[0] * x + M[3] * y + M[6];
    const sy = M[1] * x + M[4] * y + M[7];
    return [sx, sy];
  };
  const at = (x, y) => {
    const p = map(x, y);
    if (!p) return null;
    const ix = Math.floor(p[0]),
      iy = Math.floor(p[1]);
    if (ix < 0 || iy < 0 || ix >= N || iy >= N) return null;
    const o = ((N - 1 - iy) * N + ix) * 4;
    return [px[o], px[o + 1], px[o + 2], px[o + 3]];
  };
  return { map, at };
};
const dist = (a, b) =>
  Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
const tallyLine = (t) =>
  `requested ${JSON.stringify(t.requested)} last ${t.last} lbRoute ${t.lbRoute}` +
  ` draws ${JSON.stringify(t.engines)}`;

const BACKDROP = [0x20, 0x26, 0x2e]; // the gradient demo's own full-canvas rect
const BAR = '='.repeat(108);
const results = {};

// ============================================================================================================
// Gradients — the four gradient cells. Each sampled pixel is scored against WANT and WAS.
// ============================================================================================================
console.log(BAR);
console.log('objectBoundingBox gradients');
console.log(BAR);
for (const engine of ['slug', 'lb', 'cpatch']) {
  const R = await pg.evaluate(
    (s, o, e, c) => window.__render(s, o, e, c),
    ASSETS.obbGradient,
    null,
    engine,
    [0, 0, 0, 1],
  );
  const { at } = mk(R);
  console.log(`  ${engine.padEnd(7)} ${tallyLine(R.tally)}`);
  let gw = 0,
    gs = 0,
    gn = 0;
  for (const cell of PRED.obbGradient) {
    let want = 0,
      was = 0,
      neither = 0,
      decided = 0;
    for (const [x, y, cNew, cOld] of cell.pts) {
      if (dist(cNew, cOld) <= 8) continue; // cells where WANT and WAS agree decide nothing
      const got = at(x, y);
      if (!got) continue;
      // The row box is the AABB of a TURNED rect, so most of it is the asset's own #20262e
      // backdrop; the rect also carries a white hairline. Neither is the gradient.
      if (dist(got, BACKDROP) <= 8) continue;
      if (got[0] > 200 && got[1] > 200 && got[2] > 200) continue;
      decided++;
      const dW = dist(got, cNew),
        dS = dist(got, cOld);
      if (dW <= 12 && dW < dS) want++;
      else if (dS <= 12 && dS < dW) was++;
      else neither++;
    }
    gw += want;
    gs += was;
    gn += neither;
    console.log(
      `    cell ${cell.cell} (gradient ${cell.gid}, units ${cell.units}): ${decided} decisive px` +
        ` -> WANT ${want}  WAS ${was}  NEITHER ${neither}`,
    );
  }
  console.log(
    `    TOTAL WANT ${gw}  WAS ${gs}  NEITHER ${gn}` +
      `  => ${gw > 20 * Math.max(1, gs) ? 'BUNDLE RULE REACHED THE DRAW' : gs > gw ? 'NAIVE-RULE BEHAVIOR' : 'INDETERMINATE'}`,
  );
  results[`obbGradient.${engine}`] = { want: gw, was: gs, neither: gn, tally: R.tally };
}

// ============================================================================================================
// Filter regions — The scissor is what moved, so measure WHERE THE BLUR STOPS along the bar.
// The bar in cell 1 runs at 30 deg; walk its own axis and find the last painted sample.
// ============================================================================================================
console.log('');
console.log(BAR);
console.log('objectBoundingBox filter regions');
console.log(BAR);
for (const engine of ['slug', 'lb', 'cpatch']) {
  const R = await pg.evaluate(
    (s, o, e, c) => window.__render(s, o, e, c),
    ASSETS.filterRegion,
    null,
    engine,
    [0, 0, 0, 1],
  );
  const { at } = mk(R);
  console.log(`  ${engine.padEnd(7)} ${tallyLine(R.tally)}`);
  const inRect = (r, x, y) => x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];
  for (const c of PRED.filterRegion) {
    // Sample every pixel center in the union of the two scissors; a painted pixel OUTSIDE one of them
    // falsifies that one.
    const u = [
      Math.min(c.want[0], c.was[0]),
      Math.min(c.want[1], c.was[1]),
      Math.max(c.want[0] + c.want[2], c.was[0] + c.was[2]),
      Math.max(c.want[1] + c.want[3], c.was[1] + c.was[3]),
    ];
    let inkWantOnly = 0,
      inkWasOnly = 0,
      inkBoth = 0,
      inkNeither = 0;
    for (let y = Math.floor(u[1]) + 0.5; y < u[3]; y++)
      for (let x = Math.floor(u[0]) + 0.5; x < u[2]; x++) {
        const got = at(x, y);
        if (!got) continue;
        // The bar is #f05a28 through a blur; the backdrop is #101418. Orange is r >> b either way,
        // and the backdrop is not, so this reads the bar's ink and nothing else.
        if (got[0] - got[2] < 24) continue;
        const w = inRect(c.want, x, y),
          s = inRect(c.was, x, y);
        if (w && s) inkBoth++;
        else if (w) inkWantOnly++;
        else if (s) inkWasOnly++;
        else inkNeither++;
      }
    console.log(
      `    cell ${c.cell} filter ${c.fid}: ink inside WANT-only ${inkWantOnly}, WAS-only ${inkWasOnly},` +
        ` both ${inkBoth}, outside both ${inkNeither}`,
    );
    console.log(
      `      WANT ${JSON.stringify(c.want.map((v) => +v.toFixed(1)))}` +
        `  WAS ${JSON.stringify(c.was.map((v) => +v.toFixed(1)))}` +
        `  (symmetric difference ${c.symmetric.toFixed(1)} sq units)`,
    );
    results[`filterRegion.${engine}.cell${c.cell}`] = {
      inkWantOnly,
      inkWasOnly,
      inkBoth,
      inkNeither,
    };
  }
}

// ============================================================================================================
// The silhouette. The ring around the disc is the decisive feature: the naive rule draws none.
// ============================================================================================================
console.log('');
console.log(BAR);
console.log('silhouette of a clipped shape');
console.log(BAR);
for (const engine of ['slug', 'lb', 'cpatch']) {
  const R = await pg.evaluate(
    (s, o, e, c) => window.__render(s, o, e, c),
    ASSETS.clippedSilhouette,
    SIL_OPTS,
    engine,
    [0, 0, 0, 1],
  );
  const { at } = mk(R);
  console.log(`  ${engine.padEnd(7)} ${tallyLine(R.tally)}`);
  const P = PRED.clippedSilhouette;
  const white = (x, y) => {
    const g = at(x, y);
    return g && g[0] > 200 && g[1] > 200 && g[2] > 200;
  };
  const dRect = (x, y, r) => {
    const dx = Math.max(r[0] - x, 0, x - r[2]),
      dy = Math.max(r[1] - y, 0, y - r[3]);
    const o = Math.hypot(dx, dy);
    return o > 0 ? o : Math.min(x - r[0], r[2] - x, y - r[1], r[3] - y);
  };
  const onWas = (x, y) => dRect(x, y, P.wasRect) <= P.hw;
  const onWant = (x, y) =>
    dRect(x, y, P.wantRect) <= P.hw ||
    Math.abs(Math.hypot(x - P.disc[0], y - P.disc[1]) - P.disc[2]) <= P.hw;
  // The silhouette is row 0, so the plate and the disc paint OVER it: the inner half of the
  // 6-wide outline band is hidden by the artwork it outlines. Only the part OUTSIDE both the band
  // rect and the disc can be seen, so only that part decides anything.
  const covered = (x, y) =>
    (x >= P.wantRect[0] && x <= P.wantRect[2] && y >= P.wantRect[1] && y <= P.wantRect[3]) ||
    Math.hypot(x - P.disc[0], y - P.disc[1]) <= P.disc[2];
  let hitWantOnly = 0,
    missWantOnly = 0,
    hitWasOnly = 0,
    missWasOnly = 0,
    ring = 0,
    ringN = 0;
  for (let y = 0.5; y < 140; y++)
    for (let x = 0.5; x < 240; x++) {
      const a = onWas(x, y),
        c = onWant(x, y);
      if (a === c) continue;
      if (covered(x, y)) continue;
      const w = white(x, y);
      if (c) {
        if (w) hitWantOnly++;
        else missWantOnly++;
      } else {
        if (w) hitWasOnly++;
        else missWasOnly++;
      }
    }
  // The ring alone, sampled just OUTSIDE the disc (r + hw/2) where the outline is visible; the
  // same circle at r - hw/2 is under the disc's own fill and must NOT be white.
  let ringIn = 0;
  for (let i = 0; i < 360; i++) {
    const th = (i * Math.PI) / 180,
      cs = Math.cos(th),
      sn = Math.sin(th);
    const rOut = P.disc[2] + P.hw / 2,
      rIn = P.disc[2] - P.hw / 2;
    ringN++;
    if (white(P.disc[0] + rOut * cs, P.disc[1] + rOut * sn)) ring++;
    if (white(P.disc[0] + rIn * cs, P.disc[1] + rIn * sn)) ringIn++;
  }
  console.log(
    `    WANT-only outline: ${hitWantOnly} painted, ${missWantOnly} not (predicted ${P.onlyWant} px)`,
  );
  console.log(
    `    WAS-only outline:  ${hitWasOnly} painted, ${missWasOnly} not (predicted ${P.onlyWas} px,` +
      ` which this tree must NOT paint)`,
  );
  console.log(
    `    disc ring: ${ring} of ${ringN} samples white just OUTSIDE the disc,` +
      ` ${ringIn} just inside (must be ~0 — the disc's own fill covers the band's inner half)`,
  );
  results[`clippedSilhouette.${engine}`] = {
    hitWantOnly,
    missWantOnly,
    hitWasOnly,
    missWasOnly,
    ring,
    ringIn,
    ringN,
  };
}

await br.close();
server.close();
console.log('');
console.log(JSON.stringify(results));
