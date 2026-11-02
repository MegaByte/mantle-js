// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importerGeometryAuditRenderSmoke -- the importer's geometry rules that change PIXELS, on the GPU (
// the record-level proofs are test/importerGeometryAuditSmoke.mjs).
//
// Each cell renders three documents with the renderer at 128 px (64-unit viewBox, white ground), as importerSemanticsRenderSmoke does:
//   svg      the document under test, written with the feature under test;
//   control  the same picture authored without that feature (the path without its repeated point, an explicit M, a
//            disc / box drawn as a fill, the phase written inside one cycle): the render must match it to within `tol` (default 1/255);
//   old      the picture without the rule, authored literally (a join that is missing, a disc where a box belongs, nothing): the render
//            must DIFFER from svg by at least 48/255 somewhere, so a pass cannot be a picture an importer without the rule also draws.
// Probes are the analytic expectation (a stated point reads a stated color), independent of both documents.
//
// `--cpu` is not offered: the CPU proofs are the record checks in importerGeometryAuditSmoke.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
const WHITE = [255, 255, 255],
  BLACK = [0, 0, 0];
const S = (d, extra = '') => `<path d="${d}" fill="none" stroke="black" ${extra}/>`;
const W12 = 'stroke-width="12"';

const CELLS = [
  {
    name: 'duplicated mid vertex, miter join',
    svg: doc(S('M12 54 L32 14 L32 14 L52 54', `${W12} stroke-miterlimit="10"`)),
    control: doc(S('M12 54 L32 14 L52 54', `${W12} stroke-miterlimit="10"`)),
    old: doc(S('M12 54 L32 14 M32 14 L52 54', W12)),
    probes: [
      [32, 8, BLACK, 1],
      [32, 20, BLACK, 1],
      [4, 4, WHITE, 1],
    ],
  },
  {
    name: 'duplicated first and last point, butt caps',
    svg: doc(S('M12 54 L12 54 L32 14 L52 54 L52 54', `${W12} stroke-miterlimit="10"`)),
    control: doc(S('M12 54 L32 14 L52 54', `${W12} stroke-miterlimit="10"`)),
    old: doc(S('M12 54 L32 14 L52 54 L52 54', `${W12} stroke-linecap="round"`)),
    probes: [
      [32, 8, BLACK, 1],
      [4, 4, WHITE, 1],
    ],
  },
  {
    name: 'closed polygon with a repeated last vertex',
    svg: doc(S('M12 52 L32 12 L52 52 L52 52 Z', `${W12} stroke-miterlimit="10"`)),
    control: doc(S('M12 52 L32 12 L52 52 Z', `${W12} stroke-miterlimit="10"`)),
    old: doc(S('M12 52 L32 12 L52 52 Z', `${W12} stroke-linejoin="bevel"`)),
    probes: [
      [32, 6, BLACK, 1],
      [32, 36, WHITE, 1],
    ],
  },
  {
    name: 'a segment after Z starts its own subpath (square cap at the start point)',
    svg: doc(
      S('M14 14 H34 V34 Z L50 50', `${W12} stroke-linecap="square" stroke-dasharray="20 10"`),
    ),
    control: doc(
      S(
        'M14 14 H34 V34 Z M14 14 L50 50',
        `${W12} stroke-linecap="square" stroke-dasharray="20 10"`,
      ),
    ),
    old: doc(S('M14 14 H34 V34 Z L50 50', `${W12} stroke-linecap="butt"`)),
    probes: [
      [4, 14, WHITE, 1],
      [9, 14, BLACK, 1],
    ],
  },
  {
    name: 'zero-length subpaths, round cap: a disc each',
    svg: doc(S('M18 32 L18 32 M46 32 Z', 'stroke-width="16" stroke-linecap="round"')),
    control: doc('<circle cx="18" cy="32" r="8"/><circle cx="46" cy="32" r="8"/>'),
    tol: 64,
    old: doc(S('M18 32 L18 32', 'stroke-width="16" stroke-linecap="butt"')),
    probes: [
      [18, 32, BLACK, 1],
      [46, 32, BLACK, 1],
      [24, 24, WHITE, 1],
      [18, 22, WHITE, 1],
      [12, 32, BLACK, 1],
    ],
  },
  {
    name: 'zero-length subpaths, square cap: an axis-aligned box each',
    svg: doc(S('M18 32 h0 M46 32 l0 0 z', 'stroke-width="16" stroke-linecap="square"')),
    control: doc(
      '<rect x="10" y="24" width="16" height="16"/><rect x="38" y="24" width="16" height="16"/>',
    ),
    tol: 12,
    old: doc('<circle cx="18" cy="32" r="8"/><circle cx="46" cy="32" r="8"/>'),
    probes: [
      [10.6, 24.6, BLACK, 1],
      [25.4, 39.4, BLACK, 1],
      [46, 32, BLACK, 1],
      [4, 32, WHITE, 1],
    ],
  },
  {
    name: 'zero-length subpaths, butt cap: nothing',
    svg: doc(
      S(
        'M18 32 L18 32 L18 32 M46 32 l0 0 z M32 12 A0 0 0 0 1 32 12',
        'stroke-width="16" stroke-linecap="butt"',
      ),
    ),
    control: doc(''),
    old: doc('<circle cx="18" cy="32" r="8"/><circle cx="46" cy="32" r="8"/>'),
    probes: [
      [18, 32, WHITE, 1],
      [46, 32, WHITE, 1],
      [32, 12, WHITE, 1],
    ],
  },
  {
    name: 'square cap of a zero-length subpath turns with the element (user-space axes)',
    svg: doc(
      `<g transform="rotate(45 32 32)">${S('M32 32 Z', 'stroke-width="24" stroke-linecap="square"')}</g>`,
    ),
    control: doc('<rect x="20" y="20" width="24" height="24" transform="rotate(45 32 32)"/>'),
    tol: 12,
    old: doc('<circle cx="32" cy="32" r="12"/>'),
    probes: [
      [32, 32, BLACK, 1],
      [32, 16.4, BLACK, 1],
      [32, 12, WHITE, 1],
      [22, 22, WHITE, 1],
    ],
  },
  // SVG 2 path implementation notes: the square cap of a zero-length subpath follows the path's direction there (here the 45 degree
  // segment before it); Chrome and Skia draw it axis-aligned, and importSvg({ compat: 'chrome' }) keeps that.
  {
    name: 'spec default: the square cap of a zero-length subpath follows the preceding segment (45 degrees)',
    svg: doc(S('M6 6 L22 22 M46 40 h0', 'stroke-width="16" stroke-linecap="square"')),
    control: doc(
      S('M6 6 L22 22', 'stroke-width="16" stroke-linecap="square"') +
        '<rect x="38" y="32" width="16" height="16" transform="rotate(45 46 40)"/>',
    ),
    tol: 12,
    old: doc(
      S('M6 6 L22 22', 'stroke-width="16" stroke-linecap="square"') +
        '<rect x="38" y="32" width="16" height="16"/>',
    ),
    probes: [
      [46, 31.5, BLACK, 1],
      [46, 48.5, BLACK, 1],
      [38.6, 32.6, WHITE, 1],
      [53.4, 47.4, WHITE, 1],
    ],
  },
  {
    name: "compat 'chrome': the same square stays axis-aligned",
    svg: {
      svg: doc(S('M6 6 L22 22 M46 40 h0', 'stroke-width="16" stroke-linecap="square"')),
      opts: { compat: 'chrome' },
    },
    control: doc(
      S('M6 6 L22 22', 'stroke-width="16" stroke-linecap="square"') +
        '<rect x="38" y="32" width="16" height="16"/>',
    ),
    tol: 12,
    old: doc(
      S('M6 6 L22 22', 'stroke-width="16" stroke-linecap="square"') +
        '<rect x="38" y="32" width="16" height="16" transform="rotate(45 46 40)"/>',
    ),
    probes: [
      [39.5, 33.5, BLACK, 1],
      [52.5, 46.5, BLACK, 1],
      [46, 29.5, WHITE, 1],
      [46, 50.5, WHITE, 1],
    ],
  },
  {
    name: 'a stroke-dashoffset of 100000003 is its phase 3',
    svg: doc(
      S('M2 32 H62', 'stroke-width="8" stroke-dasharray="8 8" stroke-dashoffset="100000003"'),
    ),
    control: doc(S('M2 32 H62', 'stroke-width="8" stroke-dasharray="8 8" stroke-dashoffset="3"')),
    old: doc(S('M2 32 H62', 'stroke-width="8" stroke-dasharray="8 8" stroke-dashoffset="0"')),
    probes: [
      [5, 32, BLACK, 1],
      [9, 32, WHITE, 1],
    ],
  },
  {
    name: 'pathLength scales the dash pattern',
    svg: doc(S('M4 32 H60', 'stroke-width="8" stroke-dasharray="5 5" pathLength="30"')),
    control: doc(
      S('M4 32 H60', `stroke-width="8" stroke-dasharray="${(5 * 56) / 30} ${(5 * 56) / 30}"`),
    ),
    tol: 4,
    old: doc(S('M4 32 H60', 'stroke-width="8" stroke-dasharray="5 5"')),
    probes: [
      [6, 32, BLACK, 1],
      [16, 32, WHITE, 1],
    ],
  },
  {
    name: 'a 1e8 radius arc is its chord',
    svg: doc(S('M8 32 A100000000 100000000 0 0 1 56 32', 'stroke-width="12"')),
    control: doc(S('M8 32 L56 32', 'stroke-width="12"')),
    old: doc(''),
    probes: [
      [32, 32, BLACK, 1],
      [32, 24, WHITE, 1],
      [32, 40, WHITE, 1],
    ],
  },
  {
    name: 'a miter limit equal to the corner ratio keeps the miter',
    svg: doc(
      S('M10 54 L34 54 L34 30', `${W12} stroke-linejoin="miter" stroke-miterlimit="${Math.SQRT2}"`),
    ),
    control: doc(
      S('M10 54 L34 54 L34 30', `${W12} stroke-linejoin="miter" stroke-miterlimit="1.5"`),
    ),
    old: doc(S('M10 54 L34 54 L34 30', `${W12} stroke-linejoin="bevel"`)),
    probes: [
      [39, 59, BLACK, 1],
      [41, 61, WHITE, 1],
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
    const b = createBundle(gl, await importSvg(typeof s === 'string' ? s : s.svg, { preserveViewport: true, ...(typeof s === 'string' ? null : s.opts) }));
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
  const [a, b, o] = px; // c.svg may be { svg, opts } for a compat arm
  const vsControl = maxDiff(a, b),
    vsOld = maxDiff(a, o);
  const bad = c.probes
    .filter(([x, y, want, tol]) => maxDiff(at(a, x, y), want) > tol)
    .map(([x, y, want]) => `(${x},${y}) is [${at(a, x, y)}], wanted [${want}]`);
  const line = `${c.name}: control maxByte ${vsControl}, old differs by ${vsOld}, ink px svg ${inkOf(a)} / control ${inkOf(b)} / old ${inkOf(o)}`;
  if (vsControl > (c.tol ?? 1)) fail(line + ' -- render differs from its control');
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
  "\nimporterGeometryAuditRenderSmoke: the importer's geometry rules render as their controls on the GPU",
);
