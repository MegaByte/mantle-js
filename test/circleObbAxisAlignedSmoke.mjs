// circleObbAxisAlignedSmoke.mjs — verifies the cover-quad OBB for a
// circular outer ring stays axis-aligned (a rotated OBB extends past
// the AABB at the corners, mis-classifying coverage → chord-cut
// artifacts).
//
// Why it can go wrong: a full circle is often authored as TWO arcs
// (e.g. a 270° large arc + a 90° small arc). Constant per-arc sampling
// over-weights the short arc, biasing the PCA covariance and tilting
// fitOBB a few degrees off the AABB axes. Guards: arc-sample density
// scales with sweep angle; fitOBB falls back to AABB for square-ish
// (ill-conditioned) OBBs.
//
// Test: inspect the outer-ring shape's cover-quad verts, assert the
// quad is axis-aligned.

import { readFileSync, existsSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// External art fixtures. Point PAUSE_ICONS_DIR at a folder of pause
// icons (icon-soundfx-*.svg, icon-music-*.svg); the test skips cleanly
// when the variable is unset or the folder is missing.
const ICONS_DIR = process.env.PAUSE_ICONS_DIR || '';
if (!ICONS_DIR || !existsSync(ICONS_DIR)) {
  console.log(`SKIP circleObbAxisAligned: icons not found (set PAUSE_ICONS_DIR to a pause-icon folder)`);
  process.exit(0);
}
const SVG_ICONS = {
  'soundfx-on':  readFileSync(path.join(ICONS_DIR, 'icon-soundfx-on.svg'), 'utf8'),
  'soundfx-off': readFileSync(path.join(ICONS_DIR, 'icon-soundfx-off.svg'), 'utf8'),
  'music-on':    readFileSync(path.join(ICONS_DIR, 'icon-music-on.svg'), 'utf8'),
};

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="64" height="64"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true });
const SVGS = ${JSON.stringify(SVG_ICONS)};
const out = {};
for (const name of Object.keys(SVGS)) {
  const sections = await importSvg(SVGS[name]);
  const bundle = createBundle(gl, sections);
  const STRIDE = 12;
  const f32 = bundle.coverQuadFloats;
  const shapes = [];
  for (let s = 0; s < (bundle.chunkByShape ? bundle.chunkByShape.length : 0); s++) {
    const c = bundle.chunkByShape[s];
    if (!c || c.count !== 6) continue;
    const verts = [];
    for (let v = 0; v < 4; v++) {
      // Cover quad layout is [tl, tr, br, tl, br, bl] — first 3 verts
      // give 3 unique corners, vert 5 (br) repeats, vert 6 (bl) is the
      // 4th unique corner.
      const idx = v < 3 ? v : 5;
      const off = (c.start + idx) * STRIDE;
      verts.push([f32[off], f32[off + 1]]);
    }
    shapes.push({ shapeIdx: s, verts });
  }
  out[name] = shapes;
  bundle.dispose();
}
window.__result = out;
window.__done = true;
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(u.pathname);
  const mime = p.endsWith('.js') || p.endsWith('.mjs') ? 'text/javascript'
             : p.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try { res.writeHead(404); res.end(); } catch {}
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
await page.setViewport({ width: 200, height: 200 });
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__done === true, { timeout: 15000 });
const results = await page.evaluate(() => window.__result);
await browser.close();
server.close();

let failures = 0;
const ok = m => console.log('ok', m);
const fail = m => { failures++; console.error('FAIL', m); };

function isAxisAligned(verts) {
  // 4 corners. Compute the two adjacent edges (v0→v1) and (v1→v2).
  // Axis-aligned means edges are horizontal or vertical (one of the
  // components is ~0). Tolerance: 1e-3 (em-units).
  const e01 = [verts[1][0] - verts[0][0], verts[1][1] - verts[0][1]];
  const e12 = [verts[2][0] - verts[1][0], verts[2][1] - verts[1][1]];
  const isAxisAlignedEdge = e =>
    Math.abs(e[0]) < 1e-3 || Math.abs(e[1]) < 1e-3;
  return isAxisAlignedEdge(e01) && isAxisAlignedEdge(e12);
}

for (const iconName of Object.keys(results)) {
  const shapes = results[iconName];
  // The outer-ring shape is always the largest one (covers the icon's
  // viewbox). Find shapes whose cover quad spans the full [0, 64]
  // viewbox.
  const ringShapes = shapes.filter(s => {
    const xs = s.verts.map(v => v[0]);
    const ys = s.verts.map(v => v[1]);
    const w = Math.max(...xs) - Math.min(...xs);
    const h = Math.max(...ys) - Math.min(...ys);
    return w > 50 && h > 50;
  });
  if (ringShapes.length === 0) {
    fail(`${iconName}: no full-bbox shape found`);
    continue;
  }
  for (const s of ringShapes) {
    if (isAxisAligned(s.verts)) {
      ok(`${iconName}: shape ${s.shapeIdx} cover quad is axis-aligned`);
    } else {
      const edges = [
        [s.verts[1][0] - s.verts[0][0], s.verts[1][1] - s.verts[0][1]],
        [s.verts[2][0] - s.verts[1][0], s.verts[2][1] - s.verts[1][1]],
      ];
      const angles = edges.map(e => (Math.atan2(e[1], e[0]) * 180 / Math.PI).toFixed(2));
      fail(`${iconName}: shape ${s.shapeIdx} cover quad rotated, edge angles ${angles.join(',')}° (would crop on the rotated-OBB-corner pixels)`);
    }
  }
}

if (failures > 0) {
  console.error(`\nCIRCLE-OBB-AXIS-ALIGNED FAIL (${failures})`);
  process.exit(1);
}
console.log('\nCIRCLE-OBB-AXIS-ALIGNED PASS');
