// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbReadyPendingSmoke — awaitLbReady must not resolve while the bundle's off-thread build is in
// flight.
//
// The promise is documented as FULL quality ("the shapes still building would pop from Slug to
// Loop-Blinn after a caller had been told there was nothing left to wait for"). So its settled()
// test asks about a pending worker build first, not only when the bundle holds no real mesh:
// otherwise a bundle already carrying meshes from a prepare-time build or recognized primitives
// resolves while its full build is still running, shapes change after it lands, and a probe
// comparing two build switches reads the same meshes in both arms and reports a real change as a
// no-op.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { example, optionalAsset, PKG_ROOT } from './_assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = [example('smoke/lbMemBudget__SVG.svg'), optionalAsset(example('tiger.svg'))].filter(
  Boolean,
);

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="256" height="256"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__build = async (svg) => {
  R.setFillEngine({ route: 'lb', kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  const ready = R.awaitLbReady ? await R.awaitLbReady(b, 60000) : null;
  const snap = () => (b._lbMeshes || []).map((m) => !m ? 'n' : m.slug ? 's' : m.prim ? 'p' : String(m.vertexCount | 0));
  const pending = b._lbWorkerPendingGen !== undefined, atReady = snap();
  // Let anything still in flight land, draw, and look again.
  for (let i = 0; i < 100 && b._lbWorkerPendingGen !== undefined; i++) await new Promise((r) => setTimeout(r, 100));
  R.setViewport(256, 256); R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
  const settled = snap();
  let moved = 0; for (let s = 0; s < settled.length; s++) if (atReady[s] !== settled[s]) moved++;
  b.dispose && b.dispose();
  return { ready, pending, moved, shapes: settled.length };
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
  for (const file of ASSETS) {
    const name = path.basename(file);
    const o = await page.evaluate((s) => window.__build(s), readFileSync(file, 'utf8'));
    if (o.ready !== true) {
      fail(`${name}: awaitLbReady resolved ${o.ready}, not true — nothing below is evidence`);
      continue;
    }
    if (!o.pending) ok(`${name}: no off-thread build was in flight when awaitLbReady resolved`);
    else fail(`${name}: awaitLbReady resolved while the off-thread build was STILL PENDING`);
    if (o.moved === 0)
      ok(
        `${name}: the meshes it resolved with are the final ones (0 of ${o.shapes} shapes changed after)`,
      );
    else fail(`${name}: ${o.moved} of ${o.shapes} shapes changed after awaitLbReady resolved`);
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
console.log('\nlbReadyPendingSmoke: awaitLbReady resolves with the final meshes');
