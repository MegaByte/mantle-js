// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importerSemanticsRenderSmoke -- the importer-semantics rules that change PIXELS, on the GPU (the
// record-level proofs are test/svg/*ImportSmoke.mjs; this is the rendered check of them).
//
// Each cell renders three documents with the renderer at 128 px (64-unit viewBox, white ground):
//   svg      the document under test, written with the feature under test;
//   control  the same picture authored without that feature (attributes, explicit
//            values, separate paths): the render must match it to within 1/255 on every channel;
//   old      the picture without the rule, authored literally (a black flood, 16 px for 1em, a missing marker,
//            no width override ...): the render must DIFFER from svg by at least 48/255 somewhere, so a pass cannot be
//            a picture an importer without the rule also draws.
// Probes are the analytic expectation: a stated point of the 64-unit space must read a stated color. They pin ink to
// the places it belongs (and its absence to the places it does not), independent of both documents.
//
// Cells: flood color and opacity from style; radial focus defaults to the child's own cx; marker orient angle units,
// mid markers at later movetos, the marker shorthand; a zero-size filter region paints nothing; paint fallback, invalid
// declaration dropped, <use> size override on an <svg>; em in stroke widths.
//
// `--cpu` runs the same cells GL-free (import all three documents, report whether the records agree) to debug them.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
const WHITE = [255, 255, 255],
  RED = [255, 0, 0],
  LIME = [0, 255, 0],
  BLUE = [0, 0, 255],
  BLACK = [0, 0, 0];

// ---- flood-color / flood-opacity from style ---------------------------------------------------------------
const floodDoc = (prim) =>
  doc(
    `<defs><filter id="f" x="0" y="0" width="1" height="1">${prim}</filter></defs><rect x="8" y="8" width="48" height="48" fill="blue" filter="url(#f)"/>`,
  );
const shadowDoc = (prim) =>
  doc(
    `<defs><filter id="f" x="-.5" y="-.5" width="2" height="2">${prim}</filter></defs><rect x="16" y="16" width="24" height="24" fill="lime" filter="url(#f)"/>`,
  );
// ---- the child sets only cx; fx/fy default to the child's own cx/cy -------------------------------------------
const STOPS = '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>';
const radial = (defs) =>
  doc(`<defs>${defs}</defs><rect x="8" y="8" width="48" height="48" fill="url(#g)"/>`);
// ---- markers --------------------------------------------------------------------------------------------
// A 6x3 red bar in user units, centered on its vertex: orient 90 stands it up (3 wide, 6 tall).
const marker = (orient) =>
  `<marker id="m" markerUnits="userSpaceOnUse" markerWidth="6" markerHeight="6" refX="3" refY="1.5" orient="${orient}"><rect width="6" height="3" fill="red"/></marker>`;
const stroked = (d, extra) =>
  `<path d="${d}" fill="none" stroke="black" stroke-width="1" ${extra}/>`;
const ALL = 'marker-start="url(#m)" marker-mid="url(#m)" marker-end="url(#m)"';
// ---- a zero-size filter region -------------------------------------------------------------------------------
const regionDoc = (attrs, target) =>
  doc(`<defs><filter id="f" ${attrs}><feFlood flood-color="red"/></filter></defs>${target}`);
const SHAPE = '<rect x="8" y="8" width="48" height="48" fill="blue" filter="url(#f)"/>';
const GROUP =
  '<g filter="url(#f)"><rect x="8" y="8" width="20" height="48" fill="blue"/><circle cx="42" cy="32" r="14" fill="blue"/></g>';
// ---- <use> of an <svg> with a size override --------------------------------------------------------------------
const NEST = (attrs) =>
  `<svg ${attrs} viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/><rect width="5" height="5" fill="blue"/></svg>`;
// ---- em ---------------------------------------------------------------------------------------------------------
const dashed = (sw, da) =>
  doc(
    `<g font-size="20"><path d="M8 20 L56 20" fill="none" stroke="black" stroke-width="${sw}" stroke-dasharray="${da}"/></g>`,
  );

