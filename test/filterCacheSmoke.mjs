// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Filter result cache. Two alternating bundles each have two filtered shapes
// sharing a graph, plus a plain sibling shape. Asserts:
//   1. Static re-renders reuse each filter output across both graph IDs and
//      bundle switches. The composite still re-runs (backdrop may change).
//   2. Animating the SIBLING (not the filtered shape) does NOT
//      re-evaluate the filter — its feedShapeMask shape is unchanged.
//   3. Animating the FILTERED shape DOES re-evaluate.
//   4. Output stays visually correct throughout (filter content present).
//
// A filter-cache HIT must paint what the MISS painted (second page, the demo page). The filter graph is evaluated
// once and its root stashed in a per-graph texture; every later draw with the same key skips the evaluation and
// composites that texture instead. Two code paths, one expected image. It matters because the cached texture is sized
// to the filter's BBOX rather than to the canvas: the hit path has to remember WHERE on the canvas that texture belongs
// and composite it back there. Store the rect and drop it (or store it and ignore it) and the cached frame lands in the
// corner, or scaled -- and only from the second frame on, which is exactly the kind of defect that reaches an app and
// not a test suite. So: draw the same filtered card twice. Frame 1 evaluates the graph (miss), frame 2 composites the
// cache (hit). The frames must be identical.
//
// RESIDENCY (third page): a static filtered scene must stop evaluating its filter graphs after the first frame, and
// the cached frames must be identical to the one they replace. A filter-result cache bounded at 8 ENTRIES fails a
// bundle with more filtered shapes than that: every result goes into 8 slots, so each entry is evicted long before the
// next frame asks for it -- a permanent 0% hit rate that is WORSE than no cache, since every miss still pays a texture
// allocation, a framebuffer and a blit on top of re-running the graph (6.6-11.9x slower on real assets). This asserts
// both halves, because either alone is passable while broken:
//   evals after warm-up  == 0   (the cache is actually being hit)
//   warm frame           == cold frame, byte for byte (hitting it is CORRECT)
// It uses MORE filtered shapes than any small entry cap would hold, so a count-based bound fails the first assertion.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Two shapes with ids so the override table can target them:
//   #blurred — a red rect with a feTurbulence filter. feTurbulence forces
//              the composable filter-graph path (filterGraphId), which is
//              what the cache wraps. (A lone feGaussianBlur reduces to the
//              single-kind fast path.)
//   #plain   — a green rect, no filter (the animating sibling)
const SVG = readFileSync(
  new URL('../examples/smoke/filterCache__SVG.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="200" height="200"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const sections = await importSvg(${JSON.stringify(SVG)});
const bundle = createBundle(gl, sections);
const bundle2 = createBundle(gl, sections);
const ovr = createOverrideTable(gl, bundle);
// Two mounts may share one bundle but own independent override tables. Their
// generation counters can agree even when their values do not.
const shared = createBundle(gl, sections);
const handleA = renderer.createBundleHandle(shared);
const handleB = renderer.createBundleHandle(shared);
const overrideA = createOverrideTable(gl, shared);
const overrideB = createOverrideTable(gl, shared);
overrideA.set('blurred', { localPosition: [0, 0] });
overrideB.set('blurred', { localPosition: [18, 0] });
const id = new Float32Array([1,0,0, 0,1,0, 0,0,1]);
window.__r = renderer; window.__gl = gl;
window.__hasGraph = !!(bundle.filterGraphs && bundle.filterGraphs.length);
window.__frame = (useOvr) => {
  renderer.setViewport(200, 200);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(bundle, useOvr ? { worldMatrix: id, overrides: ovr } : { worldMatrix: id });
  renderer.drawBundle(bundle2, { worldMatrix: id });
  renderer.endFrame();
};
// More than the renderer's transient-handle capacity worth of unrelated
// bundles must not evict the independently bounded filter-output cache.
window.__churnTransientHandles = async () => {
  const plain = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/></svg>');
  const churn = Array.from({ length: 9 }, () => createBundle(gl, plain));
  renderer.setViewport(200, 200);
  renderer.beginFrame([0,0,0,1]);
  renderer.drawBundle(bundle, { worldMatrix: id });
  for (const b of churn) renderer.drawBundle(b, { worldMatrix: id });
  renderer.drawBundle(bundle2, { worldMatrix: id });
  renderer.endFrame();
  for (const b of churn) b.dispose();
};
window.__handleFrame = () => {
  renderer.setViewport(200, 200);
  renderer.beginFrame([0,0,0,1]);
  handleA.draw({ worldMatrix: id, overrides: overrideA });
  handleB.draw({ worldMatrix: id, overrides: overrideB });
  renderer.endFrame();
};
window.__animate = (shapeId, dx) => { ovr.set(shapeId, { localPosition: [dx, 0] }); };
window.__sample = (x, yTop) => { const b = new Uint8Array(4); gl.readPixels(x, 200-1-yTop, 1,1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0],b[1],b[2],b[3]]; };
window.__evals = () => renderer.debugStats.filterEvalCount;
window.__ready = true;
</script></body></html>`;

// A drop shadow decomposes to feGaussianBlur → feOffset → feFlood → feComposite →
// feMerge: five nodes, five rects, none of them the canvas.
const CARD = readFileSync(
  new URL('../examples/smoke/filterCacheHit__CARD.svg', import.meta.url),
  'utf8',
);

// The residency scene: more filtered shapes than any small entry cap would hold.
const N = 256,
  SHAPES = 24;

// Each circle gets its own filter so each is a distinct cache entry.
let defs = '',
  body = '';
for (let i = 0; i < SHAPES; i++) {
  const cx = 20 + (i % 6) * 42,
    cy = 20 + Math.floor(i / 6) * 42;
  defs +=
    `<filter id="f${i}" x="-50%" y="-50%" width="200%" height="200%">` +
    `<feGaussianBlur stdDeviation="${1 + (i % 3)}"/></filter>`;
  body += `<circle cx="${cx}" cy="${cy}" r="14" fill="#${(0x334455 + i * 0x050301).toString(16).slice(0, 6)}" filter="url(#f${i})"/>`;
}
const RESIDENCY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs>${defs}</defs>${body}</svg>`;

const RESIDENCY_HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl=document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N};
const r=createRenderer(gl,shaders,{});
const grab=()=>{const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p); return p;};
window.__run=async(svg)=>{
  const sec=await importSvg(svg); const b=createBundle(gl,sec);
  r.setViewport(N,N); gl.viewport(0,0,N,N);
  r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame();
  const cold=grab(); const e0=r.debugStats.filterEvalCount|0;
  for(let f=0;f<4;f++){ r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); }
  const warm=grab(); const warmEvals=(r.debugStats.filterEvalCount|0)-e0;
  let ink=0; for(let i=0;i<N*N;i++) ink += (255-cold[i*4])/255;
  let nd=0,max=0; for(let i=0;i<cold.length;i++){const d=Math.abs(cold[i]-warm[i]); if(d){nd++; if(d>max)max=d;}}
  const st=r.debugStats;
  b.dispose();
  return {coldEvals:e0, warmEvals, nd, max, ink, entries:st.filterCacheEntries|0};
};
window.__ready=true;
</script></body></html>`;
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/residency') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/' ? HTML : RESIDENCY_HTML);
    return;
  }
  let p = decodeURIComponent(req.url.split('?')[0]);
  const ct = p.endsWith('.glsl')
    ? 'text/plain'
    : p.endsWith('.html')
      ? 'text/html'
      : 'text/javascript';
  try {
    res.writeHead(200, { 'content-type': ct + '; charset=utf-8' });
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
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
try {
  await openReady(page, `http://127.0.0.1:${port}/`, { ready: 'flag' });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

