// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeExactAaSmoke.mjs — exact-area AA on straight stroke edges (DEFAULT ON).
//
// A stroke's distance-to-coverage step is an isotropic 1D ramp:
//   cov = clamp(0.5 - (minD - halfW) / pxSize)
// which is the true area(pixel box ∩ stroke) only for an AXIS-ALIGNED edge.
// _boxCov.glsl already documents that weakness for Slug's fill combiner —
// mean 10.6/255, max 31.9 at 45° — and the stroke path has the same one.
//
// Where the boundary is a straight offset line (a LINE segment's body) its
// normal is known in closed form, so the exact box coverage is available from
// the same exactBoxCov the fill engines use.
//
// CURVES TOO. A curve's OFFSET is not polynomial — which is why a stroke cannot
// be turned into a fill — but exactBoxCov needs only the boundary NORMAL AT A
// POINT, and that is the distance gradient, already in hand once the closest
// point is solved. Over one pixel a curved boundary departs from its tangent by
// O(kappa*px^2), far under a coverage LSB. Curves gain MORE than lines (64% vs
// 53%), so restricting this to lines would leave the larger half on the table.
// That is the DEFAULT;
// renderer.setStrokeExactAa(false) restores the ramp. Caps, joins and curved segments have no closed-form
// normal here and keep the ramp either way.
//
// The reference is this renderer at 8x, box-filtered down — the identical
// shader, so the comparison isolates the distance→coverage step rather than
// pitting two rasterizers against each other. Both modes are measured in one
// run and compared to each other, so the assertion does not depend on absolute
// error values that would drift with unrelated AA work.
//
// METRIC NOTE: error is summed over ALL pixels, not averaged over the pixels
// that differ. Averaging over differing pixels rewards being wrong on fewer of
// them — it ranks the exact path WORSE while it matches the reference on 4-8x
// more pixels.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const ok = (m) => console.log('  ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL ' + m);
};

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

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 900, height: 900 });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/mantleDemo.html`, {
    waitUntil: 'load',
    timeout: 20000,
  });
  await page.waitForFunction(() => window.__mantleGl, { timeout: 20000, polling: 100 });

  const r = await page.evaluate(async () => {
    const { importSvg, createBundle, createRenderer, loadShaders } = await import('/src/index.js');
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
    const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
    const S = 64;

    // ONE renderer for both modes: exact-area AA is a coherent uniform, so the
    // two differ in nothing else. Building two renderers with different
    // fillDefines would compare shader VARIANTS, not the feature.
    const R = createRenderer(gl, shaders, { strokeExactEdges: true });
    const measure = async (exact) => {
      R.setStrokeExactAa(exact);
      const render = (doc, side) => {
        cv.width = side;
        cv.height = side;
        R.setViewport(side, side);
        const b = createBundle(gl, doc);
        const h = R.createBundleHandle(b);
        R.beginFrame([1, 1, 1, 1]);
        h.draw({});
        R.endFrame();
        const px = new Uint8Array(side * side * 4);
        gl.readPixels(0, 0, side, side, gl.RGBA, gl.UNSIGNED_BYTE, px);
        h.dispose();
        b.dispose();
        return px;
      };
      let total = 0,
        curveTotal = 0,
        arcTotal = 0;
      // CURVED strokes: a quad/cubic body hit has an exact boundary normal too
      // (the distance gradient), so exact-area AA applies there as well — the
      // offset curve is never needed. Measured separately from the lines.
      for (const [i, d] of [
        'M10 70 Q50 5 90 70',
        'M10 60 C30 5 70 5 90 60',
        'M15 50 Q50 90 85 50',
        'M10 30 C40 90 60 -10 90 55',
      ].entries()) {
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
          `<path d="${d}" fill="none" stroke="#000" stroke-width="7" stroke-linecap="butt"/></svg>`;
        const doc = await importSvg(svg);
        const lo = render(doc, S),
          hi = render(doc, S * 8);
        for (let y = 0; y < S; y++)
          for (let x = 0; x < S; x++) {
            let acc = 0;
            for (let sy = 0; sy < 8; sy++)
              for (let sx = 0; sx < 8; sx++) {
                acc += hi[((y * 8 + sy) * S * 8 + (x * 8 + sx)) * 4];
              }
            curveTotal += Math.abs(acc / 64 - lo[(y * S + x) * 4]);
          }
        void i;
      }
      // ARCS: the walk already solves the closest point on the ellipse (`foot`),
      // so the same distance-gradient rule applies once it is rotated out of the
      // ellipse's local frame.
      for (const d of [
        'M20 50 A30 30 0 0 1 80 50',
        'M20 60 A30 18 0 0 1 80 60',
        'M25 30 A25 25 0 1 1 75 30',
        'M20 50 A34 20 25 0 1 80 55',
      ]) {
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
          `<path d="${d}" fill="none" stroke="#000" stroke-width="7" stroke-linecap="butt"/></svg>`;
        const doc = await importSvg(svg);
        const lo = render(doc, S),
          hi = render(doc, S * 8);
        for (let y = 0; y < S; y++)
          for (let x = 0; x < S; x++) {
            let acc = 0;
            for (let sy = 0; sy < 8; sy++)
              for (let sx = 0; sx < 8; sx++) {
                acc += hi[((y * 8 + sy) * S * 8 + (x * 8 + sx)) * 4];
              }
            arcTotal += Math.abs(acc / 64 - lo[(y * S + x) * 4]);
          }
      }
      // Skip 0/90°: the stroke's cap ends land differently between the two
      // render scales there, which swamps the edge term this test is about.
      for (const ang of [10, 20, 30, 45, 60, 75]) {
        const a = (ang * Math.PI) / 180,
          L = 30;
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
          `<path d="M${(50 - L * Math.cos(a)).toFixed(3)} ${(50 - L * Math.sin(a)).toFixed(3)}` +
          ` L${(50 + L * Math.cos(a)).toFixed(3)} ${(50 + L * Math.sin(a)).toFixed(3)}"` +
          ' fill="none" stroke="#000" stroke-width="7" stroke-linecap="butt"/></svg>';
        const doc = await importSvg(svg);
        const lo = render(doc, S),
          hi = render(doc, S * 8);
        for (let y = 0; y < S; y++)
          for (let x = 0; x < S; x++) {
            let acc = 0;
            for (let sy = 0; sy < 8; sy++)
              for (let sx = 0; sx < 8; sx++) {
                acc += hi[((y * 8 + sy) * S * 8 + (x * 8 + sx)) * 4];
              }
            total += Math.abs(acc / 64 - lo[(y * S + x) * 4]);
          }
      }
      return {
        lines: Math.round(total),
        curves: Math.round(curveTotal),
        arcs: Math.round(arcTotal),
      };
    };
    const a = await measure(false),
      b = await measure(true);
    return {
      ramp: a.lines,
      exact: b.lines,
      rampC: a.curves,
      exactC: b.curves,
      rampA: a.arcs,
      exactA: b.arcs,
    };
  });

  console.log(`   LINES  total |error| vs 8x reference — ramp ${r.ramp}, exact ${r.exact}`);
  console.log(
    `   CURVES total |error| vs 8x reference — ramp ${r.rampC}, exact ${r.exactC}` +
      `  (${(100 * (1 - r.exactC / Math.max(r.rampC, 1))).toFixed(0)}% better)`,
  );
  console.log(
    `   ARCS   total |error| vs 8x reference — ramp ${r.rampA}, exact ${r.exactA}` +
      `  (${(100 * (1 - r.exactA / Math.max(r.rampA, 1))).toFixed(0)}% better)`,
  );

  if (!(r.ramp > 0 && r.exact > 0)) {
    fail(`degenerate measurement (ramp ${r.ramp}, exact ${r.exact}) — the rig rendered nothing`);
  } else {
    // Roughly 38% better overall and 83% at 45°. Require a clear margin
    // without pinning the exact figure, which unrelated AA work would move.
    const gain = 1 - r.exact / r.ramp;
    const gainC = 1 - r.exactC / Math.max(r.rampC, 1);
    const gainA = 1 - r.exactA / Math.max(r.rampA, 1);
    if (gain >= 0.2 && gainC >= 0.2 && gainA >= 0.2) {
      ok(
        `exact-area edges cut stroke AA error ${(gain * 100).toFixed(0)}% lines ` +
          `(${r.ramp}->${r.exact}), ${(gainC * 100).toFixed(0)}% curves ` +
          `(${r.rampC}->${r.exactC}), ${(gainA * 100).toFixed(0)}% arcs ` +
          `(${r.rampA}->${r.exactA})`,
      );
    } else if (gainC < 0.2) {
      fail(
        `curved strokes gained only ${(gainC * 100).toFixed(0)}% (${r.rampC} -> ${r.exactC}). ` +
          'A curve body hit has an exact boundary normal too — the distance gradient — so ' +
          'strokeQuad/CubicAccum must still be reporting gradOut.',
      );
    } else if (gainA < 0.2) {
      fail(
        `arc strokes gained only ${(gainA * 100).toFixed(0)}% (${r.rampA} -> ${r.exactA}). ` +
          'The arc walk solves the closest point on the ellipse (`foot`); its gradient must ' +
          'be rotated out of the local frame and reported.',
      );
    } else {
      fail(
        `strokeExactAa gained only ${(gain * 100).toFixed(0)}% (${r.ramp} -> ${r.exact}); ` +
          'expected >=20%. Either setStrokeExactAa stopped reaching the shader, or ' +
          'the body-hit gradient is no longer being set.',
      );
    }
  }
} catch (e) {
  fail('drive failed: ' + e.message);
}

await browser.close();
server.close();
console.log();
console.log(failures === 0 ? 'STROKE-EXACT-AA PASS' : `STROKE-EXACT-AA FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
