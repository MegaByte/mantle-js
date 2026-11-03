// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occlusionCullSmoke — a shape hidden under a later opaque shape is culled, never bleeds through
// the shared antialiased edge, and the cull never outlives what it assumed:
//   occlusionCull            every render path: the covered shape leaves no tint on the edge
//   strokeOcclusionCull      a hidden stroke is culled; a stroke that is not hidden survives
//   morphOcclusionCull       a morph culls only what is hidden for the whole animation
//   coincidentAa             coincident shapes on Slug and LB: the hidden one leaves no tint
//   occlusionCullOverride    an override that moves, hides or shrinks the occluder retires the cull
// Each case runs on its own page (its own context and renderer) in one browser; see _caseHost.mjs.

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { emitFixture } from './_fixtures.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
import { openCaseHost, runCases } from './_caseHost.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// occlusionCull — a shape a later OPAQUE shape fully covers must not
// bleed through the antialiased boundary.
//
// A fully-occluded shape is invisible everywhere EXCEPT along a shared edge, where
// painter compositing blends each shape's coverage independently and the hidden
// color gets mixed in a second time:
//
//     truth   c·J + (1−c)·bg
//     bug     c·J + (1−c)·[ c·I + (1−c)·bg ]     ← I bleeds through
//
// Parallax-hill art that stacks two identical gold ridges and lays a 60%-alpha
// mint ridge over them would grow a gold fringe on every ridge, which reads as
// "the AA is too dark". createBundle drops such shapes
// (occlusionCull.js) — which also removes a draw.
//
// The hidden layer here is PURE RED under a gold occluder under a translucent mint,
// so the composite is green and ANY red is a leak — no thresholds to argue about.
//
// Assertions:
//   1. The occluded shape is dropped from the draw list.
//   2. No red leaks — on Slug AND on Loop-Blinn.
//   3. With opts.occlusionCull === false the red DOES leak. Without this the smoke
//      could pass on a renderer that cannot leak at all, and prove nothing.
//   4. A shape that is NOT fully covered is never culled (correctness guard).
async function occlusionCull(host) {
  const url = host.url(`mantleDemo.html`);

  // HIDDEN (red) shares its whole curved top edge with the OCCLUDER (gold) and stops
  // short at the bottom — a strict subset, exactly the hills' layering. MINT at 60%
  // sits on top so the visible composite is green.
  const RIDGE_TOP = 'M0,150 Q100,110 200,140 Q300,170 400,130';
  const HIDDEN = `${RIDGE_TOP} L400,300 L0,300 Z`;
  const OCCLUDER = `${RIDGE_TOP} L400,400 L0,400 Z`;
  const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <path d="${HIDDEN}"   fill="#ff0000"/>
  <path d="${OCCLUDER}" fill="#DEBD4F"/>
  <path d="${OCCLUDER}" fill="#B2F2D9" fill-opacity="0.6"/>
</svg>`;
  emitFixture('occlusionCull__SVG', SVG);
  // A shape that pokes OUT of the would-be occluder must survive.
  const NOT_COVERED = readFileSync(
    new URL('../examples/smoke/occlusionCull__NOT_COVERED.svg', import.meta.url),
    'utf8',
  );

  let failures = 0;
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };
  const ok = (m) => console.log('ok', m);

  const { browser } = host;
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 400 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
    timeout: 20000,
    polling: 100,
  });

  // A sheet with a small window, off every sample of the covered shape: the layer behind must show through it (a smoke that reads the picture, on each engine).
  const WINDOW = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <rect width="400" height="400" fill="#ff0000"/>
  <path fill-rule="evenodd" fill="#0000ff" d="M0 0H400V400H0Z M190 190H210V210H190Z"/>
</svg>`;
  emitFixture('occlusionCull__WINDOW', WINDOW);

  const results = await page.evaluate(
    async (svg, notCovered, windowSvg) => {
      const { importSvg, createBundle } = await import('/src/index.js');
      const gl = window.__mantleGl;
      const renderer = window.__mantleRenderer;
      const cnv = document.getElementById('glcanvas');
      const W = 800,
        H = 800;
      cnv.width = W;
      cnv.height = H;

      // The composite is mint-over-gold (green: r < g). Any pixel with r > g is the
      // hidden RED layer leaking through the antialiased boundary.
      const redLeak = () => {
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let leaked = 0,
          worst = 0;
        for (let i = 0; i < px.length; i += 4) {
          if (px[i] > 250 && px[i + 1] > 250 && px[i + 2] > 250) continue; // white bg
          const rn = px[i] - px[i + 1];
          if (rn > 4) leaked++;
          if (rn > worst) worst = rn;
        }
        return { leaked, worst };
      };

      // AAC is fixed at renderer construction, so build one lazily for that case.
      let _aacR = null;
      const aacRenderer = async () => {
        if (_aacR) return _aacR;
        const { createRenderer } = await import('/src/index.js');
        _aacR = createRenderer(gl, window.__mantleShaderSources, { aacFill: true });
        return _aacR;
      };

      const run = async (src, engine, cull) => {
        // Set the engine BEFORE createBundle: the LB mesh build is kicked off at bundle
        // creation using the mode in force at that moment, so setting it afterwards
        // leaves the bundle with no meshes and the LB assertions silently vacuous.
        // 'aac' = the analytic-area coverage engine inside the Slug cover-quad pass. It is
        // a RENDERER option, so that case gets its own renderer on the same canvas.
        const R = engine === 'aac' ? await aacRenderer() : renderer;
        R.setLoopBlinnFill(engine === 'aac' ? 'off' : engine);
        const asset = await importSvg(src);
        const b = createBundle(gl, asset, cull ? undefined : { occlusionCull: false });
        const h = R.createBundleHandle(b);
        if (engine === 'on') await R.awaitLbReady(b);
        R.beginFrame([1, 1, 1, 1]);
        h.draw();
        R.endFrame();
        const leak = redLeak();
        const draws = b.drawList.filter((o) => o.kind === 'fillShape').length;
        const shapes = b.numShapes;
        const lbRouted = Array.isArray(b._lbMeshes) && b._lbMeshes.length > 0;
        const center = new Uint8Array(4);
        gl.readPixels(W / 2, H / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, center);
        h.dispose();
        b.dispose();
        return { ...leak, draws, shapes, lbRouted, center: Array.from(center) };
      };

      return {
        slugCull: await run(svg, 'off', true),
        lbCull: await run(svg, 'on', true),
        lbNoCull: await run(svg, 'on', false),
        notCovered: await run(notCovered, 'off', true),
        windowSlug: await run(windowSvg, 'off', true),
        windowLb: await run(windowSvg, 'on', true),
        // LAST: creating a renderer takes ownership of the global LB builder, so an
        // AAC renderer built earlier would strand awaitLbReady above.
        aacCull: await run(svg, 'aac', true),
      };
    },
    SVG,
    NOT_COVERED,
    WINDOW,
  );

  const { slugCull, aacCull, lbCull, lbNoCull, notCovered, windowSlug, windowLb } = results;
  console.log(
    `  cull ON : draws ${slugCull.draws}/${slugCull.shapes}  redLeak slug=${slugCull.leaked}px lb=${lbCull.leaked}px`,
  );
  console.log(
    `  cull OFF: draws ${lbNoCull.draws}/${lbNoCull.shapes}  redLeak lb=${lbNoCull.leaked}px (worst r−g ${lbNoCull.worst})`,
  );

  if (slugCull.draws !== slugCull.shapes - 1)
    fail(
      `the occluded shape was NOT dropped (${slugCull.draws} draws of ${slugCull.shapes} shapes)`,
    );
  else
    ok(`the occluded shape is dropped from the draw list (${slugCull.draws}/${slugCull.shapes})`);

  if (slugCull.leaked > 0)
    fail(`Slug: the hidden shape bleeds through the AA edge on ${slugCull.leaked}px`);
  else ok('Slug: no bleed through the AA edge');

  // The cull drops the shape from the DRAW LIST, so it never reaches any engine — the
  // win is identical for Slug, AAC and LB, and costs the pixel shader nothing.
  if (aacCull.draws !== aacCull.shapes - 1)
    fail(`AAC: the occluded shape was NOT dropped (${aacCull.draws}/${aacCull.shapes})`);
  else if (aacCull.leaked > 0)
    fail(`AAC: the hidden shape bleeds through the AA edge on ${aacCull.leaked}px`);
  else ok('AAC: shape dropped, no bleed through the AA edge');

  if (!lbCull.lbRouted)
    fail('the bundle did NOT route to LB — the LB half of this smoke proves nothing');
  else if (lbCull.leaked > 0)
    fail(`LB: the hidden shape bleeds through the AA edge on ${lbCull.leaked}px`);
  else ok('LB: no bleed through the AA edge');

  // The bug must actually be reachable, or the assertions above are vacuous.
  if (lbNoCull.leaked === 0)
    fail('occlusionCull:false did NOT reproduce the bleed — this smoke cannot detect the bleed');
  else ok(`occlusionCull:false still bleeds (${lbNoCull.leaked}px) — the smoke has teeth`);

  if (notCovered.draws !== notCovered.shapes)
    fail(`a shape that is NOT fully covered got culled (${notCovered.draws}/${notCovered.shapes})`);
  else ok('a shape that is not fully covered survives');

  for (const [name, w] of [
    ['Slug', windowSlug],
    ['LB', windowLb],
  ]) {
    const [r, g, b] = w.center;
    if (w.draws !== w.shapes)
      fail(
        `${name}: a sheet with a small window culled the layer behind it (${w.draws}/${w.shapes})`,
      );
    else if (!(r > 250 && g < 5 && b < 5))
      fail(`${name}: the window does not show the layer behind it: rgb ${r},${g},${b}`);
    else ok(`${name}: the window shows the layer behind it`);
  }

  await page.close();
  console.log(failures ? `\nFAILURES: ${failures}` : '\nPASS');
  return failures;
}