if (await page.evaluate(() => window.__hasGraph)) ok('fixture produced a filter graph');
else fail('no filter graph — test vacuous (filter may have reduced to single-kind path)');

// Frame 1 + correctness: blur edge is soft (a pixel just outside the
// rect's hard edge should still have some red from the blur).
const r1 = await page.evaluate(() => {
  window.__frame(false);
  return { edge: window.__sample(60, 60), evals: window.__evals() };
});
if (r1.evals === 4) ok('frame 1 evaluated each filtered shape in both bundles once');
else fail('eval count after frame 1: ' + r1.evals);
if (r1.edge[3] > 8) ok('filtered (turbulence) content present inside rect (a=' + r1.edge[3] + ')');
else fail('no filtered content: ' + r1.edge);

// 4 more static frames → no more evals (cache hits). This catches both shapes
// sharing one graph ID and alternating bundles disposing one another's entries.
const r2 = await page.evaluate(() => {
  for (let i = 0; i < 4; i++) window.__frame(false);
  return window.__evals();
});
if (r2 === 4) ok('4 static frames: filters NOT re-evaluated (count still 4)');
else fail('filter re-evaluated on static re-render: ' + r2);

// Transient geometry-handle churn must not discard a still-useful filtered
// output. The cache itself has its own bounded LRU.
const r2c = await page.evaluate(async () => {
  await window.__churnTransientHandles();
  window.__frame(false);
  return window.__evals();
});
if (r2c === 4) ok('filtered output survives unrelated transient-handle churn');
else fail('transient-handle churn evicted filter output: ' + r2c);

