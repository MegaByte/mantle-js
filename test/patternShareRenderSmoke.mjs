// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// patternShareRenderSmoke -- a pattern whose content depends on the referencing box is stored once, and paints what it painted when the
// importer baked the content per box size (test/patternShareSmoke.mjs holds the CPU proofs).
//
// Each cell renders the production art (`svg`: ONE <pattern> with default objectBoundingBox units + a viewBox, or
// patternContentUnits="objectBoundingBox", referenced by four shapes of distinct size) and the CONTROL: the same art with the
// content PRE-RESOLVED per shape -- one userSpaceOnUse pattern each, the content under the explicit viewBox / box matrix, i.e. the
// rows the importer baked before. They must paint the same picture to within AA noise (a pixel counts when a channel differs by
// more than 12/255; at most 0.1% may). A DECOY (the same control with the alignment translation dropped) must differ by at least
// 48/255 in 1% of the pixels, so a pass cannot be a picture that ignores the alignment. Static cells are also compared with the
// browser's own SVG renderer: the interior share (as patternUnitsRenderSmoke) of the production art must not exceed the control's
// by more than 0.5%.
//
// Cells: preserveAspectRatio variants (meet/slice, Min/Mid/Max, none), a viewBox corner, patternContentUnits, a stroke child
// (uniform scale shares, non-uniform bakes per scale), a patternTransform, a nested pattern, a pattern STROKE paint, a tile finer
// than a pixel (the MANTLE_PATTERN_MEAN walk), a shape morph between two pattern-filled shapes, and a nine-sliced bundle.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 200;
const RECTS = [
  [10, 10, 70, 50],
  [95, 12, 95, 38],
  [12, 75, 40, 110],
  [70, 80, 120, 100],
];

