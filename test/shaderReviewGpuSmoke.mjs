// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// shaderReviewGpuSmoke.mjs — the render side of a read-through of the fragment shaders, one measurement per finding:
// feConvolveMatrix's premultiplied validity, feMorphology past 64 px, the pixel footprint of a clip or mask child an override
// scales, the alpha interpolation of the COLR gradient programs, feImage's premultiplication, and dash patterns past 32 entries.
import { readFileSync } from 'fs';
import { deflateSync, crc32 } from 'zlib';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A one-color RGBA PNG, as a data: URL.
function png(w, h, rgba) {
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(t) >>> 0);
    return Buffer.concat([len, t, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(rgba, y * (w * 4 + 1) + 1 + x * 4);
  return (
    'data:image/png;base64,' +
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]).toString('base64')
  );
}
const HALF_RED = png(8, 8, [255, 0, 0, 128]);
const N = 256;
const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import * as M from '/src/index.js';
import { packStopList } from '/src/core/gradientStops.js';
import { gradientStopsLutSize, padGradientStopsLut } from '/src/bundle/layout.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
const shaders = await M.loadShaders(new URL('/src/shaders/', location.href).href);
const R = M.createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
R.setViewport(${N}, ${N});
const doc = (body) => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${N} ${N}">' + body + '</svg>';
const paint = async (bundle, drawOpts = {}) => {
  const draw = () => { R.beginFrame([0, 0, 0, 0]); R.drawBundle(bundle, drawOpts); R.endFrame(); };
  const warmed = await R.warmScene([{ draw }], { maxPasses: 16, fenceTimeoutMs: 60000 });
  if (!warmed.complete) throw Error('did not warm');
  draw();
  const px = new Uint8Array(${N} * ${N} * 4);
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return (x, y) => Array.from(px.subarray((${N} - 1 - y) * ${N} * 4 + x * 4, (${N} - 1 - y) * ${N} * 4 + x * 4 + 4));
};
const svgPaint = async (body, drawOpts, setup) => {
  const b = M.createBundle(gl, await M.importSvg(doc(body), { preserveViewport: true }));
  const opts = { ...(drawOpts || {}) };
  let table = null;
  if (setup) { table = M.createOverrideTable(gl, b); setup(table, b); opts.overrides = table; }
  const at = await paint(b, opts);
  if (table) table.dispose();
  b.dispose();
  return at;
};
window.__svgCase = {};

// feConvolveMatrix: a sharpen across a white-to-black seam at one alpha. Color past alpha is no premultiplied color.
const CONV = (pa) => '<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${N}" height="${N}" color-interpolation-filters="sRGB">'
  + '<feConvolveMatrix order="3" kernelMatrix="0 -1 0 -1 5 -1 0 -1 0" preserveAlpha="' + pa + '"/></filter>'
  + '<g filter="url(#f)"><rect x="40" y="40" width="80" height="176" fill="#fff" fill-opacity="0.5"/><rect x="120" y="40" width="80" height="176" fill="#000" fill-opacity="0.5"/></g>';
window.__convolve = async () => {
  const out = {};
  for (const pa of ['false', 'true']) {
    const at = await svgPaint(CONV(pa));
    out[pa] = { seamWhite: at(119, 128), inWhite: at(80, 128), inBlack: at(160, 128) };
  }
  return out;
};

// feMorphology: the window is the radius, whatever the radius. A dilate of 100 reaches 90 px from the square.
window.__morph = async () => {
  const at = await svgPaint('<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${N}" height="${N}" color-interpolation-filters="sRGB">'
    + '<feMorphology operator="dilate" radius="100"/></filter><rect x="120" y="120" width="16" height="16" fill="#f00" filter="url(#f)"/>');
  return { near: at(60, 128), far: at(30, 128), past: at(10, 128) };
};
// ...and an erode of 80 takes the square in by 80: 72 px in is gone, 87 px in stays.
window.__erode = async () => {
  const at = await svgPaint('<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${N}" height="${N}" color-interpolation-filters="sRGB">'
    + '<feMorphology operator="erode" radius="80"/></filter><rect x="28" y="28" width="200" height="200" fill="#f00" filter="url(#f)"/>');
  return { center: at(128, 128), inside: at(115, 128), past64: at(100, 128) };
};

