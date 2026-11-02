// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupLeafDepthSmoke — a depth-claimed leaf renders the same inside a group as outside one, on
// both routes, against Chrome.
//
// An isolated leaf (mix-blend-mode, COLRv1 glyph, filter graph source) renders alone into a target
// of its own. Out of a group that target is shapeFbo, with a depth+stencil renderbuffer; in a group
// (the classic graph branch, the COLR leaf and the blend leaf -- the last two shared by both routes)
// it must not be pingFbo, which has neither. The unified route's DEPTH CLAIM needs depth: a translucent
// shape's Loop-Blinn pieces share chords the rasterizer hands to both, and the claim lets the first
// one own the pixel. Without a depth buffer it is inert, so a translucent blend leaf in a group
// double-paints those chords (alpha 0.5 painted twice reads 0.75), and the same leaf out of a group
// does not. test/groupLeafTargetSmoke.mjs (node lane) pins the target; this pins the pixels.
//
// THE SCENE: a translucent cubic squircle (fill-opacity 0.5, mix-blend-mode multiply) on WHITE,
// drawn (A) on its own and (B) inside <g style="isolation:isolate">. Multiply over white is the
// source, and over an isolated group's transparent backdrop it is the source too, so CSS makes A and
// B the same image; (C) inside <g opacity="0.5"> is checked against Chrome only.
// Checked per route:
//   (1) the unified arm served the blend leaf (and the group), the classic arm drew no unified draw;
//   (2) every pixel where Chrome's 3x3 neighbourhood is flat and inside the shape -- so no AA edge
//       and no difference of antialiasing between the two renderers can reach it -- matches Chrome
//       within 6/255 (a double-painted chord is a line of such pixels at 64/255 off);
//   (3) B equals A within 2/255 everywhere (the group composite's own rounding).
// On a depthless target route lb would fail (2) and (3) for B along the squircle's interior chords;
// route none would pass (cover quads have no claim and no seams). If the squircle happens to raster
// with no tied chord at this size this is a parity pin only; the node-lane smoke pins the target.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 120;
const svg = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">${body}</svg>`;
const SQ =
  '<path d="M60 12 C100 12 108 20 108 60 C108 100 100 108 60 108 C20 108 12 100 12 60 C12 20 20 12 60 12 Z" ' +
  'fill="#00f" fill-opacity="0.5" style="mix-blend-mode:multiply"/>';
const ARMS = [
  { name: 'A: the blend leaf alone', svg: svg(SQ), grouped: false },
  {
    name: 'B: the blend leaf in an isolated group',
    svg: svg(`<g style="isolation:isolate">${SQ}</g>`),
    grouped: true,
  },
  {
    name: 'C: the blend leaf in an opacity group',
    svg: svg(`<g opacity="0.5">${SQ}</g>`),
    grouped: true,
  },
];
const ROUTES = ['none', 'lb'];
const TOL = 6; // against Chrome, on flat interior pixels
const SAME = 2; // B against A, same renderer

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__case = async (svg, route) => {
  R.setFillEngine({ route, kernel: 'slug' });
  const b = createBundle(gl, await importSvg(svg, { preserveViewport: true }));
  if (R.prepareBundle) R.prepareBundle(b);
  if (R.awaitLbReady) { try { await R.awaitLbReady(b, 20000); } catch {} }
  R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
  // The route is read off the LAST frame -- the one whose pixels are compared.
  let before = null;
  for (let i = 0; i < 4; i++) {
    if (i === 3) before = Object.assign({}, R.debugStats);
    R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
  }
  const after = R.debugStats;
  const d = (k) => (after[k] | 0) - (before[k] | 0);
  const route_ = { gate: after.unifiedFillGate, uniDraws: d('unifiedFillDraws'),
                   blendLeaves: d('unifiedBlendLeaves'), groupBrackets: d('unifiedGroupBrackets') };
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  b.dispose && b.dispose();
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const cv = document.createElement('canvas'); cv.width = cv.height = ${N};
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, ${N}, ${N});
  ctx.drawImage(img, 0, 0);
  const ref = ctx.getImageData(0, 0, ${N}, ${N}).data;
  // Both flipped to y-down and straight alpha; the ground is opaque, so straight == premultiplied.
  const mantle = new Array(${N} * ${N} * 4), chrome = Array.from(ref);
  for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) {
    const s = ((${N} - 1 - y) * ${N} + x) * 4, t = (y * ${N} + x) * 4, a = px[s + 3];
    for (let c = 0; c < 3; c++) mantle[t + c] = a ? Math.round(px[s + c] * 255 / a) : 0;
    mantle[t + 3] = a;
  }
  return { route: route_, mantle, chrome };
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

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const maxDiff = (a, b, i) =>
  Math.max(
    Math.abs(a[i] - b[i]),
    Math.abs(a[i + 1] - b[i + 1]),
    Math.abs(a[i + 2] - b[i + 2]),
    Math.abs(a[i + 3] - b[i + 3]),
  );
