// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cuspFillSmoke — a cubic's CUSP must fill solid to the tip, not fray.
//
// A cusp (B'(t) = 0) is a DOUBLE root of the ray equation the fill kernels solve, and a double
// root is exactly the case a sign-based crossing count cannot decide: "crosses" vs "touches"
// comes down to floating-point noise. Undecided, the tip breaks into alternating covered/uncovered pixels
// — a visible checkerboard fray where the browser (and GWN, which splits its own tree pieces)
// paints a solid point.
//
// The cusp split is done by Loop-Blinn's static builder, not at parse. That keeps
// morph topology faithful. The static builder can then route the split pieces through
// the analytic path without changing the source geometry seen by morph matching.
//
// The fray is INTERIOR speckle, so the test is spatial, not a mean: no pixel deep inside the
// wedge may be background. A mean over the image cannot see 30 alternating pixels.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { emitFixture } from './_fixtures.mjs';
import { parsePathD } from '../src/svg/path.js';
import { splitCubicCusps } from '../src/svg/cubicCusp.js';
import { SEG_CUBIC } from '../src/svg/segment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 400;

// The cusp is at t = 0.5 of the cubic: x' and y' both vanish there (control points chosen so
// the derivative's quadratic has a double root). The tip points +x at (~115, 100) in user units.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200">
  <path d="M 40 40 L 40 160 L 100 160 C 140 40 140 160 100 40 Z" fill="#3366cc"/>
</svg>`;
emitFixture('cuspFill__SVG', SVG);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;
globalThis.__MANTLE_NO_STATIC_CACHE = true;
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, premultipliedAlpha:true, preserveDrawingBuffer:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const N = ${N}, SVG = ${JSON.stringify(SVG)};
const read = () => { const px = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,px); return px; };

async function paint(rOpts, impOpts, lbMode) {
  const r = createRenderer(gl, shaders, rOpts || {});
  r.setLoopBlinnFill(lbMode || 'off');
  const b = createBundle(gl, await importSvg(SVG, impOpts || {}));
  r.prepareBundle(b);
  if (r.awaitLbReady && lbMode !== 'off') await r.awaitLbReady(b);
  r.setViewport(N,N); r.beginFrame([1,1,1,1]); r.drawBundle(b, {}); r.endFrame();
  return { px: read(), sentinel: !!b._lbHasSlug,
    routed: r.debugStats.loopBlinnRouteCount > 0 };
}
const lb   = await paint(null, null, 'on');
const gwn  = await paint({ fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF'] }, { gwnTree:true }, 'off');
const slug = await paint(null, null, 'off');

// FRAY DETECTOR. The fray is a CHECKERBOARD at the tip: background pixels with ink all around
// them. So count background pixels that have at least 6 of their 8 neighbors inked — an
// isolated hole. A solid fill (and a clean AA edge, whose background pixels have 3-5 ink
// neighbors at most) produces none.
//
// Scanning each row's ink SPAN and looking strictly inside it finds nothing at all: the fray
// lives at the END of each row's span, where the wedge closes. Such a detector reports 0 for
// Slug, which visibly frays — it cannot see the defect it exists for.
const speckle = (px) => {
  const isInk = (x,y) => (x>=0 && y>=0 && x<N && y<N) && px[((N-1-y)*N + x)*4] < 200;
  let n = 0;
  for (let y = 1; y < N-1; y++) for (let x = 1; x < N-1; x++) {
    if (isInk(x,y)) continue;
    let ink = 0;
    for (let dy=-1; dy<=1; dy++) for (let dx=-1; dx<=1; dx++)
      if ((dx || dy) && isInk(x+dx, y+dy)) ink++;
    if (ink >= 6) n++;
  }
  return n;
};
window.__out = {
  lbSpeckle: speckle(lb.px), gwnSpeckle: speckle(gwn.px), slugSpeckle: speckle(slug.px),
  lbSentinel: lb.sentinel, lbRouted: lb.routed,
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
const br = await launchBrowser({ headless: 'new', args: ['--no-sandbox'] });
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
// Interval polling: the default raf-based poll can stall in headless runs
// (the page finishes but rAF never fires), timing out a passing test.
await pg.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 250 });
const o = await pg.evaluate(() => window.__out);
await br.close();
server.close();

let fail = 0;
const ok = (c, m) => (c ? console.log('  ok ' + m) : (fail++, console.error('  FAIL ' + m)));

// PARSE STAYS FAITHFUL: the cusp cubic comes back whole (one segment per command), so a morph pose
// of this path always has the same segment count regardless of how cusp-y its geometry is.
const D = 'M 40 40 L 40 160 L 100 160 C 140 40 140 160 100 40 Z';
const segs = parsePathD(D);
const cubics = segs.filter((s) => s.type === SEG_CUBIC);
console.log(`  parse: "${D}" -> ${segs.length} segments (${cubics.length} cubics)`);
console.log(
  `  interior background pixels (the fray): LB=${o.lbSpeckle}  GWN=${o.gwnSpeckle}  Slug=${o.slugSpeckle}`,
);
ok(
  cubics.length === 1,
  `parse keeps the cusp cubic WHOLE — morph-safe (got ${cubics.length} cubics)`,
);
ok(
  segs.length === 4,
  `2 lines + 1 cubic + the closing line, no split at parse (got ${segs.length})`,
);

// The RENDER-INTERNAL splitter (svg/cubicCusp.js, used by LB's static builder) turns that whole
// cusp cubic into TWO cubics meeting at the cusp.
const split = splitCubicCusps(segs);
const splitCubics = split.filter((s) => s.type === SEG_CUBIC);
ok(
  splitCubics.length === 2,
  `splitCubicCusps splits the cusp cubic in TWO (got ${splitCubics.length})`,
);
const meet = splitCubics[0].p4,
  start2 = splitCubics[1].p1;
ok(
  Math.hypot(meet[0] - start2[0], meet[1] - start2[1]) < 1e-9,
  'the halves meet exactly at the cusp',
);
ok(
  splitCubicCusps(parsePathD('M 40 40 C 60 40 80 60 80 80')).length === 1,
  'a cusp-free cubic is left alone by the splitter',
);
ok(
  !o.lbSentinel && o.lbRouted,
  'Loop-Blinn routes the internally split cusp through clean analytic pieces',
);
ok(
  o.lbSpeckle === 0,
  `the analytic Loop-Blinn route fills the cusp solid (${o.lbSpeckle} interior background px)`,
);
ok(
  o.gwnSpeckle === 0,
  `GWN fills the cusp solid to the tip (${o.gwnSpeckle} interior background px)`,
);

// KNOWN GAP, deliberately not an assertion. The split makes the cusp an endpoint, which is what
// LB and GWN needed — but the Slug band walk still frays there: its coverage at a tip narrower
// than a pixel double-counts two near-tangent branches in the same band. Reported, not asserted,
// so the number stays visible.
if (o.slugSpeckle > 0)
  console.log(
    `  NOTE: Slug still frays at the cusp (${o.slugSpeckle} interior background px) — ` +
      "the band walk's sub-pixel tip coverage; GWN is the clean route.",
  );

console.log(fail ? `\nCUSP-FILL FAIL (${fail})` : '\nCUSP-FILL PASS');
process.exit(fail ? 1 : 0);