// The graph route's own handler: a chain does not take the single-primitive path.
window.__morphGraph = async () => {
  const at = await svgPaint('<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${N}" height="${N}" color-interpolation-filters="sRGB">'
    + '<feMorphology operator="dilate" radius="100"/><feOffset dx="0" dy="0"/></filter><rect x="120" y="120" width="16" height="16" fill="#f00" filter="url(#f)"/>');
  return { far: at(30, 128), past: at(10, 128) };
};

// feImage: a half-transparent red pixel is (128, 0, 0, 128) premultiplied. The atlas already holds that.
window.__feImage = async () => {
  const at = await svgPaint('<filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${N}" height="${N}" color-interpolation-filters="sRGB">'
    + '<feImage href="${HALF_RED}" x="0" y="0" width="${N}" height="${N}" preserveAspectRatio="none"/></filter><rect width="${N}" height="${N}" fill="#00f" filter="url(#f)"/>');
  return at(128, 128);
};

// A dash pattern past 32 entries: 10 on, 10 off, 17 times over. The dash table holds 60; the walk stopped at 32, and read the rest of the cycle as a gap.
window.__dashLong = async () => {
  const at = await svgPaint('<line x1="0" y1="128" x2="${N}" y2="128" stroke="#f00" stroke-width="20" stroke-dasharray="' + Array(34).fill(10).join(' ') + '"/>');
  // Entries 33 and 34 are the dash at 320..330 and the gap after it, off this canvas: the pattern has to hold 256 px in x, so shift it by an offset that brings them on.
  const shifted = await svgPaint('<line x1="0" y1="128" x2="${N}" y2="128" stroke="#f00" stroke-width="20" stroke-dashoffset="200" stroke-dasharray="' + Array(34).fill(10).join(' ') + '"/>');
  return { early: at(5, 128)[3], earlyGap: at(15, 128)[3], dash33: shifted(125, 128)[3], gap34: shifted(135, 128)[3], wrapped: shifted(145, 128)[3] };
};

// The AA ramp of an edge at one pixel, under an override that scales the clip or mask child: counts of partial pixels along a row.
const rampWidth = (at, y, x0, x1) => { let n = 0; for (let x = x0; x < x1; x++) { const a = at(x, y)[3]; if (a > 2 && a < 253) n++; } return n; };
const CLIP = '<defs><clipPath id="c"><path id="cr" d="M100.4 100.4H155.6V155.6H100.4Z"/></clipPath></defs><rect width="${N}" height="${N}" fill="#f00" clip-path="url(#c)"/>';
const MASK = '<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${N}" height="${N}"><path id="mr" d="M100.4 100.4H155.6V155.6H100.4Z" fill="#fff"/></mask></defs><rect width="${N}" height="${N}" fill="#f00" mask="url(#m)"/>';
window.__footprint = async () => {
  const out = {};
  const about = (s) => ({ localScale: [s, s], localPosition: [128 * (1 - s), 128 * (1 - s)] });
  for (const s of [1, 2, 4, 0.5]) {
    const at = await svgPaint(CLIP, null, (t) => { if (!t.setClipper('cr', about(s)) && !t.setClipper('c', about(s))) throw Error('no clipper'); });
    out['clip@' + s] = rampWidth(at, 128, 0, ${N});
    const am = await svgPaint(MASK, null, (t) => { if (!t.setClipper('m', about(s))) throw Error('no mask clipper'); });
    out['mask@' + s] = rampWidth(am, 128, 0, ${N});
  }
  // A turning override takes the rotated-map fill program: it must link, and its edges stay about a pixel wide.
  const turned = { localScale: [2, 2], localRotation: Math.PI / 6, localPosition: [128 - 128 * 2 * Math.cos(Math.PI / 6) + 128 * 2 * Math.sin(Math.PI / 6), 128 - 128 * 2 * Math.sin(Math.PI / 6) - 128 * 2 * Math.cos(Math.PI / 6)] };
  const am = await svgPaint(MASK, null, (t) => { if (!t.setClipper('m', turned)) throw Error('no mask clipper'); });
  const ac = await svgPaint(CLIP, null, (t) => { if (!t.setClipper('cr', turned) && !t.setClipper('c', turned)) throw Error('no clipper'); });
  out.turned = { mask: rampWidth(am, 128, 0, ${N}), clip: rampWidth(ac, 128, 0, ${N}), maskCenter: am(128, 128)[3], clipCenter: ac(128, 128)[3] };
  return out;
};