// Animate the SIBLING (plain) — filter must NOT re-evaluate.
const r3 = await page.evaluate(() => {
  window.__animate('plain', 5);
  window.__frame(true);
  window.__animate('plain', 10);
  window.__frame(true);
  return { evals: window.__evals(), halo: window.__sample(60, 60) };
});
if (r3.evals === 4) ok('sibling animates → filters NOT re-evaluated (count still 4)');
else fail('sibling animation re-evaluated filter: ' + r3.evals);
if (r3.halo[3] > 8) ok('filtered output still present after sibling animation');
else fail('filter output lost: ' + r3.halo);

// Animate the FILTERED shape — filter MUST re-evaluate.
const r4 = await page.evaluate(() => {
  window.__animate('blurred', 8);
  window.__frame(true);
  return window.__evals();
});
if (r4 === 5) ok('filtered shape animates → only its filter re-evaluated (count→5)');
else fail('filtered shape animation did not re-evaluate: ' + r4);

// Two persistent handles over one bundle have equal override generations but
// distinct values. Their first render must evaluate separately; later renders
// must hit their own entries.
const hi = await page.evaluate(() => {
  const base = window.__evals();
  window.__handleFrame();
  const first = window.__evals() - base;
  window.__handleFrame();
  const second = window.__evals() - base;
  return { first, second };
});
if (hi.first === 4) ok('separate handles with same-gen overrides evaluate separately');
else fail('handle filter cache crossed override tables: ' + hi.first + ' initial evals');
if (hi.second === 4) ok('separate handles reuse their own filter entries');
else fail('handle filter cache missed on static re-render: ' + hi.second);

