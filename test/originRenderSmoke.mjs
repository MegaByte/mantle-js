// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// originRenderSmoke -- the GPU half of the per-bundle origin (bundle/layout.js, svg/importer.js).
//
// A bundle stores its coordinates RELATIVE to an origin (a float64 pair, subtracted before the float32 store), because a float32 at 1e7
// spaces 1.0 apart and unit-sized art there would be a smear. The draw fits the content box, so nothing in the shaders changes; what this
// proves is that no importer path left a coordinate behind (gradients, patterns, clips, masks, filter regions, text, images) and that
// far art draws as the same art does at the document origin.
//   (1) CORPUS: every SVG under examples/, B (origin forced near the art) against A (origin: false), one fresh bundle per draw. A then B
//       must agree to 2/255 with no pixel over 40; an asset that does not is drawn again, B then A (the order A B B A), and its two pairs
//       must agree to their own A/A floor (+2/255): a coordinate the importer did not shift shows as an asset whose B differs.
//   (2) FAR CELLS: art 1 unit wide at offset 0, 1e4, 1e5, 1e6, 1e7 and scale 2^-10, 1, 2^10 (offset in document units, the art scales),
//       five cases, auto origin. Each must equal the offset-0 picture of its own scale and engine to 2/255, and sit as close to Chrome's
//       own raster of the offset-0 art at 8x, box averaged (the project's AA reference), as the offset-0 picture does (+2/255 on the
//       mean). The `origin: false` arm at 1e6 and 1e7 (unit-sized art, 2^0) must be WRONG (> 8/255 somewhere): the cells would pass
//       vacuously if it were not.
// ORIGIN_ONLY=corpus|cells selects a phase; ORIGIN_ENGINES=slug,aac,lb,cpatch,gwn the engines of the cells.
// Run whole, the corpus draws in parts of 100 assets and the cells in one more part, each in a process and browser of its
// own. ORIGIN_PART=corpus:k/K runs corpus part k of K alone (assets 100(k-1) to 100k-1) and ORIGIN_PART=cells:k/K the
// cells of the k-th of the K default engines alone: the render lane lists these parts as entries of their own
// (test/originRenderCorpus<k>Smoke.mjs, test/originRenderCells<k>Smoke.mjs), so they spread across its workers. The last
// part of each fails when the parts no longer cover the whole corpus or every default engine.
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import zlib from 'zlib';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { pageTimeoutFor } from './_laneBudget.mjs';

const ROOT =
  process.env.MANTLE_SRC_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +process.env.ORIGIN_N || 128;
// corpus assets one browser draws: a browser draws blank frames after about 150
const PER_BROWSER = 100;
const DEFAULT_ENGINES = ['slug', 'aac', 'lb'];
const PART = /^(corpus|cells):(\d+)\/(\d+)$/.exec(process.env.ORIGIN_PART || '');
if (process.env.ORIGIN_PART && !(PART && +PART[2] >= 1 && +PART[2] <= +PART[3]))
  throw new Error(
    `ORIGIN_PART=${process.env.ORIGIN_PART}: expected corpus:k/K or cells:k/K with 1 <= k <= K`,
  );