const flood = (attrs) => floodDoc(`<feFlood ${attrs}/>`);
const FLOOD_HALF = [127.5, 255, 127.5]; // lime at 0.5 over white
const CELLS = [
  {
    name: 'feFlood style color and percent opacity',
    svg: flood('style="flood-color:lime;flood-opacity:50%"'),
    control: flood('flood-color="lime" flood-opacity="0.5"'),
    old: flood('flood-color="black" flood-opacity="1"'),
    probes: [
      [32, 32, FLOOD_HALF, 3],
      [4, 4, WHITE, 1],
    ],
  },
  {
    name: 'feDropShadow style flood-color',
    svg: shadowDoc('<feDropShadow dx="6" dy="6" stdDeviation="0" style="flood-color:red"/>'),
    control: shadowDoc('<feDropShadow dx="6" dy="6" stdDeviation="0" flood-color="red"/>'),
    old: shadowDoc('<feDropShadow dx="6" dy="6" stdDeviation="0" flood-color="black"/>'),
    probes: [
      [43, 43, RED, 3],
      [28, 28, LIME, 3],
      [4, 4, WHITE, 1],
    ],
  },
  {
    name: 'radial focus defaults to the child cx',
    svg: radial(
      `<radialGradient id="p" r=".5">${STOPS}</radialGradient><radialGradient id="g" href="#p" cx=".8"/>`,
    ),
    control: radial(
      `<radialGradient id="g" cx=".8" cy=".5" fx=".8" fy=".5" r=".5">${STOPS}</radialGradient>`,
    ),
    old: radial(
      `<radialGradient id="g" cx=".8" cy=".5" fx=".5" fy=".5" r=".5">${STOPS}</radialGradient>`,
    ),
    probes: [
      [46.4, 32, RED, 10],
      [4, 4, WHITE, 1],
    ],
  },
  {
    name: 'marker orient="90deg"',
    svg: doc(`<defs>${marker('90deg')}</defs>` + stroked('M10 20 L50 20', 'marker-end="url(#m)"')),
    control: doc(`<defs>${marker('90')}</defs>` + stroked('M10 20 L50 20', 'marker-end="url(#m)"')),
    old: doc(`<defs>${marker('1.57')}</defs>` + stroked('M10 20 L50 20', 'marker-end="url(#m)"')),
    probes: [
      [50, 22.5, RED, 3],
      [52.5, 20, WHITE, 3],
    ],
  },
  {
    name: 'mid markers at a later moveto',
    svg: doc(`<defs>${marker('0')}</defs>` + stroked('M10 10 L50 10 M10 30 L50 30', ALL)),
    control: doc(
      `<defs>${marker('0')}</defs>` +
        stroked('M10 10 L50 10', 'marker-start="url(#m)" marker-end="url(#m)"') +
        stroked('M10 30 L50 30', 'marker-start="url(#m)" marker-end="url(#m)"'),
    ),
    old: doc(
      `<defs>${marker('0')}</defs>` +
        stroked('M10 10 L50 10', 'marker-start="url(#m)" marker-end="url(#m)"') +
        stroked('M10 30 L50 30', 'marker-end="url(#m)"'),
    ),
    probes: [
      [10, 11, RED, 3],
      [50, 11, RED, 3],
      [10, 31, RED, 3],
      [50, 31, RED, 3],
      [30, 20, WHITE, 3],
    ],
  },
  {
    name: 'marker shorthand in style',
    svg: doc(
      `<defs>${marker('0')}</defs>` + stroked('M10 50 L30 50 L50 50', 'style="marker:url(#m)"'),
    ),
    control: doc(`<defs>${marker('0')}</defs>` + stroked('M10 50 L30 50 L50 50', ALL)),
    old: doc(`<defs>${marker('0')}</defs>` + stroked('M10 50 L30 50 L50 50', '')),
    probes: [
      [10, 51, RED, 3],
      [30, 51, RED, 3],
      [50, 51, RED, 3],
    ],
  },
  {
    name: 'filter width="0" on a shape',
    svg: regionDoc('width="0"', SHAPE),
    control: doc(''),
    old: regionDoc('width="1"', SHAPE),
    probes: [
      [32, 32, WHITE, 1],
      [10, 10, WHITE, 1],
    ],
  },
  {
    name: 'filter height="0" on a shape',
    svg: regionDoc('height="0"', SHAPE),
    control: doc(''),
    old: regionDoc('height="1"', SHAPE),
    probes: [
      [32, 32, WHITE, 1],
      [10, 10, WHITE, 1],
    ],
  },
  {
    name: 'filter width="0" on a group',
    svg: regionDoc('width="0"', GROUP),
    control: doc(''),
    old: regionDoc('width="1"', GROUP),
    probes: [
      [18, 32, WHITE, 1],
      [42, 32, WHITE, 1],
    ],
  },
  {
    name: 'paint fallback after a missing url()',
    svg: doc('<rect x="8" y="8" width="48" height="48" fill="url(#missing) lime"/>'),
    control: doc('<rect x="8" y="8" width="48" height="48" fill="lime"/>'),
    old: doc('<rect x="8" y="8" width="48" height="48" fill="black"/>'),
    probes: [
      [32, 32, LIME, 1],
      [4, 4, WHITE, 1],
    ],
  },
  {
    name: 'invalid declaration dropped',
    svg: doc('<rect x="8" y="8" width="48" height="48" style="fill:blue;fill:bogus"/>'),
    control: doc('<rect x="8" y="8" width="48" height="48" fill="blue"/>'),
    old: doc('<rect x="8" y="8" width="48" height="48" fill="black"/>'),
    probes: [
      [32, 32, BLUE, 1],
      [4, 4, WHITE, 1],
    ],
  },
  {
    name: 'use of an svg takes the width/height override',
    svg: doc(
      `<defs>${NEST('id="s" width="20" height="20"')}</defs><use href="#s" x="10" y="10" width="40" height="40"/>`,
    ),
    control: doc(NEST('x="10" y="10" width="40" height="40"')),
    old: doc(NEST('x="10" y="10" width="20" height="20"')),
    probes: [
      [15, 15, BLUE, 1],
      [25, 25, BLUE, 1],
      [45, 45, RED, 1],
      [55, 55, WHITE, 1],
    ],
  },
  {
    name: 'em in stroke-width and stroke-dasharray',
    svg: dashed('1em', '1em 0.5em'),
    control: dashed('20', '20 10'),
    old: dashed('16', '16 8'),
    probes: [
      [18, 11, BLACK, 1],
      [45, 20, BLACK, 1],
      [33, 20, WHITE, 1],
      [18, 7, WHITE, 1],
    ],
  },
];

