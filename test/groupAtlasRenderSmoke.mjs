// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// groupAtlasRenderSmoke -- a run of faded plain groups shares ONE accumulator (the group atlas), and the picture is the same.
//
// A faded fill+stroke leaf (`opacity` below 1 on a shape that paints both) is one composited group; a faded grid of
// instances is one group per layer. On its own accumulator each pays a render-pass pair, a fixed cost on a tile-based GPU
// whatever the group's size. renderer.js R._atlasTryBegin gives every group of a run a SLOT of one atlas and
// composites the slots in painter order when the run ends.
//
// Each cell is rendered twice at 128 px on a white ground, under four fill engines (auto, classic Slug, classic AAC, unified Loop-Blinn):
//   on    a renderer with the atlas (the default);
//   off   a renderer built with `groupAtlas: false` (every group its own accumulator, the reference without the atlas).
// The two must agree within 1/255 (the composite samples the same texels at the same pixel centers; the atlas's power-of-two size makes its sample coordinates exact where a canvas-sized accumulator's remap rounds, which moves a handful of pixels by one level), and each must match Chrome's own 8x
// raster of the document box-averaged to 128 px (the AA reference of this repo) to a mean 1.5/255. `on` must also have used the
// atlas (debugStats.groupAtlasSlots > 0, one pass for the run), and `off` must not have.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bare = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${body}</svg>`;
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" fill="white"/>${body}</svg>`;
const leaf = (x, y, w, h, fill, stroke, sw, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" ${extra}/>`;
const row = (n, op, extra = '') =>
  Array.from({ length: n }, (_, i) =>
    leaf(
      2 + i * 10,
      8,
      8,
      40,
      `hsl(${i * 50} 80% 50%)`,
      `hsl(${(i * 50 + 150) % 360} 80% 30%)`,
      2,
      `opacity="${op}" ${extra}`,
    ),
  ).join('');
const cluster = (n, op) =>
  Array.from({ length: n }, (_, i) =>
    leaf(
      6 + (i % 4) * 7,
      6 + Math.floor(i / 4) * 9,
      22,
      22,
      `hsl(${i * 37} 80% 50%)`,
      `hsl(${(i * 37 + 150) % 360} 80% 25%)`,
      4,
      `opacity="${op}"`,
    ),
  ).join('');
const big = (n, op) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<circle cx="${20 + ((i * 7) % 30)}" cy="${20 + ((i * 11) % 30)}" r="${28 + (i % 3)}" fill="hsl(${i * 23} 70% 50%)" stroke="hsl(${(i * 23 + 120) % 360} 70% 25%)" stroke-width="3" opacity="${op}"/>`,
  ).join('');
const far = (n, op) =>
  Array.from({ length: n }, (_, i) =>
    leaf(
      2 + (i % 8) * 7.5,
      6 + Math.floor(i / 8) * 30,
      2,
      24,
      `hsl(${i * 40} 80% 50%)`,
      `hsl(${(i * 40 + 150) % 360} 80% 30%)`,
      1,
      `opacity="${op(i)}"`,
    ),
  ).join('');
const tiny = (n, op) =>
  Array.from({ length: n }, (_, i) =>
    leaf(
      1 + (i % 10) * 6.3,
      1 + Math.floor(i / 10) * 6.3,
      2.4,
      2.4,
      `hsl(${i * 13} 80% 50%)`,
      `hsl(${(i * 13 + 150) % 360} 80% 30%)`,
      0.6,
      `opacity="${op(i)}"`,
    ),
  ).join('');
const GRAD =
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient></defs>';
const MASK = '<mask id="m"><rect width="64" height="64" fill="#808080"/></mask>';

const CELLS = [
  {
    name: 'eight far-apart faded fill+stroke leaves (one merged run, one draw)',
    svg: doc(far(8, () => 0.5)),
    merged: 8,
  },
  {
    name: 'sixteen far-apart leaves at opacities .2 to .9 (merged)',
    svg: doc(far(16, (i) => (0.2 + 0.7 * (i / 15)).toFixed(2))),
    merged: 16,
  },
  {
    name: 'one hundred tiny disjoint faded leaves (merged)',
    svg: doc(tiny(100, () => 0.5)),
    merged: 100,
  },
  // The tight rect of a group is the exact ink box +2 px (not a quantized rect): a miter tip, a rotated or skewed stroke and a dash must lie inside it.
  {
    name: 'sharp miter tips, a rotated stroke and a skewed dashed stroke in a run (the tight rects hold the ink)',
    loose: true,
    svg: doc(
      '<path d="M4 30 L12 6 L20 30 L12 24 Z" fill="#0cf" stroke="#f0c" stroke-width="3" stroke-miterlimit="10" opacity=".5"/>' +
        '<rect x="30" y="8" width="16" height="22" fill="#fc0" stroke="#06f" stroke-width="4" transform="rotate(25 38 19)" opacity=".5"/>' +
        '<ellipse cx="20" cy="50" rx="14" ry="6" fill="#0a4" stroke="#000" stroke-width="3" stroke-dasharray="5 3" transform="skewX(-25)" opacity=".5"/>' +
        '<path d="M44 40 L58 56 L44 56 Z" fill="none" stroke="#c00" stroke-width="5" stroke-linejoin="miter" stroke-miterlimit="20" opacity=".5"/>',
    ),
  },
  {
    name: 'a far leaf joins a run that overlaps once: the whole run takes the atlas',
    svg: doc(far(6, () => 0.5) + leaf(4, 6, 20, 24, '#0cf', '#f0c', 1, 'opacity=".5"')),
    slots: 7,
  },
  {
    name: 'six faded fill+stroke leaves a few px apart (atlas slots)',
    svg: doc(row(6, 0.5)),
    slots: 6,
  },
  {
    name: 'overlapping faded fill+stroke leaves (the cluster)',
    svg: doc(cluster(12, 0.5)),
    slots: 12,
  },
  {
    name: 'per-leaf opacities .2 .5 .8',
    svg: doc(
      leaf(4, 8, 20, 40, '#0cf', '#f0c', 6, 'opacity=".2"') +
        leaf(20, 8, 20, 40, '#0c4', '#f60', 6, 'opacity=".5"') +
        leaf(36, 8, 20, 40, '#fc0', '#06f', 6, 'opacity=".8"'),
    ),
    slots: 3,
  },
  {
    name: 'a plain leaf between two faded leaves ends the run (two runs of one: no atlas)',
    svg: doc(
      leaf(4, 8, 20, 40, '#0cf', '#f0c', 6, 'opacity=".5"') +
        '<rect x="22" y="20" width="16" height="16" fill="#0a0"/>' +
        leaf(36, 8, 20, 40, '#fc0', '#06f', 6, 'opacity=".5"'),
    ),
    slots: 0,
  },
  {
    name: 'a gradient fill with a dashed, stroke-opacity stroke in a run',
    svg: doc(
      GRAD +
        leaf(
          4,
          8,
          24,
          40,
          'url(#g)',
          '#000',
          5,
          'opacity=".5" stroke-dasharray="4 2" stroke-opacity=".7"',
        ) +
        leaf(30, 8, 24, 40, 'url(#g)', '#f60', 5, 'opacity=".5"'),
    ),
    slots: 2,
  },
  {
    name: 'a leaf hanging off the canvas edge (a merged run clipped to the canvas)',
    svg: doc(
      leaf(-6, 8, 20, 40, '#0cf', '#f0c', 6, 'opacity=".5"') +
        leaf(50, 8, 20, 40, '#fc0', '#06f', 6, 'opacity=".5"'),
    ),
    merged: 2,
  },
  {
    name: 'a masked group in the run takes the ordinary accumulator, the rest the atlas',
    svg: doc(
      MASK +
        leaf(4, 8, 16, 40, '#0cf', '#f0c', 5, 'opacity=".5"') +
        leaf(22, 8, 16, 40, '#0cf', '#f0c', 5, 'opacity=".5" mask="url(#m)"') +
        leaf(40, 8, 16, 40, '#fc0', '#06f', 5, 'opacity=".5"'),
    ),
    slots: 0,
  },
  {
    name: 'a faded leaf inside a group stays on the ordinary accumulator',
    svg: doc('<g opacity=".7">' + row(4, 0.5) + '</g>'),
    slots: 0,
  },
  {
    name: 'four hundred big faded leaves (the atlas fills up and settles mid-run)',
    svg: doc(big(400, 0.4)),
    anySlots: true,
  },
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas><canvas id="c0" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const attrs = { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true, alpha: true };
const gl = document.getElementById('c').getContext('webgl2', attrs), gl0 = document.getElementById('c0').getContext('webgl2', attrs);
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const R0 = createRenderer(gl0, shaders, { groupAtlas: false }); if (R0.ready) await R0.ready;
const W = 128;
const read = (g) => { const px = new Uint8Array(W * W * 4); g.readPixels(0, 0, W, W, g.RGBA, g.UNSIGNED_BYTE, px);
  const out = new Uint8Array(W * W * 4); for (let y = 0; y < W; y++) out.set(px.subarray((W - 1 - y) * W * 4, (W - y) * W * 4), y * W * 4); return Array.from(out); };
const ENG = { auto: { route: 'auto', kernel: 'auto' }, slug: { route: 'none', kernel: 'slug' }, aac: { route: 'none', kernel: 'aac' }, lb: { route: 'lb', kernel: 'slug' } };
async function one(Rn, g, svg, eng) {
  const b = createBundle(g, await importSvg(svg, { preserveViewport: true }));
  Rn.setFillEngine(ENG[eng]);
  if (Rn.prepareBundle) Rn.prepareBundle(b);
  if (Rn.awaitLbReady) { try { await Rn.awaitLbReady(b, 20000); } catch {} }
  Rn.setViewport(W, W); g.viewport(0, 0, W, W);
  for (let i = 0; i < 3; i++) { Rn.beginFrame([1, 1, 1, 1]); Rn.drawBundle(b); Rn.endFrame(); }
  const s0 = Rn.debugStats.groupAtlasSlots | 0, p0 = Rn.debugStats.groupAtlasPasses | 0, c0 = Rn.debugStats.groupAtlasComposites | 0, m0 = Rn.debugStats.groupMergedComposites | 0;
  Rn.beginFrame([1, 1, 1, 1]); Rn.drawBundle(b); Rn.endFrame();
  const px = read(g);
  const st = Rn.debugStats;
  b.dispose && b.dispose();
  return { px, slots: (st.groupAtlasSlots | 0) - s0, passes: (st.groupAtlasPasses | 0) - p0, composites: (st.groupAtlasComposites | 0) - c0, merged: (st.groupMergedComposites | 0) - m0 };
}
// A faded GRID of instances (the layered passes): the oracle composes each placement's alpha-1 picture, faded by hand, in order.
async function grid(Rn, g, svg, eng, n, scale, alpha) {
  const b = createBundle(g, await importSvg(svg, { preserveViewport: true }));
  Rn.setFillEngine(ENG[eng]);
  if (Rn.prepareBundle) Rn.prepareBundle(b);
  if (Rn.awaitLbReady) { try { await Rn.awaitLbReady(b, 20000); } catch {} }
  Rn.setViewport(W, W); g.viewport(0, 0, W, W);
  const gn = Math.ceil(Math.sqrt(n)), sc = 2 / gn;
  const wm = (i) => new Float32Array([sc * scale, 0, 0, 0, sc * scale, 0, -1 + sc * ((i % gn) + 0.5), 1 - sc * (((i / gn) | 0) + 0.5), 1]);
  const insts = Array.from({ length: n }, (_, i) => ({ worldMatrix: wm(i), alpha }));
  for (let i = 0; i < 3; i++) { Rn.beginFrame([1, 1, 1, 1]); Rn.drawBundleInstanced(b, insts); Rn.endFrame(); }
  const c0 = (Rn.debugStats.groupAtlasComposites | 0) + (Rn.debugStats.groupMergedComposites | 0);
  Rn.beginFrame([1, 1, 1, 1]); Rn.drawBundleInstanced(b, insts); Rn.endFrame();
  const px = read(g), used = ((Rn.debugStats.groupAtlasComposites | 0) + (Rn.debugStats.groupMergedComposites | 0)) - c0;
  const want = new Array(W * W * 4).fill(255);
  for (let k = 0; k < n; k++) {
    Rn.beginFrame([0, 0, 0, 0]); Rn.drawBundle(b, { worldMatrix: wm(k) }); Rn.endFrame();
    const S = read(g);
    for (let i = 0; i < W * W; i++) { const sa = S[i * 4 + 3] / 255 * alpha; for (let ch = 0; ch < 3; ch++) want[i * 4 + ch] = Math.round(S[i * 4 + ch] * alpha + want[i * 4 + ch] * (1 - sa)); }
  }
  b.dispose && b.dispose();
  return { px, want, used };
}
window.__grid = async (svg, eng, n, scale, alpha) => ({ on: await grid(R, gl, svg, eng, n, scale, alpha), off: await grid(R0, gl0, svg, eng, n, scale, alpha) });
window.__pair = async (svg, eng) => ({ on: await one(R, gl, svg, eng), off: await one(R0, gl0, svg, eng) });
window.__chrome8 = async (svg) => {
  const K = 8, S = W * K;
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const c = document.createElement('canvas'); c.width = S; c.height = S; const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, S, S); const d = x.getImageData(0, 0, S, S).data;
  const out = new Array(W * W * 4);
  for (let y = 0; y < W; y++) for (let xx = 0; xx < W; xx++) for (let ch = 0; ch < 4; ch++) {
    let s = 0; for (let j = 0; j < K; j++) for (let i = 0; i < K; i++) s += d[(((y * K + j) * S) + xx * K + i) * 4 + ch];
    out[(y * W + xx) * 4 + ch] = Math.round(s / (K * K));
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
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 300));
});
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const maxDiff = (p, q) => {
  let m = 0;
  for (let i = 0; i < p.length; i++) m = Math.max(m, Math.abs(p[i] - q[i]));
  return m;
};
const meanDiff = (p, q) => {
  let s = 0;
  for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - q[i]);
  return s / p.length;
};

const ENGINES = process.env.GA_ENGINES
  ? process.env.GA_ENGINES.split(',')
  : ['auto', 'slug', 'aac', 'lb'];
for (const eng of ENGINES) {
  console.log(`\n-- engine ${eng}`);
  for (const c of CELLS) {
    const tag = `${c.name} [${eng}]`;
    let r, chrome;
    try {
      r = await page.evaluate((s, e) => window.__pair(s, e), c.svg, eng);
      chrome = await page.evaluate((s) => window.__chrome8(s), c.svg);
    } catch (e) {
      fail(`${tag}: ${e.message}`);
      continue;
    }
    const d = maxDiff(r.on.px, r.off.px),
      cm = meanDiff(r.on.px, chrome);
    const note = `on vs off ${d}, on vs Chrome 8x mean ${cm.toFixed(2)}; slots ${r.on.slots}, passes ${r.on.passes}, composites ${r.on.composites}, merged ${r.on.merged}`;
    if (d > (c.loose ? 2 : 1))
      fail(`${tag}: the atlas picture differs from the per-group accumulator by ${d} -- ${note}`);
    else if (cm > 1.5)
      fail(`${tag}: mean ${cm.toFixed(2)} from Chrome's 8x box-averaged answer -- ${note}`);
    else if (r.off.slots !== 0 || r.off.composites !== 0 || r.off.merged !== 0)
      fail(`${tag}: groupAtlas:false still used the atlas -- ${note}`);
    else if (c.loose) ok(`${tag} -- ${note}`);
    else if (
      c.merged !== undefined
        ? r.on.merged !== c.merged || r.on.slots !== 0
        : c.anySlots
          ? r.on.slots === 0
          : (c.slots || 0) === 0
            ? r.on.slots !== 0 || r.on.merged !== 0
            : r.on.slots !== c.slots
    )
      fail(
        `${tag}: expected ${c.merged !== undefined ? c.merged + ' merged composites and no slot' : c.anySlots ? 'some atlas slots' : (c.slots || 0) + ' atlas slot(s)'} -- ${note}`,
      );
    else if (!c.anySlots && (c.slots || 0) > 1 && r.on.passes !== 1)
      fail(`${tag}: the run must composite in ONE pass -- ${note}`);
    else ok(`${tag} -- ${note}`);
  }
}