// strokeOcclusionCull — a stroke hidden behind opaque geometry is culled,
// and one that is NOT hidden survives.
//
// Occlusion culling only ever considered FILL rows: `cullable` required
// META_FILL_A > 0, and a stroke row carries fillColor [0,0,0,0]. So a stroke
// completely buried under an opaque shape still drew, every frame.
//
// Extending it needs a different containment test, which is the whole risk here.
// isContained samples the shape's boundary, nudges a hair to both sides, and only
// checks points that land INSIDE the shape — correct for a fill, useless for a
// stroke, whose ink lies `reach` em to both sides of the centerline and mostly
// outside it. isStrokeBandContained pushes by the full reach and checks
// unconditionally, including along the tangent at segment ends where caps put ink.
//
// The reach must also cover MITER SPIKES: the row's stored bbox is only
// halfW-padded ("the perceived stroke ink"), while a miter join reaches
// halfW*miterLimit past the vertex, so the spike lives outside that bbox.
//
// Hence the third case. A cull that loses visible ink is a rendering bug; a cull
// that is merely missed costs a draw. The near-miss cases are what keep the error
// on the right side, so they are the ones worth testing.
async function strokeOcclusionCull(host) {
  let failures = 0;
  const ok = (m) => console.log('  ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL ' + m);
  };

  // 1. BURIED: a stroked shape entirely under a later opaque rect.
  const BURIED =
    '<path d="M35 35 L65 35 L65 65 L35 65 Z" fill="none" stroke="#0000ff" stroke-width="6"/>' +
    '<rect x="10" y="10" width="80" height="80" fill="#ff0000"/>';
  // 2. POKING: same, but the occluder is too small — the band crosses its edge.
  const POKING =
    '<path d="M35 35 L65 35 L65 65 L35 65 Z" fill="none" stroke="#0000ff" stroke-width="6"/>' +
    '<rect x="36" y="36" width="28" height="28" fill="#ff0000"/>';
  // 3. MITER SPIKE: a sharp miter reaches far past the halfW-padded bbox. The
  //    occluder covers that bbox but not the spike.
  const SPIKE =
    '<path d="M30 62 L50 30 L70 62" fill="none" stroke="#0000ff" stroke-width="7" ' +
    'stroke-linejoin="miter" stroke-miterlimit="10"/>' +
    '<rect x="24" y="26" width="52" height="42" fill="#ff0000"/>';

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="300" height="300"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = 300;
const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);

