// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// maskBakePerHandleSmoke — two masked bundles drawn every frame do not re-bake each other's mask
// layers every frame.
//
// A bake validity check that remembers ONE handle over one shared layer array re-bakes both of two
// masked handles drawn in a frame, every frame: the full-canvas child draws priced as per-bake
// become per-frame work. The count is read from debugStats.maskBakeCount over 60 steady frames, and
// the picture is checked against a frame drawn with each bundle alone.
//
// THE STATIC CACHE IS OFF (the debug-gated __MANTLE_NO_STATIC_CACHE), because it replays a bundle's
// finished pixels and the bake then never runs at all: with it on, a one-handle check also counts 0.
// The case under test is handles that are NOT statically cached, i.e. anything animating.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 160;
const masked = (fill, cx) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  // TWO shapes in the mask: a single-shape mask is handled inline and never bakes (maskCacheSmoke).
  `<defs><mask id="m"><circle cx="${cx}" cy="60" r="28" fill="#fff"/><circle cx="${cx}" cy="100" r="28" fill="#fff"/></mask></defs>` +
  `<rect x="0" y="0" width="${N}" height="${N}" fill="${fill}" mask="url(#m)"/></svg>`;
const A = masked('#c33', 55),
  B = masked('#33c', 105);
const FRAMES = 60;

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
globalThis.__MANTLE_DEBUG__ = true; globalThis.__MANTLE_NO_STATIC_CACHE = true;
const R = createRenderer(gl, shaders, { aacPoints: false }); if (R.ready) await R.ready;
const read = () => { const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };
window.__run = async (a, b, frames) => {
  const ba = createBundle(gl, await importSvg(a, { preserveViewport: true }));
  const bb = createBundle(gl, await importSvg(b, { preserveViewport: true }));
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  // Warm both, then count bakes over steady frames that draw BOTH.
  for (let i = 0; i < 4; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(ba); R.drawBundle(bb); R.endFrame(); }
  const c0 = R.debugStats.maskBakeCount | 0, warm = c0;
  for (let i = 0; i < frames; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(ba); R.drawBundle(bb); R.endFrame(); }
  const bakes = (R.debugStats.maskBakeCount | 0) - c0;
  const both = read();
  // Reference: each bundle alone, composited by drawing the second over the first's frame once.
  R.beginFrame([1, 1, 1, 1]); R.drawBundle(ba); R.endFrame(); const onlyA = read();
  R.beginFrame([1, 1, 1, 1]); R.drawBundle(bb); R.endFrame(); const onlyB = read();
  let bad = 0, ink = 0; const badPx = [];
  for (let i = 0; i < both.length; i += 4) {
    // Where ONLY A paints, 'both' must equal A alone, and likewise B. The overlap is skipped: there B
    // is drawn over A, which legitimately differs from B over white along B's antialiased edge.
    const aInk = onlyA[i] < 250 || onlyA[i + 1] < 250 || onlyA[i + 2] < 250, bInk = onlyB[i] < 250 || onlyB[i + 1] < 250 || onlyB[i + 2] < 250;
    if (aInk || bInk) ink++;
    // A PIXEL ONLY A PAINTS is one B leaves the white ground on, not one B paints faintly: B's antialiased edge
    // composites over A wherever B has any coverage at all. Judged by the ink threshold instead, B's circles at 2.4%
    // (250 on the red channel, just not "ink") read as B-free, and 'both' -- A under B's faint edge, exactly -- came
    // out 4 levels off A alone on 4 px with Slug's exact edges (a blended edge gives those slivers 0).
    const aAny = onlyA[i] < 255 || onlyA[i + 1] < 255 || onlyA[i + 2] < 255, bAny = onlyB[i] < 255 || onlyB[i + 1] < 255 || onlyB[i + 2] < 255;
    const ref = (bAny && !aAny) ? onlyB : (aAny && !bAny) ? onlyA : null;
    if (ref && (Math.abs(both[i] - ref[i]) > 2 || Math.abs(both[i + 1] - ref[i + 1]) > 2 || Math.abs(both[i + 2] - ref[i + 2]) > 2)) {
      bad++;
      if (badPx.length < 8) { const q = i / 4; badPx.push(\`(\${q % ${N}},\${${N} - 1 - Math.floor(q / ${N})}) both \${[both[i], both[i + 1], both[i + 2]]} A \${[onlyA[i], onlyA[i + 1], onlyA[i + 2]]} B \${[onlyB[i], onlyB[i + 1], onlyB[i + 2]]}\`); }
    }
  }
  return { bakes, bad, ink, warm, badPx, hasCount: typeof R.debugStats.maskBakeCount === 'number' };
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
  const r = await page.evaluate((a, b, f) => window.__run(a, b, f), A, B, FRAMES);
  console.log(
    `  warm-up ${r.warm} bake(s); ${FRAMES} frames drawing two masked bundles: ${r.bakes} bakes, ${r.bad} px off the single-bundle frames, ${r.ink} ink px`,
  );
  if (!r.hasCount) fail('debugStats.maskBakeCount is not reported — the count proves nothing');
  else if (r.warm < 1) fail('the masks never baked at all — the case does not reach the bake path');
  else if (r.ink < 1000) fail('the masked content is nearly blank');
  else {
    if (r.bakes === 0) ok(`no re-bake over ${FRAMES} steady frames (the layers are per handle)`);
    else
      fail(
        `${r.bakes} bakes over ${FRAMES} steady frames — the two handles re-bake each other every frame`,
      );
    if (r.bad === 0) ok('each bundle still draws its own mask');
    else
      fail(
        `${r.bad} px differ from the single-bundle frames — a handle drew another's mask: ${r.badPx.join('; ')}`,
      );
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
console.log('\nmaskBakePerHandleSmoke: masked handles keep their own layers');