if (PART) {
  const k = +PART[2];
  process.env.ORIGIN_ONLY = PART[1];
  if (PART[1] === 'corpus') {
    process.env.ORIGIN_FROM = String((k - 1) * PER_BROWSER);
    process.env.ORIGIN_TO = String(k * PER_BROWSER);
  } else {
    if (!DEFAULT_ENGINES[k - 1])
      throw new Error(
        `ORIGIN_PART=cells:${k}/${PART[3]}: there are only ${DEFAULT_ENGINES.length} default engines`,
      );
    process.env.ORIGIN_ENGINES = DEFAULT_ENGINES[k - 1];
  }
}
// The two phases run in two browsers: one browser that has drawn the whole corpus draws blank frames afterwards (a reload of the page does not
// clear it; a new browser does), and a blank frame equals a blank frame, so the cells also ask for ink.
if (!process.env.ORIGIN_ONLY && !process.env.ORIGIN_ASSET) {
  const { spawnSync } = await import('child_process');
  let rc = 0;
  // (a browser draws blank frames after about 150 corpus assets: 100 a browser)
  const total = ['examples/smoke', 'examples'].reduce(
    (n, d) => n + readdirSync(path.join(ROOT, d)).filter((f) => f.endsWith('.svg')).length,
    0,
  );
  const phase = (env) => {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, ...env },
      stdio: 'inherit',
      timeout: pageTimeoutFor(180000),
      killSignal: 'SIGTERM',
    });
    if (r.error || r.signal || r.status == null) {
      console.error('origin phase did not complete:', env, r.error?.message || r.signal);
      return 1;
    }
    return r.status;
  };
  for (let from = 0; from < total; from += PER_BROWSER)
    rc =
      phase({
        ORIGIN_ONLY: 'corpus',
        ORIGIN_FROM: String(from),
        ORIGIN_TO: String(from + PER_BROWSER),
      }) || rc;
  rc = phase({ ORIGIN_ONLY: 'cells' }) || rc;
  process.exit(rc);
}
const ONLY = process.env.ORIGIN_ONLY || '';
const ENGINES = (process.env.ORIGIN_ENGINES || DEFAULT_ENGINES.join(',')).split(',');
const FORCED = [4096.5, -2048.25];
// Assets whose picture sits on a knife edge that a translation alone flips (3-12 pixels, 0 <-> 255, every engine, any translation): half-ellipse
// arcs (radius exactly half the chord). They are drawn, not compared.
// examples/smoke/filterCache__blurSvg.svg leaves the browser drawing blank frames (it is left out)
const SKIP = new Set(['examples/smoke/filterCache__blurSvg.svg']);
const TIES = new Set(['examples/smoke/arcRebuildEquivariance__ARC_SVG.svg']);
// Art at y about 1e5 on purpose: the origin-free picture rounds those coordinates in float32, and the same art drawn near zero reads 1-2 under the same origins. Every engine reads at most 4 here; which engine auto takes depends on the corpus position.
const FAR_ALLOW = new Map([['examples/smoke/noAaArcRow__FAR.svg', 4]]);
const CORPUS = [];
for (const dir of ['examples/smoke', 'examples']) {
  for (const f of readdirSync(path.join(ROOT, dir)).sort())
    if (f.endsWith('.svg')) CORPUS.push(dir + '/' + f);
}

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script>globalThis.__MANTLE_DEBUG__ = true;</script>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl0 = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true, stencil: ${process.env.ORIGIN_STENCIL ? 'true' : 'false'}, depth: true });
// ORIGIN_GLTRACE=1: every call is followed by getError; the first error's call and stack ride the next result (a diagnosis for a 'gl 128x' cell)
let glSite = null;
const gl = ${process.env.ORIGIN_GLTRACE ? 'true' : 'false'} ? new Proxy(gl0, { get(t, k) { const v = t[k]; if (typeof v !== 'function') return v; return (...a) => { const r = v.apply(t, a); if (k !== 'getError' && !glSite) { const e = t.getError(); if (e) glSite = k + ' err ' + e + ' args ' + a.slice(0, 6).map((x) => (x && x.constructor && x.constructor.name) === 'Object' ? '{}' : typeof x === 'object' && x ? (x.constructor && x.constructor.name) : String(x)).join(',') + ' @ ' + new Error().stack.split('\\n').slice(2, 6).join(' | '); } return r; }; } }) : gl0;
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
// the plain renderer for every engine but GWN: the GWN defines compile every variant with the winding kernel in, which is not what the other
// engines draw (and a page of GWN-defined filters drew blank frames); GWN gets a renderer of its own, made when it is first asked for
const R0 = createRenderer(gl, shaders, {}); if (R0.ready) await R0.ready;
let RG = null;
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const ARM = { slug: [{ route: 'none', kernel: 'slug' }, {}], aac: [{ route: 'none', kernel: 'aac' }, {}], lb: [{ route: 'lb', kernel: 'slug' }, {}],
  cpatch: [{ route: 'cpatch', kernel: 'slug' }, {}], gwn: [{ route: 'none' }, { gwnTree: true }], auto: [{ route: 'auto', kernel: 'auto', commit: false }, {}] };
