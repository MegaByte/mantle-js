// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// paintOrderStrokeSmoke — paint-order="stroke" puts the stroke UNDER the fill,
// and costs one draw, not two.
//
// Fill and stroke are separate meta rows, emitted in the requested paint order.
// The cover-quad meshes are appended to the VBO in emission order and the
// renderer batches adjacent chunks only while chunk.vboStart === pendingEnd, so
// emitting fill-then-stroke and SWAPPING the two rows afterwards would leave draw
// order reversed against VBO order and break the batch — two draws per shape.
// Emitting in the requested order keeps the pair contiguous.
//
// Two things are checked, because the draw count alone would happily pass while
// painting the layers the wrong way round:
//
//   1. SEMANTICS. With the stroke underneath, the fill covers its inner half, so
//      only the outer half stays visible — roughly half the stroke ink of the
//      default order. Measured by counting stroke-colored pixels rather than by
//      assuming canvas coordinates: the renderer fits the CONTENT BBOX to the
//      viewport, so em positions do not map to pixels the obvious way.
//   2. BATCHING. One draw, matching the default order.
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

const svgFor = (po) =>
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  `<rect x="25" y="25" width="50" height="50" fill="#ff0000" stroke="#0000ff" stroke-width="10"` +
  (po ? ' paint-order="stroke"' : '') +
  '/></svg>';

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="400" height="400"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = 400;
const cv = document.getElementById('c');
const raw = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const counts = {};
const gl = new Proxy(raw, { get(t, k) {
  const v = t[k];
  if (typeof v !== 'function') return v;
  return (...a) => { counts[k] = (counts[k] || 0) + 1; return v.apply(t, a); };
} });
const R = createRenderer(gl, shaders, {});
R.setViewport(S, S);

window.__run = async (svg) => {
  const sec = await importSvg(svg);
  const b = createBundle(gl, sec);
  const h = R.createBundleHandle(b);
  const draw = () => { R.beginFrame([1, 1, 1, 1]); h.draw({}); R.endFrame(); };
  for (let i = 0; i < 8; i++) draw();
  for (const k of Object.keys(counts)) delete counts[k];
  draw();
  const px = new Uint8Array(S * S * 4);
  raw.readPixels(0, 0, S, S, raw.RGBA, raw.UNSIGNED_BYTE, px);
  // Center row: count strongly-blue (stroke) and strongly-red (fill) pixels.
  const y = S >> 1;
  let stroke = 0, fill = 0;
  for (let x = 0; x < S; x++) {
    const i = ((y * S) + x) * 4;
    if (px[i + 2] > 160 && px[i] < 96) stroke++;
    if (px[i] > 160 && px[i + 2] < 96) fill++;
  }
  h.dispose(); b.dispose();
  return { stroke, fill,
    draws: (counts.drawArrays || 0) + (counts.drawElements || 0) + (counts.drawArraysInstanced || 0) };
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
  const def = await page.evaluate((s) => window.__run(s), svgFor(false));
  const po = await page.evaluate((s) => window.__run(s), svgFor(true));

  console.log(
    `   default          stroke px ${def.stroke}, fill px ${def.fill}, draws ${def.draws}`,
  );
  console.log(`   paint-order=strk stroke px ${po.stroke}, fill px ${po.fill}, draws ${po.draws}`);

  if (def.stroke === 0 || def.fill === 0) {
    fail('the default order rendered no stroke or no fill — the fixture is not drawing');
  } else if (po.stroke === 0) {
    fail(
      'paint-order="stroke" rendered NO visible stroke; the fill has covered all of it, ' +
        'so the stroke is not merely underneath but fully hidden',
    );
  } else {
    ok(
      `both orders render both paints (default ${def.stroke}/${def.fill}, ` +
        `paint-order ${po.stroke}/${po.fill})`,
    );
    // Under the fill, only the stroke's outer half survives.
    if (po.stroke * 1.5 < def.stroke) {
      ok(
        `paint-order="stroke" hides the stroke's inner half ` +
          `(${def.stroke} -> ${po.stroke} stroke px on the center row)`,
      );
    } else {
      fail(
        `paint-order="stroke" left ${po.stroke} stroke px against the default's ` +
          `${def.stroke} — the stroke is not being painted UNDER the fill`,
      );
    }
    if (po.fill <= def.fill) {
      fail(
        `paint-order="stroke" should show MORE fill than the default (the fill is on ` +
          `top), but showed ${po.fill} against ${def.fill}`,
      );
    } else {
      ok(`the fill is on top (${def.fill} -> ${po.fill} fill px)`);
    }
    if (po.draws === def.draws) {
      ok(
        `paint-order costs the same ${po.draws} draw(s) as the default — the fill/stroke ` +
          'pair still batches',
      );
    } else {
      fail(
        `paint-order="stroke" costs ${po.draws} draws vs the default's ${def.draws}. The ` +
          'pair is no longer VBO-contiguous, so the cover-quad batch breaks — emit the rows ' +
          'in paint order rather than swapping them afterwards.',
      );
    }
  }
} catch (e) {
  fail('drive failed: ' + e.message);
}

await browser.close();
server.close();
console.log();
console.log(failures === 0 ? 'PAINT-ORDER-STROKE PASS' : `PAINT-ORDER-STROKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
