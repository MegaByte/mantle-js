// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// compatEngines — what each browser engine does at Mantle's two documented spec divergences, so the compat
// option could be named by who actually behaves that way (Chrome alone, or every engine). The answer:
// Chrome alone, so the option is importSvg({ compat: 'chrome' }).
//
//   1. an SVG <image> referencing an SVG document: the 18 cases of test/_svgImageFitCases.mjs, read at
//      their 12 points;
//   2. feSpecularLighting with specularConstant 0, plus a negative constant, a positive control, and
//      specularExponent 0.5 / 1 / 128 / 200 (does the engine clamp the exponent to 1..128?).
//
// TWO MODES.
//
//   node probes/compatEngines.mjs                 (no browser) the engines' rules as their SOURCE states them,
//                                                  run over the 18 cases; prints each engine's predicted row
//   node probes/compatEngines.mjs --browser firefox [--exe <path>]   renders both, in that browser
//   node probes/compatEngines.mjs --browser chrome
//
// THE BROWSER MODE HAS NOT RUN. On the machine this was written on Firefox Nightly could not be driven: macOS
// privacy protection denies this process ~/Library/Application Support/Firefox ("Operation not permitted",
// sandboxed or not), so Firefox's profile service fails and it exits with "Could not find profile folder."
// Safari's WebDriver refuses a session until "Allow remote automation" is enabled in Safari's settings. And
// Chrome was not launched (the rows for Chrome in test/_svgImageFitCases.mjs are Chrome 147's, measured).
// So what is below is read from the engines' source, with the file and line.
//
// ---- 1. <image> of an SVG document (sources: Gecko mozilla-firefox/firefox 270f3350, WebKit/WebKit 436e6d6b) --
//
// WebKit has Blink's structure (Blink forked it): the image's box is the document's container size unless
// the image's preserveAspectRatio is `none` (LegacyRenderSVGImage.cpp:90-119; RenderSVGImage.cpp:269-284,
// where `none` sets the container to the intrinsic size), the root fits its viewBox into that with its
// own preserveAspectRatio (SVGSVGElement.cpp:825-837), a root with width/height and no viewBox gets a
// synthesized viewBox drawn with `none` (SVGSVGElement.cpp:694-737, 830-834), and the result is drawn into
// the image's box, the image's preserveAspectRatio mapping a source rect the same size as that box
// (LegacyRenderSVGImage.cpp:194-203) -- so it acts only through `none`. That model reproduces all 18 of
// Chrome's measured rows (the no-browser mode prints it), so Safari is expected to match Chrome on every case.
//
// Gecko is a mix. The image's preserveAspectRatio OVERRIDES the root's, as the spec says: SVGImageFrame
// passes it in an SVGImageContext with the image's width and height as the viewport (SVGImageFrame.cpp:
// 368-377, and 614-622 on the WebRender path), and AutoPreserveAspectRatioOverride installs it on the root
// (SVGSVGElement.h:245-265; SVGSVGElement.cpp:599-619, 670-701) -- when the root has a viewBox. But the
// viewport is the image's box, not the spec's box fitted to the document's natural aspect ratio; a root
// with width/height and no viewBox gets a synthesized viewBox drawn with `none` (SVGViewportElement.cpp:
// 257-289; SVGSVGElement.cpp:686-693); and overflow is not honored ("We should technically be overriding
// the helper doc's clip and overflow properties here, too", SVGSVGElement.h:254-255) -- the vector image
// is drawn into a surface the image's size. Modeled: the spec's row in 12 of 18 cases, Chrome's in 10,
// neither in case 18.
//
// ---- 2. feSpecularLighting (sources: Chromium 98c0ab58, Gecko 270f3350, WebKit 436e6d6b) ----------------
//
//   Blink   the lighting TYPE is `specular_constant_ > 0 ? kSpecular : kDiffuse` (fe_lighting.cc:140-143) and
//           FESpecularLighting hands FELighting a diffuse constant of 0 (fe_specular_lighting.cc:33-45), so
//           a constant <= 0 draws diffuse lighting with kd 0: opaque black. Exponent clamped to 1..128
//           (fe_lighting.cc:53-54).
//   Gecko   ks clamped to 0..255 (FilterNodeSoftware.cpp:3717-3729), S = ks * pow(N.H, exp) and
//           alpha = max(R, G, B) (3736-3774): ks 0 is transparent -- the spec's answer. An exponent
//           outside 1..128 returns an empty primitive (SVGFESpecularLightingElement.cpp:63-81), which
//           builds no filter node (FilterSupport.cpp:689-690): transparent, where Blink and WebKit clamp.
//   WebKit  ks = max(ks, 0), exponent clamped to 1..128 (FELighting.cpp:47-48; FESpecularLighting.cpp:
//           43-58); the type is the element's, not the constant's (FELightingSoftwareApplier.cpp:46-86;
//           FELightingCoreImageApplier.mm:462-466), and specular alpha is max(R, G, B) (software applier
//           160-170): ks 0 is transparent -- the spec's answer.
//
// So Chrome is alone on the specular constant, and on the image fit Safari agrees with Chrome while Firefox
// takes the spec's side on preserveAspectRatio and Chrome's on the viewport, size-only roots and overflow.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import { CASES, PTS, RGB, cellSvg } from '../test/_svgImageFitCases.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : d;
};
const BROWSER = arg('--browser', null);
const EXE = arg(
  '--exe',
  BROWSER === 'firefox' ? '/Applications/Firefox Nightly.app/Contents/MacOS/firefox' : null,
);