// ---- Single-kind path (lone feGaussianBlur — the COMMON case) ----
// A lone blur reduces to the single-kind filter path, not the graph
// path. Verify it caches the same way: static no re-eval, sibling no
// re-eval, filtered shape re-evals, and the cached output is identical.
{
  const blurSvg = readFileSync(
    new URL('../examples/smoke/filterCache__blurSvg.svg', import.meta.url),
    'utf8',
  );
  await page.evaluate(async (svg) => {
    const { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } =
      await import('/src/index.js');
    const cnv = document.getElementById('c');
    const gl = cnv.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: true });
    const sh = await loadShaders(new URL('/src/shaders/', location.href).href);
    const r = createRenderer(gl, sh);
    const sections = await importSvg(svg);
    const b = createBundle(gl, sections);
    const b2 = createBundle(gl, sections);
    const ovr = createOverrideTable(gl, b);
    const id = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    window.__bHasGraph = !!(b.filterGraphs && b.filterGraphs.length);
    window.__bframe = (o) => {
      r.setViewport(200, 200);
      r.beginFrame([0, 0, 0, 1]);
      r.drawBundle(b, o ? { worldMatrix: id, overrides: ovr } : { worldMatrix: id });
      r.drawBundle(b2, { worldMatrix: id });
      r.endFrame();
    };
    window.__ban = (s, d) => ovr.set(s, { localPosition: [d, 0] });
    window.__bev = () => r.debugStats.filterEvalCount;
    window.__bcore = () => {
      const x = new Uint8Array(4);
      gl.readPixels(90, 200 - 1 - 90, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, x);
      return x[0];
    };
  }, blurSvg);
  const sk = await page.evaluate(() => {
    const base = window.__bev();
    window.__bframe(false);
    const e1 = window.__bev() - base,
      c1 = window.__bcore();
    for (let i = 0; i < 4; i++) window.__bframe(false);
    const e2 = window.__bev() - base;
    window.__ban('pl', 10);
    window.__bframe(true);
    const e3 = window.__bev() - base;
    window.__ban('bl', 8);
    window.__bframe(true);
    const e4 = window.__bev() - base;
    const c2 = window.__bcore();
    return { graph: window.__bHasGraph, e1, e2, e3, e4, c1, c2 };
  });
  if (sk.graph === false) ok('single-kind: lone blur uses the single-kind path (not graph)');
  else fail('lone blur unexpectedly produced a graph');
  if (sk.e1 === 2) ok('single-kind: both bundles evaluated once');
  else fail('single-kind eval after f1: ' + sk.e1);
  if (sk.e2 === 2) ok('single-kind: static re-renders cache hit across bundle switches');
  else fail('single-kind re-eval on static: ' + sk.e2);
  if (sk.e3 === 2) ok('single-kind: sibling animates → no re-eval');
  else fail('single-kind sibling re-eval: ' + sk.e3);
  if (sk.e4 === 3) ok('single-kind: filtered shape animates → only its filter re-evaluates');
  else fail('single-kind filtered no re-eval: ' + sk.e4);
  if (sk.c1 > 200 && sk.c2 === sk.c1)
    ok('single-kind: cached blur output identical (core red ' + sk.c1 + ')');
  else fail('single-kind output changed: ' + sk.c1 + ' vs ' + sk.c2);
}

