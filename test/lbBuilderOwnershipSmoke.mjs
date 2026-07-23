// lbBuilderOwnershipSmoke — creating a SECOND renderer must not stop the first one building LB.
//
// The off-thread LB builder is registered through a module-level singleton (setLbBuilder), so the
// LAST renderer created owned it. Its first line is `if (R._lbSlugOnly) return;` — so the moment
// anything created a Slug-only renderer (which is every non-LB engine: AAC, GWN, hard, and any app
// that keeps a second renderer around), NO bundle created afterwards ever got LB meshes built, and
// LB silently declined for the rest of the session. In the demo: pick LB, it works; pick AAC; pick
// LB again — declined, permanently.
//
// The bundle is shared, so this is not about which renderer draws: it is that nobody BUILT the
// meshes. Build if ANY registered builder wants them.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { emitFixture } from './_fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 220;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <path fill="#3366cc" fill-rule="evenodd" d="M 170 100 C 170 61.34 138.66 30 100 30 C 61.34 30 30 61.34 30 100 C 30 138.66 61.34 170 100 170 C 138.66 170 170 138.66 170 100 Z M 135 100 C 135 80.67 119.33 65 100 65 C 80.67 65 65 80.67 65 100 C 65 119.33 80.67 135 100 135 C 119.33 135 135 119.33 135 100 Z"/>
</svg>`;
const LINE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <path fill="#3366cc" d="M 25 25 L 175 25 L 175 175 L 25 175 Z"/>
</svg>`;
emitFixture('lbBuilderOwnership__RING', SVG);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, SVG = ${JSON.stringify(SVG)}, LINE_SVG = ${JSON.stringify(LINE_SVG)};

// 1. the LB renderer, created FIRST — exactly as an app would
const rLb = createRenderer(gl, shaders);
rLb.setLoopBlinnFill('on');

// NB: no prepareBundle(). That builds explicitly and would mask the bug. An app (and this repo's
// demo) relies on the AUTO-BUILD that createBundle kicks off — which is the path that goes through
// the singleton, and the path that a second renderer disarms.
const lbMeshes = async () => {
  const b = createBundle(gl, await importSvg(SVG));
  await rLb.awaitLbReady(b);
  const m = b._lbMeshes || [];
  const real = m.filter(x => x && x.vertexCount).length;
  const c0 = rLb.debugStats.loopBlinnRouteCount;
  rLb.setViewport(N,N); rLb.beginFrame([1,1,1,1]); rLb.drawBundle(b, {}); rLb.endFrame();
  const routed = rLb.debugStats.loopBlinnRouteCount - c0;
  b.dispose();
  return { meshes: m.length, real, routed };
};

const before = await lbMeshes();

// 2. now create a SECOND, Slug-only renderer — what the demo does for AAC/GWN/hard, and what any
//    app with a second renderer does. It must not disarm the first one.
const rAac = createRenderer(gl, shaders, { aacFill: true });
rAac.setLoopBlinnFill('off');

// 3. back to LB, with a FRESH bundle (the demo rebuilds on every engine switch)
const after = await lbMeshes();

// 4. DISPOSE the second renderer. Its hook must come back OUT of the registry — a disposed
//    renderer's closure captures a dead GL context, and leaving it registered would hand the next
//    bundle's build to a renderer that no longer exists. (The registry that fixes the bug above is
//    what makes this hazard possible: a single slot used to be overwritten by the next renderer.)
rAac.dispose();
const afterDispose = await lbMeshes();

