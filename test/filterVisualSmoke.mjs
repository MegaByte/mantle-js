// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterVisualSmoke — filters must draw their artwork: the primitives render, and the filter pipeline never
// makes artwork vanish, shift, or escape its group.
//
// Cases (one browser; each case runs on its own fresh page, most on mantleDemo.html):
//   filterPrimitives       feMorphology, feTurbulence, feDisplacementMap, lighting, feConvolveMatrix, feImage
//                          fixtures render with each one's color signal (PNG snapshots under test/visuals/filter/)
//   filterPassthroughAlpha an identity primitive reading SourceAlpha keeps the silhouette, black
//   filterGroup            a filtered shape inside an opacity group composites into the group
//   filterUnhandledNode    a primitive with no registered handler degrades to unfiltered, not to nothing
//   rectRxDropShadow       a rounded rect and an feDropShadow card render, with and without a worldMatrix
//   filterFrameOrigin      a filtered draw does not displace the next draw
//   nineSliceFilter        nine-slice stretches a filtered shape like an unfiltered one
// Each case's own notes are above it.

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { openPageSuite, tally } from './_pageSuite.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'filter');
const T = tally();

// End-to-end render of filter primitives wired in the importer + dispatch, per fixture:
//   * feMorphology   — examples/_morph.svg
//   * feTurbulence   — examples/_turbulence.svg
//   * feDisplacementMap — examples/_displace.svg
//   * feDiffuseLighting + feSpecularLighting — examples/_fgraph_light.svg
//   * feConvolveMatrix — examples/_convolve.svg
//   * feImage — examples/_feimage.svg
// Each fixture opens mantleDemo.html with ?svg=<fixture>, reads back the WebGL framebuffer pixels and
// asserts a per-fixture color-signal predicate. PNG snapshots are saved under test/visuals/filter/ for
// visual inspection.
async function filterPrimitives(suite) {
  mkdirSync(OUT, { recursive: true });
  const CASES = [
    {
      name: 'fe-morphology',
      svgUrl: 'examples/_morph.svg',
      desc: 'erode + plain + dilate orange/lime squares',
      // _morph paints: orange (eroded) at x=40-120, plain orange at x=160-240,
      // lime (dilated) at x=280-360. All on a white background. Demand both
      // an orange channel signal and a lime/green channel signal.
      expect: (s) =>
        s.orangePx > 1000 && // visible orange (eroded + plain)
        s.greenPx > 1000 && // visible lime
        s.nonWhite > 20000, // squares cover real area
    },
    {
      name: 'fe-turbulence',
      svgUrl: 'examples/_turbulence.svg',
      desc: 'fractalNoise turbulence clipped to a black circle',
      // SVG feTurbulence emits PER-CHANNEL noise (R, G, B independent),
      // not grayscale — so the result is colorful noise composited into
      // the source's silhouette. We demand: shape silhouette present
      // (nonWhite > some floor) AND pixel-to-pixel variance per channel
      // (so the filter isn't a flat fill).
      expect: (s) => s.nonWhite > 5000 && s.channelVar > 300, // (linearRGB noise, the default, is brighter and flatter after the conversion: 464 vs 500+ in sRGB)
    },
    {
      name: 'fe-displacement-map',
      svgUrl: 'examples/_displace.svg',
      desc: 'red circle warped via a turbulence displacement map',
      // _displace's circle is red, warped by ±20 px via low-freq noise.
      // The output should remain dominantly red with a non-circular
      // silhouette. Demand: visible red (the source survives), and a
      // pixel count distinct from a clean circle of radius 60. We don't
      // measure silhouette directly — coverage > a hard floor proves
      // the displacement didn't kill the shape.
      expect: (s) => s.redPx > 5000 && s.nonWhite > 5000,
    },
    {
      name: 'fe-lighting',
      svgUrl: 'examples/_fgraph_light.svg',
      desc: 'diffuse (orange light) + specular (white highlight) circles on dark bg',
      // _fgraph_light has TWO lit circles on a dark gray bg. The diffuse
      // pass is orange-tinted; the specular pass is bright with a white
      // highlight. We demand orange signal somewhere, and a bright spot
      // (peak luminance > 200) somewhere — that's the specular highlight.
      expect: (s) => s.orangePx > 500 && s.peakLuma > 200,
    },
    {
      name: 'fe-convolve-matrix',
      svgUrl: 'examples/_convolve.svg',
      desc: 'Sobel-X convolve(red circle) → feComposite-in shape',
      // The graph-dispatched feConvolveMatrix produces edge-detect output
      // (Sobel-X picks up the disc's vertical edges). feComposite-in clips
      // to the source silhouette. We demand visible red signal (the edges
      // retain the source's red channel) + some channel variance.
      expect: (s) => s.redPx > 500 && s.channelVar > 500, // (the bias 0.5 is half a unit of LINEAR light: the same edges, less spread in sRGB)
    },
    {
      name: 'fe-image',
      svgUrl: 'examples/_feimage.svg',
      desc: 'feImage(#bmp) feComposite-in shape — 4-quadrant R/G/B/Y bitmap',
      // feImage draws the referenced <image> at its own x/y/size in the
      // filtered element's user space (as Chrome does); the SVG places
      // it over exactly the filtered rect with preserveAspectRatio=none, and
      // feComposite-in clips it to the shape silhouette. Demand strong red, green, blue signal
      // (the 4 quadrants of the R/G/B/Y bitmap) within the filtered rect.
      expect: (s) => s.redPx > 5000 && s.greenPx > 5000 && s.bluePx > 500 && s.channelVar > 1000,
    },
  ];
  const fail = (name, msg) => T.fail(`${name}: ${msg}`);
  for (const c of CASES) {
    const page = await suite.page({ logs: false });
    await page.setViewport({ width: 400, height: 400 });
    page.on('pageerror', (e) => console.error(`  [${c.name} page-err]`, e.message));
    page.on('console', (m) => {
      const t = m.text();
      if (/error|fail|warn/i.test(t)) console.log(`  [${c.name} console]`, t);
    });
    const target = `/mantleDemo.html?svg=/${encodeURIComponent(c.svgUrl)}`;
    try {
      await suite.visit(page, target, { ready: 'demoSvg' });
    } catch (e) {
      const statusTxt = await page.evaluate(
        () => document.getElementById('status') && document.getElementById('status').textContent,
      );
      fail(c.name, `goto/wait failed: ${e.message} (status="${statusTxt}")`);
      await page.close();
      continue;
    }
    const stats = await page.evaluate(() => {
      const cnv = document.getElementById('glcanvas');
      if (!cnv) return null;
      const gl = window.__mantleGl,
        renderer = window.__mantleRenderer;
      if (!gl || !renderer) return null;
      renderer.render();
      const w = cnv.width,
        h = cnv.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let opaque = 0,
        nonWhite = 0;
      let redPx = 0,
        greenPx = 0,
        bluePx = 0,
        orangePx = 0;
      let sumR = 0,
        sumG = 0,
        sumB = 0,
        sumR2 = 0,
        sumG2 = 0,
        sumB2 = 0,
        nwCount = 0;
      let peakLuma = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i],
          g = px[i + 1],
          b = px[i + 2],
          a = px[i + 3];
        if (a < 16) continue;
        opaque++;
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (luma > peakLuma) peakLuma = luma;
        if (r < 240 || g < 240 || b < 240) {
          nonWhite++;
          // Accumulate variance only over non-white (interior) pixels.
          sumR += r;
          sumG += g;
          sumB += b;
          sumR2 += r * r;
          sumG2 += g * g;
          sumB2 += b * b;
          nwCount++;
        }
        // Orange ≈ R high, G medium-high, B low.
        if (r > 200 && g > 100 && g < 200 && b < 80) orangePx++;
        // Strong-channel buckets (mostly-red, mostly-green, mostly-blue).
        if (r > 150 && r - g > 60 && r - b > 60) redPx++;
        if (g > 150 && g - r > 60 && g - b > 60) greenPx++;
        if (b > 150 && b - r > 60 && b - g > 60) bluePx++;
      }
      let channelVar = 0;
      if (nwCount > 4) {
        const mR = sumR / nwCount,
          mG = sumG / nwCount,
          mB = sumB / nwCount;
        const vR = sumR2 / nwCount - mR * mR;
        const vG = sumG2 / nwCount - mG * mG;
        const vB = sumB2 / nwCount - mB * mB;
        channelVar = vR + vG + vB;
      }
      return { w, h, opaque, nonWhite, redPx, greenPx, bluePx, orangePx, channelVar, peakLuma };
    });
    if (!stats) {
      fail(c.name, 'no canvas / WebGL2 context');
      await page.close();
      continue;
    }
    console.log(
      `  diag[${c.name}]: opaque=${stats.opaque} nonWhite=${stats.nonWhite} red=${stats.redPx} green=${stats.greenPx} blue=${stats.bluePx} orange=${stats.orangePx} channelVar=${stats.channelVar.toFixed(1)} peakLuma=${stats.peakLuma.toFixed(1)}`,
    );

    const dataUrl = await page.evaluate(() => {
      const cnv = document.getElementById('glcanvas');
      const renderer = window.__mantleRenderer;
      if (!cnv || !renderer) return null;
      renderer.render();
      return cnv.toDataURL('image/png');
    });
    if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
      writeFileSync(
        path.join(OUT, `${c.name}.png`),
        Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'),
      );
    }

    if (c.expect(stats)) {
      T.ok(c.name);
    } else {
      fail(
        c.name,
        `predicate failed: opaque=${stats.opaque} red=${stats.redPx} green=${stats.greenPx} orange=${stats.orangePx} channelVar=${stats.channelVar.toFixed(1)} peakLuma=${stats.peakLuma.toFixed(1)}`,
      );
    }
    await page.close();
  }
}