window.__run = async (inner) => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' + inner + '</svg>';
  const sec = await importSvg(svg);
  // Culling happens in createBundle (default on), NOT in importSvg — passing the
  // option to the importer does nothing, and reading a cull count off sec gives
  // undefined. bundle._culledShapes is the observable.
  const b = createBundle(gl, sec);
  // The inline pass runs in 'coincident' mode and only considers shapes flush with
  // the occluder's boundary. A shape buried well INSIDE one is found by the async
  // worker pass, so a test that does not wait for it culls nothing and passes
  // vacuously. bundle._occlusionCullPending clears when that pass lands.
  for (let i = 0; i < 400 && b._occlusionCullPending; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const R = createRenderer(gl, shaders, {});
  R.setViewport(S, S);
  const shot = () => {
    R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
    const px = new Uint8Array(S * S * 4);
    gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px); return px;
  };
  for (let i = 0; i < 4; i++) shot();
  const px = shot();
  let blue = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i + 2] > 150 && px[i] < 110) blue++;

  // Reference: identical scene with culling off. Any blue that culling removed
  // was VISIBLE blue, i.e. lost ink.
  const sec2 = await importSvg(svg);
  const b2 = createBundle(gl, sec2, { occlusionCull: false });
  const R2 = createRenderer(gl, shaders, {});
  R2.setViewport(S, S);
  R2.beginFrame([1, 1, 1, 1]); R2.drawBundle(b2); R2.endFrame();
  const px2 = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px2);
  let blueRef = 0, maxDiff = 0;
  for (let i = 0; i < px2.length; i += 4) if (px2[i + 2] > 150 && px2[i] < 110) blueRef++;
  for (let i = 0; i < px.length; i++) { const d = Math.abs(px[i] - px2[i]); if (d > maxDiff) maxDiff = d; }
  R.dispose(); R2.dispose(); b.dispose(); b2.dispose();
  return { blue, blueRef, maxDiff,
           culled: (b._culledShapes && b._culledShapes.size) || 0,
           rows: b.numShapes | 0 };
};
window.__ready = true;
</script></body></html>`;

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await page.goto(host.page(HTML), {
      waitUntil: 'load',
      timeout: 30000,
    });
    await page.waitForFunction(() => window.__ready === true, { timeout: 30000, polling: 100 });

    const buried = await page.evaluate((s) => window.__run(s), BURIED);
    const poking = await page.evaluate((s) => window.__run(s), POKING);
    const spike = await page.evaluate((s) => window.__run(s), SPIKE);

    const line = (n, r) =>
      console.log(
        `   ${n.padEnd(12)} blue ${String(r.blue).padStart(6)}` +
          ` (ref ${String(r.blueRef).padStart(6)}), maxDiff ${r.maxDiff}, culled ${r.culled}/${r.rows} rows`,
      );
    line('buried:', buried);
    line('poking:', poking);
    line('miter spike:', spike);

    // Every case must be pixel-identical to the uncalled render. Culling is only
    // ever allowed to remove work, never ink.
    for (const [name, r] of [
      ['buried', buried],
      ['poking', poking],
      ['miter spike', spike],
    ]) {
      if (r.maxDiff !== 0) {
        fail(
          `${name}: culling changed the image (maxDiff ${r.maxDiff}, blue ${r.blue} vs ` +
            `${r.blueRef}). A stroke was culled whose band is NOT fully covered — check ` +
            'the reach used by isStrokeBandContained.',
        );
      } else {
        ok(`${name}: byte-identical to the uncalled render`);
      }
    }
    // Non-vacuity: the buried stroke must really be invisible, and the two
    // near-miss cases must really show ink, or none of the above tests anything.
    if (buried.blueRef !== 0) {
      fail(
        `the "buried" stroke is visible (${buried.blueRef} blue px) even with culling OFF, ` +
          'so it was never a cull candidate and this case proves nothing',
      );
    } else if (buried.culled === 0) {
      fail(
        'the buried stroke was NOT culled, so "byte-identical" here only says culling did ' +
          'nothing. cullable() must accept stroke rows (fill alpha is 0 on them).',
      );
    } else {
      ok(`the buried stroke is hidden AND culled (${buried.culled} row(s)) — non-vacuous`);
    }
    if (poking.blueRef === 0 || spike.blueRef === 0) {
      fail('a near-miss case shows no ink even uncalled, so it cannot detect an over-eager cull');
    } else {
      ok(`near-miss cases show ink (poking ${poking.blueRef}, spike ${spike.blueRef} blue px)`);
    }
  } catch (e) {
    fail('drive failed: ' + e.message);
  }

  await page.close();
  console.log();
  console.log(
    failures === 0 ? 'STROKE-OCCLUSION-CULL PASS' : `STROKE-OCCLUSION-CULL FAIL (${failures})`,
  );
  return failures;
}

// morphOcclusionCull — a morph may cull a shape only if it is hidden for the
// whole animation, not merely at the two ends.
//
// A morph lerps every control point, so "hidden at t=0" says nothing about t=1. Worse,
// "hidden at t=0 AND at t=1" says nothing about the middle: an occluder can shrink
// faster than the shape it hides, expose it midway, and cover it again. Sampling t
// cannot rule that out either. morphCull.js eliminates t analytically — the crossing
// condition S(u,t) = B(v,t) becomes cross(P,Q) = 0 ∧ dot(P,Q) ≤ 0 in (u,v) alone — and
// certifies via Bernstein sign tests that the boundaries never meet for ANY t.
//
// Three cases, all with a RED shape under an opaque GOLD occluder:
//   always HIDDEN   the occluder covers it at every t          → must be CULLED
//   EXPOSED AT t=1  the occluder shrinks away                  → must NOT be culled,
//                                                                and red must appear
//   EXPOSED MIDWAY  covered at t=0 and t=1, but not at t=0.5   → must NOT be culled.
//                   This is the case endpoint-testing gets WRONG, and the reason the
//                   test is analytic rather than sampled.
async function morphOcclusionCull(host) {
  const url = host.url(`mantleDemo.html`);

  // The RED shape is identical in every pose. Only the GOLD occluder differs.
  const RED = 'M120,120 L280,120 L280,240 L120,240 Z';
  const svg = (gold) => `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">
  <path id="hidden" d="${RED}" fill="#ff0000"/>
  <path id="cover"  d="${gold}" fill="#DEBD4F"/>
