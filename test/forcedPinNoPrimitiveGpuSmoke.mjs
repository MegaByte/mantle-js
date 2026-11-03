// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Engine pins control recognized primitives; primitives:'on' restores SDF explicitly.
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const R = 192;

const ring = (cx, cy, r, n) => {
  const P = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    P.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  let d = `M${P[0][0].toFixed(3)} ${P[0][1].toFixed(3)}`;
  for (let i = 0; i < n; i++) {
    const p = P[i],
      q = P[(i + 1) % n],
      mx = (p[0] + q[0]) / 2,
      my = (p[1] + q[1]) / 2;
    d += ` Q${(cx + (mx - cx) * 1.18).toFixed(3)} ${(cy + (my - cy) * 1.18).toFixed(3)} ${q[0].toFixed(3)} ${q[1].toFixed(3)}`;
  }
  return d + ' Z';
};
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">' +
  '<circle cx="34" cy="64" r="26" fill="#000000"/>' +
  `<path d="${ring(96, 64, 26, 16)}" fill="#000000"/></svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${R}" height="${R}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias:false, preserveDrawingBuffer:true, depth:true, stencil:true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const out = {};
// Kernel pins apply to cover rows; explicit primitive permission preserves SDF rows.
for (const [name, fe] of [['auto', { route: 'auto' }], ['none', { route: 'none' }], ['aac', { kernel: 'aac' }], ['lb', { route: 'lb' }], ['cpatch', { route: 'cpatch' }], ['slugK', { kernel: 'slug' }], ['noneOn', { route: 'none', primitives: 'on' }], ['lbOn', { route: 'lb', primitives: 'on' }], ['cpatchOn', { route: 'cpatch', primitives: 'on' }], ['aacOn', { kernel: 'aac', primitives: 'on' }]]) {
  const route = fe.route || 'auto';
  // Permit asynchronous pipeline warming and keep small-shape point routing out of this check.
  const r = createRenderer(gl, shaders, { psoWarmIdle: () => true, aacPoints: false });
  r.setViewport(${R}, ${R});
  // Apply selection before preparation so recognition follows the initial policy.
  r.setFillEngine(fe);
  const b = createBundle(gl, await importSvg(${JSON.stringify(SVG)}));
  r.prepareBundle(b);
  if (r.awaitEngine) { try { await r.awaitEngine(b, route, 30000); } catch {} }
  const paint = () => { r.beginFrame([1,1,1,1]); r.drawBundle(b, {}); r.endFrame(); };
  for (let w = 0; w < 32; w++) paint();
  // Wait for the selected engine, since asynchronous pipelines can outlive a fixed frame count.
  const WANT = { none: 'slug', aac: 'aac', lb: 'lb', cpatch: 'cpatch', slugK: 'slug' };
  const want = fe.primitives === 'on' ? 'sdf' : (name === 'auto' ? 'slug' : WANT[name]);   // router A*: a static bundle under auto is the cover pass (SDF primitives need an explicit primitives:'on')
  const drew = () => (((r.debugStats.engines && r.debugStats.engines.draws) || {})[want] | 0) > 0;
  {
    const t0 = performance.now();
    while (!drew() && performance.now() - t0 < ${pageTimeoutFor(120000)}) {
      paint();
      await new Promise((rr) => setTimeout(rr, 5));
    }
    paint();
  }
  const uni0 = r.debugStats.unifiedFillDraws | 0;
  paint();
  const uni1 = r.debugStats.unifiedFillDraws | 0;
  const px = new Uint8Array(${R} * ${R} * 4);
  gl.readPixels(0, 0, ${R}, ${R}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const at = (x, y) => { const i = ((${R} - 1 - y) * ${R} + x) * 4; return 1 - px[i] / 255; };
  const e = (r.debugStats.engines && r.debugStats.engines.draws) || {};
  out[name] = {
    engines: Object.keys(e).filter((k) => e[k] > 0).sort(),
    uniPerFrame: uni1 - uni0,
    ink: +at(Math.round(${R} * 34 / 128), Math.round(${R} * 64 / 128)).toFixed(3),
  };
  if (name === 'auto' || name === 'lbOn' || name === 'cpatchOn') {
    const peer = createRenderer(gl, shaders, { psoWarmIdle: () => true, aacPoints: false });
    peer.setViewport(${R}, ${R});
    const retained = [], images = [];
    let meshes = b._lbMeshes;   // (router A*: a static bundle under auto builds none until the first primitives:'on' row asks, so the first build is the reference)
    try {
      for (const [renderer, primitives] of [[0, 'on'], [0, 'off'], [0, 'on'], [1, 'off'], [0, 'on'], ...(name === 'auto' ? [[0, false], [0, true]] : [])]) {
        const active = renderer === 0 ? r : peer;
        active.setFillEngine({ route, kernel: name === 'auto' ? 'auto' : 'slug', primitives });
        active.prepareBundle(b);
        if (!meshes) meshes = b._lbMeshes;
        const draw = () => { active.beginFrame([1,1,1,1]); active.drawBundle(b); active.endFrame(); };
        const warm = await active.warmScene([{ name: 'retained-primitive', draw }],
          { maxPasses: 16, fenceTimeoutMs: 20000 });
        const before = { ...active.debugStats.engines.draws };
        draw();
        const after = active.debugStats.engines.draws;
        const image = new Uint8Array(${R} * ${R} * 4);
        gl.readPixels(0, 0, ${R}, ${R}, gl.RGBA, gl.UNSIGNED_BYTE, image);
        images.push(image);
        const center = ((${R} - 1 - Math.round(${R} * 64 / 128)) * ${R} + Math.round(${R} * 34 / 128)) * 4;
        retained.push({ renderer, primitives, complete: warm.complete,
          sdf: (after.sdf || 0) - (before.sdf || 0),
          slug: (after.slug || 0) - (before.slug || 0), aac: (after.aac || 0) - (before.aac || 0),
          ink: 1 - image[center] / 255, sameMeshes: b._lbMeshes === meshes, error: gl.getError() });
      }
      const difference = (a, b) => {
        let max = 0;
        for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
        return max;
      };
      out[name].retained = { rows: retained,
        restored: difference(images[0], images[2]), sharedRestored: difference(images[0], images[4]),
        offShared: difference(images[1], images[3]) };
    } finally { peer.dispose(); }
  }
  b.dispose && b.dispose();
  r.dispose();
}
window.__out = out;
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

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
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 20000 });
  // Headless pages can suspend animation frames; poll readiness with a timer.
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const o = await page.evaluate(() => window.__out);
await browser.close();
server.close();
console.log('  ', JSON.stringify(o));

const has = (n, k) => o[n] && o[n].engines.includes(k);
const chk = (c, m) => (c ? ok(m) : fail(m + ' -- engines ' + JSON.stringify(o)));
chk(
  !has('auto', 'sdf') && has('auto', 'slug') && o.auto.uniPerFrame === 0,
  "auto: a static bundle draws the cover pass (no unified stream, no SDF mesh unless primitives:'on' is asked)",
);
const PIN = { none: 'slug', aac: 'aac', lb: 'lb', cpatch: 'cpatch', slugK: 'slug' };
for (const [n, eng] of Object.entries(PIN)) {
  chk(!has(n, 'sdf'), `pin ${n}: no sdf draw`);
  chk(has(n, eng), `pin ${n}: drawn by ${eng}`);
  chk(o[n] && o[n].ink > 0.9, `pin ${n}: circle is filled (${o[n] && o[n].ink})`);
}
for (const n of ['noneOn', 'lbOn', 'cpatchOn', 'aacOn'])
  chk(has(n, 'sdf'), `${n}: primitives:'on' restores sdf under the pin`);
for (const n of ['auto', 'lbOn', 'cpatchOn']) {
  const retained = o[n] && o[n].retained;
  chk(!!retained, n + ': retained policy results are present');
  if (!retained) continue;
  chk(
    retained.rows.every(
      (row) => row.complete && row.sameMeshes && row.error === 0 && row.ink > 0.9,
    ),
    n + ': policy changes retain prepared geometry and filled pixels',
  );
  chk(
    retained.rows.every((row) =>
      row.primitives === 'on' || row.primitives === true
        ? row.sdf > 0
        : row.sdf === 0 && row.slug + row.aac > 0,
    ),
    n + ': retained SDF obeys each renderer policy',
  );
  chk(
    retained.restored === 0 && retained.sharedRestored === 0 && retained.offShared === 0,
    n + ': same-bundle policy restoration and shared-renderer images are exact',
  );
}
console.log('\nforcedPinNoPrimitiveSmoke');
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