function fit(vb, par, w, h) {
  const p = (par || 'xMidYMid meet').trim().split(/\s+/);
  let sx = w / vb[2],
    sy = h / vb[3];
  if (p[0] === 'none') return [sx, sy, -sx * vb[0], -sy * vb[1]];
  const s = p[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
  const m = /^x(min|mid|max)y(min|mid|max)$/.exec(p[0].toLowerCase());
  const f = { min: 0, mid: 0.5, max: 1 };
  return [s, s, (w - vb[2] * s) * f[m[1]] - s * vb[0], (h - vb[3] * s) * f[m[2]] - s * vb[1]];
}
const CONTENT =
  '<rect width="5" height="10" fill="#0090ff"/><circle cx="7.5" cy="5" r="2.5" fill="#e03020"/><path d="M5 0 L10 0 L10 3 Z" fill="#20a040"/>';
const doc = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="200" height="200"><defs>${defs}</defs>${body}</svg>`;

// shapeOf(r, fill) -> element markup; cell = { vb, par, fw, fh, fx, fy } (viewBox kind) or { cu: true, tw, th } (content units kind).
function art(c) {
  const content = c.content || CONTENT,
    shape =
      c.shape ||
      ((r, fill) =>
        `<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" fill="${fill}"/>`);
  const box = c.box || ((r) => r); // the element's own bounding box (what objectBoundingBox is of)
  const attrs = c.cu
    ? `width="${c.tw}" height="${c.th}" patternUnits="userSpaceOnUse" patternContentUnits="objectBoundingBox"`
    : `x="${c.fx || 0}" y="${c.fy || 0}" width="${c.fw}" height="${c.fh}" viewBox="${c.vb.join(' ')}"${c.par ? ` preserveAspectRatio="${c.par}"` : ''}${c.pt ? ` patternTransform="${c.pt}"` : ''}`;
  const shared = doc(
    `<pattern id="p" ${attrs}>${content}</pattern>${c.extra || ''}`,
    RECTS.map((r) => shape(r, 'url(#p)')).join(''),
  );
  const pats = [],
    dpats = [],
    body = [],
    dbody = [];
  let shifted = false;
  RECTS.forEach((r0, i) => {
    const r = box(r0);
    let tile, m;
    if (c.cu) {
      tile = [0, 0, c.tw, c.th];
      m = [r[2], r[3], 0, 0];
    } else {
      tile = [r[0] + (c.fx || 0) * r[2], r[1] + (c.fy || 0) * r[3], c.fw * r[2], c.fh * r[3]];
      m = fit(c.vb, c.par, tile[2], tile[3]);
    }
    const mk = (mm) =>
      `<pattern id="p${i}" patternUnits="userSpaceOnUse" x="${tile[0]}" y="${tile[1]}" width="${tile[2]}" height="${tile[3]}"${c.pt ? ` patternTransform="${c.pt}"` : ''}>` +
      `<g transform="matrix(${mm[0]} 0 0 ${mm[1]} ${mm[2]} ${mm[3]})">${content}</g></pattern>`;
    pats.push(mk(m));
    body.push(shape(r0, `url(#p${i})`));
    if (Math.abs(m[2]) + Math.abs(m[3]) > 0.5) shifted = true;
    dpats.push(mk([m[0], m[1], 0, 0]));
    dbody.push(shape(r0, `url(#p${i})`));
  });
  return {
    svg: shared,
    control: doc(pats.join('') + (c.extra || ''), body.join('')),
    decoy: shifted && !c.cu ? doc(dpats.join('') + (c.extra || ''), dbody.join('')) : null,
  };
}
const CELLS = [];
const add = (name, c, extra = {}) => {
  const a = art(c);
  CELLS.push({
    name,
    kind: 'draw',
    svg: a.svg,
    control: a.control,
    decoy: a.decoy,
    native: !extra.noNative,
    ...extra,
  });
};
add('viewBox meet xMidYMid (the default)', { fw: 0.4, fh: 0.5, vb: [0, 0, 10, 10] });
add('viewBox slice xMinYMax', { fw: 0.4, fh: 0.5, vb: [0, 0, 10, 10], par: 'xMinYMax slice' });
add('viewBox meet xMaxYMid', { fw: 0.45, fh: 0.3, vb: [0, 0, 10, 10], par: 'xMaxYMid meet' });
add('viewBox with a corner (5 -3), xMidYMin', {
  fw: 0.4,
  fh: 0.5,
  vb: [5, -3, 10, 10],
  par: 'xMidYMin meet',
  content:
    '<rect x="5" y="-3" width="5" height="10" fill="#0090ff"/><circle cx="12.5" cy="2" r="2.5" fill="#e03020"/>',
});
add('viewBox none (non-uniform)', { fw: 0.4, fh: 0.5, vb: [0, 0, 10, 10], par: 'none' });
add('patternContentUnits objectBoundingBox', {
  cu: true,
  tw: 25,
  th: 20,
  content:
    '<rect width="0.25" height="0.5" fill="#0090ff"/><circle cx="0.6" cy="0.5" r="0.2" fill="#e03020"/>',
});
add('a stroke child, uniform scale (shares)', {
  fw: 0.4,
  fh: 0.5,
  vb: [0, 0, 10, 10],
  content:
    '<rect x="1" y="1" width="8" height="8" fill="#ffe08a" stroke="#102040" stroke-width="1.2" stroke-dasharray="2 1"/>',
});
add('a stroke child, non-uniform scale (per size)', {
  fw: 0.4,
  fh: 0.5,
  vb: [0, 0, 10, 10],
  par: 'none',
  content:
    '<rect x="1" y="1" width="8" height="8" fill="#ffe08a" stroke="#102040" stroke-width="1.2"/>',
});
add('a gradient child', {
  fw: 0.4,
  fh: 0.5,
  vb: [0, 0, 10, 10],
  content: '<rect width="10" height="10" fill="url(#g)"/>',
  extra:
    '<linearGradient id="g" x1="0" y1="0" x2="10" y2="10" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#0090ff"/><stop offset="1" stop-color="#e03020"/></linearGradient>',
});
add('patternTransform rotate(25)', { fw: 0.4, fh: 0.5, vb: [0, 0, 10, 10], pt: 'rotate(25)' });
add('a nested pattern', {
  fw: 0.4,
  fh: 0.5,
  vb: [0, 0, 10, 10],
  content:
    '<rect width="10" height="10" fill="url(#q)"/><circle cx="5" cy="5" r="2" fill="#e03020"/>',
  extra:
    '<pattern id="q" width="2.5" height="2.5" patternUnits="userSpaceOnUse"><rect width="1.25" height="2.5" fill="#0090ff"/></pattern>',
});
add('a pattern STROKE paint', {
  fw: 0.4,
  fh: 0.5,
  vb: [0, 0, 10, 10],
  box: (r) => [r[0] + 6, r[1] + 6, r[2] - 12, r[3] - 12],
  shape: (r, fill) =>
    `<rect x="${r[0] + 6}" y="${r[1] + 6}" width="${r[2] - 12}" height="${r[3] - 12}" fill="none" stroke="${fill}" stroke-width="10"/>`,
});
add(
  'a tile finer than a pixel (the mean walk)',
  { fw: 0.005, fh: 0.007, vb: [0, 0, 10, 10] },
  { noNative: true },
);
// morph and nine-slice: both poses pattern-filled; fix draws the production art's morph, control the pre-resolved art's.
{
  const A = art({ fw: 0.4, fh: 0.5, vb: [0, 0, 10, 10] });
  const B = art({
    fw: 0.4,
    fh: 0.5,
    vb: [0, 0, 10, 10],
    box: (r) => [r[0] + 12, r[1] + 8, r[2] - 10, r[3] - 6],
    shape: (r, f) =>
      `<rect x="${r[0] + 12}" y="${r[1] + 8}" width="${r[2] - 10}" height="${r[3] - 6}" fill="${f}"/>`,
  });
  // A morph lands on each pose: the carrier's pattern inverse (texel 5) lerps with its tile (morphCore.js). (Between the poses the pre-resolved control
  // also morphs the content rows, which the shared one does not need to: only the endpoints are compared.)
  for (const t of [0, 1])
    CELLS.push({
      name: `a shape morph between two pattern-filled poses, t = ${t}`,
      kind: 'morph',
      svg: [A.svg, B.svg],
      control: [A.control, B.control],
      t,
      native: false,
    });
  CELLS.push({
    name: 'a nine-sliced bundle',
    kind: 'nine',
    svg: A.svg,
    control: A.control,
    native: false,
  });
}

