// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nineSliceFilterSmoke.mjs — nine-slice must stretch a FILTERED shape the same
// as an unfiltered one.
// Renders a rounded rect (a) WITHOUT and (b) WITH feDropShadow, each nine-sliced
// to a wide target, and asserts both fill ~the full width. A filter pass
// scissored to the shape's native bbox (mapped through the stretched target
// globalBBox) would clip the filtered output to ~1/3 (native) width.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
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
const port = server.address().port;

const PLAIN = readFileSync(
  new URL('../examples/smoke/nineSliceFilter__PLAIN.svg', import.meta.url),
  'utf8',
);
const FILT = readFileSync(
  new URL('../examples/smoke/nineSliceFilter__FILT.svg', import.meta.url),
  'utf8',
);

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 120 });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await openReady(page, `http://127.0.0.1:${port}/mantleDemo.html`, { ready: 'renderer' });

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

await browser.close();
server.close();

console.log('PLAIN (no filter):', JSON.stringify(out.plain));
console.log('FILT  (feDropShadow):', JSON.stringify(out.filt));
const plainW = out.plain.wpx,
  filtW = out.filt.wpx;
console.log(
  `\nink width — plain=${plainW}px  filtered=${filtW}px  ratio=${(filtW / plainW).toFixed(2)}`,
);

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
// A filtered shape must nine-slice-stretch like an unfiltered one; a
// filter-pass scissor at the native bbox would clip the output to ~1/3 width.
if (!(out.plain.active && out.filt.active)) fail('nine-slice not active on one instance');
if (!(plainW >= 380)) fail(`unfiltered shape did not stretch to full width (${plainW}px)`);
if (filtW < plainW * 0.9)
  fail(
    `filtered shape did not stretch: ${filtW}px vs unfiltered ${plainW}px (ratio ${(filtW / plainW).toFixed(2)})`,
  );

if (failures > 0) {
  console.error(`\nNINE-SLICE-FILTER FAIL (${failures})`);
  process.exit(1);
}
console.log('\nNINE-SLICE-FILTER PASS');
