// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbDegenerateCubicDropSmoke.mjs — the cubic self-audit (lbPartition) declines a whole
// shape to Slug if ANY cubic piece over-paints air. NEAR-DEGENERATE pieces (a hull
// collapsed toward a point — a ~0-length cubic sub-sliver from fat-curve subdivision)
// paint essentially nothing, yet their implicit is numerically unstable at ~0 extent
// and emits spurious f<0 samples that FALSELY decline the shape. The partition
// DROPS pieces whose whole hull is below a sub-pixel fraction of the shape (0.3% of the
// diagonal) before the audit AND from the returned mesh (so they never render, at any
// zoom), recovering those shapes for the analytic path.
//
// A/B via the __LB_MIN_EDGE test hook (0 = drop off), one page load each so the global
// mesh cache is fresh: the drop must remove every collapsed cubic, reshape the partition, and add
// none. Curve-heavy fixture (the Ghostscript tiger) so the effect is real / non-vacuous.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { launchBrowser } from './_launch.mjs';
import { example, requireAsset } from './_assets.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TIGER_PATH = requireAsset(example('tiger.svg'));
const SVG = readFileSync(TIGER_PATH, 'utf8').replace(
  /(fill|stroke)="([^"]+)"/g,
  (_match, attr, value) => `${attr}="${attr === 'fill' && value === '#000' ? '#000' : 'none'}"`,
);
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
// A SENTINEL IS A ROUTING ANSWER, NOT AN ATTRIBUTION. The 'sent' count below walks _lbMeshes for
// rows without a mesh, and five different outcomes produce one -- three of which never attempted
// the shape. lbMeshCensus splits them, so "did the drop cost a shape its mesh" is asked of the
// number that means it (src/renderer/lbBuildCore.js).
import { lbMeshCensus } from '/src/renderer/lbBuildCore.js';
import { buildLoopBlinnPartition } from '/src/renderer/lbPartition.js';
import { curveRangeToContours } from '/src/renderer/loopBlinn.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders, { staticUnified: true }); renderer.setViewport(256, 256);
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
renderer.prepareBundle(bundle);
// THE RAW PIECES COME FROM prepareBundle's SYNCHRONOUS BUILD, and are read before anything is
// awaited. The worker ships packed GPU buffers only, so once its result lands _lbMeshesRaw is empty;
// read after awaitLbReady it holds the prepare-time set only when that promise resolves before the
// worker replies, and otherwise both raw-piece assertions go vacuous -- 0 cubics, and
// "0 collapsed" on nothing. The worker's builder is covered by
// the buildLoopBlinnPartition counts below.
const rawAtPrepare = (bundle._lbMeshesRaw || []).slice();
await renderer.awaitLbReady(bundle);
// MORPH-SAFETY: the drop must be gated to STATIC builds. A STATIC partition ({}) reacts
// to the drop hook (fewer/adjusted cubics); a MORPH-pair partition ({skipCurveInterior})
// must be INVARIANT to it (the gate ignores it), so a piece degenerate at src but real at
// dst is never removed — the pair stays in correspondence. Sum cubic pieces across all
// shapes with the drop hook OFF (0) and ON (3e-3), for each opts flavor.
let staticOff = 0, staticOn = 0, morphOff = 0, morphOn = 0;
{
  const cf = bundle.curveFloats, ranges = bundle.curveRangesByShape;
  const sum = (opts, minEdge) => {
    globalThis.__LB_MIN_EDGE = minEdge; let n = 0;
    for (let s = 0; s < (bundle.numShapes | 0); s++) {
      const r = ranges && ranges[s]; if (!r) continue;
      let contours = null; try { contours = curveRangeToContours(cf, r.begin, r.end); } catch { contours = null; }
      if (!contours) continue;
      let m = null; try { m = buildLoopBlinnPartition(contours, opts); } catch {}
      if (m && m.cubics) n += m.cubics.length;
    }
    return n;
  };
  staticOff = sum({ fillRule: 'nonzero' }, 0);
  staticOn  = sum({ fillRule: 'nonzero' }, 3e-3);
  morphOff  = sum({ fillRule: 'nonzero', skipCurveInterior: true }, 0);
  morphOn   = sum({ fillRule: 'nonzero', skipCurveInterior: true }, 3e-3);
  globalThis.__LB_MIN_EDGE = 0;   // leave it as this page's variant expects (build() already ran)
}
const meshes = bundle._lbMeshes || [], raw = rawAtPrepare;
let real = 0, sent = 0, cubics = 0, collapsed = 0;
for (const m of meshes) { if (m && m.vertexCount) real++; else sent++; }
for (const m of raw) {
  if (!m || m.slug || !m.cubics || !m.cubics.length) continue;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of m.cubics) { const H = c.hull; for (let k = 0; k < 6; k += 2) {
    if (H[k] < x0) x0 = H[k]; if (H[k] > x1) x1 = H[k]; if (H[k+1] < y0) y0 = H[k+1]; if (H[k+1] > y1) y1 = H[k+1]; } }
  const diag = Math.hypot(x1 - x0, y1 - y0) || 1;
  for (const c of m.cubics) { const H = c.hull;
    const e0 = Math.hypot(H[2]-H[0], H[3]-H[1]), e1 = Math.hypot(H[4]-H[2], H[5]-H[3]), e2 = Math.hypot(H[0]-H[4], H[1]-H[5]);
    cubics++; if (Math.max(e0, e1, e2) < 3e-3 * diag) collapsed++;
  }
}
window.__out = { real, sent, census: lbMeshCensus(bundle), cubics, collapsed, staticOff, staticOn, morphOff, morphOn };
window.__ready = true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
// One fresh page per variant → fresh module-level mesh cache, so the drop actually
// re-runs (a shared page reuses cached meshes and would mask the A/B).
const run = async (minEdge) => {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  // __LB_MIN_EDGE is a test hook, read only under __MANTLE_DEBUG__ (forwarded to the build workers with it)
  await page.evaluateOnNewDocument((v) => {
    globalThis.__MANTLE_DEBUG__ = true;
    globalThis.__LB_MIN_EDGE = v;
  }, minEdge);
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 25000, polling: 100 });
  const o = await page.evaluate(() => window.__out);
  await page.close();
  return o;
};
let off, on;
try {
  off = await run(0);
  on = await run(3e-3);
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}
console.log('   drop OFF:', JSON.stringify(off));
console.log('   drop ON :', JSON.stringify(on));
if (off.cubics > 100) ok('non-vacuous: ' + off.cubics + ' cubic pieces exercised (drop off)');
else fail('vacuous: only ' + off.cubics + ' cubic pieces built');
if (on.collapsed === 0) ok('no collapsed cubic survives the drop');
else fail(on.collapsed + ' collapsed cubic pieces survived');
// THE DROP MUST NOT COST ROUTING, and that is all this claims. The audit takes no verdict from a
// degenerate klmn frame (k³ − l·m on a frame three decades below its siblings' is noise), so
// collapsed cubics do not falsely decline a shape in the first place and there is nothing for the
// drop to recover; demanding a recovery would demand false declines.
//
// What the drop is FOR is asserted above: no collapsed cubic survives it, and it measurably
// reshapes the partition. Here we only require that it never makes routing worse.
// ASKED OF THE DECLINE COUNT, not of the sentinel count. The question is whether the drop makes the
// builder give up on a shape it serves without the drop; a row that is never attempted (no
// geometry, refused by the caller's memory budget, or skipped by a build gate) is a sentinel too
// and says nothing about it.
// They agree on this fixture, and that is a property of the fixture, not of the counter.
console.log(
  '   lbMeshCensus OFF:',
  JSON.stringify(off.census),
  '\n   lbMeshCensus ON :',
  JSON.stringify(on.census),
);
if (on.census.declined <= off.census.declined) {
  ok(
    'drop does not cost routing (declined ' +
      off.census.declined +
      ' → ' +
      on.census.declined +
      ', real ' +
      off.real +
      ' → ' +
      on.real +
      ')',
  );
} else {
  fail(
    'drop LOST ' +
      (on.census.declined - off.census.declined) +
      ' shape(s) to Slug (declined ' +
      off.census.declined +
      ' → ' +
      on.census.declined +
      ')',
  );
}
// morph safety: the drop hook must change the STATIC partition output but leave the
// MORPH-pair partition (skipCurveInterior) untouched — proving the drop is gated to
// static so a morph pair never loses a piece that is degenerate at src but real at dst.
console.log(
  '   partition cubics — static off/on:',
  on.staticOff + '/' + on.staticOn,
  ' morph off/on:',
  on.morphOff + '/' + on.morphOn,
);
if (on.staticOff !== on.staticOn)
  ok(
    'drop affects the static partition (' +
      on.staticOff +
      ' → ' +
      on.staticOn +
      ' cubics) — non-vacuous',
  );
else
  fail(
    'drop had no effect on the static partition (' + on.staticOff + ') — hook or fixture broken',
  );
if (on.morphOff === on.morphOn)
  ok(
    'morph-pair partition is INVARIANT to the drop (' +
      on.morphOn +
      ' cubics) — pair topology preserved',
  );
else
  fail(
    'morph-pair partition changed with the drop (' +
      on.morphOff +
      ' → ' +
      on.morphOn +
      ') — the drop is not gated to static; morph pairs will desync',
  );
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nlbDegenerateCubicDropSmoke: near-degenerate cubic pieces dropped from the mesh, no collapsed survivor, routing never worse',
);
