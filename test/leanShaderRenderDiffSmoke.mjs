// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// leanShaderRenderDiffSmoke — the STANDARD WebGL shader-variant path: the fill
// shader guards each optional feature with `#ifndef MANTLE_NO_<FEAT>`, and a
// renderer compiles a lean program from them -- its fill variants do it per bundle
// (renderer/fillOmit.js); this forces all of them for a whole renderer through
// createRenderer's opts.fillDefines, a test hook read only under __MANTLE_DEBUG__
//. This proves (a) the lean variant COMPILES,
// (b) it renders byte-identical to the full ubershader for content using none
// of the omitted features, and (c) it drops the feature samplers.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { FILL_FEATURES, omitDefinesFor } from '../src/renderer/fillOmit.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Sanity: omitDefinesFor maps feature names → #define macros.
const omit = omitDefinesFor(FILL_FEATURES); // omit ALL optional features
let failures = 0;
const ok = (m) => console.log('ok', m);
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};

// Sampler-drop check (node side): apply the #define guards to the generated
// source the way the GLSL preprocessor would, and count sampler uniforms.
const fullSrc = readFileSync(path.join(ROOT, 'src/shaders/generated/mantle.frag.glsl'), 'utf8');
function applyDefines(src, defs) {
  const D = new Set(defs);
  // evaluate a #if expression over defined()/!/&&/|| against the define set
  const ev = (e) => {
    try {
      return !!Function(
        'return(' + e.replace(/defined\s*\(\s*(\w+)\s*\)/g, (m, n) => (D.has(n) ? '1' : '0')) + ')',
      )();
    } catch {
      return true;
    }
  };
  const out = [],
    st = []; // st: true = keep this branch
  for (const ln of src.split('\n')) {
    let m;
    if ((m = ln.match(/^\s*#ifndef\s+(\w+)/))) {
      st.push(!D.has(m[1]));
      continue;
    }
    if ((m = ln.match(/^\s*#ifdef\s+(\w+)/))) {
      st.push(D.has(m[1]));
      continue;
    }
    if ((m = ln.match(/^\s*#if\s+(.+)/))) {
      st.push(ev(m[1]));
      continue;
    }
    if (/^\s*#else/.test(ln)) {
      st[st.length - 1] = !st[st.length - 1];
      continue;
    }
    if (/^\s*#endif/.test(ln)) {
      st.pop();
      continue;
    }
    if (st.every(Boolean)) out.push(ln);
  }
  return out.join('\n');
}
const leanSrc = applyDefines(fullSrc, omit);
const sFull = (fullSrc.match(/uniform[^\n]*sampler/g) || []).length;
const sLean = (leanSrc.match(/uniform[^\n]*sampler/g) || []).length;
if (sLean < sFull)
  ok(`lean drops samplers ${sLean} vs full ${sFull} (#ifndef MANTLE_NO_* compiled out)`);
else fail(`lean did not drop samplers (${sLean} vs ${sFull})`);

// Solid-only content (the road / minimal-core case): no gradient/clip/mask/
// filter/recolor, so omitting ALL of FILL_FEATURES is valid and must render
// identically — this is the maximal lean variant (down to ~6 samplers).
const SVG = readFileSync(
  new URL('../examples/smoke/leanShaderRenderDiff__SVG.svg', import.meta.url),
  'utf8',
);

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="256" height="256"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const cnv = document.getElementById('c');
const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const W = 256, H = 256;
const sec = await importSvg(${JSON.stringify(SVG)});
const OMIT = ${JSON.stringify(omit)};

// The renderer auto-specializes the fill program per-bundle/per-draw, so a
// no-opts renderer would ALSO auto-lean, making this a lean-vs-lean compare.
// Force the TRUE full ubershader for the baseline via disableFillVariants; the
// defines path exercises the opts-forced lean variant. (Two separately-compiled
// identical-source programs can differ by 1 ULP at AA ties on some drivers, so
// the baseline must be the single default program to stay bit-exact.)
// One renderer per mode draws both scales (the scale is a draw argument).
const renderers = new Map();
function renderWith(defines, s) {
  const mode = defines ? 'lean' : 'full';
  if (!renderers.has(mode))
    renderers.set(mode, createRenderer(gl, shaders, defines ? { fillDefines: defines } : { disableFillVariants: true }));
  const renderer = renderers.get(mode);
  renderer.invalidateRenderState();
  renderer.setViewport(W, H);
  const bundle = createBundle(gl, sec);
  const wm = new Float32Array([s,0,0, 0,s,0, 0,0,1]);
  gl.clearColor(0,0,0,0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
  renderer.drawBundle(bundle, { worldMatrix: wm });
  const buf = new Uint8Array(W*H*4);
  gl.readPixels(0,0,W,H,gl.RGBA,gl.UNSIGNED_BYTE,buf);
  bundle.dispose();
  return buf;
}

const result = { compiled: false, perScale: [] };
try {
  for (const s of [1.0, 1.5]) {
    const a = renderWith(null, s);     // full ubershader
    const b = renderWith(OMIT, s);     // lean variant via #define
    let maxDiff = 0, nDiff = 0, ink = 0;
    for (let i = 0; i < a.length; i++) {
      const d = Math.abs(a[i]-b[i]);
      if (d > maxDiff) maxDiff = d;
      if (d !== 0) nDiff++;
      if (a[i] !== 0) ink++;
    }
    result.perScale.push({ s, maxDiff, nDiff, ink });
  }
  result.compiled = true;
} catch (e) { result.error = String(e); }
window.__result = result;
window.__done = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  const p = decodeURIComponent(u.pathname);
  const mime =
    p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
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
  if (m.type() === 'error') console.error('  [console]', m.text());
});
await page.goto(url, { waitUntil: 'load', timeout: 15000 });
await page
  .waitForFunction(() => window.__done === true, { timeout: 30000, polling: 100 })
  .catch(() => {});
const r = await page.evaluate(() => window.__result);
await browser.close();
server.close();

if (!r || !r.compiled) {
  fail('lean variant did not compile/render: ' + ((r && r.error) || 'page error'));
} else
  for (const ps of r.perScale) {
    if (ps.ink === 0) fail(`scale ${ps.s}: nothing rendered`);
    else if (ps.maxDiff === 0)
      ok(`scale ${ps.s}: lean (#define) == full byte-identical (ink=${ps.ink})`);
    else fail(`scale ${ps.s}: lean differs (maxDiff=${ps.maxDiff}, nDiff=${ps.nDiff})`);
  }
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log(
  '\nleanShaderRenderDiffSmoke: standard #ifndef/#define lean variant compiles, drops samplers, renders identical',
);
