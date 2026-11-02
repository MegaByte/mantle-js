// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// feSpotLightConeSmoke — an feSpotLight with no limitingConeAngle lights the surface.
//
// The importer and the filter graph write spotCosCone = 2.0 to mean "no cone" (svg/filter.js,
// filterGraph/primitives/lighting.js), so feLighting.frag.glsl must not zero the light whenever
// cosLight < uSpotCosCone -- always true for 2.0 -- or every cone-less spot light renders black
// (diffuse) or nothing (specular). feLightingWorldScaleSmoke only binds the uniforms.
//
// THE REFERENCE IS THE BROWSER'S own RENDERING of the same SVG, read back through a 2D canvas, so the
// assertion is "lit where Chrome is lit, dark where Chrome is dark" at sampled points. A coned spot is
// checked too: the "no cone" value must not open a cone that was asked for.
//
// A BLACK GROUND ON both SIDES. feSpecularLighting's alpha is its brightest channel, so an unlit
// result is transparent -- and transparent over white reads white, exactly like a lit one, so a
// broken specular case would pass at 255 everywhere on a white ground.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 128;
const spot = (cone) =>
  `<feSpotLight x="64" y="64" z="60" pointsAtX="64" pointsAtY="64" pointsAtZ="0" specularExponent="1"${cone ? ` limitingConeAngle="${cone}"` : ''}/>`;
const svg = (prim) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<filter id="f" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">${prim}</filter>` +
  `<rect width="${N}" height="${N}" fill="#000" filter="url(#f)"/></svg>`;
const CASES = [
  [
    'diffuse, no cone',
    svg(
      `<feDiffuseLighting in="SourceGraphic" lighting-color="#fff" surfaceScale="0" diffuseConstant="1">${spot(0)}</feDiffuseLighting>`,
    ),
  ],
  [
    'specular, no cone',
    svg(
      `<feSpecularLighting in="SourceGraphic" lighting-color="#fff" surfaceScale="0" specularConstant="1" specularExponent="1">${spot(0)}</feSpecularLighting>`,
    ),
  ],
  [
    'diffuse, 20 degree cone',
    svg(
      `<feDiffuseLighting in="SourceGraphic" lighting-color="#fff" surfaceScale="0" diffuseConstant="1">${spot(20)}</feDiffuseLighting>`,
    ),
  ],
];
// Center, a mid point inside a 20-degree cone's reach (22 px at z 60), one outside it, and a corner.
const PTS = [
  [64, 64],
  [64, 80],
  [64, 110],
  [8, 8],
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];
window.__case = async (svg, pts) => {
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  for (let i = 0; i < 3; i++) { R.beginFrame([0, 0, 0, 1]); R.drawBundle(b); R.endFrame(); }
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const cv = document.createElement('canvas'); cv.width = cv.height = ${N};
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, ${N}, ${N}); ctx.drawImage(img, 0, 0);
  const ref = ctx.getImageData(0, 0, ${N}, ${N}).data;
  // WebGL rows are bottom-up, the 2D canvas's top-down.
  return pts.map(([x, y]) => ({ x, y, mantle: +lum(px, ((${N} - 1 - y) * ${N} + x) * 4).toFixed(1), chrome: +lum(ref, (y * ${N} + x) * 4).toFixed(1) }));
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail('page: ' + e.message));
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const [name, s] of CASES) {
    const pts = await page.evaluate((a, b) => window.__case(a, b), s, PTS);
    console.log(
      `  ${name}: ` +
        pts.map((p) => `(${p.x},${p.y}) mantle ${p.mantle} chrome ${p.chrome}`).join('  '),
    );
    // Lit and dark where Chrome is (40 of 255 is the line), and within 8/255 where lit. The two agree
    // to the unit on this GPU; 8 leaves room for another backend's precision and is still far inside
    // the specular double premultiply this also guards (191 read 143, 139 read 76).
    let bad = 0;
    for (const p of pts) {
      const litM = p.mantle > 40,
        litC = p.chrome > 40;
      if (litM !== litC || (litM && Math.abs(p.mantle - p.chrome) > 8)) bad++;
    }
    if (pts.every((p) => p.chrome <= 40)) {
      fail(`${name}: Chrome itself is dark at every sample — the case proves nothing`);
      continue;
    }
    if (!bad) ok(`${name}: lit and dark where Chrome is, within 8/255`);
    else fail(`${name}: ${bad} of ${pts.length} samples disagree with Chrome`);
  }
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log('\nfeSpotLightConeSmoke: spot lights light, with and without a cone');