/// Chrome's flat interior: the pixel and its 8 neighbours identical, and not the white ground.
function flatInterior(ref) {
  const out = [];
  for (let y = 1; y < N - 1; y++)
    for (let x = 1; x < N - 1; x++) {
      const i = (y * N + x) * 4;
      if (ref[i] === 255 && ref[i + 1] === 255 && ref[i + 2] === 255) continue;
      let flat = true;
      for (let dy = -1; dy <= 1 && flat; dy++)
        for (let dx = -1; dx <= 1 && flat; dx++) {
          const j = ((y + dy) * N + (x + dx)) * 4;
          if (
            ref[j] !== ref[i] ||
            ref[j + 1] !== ref[i + 1] ||
            ref[j + 2] !== ref[i + 2] ||
            ref[j + 3] !== ref[i + 3]
          )
            flat = false;
        }
      if (flat) out.push(i);
    }
  return out;
}

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail('page: ' + e.message));
try {
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
  for (const route of ROUTES) {
    const got = [];
    for (const arm of ARMS) {
      const r = await page.evaluate((s, rt) => window.__case(s, rt), arm.svg, route);
      got.push(r);
      const t = r.route;
      const tookMsg =
        `route ${route}, ${arm.name}: last frame gate ${t.gate}, unified draws ${t.uniDraws}, ` +
        `blend leaves ${t.blendLeaves}, group brackets ${t.groupBrackets}`;
      if (route === 'none') {
        if (t.uniDraws === 0) ok(tookMsg + ' (classic route)');
        else fail(tookMsg + ' -- the classic arm drew on the unified route');
      } else if (t.blendLeaves > 0 && (!arm.grouped || t.groupBrackets > 0)) {
        ok(tookMsg + ' (unified route)');
      } else {
        fail(
          tookMsg +
            ' -- the unified arm did not serve the blend leaf' +
            (arm.grouped ? ' inside a group it served' : ''),
        );
      }
      const flat = flatInterior(r.chrome);
      let bad = 0,
        worst = 0,
        at = null;
      for (const i of flat) {
        const dd = maxDiff(r.mantle, r.chrome, i);
        if (dd > worst) {
          worst = dd;
          at = i;
        }
        if (dd > TOL) bad++;
      }
      const where =
        at == null
          ? ''
          : ` (worst at ${(at / 4) % N},${Math.floor(at / 4 / N)}: mantle rgba(${r.mantle.slice(at, at + 4)}) ` +
            `chrome rgba(${r.chrome.slice(at, at + 4)}))`;
      const msg = `route ${route}, ${arm.name}: ${bad} of ${flat.length} flat interior pixels off Chrome by more than ${TOL}/255, worst ${worst}${where}`;
      if (flat.length > 1000 && bad === 0) ok(msg);
      else fail(msg + (flat.length > 1000 ? '' : ' -- too few flat pixels to judge'));
    }
    // (3) B against A, whole image.
    let bad = 0,
      worst = 0;
    for (let i = 0; i < N * N * 4; i += 4) {
      const dd = maxDiff(got[1].mantle, got[0].mantle, i);
      if (dd > worst) worst = dd;
      if (dd > SAME) bad++;
    }
    const msg = `route ${route}: the leaf in an isolated group vs alone -- ${bad} px differ by more than ${SAME}/255, worst ${worst}`;
    if (bad === 0) ok(msg);
    else fail(msg);
  }
} catch (e) {
  fail('setup: ' + e.message);
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\ngroupLeafDepthSmoke: a depth-claimed leaf renders the same inside a group as outside one, on both routes',
);
