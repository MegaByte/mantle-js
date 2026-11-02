// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// compositingGroupRenderSmoke -- the compositing rules that change PIXELS, on the GPU (mask on a group, markers under
// the element's opacity, filter and mask and the <marker>'s own opacity, context-fill / context-stroke; the record-level proofs are
// test/compositingGroupSmoke.mjs).
//
// Each cell renders three documents with the renderer at 128 px (64-unit viewBox, white ground), as importerGeometryAuditRenderSmoke does:
//   svg      the document under test, written with the feature under test;
//   control  the same picture authored with features that do not depend on the rule (a group's opacity or filter standing for a uniform mask, an
//            explicit paint standing for a context paint): the render must match it to within `tol` (default 2/255);
//   old      what the defect draws, authored literally (each leaf masked on its own, an opaque marker, a black marker): the render must
//            DIFFER from it by at least 48/255 somewhere, so a pass cannot be a picture the defect also draws.
// Probes are the analytic expectation (a stated point reads a stated color), independent of both documents.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
const WHITE = [255, 255, 255];
const G = 128 / 255; // the opacity a uniform #808080 mask stands for
const MASK = '<mask id="m"><rect width="64" height="64" fill="#808080"/></mask>';
const MASK_US =
  '<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#808080"/></mask>';
const CYAN = (extra = '') => `<rect x="4" y="4" width="40" height="40" fill="#0cf" ${extra}/>`;
const PINK = (extra = '') => `<rect x="20" y="20" width="40" height="40" fill="#f0c" ${extra}/>`;
const TWO = CYAN() + PINK();
const TWO_LEAF_MASKED = CYAN('mask="url(#m)"') + PINK('mask="url(#m)"');
const MARK = (attrs = '', inner = '<circle cx="5" cy="5" r="5" fill="#f00"/>') =>
  `<marker id="k" markerWidth="10" markerHeight="10" refX="5" refY="5" markerUnits="userSpaceOnUse" ${attrs}>${inner}</marker>`;
const PATH = (attrs = '', markers = true) =>
  `<path d="M8 32 H56" stroke="#00f" stroke-width="8" fill="none" ${markers ? 'marker-start="url(#k)" marker-end="url(#k)"' : ''} ${attrs}/>`;
const DOTS =
  '<circle cx="8" cy="32" r="5" fill="#f00"/><circle cx="56" cy="32" r="5" fill="#f00"/>';
const SAT =
  '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB"><feColorMatrix type="saturate" values="0"/></filter>';
const over = (rgb, a, under = WHITE) => rgb.map((c, i) => c * a + under[i] * (1 - a));