</svg>`;

  const COVER_BIG = 'M100,100 L300,100 L300,300 L100,300 Z'; // covers RED with margin
  const COVER_BIG2 = 'M100,100 L300,100 L300,320 L100,320 Z'; // still covers, slightly taller
  const COVER_TINY = 'M100,100 L140,100 L140,140 L100,140 Z'; // exposes RED entirely
  // Covers RED at both ends, yet exposes it in the middle. The same rectangle, with its
  // corners listed rotated by two: every corner lerps to the OPPOSITE corner, so at
  // t=0.5 they all meet at the center and the occluder collapses to a point — RED is
  // fully exposed — then it re-expands. Endpoint testing sees two identical covering
  // rectangles and would cull; coarse t-sampling can step straight over the collapse.
  const COLLAPSE_A = 'M100,100 L300,100 L300,300 L100,300 Z';
  const COLLAPSE_B = 'M300,300 L100,300 L100,100 L300,100 Z';

  let failures = 0;
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };
  const ok = (m) => console.log('ok', m);

  const { browser } = host;
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 400 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
    timeout: 20000,
    polling: 100,
  });

  const results = await page.evaluate(
    async (cases, MS) => {
      const { importSvg, createBundle, createShapeMorph } = await import('/src/index.js');
      const gl = window.__mantleGl;
      const renderer = window.__mantleRenderer;
      const out = {};
      for (const [name, [srcSvg, dstSvg]] of Object.entries(cases)) {
        const bS = createBundle(gl, await importSvg(srcSvg), { occlusionCull: false });
        const bD = createBundle(gl, await importSvg(dstSvg), { occlusionCull: false });
        const m = createShapeMorph(gl, bS, bD);
        const b = m.bundle;
        // The cull runs off-thread: wait for its completion flag (_morphCullPending: the worker's reply, applied or discarded), not a fixed delay.
        {
          const t0 = performance.now();
          while (b._morphCullPending && performance.now() - t0 < MS)
            await new Promise((r) => setTimeout(r, 10));
        }
        // RED must never appear when the shape is legitimately hidden, and MUST appear
        // when the morph exposes it — check that on both engines. The cull works at the
        // draw-list level, so Slug and LB (and AAC) all see the same shortened list; this
        // proves the morph's LB route honors it, not just the Slug one.
        const cnv = document.getElementById('glcanvas');
        cnv.width = 400;
        cnv.height = 400;
        const redAt = (t) => {
          m.setT(t);
          renderer.beginFrame([1, 1, 1, 1]);
          renderer.drawBundle(b);
          renderer.endFrame();
          const px = new Uint8Array(400 * 400 * 4);
          gl.readPixels(0, 0, 400, 400, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let red = 0;
          for (let i = 0; i < px.length; i += 4)
            if (px[i] > 170 && px[i + 1] < 90 && px[i + 2] < 90) red++;
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
          draws: b.drawList.filter((o) => o.kind === 'fillShape').length,
          shapes: b.numShapes,
          red: perEngine,
        };
        m.dispose();
        bS.dispose();
        bD.dispose();
      }
      return out;
    },
    {
      alwaysHidden: [svg(COVER_BIG), svg(COVER_BIG2)],
      exposedAtEnd: [svg(COVER_BIG), svg(COVER_TINY)],
      exposedMidway: [svg(COLLAPSE_A), svg(COLLAPSE_B)],
    },
    pageTimeoutFor(120000),
  );

  const { alwaysHidden, exposedAtEnd, exposedMidway } = results;
  for (const [k, v] of Object.entries(results)) {
    console.log(
      `  ${k.padEnd(14)} culled=[${v.culled}]  draws ${v.draws}/${v.shapes}` +
        `  red@t=0/0.5/1  slug=[${v.red.slug}] lb=[${v.red.lb}]`,
    );
  }

  // The cull drops the shape from the DRAW LIST, so every engine sees the same shortened
  // list. Assert that on both morph routes rather than trusting it.
  for (const eng of ['slug', 'lb']) {
    if (alwaysHidden.red[eng].some((n) => n > 50)) {
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
    fail(
      'a shape hidden for the ENTIRE morph was not culled — the analytic test should certify this',
    );
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
    fail(
      'a shape exposed MIDWAY was culled — endpoint containment is not sufficient, ' +
        'and the analytic no-crossing certificate should have refused this',
    );
  } else {
    ok('a shape exposed midway survives (endpoint containment alone would have culled it)');
  }

  await page.close();
  console.log(failures ? `\nFAILURES: ${failures}` : '\nPASS');
  return failures;
}

// coincidentAa — a shape hidden under an opaque one must not tint its AA edge.
//
// THE CONFLATION ARTIFACT. Two coincident shapes are each anti-aliased against what is
// already there. The lower one blends its edge with the background; the upper one then
// blends ITS edge over that — so the shared boundary is composited twice and comes out
// darker than either shape's edge alone: two identical ridges stacked under a
// translucent one show a dark fringe.
//
// The occlusion cull handles it: a shape a later OPAQUE shape fully covers contributes
// nothing, so it is dropped from the draw list and its edge never composites.
//
// "Dropped from the draw list" is the whole subtlety. Any render path that does not read
// bundle.drawList does not get the cull — and one of them doesn't.
//
// So: render a scene with a hidden duplicate, and the same scene WITHOUT the duplicate,
// through every path. Each path is compared against itself, so a path's own AA character
// cancels out and only the conflation shows.
async function coincidentAa(host) {
  const url = host.url(`mantleDemo.html`);

  // A curved shape (so it has a long AA boundary) in a strong color on a contrasting
  // background. The DUPE is the same path drawn underneath — fully covered, contributes
  // nothing, and must be culled.
  const SHAPE = `<path d="M60,200 C60,110 130,45 220,45 C310,45 380,110 380,200 C380,290 310,355 220,355 C130,355 60,290 60,200 Z" fill="#c0392b"/>`;
  const REF = readFileSync(
    new URL('../examples/smoke/coincidentAa__REF.svg', import.meta.url),
    'utf8',
  );
  const DUPE = readFileSync(
    new URL('../examples/smoke/coincidentAa__DUPE.svg', import.meta.url),
    'utf8',
  );

  let failures = 0;
  const fail = (m) => {
    failures++;
    console.error('FAIL', m);
  };
  const ok = (m) => console.log('ok', m);

  const { browser } = host;
  const page = await browser.newPage();
  await page.setViewport({ width: 500, height: 500 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  // Count real instanced draws, so "it took the fast path" is measured, not assumed.
  await page.evaluateOnNewDocument(() => {
    globalThis.__instCalls = 0;
    const P = WebGL2RenderingContext.prototype,
      o = P.drawArraysInstanced;
    P.drawArraysInstanced = function (...a) {
      globalThis.__instCalls++;
      return o.apply(this, a);
    };
  });
  await page.goto(url, { waitUntil: 'load', timeout: 20000 });
  await page.waitForFunction(
    () => window.__mantleRenderer && window.__mantleGl && window.__mantleShaderSources,
    { timeout: 20000, polling: 100 },
  );

  const payload = await page.evaluate(
    async (REF, DUPE) => {
      const M = await import('/src/index.js');
      const gl = window.__mantleGl;
      const base = window.__mantleRenderer;
      const cnv = document.getElementById('glcanvas');
      const W = 440,
        H = 400;
      cnv.width = W;
      cnv.height = H;

      let aac = null;
      const getAac = () =>
        aac || (aac = M.createRenderer(gl, window.__mantleShaderSources, { aacFill: true }));

      const shot = () => {
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px;
      };

      // Each path draws ONE bundle and returns the frame.
      const PATHS = {
        'handle.draw': async (svg) => {
          const b = M.createBundle(gl, await M.importSvg(svg));
          const h = base.createBundleHandle(b);
          base.setLoopBlinnFill('auto');
          base.beginFrame([1, 1, 1, 1]);
          h.draw({});
          base.endFrame();
          const p = shot();
          h.dispose();
          b.dispose();
          return p;
        },
        drawBundle: async (svg) => {
          const b = M.createBundle(gl, await M.importSvg(svg));
          base.setLoopBlinnFill('auto');
          base.beginFrame([1, 1, 1, 1]);
          base.drawBundle(b);
          base.endFrame();
          const p = shot();
          b.dispose();
          return p;
        },
        // TWO instances, side by side. The fast path is gated on instances.length >= 2 — with a
        // single instance drawBundleInstanced quietly takes the LOOP, so a one-instance "fast
        // path" test is testing the loop twice and would miss anything the fast path gets wrong.
        'instanced FAST': async (svg) => {
          globalThis.__MANTLE_DEBUG__ = true;
          globalThis.__MANTLE_NO_INSTANCED_FAST = undefined;
          const b = M.createBundle(gl, await M.importSvg(svg));
          base.setLoopBlinnFill('off'); // keep it on the Slug instanced path
          globalThis.__instCalls = 0;
          base.beginFrame([1, 1, 1, 1]);
          base.drawBundleInstanced(b, [
            { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, -0.45, 0, 1] },
            { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, 0.45, 0, 1] },
          ]);
          base.endFrame();
          const p = shot();
          b.dispose();
          base.setLoopBlinnFill('auto');
          p._instanced = globalThis.__instCalls;
          return p;
        },
        'instanced LOOP': async (svg) => {
          globalThis.__MANTLE_NO_INSTANCED_FAST = true;
          const b = M.createBundle(gl, await M.importSvg(svg));
          base.setLoopBlinnFill('off');
          base.beginFrame([1, 1, 1, 1]);
          base.drawBundleInstanced(b, [
            { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, -0.45, 0, 1] },
            { worldMatrix: [0.5, 0, 0, 0, 0.5, 0, 0.45, 0, 1] },
          ]);
          base.endFrame();
          const p = shot();
          b.dispose();
          globalThis.__MANTLE_NO_INSTANCED_FAST = undefined;
          base.setLoopBlinnFill('auto');
          return p;
        },
        'static cache': async (svg) => {
          const b = M.createBundle(gl, await M.importSvg(svg));
          const h = base.createBundleHandle(b, {
            staticCache: { strategy: M.CacheStrategy.ForceWholeAsset },
          });
          base.setLoopBlinnFill('auto');
          base.beginFrame([1, 1, 1, 1]);
          h.draw({});
          base.endFrame(); // bake
          base.beginFrame([1, 1, 1, 1]);
          h.draw({});
          base.endFrame(); // blit
          const p = shot();
          h.dispose();
          b.dispose();
          return p;
        },
        'Loop-Blinn': async (svg) => {
          const b = M.createBundle(gl, await M.importSvg(svg));
          const h = base.createBundleHandle(b);
          base.setLoopBlinnFill('on');
          if (base.awaitLbReady) await base.awaitLbReady(b);
          base.beginFrame([1, 1, 1, 1]);
          h.draw({});
          base.endFrame();
          const p = shot();
          h.dispose();
          b.dispose();
          base.setLoopBlinnFill('auto');
          return p;
        },
        AAC: async (svg) => {
          const r = getAac();
          const b = M.createBundle(gl, await M.importSvg(svg));
          const h = r.createBundleHandle(b);
          r.setLoopBlinnFill('off');
          r.beginFrame([1, 1, 1, 1]);
          h.draw({});
          r.endFrame();
          const p = shot();
          h.dispose();
          b.dispose();
          return p;
        },
      };

      // VACUITY GUARD. If the duplicate is not actually THERE and actually CULLED, every
      // comparison below is two identical renders of the same thing and proves nothing.
      const probe = M.createBundle(gl, await M.importSvg(DUPE));
      const probeRef = M.createBundle(gl, await M.importSvg(REF));
      const guard = {
        dupeShapes: probe.numShapes,
        refShapes: probeRef.numShapes,
        culled: probe._culledShapes ? probe._culledShapes.size : 0,
        drawOps: (probe.drawList || []).filter((o) => o.kind === 'fillShape').length,
      };
      probe.dispose();
      probeRef.dispose();

      const out = [];
      for (const [name, run] of Object.entries(PATHS)) {
        const ref = await run(REF);
        const dup = await run(DUPE);
        // Count pixels where the duplicate changed the picture, and how strongly. The
        // conflation shows only on the AA boundary — the interior is opaque either way.
        let diff = 0,
          worst = 0,
          ink = 0;
        for (let i = 0; i < ref.length; i += 4) {
          if (ref[i] < 240 || ref[i + 1] < 240 || ref[i + 2] < 240) ink++;
          const d = Math.max(
            Math.abs(ref[i] - dup[i]),
            Math.abs(ref[i + 1] - dup[i + 1]),
            Math.abs(ref[i + 2] - dup[i + 2]),
          );
          if (d > 3) diff++;
          if (d > worst) worst = d;
        }
        out.push({ name, diff, worst, ink, instanced: dup._instanced });
      }
      return { out, guard };
    },
    REF,
    DUPE,
  );

  const { out: res, guard } = payload;
  console.log(
    `  the DUPE bundle: ${guard.dupeShapes} shapes (ref has ${guard.refShapes}), ` +
      `${guard.culled} culled, ${guard.drawOps} fill ops left in the draw list\n`,
  );
  if (guard.dupeShapes <= guard.refShapes) {
    fail(
      `the duplicate did not survive the import (${guard.dupeShapes} shapes vs the ref's ` +
        `${guard.refShapes}) — there is nothing hidden, so every comparison below is two ` +
        `identical renders and proves nothing`,
    );
  }
  if (guard.culled < 1) {
    fail(
      `NOTHING WAS CULLED (${guard.culled}) — so the 0px results below are not the cull ` +
        `working, they are something else, and this smoke would pass with the cull deleted`,
    );
  }
  console.log('  a fully-hidden duplicate must change NOTHING:\n');
  console.log('  path              edge px changed   worst   ink');
  for (const r of res) {
    const inst = r.instanced != null ? `   [${r.instanced} drawArraysInstanced]` : '';
    console.log(
      `  ${r.name.padEnd(16)} ${String(r.diff).padStart(11)}   ${String(r.worst).padStart(5)}   ${r.ink}${inst}`,
    );
  }
  console.log('');
  const fastRow = res.find((r) => r.name === 'instanced FAST');
  if (fastRow && !fastRow.instanced) {
    fail(
      `the "instanced FAST" case never issued a drawArraysInstanced — it fell back to the ` +
        `per-instance loop, so the fast path is NOT being tested here at all`,
    );
  } else if (fastRow) {
    ok(`the instanced fast path is genuinely taken (${fastRow.instanced} drawArraysInstanced)`);
  }
  for (const r of res) {
    if (r.ink < 20000) {
      fail(
        `${r.name}: barely rendered (${r.ink}px of ink) — this path isn't drawing, so its ` +
          `comparison proves nothing`,
      );
      continue;
    }
    if (r.diff > 50) {
      fail(
        `${r.name}: a hidden duplicate changed ${r.diff} px (worst ${r.worst}). Its edge is ` +
          `being composited under the visible shape's edge — the CONFLATION artifact. The ` +
          `occlusion cull drops such shapes from bundle.drawList; a path that does not READ ` +
          `drawList never sees the cull.`,
      );
    } else {
      ok(`${r.name}: the hidden duplicate is culled (${r.diff} px changed)`);
    }
  }

  await page.close();
  console.log(failures ? `\nFAILURES: ${failures}` : '\nCOINCIDENT-AA PASS');
  return failures;
}