if (process.argv.includes('--cpu')) {
  const { imp } = await import('./svg/_importSemantics.mjs');
  const key = (x) =>
    JSON.stringify(
      Object.keys(x)
        .sort()
        .map((k) => [
          k,
          ArrayBuffer.isView(x[k]) || x[k] instanceof ArrayBuffer
            ? Buffer.from(x[k].buffer || x[k]).toString('base64')
            : x[k],
        ]),
      (k, v) => (typeof v === 'number' && !isFinite(v) ? String(v) : v),
    );
  const same = (a, b) => key(a) === key(b);
  for (const c of CELLS) {
    const [s, k, o] = await Promise.all([
      imp(c.svg, { preserveViewport: true }),
      imp(c.control, { preserveViewport: true }),
      imp(c.old, { preserveViewport: true }),
    ]);
    console.log(
      `${same(s, k) ? 'record==control' : 'record!=control'} ${same(s, o) ? 'record==OLD(vacuous?)' : 'record!=old'}  ${c.name}`,
    );
  }
  process.exit(0);
}

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
  if (vsControl > 1) fail(line + ' -- render differs from its control');
  else if (vsOld < 48) fail(line + ' -- vacuous: the picture without the rule is the same');
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
  '\nimporterSemanticsRenderSmoke: the importer-semantics rules render as their controls on the GPU',
);