const f = String;
// one draw of an SVG text: a fresh bundle, frames until two in a row read the same
window.__draw = async (svg, arm, origin) => {
  const [sel, io] = ARM[arm];
  if (arm === 'gwn' && !RG) { RG = createRenderer(gl, shaders, { fillDefines: ['MANTLE_GWN', 'MANTLE_GWN_SDF'] }); if (RG.ready) await RG.ready; }
  const R = arm === 'gwn' ? RG : R0;
  R.setFillEngine(sel);
  while (gl.getError() !== 0) { /* an earlier draw's error is not this one's */ }
  glSite = null;
  let b, bbox = null;
  try {
    const o = Object.assign({ preserveViewport: true }, io);
    if (origin !== undefined) o.origin = origin;
    const sec = await importSvg(svg, o); bbox = sec.globalBBox;
    b = createBundle(gl, sec);
    // the bundle's own async builds (the worker occlusion cull, the occupancy grids) land before the picture is taken: they decide what is drawn
    const t0 = performance.now();
    while ((b._occupancyBuildPending || b._occlusionCullPending) && performance.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 10));
  } catch (e) { return { err: 'import: ' + e.message }; }
  const err = [];
  let prev = '';
  try {
    R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
    if (R.prepareBundle) R.prepareBundle(b);
    const want = arm === 'lb' || arm === 'cpatch' ? arm : null, eng0 = Object.assign({}, (R.debugStats.engines || {}).draws || {}), tEng = performance.now();
    for (let i = 0; i < 120; i++) {
      R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
      // a pinned Loop-Blinn / CPatch route draws Slug until its meshes land: the picture counts once the pinned engine has drawn
      if (want && (((R.debugStats.engines || {}).draws || {})[want] || 0) === (eng0[want] || 0) && performance.now() - tEng < 8000) { await new Promise((r) => setTimeout(r, 20)); i = Math.min(i, 1); continue; }
      const p = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, p);
      const h = b64(p);
      if (i >= 2 && h === prev) break;
      prev = h; if (i >= 2) await new Promise((r) => setTimeout(r, 10));
    }
    if (want && ((((R.debugStats.engines || {}).draws || {})[want] || 0) <= (eng0[want] || 0))) err.push('requested engine never drew');
  } catch (e) { err.push('draw ' + e.message); }
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const glErr = gl.getError();
  const origin2 = b.origin.slice(); const site = glSite; glSite = null;
  b.dispose && b.dispose();
  return { px: b64(px), origin: origin2, bbox, numShapes: b.numShapes, err: err.join(';') || (glErr ? 'gl ' + glErr + (site ? ' ' + site : '') : '') };
};
// Chrome's own raster of an SVG at 8N, box averaged to N (RGB over an opaque background; row 0 = top)
window.__chrome8 = async (svg) => {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = ${N} * 8; c.height = ${N} * 8;
  const x = c.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, ${N} * 8, ${N} * 8); x.drawImage(img, 0, 0, ${N} * 8, ${N} * 8);
  const big = x.getImageData(0, 0, ${N} * 8, ${N} * 8).data, out = new Uint8Array(${N} * ${N} * 4);
  for (let y = 0; y < ${N}; y++) for (let xx = 0; xx < ${N}; xx++) {
    const acc = [0, 0, 0];
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = ((y * 8 + j) * ${N} * 8 + xx * 8 + i) * 4; acc[0] += big[k]; acc[1] += big[k + 1]; acc[2] += big[k + 2]; }
    const o = (y * ${N} + xx) * 4; out[o] = acc[0] / 64 + 0.5; out[o + 1] = acc[1] / 64 + 0.5; out[o + 2] = acc[2] / 64 + 0.5; out[o + 3] = 255;
  }
  URL.revokeObjectURL(url);
  return b64(out);
};
// the far cells: (S, o) => svg. The art is 128 S wide in a viewBox of exactly that, at (o, o), over a full-frame background.
const open = (S, o) => '<' + 'svg xmlns="http://www.w3.org/2000/svg" viewBox="' + f(o) + ' ' + f(o) + ' ' + f(128 * S) + ' ' + f(128 * S) + '" width="${N}" height="${N}">';
const BG = (S, o) => '<rect x="' + f(o) + '" y="' + f(o) + '" width="' + f(128 * S) + '" height="' + f(128 * S) + '" fill="#e8e8e8"/>';
// the art sits 0.9937 of the way across the box and 0.37 of a unit in: with the box exactly the device (one art unit a pixel) every edge would lie on a pixel boundary, where a coverage tie goes either way
const P = (S, o, d, a) => '<path d="' + d.replace(/(-?\\d+\\.?\\d*)\\s+(-?\\d+\\.?\\d*)/g, (m, x, y) => f(+x * S * 0.9937 + 0.37 * S + o) + ' ' + f(+y * S * 0.9937 + 0.37 * S + o)) + '" ' + a + '/>';
const G2 = (id, a) => '<linearGradient id="' + id + '" ' + a + '><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>';
const CASES = {
  // curves: a circle of arcs, a quad leaf
  fill: (S, o) => open(S, o) + BG(S, o) + P(S, o, 'M104 64 C104 86 86 104 64 104 C42 104 24 86 24 64 C24 42 42 24 64 24 C86 24 104 42 104 64 Z', 'fill="#c0392b"')
    + P(S, o, 'M20 100 Q64 10 108 100 Z', 'fill="#2980b9" fill-opacity="0.8"') + '</svg>',
  // stroke: round joins, a dashed curve
  stroke: (S, o) => open(S, o) + BG(S, o) + P(S, o, 'M16 100 L48 24 L80 100 L112 24', 'fill="none" stroke="#c0392b" stroke-width="' + f(8 * S) + '" stroke-linejoin="round"')
    + P(S, o, 'M14 110 C40 40 80 160 114 60', 'fill="none" stroke="#000" stroke-width="' + f(3 * S) + '" stroke-dasharray="' + f(10 * S) + ' ' + f(6 * S) + '"') + '</svg>',
  // user-space paint: a gradient, a pattern, a clip and a mask, all in document coordinates
  paint: (S, o) => open(S, o) + BG(S, o) + '<defs>' + G2('g', 'gradientUnits="userSpaceOnUse" x1="' + f(20 * S + o) + '" y1="' + f(o) + '" x2="' + f(108 * S + o) + '" y2="' + f(o) + '"')
    + '<pattern id="p" patternUnits="userSpaceOnUse" x="' + f(o) + '" y="' + f(o) + '" width="' + f(16 * S) + '" height="' + f(16 * S) + '"><rect width="' + f(8 * S) + '" height="' + f(8 * S) + '" fill="#c00"/><rect x="' + f(8 * S) + '" y="' + f(8 * S) + '" width="' + f(8 * S) + '" height="' + f(8 * S) + '" fill="#00c"/></pattern>'
    + '<clipPath id="c"><circle cx="' + f(90 * S + o) + '" cy="' + f(90 * S + o) + '" r="' + f(24 * S) + '"/></clipPath>'
    + '<mask id="m"><rect x="' + f(o) + '" y="' + f(o) + '" width="' + f(64 * S) + '" height="' + f(128 * S) + '" fill="#fff"/></mask></defs>'
    + P(S, o, 'M10 10 L118 10 L118 50 L10 50 Z', 'fill="url(#g)"') + P(S, o, 'M10 56 L70 56 L70 118 L10 118 Z', 'fill="url(#p)"')
    + '<rect x="' + f(66 * S + o) + '" y="' + f(66 * S + o) + '" width="' + f(52 * S) + '" height="' + f(52 * S) + '" fill="#080" clip-path="url(#c)"/>'
    + '<rect x="' + f(o) + '" y="' + f(o) + '" width="' + f(128 * S) + '" height="' + f(8 * S) + '" fill="#000" mask="url(#m)"/></svg>',
  // filters, one primitive family each: a blur, a user-space region with an offset, turbulence
  filterBlur: (S, o) => open(S, o) + BG(S, o) + '<defs><filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="' + f(5 * S) + '"/></filter></defs>'
    + P(S, o, 'M24 24 L60 24 L60 60 L24 60 Z', 'fill="#c00" filter="url(#f)"') + '</svg>',
  filterRegion: (S, o) => open(S, o) + BG(S, o) + '<defs><filter id="r" filterUnits="userSpaceOnUse" x="' + f(60 * S + o) + '" y="' + f(60 * S + o) + '" width="' + f(60 * S) + '" height="' + f(60 * S) + '"><feOffset dx="' + f(8 * S) + '" dy="' + f(8 * S) + '"/></filter></defs>'
    + P(S, o, 'M64 64 L100 64 L100 100 L64 100 Z', 'fill="#080" filter="url(#r)"') + '</svg>',
  filterTurb: (S, o) => open(S, o) + BG(S, o) + '<defs><filter id="t" x="0" y="0" width="1" height="1"><feTurbulence type="fractalNoise" baseFrequency="' + f(0.05 / S) + '" numOctaves="2" seed="3"/></filter></defs>'
    + P(S, o, 'M12 70 L56 70 L56 116 L12 116 Z', 'fill="#000" filter="url(#t)"') + '</svg>',
  // a scene graph: the art is drawn near zero inside a group translated to the far position (the CTM carries the offset)
  nested: (S, o) => open(S, o) + BG(S, o) + '<g transform="translate(' + f(o) + ' ' + f(o) + ') rotate(12 ' + f(64 * S) + ' ' + f(64 * S) + ')"><g transform="scale(' + f(S) + ')">'
    + '<path d="M20 20 H100 V100 H20 Z" fill="#8e44ad"/><circle cx="64" cy="64" r="30" fill="#f1c40f" stroke="#000" stroke-width="4"/></g></g></svg>',
};
window.__svg = (name, S, o) => CASES[name](S, o);
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
    res.writeHead(200, {
      'content-type': p.endsWith('.glsl')
        ? 'text/plain'
        : p.endsWith('.svg')
          ? 'image/svg+xml'
          : 'text/javascript',
    });
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
const URL0 = 'http://127.0.0.1:' + server.address().port + '/';
await page.goto(URL0, { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 100 });

