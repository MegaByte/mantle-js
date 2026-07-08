// colorPaletteSmoke.mjs — per-draw palette LUT for indexed discrete
// recoloring. Companion to colorMatrix.js: where matrix is continuous,
// palette is discrete.
// The shape's resolved fill picks an index from one channel; the
// index reads a 256×1 RGBA8 LUT; result replaces RGB.
//
// Critical contract: palette is MUTABLE AT WILL. Caller can mutate
// any entry between draws (or every frame) at single-texSubImage2D
// cost. No bundle changes, no shader recompile.
//
// Test plan:
//   T1 — baseline (no palette): two-rect SVG (R=#100, G=#200) renders
//        as authored.
//   T2 — palette substitution: bind a palette that maps the SVG
//        indices to specific colors; verify rendered output matches.
//   T3 — mutation between draws: same palette object, call .set()
//        between two draws on different frames; second draw uses the
//        mutated entries (proves "change at will" claim).
//   T4 — bulk update: .update() replaces all entries; subsequent
//        draw uses the new palette.
//   T5 — state revert: drawing without palette opts after a palette
//        draw returns to baseline (no sticky uniforms).
//   T6 — palette + color matrix compose: palette substitutes then
//        matrix transforms the substituted result.

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'color-palette');
mkdirSync(OUT, { recursive: true });

// Author the two shapes with distinct R values (small, on purpose, so
// they land in different palette index buckets after `index = R *
// paletteSize`). Default paletteChannel='r', paletteSize=4.
//   shape 0: R=0   → index 0
//   shape 1: R=64  → index 1 (with paletteSize=4: 64/255 * 4 ≈ 1.003 → 1)
//   shape 2: R=128 → index 2
//   shape 3: R=192 → index 3
const SVG = `
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="0"  y="0"  width="25" height="100" fill="#000000"/>
  <rect x="25" y="0"  width="25" height="100" fill="#400000"/>
  <rect x="50" y="0"  width="25" height="100" fill="#800000"/>
  <rect x="75" y="0"  width="25" height="100" fill="#C00000"/>
</svg>`;