// ---- the no-browser mode: the engines' <image> rules, as their source states them, over the 18 cases ----
// The document's rects in paint order (the last wins), in its own units: green left of the viewBox, blue right
// of it, red on it, yellow its top fifth.
const RECTS = [
  ['grn', -10, 0, 10, 10],
  ['blu', 10, 0, 10, 10],
  ['red', 0, 0, 10, 10],
  ['yel', 0, 0, 10, 2],
];
const attrOf = (s, n) => {
  const m = new RegExp(`${n}="([^"]*)"`).exec(s);
  return m ? m[1] : null;
};
/// A box -> viewport map [sx, sy, tx, ty] under a preserveAspectRatio value.
function fitBox(vb, V, par) {
  const [vx, vy, vw, vh] = vb,
    [X, Y, W, H] = V;
  if (par === 'none') return [W / vw, H / vh, X - (vx * W) / vw, Y - (vy * H) / vh];
  const [align, ms] = (par || 'xMidYMid meet').split(/\s+/);
  const k = (ms === 'slice' ? Math.max : Math.min)(W / vw, H / vh);
  const ax = align.slice(1, 4),
    ay = align.slice(5, 8);
  const ox = ax === 'Min' ? 0 : ax === 'Mid' ? (W - vw * k) / 2 : W - vw * k;
  const oy = ay === 'Min' ? 0 : ay === 'Mid' ? (H - vh * k) / 2 : H - vh * k;
  return [k, k, X + ox - vx * k, Y + oy - vy * k];
}
/// One case's row under an engine's rules: 'gecko' (the image's preserveAspectRatio overrides the root's),
/// 'webkit' (the root's, with the image's acting only through `none` -- Blink's structure too). Both: the
/// viewport is the image's box, a size-only root gets a synthesized viewBox drawn with `none`, and the result
/// is clipped to the image's box.
function modelRow(c, engine) {
  const V = [10, 10, 80, 40];
  const vbS = attrOf(c.rootAttrs, 'viewBox'),
    w = +attrOf(c.rootAttrs, 'width'),
    h = +attrOf(c.rootAttrs, 'height');
  const imgPar = c.imgPar || 'xMidYMid meet',
    rootPar = attrOf(c.rootAttrs, 'preserveAspectRatio') || 'xMidYMid meet';
  let T;
  if (vbS && engine === 'webkit' && imgPar === 'none') {
    // The container is the document's intrinsic size (width/height, else the viewBox's ratio); the root fits its
    // viewBox into that by its own preserveAspectRatio, and the container is stretched onto the image's box.
    const vb = vbS.split(/\s+/).map(Number),
      C = w > 0 && h > 0 ? [0, 0, w, h] : [0, 0, vb[2], vb[3]];
    const a = fitBox(vb, C, rootPar),
      b = fitBox(C, V, 'none');
    T = [a[0] * b[0], a[1] * b[1], a[2] * b[0] + b[2], a[3] * b[1] + b[3]];
  } else if (vbS)
    T = fitBox(vbS.split(/\s+/).map(Number), V, engine === 'gecko' ? imgPar : rootPar);
  else if (w > 0 && h > 0) T = fitBox([0, 0, w, h], V, 'none');
  else T = [1, 1, V[0], V[1]];
  return PTS.map(([px, py]) => {
    const x = px + 0.5,
      y = py + 0.5;
    if (x < V[0] || x > V[0] + V[2] || y < V[1] || y > V[1] + V[3]) return 'wht';
    let col = 'wht';
    for (const [n, rx, ry, rw, rh] of RECTS) {
      const X0 = T[0] * rx + T[2],
        Y0 = T[1] * ry + T[3];
      if (x >= X0 && x < X0 + T[0] * rw && y >= Y0 && y < Y0 + T[1] * rh) col = n;
    }
    return col;
  });
}
if (!BROWSER) {
  console.log(
    '<image> fit, predicted from source (rows at the 12 points; "matches" against the rows in test/_svgImageFitCases.mjs)',
  );
  const tally = { gecko: { spec: 0, chrome: 0 }, webkit: { spec: 0, chrome: 0 } };
  for (const c of CASES) {
    const out = [];
    for (const e of ['gecko', 'webkit']) {
      const r = modelRow(c, e).join(' ');
      const m = [
        r === c.spec.join(' ') ? 'spec' : null,
        r === c.chrome.join(' ') ? 'chrome' : null,
      ].filter(Boolean);
      for (const k of m) tally[e][k]++;
      out.push(`${e} ${r} (${m.join('+') || 'neither'})`);
    }
    console.log(`  ${c.id.padStart(2)} ${c.what}\n       ${out.join('\n       ')}`);
  }
  for (const e of ['gecko', 'webkit'])
    console.log(`  ${e}: the spec's row in ${tally[e].spec}/18, Chrome's in ${tally[e].chrome}/18`);
  process.exit(0);
}