// ORIGIN_DUMP=dir: write a few pictures (top-down PNG) to look at
const png = (px) => {
  const raw = Buffer.alloc((N * 4 + 1) * N);
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0;
    Buffer.from(px.buffer, px.byteOffset + (N - 1 - y) * N * 4, N * 4).copy(
      raw,
      y * (N * 4 + 1) + 1,
    );
  }
  const crcT = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcT[n] = c >>> 0;
  }
  const crc = (b) => {
    let c = 0xffffffff;
    for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t, d) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(N, 0);
  ih.writeUInt32BE(N, 4);
  ih[8] = 8;
  ih[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ih),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};
const dump = (name, px) => {
  if (process.env.ORIGIN_DUMP && px)
    writeFileSync(process.env.ORIGIN_DUMP + '/' + name + '.png', png(px));
};
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
// A part says what it draws, and the last part of a phase checks that the lane's parts still cover all of it.
if (PART) {
  const [, phase, k, parts] = PART;
  const what =
    phase === 'corpus'
      ? `assets ${process.env.ORIGIN_FROM}..${Math.min(+process.env.ORIGIN_TO, CORPUS.length) - 1}`
      : `engine ${ENGINES.join(',')}`;
  console.log(`  ${phase} part ${k}/${parts}: ${what}`);
  if (k === parts) {
    if (phase === 'corpus' && +parts * PER_BROWSER < CORPUS.length)
      fail(
        `the corpus holds ${CORPUS.length} assets and its ${parts} parts of ${PER_BROWSER} draw ` +
          `${+parts * PER_BROWSER}: add test/originRenderCorpus${+parts + 1}Smoke.mjs and its runner ` +
          `entry, and raise every part's K`,
      );
    else if (phase === 'cells' && +parts !== DEFAULT_ENGINES.length)
      fail(
        `the cells run ${DEFAULT_ENGINES.length} default engines (${DEFAULT_ENGINES.join(', ')}) in ` +
          `${parts} parts: give every engine its part`,
      );
    else ok(`the ${parts} ${phase} parts cover the whole ${phase}`);
  }
}
const unb = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const draw = async (svg, arm, origin) => {
  const r = await page.evaluate((a, b, c) => window.__draw(a, b, c), svg, arm, origin);
  if (r.px) r.px = unb(r.px);
  return r;
};
const maxDiff = (a, b) => {
  let m = 0,
    n = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
    if (d > 40) n++;
  }
  return [m, n];
};
const where = (a, b) => {
  const w = [];
  for (let i = 0; i < N * N && w.length < 6; i++) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i * 4 + c] - b[i * 4 + c]));
    if (d > 40)
      w.push(
        '(' +
          (i % N) +
          ',' +
          (N - 1 - ((i / N) | 0)) +
          ') ' +
          Array.from(a.slice(i * 4, i * 4 + 3)) +
          '->' +
          Array.from(b.slice(i * 4, i * 4 + 3)),
      );
  }
  return w.join('; ');
};
const flip = (px) => {
  const o = new Uint8Array(px.length);
  for (let y = 0; y < N; y++) o.set(px.subarray((N - 1 - y) * N * 4, (N - y) * N * 4), y * N * 4);
  return o;
};
const meanErr = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 4)
    for (let c = 0; c < 3; c++) s += Math.abs(a[i + c] - b[i + c]);
  return s / ((a.length / 4) * 3);
};