// occlusionCullOverride — the occlusion cull must not outlive the condition it assumed.
//
// occlusionCull removes a shape from the draw list entirely (bundle.js) when a LATER plain-
// opaque shape provably covers it. That containment is computed ONCE, from static em-space
// geometry, at bundle build. Per-shape OVERRIDES then move / hide / fade shapes at draw time —
// so an occluder can stop occluding after the cull was decided. If nothing re-checks, the shape
// underneath stays culled and silently never draws.
//
// A whole-bundle worldMatrix is safe (an affine map preserves containment), and streaming
// geometry reverts to drawListUnculled (streamGeometry.js). Per-shape overrides are
// the gap this guards.
//
// Scene: small BLUE square fully inside a large RED square that is drawn AFTER it. Baseline: red
// covers blue, blue is culled. Then, via overrides, make the occluder stop covering:
//   1. visibility 0        — occluder hidden
//   2. localPosition       — occluder moved away
//   3. localScale          — occluder shrunk off the blue
// In each case blue MUST become visible.
async function occlusionCullOverride(host) {
  const N = 128;

  // blue first (underneath), red second (on top, fully covering) — both plain opaque solids.
  const SVG =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}" width="${N}" height="${N}">` +
    `<rect id="under" x="48" y="48" width="32" height="32" fill="#0000ff"/>` +
    `<rect id="over"  x="24" y="24" width="80" height="80" fill="#ff0000"/>` +
    `</svg>`;

  const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
