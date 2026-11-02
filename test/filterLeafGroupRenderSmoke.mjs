// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterLeafGroupRenderSmoke -- on the GPU: a filter on a leaf with a fill AND a stroke, and a filter on a <use>, run ONCE over the
// composited element (record-level proofs: test/filterLeafGroupSmoke.mjs).
//
// Each cell renders three documents with the renderer at 128 px (64-unit viewBox, white ground), as compositingGroupRenderSmoke does:
//   svg      the document under test (the filter on the leaf / on the <use>);
//   control  the same picture with the filter on a <g> around it (already one evaluation over the union): the render must match to `tol`;
//   old      what the defect draws, authored literally (the fill and the stroke as two elements that each carry the filter, the
//            leaves of the instance each filtered alone): the render must DIFFER from it by at least 24/255 somewhere, so a pass cannot
//            be a picture the defect also draws.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = (body, f) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="white"/><defs><filter id="f" x="-30%" y="-30%" width="170%" height="170%" color-interpolation-filters="sRGB">${f}</filter></defs>${body}</svg>`;
const R = 'x="16" y="14" width="28" height="26" rx="4"';
const FS = (extra = '') => `${R} fill="#e04020" stroke="#2040c0" stroke-width="6" ${extra}`;
const leaf = (extra) => `<rect ${FS(extra)}/>`;
const grp = (extra = '') => `<g filter="url(#f)" ${extra}><rect ${FS()}/></g>`;
const old = `<rect ${R} fill="#e04020" filter="url(#f)"/><rect ${R} fill="none" stroke="#2040c0" stroke-width="6" filter="url(#f)"/>`;
const FILTERS = {
  feDropShadow:
    '<feDropShadow dx="4" dy="4" stdDeviation="1.5" flood-color="#000" flood-opacity=".5"/>',
  'offset + merge with SourceGraphic':
    '<feOffset dx="5" dy="4" result="o"/><feMerge><feMergeNode in="o"/><feMergeNode in="SourceGraphic"/></feMerge>',
  feGaussianBlur: '<feGaussianBlur stdDeviation="2"/>',
  'feMorphology erode': '<feMorphology operator="erode" radius="2"/>',
  'feMorphology dilate': '<feMorphology operator="dilate" radius="2"/>',
  feDiffuseLighting:
    '<feDiffuseLighting in="SourceAlpha" surfaceScale="3" diffuseConstant="1" lighting-color="#fff" result="l"><fePointLight x="10" y="6" z="30"/></feDiffuseLighting><feComposite in="SourceGraphic" in2="l" operator="arithmetic" k1="1" k2="0" k3="0" k4="0"/>',
  'feColorMatrix on alpha (translucent result)':
    '<feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 .5 0"/>',
};
const DEFS_USE = `<defs><rect id="a" x="8" y="8" width="30" height="30" fill="#0cf"/><rect id="b" x="24" y="24" width="30" height="30" fill="#f0c"/><g id="two"><use href="#a"/><use href="#b"/></g></defs>`;
const CELLS = [];
for (const [name, f] of Object.entries(FILTERS)) {
  CELLS.push({
    name: `${name} on a fill+stroke leaf`,
    svg: doc(leaf('filter="url(#f)"'), f),
    control: doc(grp(), f),
    old: doc(old, f),
    tol: 3,
    minOld: name.startsWith('feGauss') ? 8 : 24,
    probes: [],
  });
}
CELLS.push({
  name: 'a leaf filter with opacity: one group, filter then opacity',
  svg: doc(leaf('filter="url(#f)" opacity=".6"'), FILTERS['feDropShadow']),
  control: doc(grp('opacity=".6"'), FILTERS['feDropShadow']),
  old: doc(
    old.replace('/>', '/>').replace(/<rect /g, '<rect opacity=".6" '),
    FILTERS['feDropShadow'],
  ),
  tol: 3,
  probes: [],
});
CELLS.push({
  name: '<use filter> of two overlapping rects: feMorphology erode (a single-kind filter ran per leaf)',
  svg: doc(DEFS_USE + '<use href="#two" filter="url(#f)"/>', FILTERS['feMorphology erode']),
  control: doc(
    DEFS_USE + '<g filter="url(#f)"><use href="#two"/></g>',
    FILTERS['feMorphology erode'],
  ),
  old: doc(
    DEFS_USE + '<use href="#a" filter="url(#f)"/><use href="#b" filter="url(#f)"/>',
    FILTERS['feMorphology erode'],
  ),
  tol: 3,
  probes: [],
});
CELLS.push({
  name: '<use filter> of two overlapping rects: feMorphology dilate, x/y on the use',
  svg: doc(
    DEFS_USE + '<use href="#two" x="3" y="2" filter="url(#f)"/>',
    FILTERS['feMorphology dilate'],
  ),
  control: doc(
    DEFS_USE + '<g filter="url(#f)"><use href="#two" x="3" y="2"/></g>',
    FILTERS['feMorphology dilate'],
  ),
  old: doc(
    DEFS_USE +
      '<use href="#a" x="3" y="2" filter="url(#f)"/><use href="#b" x="3" y="2" filter="url(#f)"/>',
    FILTERS['feMorphology dilate'],
  ),
  tol: 3,
  probes: [],
});
CELLS.push({
  name: '<use filter> of a fill+stroke leaf',
  svg: doc(
    `<defs><rect id="fs" ${FS()}/></defs><use href="#fs" filter="url(#f)"/>`,
    FILTERS['feDropShadow'],
  ),
  control: doc(grp(), FILTERS['feDropShadow']),
  old: doc(old, FILTERS['feDropShadow']),
  tol: 3,
  probes: [],
});

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
  else if (vsOld < (c.minOld ?? 24)) fail(line + ' -- vacuous: the defect picture is the same');
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
  '\nfilterLeafGroupRenderSmoke: a filtered fill+stroke leaf and a <use filter> render as the equivalent <g filter>, not as per-row results',
);