if (process.env.ORIGIN_ASSET) {
  // ORIGIN_ASSET=examples/tiger.svg: one asset under several origins, per engine, against its origin-free picture (a diagnosis, no verdict)
  const svg = readFileSync(path.join(ROOT, process.env.ORIGIN_ASSET), 'utf8');
  for (const arm of ['slug', 'aac', 'lb', 'cpatch', 'auto']) {
    const a = await draw(svg, arm, false),
      a2 = await draw(svg, arm, false);
    const line = [];
    for (const o of (process.env.ORIGIN_ORGS
      ? JSON.parse(process.env.ORIGIN_ORGS)
      : [
          [0.5, 0.25],
          [64.5, -32.25],
          [436, 450],
          [512, 512],
          [2048.5, -1024.25],
        ]
    ).slice(0, +process.env.ORIGIN_NORGS || 9)) {
      const b = await draw(svg, arm, o);
      if (b.px && maxDiff(a.px, b.px)[1] > 0) {
        // where: the pixels over 40 (x, y top-left; A rgba -> B rgba)
        const w = [];
        for (let i = 0; i < N * N && w.length < 8; i++) {
          let d = 0;
          for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.px[i * 4 + c] - b.px[i * 4 + c]));
          if (d > 40)
            w.push(
              '(' +
                (i % N) +
                ',' +
                (N - 1 - ((i / N) | 0)) +
                ') ' +
                Array.from(a.px.slice(i * 4, i * 4 + 4)) +
                '->' +
                Array.from(b.px.slice(i * 4, i * 4 + 4)),
            );
        }
        console.log('  where ' + arm + ' ' + JSON.stringify(o) + ': ' + w.join('; '));
      }
      line.push(JSON.stringify(o) + ':' + (b.px ? maxDiff(a.px, b.px).join('/') : b.err));
    }
    console.log(
      'ASSET ' +
        process.env.ORIGIN_ASSET +
        ' ' +
        arm +
        ' A/A ' +
        maxDiff(a.px, a2.px).join('/') +
        '  ' +
        line.join('  '),
    );
  }
  await browser.close();
  server.close();
  process.exit(0);
}
if (ONLY !== 'cells') {
  let bad = 0,
    drawn = 0,
    repeated = 0,
    skipped = 0,
    blankRun = 0;
  const s_reloaded = new Set();
  const t0 = Date.now();
  // warm: every program a corpus asset needs is compiled before the first compared draw (the first arm in a page differs by 1/255)
  for (const rel of CORPUS.slice(
    +process.env.ORIGIN_FROM || 0,
    +process.env.ORIGIN_TO || CORPUS.length,
  )) {
    // a fresh page every 64 assets: one page left alone draws blank frames after a few hundred (see the cells below), and blank equals blank
    if (drawn > 0 && drawn % 64 === 0 && !s_reloaded.has(drawn)) {
      s_reloaded.add(drawn);
      await page.goto(URL0, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 100 });
    }
    const svg = readFileSync(path.join(ROOT, rel), 'utf8');
    if (SKIP.has(rel)) continue;
    const a1 = await draw(svg, 'auto', false);
    if (!a1.px) {
      skipped++;
      continue;
    }
    // a forced origin near the art (its box center, snapped to a power of two): the origin an app would pin, and the one whose
    // coordinates are no worse than the origin-free ones (a far arbitrary one is a precision test of its own)
    const box = a1.bbox,
      e = Math.max(box[2], box[3]),
      step = e > 0 ? 2 ** Math.floor(Math.log2(e)) : 1;
    const org = [
      Math.round((box[0] + box[2] / 2) / step) * step + 0.5 * step,
      Math.round((box[1] + box[3] / 2) / step) * step - 0.25 * step,
    ];
    {
      let ink = 0;
      for (let i = 0; i < a1.px.length; i += 4)
        if (a1.px[i] !== a1.px[0] || a1.px[i + 1] !== a1.px[1] || a1.px[i + 2] !== a1.px[2]) {
          ink++;
          break;
        }
      blankRun = ink ? 0 : blankRun + 1;
      if (blankRun >= 40) {
        fail(
          'the page has drawn 40 blank pictures in a row (' +
            rel +
            '): the corpus is not being compared',
        );
        break;
      }
    }
    const b1 = await draw(svg, 'auto', org);
    if (!b1.px) {
      fail(rel + ': ' + b1.err);
      bad++;
      continue;
    }
    drawn++;
    if ((drawn & 63) === 0)
      console.log(
        '  .. ' +
          drawn +
          ' assets drawn, ' +
          repeated +
          ' drawn twice, ' +
          bad +
          ' bad, ' +
          ((Date.now() - t0) / 1000).toFixed(0) +
          ' s',
      );
    const allow = FAR_ALLOW.get(rel) ?? 2;
    const [ab1, n1] = maxDiff(a1.px, b1.px);
    if (TIES.has(rel)) {
      if (process.env.ORIGIN_VERBOSE) console.log('  (tie) ' + rel + ' A/B ' + ab1);
      continue;
    }
    if (b1.numShapes > 0 && (b1.origin[0] !== org[0] || b1.origin[1] !== org[1])) {
      fail(rel + ': the bundle origin is ' + b1.origin + ', not the one asked for');
      bad++;
      continue;
    }
    // A/B within the allowance on a floor of 0 passes as it is: the repeat only measures the A/A floor, which can only widen the bound
    if (ab1 <= allow && n1 === 0) {
      if (process.env.ORIGIN_VERBOSE) ok(rel + ' (A/B ' + ab1 + ')');
      continue;
    }
    repeated++;
    const b2 = await draw(svg, 'auto', org),
      a2 = await draw(svg, 'auto', false);
    if (!b2.px || !a2.px) {
      fail(rel + ': ' + (b2.err || a2.err));
      bad++;
      continue;
    }
    const [aa] = maxDiff(a1.px, a2.px),
      [bb] = maxDiff(b1.px, b2.px);
    const [ab2, n2] = maxDiff(a2.px, b2.px);
    const floor = Math.max(aa, bb),
      ab = Math.max(ab1, ab2),
      n = Math.max(n1, n2);
    if (floor > 40) {
      skipped++;
      continue;
    } // an asset whose own two pictures differ (async CPatch certification): nothing to compare against
    if (ab <= floor + allow && n === 0) {
      if (process.env.ORIGIN_VERBOSE) ok(rel + ' (A/A ' + aa + ', B/B ' + bb + ', A/B ' + ab + ')');
    } else {
      // A differs from B: which is nearer Chrome's own raster at 8x, box averaged (the project's AA reference)? Only a square viewBox frames the same in both.
      const sq = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg);
      let verdict = null;
      if (sq && sq[1] === sq[2]) {
        const sized = svg.replace(
          /<svg\b([^>]*)>/,
          (m, a) =>
            '<svg' +
            a.replace(/\s(width|height)="[^"]*"/g, '') +
            ' width="' +
            N +
            '" height="' +
            N +
            '">',
        );
        const ref = flip(unb(await page.evaluate((t) => window.__chrome8(t), sized)));
        verdict = [meanErr(a1.px, ref), meanErr(b1.px, ref)];
      }
      if (verdict && verdict[1] <= verdict[0] + 0.25)
        console.log(
          '  note ' +
            rel +
            ': A/B ' +
            ab +
            ' (' +
            n +
            ' px over 40); the origin picture is as near Chrome 8x as the origin-free one (' +
            verdict[1].toFixed(2) +
            ' vs ' +
            verdict[0].toFixed(2) +
            ' mean 8-bit error): the baseline is the odd one',
        );
      else {
        fail(
          rel +
            ' differs under an origin: A/B ' +
            ab +
            ' (' +
            n +
            ' px over 40) against an A/A floor of ' +
            floor +
            (verdict
              ? '; Chrome 8x error origin-free ' +
                verdict[0].toFixed(2) +
                ', origin ' +
                verdict[1].toFixed(2)
              : ''),
        );
        bad++;
      }
    }
  }
  if (!bad)
    ok(
      'corpus: ' +
        drawn +
        ' assets drawn under a forced origin equal the origin-free picture (to the A/A floor + 2; ' +
        repeated +
        ' drawn twice)' +
        (skipped ? ' (' + skipped + ' did not import)' : ''),
    );
}