// Specular cases: a white rect lit by a white distant light over a #4060c0 ground, read at its center.
const N = 100;
const LIGHT = '<feDistantLight azimuth="0" elevation="30"/>';
const spec = (attrs) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">` +
  `<defs><filter id="f" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">` +
  `<feSpecularLighting ${attrs} lighting-color="#fff">${LIGHT}</feSpecularLighting></filter></defs>` +
  `<rect width="${N}" height="${N}" fill="#4060c0"/><rect x="20" y="20" width="60" height="60" fill="#fff" filter="url(#f)"/></svg>`;
const SPEC = [
  ['specularConstant 0', 'specularConstant="0" specularExponent="1"'],
  ['specularConstant -1', 'specularConstant="-1" specularExponent="1"'],
  ['specularConstant 0.5 (control)', 'specularConstant="0.5" specularExponent="1"'],
  ['specularExponent 0.5', 'specularConstant="1" specularExponent="0.5"'],
  ['specularExponent 1', 'specularConstant="1" specularExponent="1"'],
  ['specularExponent 128', 'specularConstant="1" specularExponent="128"'],
  ['specularExponent 200', 'specularConstant="1" specularExponent="200"'],
];

const HTML = `<!DOCTYPE html><html><body style="margin:0;background:#fff"><div id="host"></div><script>
window.__img = async (svg, w, h, pts) => {
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, w, h).data;
  return pts.map(([x, y]) => Array.from(d.slice((y * w + x) * 4, (y * w + x) * 4 + 4)));
};
window.__inline = (svg) => { document.getElementById('host').innerHTML = svg; return true; };
window.__ready = true;
</script></body></html>`;

