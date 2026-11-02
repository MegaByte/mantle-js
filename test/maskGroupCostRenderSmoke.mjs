// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// maskGroupCostRenderSmoke -- keeping a masked group's passes inside its painted rect changes NO pixel. Each cell renders the
// same masked-group document twice on the GPU (128 px, white ground):
//   default       the passes scissored to the group's rect (what ships);
//   full-canvas   __MANTLE_NO_GROUP_RECT: the canvas-sized accumulator, masked copy and composite, the reference;
// and requires byte-for-byte equality. A cell is vacuous when the mask does nothing, so each also has to paint non-binary mask values.
// (pass counts and scissors: maskGroupCostSmoke, on the fake GL; the picture against Chrome: compositingGroupRenderSmoke.)
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Two dots outside the group keep the content box (which the renderer fits to the canvas) much larger than the group's own rect.
const DOTS = '<circle cx="3" cy="3" r="2" fill="#333"/><circle cx="61" cy="61" r="2" fill="#333"/>';
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}${DOTS}</svg>`;
const GRAD =
  '<linearGradient id="g" x2="1"><stop offset="0" stop-color="#fff"/><stop offset=".5" stop-color="#777"/><stop offset="1" stop-color="#000"/></linearGradient>';
const RAD =
  '<radialGradient id="r"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#222"/></radialGradient>';
const MASK = `${GRAD}<mask id="m"><rect x="8" y="8" width="40" height="40" fill="url(#g)"/></mask>`;
const MASK2 = `${RAD}<mask id="m2"><circle cx="30" cy="30" r="22" fill="url(#r)"/></mask>`;
const MASKA =
  '<mask id="ma" mask-type="alpha"><circle cx="28" cy="28" r="20" fill="#000" fill-opacity=".6"/><rect x="26" y="26" width="26" height="26" fill="#000" fill-opacity=".35"/></mask>';
const LEAVES =
  '<rect x="10" y="10" width="26" height="26" fill="#0cf" fill-opacity=".8"/><circle cx="30" cy="30" r="14" fill="#f0c" fill-opacity=".7"/><path d="M12 40 Q30 20 48 44 L20 50Z" fill="#fa0" stroke="#033" stroke-width="3" stroke-opacity=".5"/>';
// every (alpha, mask) pair across a 56 x 56 px field: a wide spread of 8-bit products, where a rounding step that moved would show
const RAMP =
  '<linearGradient id="gx" x2="1"><stop offset="0" stop-color="#e22" stop-opacity="0"/><stop offset="1" stop-color="#e22"/></linearGradient>' +
  '<linearGradient id="gy" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient>' +
  '<mask id="mr"><rect x="4" y="4" width="56" height="56" fill="url(#gy)"/></mask>';
const CELLS = [
  [
    'alpha ramp x mask ramp',
    doc(
      `${RAMP}<g mask="url(#mr)"><rect x="4" y="4" width="56" height="56" fill="url(#gx)"/><circle cx="32" cy="32" r="18" fill="#26f" fill-opacity=".45"/></g>`,
    ),
  ],
  [
    'gradient mask over translucent overlapping leaves',
    doc(`${MASK}<g mask="url(#m)">${LEAVES}</g>`),
  ],
  [
    'radial mask, group translated',
    doc(`${MASK2}<g transform="translate(3 2)" mask="url(#m2)">${LEAVES}</g>`),
  ],
  ['alpha-type mask', doc(`${MASKA}<g mask="url(#ma)">${LEAVES}</g>`)],
  [
    'mask + group opacity (masked copy path)',
    doc(`${MASK}<g mask="url(#m)" opacity=".6">${LEAVES}</g>`),
  ],
  [
    'nested masks',
    doc(
      `${MASK}${MASK2}<g mask="url(#m)"><g mask="url(#m2)">${LEAVES}</g><rect x="30" y="8" width="14" height="14" fill="#06f"/></g>`,
    ),
  ],
  [
    'mask on a <use>',
    doc(`${MASK}<defs><g id="u">${LEAVES}</g></defs><use href="#u" mask="url(#m)"/>`),
  ],
  [
    'group over a painted ground',
    doc(
      `${MASK}<rect x="0" y="30" width="64" height="12" fill="#c33"/><g mask="url(#m)">${LEAVES}</g>`,
    ),
  ],
  [
    'mask and clip-path on one group',
    doc(
      `${MASK}<clipPath id="c"><rect x="0" y="0" width="40" height="40"/></clipPath><g mask="url(#m)" clip-path="url(#c)">${LEAVES}</g>`,
    ),
  ],
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // the kill switch is read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { paint, viewport } from '/test/_auditPaintCases.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__render = async (source) => {
  viewport(gl, R); R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const out = [];
  for (const noRect of [false, true]) {
    globalThis.__MANTLE_NO_GROUP_RECT = noRect;
    const b = createBundle(gl, await importSvg(source, { preserveViewport: true }));
    out.push(Array.from(await paint(gl, R, b))); b.dispose();
  }
  globalThis.__MANTLE_NO_GROUP_RECT = false;
  return out;
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
const { launchBrowser } = await import('./_launch.mjs');
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
let failures = 0;
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const partial = (px) => {
  const s = new Set();
  for (let i = 0; i < px.length; i += 4) if (px[i] > 20 && px[i] < 235) s.add(px[i]);
  return s.size;
};
for (const [name, svg] of CELLS) {
  let r;
  try {
    r = await page.evaluate((s) => window.__render(s), svg);
  } catch (e) {
    failures++;
    console.error(`FAIL: ${name}: ${e.message}`);
    continue;
  }
  const [def, merged] = r;
  const d1 = maxDiff(def, merged),
    levels = partial(def);
  const line = `${name}: default vs full-canvas maxByte ${d1}, ${levels} partial-coverage levels`;
  if (d1 !== 0) {
    failures++;
    console.error('FAIL: ' + line);
  } else if (levels < 24) {
    failures++;
    console.error('FAIL: ' + line + ' -- vacuous: the mask paints no gradation');
  } else console.log('ok ' + line);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nmaskGroupCostRenderSmoke: the group rect draws the full-canvas picture byte for byte',
);