// 5. dispose the LB renderer's PEER while LB is still live, then build again — the surviving
//    renderer must still be the one that builds.
const rGwn = createRenderer(gl, shaders, { fillDefines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'] });
rGwn.setLoopBlinnFill('off');
rGwn.dispose();
const afterPeerGone = await lbMeshes();

// 6. With every analytic renderer gone, an explicitly Slug-only renderer must
// not rebuild LB through the legacy idle-preparer fallback.
rLb.dispose();
const rOff = createRenderer(gl, shaders); rOff.setLoopBlinnFill('off');
const bOff = createBundle(gl, await importSvg(SVG));
await new Promise(q => setTimeout(q, 100));
const slugOnly = { decided: bOff._lbMeshes !== undefined, memory: rOff.getLoopBlinnMemoryUse() };
bOff.dispose(); rOff.dispose();

// 7. Auto mode should not spend worker time or memory on straight-only geometry,
// but changing that same renderer to forced LB must build it on demand.
const rAuto = createRenderer(gl, shaders);
const bAuto = createBundle(gl, await importSvg(LINE_SVG));
await new Promise(q => setTimeout(q, 100));
const autoWaitStart = performance.now();
const autoReady = await rAuto.awaitLbReady(bAuto);
const autoSkipped = {
  decided: bAuto._lbMeshes !== undefined,
  memory: rAuto.getLoopBlinnMemoryUse(),
  ready: autoReady,
  waitMs: performance.now() - autoWaitStart,
};
rAuto.setLoopBlinnFill('on');
const forcedReady = await rAuto.awaitLbReady(bAuto);
const forcedStart = rAuto.debugStats.loopBlinnRouteCount;
rAuto.setViewport(N,N); rAuto.beginFrame([1,1,1,1]); rAuto.drawBundle(bAuto, {}); rAuto.endFrame();
const forced = {
  ready: forcedReady,
  routed: rAuto.debugStats.loopBlinnRouteCount - forcedStart,
  memory: rAuto.getLoopBlinnMemoryUse(),
};
bAuto.dispose(); rAuto.dispose();

window.__out = { before, after, afterDispose, afterPeerGone, slugOnly, autoSkipped, forced };
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(HTML); return; }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch { if (!res.headersSent) res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
// Interval polling: the default raf-based poll can stall in headless runs
// (the page finishes but rAF never fires), timing out a passing test.
await pg.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 250 });
const o = await pg.evaluate(() => window.__out);
await br.close(); server.close();

let fail = 0;
const ok = (c, m) => c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m));

console.log(`  before a 2nd renderer exists: ${o.before.real}/${o.before.meshes} meshes built, LB routed ${o.before.routed}`);
console.log(`  after  a Slug-only renderer : ${o.after.real}/${o.after.meshes} meshes built, LB routed ${o.after.routed}`);
console.log(`  after  disposing it         : ${o.afterDispose.real}/${o.afterDispose.meshes} meshes built, LB routed ${o.afterDispose.routed}`);
console.log(`  after  a disposed peer      : ${o.afterPeerGone.real}/${o.afterPeerGone.meshes} meshes built, LB routed ${o.afterPeerGone.routed}`);

ok(o.before.real > 0 && o.before.routed > 0, 'LB builds and routes before any other renderer exists');
ok(o.after.real > 0, `LB still BUILDS meshes after a Slug-only renderer is created (${o.after.real} real)`);
ok(o.after.routed > 0, 'LB still ROUTES after a Slug-only renderer is created');
ok(o.afterDispose.real > 0 && o.afterDispose.routed > 0,
   `LB survives that renderer being DISPOSED (${o.afterDispose.real} meshes, routed ${o.afterDispose.routed})`);
ok(o.afterPeerGone.real > 0 && o.afterPeerGone.routed > 0,
   `LB survives a create-then-dispose peer (${o.afterPeerGone.real} meshes, routed ${o.afterPeerGone.routed})`);
ok(!o.slugOnly.decided && o.slugOnly.memory === 0,
   'Slug-only renderers do not enqueue an LB idle build');
ok(!o.autoSkipped.decided && o.autoSkipped.memory === 0,
   'auto mode skips LB construction for straight-only bundles');
ok(!o.autoSkipped.ready && o.autoSkipped.waitMs < 250,
   `awaitLbReady resolves false immediately for an auto-skipped bundle (${o.autoSkipped.waitMs.toFixed(1)} ms)`);
ok(o.forced.ready && o.forced.routed > 0 && o.forced.memory > 0,
   'switching an auto-skipped bundle to forced LB builds and routes it on demand');

console.log(fail ? `\nLB-BUILDER-OWNERSHIP FAIL (${fail})` : '\nLB-BUILDER-OWNERSHIP PASS');
process.exit(fail ? 1 : 0);
