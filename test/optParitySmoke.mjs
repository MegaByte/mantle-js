// optParitySmoke.mjs — every optimization must be OUTPUT-IDENTICAL to the plain path.
//
// This is the test that was missing. The suite had deep coverage of each subsystem in
// isolation, and still shipped a filter optimization that CLIPPED THE TOP EDGE off every
// filtered shape (Color Match / Brain Shift cards) — because nothing ever asked the one
// question that matters about an optimization: does turning it on change any pixel?
//
// The root cause was that nothing owned the mapping between a filter pass's viewport and
// its textures. The RT pool rounded each RT up to a 32px bucket, so the framebuffer was
// taller than the canvas: the per-node scissor's y-flip (ch − (y+hgt)) sat shifted and
// cut the top off, AND every pass resampled the image, because the shaders read `vUV`
// (0..1 across the VIEWPORT) as if it were 0..1 across the TEXTURE — which is what made
// filtered cards look low-res and upscaled. That mapping is now explicit: an RT carries
// its canvas rect and consumers remap uv through it (src/shaders/_filterRect.glsl).
//
// This smoke never did reproduce the clip — a bundle drawn here through a worldMatrix on
// a portrait canvas came out identical either way — so treat the cases below as a floor,
// not a ceiling. If an optimization ever looks wrong in an app and passes here, the smoke
// is the thing that's incomplete.
//
// Each optimization here is a pure performance trade with NO licence to alter output.
// Render each asset twice — optimization off, then on — and require the frames to
// match. A path that cannot pass this is not an optimization, it is a bug.
//
// NOT in this list, deliberately: the occlusion cull. It is allowed to change pixels
// (removing a hidden shape's conflated AA fringe is the point), so identity is the
// wrong assertion — occlusionCullSmoke owns it. It IS exercised here on content with
// nothing occluded, where it must be invisible.

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

// A FILTERED shape — the exact shape of the bug: a rounded card with a drop shadow,
// which the importer decomposes to feGaussianBlur → feOffset → feFlood → feComposite
// → feMerge. The scissor clipped its top edge.
const CARD = readFileSync(new URL('../examples/smoke/optParity__CARD.svg', import.meta.url), 'utf8');

// A CLIP SHAPE for the external screen-space clip (setNodeClip). The clip's coverage
// is a CANVAS-space texture that the fill shader samples by gl_FragCoord — and a
// filtered shape no longer renders into a canvas-sized framebuffer, it renders into an
// RT covering only its own rect, where gl_FragCoord is rect-local. Get the frame origin
// wrong and the clip is sampled at the wrong place: the card gets cut by the wrong part
// of the clip, which is a plausible-looking image rather than an obviously broken one.
// (A <mask> would not reach this path — Mantle attaches masks to a GROUP, and a group's
// filtered shape still renders canvas-sized. The external clip is the co-occurrence
// that does.)
const CLIP = readFileSync(new URL('../examples/smoke/optParity__CLIP.svg', import.meta.url), 'utf8');

// A LONE feGaussianBlur — the "single-kind" filter path. No graph: the shape is
// rendered offscreen and the kernel runs on it IN PLACE, so it is a separate route
// from the drop shadow above with its own target, its own cache and its own idea of
// how far the kernel reaches. It renders into a rect-sized RT too, and if the reach
// is under-estimated the blur is CLIPPED at the rect edge — a soft halo that just
// stops, which is easy to miss by eye and impossible to miss here.
const BLURRED = readFileSync(new URL('../examples/smoke/optParity__BLURRED.svg', import.meta.url), 'utf8');

// A FAT-STROKED filtered shape, drawn AFTER the card above. Both bundles carry a filter
// with the same bundle-local id (every bundle's first filter is 1), and the filtered-output
// cache used to be keyed on that id alone — so this shape could be handed the CARD's cached
// image. Two identical draws of it then differed by 28028px, and the flag had nothing to do
// with it. The cache is keyed by bundle now; this case is here to keep it that way.
const STROKED = readFileSync(new URL('../examples/smoke/optParity__STROKED.svg', import.meta.url), 'utf8');