const shaders = await loadShaders(new URL('/src/shaders/',location.href).href);
const r = createRenderer(gl, shaders, {}); r.setViewport(${N}, ${N});
const bundle = createBundle(gl, await importSvg(${JSON.stringify(SVG)}, { preserveViewport: true }));
r.prepareBundle && r.prepareBundle(bundle);
if (r.awaitLbReady) await r.awaitLbReady(bundle);
const ov = createOverrideTable(gl, bundle);
// The general containment cull runs OFF-THREAD (bundle.js:800 requestOcclusionCull) and only the
// cheap 'coincident' pass runs inline at build. Wait for the full pass to land, or this test is
// vacuous — the shape under the occluder is not culled until then.
for (let i = 0; i < 400 && !(bundle._cullGen > 0); i++) await new Promise(r => setTimeout(r, 10));

// Color at the center — where the blue square lives, under the red one.
const center = () => {
  const px = new Uint8Array(4);
  gl.readPixels(${N >> 1}, ${N >> 1}, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  if (px[2] > 180 && px[0] < 80) return 'blue';
  if (px[0] > 180 && px[2] < 80) return 'red';
  if (px[0] > 200 && px[1] > 200 && px[2] > 200) return 'white';
  return 'other(' + px[0] + ',' + px[1] + ',' + px[2] + ')';
};
const paint = (useOv) => {
  r.beginFrame([1,1,1,1]);
  r.drawBundle(bundle, useOv ? { overrides: ov } : {});
  r.endFrame();
  return center();
};
const out = {};
// GUARD AGAINST A VACUOUS TEST: if the cull never fired, every assertion below passes for the
// wrong reason. Require that 'under' really was culled out of the draw list.
out.culled = Array.from(bundle._culledShapes || []);
out.numShapes = bundle.numShapes;
out.drawListLen = bundle.drawList ? bundle.drawList.length : -1;
out.unculledLen = bundle.drawListUnculled ? bundle.drawListUnculled.length : -1;
out.baseline = paint(false);                       // red on top => 'red'
// The occluder is CULLED-AWAY-FROM in three different ways; blue must appear each time.
ov.set('over', { visibility: 0 });                 out.hidden = paint(true);
ov.set('over', { localPosition: [200, 200] });     out.moved  = paint(true);
ov.set('over', { localScale: [0.05, 0.05] });      out.shrunk = paint(true);
ov.set('over', {});                                out.restored = paint(true);   // back to covering
// Whole-bundle transform is affine => containment preserved => culling stays valid.
r.beginFrame([1,1,1,1]);
r.drawBundle(bundle, { worldMatrix: [1,0,0, 0,1,0, 0,0,1] });
r.endFrame();
out.worldMatrixIdentity = center();
window.__out = out; window.__ready = true;
</script></body></html>`;

  const { browser } = host;
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page-err]', e.message));
  await page.goto(host.page(HTML), { waitUntil: 'load', timeout: 60000 });
  // 120s: the page waits on the ASYNC occlusion cull, which is real CPU-bound
  // work rather than navigation.
  //
  // A timeout here is not by itself a renderer defect. This smoke is
  // memory-heavy, and on a host under memory pressure it slows by more than an
  // order of magnitude while light smokes stay at 1-2s — it then fails at any
  // timeout. Check free swap first.
  await page.waitForFunction(() => window.__ready === true, { timeout: 120000, polling: 100 });
  const out = await page.evaluate(() => window.__out);
  await page.close();

  let fail = 0;
  console.log(
    `  cull state: culledShapes=[${out.culled}] of ${out.numShapes} shapes; ` +
      `drawList=${out.drawListLen} vs unculled=${out.unculledLen}`,
  );
  if (!out.culled.length) {
    console.log(
      'FAIL the occlusion cull never fired — this test would pass vacuously. ' +
        'Make the occluder cover the shape more decisively, or the guard below proves nothing.',
    );
    return 1;
  }
  const expect = (name, got, want, why) => {
    if (got === want) console.log('ok', name, '=', got);
    else {
      console.log(`FAIL ${name} — got ${got}, want ${want}${why ? ' (' + why + ')' : ''}`);
      fail++;
    }
  };
  expect('baseline: occluder covers', out.baseline, 'red');
  expect(
    'occluder hidden by override → covered shape appears',
    out.hidden,
    'blue',
    'the shape under a now-invisible occluder is still culled',
  );
  expect(
    'occluder moved by override → covered shape appears',
    out.moved,
    'blue',
    'the shape under a now-moved occluder is still culled',
  );
  expect(
    'occluder shrunk by override → covered shape appears',
    out.shrunk,
    'blue',
    'the shape under a now-shrunken occluder is still culled',
  );
  expect('override cleared → occluder covers again', out.restored, 'red');
  expect('whole-bundle worldMatrix keeps culling valid', out.worldMatrixIdentity, 'red');

  if (fail) {
    console.log(`\nOCCLUSION-CULL-OVERRIDE FAIL (${fail})`);
    return 1;
  }
  console.log('\nOCCLUSION-CULL-OVERRIDE PASS');
  return 0;
}

const host = await openCaseHost(ROOT);
const failures = await runCases(host, [
  ['occlusionCull', occlusionCull],
  ['strokeOcclusionCull', strokeOcclusionCull],
  ['morphOcclusionCull', morphOcclusionCull],
  ['coincidentAa', coincidentAa],
  ['occlusionCullOverride', occlusionCullOverride],
]);
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nocclusionCullSmoke: culls hold on every path and retire when their premise does');