// The COLR gradient programs, driven directly: a quad, the shared stops LUT, the uniforms the dispatch sets.
const prog = (fragKey) => {
  const mk = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(o)); return o; };
  const p = gl.createProgram();
  gl.attachShader(p, mk(gl.VERTEX_SHADER, shaders.compositeVert)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, shaders[fragKey]));
  gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
  return p;
};
const quad = gl.createVertexArray();
{ gl.bindVertexArray(quad); const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0); gl.bindVertexArray(null); }
const colrDraw = (fragKey, stops, set) => {
  const p = prog(fragKey);
  const { bytes, count } = packStopList(stops);
  const [w, h] = gradientStopsLutSize(bytes.length >>> 2);
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, padGradientStopsLut(bytes));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, ${N}, ${N}); gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST); gl.disable(gl.STENCIL_TEST);
  gl.colorMask(true, true, true, true); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(p); gl.bindVertexArray(quad);
  const u = (n) => gl.getUniformLocation(p, n);
  gl.uniform1i(u('uGradientStops'), 0); gl.uniform1i(u('uStopsOffset'), 0); gl.uniform1i(u('uStopCount'), count);
  gl.uniform3f(u('uPaintMapX'), 1, 0, 0); gl.uniform3f(u('uPaintMapY'), 0, 1, 0);
  set(u);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const px = new Uint8Array(4 * ${N} * ${N});
  gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
  gl.bindVertexArray(null); gl.deleteTexture(tex); gl.deleteProgram(p);
  return (x, y) => Array.from(px.subarray(y * ${N} * 4 + x * 4, y * ${N} * 4 + x * 4 + 4));
};
const LIN = (u, p0, p1, p2, ext) => { gl.uniform2f(u('uP0'), ...p0); gl.uniform2f(u('uP1'), ...p1); gl.uniform2f(u('uP2'), ...p2); gl.uniform1i(u('uExtend'), ext); };
const OPAQUE = [{ offset: 0, color: [1, 0, 0, 1] }, { offset: 1, color: [0, 0, 1, 1] }];
window.__colr = async () => {
  const out = {};
  // Red, opaque, to blue at alpha 0: OpenType (CPAL, Interpolation of colors) interpolates premultiplied, so halfway is red at half alpha.
  const fade = [{ offset: 0, color: [1, 0, 0, 1] }, { offset: 1, color: [0, 0, 1, 0] }];
  out.fadeMid = colrDraw('paintLinearGradFrag', fade, (u) => LIN(u, [0, 0], [1, 0], [0, 1], 0))(128, 128);
  // Opaque stops: the same text has it in linear light, so halfway is 0.5 of each, about 188 once encoded.
  out.opaqueMid = colrDraw('paintLinearGradFrag', OPAQUE, (u) => LIN(u, [0, 0], [1, 0], [0, 1], 0))(128, 128);
  // { compat: 'chrome' } on the font: sRGB-encoded and straight, the program's other answer to the same uniforms.
  const chrome = (u) => { LIN(u, [0, 0], [1, 0], [0, 1], 0); gl.uniform1i(u('uStopsChrome'), 1); };
  out.chromeFadeMid = colrDraw('paintLinearGradFrag', fade, chrome)(128, 128);
  out.chromeOpaqueMid = colrDraw('paintLinearGradFrag', OPAQUE, chrome)(128, 128);
  return out;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  try {
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    const body = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(body);
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: N, height: N });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' || /shader|compile/i.test(t))
    console.log('  [console]', t.slice(0, 400));
});
await openReady(page, 'http://127.0.0.1:' + server.address().port + '/');
let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log('ok ' + msg);
  else {
    failures++;
    console.error('FAIL: ' + msg);
  }
};
const near = (a, b, e) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= e);
const run = (name) => page.evaluate((n) => window['__' + n](), name);