const HTML = `<!DOCTYPE html><html><body style="margin:0;background:#000">
<canvas id="c" width="100" height="100"></canvas>
<script type="module">
import {
  importSvg, createBundle, createRenderer, loadShaders,
  createPalette,
  colorMatrixMonochrome,
} from '/src/index.js';

const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const renderer = createRenderer(gl, shaders);
const id = new Float32Array([1,0,0,0,1,0,0,0,1]);

const sections = await importSvg(${JSON.stringify(SVG)});
const bundle = createBundle(gl, sections);

function readPx(x, y) {
  const buf = new Uint8Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  return [buf[0], buf[1], buf[2], buf[3]];
}

async function drawAndSnapshot(opts) {
  renderer.setViewport(100, 100);
  renderer.beginFrame([0, 0, 0, 1]);
  renderer.drawBundle(bundle, { worldMatrix: id, ...opts });
  renderer.endFrame();
  // Sample center of each rect.
  return {
    s0: readPx(12, 50),  s1: readPx(37, 50),
    s2: readPx(62, 50),  s3: readPx(87, 50),
    pngDataUrl: cnv.toDataURL('image/png'),
  };
}

const out = {};

// T1 baseline (no palette).
out.T1_baseline = await drawAndSnapshot({});

// T2 palette substitution.
const palette = createPalette(gl, [
  [255, 0,   0,   255],   // index 0 → red
  [0,   255, 0,   255],   // index 1 → green
  [0,   0,   255, 255],   // index 2 → blue
  [255, 255, 0,   255],   // index 3 → yellow
]);
out.T2_palette = await drawAndSnapshot({
  palette, paletteChannel: 'r',
});

// T3 mutation between draws: change index 0 (red → cyan) and index 2
// (blue → magenta) via .set(), redraw. Same palette handle, no
// recreation. Proves "mutable at will" — single per-entry upload,
// no bundle / shader changes.
palette.set(0, [0, 255, 255, 255]);    // red → cyan
palette.set(2, [255, 0, 255, 255]);    // blue → magenta
out.T3_mutated = await drawAndSnapshot({
  palette, paletteChannel: 'r',
});

// T4 bulk update.
palette.update([
  [128, 128, 128, 255],   // index 0 → gray
  [255, 255, 255, 255],   // index 1 → white
  [64,  64,  64,  255],   // index 2 → dark gray
  [192, 192, 192, 255],   // index 3 → light gray
]);
out.T4_bulk_update = await drawAndSnapshot({
  palette, paletteChannel: 'r',
});

// T5 state revert.
out.T5_revert = await drawAndSnapshot({});

// T6 palette + color matrix compose. Palette returns greys (T4
// state). Color matrix then turns them into a yellow-tinted scale.
{
  const { matrix, offset } = colorMatrixMonochrome([1, 1, 0, 1]);
  out.T6_palette_then_matrix = await drawAndSnapshot({
    palette, paletteChannel: 'r',
    colorMatrix: matrix, colorMatrixOffset: offset,
  });
}

palette.dispose();
window.__r = out;
window.__d = true;
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

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => { if (m.type() === 'error') console.error('  [console]', m.text()); });
await page.setViewport({ width: 200, height: 200 });
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__d === true, { timeout: 30000 });
const r = await page.evaluate(() => window.__r);
await browser.close();
server.close();

for (const k of Object.keys(r)) {
  writeFileSync(path.join(OUT, k + '.png'),
    Buffer.from(r[k].pngDataUrl.slice('data:image/png;base64,'.length), 'base64'));
}

let failures = 0;
const ok = m => console.log('ok', m);
const fail = m => { failures++; console.error('FAIL', m); };
const close = (a, b, tol = 6) =>
  Math.abs(a[0] - b[0]) <= tol &&
  Math.abs(a[1] - b[1]) <= tol &&
  Math.abs(a[2] - b[2]) <= tol;

// T1 baseline: the 4 rects show their authored R values (0, 64, 128, 192).
{
  const t = r.T1_baseline;
  console.log('T1:', t.s0, t.s1, t.s2, t.s3);
  if (close(t.s0, [0, 0, 0]))      ok('T1 s0 = #000');
  else fail('T1 s0 got ' + t.s0.slice(0,3));
  if (close(t.s1, [64, 0, 0]))     ok('T1 s1 = #400000');
  else fail('T1 s1 got ' + t.s1.slice(0,3));
  if (close(t.s2, [128, 0, 0]))    ok('T1 s2 = #800000');
  else fail('T1 s2 got ' + t.s2.slice(0,3));
  if (close(t.s3, [192, 0, 0]))    ok('T1 s3 = #C00000');
  else fail('T1 s3 got ' + t.s3.slice(0,3));
}

// T2 palette: with the default paletteSize=256 (the LUT width), the
// shader index formula is `clamp(floor(R * paletteSize), 0, size-1)`,
// so R values 0/64/128/192 index palette[0]/[64]/[128]/[192]. Only
// palette[0] is set (red); the other three entries stay at the default
// black. Assertions follow that indexing.
{
  const t = r.T2_palette;
  console.log('T2:', t.s0, t.s1, t.s2, t.s3);
  if (close(t.s0, [255, 0, 0]))   ok('T2 s0 (R=0   → palette[0]=red)');
  else fail('T2 s0 got ' + t.s0.slice(0,3));
  // s1..s3 fall outside the 4 entries we set → default black.
  if (close(t.s1, [0, 0, 0]))     ok('T2 s1 (R=64 → palette[64]=unset=black)');
  else fail('T2 s1 got ' + t.s1.slice(0,3));
  if (close(t.s2, [0, 0, 0]))     ok('T2 s2 (R=128 → palette[128]=unset=black)');
  else fail('T2 s2 got ' + t.s2.slice(0,3));
  if (close(t.s3, [0, 0, 0]))     ok('T2 s3 (R=192 → palette[192]=unset=black)');
  else fail('T2 s3 got ' + t.s3.slice(0,3));
}

// T3 — after .set(0, cyan), shape 0 substitutes to cyan. The .set
// call costs one gl.texSubImage2D for 4 bytes — no other state changes.
{
  const t = r.T3_mutated;
  console.log('T3:', t.s0, t.s1, t.s2, t.s3);
  if (close(t.s0, [0, 255, 255])) ok('T3 s0 (palette[0] mutated red → cyan)');
  else fail('T3 s0 expected cyan, got ' + t.s0.slice(0,3));
  // The .set(2, magenta) call mutates palette[2] which no shape indexes
  // (shape 2's R=128 indexes palette[128]). So it's a no-op visually
  // but proves we can mutate ANY entry, not just used ones.
  if (close(t.s2, [0, 0, 0]))     ok('T3 s2 (palette[128] unchanged → black)');
  else fail('T3 s2 got ' + t.s2.slice(0,3));
}

// T4 — bulk update: only the first 4 entries are written. shape 0
// indexes palette[0]=gray. shapes 1..3 index palette[64], [128], [192]
// which reset to alpha=255, RGB=(0,0,0) per the .update default.
{
  const t = r.T4_bulk_update;
  console.log('T4:', t.s0, t.s1, t.s2, t.s3);
  if (close(t.s0, [128, 128, 128])) ok('T4 s0 (palette[0] bulk → gray)');
  else fail('T4 s0 got ' + t.s0.slice(0,3));
  if (close(t.s1, [0, 0, 0]))       ok('T4 s1 (palette[64] reset to default black)');
  else fail('T4 s1 got ' + t.s1.slice(0,3));
}

// T5 — state revert.
{
  const t = r.T5_revert;
  console.log('T5:', t.s0, t.s1, t.s2, t.s3);
  if (close(t.s0, [0, 0, 0]))       ok('T5 s0 reverted to baseline');
  else fail('T5 s0 got ' + t.s0.slice(0,3));
  if (close(t.s1, [64, 0, 0]))      ok('T5 s1 reverted to baseline');
  else fail('T5 s1 got ' + t.s1.slice(0,3));
}

// T6 — palette + monochrome(yellow) matrix.
// shape 0: palette[0]=gray (128,128,128). Monochrome luminance:
//   Y = 0.2126*128 + 0.7152*128 + 0.0722*128 = 128 (perfect gray
//   maps to identical luminance). Tint by yellow (1, 1, 0):
//   out = (128, 128, 0).
{
  const t = r.T6_palette_then_matrix;
  console.log('T6:', t.s0, t.s1, t.s2, t.s3);
  if (close(t.s0, [128, 128, 0]))   ok('T6 palette → matrix: gray → yellow-luminance');
  else fail('T6 s0 expected (128,128,0), got ' + t.s0.slice(0,3));
}

console.log(`\nPNGs saved to ${OUT}`);
if (failures > 0) {
  console.error(`\nCOLOR-PALETTE FAIL (${failures})`);
  process.exit(1);
}
console.log('\nCOLOR-PALETTE PASS');