const HTML = `<!DOCTYPE html><html><body style="margin:0">
<canvas id="c" width="${N}" height="${N}"></canvas><canvas id="r" width="${N}" height="${N}"></canvas>
<script type="module">
import * as M from '/src/index.js';
const N = ${N}, CELLS = ${JSON.stringify(CELLS)};
const gl = document.getElementById('c').getContext('webgl2', { stencil: true, depth: true, antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await M.loadShaders(new URL('/src/shaders/', location.href).href);
const R = M.createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
const ref2d = document.getElementById('r').getContext('2d', { willReadFrequently: true });
const bun = async (s) => M.createBundle(gl, await M.importSvg(s, { preserveViewport: true }));
async function native(svg) {
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  ref2d.fillStyle = '#fff'; ref2d.fillRect(0, 0, N, N); ref2d.drawImage(img, 0, 0, N, N);
  return Array.from(ref2d.getImageData(0, 0, N, N).data);
}
const frame = async (fn) => {
  R.setViewport(N, N);
  const f = () => { R.beginFrame([1, 1, 1, 1]); fn(); R.endFrame(); };
  const w = await R.warmScene([{ draw: f }], { maxPasses: 16, fenceTimeoutMs: 60000 }); if (!w.complete) throw Error('warm incomplete');
  f();
  const px = new Uint8Array(N * N * 4); gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const out = new Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N * 4; x++) out[y * N * 4 + x] = px[(N - 1 - y) * N * 4 + x];
  return out;
};
async function mantle(kind, v, cell) {
  if (kind === 'draw') { const b = await bun(v); return frame(() => R.drawBundle(b)); }
  if (kind === 'morph') { const [a, b] = await Promise.all([bun(v[0]), bun(v[1])]); const m = M.createShapeMorph(gl, a, b); m.setT(cell.t); return frame(() => R.drawBundle(m.bundle)); }
  if (kind === 'nine') { const b = await bun(v); const i = b.nineSliceInstance({ border: [40, 40, 40, 40], worldSize: [170, 140] }); return frame(() => R.drawBundle(i)); }
}
const diff = (a, b, tol) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])) > tol) n++; return n; };
const interior = (ref, got) => {
  let inn = 0, wrong = 0;
  const same = (a, b) => Math.max(Math.abs(ref[a] - ref[b]), Math.abs(ref[a + 1] - ref[b + 1]), Math.abs(ref[a + 2] - ref[b + 2])) <= 8;
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const o = (y * N + x) * 4; let flat = true;
    for (let dy = -1; dy <= 1 && flat; dy++) for (let dx = -1; dx <= 1; dx++) if (!same(o, ((y + dy) * N + x + dx) * 4)) { flat = false; break; }
    if (!flat) continue; inn++;
    if (Math.max(Math.abs(ref[o] - got[o]), Math.abs(ref[o + 1] - got[o + 1]), Math.abs(ref[o + 2] - got[o + 2])) > 48) wrong++;
  }
  return { inn, wrong };
};
const out = { cells: [] };
try {
  for (const c of CELLS) {
    const fix = await mantle(c.kind, c.svg, c), ctl = await mantle(c.kind, c.control, c);
    const r = { name: c.name, px: N * N, differ: diff(fix, ctl, 12), ink: 0 };
    // where the picture departs from the control (reported for a failing cell): the largest channel difference and the first few pixels
    r.dmax = 0; r.dpos = [];
    for (let i = 0; i < fix.length; i += 4) {
      const d = Math.max(Math.abs(fix[i] - ctl[i]), Math.abs(fix[i + 1] - ctl[i + 1]), Math.abs(fix[i + 2] - ctl[i + 2]));
      if (d > r.dmax) r.dmax = d;
      if (d > 12 && r.dpos.length < 12) r.dpos.push([(i >> 2) % N, ((i >> 2) / N) | 0, d]);
    }
    for (let i = 0; i < fix.length; i += 4) if (fix[i] < 245 || fix[i + 1] < 245 || fix[i + 2] < 245) r.ink++;
    if (c.decoy) { const d = await mantle(c.kind, c.decoy, c); r.decoy = diff(fix, d, 48); }
    if (c.native) { const nat = await native(c.svg), natC = await native(c.control); r.nat = interior(nat, fix); r.natCtl = interior(natC, ctl); }
    out.cells.push(r);
  }
  out.ok = true;
} catch (e) { out.err = String((e && e.stack) || e); }
window.__out = out;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    res.writeHead(200, {
      'content-type':
        (/\.(js|mjs)$/.test(u.pathname) ? 'text/javascript' : 'text/plain') + '; charset=utf-8',
    });
    res.end(b);
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((res) => server.listen(0, '127.0.0.1', res));
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
await page
  .waitForFunction('window.__out !== undefined', { timeout: 120000, polling: 100 })
  .catch(() => {});
const r = await page.evaluate(() => window.__out);
await browser.close();
server.close();

let fail = 0;
if (!r || !r.ok) {
  console.log('FAIL did not complete: ' + (r && r.err));
  process.exit(1);
}
for (const c of r.cells) {
  const same = c.differ <= 0.001 * c.px,
    ink = c.ink > 800;
  const decoyOk = c.decoy === undefined || c.decoy >= 0.01 * c.px;
  const natOk =
    !c.nat ||
    (c.nat.inn > 500 &&
      c.nat.wrong / c.nat.inn <= c.natCtl.wrong / Math.max(1, c.natCtl.inn) + 0.005);
  const pass = same && ink && decoyOk && natOk;
  console.log(
    `${pass ? '  ok' : 'FAIL'} ${c.name}: ${c.differ} of ${c.px} px differ from the pre-resolved control (limit ${Math.floor(0.001 * c.px)}), ink ${c.ink}` +
      (c.decoy !== undefined ? `, decoy differs by ${c.decoy}` : '') +
      (c.nat
        ? `, browser: ${c.nat.wrong}/${c.nat.inn} interior px off (control ${c.natCtl.wrong}/${c.natCtl.inn})`
        : ''),
  );
  if (!pass) {
    fail++;
    console.log(
      `     largest channel difference ${c.dmax}; first differing pixels (x, y, diff): ${JSON.stringify(c.dpos)}`,
    );
  }
}
console.log(fail ? `\nPATTERN-SHARE-RENDER FAIL (${fail})` : '\nPATTERN-SHARE-RENDER PASS');
process.exit(fail ? 1 : 0);