// Plain curved/overlapping content — nothing hidden, so the occlusion cull must be
// invisible here, and the occupancy interior-skip must be too.
const SHAPES = readFileSync(new URL('../examples/smoke/optParity__SHAPES.svg', import.meta.url), 'utf8');

// flag        — the globalThis switch
// enabledWhen — value of the flag that turns the optimization ON
const CASES = [
  { name: 'filter bbox RTs',       svg: CARD,   flag: '__MANTLE_NO_FILTER_BBOX',     on: undefined,
    why: 'sizes each filter-graph RT to its propagated bbox instead of the canvas' },
  { name: 'filtered fat stroke', svg: STROKED, flag: '__MANTLE_NO_FILTER_BBOX', on: undefined,
    why: 'draws a second filtered bundle after the card — they must not share a cache entry' },
  { name: 'single-kind blur rect', svg: BLURRED, flag: '__MANTLE_NO_FILTER_BBOX', on: undefined,
    why: 'runs a lone feGaussianBlur in an RT sized to the shape plus the kernel\'s reach; '
       + 'too small a reach clips the halo' },
  { name: 'filter bbox RTs + clip', svg: CARD, flag: '__MANTLE_NO_FILTER_BBOX', on: undefined,
    clip: true,
    why: 'renders the filtered shape into a rect-sized RT, where the external clip — a '
       + 'CANVAS-space coverage texture sampled by gl_FragCoord — must still be sampled '
       + 'in canvas space' },
  { name: 'static cache',          svg: SHAPES, flag: '__MANTLE_NO_STATIC_CACHE',    on: undefined,
    why: 'bakes a static handle to an RT and blits it' },
  { name: 'occupancy interior-skip', svg: SHAPES, flag: '__MANTLE_NO_OCCUPANCY',     on: undefined,
    why: 'skips the coverage walk on provably-interior pixels' },
  { name: 'occlusion cull (nothing hidden)', svg: SHAPES, flag: '__MANTLE_NO_OCCLUSION_CULL', on: undefined,
    why: 'drops shapes a later opaque shape fully covers' },
];

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok   = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 500, height: 500 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 20000 });