const CELLS = [
  {
    name: 'uniform gray mask over two overlapping opaque rects',
    svg: doc(`${MASK}<g mask="url(#m)">${TWO}</g>`),
    control: doc(`<g opacity="${G}">${TWO}</g>`),
    old: doc(`${MASK}${TWO_LEAF_MASKED}`),
    probes: [
      [30, 30, over([255, 0, 204], G), 3],
      [10, 10, over([0, 204, 255], G), 3],
      [55, 55, over([255, 0, 204], G), 3],
      [62, 2, WHITE, 1],
    ],
  },
  {
    name: 'gradient fade mask over two overlapping opaque rects',
    svg: doc(
      `<linearGradient id="g" x2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><mask id="m"><rect width="64" height="64" fill="url(#g)"/></mask><g mask="url(#m)">${TWO}</g>`,
    ),
    control: doc(
      `<linearGradient id="g" x2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><mask id="m"><rect width="64" height="64" fill="url(#g)"/></mask><filter id="i" filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64" color-interpolation-filters="sRGB"><feOffset dx="0"/></filter><g filter="url(#i)" mask="url(#m)">${TWO}</g>`,
    ),
    old: doc(
      `<linearGradient id="g" x2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></linearGradient><mask id="m"><rect width="64" height="64" fill="url(#g)"/></mask>${TWO_LEAF_MASKED}`,
    ),
    tol: 4,
    probes: [
      [30.25, 30, over([255, 0, 204], 1 - 30.25 / 64), 4],
      [40.25, 30, over([255, 0, 204], 1 - 40.25 / 64), 4],
    ],
  },
  {
    name: 'mask plus group opacity: one group, both applied once',
    svg: doc(`${MASK}<g mask="url(#m)" opacity=".5">${TWO}</g>`),
    control: doc(`<g opacity="${G * 0.5}">${TWO}</g>`),
    old: doc(`${MASK}<g opacity=".5">${TWO_LEAF_MASKED}</g>`),
    minOld: 24, // the defect picture differs from this one only by the overlap's second masking (32 here)
    probes: [[30, 30, over([255, 0, 204], G * 0.5), 3]],
  },
  {
    name: 'nested group masks multiply',
    svg: doc(
      `${MASK}<mask id="m2"><rect width="64" height="64" fill="#808080"/></mask><g mask="url(#m)"><g mask="url(#m2)">${TWO}</g></g>`,
    ),
    control: doc(`<g opacity="${G}"><g opacity="${G}">${TWO}</g></g>`),
    old: doc(
      `<mask id="m2"><rect width="64" height="64" fill="#808080"/></mask>${CYAN('mask="url(#m2)"')}${PINK('mask="url(#m2)"')}`,
    ),
    probes: [[30, 30, over([255, 0, 204], G * G), 3]],
  },
  {
    name: 'mask on a <use>',
    svg: doc(`${MASK}<defs><g id="u">${TWO}</g></defs><use href="#u" mask="url(#m)"/>`),
    control: doc(`<defs><g id="u">${TWO}</g></defs><use href="#u" opacity="${G}"/>`),
    old: doc(`${MASK}${TWO_LEAF_MASKED}`),
    probes: [[30, 30, over([255, 0, 204], G), 3]],
  },
  {
    name: 'mask and clip-path on one group',
    svg: doc(
      `${MASK}<clipPath id="c"><rect width="50" height="50"/></clipPath><g mask="url(#m)" clip-path="url(#c)">${TWO}</g>`,
    ),
    control: doc(
      `<clipPath id="c"><rect width="50" height="50"/></clipPath><g clip-path="url(#c)" opacity="${G}">${TWO}</g>`,
    ),
    old: doc(
      `${MASK}<clipPath id="c"><rect width="50" height="50"/></clipPath><g clip-path="url(#c)">${TWO_LEAF_MASKED}</g>`,
    ),
    probes: [
      [30, 30, over([255, 0, 204], G), 3],
      [55, 55, WHITE, 1],
    ],
  },
  {
    name: 'a fill and a stroke under one mask (region = the box, objectBoundingBox)',
    svg: doc(
      `${MASK}<rect x="12" y="12" width="40" height="40" fill="#0cf" stroke="#f0c" stroke-width="16" mask="url(#m)"/>`,
    ),
    control: doc(
      `<clipPath id="c"><rect x="8" y="8" width="48" height="48"/></clipPath><g clip-path="url(#c)" opacity="${G}"><rect x="12" y="12" width="40" height="40" fill="#0cf" stroke="#f0c" stroke-width="16"/></g>`,
    ),
    old: doc(
      `${MASK}<rect x="12" y="12" width="40" height="40" fill="#0cf" mask="url(#m)"/><rect x="12" y="12" width="40" height="40" fill="none" stroke="#f0c" stroke-width="16" mask="url(#m)"/>`,
    ),
    probes: [
      [16, 30, over([255, 0, 204], G), 3],
      [30, 30, over([0, 204, 255], G), 3],
      [6, 30, WHITE, 1],
    ],
  },
  {
    name: 'a marker takes the path opacity',
    svg: doc(MARK() + PATH('opacity=".5"')),
    control: doc(`<g opacity=".5">${MARK()}${PATH()}</g>`),
    old: doc(PATH('opacity=".5"', false) + DOTS),
    probes: [
      [8, 32, over([255, 0, 0], 0.5), 2],
      [30, 32, over([0, 0, 255], 0.5), 2],
    ],
  },
  {
    name: 'a marker takes the path filter',
    svg: doc(SAT + MARK() + PATH('filter="url(#f)"')),
    control: doc(`${SAT}${MARK()}<g filter="url(#f)">${PATH()}</g>`),
    old: doc(SAT + PATH('filter="url(#f)"', false) + DOTS),
    tol: 3,
    probes: [
      [8, 32, [54, 54, 54], 3],
      [30, 32, [18, 18, 18], 3],
    ],
  },
  {
    name: 'a marker takes the path mask (stroke and marker mask once)',
    svg: doc(MASK_US + MARK() + PATH('mask="url(#m)"')),
    control: doc(`${MARK()}<g opacity="${G}">${PATH()}</g>`),
    old: doc(
      MASK_US +
        PATH('mask="url(#m)"', false) +
        `<circle cx="8" cy="32" r="5" fill="#f00" mask="url(#m)"/><circle cx="56" cy="32" r="5" fill="#f00" mask="url(#m)"/>`,
    ),
    probes: [
      [8, 32, over([255, 0, 0], G), 3],
      [30, 32, over([0, 0, 255], G), 3],
    ],
  },
  {
    name: 'the <marker> opacity',
    svg: doc(MARK('opacity=".5"') + PATH()),
    control: doc(MARK('', '<circle cx="5" cy="5" r="5" fill="#f00" fill-opacity=".5"/>') + PATH()),
    old: doc(MARK() + PATH()),
    probes: [
      [8, 27.5, over([255, 0, 0], 0.5), 2],
      [8, 32, over([255, 0, 0], 0.5, [0, 0, 255]), 2],
    ],
  },
  {
    name: 'context-stroke in a marker',
    svg: doc(MARK('', '<circle cx="5" cy="5" r="5" fill="context-stroke"/>') + PATH()),
    control: doc(MARK('', '<circle cx="5" cy="5" r="5" fill="#00f"/>') + PATH()),
    old: doc(MARK('', '<circle cx="5" cy="5" r="5" fill="#000"/>') + PATH()),
    probes: [
      [8, 27.5, [0, 0, 255], 2],
      [56, 27.5, [0, 0, 255], 2],
    ],
  },
  {
    name: 'context-fill in a marker',
    svg: doc(
      MARK('', '<circle cx="5" cy="5" r="5" fill="context-fill"/>') +
        '<path d="M12 12 L52 12 L32 52 Z" fill="#a0a" stroke="#00f" stroke-width="2" marker-start="url(#k)" marker-end="url(#k)"/>',
    ),
    // (a transform on the control's circle puts it on the walked path too, which clips a marker to its viewport as the svg's does)
    control: doc(
      MARK('', '<circle cx="5" cy="5" r="5" fill="#a0a" transform="translate(0 0)"/>') +
        '<path d="M12 12 L52 12 L32 52 Z" fill="#a0a" stroke="#00f" stroke-width="2" marker-start="url(#k)" marker-end="url(#k)"/>',
    ),
    old: doc(
      MARK('', '<circle cx="5" cy="5" r="5" fill="#000"/>') +
        '<path d="M12 12 L52 12 L32 52 Z" fill="#a0a" stroke="#00f" stroke-width="2" marker-start="url(#k)" marker-end="url(#k)"/>',
    ),
    probes: [
      [12, 12, [170, 0, 170], 2],
      [32, 30, [170, 0, 170], 2],
    ],
  },
  {
    name: 'context-fill and context-stroke in a <use> instance',
    svg: doc(
      '<defs><rect id="r" width="30" height="30" fill="context-fill" stroke="context-stroke" stroke-width="6"/></defs><use href="#r" x="10" y="10" fill="#f80" stroke="#08f"/>',
    ),
    control: doc(
      '<rect x="10" y="10" width="30" height="30" fill="#f80" stroke="#08f" stroke-width="6"/>',
    ),
    old: doc(
      '<rect x="10" y="10" width="30" height="30" fill="#000" stroke="#000" stroke-width="6"/>',
    ),
    probes: [
      [25, 25, [255, 136, 0], 2],
      [10, 25, [0, 136, 255], 2],
    ],
  },
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { paint, viewport } from '/test/_auditPaintCases.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__render = async (sources) => {
  viewport(gl, R); R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const out = [];
  for (const s of sources) {
    const b = createBundle(gl, await importSvg(s, { preserveViewport: true }));
    out.push(Array.from(await paint(gl, R, b))); b.dispose();
  }
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
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const at = (px, x, y) => {
  const i = ((127 - Math.floor(y * 2)) * 128 + Math.floor(x * 2)) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const inkOf = (px) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) n++;
  return n;
};
for (const c of CELLS) {
  let px;
  try {
    px = await page.evaluate((s) => window.__render(s), [c.svg, c.control, c.old]);
  } catch (e) {
    fail(c.name + ': ' + e.message);
    continue;
  }
  const [a, b, o] = px;
  const vsControl = maxDiff(a, b),
    vsOld = maxDiff(a, o);
  const bad = c.probes
    .filter(([x, y, want, tol]) => maxDiff(at(a, x, y), want) > tol)
    .map(([x, y, want]) => `(${x},${y}) is [${at(a, x, y)}], wanted [${want}]`);
  const line = `${c.name}: control maxByte ${vsControl}, old differs by ${vsOld}, ink px svg ${inkOf(a)} / control ${inkOf(b)} / old ${inkOf(o)}`;
  if (vsControl > (c.tol ?? 2)) fail(line + ' -- render differs from its control');
  else if (vsOld < (c.minOld ?? 48)) fail(line + ' -- vacuous: the defect picture is the same');
  else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
  else ok(line);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\ncompositingGroupRenderSmoke: mask groups, marker groups and context paints render as their controls on the GPU',
);
