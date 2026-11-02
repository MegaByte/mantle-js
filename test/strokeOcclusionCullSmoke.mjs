// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeOcclusionCullSmoke — a stroke hidden behind opaque geometry is culled,
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

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(q.url.split('?')[0]);
    const mime = /\.(js|mjs)$/.test(p)
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
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
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, {
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

await browser.close();
server.close();
console.log();
console.log(
  failures === 0 ? 'STROKE-OCCLUSION-CULL PASS' : `STROKE-OCCLUSION-CULL FAIL (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