// filterPassthroughAlpha — an identity filter primitive reading
// SourceAlpha must still render the silhouette.
//
// Several primitives fall back to a straight blit when their parameters reduce
// to identity: feMorphology whose radius rounds below half a pixel, feMerge
// with a single node. That blit resolved SourceGraphic and BackgroundImage,
// but SourceAlpha and BackgroundAlpha hit the null branch and CLEARED the
// output — the shape vanished, with no error.
//
// Both routes in are ordinary markup, not lean-build fallbacks.
//
// SourceAlpha is (0, 0, 0, a) in a premultiplied buffer, so a RED source must
// come out BLACK at full coverage. Asserting only "something rendered" would
// pass on a plain RGBA blit that forgot to mask RGB — the other way to get
// this wrong — so the color is checked too.
async function filterPassthroughAlpha(suite) {
  const { ok, fail } = T;
  const SIDE = 160;
  const page = await suite.page({ logs: false });
  await page.setViewport({ width: SIDE, height: SIDE });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.visit(page, '/mantleDemo.html', { ready: 'renderer' });

    const stats = await page.evaluate(async (side) => {
      const { importSvg, createBundle } = await import('/src/index.js');
      const gl = window.__mantleGl;
      const renderer = window.__mantleRenderer;
      renderer.setViewport(side, side);

      const RECT = '<rect x="40" y="40" width="80" height="80" fill="#ff0000"/>';
      // radius 0.1 rounds below the half-pixel cutoff -> identity -> passthrough.
      const MORPH = (input) =>
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
        `<filter id="f"><feMorphology radius="0.1" in="${input}"/></filter>` +
        `<g filter="url(#f)">${RECT}</g></svg>`;
      // A single feMergeNode -> nothing to composite -> passthrough.
      const MERGE = (input) =>
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
        `<filter id="f"><feMerge><feMergeNode in="${input}"/></feMerge></filter>` +
        `<g filter="url(#f)">${RECT}</g></svg>`;

      const shot = async (svg) => {
        const b = createBundle(gl, await importSvg(svg));
        const h = renderer.createBundleHandle(b);
        renderer.beginFrame([1, 1, 1, 1]);
        h.draw({});
        renderer.endFrame();
        const px = new Uint8Array(side * side * 4);
        gl.readPixels(0, 0, side, side, gl.RGBA, gl.UNSIGNED_BYTE, px);
        h.dispose();
        b.dispose();
        // Ink = anything darker than the white clear. Means are over ink only,
        // so background white can't wash out the color check.
        let ink = 0,
          sr = 0,
          sg = 0,
          sb = 0;
        for (let i = 0; i < px.length; i += 4) {
          const r = px[i],
            g = px[i + 1],
            bl = px[i + 2];
          if (r < 220 || g < 220 || bl < 220) {
            ink++;
            sr += r;
            sg += g;
            sb += bl;
          }
        }
        const d = Math.max(1, ink);
        return { ink, r: sr / d, g: sg / d, b: sb / d };
      };

      // A lone primitive takes the single-kind fast path, which folds the
      // filter to a matrix/sigma instead of building a graph. That path has to
      // honor `in` too.
      const LONE = (prim) =>
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160">' +
        `<filter id="f">${prim}</filter><g filter="url(#f)">${RECT}</g></svg>`;

      const out = {};
      for (const [k, doc] of [
        ['morphGraphic', MORPH('SourceGraphic')],
        ['morphAlpha', MORPH('SourceAlpha')],
        ['mergeGraphic', MERGE('SourceGraphic')],
        ['mergeAlpha', MERGE('SourceAlpha')],
        ['zeroBlurGraphic', LONE('<feGaussianBlur stdDeviation="0"/>')],
        ['zeroBlurAlpha', LONE('<feGaussianBlur in="SourceAlpha" stdDeviation="0"/>')],
        ['blurGraphic', LONE('<feGaussianBlur stdDeviation="3"/>')],
        ['blurAlpha', LONE('<feGaussianBlur in="SourceAlpha" stdDeviation="3"/>')],
        ['convGraphic', LONE('<feConvolveMatrix order="3" kernelMatrix="0 0 0 0 1 0 0 0 0"/>')],
        [
          'convAlpha',
          LONE('<feConvolveMatrix in="SourceAlpha" order="3" kernelMatrix="0 0 0 0 1 0 0 0 0"/>'),
        ],
      ])
        out[k] = await shot(doc);
      return out;
    }, SIDE);

    // ---- T1: the identity routes on SourceGraphic (the control) -----------
    // If these fail, the SourceAlpha checks below would be measuring a
    // broken passthrough rather than the alpha handling.
    for (const [name, s] of [
      ['feMorphology', stats.morphGraphic],
      ['feMerge', stats.mergeGraphic],
      ['feGaussianBlur zero', stats.zeroBlurGraphic],
    ]) {
      if (s.ink > 3000 && s.r > s.b + 60) {
        ok(`T1 ${name} identity on SourceGraphic passes the red rect through (${s.ink} px)`);
      } else {
        fail(
          `T1 ${name} on SourceGraphic: ${s.ink} ink px, r ${s.r.toFixed(1)} b ${s.b.toFixed(1)}`,
        );
      }
    }

    // ---- T2: the same routes on SourceAlpha give a BLACK silhouette -------
    for (const [name, s] of [
      ['feMorphology', stats.morphAlpha],
      ['feMerge', stats.mergeAlpha],
      ['feGaussianBlur zero', stats.zeroBlurAlpha],
    ]) {
      if (s.ink < 1000) {
        fail(
          `T2 ${name} identity on SourceAlpha rendered ${s.ink} px — ` +
            'the silhouette was cleared away (the defect this guards)',
        );
      } else if (s.r > 60 || s.g > 60 || s.b > 60) {
        fail(
          `T2 ${name} on SourceAlpha kept color (r ${s.r.toFixed(1)} g ${s.g.toFixed(1)} ` +
            `b ${s.b.toFixed(1)}) — RGB was not masked off`,
        );
      } else {
        ok(`T2 ${name} identity on SourceAlpha gives a black silhouette (${s.ink} px)`);
      }
    }

    // ---- T2b: the single-kind fast path must honor `in` too --------------
    // A lone feGaussianBlur/feConvolveMatrix never reaches the graph builder.
    // `<feGaussianBlur in="SourceAlpha">` is the standard hand-rolled drop
    // shadow, so getting a RED blur instead of a black one is very visible.
    for (const [name, s] of [
      ['feGaussianBlur', stats.blurAlpha],
      ['feConvolveMatrix', stats.convAlpha],
    ]) {
      if (s.ink < 1000) {
        fail(`T2b lone ${name} on SourceAlpha rendered ${s.ink} px — silhouette lost`);
      } else if (s.r > 60 || s.g > 60 || s.b > 60) {
        fail(
          `T2b lone ${name} ignored in="SourceAlpha" (r ${s.r.toFixed(1)} g ${s.g.toFixed(1)} ` +
            `b ${s.b.toFixed(1)}) — the single-kind path filtered the COLOR graphic`,
        );
      } else {
        ok(`T2b lone ${name} honors in="SourceAlpha" (${s.ink} px, black)`);
      }
    }

    // ---- T3: masking RGB must not eat coverage ---------------------------
    {
      const g = stats.mergeGraphic,
        a = stats.mergeAlpha;
      const drift = Math.abs(g.ink - a.ink) / Math.max(1, g.ink);
      if (drift < 0.02)
        ok(`T3 SourceAlpha covers the same area as SourceGraphic (${a.ink} vs ${g.ink})`);
      else fail(`T3 coverage differs by ${(drift * 100).toFixed(1)}% (${a.ink} vs ${g.ink})`);
    }
  } catch (e) {
    fail(`render drive failed: ${e.message}`);
  }
  await page.close();
}