// Faded instance grids: the atlas picture and the per-group picture against the hand fade of each placement's alpha-1 picture.
// (axis-aligned rects: the oracle draws each placement alone through the single-draw route, whose curved-edge antialiasing is not the instanced program's)
const ICON = bare(
  '<rect x="8" y="10" width="40" height="40" fill="#0cf" stroke="#f0c" stroke-width="8"/><rect x="22" y="26" width="30" height="12" fill="#fc0" stroke="#000" stroke-width="3"/>',
);
for (const eng of ENGINES) {
  for (const [name, n, scale] of [
    ['overlapping 5x5 grid', 25, 0.9],
    ['tiled 5x5 grid', 25, 0.45],
  ]) {
    let r;
    try {
      r = await page.evaluate(
        (s, e, nn, sc) => window.__grid(s, e, nn, sc, 0.5),
        ICON,
        eng,
        n,
        scale,
      );
    } catch (e) {
      fail(`grid ${name} [${eng}]: ${e.message}`);
      continue;
    }
    const dOn = maxDiff(r.on.px, r.on.want),
      dOff = maxDiff(r.off.px, r.off.want),
      dBoth = maxDiff(r.on.px, r.off.px);
    const note = `on vs hand fade ${dOn}, off vs hand fade ${dOff}, on vs off ${dBoth}; atlas/merged composites ${r.on.used} (off ${r.off.used})`;
    // (the oracle composes each placement drawn alone through the single-draw program; where the instanced program's own antialiasing departs from it
    // the per-group accumulators miss it too -- then the atlas must equal them to within 1)
    if (dOn > 3 && !(dOff > 3 && dBoth <= 1))
      fail(
        `grid ${name} [${eng}]: the atlas picture is ${dOn} from the hand fade of each placement (the per-group picture ${dOff}) -- ${note}`,
      );
    else if (r.off.used !== 0)
      fail(`grid ${name} [${eng}]: groupAtlas:false used the atlas -- ${note}`);
    else ok(`grid ${name} at alpha .5 [${eng}] -- ${note}`);
  }
}

await browser.close();
server.close();
console.log(failures ? `\nFAIL (${failures})` : '\nPASS');
process.exit(failures ? 1 : 0);
