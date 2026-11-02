// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacPointsRowGateDefaultSmoke -- default-on: a plain `createRenderer(gl, shaders)` (no options, no pins) draws dense content (thousands of
// 1-2 px rows, depth 1) through the AAC point route, because the ROW gate takes the draw the whole-bundle gate declines (P ~100k over its 90,000 base);
// every override works: aacPointsRowGate:false (and setFillPolicyOptions) returns it to the cover quads, a setFillEngine pin keeps its engine, and the
// effective options are readable (getFillPolicyOptions, debugStats.fillPolicy).
import http from 'http';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const N = 128;
function blobs() {
  let out = '';
  for (let j = 0; j < 72; j++)
    for (let i = 0; i < 70; i++) {
      const x = i + 0.05,
        y = j + 0.05;
      out += `<path fill="#${((i * 37 + j * 91) % 4096).toString(16).padStart(3, '0')}" d="M${x} ${y + 0.45}c0 -0.35 0.2 -0.45 0.45 -0.45s0.45 0.1 0.45 0.45s-0.2 0.45 -0.45 0.45s-0.45 -0.1 -0.45 -0.45z"/>`;
    }
  return out;
}
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 70 72">${blobs()}</svg>`;
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sec = await importSvg(${JSON.stringify(SVG)}, { preserveViewport: true });
window.__draw = (opts, pin, patch) => {
  const r = createRenderer(gl, shaders, opts);
  if (pin) r.setFillEngine(pin);
  if (patch) r.setFillPolicyOptions(patch);
  r.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  const b = createBundle(gl, sec); r.prewarmBundle(b); r.precompileFills();   // the loading call: the point program is finished there, not at the first draw
  const policy = r.getFillPolicyOptions();
  r.beginFrame([0, 0, 0, 0]); r.drawBundle(b); r.endFrame();
  const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const st = r.debugStats || {};
  const via = (st.engines && st.engines.viaRoute) || {};
  let ink = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 8) ink++;
  const stats = { fillPolicy: st.fillPolicy || null, rowGatePlan: st.rowGatePlan || null };
  b.dispose && b.dispose(); r.dispose && r.dispose();
  return { px: Array.from(px), via, ink, policy, stats };
};
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
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.error('  [console]', m.text());
});
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
} catch (e) {
  fail('setup: ' + e.message);
  await browser.close();
  server.close();
  process.exit(1);
}

const draw = (opts, pin, patch) =>
  page.evaluate((o, p, q) => window.__draw(o, p, q), opts, pin, patch);
const points = (v) =>
  Object.entries(v).reduce((n, [k, c]) => n + (k.endsWith('@points') ? c | 0 : 0), 0);
const diff = (a, b) => {
  let mx = 0;
  for (let i = 0; i < a.px.length; i++) mx = Math.max(mx, Math.abs(a.px[i] - b.px[i]));
  return mx;
};

const D = await draw({});
if (points(D.via) > 0)
  ok(
    `default createRenderer draws dens-like content on the point route (${JSON.stringify(D.via)})`,
  );
else fail(`default draw did not take the point route: ${JSON.stringify(D.via)}`);
if (D.ink > 500) ok(`...with ink (${D.ink} px)`);
else fail(`default draw is nearly blank (${D.ink} px)`);
const want = {
  aacPointsRowGate: true,
  aacPointsExtMax: 30,
  aacPointsRowsMin: 128,
  lbMinExtentPx: 8,
  lbMinExtentShare: 0.1,
};
const bad = Object.entries(want).filter(([k, v]) => D.policy[k] !== v);
if (!bad.length) ok(`getFillPolicyOptions shows the defaults (${JSON.stringify(D.policy)})`);
else fail(`defaults differ: ${JSON.stringify(bad)} of ${JSON.stringify(D.policy)}`);
if (D.stats.fillPolicy && D.stats.fillPolicy.lbMinExtentPx === 8)
  ok('debugStats.fillPolicy carries them');
else fail(`debugStats.fillPolicy: ${JSON.stringify(D.stats.fillPolicy)}`);

const OFF = await draw({ aacPointsRowGate: false });
if (points(OFF.via) === 0)
  ok(
    `aacPointsRowGate:false returns the draw to the whole-bundle gate (${JSON.stringify(OFF.via)})`,
  );
else fail(`aacPointsRowGate:false still took points: ${JSON.stringify(OFF.via)}`);
const PATCH = await draw({}, null, { aacPointsRowGate: false });
if (points(PATCH.via) === 0 && PATCH.policy.aacPointsRowGate === false)
  ok('setFillPolicyOptions({aacPointsRowGate:false}) overrides at run time');
else
  fail(
    `setFillPolicyOptions did not override: ${JSON.stringify(PATCH.via)} ${JSON.stringify(PATCH.policy)}`,
  );
const PIN = await draw({}, { route: 'none', kernel: 'slug' });
if (points(PIN.via) === 0 && (PIN.via['slug@cover'] | 0) > 0)
  ok(`a setFillEngine pin keeps its engine (${JSON.stringify(PIN.via)})`);
else fail(`a pin did not keep its engine: ${JSON.stringify(PIN.via)}`);
const mx = diff(D, OFF);
if (mx <= 24 && Math.abs(D.ink - OFF.ink) <= Math.max(8, D.ink * 0.01))
  ok(`points match the cover quads within rounding (max ${mx}, ink ${D.ink} vs ${OFF.ink})`);
else fail(`points differ from cover: max ${mx}, ink ${D.ink} vs ${OFF.ink}`);

await browser.close();
server.close();
if (failures) {
  console.error(`aacPointsRowGateDefaultSmoke: ${failures} failure(s)`);
  process.exit(1);
}
console.log(
  'aacPointsRowGateDefaultSmoke: the default renderer takes the row gate; options and pins override it',
);
