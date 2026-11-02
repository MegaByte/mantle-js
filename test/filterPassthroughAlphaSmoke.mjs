// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterPassthroughAlphaSmoke.mjs — an identity filter primitive reading
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

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SIDE = 160;

const mime = (p) =>
  p.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript; charset=utf-8'
      : p.endsWith('.glsl')
        ? 'text/plain; charset=utf-8'
        : 'application/octet-stream';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try {
    res.writeHead(200, { 'content-type': mime(p) });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('  ok ' + m);

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: SIDE, height: SIDE });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/mantleDemo.html`, {
    waitUntil: 'load',
    timeout: 20000,
  });
  await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
    timeout: 20000,
    polling: 100,
  });

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
      fail(`T1 ${name} on SourceGraphic: ${s.ink} ink px, r ${s.r.toFixed(1)} b ${s.b.toFixed(1)}`);
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

await browser.close();
server.close();
console.log();
console.log(
  failures === 0 ? 'FILTER-PASSTHROUGH-ALPHA PASS' : `FILTER-PASSTHROUGH-ALPHA FAIL (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