const conv = await run('convolve');
for (const pa of ['false', 'true']) {
  const c = conv[pa];
  check(
    c.seamWhite[0] <= c.seamWhite[3] + 1,
    `convolve preserveAlpha=${pa}: color stays within alpha at the seam (${c.seamWhite})`,
  );
  check(
    near(c.inWhite, [128, 128, 128, 128], 1) && near(c.inBlack, [0, 0, 0, 128], 1),
    `convolve preserveAlpha=${pa}: a flat region is unchanged`,
  );
}
const mo = await run('morph');
check(mo.near[0] > 250 && mo.near[3] > 250, 'dilate 100 fills 60 px out');
check(
  mo.far[0] > 250 && mo.far[3] > 250,
  `dilate 100 fills 90 px out, past one pass's reach (${mo.far})`,
);
check(mo.past[3] === 0, 'and stops at its radius, not past it');
const mg = await run('morphGraph');
check(
  mg.far[0] > 250 && mg.far[3] > 250 && mg.past[3] === 0,
  `the graph route: dilate 100 fills 90 px out, and stops at its radius (${mg.far} / ${mg.past})`,
);
const er = await run('erode');
check(er.center[3] > 250 && er.inside[3] > 250, 'erode 80 leaves what lies 87 px in');
check(er.past64[3] === 0, `erode 80 removes what lies 72 px in (${er.past64})`);
const fi = await run('feImage');
check(
  near(fi, [128, 0, 0, 128], 2),
  `feImage keeps a half-transparent pixel's color: the atlas is premultiplied once (${fi})`,
);
const dl = await run('dashLong');
check(dl.early === 255 && dl.earlyGap === 0, 'a long dash pattern starts on its first dash');
check(
  dl.dash33 === 255 && dl.gap34 === 0 && dl.wrapped === 255,
  `a dash pattern past 32 entries keeps its later dashes (33rd entry ${dl.dash33}, 34th ${dl.gap34}, wrapped ${dl.wrapped})`,
);
const fp = await run('footprint');
const turned = fp.turned;
delete fp.turned;
for (const k of Object.keys(fp))
  check(fp[k] === 2, `${k}: one AA pixel at each edge of the row (${fp[k]})`);
check(
  turned.maskCenter === 255 && turned.clipCenter === 255,
  'a turning override: the center is still inside',
);
check(
  turned.mask <= 6 && turned.clip <= 6,
  `a turning override: its edges stay narrow (mask ${turned.mask}, clip ${turned.clip} AA pixels across two edges)`,
);
const co = await run('colr');
check(
  near(co.fadeMid, [127, 0, 0, 127], 2),
  `COLR: opaque red to transparent blue is red at half alpha halfway (${co.fadeMid})`,
);
check(
  near(co.opaqueMid, [188, 0, 188, 255], 1),
  `COLR: opaque stops interpolate in linear light (${co.opaqueMid})`,
);
check(
  near(co.chromeFadeMid, [63, 0, 64, 127], 2),
  `COLR, Chrome's reading: opaque red to transparent blue is straight (${co.chromeFadeMid})`,
);
check(
  near(co.chromeOpaqueMid, [127, 0, 128, 255], 1),
  `COLR, Chrome's reading: opaque stops interpolate sRGB-encoded (${co.chromeOpaqueMid})`,
);
await browser.close();
server.close();
if (failures) {
  console.error(`SHADER-REVIEW FAIL (${failures})`);
  process.exit(1);
}
console.log('SHADER-REVIEW PASS');