// Filtered shape INSIDE an opacity group — the group-compositing path.
//
// examples/_filtergroup.svg: a solid blue rect outside the group, then
// <g opacity="0.5"> containing a blurred red rect (single-kind filterId
// route) and a plain green rect. The filter branch must:
//   * not clobber mainCopyTex (groupEnd's canvas snapshot),
//   * not clear shapeFbo (the group's accumulator),
//   * composite its output INTO the group, not escape to the canvas —
// so the filtered red renders at the group's 50% opacity like its green
// sibling, and the blue backdrop outside the group survives untouched.
async function filterGroup(suite) {
  const { ok, fail } = T;
  const page = await suite.page({ logs: false });
  await page.setViewport({ width: 400, height: 400 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  const target = `/mantleDemo.html?svg=/${encodeURIComponent('examples/_filtergroup.svg')}`;
  try {
    await suite.visit(page, target, { ready: 'demoSvg' });

    const s = await page.evaluate(() => {
      const cnv = document.getElementById('glcanvas');
      const gl = window.__mantleGl,
        renderer = window.__mantleRenderer;
      if (!cnv || !gl || !renderer) return null;
      renderer.render();
      const w = cnv.width,
        h = cnv.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let solidBlue = 0,
        halfRed = 0,
        halfGreen = 0,
        fullRed = 0,
        fullGreen = 0;
      for (let i = 0; i < px.length; i += 4) {
        const r = px[i],
          g = px[i + 1],
          b = px[i + 2];
        if (b > 200 && r < 80 && g < 80) solidBlue++;
        // 50% red over white ≈ (255, 127, 127); blur softens edges, so
        // accept a generous band around the plateau.
        if (r > 200 && g > 90 && g < 200 && b > 90 && b < 200) halfRed++;
        // 50% #00c000 over white ≈ (127, 223, 127).
        if (g > 180 && r > 90 && r < 200 && b > 90 && b < 200) halfGreen++;
        if (r > 200 && g < 60 && b < 60) fullRed++;
        if (g > 200 && r < 60 && b < 60) fullGreen++;
      }
      return { w, h, solidBlue, halfRed, halfGreen, fullRed, fullGreen };
    });
    if (!s) throw new Error('no canvas / WebGL2 context');
    console.log(
      `  diag: blue=${s.solidBlue} halfRed=${s.halfRed} halfGreen=${s.halfGreen} fullRed=${s.fullRed} fullGreen=${s.fullGreen}`,
    );

    if (s.solidBlue > 500) ok(`blue rect outside the group survives (${s.solidBlue} px)`);
    else fail(`blue backdrop lost (${s.solidBlue} px) — the in-group filter clobbered the canvas`);

    if (s.halfRed > 500) ok(`filtered red renders at group opacity (${s.halfRed} px)`);
    else fail(`no half-opacity red (${s.halfRed} px) — filtered shape missing or at wrong alpha`);

    if (s.halfGreen > 500) ok(`plain sibling renders at group opacity (${s.halfGreen} px)`);
    else
      fail(
        `no half-opacity green (${s.halfGreen} px) — group content clobbered by the filter branch`,
      );

    if (s.fullRed < 50)
      ok(`no full-opacity red (${s.fullRed} px) — the filter did not escape the group`);
    else
      fail(
        `${s.fullRed} full-opacity red px — the filtered shape composited to the canvas, escaping the group`,
      );

    if (s.fullGreen < 50) ok(`no full-opacity green (${s.fullGreen} px)`);
    else fail(`${s.fullGreen} full-opacity green px — group opacity not applied`);
  } catch (e) {
    fail(`render drive failed: ${e.message}`);
  }
  await page.close();
}

// filterUnhandledNode — a filter primitive with no registered
// handler must degrade to unfiltered, not to nothing.
//
// Handlers register themselves on import (dispatchRegistry.js), so a build
// that ships only the primitives its assets need — the whole point of the
// per-primitive split — hits the no-handler path for anything it left out.
// A path that CLEARS there silently deletes the artwork rather than degrading
// it -- and svgFilterShared.js exports a `passthrough` that really does copy, so
// a no-handler path with the same name is easy to mistake for it.
//
// A full build registers everything, so no rendering test reaches this. The
// dispatch table is just an object evaluateGraph is handed, though, so the
// case can be built directly: one node with a handler that fills red, feeding
// a second node whose type is deliberately absent from the table.
//
//   handled(red) -> UNHANDLED -> root
//
// Red root = the input was copied through. Transparent root = it was cleared,
// which is the defect.
async function filterUnhandledNode(suite) {
  const { ok, fail } = T;
  const page = await suite.page({ logs: false });
  await page.setViewport({ width: 64, height: 64 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  try {
    await suite.visit(page, '/mantleDemo.html', { ready: () => window.__mantleGl });

    const r = await page.evaluate(async () => {
      const { createRTPool, evaluateGraph, releaseRoot } =
        await import('/src/filterGraph/filterGraph.js');
      const gl = window.__mantleGl;
      const W = 64,
        H = 64;
      const pool = createRTPool(gl);

      // Fills its output with opaque red. Stands in for any registered handler.
      const fillRed = (node, inputs, outRT) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, outRT.fbo);
        gl.viewport(0, 0, outRT.size[0], outRT.size[1]);
        gl.disable(gl.BLEND);
        gl.clearColor(1, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      };

      const readRoot = (dispatch) => {
        const graph = {
          nodes: [
            { type: 'FillRed', inputs: [], params: null },
            // Absent from every dispatch table below.
            { type: 'NotRegistered', inputs: [0], params: null },
          ],
          rootOut: 1,
        };
        const ctx = { gl, pool, w: W, h: H };
        const root = evaluateGraph(gl, graph, pool, dispatch, ctx, W, H);
        const px = new Uint8Array(4);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, root.fbo);
        gl.readPixels(W >> 1, H >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        releaseRoot(pool, root);
        return Array.from(px);
      };

      // Control: the same graph with a handler for both nodes. Pins that the
      // harness renders red at all, so a transparent result in the real case
      // means the fallback, not a broken rig.
      const control = readRoot({ FillRed: fillRed, NotRegistered: fillRed });
      const unhandled = readRoot({ FillRed: fillRed });

      pool.invalidate();
      return { control, unhandled };
    });

    if (r.control[0] > 200 && r.control[3] > 200) {
      ok(`T1 control: both nodes handled renders red (${r.control.join(',')})`);
    } else {
      fail(
        `T1 control rendered ${r.control.join(',')} — the rig is broken, T2 would be meaningless`,
      );
    }

    if (r.unhandled[3] < 40) {
      fail(
        `T2 unhandled node produced ${r.unhandled.join(',')} — the input was CLEARED, ` +
          'so a missing handler deletes the artwork (this is the bug)',
      );
    } else if (r.unhandled[0] > 200 && r.unhandled[3] > 200) {
      ok(`T2 unhandled node copies its input through (${r.unhandled.join(',')})`);
    } else {
      fail(`T2 unhandled node produced ${r.unhandled.join(',')}, expected the red input`);
    }
  } catch (e) {
    fail(`drive failed: ${e.message}`);
  }
  await page.close();
}

// Guards that rounded-rect and feDropShadow both render, WITH and WITHOUT a
// worldMatrix.
//   A: <rect rx>            — mixed line + native-arc contour
//   B: <path> rounded rect  — control (always rendered)
//   D: <circle> + feDropShadow — card + a visible soft shadow
async function rectRxDropShadow(suite) {
  const A = readFileSync(
    new URL('../examples/smoke/rectRxDropShadowRender__A.svg', import.meta.url),
    'utf8',
  );
  const B = readFileSync(
    new URL('../examples/smoke/rectRxDropShadowRender__B.svg', import.meta.url),
    'utf8',
  );
  const D = readFileSync(
    new URL('../examples/smoke/rectRxDropShadowRender__D.svg', import.meta.url),
    'utf8',
  );
  const pg = await suite.page({ logs: false });
  await pg.setViewport({ width: 300, height: 300 });
  pg.on('pageerror', (e) => console.error('[page]', e.message));
  await suite.visit(pg, '/mantleDemo.html', { ready: 'renderer' });
  const out = await pg.evaluate(
    async (A, B, D) => {
      const { importSvg, createBundle } = await import('/src/index.js');
      const gl = window.__mantleGl,
        r = window.__mantleRenderer,
        cnv = document.getElementById('glcanvas');
      cnv.width = 300;
      cnv.height = 300;
      r.setViewport(300, 300);
      const px = new Uint8Array(300 * 300 * 4);
      async function render(svg, wm) {
        let white = 0,
          dark = 0,
          err = null;
        try {
          const b = createBundle(gl, await importSvg(svg));
          r.beginFrame([0.3, 0.3, 0.3, 1]);
          r.drawBundle(b, wm ? { worldMatrix: wm } : undefined);
          r.endFrame();
          gl.readPixels(0, 0, 300, 300, gl.RGBA, gl.UNSIGNED_BYTE, px);
          for (let i = 0; i < px.length; i += 4) {
            const lum = px[i] * 0.3 + px[i + 1] * 0.6 + px[i + 2] * 0.1;
            if (lum > 200) white++;
            else if (lum < 60 && px[i] + px[i + 1] + px[i + 2] > 4) dark++;
          }
          b.dispose();
        } catch (e) {
          err = e.message;
        }
        return { white, dark, err };
      }
      const wm = new Float32Array([0.9, 0, 0, 0, 0.9, 0, 0, 0, 1]);
      return {
        A: await render(A),
        Awm: await render(A, wm),
        B: await render(B),
        D: await render(D),
        Dwm: await render(D, wm),
      };
    },
    A,
    B,
    D,
  );
  await pg.close();
  const need = (cond, msg) => {
    if (!cond) T.fail(msg);
  };
  need(
    !out.A.err && out.A.white > 5000,
    `rect rx renders (white=${out.A.white}${out.A.err ? ' err=' + out.A.err : ''})`,
  );
  need(
    !out.Awm.err && out.Awm.white > 5000,
    `rect rx renders under worldMatrix (white=${out.Awm.white})`,
  );
  need(out.B.white > 5000, `path rounded-rect renders (white=${out.B.white})`);
  need(
    !out.D.err && out.D.white > 5000,
    `feDropShadow card renders (white=${out.D.white}${out.D.err ? ' err=' + out.D.err : ''})`,
  );
  need(out.D.dark > 500, `feDropShadow soft shadow renders (shadow px=${out.D.dark})`);
  need(
    out.Dwm.white > 5000 && out.Dwm.dark > 500,
    `feDropShadow renders under worldMatrix (white=${out.Dwm.white} shadow=${out.Dwm.dark})`,
  );
  if (!T.caseFailures())
    T.ok(
      `rect-rx renders (${out.A.white}px), feDropShadow renders card+shadow (${out.D.white}px + ${out.D.dark} shadow px)`,
    );
}

// filterFrameOrigin — a filtered draw must not displace the NEXT draw.
//
// A filtered shape renders into an RT covering only itself, which means its fill pass
// runs with a TRANSLATED viewport and the shader is told where its framebuffer sits
// (uFragOrigin). That origin belongs to exactly one pass. If it outlives the pass,
// everything drawn afterwards is rendered through the leftover shift — displaced by the
// filter's rect, in a LATER frame, far from the code that set it.
//
// A reset written into the wrong branch (the COLR one, the first textual match of the same
// three lines) leaves the filter-graph route setting the origin and never clearing it, and
// no fixture that draws nothing after a filtered shape notices. So endFillPass owns the
// origin's lifetime, and a caller cannot forget.
//
// Draw a plain bundle twice — once after a FILTERED draw, once after a PLAIN one. The
// two frames must be identical. Nothing about the plain bundle depends on what was
// drawn before it.
async function filterFrameOrigin(suite) {
  const { ok, fail } = T;
  // The filtered draw — a drop shadow, so it takes the filter-GRAPH route.
  const FILTERED = readFileSync(
    new URL('../examples/smoke/filterFrameOrigin__FILTERED.svg', import.meta.url),
    'utf8',
  );
  // A lone blur — the SINGLE-KIND route, which shifts its viewport too.
  const BLURRED = readFileSync(
    new URL('../examples/smoke/filterFrameOrigin__BLURRED.svg', import.meta.url),
    'utf8',
  );
  // The victim: no filter at all. Where it lands must not depend on the frame before.
  const PLAIN = readFileSync(
    new URL('../examples/smoke/filterFrameOrigin__PLAIN.svg', import.meta.url),
    'utf8',
  );
  const page = await suite.page({ logs: false });
  await page.setViewport({ width: 500, height: 500 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await suite.visit(page, '/mantleDemo.html', { ready: 'renderer' });
  const res = await page.evaluate(
    async (svgs) => {
      const { importSvg, createBundle } = await import('/src/index.js');
      const gl = window.__mantleGl;
      const renderer = window.__mantleRenderer;
      const cnv = document.getElementById('glcanvas');
      // A small shape on a big canvas — the case the rect RTs exist for, and the one where
      // a leaked origin displaces by the most.
      const W = 820,
        H = 1000;
      cnv.width = W;
      cnv.height = H;
      const WM = [0.55, 0, 0, 0, 0.55, 0, 0.12, 0.18, 1];

      const drawOnce = async (svg) => {
        const b = createBundle(gl, await importSvg(svg));
        const h = renderer.createBundleHandle(b);
        renderer.beginFrame([1, 1, 1, 1]);
        h.draw({ worldMatrix: WM });
        renderer.endFrame();
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        h.dispose();
        b.dispose();
        return px;
      };
      // `after` is drawn in its own frame FIRST; then PLAIN, in a frame of its own.
      const plainAfter = async (after) => {
        await drawOnce(after);
        return drawOnce(svgs.PLAIN);
      };

      const baseline = await plainAfter(svgs.PLAIN); // plain after plain
      const afterGraph = await plainAfter(svgs.FILTERED); // plain after a filter GRAPH
      const afterBlur = await plainAfter(svgs.BLURRED); // plain after a SINGLE-KIND filter

      const cmp = (a, b) => {
        let d = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (
            Math.abs(a[i] - b[i]) > 8 ||
            Math.abs(a[i + 1] - b[i + 1]) > 8 ||
            Math.abs(a[i + 2] - b[i + 2]) > 8
          )
            d++;
        }
        return d;
      };
      let ink = 0;
      for (let i = 0; i < baseline.length; i += 4) {
        if (baseline[i] < 250 || baseline[i + 1] < 250 || baseline[i + 2] < 250) ink++;
      }
      return {
        ink,
        graph: cmp(baseline, afterGraph),
        blur: cmp(baseline, afterBlur),
        total: W * H,
      };
    },
    { FILTERED, BLURRED, PLAIN },
  );

  console.log(
    `  plain bundle ink ${res.ink}px   ` +
      `diff after graph-filter ${res.graph}px, after single-kind filter ${res.blur}px`,
  );

  if (res.ink < 5000) {
    fail(
      `the plain bundle barely rendered (${res.ink}px) — a displaced shape would look ` +
        `the same as this, so the comparisons below prove nothing`,
    );
  } else {
    ok(`the plain bundle renders (${res.ink}px of ink)`);
  }
  for (const [name, d] of [
    ['filter graph', res.graph],
    ['single-kind filter', res.blur],
  ]) {
    if (d > 0) {
      fail(
        `a plain draw after a ${name} differs from the same draw after a plain one — ` +
          `${d}px. The filtered pass's frame origin outlived it, so this draw rendered ` +
          `through a leftover viewport shift. endFillPass must clear R._fragOrigin.`,
      );
    } else {
      ok(`a plain draw after a ${name} is unaffected by it (0px differ)`);
    }
  }
  await page.close();
}

// nineSliceFilter — nine-slice must stretch a FILTERED shape the same
// as an unfiltered one.
// Renders a rounded rect (a) WITHOUT and (b) WITH feDropShadow, each nine-sliced
// to a wide target, and asserts both fill ~the full width. A filter pass
// scissored to the shape's native bbox (mapped through the stretched target
// globalBBox) would clip the filtered output to ~1/3 (native) width.
async function nineSliceFilter(suite) {
  const { fail } = T;
  const PLAIN = readFileSync(
    new URL('../examples/smoke/nineSliceFilter__PLAIN.svg', import.meta.url),
    'utf8',
  );
  const FILT = readFileSync(
    new URL('../examples/smoke/nineSliceFilter__FILT.svg', import.meta.url),
    'utf8',
  );
  const page = await suite.page({ logs: false });
  await page.setViewport({ width: 400, height: 120 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await suite.visit(page, '/mantleDemo.html', { ready: 'renderer' });
  const out = await page.evaluate(
    async (PLAIN, FILT) => {
      const { importSvg, createBundle } = await import('/src/index.js');
      const gl = window.__mantleGl,
        renderer = window.__mantleRenderer;
      const cnv = document.getElementById('glcanvas');
      cnv.width = 400;
      cnv.height = 120;
      renderer.setViewport(400, 120);

      async function inkExtent(svg) {
        const base = createBundle(gl, await importSvg(svg));
        // Stretch native 100-em width to a 300-em wide target (3x) with 15-em corners.
        const inst = base.nineSliceInstance({ border: [15, 15, 15, 15], worldSize: [300, 50] });
        const h = renderer.createBundleHandle(inst);
        renderer.beginFrame([1, 1, 1, 1]);
        h.draw();
        renderer.endFrame();
        const p = new Uint8Array(cnv.width * cnv.height * 4);
        gl.readPixels(0, 0, cnv.width, cnv.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
        let minX = 1e9,
          maxX = -1,
          minY = 1e9,
          maxY = -1,
          ink = 0;
        for (let y = 0; y < cnv.height; y++)
          for (let x = 0; x < cnv.width; x++) {
            const i = (y * cnv.width + x) * 4;
            // non-white (shape is red, shadow is dark)
            if (p[i] < 235 || p[i + 1] < 235 || p[i + 2] < 235) {
              ink++;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
        h.dispose();
        inst.dispose();
        base.dispose();
        const chunkCounts = inst.coverQuadChunks.map((c) => c.count);
        return {
          ink,
          wpx: maxX - minX + 1,
          hpx: maxY - minY + 1,
          minX,
          maxX,
          chunkCounts,
          active: !!inst._nineSliceActive,
        };
      }
      return { plain: await inkExtent(PLAIN), filt: await inkExtent(FILT) };
    },
    PLAIN,
    FILT,
  );
  await page.close();
  console.log('PLAIN (no filter):', JSON.stringify(out.plain));
  console.log('FILT  (feDropShadow):', JSON.stringify(out.filt));
  const plainW = out.plain.wpx,
    filtW = out.filt.wpx;
  console.log(
    `\nink width — plain=${plainW}px  filtered=${filtW}px  ratio=${(filtW / plainW).toFixed(2)}`,
  );
  // A filtered shape must nine-slice-stretch like an unfiltered one; a
  // filter-pass scissor at the native bbox would clip the output to ~1/3 width.
  if (!(out.plain.active && out.filt.active)) fail('nine-slice not active on one instance');
  if (!(plainW >= 380)) fail(`unfiltered shape did not stretch to full width (${plainW}px)`);
  if (filtW < plainW * 0.9)
    fail(
      `filtered shape did not stretch: ${filtW}px vs unfiltered ${plainW}px (ratio ${(filtW / plainW).toFixed(2)})`,
    );
  if (!T.caseFailures()) T.ok('a filtered shape nine-slice-stretches like an unfiltered one');
}

const suite = await openPageSuite({ root: ROOT });
try {
  await T.run(
    [
      ['filterPrimitives', filterPrimitives],
      ['filterPassthroughAlpha', filterPassthroughAlpha],
      ['filterGroup', filterGroup],
      ['filterUnhandledNode', filterUnhandledNode],
      ['rectRxDropShadow', rectRxDropShadow],
      ['filterFrameOrigin', filterFrameOrigin],
      ['nineSliceFilter', nineSliceFilter],
    ],
    suite,
  );
} finally {
  await suite.close();
}
console.log();
console.log(T.failures() === 0 ? 'FILTER VISUAL PASS' : `FILTER VISUAL FAIL (${T.failures()})`);
process.exit(T.failures() === 0 ? 0 : 1);