// A PNG decoder for the screenshot: 8-bit RGB/RGBA, non-interlaced.
function decodePng(buf) {
  let o = 8,
    W = 0,
    H = 0,
    ct = 0;
  const idat = [];
  while (o < buf.length) {
    const n = buf.readUInt32BE(o),
      t = buf.toString('latin1', o + 4, o + 8),
      c = buf.subarray(o + 8, o + 8 + n);
    if (t === 'IHDR') {
      W = c.readUInt32BE(0);
      H = c.readUInt32BE(4);
      ct = c[9];
    }
    if (t === 'IDAT') idat.push(c);
    o += 12 + n;
  }
  const bpp = ct === 6 ? 4 : 3,
    stride = W * bpp,
    raw = zlib.inflateSync(Buffer.concat(idat)),
    out = Buffer.alloc(W * H * 4);
  let prev = Buffer.alloc(stride),
    p = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[p++],
      line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0,
        b = prev[x],
        cc = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const q = a + b - cc,
          pa = Math.abs(q - a),
          pb = Math.abs(q - b),
          pc = Math.abs(q - cc);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
      }
      line[x] = v & 255;
    }
    for (let x = 0; x < W; x++) {
      out[(y * W + x) * 4] = line[x * bpp];
      out[(y * W + x) * 4 + 1] = line[x * bpp + 1];
      out[(y * W + x) * 4 + 2] = line[x * bpp + 2];
      out[(y * W + x) * 4 + 3] = bpp === 4 ? line[x * bpp + 3] : 255;
    }
    prev = line;
  }
  return { W, H, px: out };
}
const name = (c) => {
  let best = '?',
    bd = 1e9;
  for (const [k, v] of Object.entries(RGB)) {
    const d = Math.max(...v.map((x, i) => Math.abs(x - c[i])));
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return bd <= 40 ? best : `rgb(${c.slice(0, 3)})`;
};

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  try {
    res.writeHead(200);
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(u))));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const opts =
  BROWSER === 'firefox'
    ? { browser: 'firefox', headless: true, executablePath: EXE }
    : { headless: 'new', args: ['--no-sandbox'] };
const browser = await launchBrowser(opts);
try {
  console.log(`browser: ${await browser.version()}`);
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 200 });
  await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  console.log('\n<image> fit (18 cases x 12 points); img route | inline route | matches');
  let nSpec = 0,
    nChrome = 0;
  for (const c of CASES) {
    const svg = cellSvg(c);
    const viaImg = (await page.evaluate((s, p) => window.__img(s, 100, 60, p), svg, PTS)).map(name);
    await page.evaluate((s) => window.__inline(s), svg);
    const shot = decodePng(
      Buffer.from(
        await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 100, height: 60 } }),
      ),
    );
    const sx = shot.W / 100; // device pixel ratio
    const viaInline = PTS.map(([x, y]) => {
      const i = (Math.floor((y + 0.5) * sx) * shot.W + Math.floor((x + 0.5) * sx)) * 4;
      return name(Array.from(shot.px.subarray(i, i + 4)));
    });
    const row = viaImg.join(' ');
    const m =
      [row === c.spec.join(' ') ? 'spec' : null, row === c.chrome.join(' ') ? 'chrome' : null]
        .filter(Boolean)
        .join('+') || 'NEITHER';
    if (m.includes('spec')) nSpec++;
    if (m.includes('chrome')) nChrome++;
    console.log(
      `  ${c.id.padStart(2)} ${c.what.padEnd(56)} ${row} | ${viaInline.join(' ') === row ? '(same)' : viaInline.join(' ')} | ${m}`,
    );
  }
  console.log(
    `  -> the img route matches the spec row in ${nSpec}/18 cases and Chrome's in ${nChrome}/18`,
  );
  console.log("\nfeSpecularLighting, the lit rect's center (ground is #4060c0 = 64,96,192)");
  for (const [what, attrs] of SPEC) {
    const [c] = await page.evaluate((s, p) => window.__img(s, 100, 100, p), spec(attrs), [
      [50, 50],
    ]);
    console.log(`  ${what.padEnd(32)} rgba(${c})`);
  }
} finally {
  await browser.close();
  server.close();
}