const payload = await page.evaluate(async (cases, CLIP) => {
  globalThis.__MANTLE_DEBUG__ = true;
  const { importSvg, createBundle, CacheStrategy, createOverrideTable } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');
  // PORTRAIT, near-square — the aspect the artifact was reported at. A SQUARE canvas
  // makes arScale (1,1) and cancels any aspect-dependent error, which is why the first
  // cut of this smoke passed while the game was visibly broken.
  const W = 820, H = 1000;
  cnv.width = W; cnv.height = H;

  const shot = () => {
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  // Force the static cache so its case actually exercises a bake+blit rather than
  // whatever the cost gate happens to pick on this machine.
  // Draw through a WORLD MATRIX — scaled down and shifted, the way an app lays a card
  // out. Without one the filter scissor is correct and this smoke is vacuous: the bug
  // only bites once the shape is world-transformed, which is exactly how every real
  // app draws. Test the path the app uses, not the one that's convenient.
  const WM = [0.55, 0, 0, 0, 0.55, 0, 0.12, 0.18, 1];   // col-major mat3: scale + translate
  let clipBundle = null;
  const draw = async (svg, forceCache, useOverride, useClip) => {
    const asset = await importSvg(svg);
    const b = createBundle(gl, asset);
    if (useClip) {
      if (!clipBundle) clipBundle = createBundle(gl, await importSvg(CLIP));
      renderer.setNodeClip(b, { clipBundle, worldMatrix: WM, mode: 'in' });
    }
    const h = renderer.createBundleHandle(b, forceCache
      ? { staticCache: { strategy: CacheStrategy.ForceWholeAsset } } : undefined);
    // PER-SHAPE TRANSFORM OVERRIDE — how an app actually animates a card. The filter
    // rects derive from the shape's META BBOX and the worldMatrix and never read
    // overrides, so an overridden shape draws in one place and its RTs sit in another.
    // Without this the smoke is vacuous.
    let ovr = null;
    if (useOverride && typeof createOverrideTable === 'function') {
      ovr = createOverrideTable(gl, b);
      ovr.set(0, { translate: [0.10, -0.08] });
      ovr.uploadIfDirty();
    }
    const opts = { worldMatrix: WM };
    if (ovr) opts.overrides = ovr;
    renderer.beginFrame([1, 1, 1, 1]); h.draw(opts); renderer.endFrame();
    if (forceCache) { renderer.beginFrame([1, 1, 1, 1]); h.draw(opts); renderer.endFrame(); }
    const px = shot();
    if (ovr && ovr.dispose) ovr.dispose();
    if (useClip) renderer.clearNodeClip(b);
    h.dispose(); b.dispose();
    return px;
  };

  // VACUITY GUARD for the clipped case. If the external clip silently did nothing, the
  // case would pass with the frame origin wrong in BOTH renders and prove nothing. So
  // prove the clip actually cuts the card before trusting that comparison.
  globalThis.__MANTLE_NO_FILTER_BBOX = undefined;
  const CARD_SVG = cases.find(c => c.clip).svg;
  const clipped = await draw(CARD_SVG, false, false, true);
  const unclipped = await draw(CARD_SVG, false, false, false);
  let clipProof = 0;
  for (let i = 0; i < clipped.length; i += 4) {
    if (Math.abs(clipped[i] - unclipped[i]) > 8 ||
        Math.abs(clipped[i + 1] - unclipped[i + 1]) > 8 ||
        Math.abs(clipped[i + 2] - unclipped[i + 2]) > 8) clipProof++;
  }

  const out = [];
  for (const c of cases) {
    const forceCache = c.flag === '__MANTLE_NO_STATIC_CACHE';
    // OFF
    globalThis[c.flag] = c.on === true ? undefined : true;
    const useOvr = c.flag === '__MANTLE_NO_FILTER_BBOX';
    const off = await draw(c.svg, forceCache, useOvr, c.clip);
    // ON
    globalThis[c.flag] = c.on === true ? true : undefined;
    const on = await draw(c.svg, forceCache, useOvr, c.clip);
    globalThis[c.flag] = undefined;

    let diff = 0, worst = 0;
    for (let i = 0; i < off.length; i += 4) {
      const d = Math.max(Math.abs(off[i] - on[i]), Math.abs(off[i + 1] - on[i + 1]),
                         Math.abs(off[i + 2] - on[i + 2]));
      if (d > 8) diff++;
      if (d > worst) worst = d;
    }
    out.push({ name: c.name, why: c.why, diff, worst, total: W * H });
  }
  if (clipBundle) clipBundle.dispose();
  return { out, clipProof };
}, CASES, CLIP);

const { out: results, clipProof } = payload;
if (clipProof < 500) {
  fail(`the external clip changes only ${clipProof}px — it is barely cutting the card, so `
     + `the clipped case cannot detect a wrong frame origin. Fix the fixture.`);
} else {
  ok(`the external clip actually cuts the card (${clipProof}px vs unclipped)`);
}
for (const r of results) {
  console.log(`  ${r.name.padEnd(28)} ${String(r.diff).padStart(6)}px differ (worst ${r.worst})`);
}
for (const r of results) {
  // An optimization has NO licence to change pixels. A handful of AA-rounding pixels
  // is tolerable; a clipped edge is thousands.
  if (r.diff > 120) {
    fail(`${r.name} is NOT output-identical — ${r.diff}px differ (worst ${r.worst}). `
       + `It ${r.why}, which must be invisible. Do not trade a wrong pixel for fillrate.`);
  } else {
    ok(`${r.name} is output-identical (${r.diff}px differ)`);
  }
}

await browser.close();
server.close();
console.log(failures ? `\nFAILURES: ${failures}` : '\nPASS');
process.exit(failures ? 1 : 0);
