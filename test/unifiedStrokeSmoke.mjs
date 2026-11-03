// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedStrokeSmoke.mjs — a STROKED bundle draws in one call, no coverage RT.
//
// It needs no new geometry kind. Fill and stroke are SEPARATE meta rows, so a stroked shape's stroke row owns
// its own cover quad, and the ubershader's analytic band walk already renders it.
// In the unified stream the fill row contributes LB triangles and the stroke row
// contributes its cover quad, painter-sorted into one buffer:
//
//   fill(shape0) LB tris | stroke(shape0) quad | fill(shape1) LB tris | ...
//
// So the split-stroke coverage RT and its per-shape composite are not needed for
// a stroked bundle to reach one draw (with them a stroked bundle costs over a
// hundred GL draws where Slug costs 1). The per-segment split stroke stays as an
// ALTERNATIVE to measure against the band walk, not as a requirement.
//
// Asserts the three things that could each rot silently: exactly one GL draw,
// the stroke actually painted (a fill-only draw would still pass an
// ink-vs-Slug check if the stroke were merely thin), and parity with Slug.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Curved fills (so LB meshes exist) with thick contrasting strokes (so the
// stroke is unmistakable in the pixels and its own meta row).
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M20 50 C20 26 40 14 50 30 C60 14 80 26 80 50 C80 72 50 88 50 88' +
  ' C50 88 20 72 20 50Z" fill="#2a6fd6" stroke="#e03c3c" stroke-width="6"/>' +
  '<circle cx="72" cy="26" r="12" fill="#3fbf6f" stroke="#1a1a1a" stroke-width="5"/></svg>';

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="220" height="220"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = 220;
const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
let draws = 0;
for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
  const orig = gl[m].bind(gl);
  gl[m] = (...a) => { draws++; return orig(...a); };
}
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const sec = await importSvg(${JSON.stringify(SVG)});
const read = () => { const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px); return px; };

async function shoot(opts, lb) {
  const r = createRenderer(gl, shaders, opts);
  const b = createBundle(gl, sec);
  r.setLoopBlinnFill(lb);
  try { r.prepareBundle(b); } catch {}
  if (lb !== 'off' && r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  const frame = () => { r.setViewport(S, S); r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame(); };
  frame();                       // warm: first frame may still be finishing the build
  draws = 0; frame();
  const px = read(), d = draws;
  const st = r.debugStats || {};
  try { b.dispose(); } catch {}
  return { px, draws: d, lbRoute: (st.loopBlinnRouteCount | 0) + (st.loopBlinnMorphRouteCount | 0) };
}

const slug = await shoot({ aacFill: false }, 'off');
const uni  = await shoot({ aacFill: false, fillDefines: ['MANTLE_LB_FILL'] }, 'on');

// Count RED (stroke of shape 0) and BLUE (its fill) separately: a regression
// that dropped strokes would keep the fill parity and lose only the red.
const tally = (px) => {
  let red = 0, blue = 0, ink = 0;
  for (let i = 0; i < S * S; i++) {
    const r = px[i * 4], g = px[i * 4 + 1], b = px[i * 4 + 2];
    if (r + g + b > 24) ink++;
    if (r > 140 && g < 90 && b < 90) red++;
    if (b > 140 && r < 110) blue++;
  }
  return { red, blue, ink };
};
const A = tally(slug.px), B = tally(uni.px);
let diff = 0, n = 0;
for (let i = 0; i < S * S; i++) {
  const o = i * 4;
  const a = slug.px[o] + slug.px[o + 1] + slug.px[o + 2];
  const b = uni.px[o] + uni.px[o + 1] + uni.px[o + 2];
  if (a > 24 || b > 24) { n++; for (let k = 0; k < 3; k++) diff += Math.abs(slug.px[o + k] - uni.px[o + k]); }
}
window.out = { slugDraws: slug.draws, uniDraws: uni.draws, lbRoute: uni.lbRoute,
               slug: A, uni: B, meanDiff: n ? +(diff / (n * 3)).toFixed(2) : 0 };
</script></body></html>`;

const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    res.writeHead(200, { 'content-type': mime(u.pathname) + '; charset=utf-8' });
    res.end(b);
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 180000,
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error') logs.push(m.text());
});
page.on('pageerror', (e) => logs.push(String(e.message)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
try {
  await page.waitForFunction('typeof window.out !== "undefined"', {
    timeout: 120000,
    polling: 100,
  });
} catch {
  console.log('  page never finished:\n    ' + (logs.join('\n    ') || '(none)'));
  await browser.close();
  server.close();
  process.exit(1);
}
const r = await page.evaluate(() => window.out);
await browser.close();
server.close();

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
console.log(`  ${JSON.stringify(r)}`);
ok(r.lbRoute > 0, `stroked bundle routed through LB (${r.lbRoute})`);
ok(r.uniDraws === 1, `ONE GL draw for a stroked bundle (${r.uniDraws}; Slug ${r.slugDraws})`);
ok(r.slug.red > 800, `reference actually has a stroke (${r.slug.red} red px)`);
ok(
  Math.abs(r.uni.red - r.slug.red) / Math.max(r.slug.red, 1) < 0.06,
  `stroke painted, within 6% of Slug (${r.uni.red} vs ${r.slug.red} red px)`,
);
ok(
  Math.abs(r.uni.blue - r.slug.blue) / Math.max(r.slug.blue, 1) < 0.06,
  `fill painted, within 6% of Slug (${r.uni.blue} vs ${r.slug.blue} blue px)`,
);
ok(r.meanDiff < 8, `mean channel difference is AA/edge scale (${r.meanDiff})`);

console.log(
  `\nunifiedStrokeSmoke: ${fail ? 'FAIL' : 'PASS'} — stroked bundle in one draw, no coverage RT`,
);
process.exit(fail ? 1 : 0);
