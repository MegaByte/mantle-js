// morphOcclusionCullSmoke.mjs — a morph may cull a shape ONLY if it is hidden for the
// WHOLE animation, not merely at the two ends.
//
// A morph lerps every control point, so "hidden at t=0" says nothing about t=1. Worse,
// "hidden at t=0 AND at t=1" says nothing about the middle: an occluder can shrink
// faster than the shape it hides, expose it midway, and cover it again. Sampling t
// cannot rule that out either. morphCull.js eliminates t analytically — the crossing
// condition S(u,t) = B(v,t) becomes cross(P,Q) = 0 ∧ dot(P,Q) ≤ 0 in (u,v) alone — and
// certifies via Bernstein sign tests that the boundaries never meet for ANY t.
//
// Three cases, all with a RED shape under an opaque GOLD occluder:
//   ALWAYS HIDDEN   the occluder covers it at every t          → must be CULLED
//   EXPOSED AT t=1  the occluder shrinks away                  → must NOT be culled,
//                                                                and red must appear
//   EXPOSED MIDWAY  covered at t=0 and t=1, but not at t=0.5   → must NOT be culled.
//                   This is the case endpoint-testing gets WRONG, and the reason the
//                   test is analytic rather than sampled.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  const m = p.endsWith('.html') ? 'text/html'
    : (p.endsWith('.js') || p.endsWith('.mjs')) ? 'text/javascript'
    : p.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream';
  try { res.writeHead(200, { 'content-type': m + '; charset=utf-8' }); res.end(readFileSync(path.join(ROOT, p))); }
  catch { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

// The RED shape is identical in every pose. Only the GOLD occluder differs.
const RED = 'M120,120 L280,120 L280,240 L120,240 Z';
const svg = (gold) => `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <path id="hidden" d="${RED}" fill="#ff0000"/>
  <path id="cover"  d="${gold}" fill="#DEBD4F"/>
</svg>`;

const COVER_BIG    = 'M100,100 L300,100 L300,300 L100,300 Z';   // covers RED with margin
const COVER_BIG2   = 'M100,100 L300,100 L300,320 L100,320 Z';   // still covers, slightly taller
const COVER_TINY   = 'M100,100 L140,100 L140,140 L100,140 Z';   // exposes RED entirely
// Covers RED at BOTH ends, yet exposes it in the middle. The SAME rectangle, with its
// corners listed rotated by two: every corner lerps to the OPPOSITE corner, so at
// t=0.5 they all meet at the centre and the occluder collapses to a point — RED is
// fully exposed — then it re-expands. Endpoint testing sees two identical covering
// rectangles and would cull; coarse t-sampling can step straight over the collapse.
const COLLAPSE_A = 'M100,100 L300,100 L300,300 L100,300 Z';
const COLLAPSE_B = 'M300,300 L100,300 L100,100 L300,100 Z';

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok   = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 400 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 20000 });

const results = await page.evaluate(async (cases) => {
  const { importSvg, createBundle, createShapeMorph } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const out = {};
  for (const [name, [srcSvg, dstSvg]] of Object.entries(cases)) {
    const bS = createBundle(gl, await importSvg(srcSvg), { occlusionCull: false });
    const bD = createBundle(gl, await importSvg(dstSvg), { occlusionCull: false });
    const m = createShapeMorph(gl, bS, bD);
    // The cull runs off-thread; wait for it to land.
    await new Promise(r => setTimeout(r, 1500));
    const b = m.bundle;
    // RED must never appear when the shape is legitimately hidden, and MUST appear
    // when the morph exposes it — check that on BOTH engines. The cull works at the
    // draw-list level, so Slug and LB (and AAC) all see the same shortened list; this
    // proves the morph's LB route honours it, not just the Slug one.
    const cnv = document.getElementById('glcanvas');
    cnv.width = 400; cnv.height = 400;
    const redAt = (t) => {
      m.setT(t);
      renderer.beginFrame([1, 1, 1, 1]); renderer.drawBundle(b); renderer.endFrame();
      const px = new Uint8Array(400 * 400 * 4);
      gl.readPixels(0, 0, 400, 400, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let red = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] > 170 && px[i + 1] < 90 && px[i + 2] < 90) red++;
      return red;
    };
    const perEngine = {};
    for (const eng of ['off', 'on']) {
      renderer.setLoopBlinnFill(eng);
      if (eng === 'on') await renderer.awaitLbReady(b);
      perEngine[eng === 'off' ? 'slug' : 'lb'] = [redAt(0), redAt(0.5), redAt(1)];
    }
    renderer.setLoopBlinnFill('auto');
    out[name] = {
      culled: b._culledShapes ? [...b._culledShapes] : [],
      draws: b.drawList.filter(o => o.kind === 'fillShape').length,
      shapes: b.numShapes,
      red: perEngine,
    };
    m.dispose(); bS.dispose(); bD.dispose();
  }
  return out;
}, {
  alwaysHidden: [svg(COVER_BIG), svg(COVER_BIG2)],
  exposedAtEnd: [svg(COVER_BIG), svg(COVER_TINY)],
  exposedMidway: [svg(COLLAPSE_A), svg(COLLAPSE_B)],
});

const { alwaysHidden, exposedAtEnd, exposedMidway } = results;
for (const [k, v] of Object.entries(results)) {
  console.log(`  ${k.padEnd(14)} culled=[${v.culled}]  draws ${v.draws}/${v.shapes}`
    + `  red@t=0/0.5/1  slug=[${v.red.slug}] lb=[${v.red.lb}]`);
}

// The cull drops the shape from the DRAW LIST, so every engine sees the same shortened
// list. Assert that on BOTH morph routes rather than trusting it.
for (const eng of ['slug', 'lb']) {
  if (alwaysHidden.red[eng].some(n => n > 50)) {
    fail(`${eng}: a shape hidden for the whole morph still painted red`);
  } else ok(`${eng}: the always-hidden shape paints nothing`);

  const [, , end] = exposedAtEnd.red[eng];
  if (end < 2000) fail(`${eng}: the shape the morph exposes at t=1 did NOT appear (red=${end})`);
  else ok(`${eng}: the shape exposed at t=1 appears (red=${end})`);

  const [, mid] = exposedMidway.red[eng];
  if (mid < 2000) fail(`${eng}: the shape exposed MIDWAY did not appear at t=0.5 (red=${mid})`);
  else ok(`${eng}: the shape exposed midway appears at t=0.5 (red=${mid})`);
}

// 1. Hidden for the whole morph → cull it (shape 0 is the red one).
if (!alwaysHidden.culled.includes(0)) {
  fail('a shape hidden for the ENTIRE morph was not culled — the analytic test should certify this');
} else {
  ok('a shape hidden for the whole morph is culled');
}

// 2. Exposed at t=1 → must survive. Culling it would delete it from the animation.
if (exposedAtEnd.culled.includes(0)) {
  fail('a shape the morph EXPOSES at t=1 was culled — it would vanish from the animation');
} else {
  ok('a shape exposed at t=1 survives');
}

// 3. THE ONE THAT MATTERS. Covered at both ends, exposed in the middle. Endpoint (and
//    coarse-sampled) tests would happily cull this.
if (exposedMidway.culled.includes(0)) {
  fail('a shape exposed MIDWAY was culled — endpoint containment is not sufficient, '
     + 'and the analytic no-crossing certificate should have refused this');
} else {
  ok('a shape exposed midway survives (endpoint containment alone would have culled it)');
}

await browser.close();
server.close();
console.log(failures ? `\nFAILURES: ${failures}` : '\nPASS');
process.exit(failures ? 1 : 0);