if (ONLY !== 'corpus') {
  // a fresh page: after hundreds of corpus assets this page draws blank frames (a renderer left in a state no cell should inherit), which made every
  // cell compare white with white -- so the cells also insist that their control is not blank
  if (ONLY !== 'cells') {
    await page.goto(URL0, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true, { timeout: 90000, polling: 100 });
  }
  const OFFS = [0, 1e4, 1e5, 1e6, 1e7],
    KS = [-10, 0, 10];
  // Chrome's raster of a case at a scale does not depend on the engine: drawn once, read by every engine
  const refs = new Map();
  for (const arm of ENGINES) {
    for (const name of (
      process.env.ORIGIN_CASES || 'fill,stroke,paint,filterBlur,filterRegion,filterTurb,nested'
    ).split(',')) {
      let bad = 0,
        cells = 0,
        unfixedWorst = 0;
      const UNFIXED = (globalThis.__unfixed ||= {});
      for (const k of KS) {
        const S = (2 ** k / 128) * 1.0173,
          svg0 = await page.evaluate((n, s) => window.__svg(n, s, 0), name, S);
        const control = await draw(svg0, arm);
        if (!control.px) {
          fail(arm + ' ' + name + ' control: ' + control.err);
          bad++;
          continue;
        }
        {
          let ink = 0;
          for (let i = 0; i < control.px.length; i += 4)
            if (
              Math.abs(control.px[i] - control.px[0]) +
                Math.abs(control.px[i + 1] - control.px[1]) >
              24
            )
              ink++;
          if (ink < 40) {
            fail(
              arm +
                ' ' +
                name +
                ' art 2^' +
                k +
                ': the control picture is blank (' +
                ink +
                ' px differ from the corner) -- nothing to compare',
            );
            bad++;
            continue;
          }
        }
        const refKey = name + ' ' + k;
        if (!refs.has(refKey))
          refs.set(refKey, flip(unb(await page.evaluate((s) => window.__chrome8(s), svg0))));
        const ref = refs.get(refKey);
        const base = meanErr(control.px, ref);
        for (const o of OFFS) {
          if (o === 0) continue;
          const svg = await page.evaluate((n, s, off) => window.__svg(n, s, off), name, S, o);
          const r = await draw(svg, arm);
          cells++;
          if (!r.px || r.err) {
            fail(arm + ' ' + name + ' art 2^' + k + ' o=' + o + ': ' + r.err);
            bad++;
            continue;
          }
          const [m, n] = maxDiff(r.px, control.px);
          const e = meanErr(r.px, ref);
          if (!(m <= 2)) {
            fail(
              arm +
                ' ' +
                name +
                ' art 2^' +
                k +
                ' o=' +
                o +
                ' differs from its offset-0 picture: max ' +
                m +
                ', ' +
                n +
                ' px over 40: ' +
                where(control.px, r.px),
            );
            bad++;
          } else if (!(e <= base + 2)) {
            fail(
              arm +
                ' ' +
                name +
                ' art 2^' +
                k +
                ' o=' +
                o +
                ': mean error against Chrome 8x ' +
                e.toFixed(2) +
                ' vs ' +
                base.toFixed(2) +
                ' at offset 0',
            );
            bad++;
          }
          // the origin-free negative control: unit-sized art at 1e6 and 1e7, where float32 spaces 1/16 and 1 unit apart
          if (o >= 1e6 && k === 0) {
            const u = await draw(svg, arm, false);
            if (k === 0 && o === 1e6) {
              dump(arm + '_' + name + '_control', control.px);
              dump(arm + '_' + name + '_auto', r.px);
              dump(arm + '_' + name + '_unfixed', u.px);
            }
            if (u.px) {
              unfixedWorst = Math.max(unfixedWorst, maxDiff(u.px, control.px)[0]);
              if (process.env.ORIGIN_VERBOSE)
                console.log(
                  '    unfixed ' +
                    o +
                    ' origin ' +
                    u.origin +
                    ' diff ' +
                    maxDiff(u.px, control.px) +
                    ' err [' +
                    u.err +
                    '] numShapes ' +
                    u.numShapes,
                );
            } else
              console.log(
                '  (' +
                  arm +
                  ' ' +
                  name +
                  ' origin-free arm at ' +
                  o +
                  ' drew nothing: ' +
                  u.err +
                  ')',
              );
          }
        }
      }
      if (!bad)
        ok(
          arm +
            ' ' +
            name +
            ': ' +
            cells +
            ' far cells (unit-sized art 2^-10..2^10 wide at offset 1e4..1e7) equal the offset-0 picture to 2/255 and sit as near Chrome 8x as it does',
        );
      UNFIXED[arm] = Math.max(UNFIXED[arm] || 0, unfixedWorst);
      console.log(
        '  (' +
          arm +
          ' ' +
          name +
          ': the origin-free arm is off by up to ' +
          unfixedWorst +
          '/255 at 1e6..1e7, art 2^0)',
      );
    }
  }
}
if (ONLY !== 'corpus')
  for (const arm of ENGINES) {
    const w = (globalThis.__unfixed || {})[arm] || 0;
    if (!(w > 8))
      fail(
        arm +
          ': the origin-free arm is never wrong at 1e6 and 1e7 in any case at 2^0 (worst ' +
          w +
          ') -- the cells prove nothing',
      );
    else
      ok(
        arm +
          ': the origin-free arm is wrong at 1e6..1e7 (worst ' +
          w +
          '/255), so the cells can fail',
      );
  }
await browser.close();
server.close();
if (failures) {
  console.error('ORIGIN RENDER FAIL (' + failures + ')');
  process.exit(1);
}
console.log('ORIGIN RENDER PASS');