// The cache HIT paints the MISS, on the demo page with a bbox-sized cached texture.
async function cacheHitSection() {
  const url = `http://127.0.0.1:${port}/mantleDemo.html`;
  const page = await browser.newPage();
  await page.setViewport({ width: 500, height: 500 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await page.goto(url, { waitUntil: 'load', timeout: pageTimeoutFor() });
  await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
    timeout: pageTimeoutFor(),
    polling: 100,
  });

  const res = await page.evaluate(async (svg) => {
    const { importSvg, createBundle } = await import('/src/index.js');
    const gl = window.__mantleGl;
    const renderer = window.__mantleRenderer;
    const cnv = document.getElementById('glcanvas');
    // A big canvas and a small card — the shape the bbox RTs are for, and the shape
    // that makes a mis-placed cache texture obvious.
    const W = 900,
      H = 1100;
    cnv.width = W;
    cnv.height = H;
    const WM = [0.5, 0, 0, 0, 0.5, 0, 0.15, 0.2, 1];

    const asset = await importSvg(svg);
    const b = createBundle(gl, asset);
    const h = renderer.createBundleHandle(b);

    const shot = () => {
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    };
    const frame = () => {
      renderer.beginFrame([1, 1, 1, 1]);
      h.draw({ worldMatrix: WM });
      renderer.endFrame();
      return shot();
    };

    const miss = frame(); // evaluates the graph
    const evalsAfterMiss = renderer.debugStats.filterEvalCount;
    const hit = frame(); // must come off the cache
    const evalsAfterHit = renderer.debugStats.filterEvalCount;

    let diff = 0,
      worst = 0,
      ink = 0;
    for (let i = 0; i < miss.length; i += 4) {
      // Non-white = the card + its shadow. Guards against both frames being blank.
      if (miss[i] < 250 || miss[i + 1] < 250 || miss[i + 2] < 250) ink++;
      const d = Math.max(
        Math.abs(miss[i] - hit[i]),
        Math.abs(miss[i + 1] - hit[i + 1]),
        Math.abs(miss[i + 2] - hit[i + 2]),
        Math.abs(miss[i + 3] - hit[i + 3]),
      );
      if (d > 0) diff++;
      if (d > worst) worst = d;
    }
    h.dispose();
    b.dispose();
    return { diff, worst, ink, total: W * H, evalsAfterMiss, evalsAfterHit };
  }, CARD);

  console.log(
    `  ink ${res.ink}px   graph evals: ${res.evalsAfterMiss} after miss, ${res.evalsAfterHit} after hit`,
  );

  if (res.ink < 1000) {
    fail(`the card barely rendered (${res.ink}px of ink) — this smoke would pass on a blank frame`);
  } else {
    ok(`the filtered card rendered (${res.ink}px of ink)`);
  }
  if (res.evalsAfterMiss < 1) {
    fail(
      `frame 1 never evaluated a filter graph (${res.evalsAfterMiss} evals) — the card ` +
        `isn't taking the graph path at all, so nothing below is testing the filter cache`,
    );
  } else if (res.evalsAfterHit !== res.evalsAfterMiss) {
    fail(
      `frame 2 re-evaluated the graph (${res.evalsAfterMiss} → ${res.evalsAfterHit}) — ` +
        `it never took the cache HIT, so this smoke is comparing two misses and proves nothing`,
    );
  } else {
    ok('frame 2 took the cache hit (no second graph evaluation)');
  }
  if (res.diff > 0) {
    fail(
      `the cache HIT does not match the MISS — ${res.diff}px differ (worst ${res.worst}). ` +
        `The cached texture is sized to the filter's bbox; the hit path has to composite it ` +
        `back at that rect, not at the canvas origin and not stretched to the canvas.`,
    );
  } else {
    ok('cache hit is byte-identical to the miss (0px differ)');
  }

  await page.close();
}
// Residency: a static scene with more filtered shapes than a small entry cap stops evaluating after frame 1.
async function residencySection() {
  const pg = await browser.newPage();
  const errs = [];
  pg.on('pageerror', (e) => errs.push(String(e.message)));
  await pg.goto(`http://127.0.0.1:${server.address().port}/residency`, {
    waitUntil: 'load',
    timeout: pageTimeoutFor(),
  });
  let o = null;
  try {
    await pg.waitForFunction(() => window.__ready === true, {
      timeout: pageTimeoutFor(),
      polling: 50,
    });
    o = await pg.evaluate((s) => window.__run(s), RESIDENCY_SVG);
  } catch (e) {
    fail('page never ran: ' + (errs.join(' | ') || e.message));
  }
  await pg.close();
  if (!o) return;
  check(o.ink > 200, `the scene actually rendered (ink ${o.ink.toFixed(0)})`);
  check(o.coldEvals >= SHAPES, `cold frame evaluated all ${SHAPES} graphs (got ${o.coldEvals})`);
  check(
    o.warmEvals === 0,
    `warm frames evaluated NOTHING (got ${o.warmEvals} — nonzero means cache thrash)`,
  );
  check(
    o.nd === 0,
    `warm frame is byte-identical to cold (differing bytes ${o.nd}, max delta ${o.max})`,
  );
  check(o.entries >= SHAPES, `cache holds all ${SHAPES} results (got ${o.entries})`);
}
const check = (c, m) => (c ? ok(m) : fail(m));
await page.close();
for (const [name, section] of [
  ['FILTER-CACHE-HIT', cacheHitSection],
  ['FILTER-CACHE-RESIDENCY', residencySection],
]) {
  const before = failures;
  try {
    await section();
  } catch (e) {
    fail(name + ': ' + e.message);
  }
  console.log(failures === before ? `${name} PASS` : `${name} FAIL (${failures - before})`);
}

await browser.close();
server.close();
if (failures === 0) console.log('\nFILTER-CACHE PASS');
else console.log(`\nFILTER-CACHE FAIL (${failures})`);
process.exit(failures ? 1 : 0);
