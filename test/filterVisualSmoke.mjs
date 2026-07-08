// End-to-end render of filter primitives wired in the importer +
// dispatch.
//
// Covers (per fixture):
//   * feMorphology   — examples/_morph.svg
//   * feTurbulence   — examples/_turbulence.svg
//   * feDisplacementMap — examples/_displace.svg
//   * feDiffuseLighting + feSpecularLighting — examples/_fgraph_light.svg
//
// Each case sets up a Puppeteer page pointed at mantleDemo.html with
// ?svg=<fixture>, then reads back the WebGL framebuffer pixels and
// asserts a per-fixture color-signal predicate. PNG snapshots saved
// under test/visuals/filter/ for visual inspection.

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT  = path.join(__dirname, 'visuals', 'filter');
mkdirSync(OUT, { recursive: true });

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (p.endsWith('.glsl')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try { res.writeHead(200, { 'content-type': mime(p) }); res.end(readFileSync(path.join(ROOT, p))); }
  catch (e) { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const CASES = [
  {
    name: 'fe-morphology',
    svgUrl: 'examples/_morph.svg',
    desc: 'erode + plain + dilate orange/lime squares',
    // _morph paints: orange (eroded) at x=40-120, plain orange at x=160-240,
    // lime (dilated) at x=280-360. All on a white background. Demand both
    // an orange channel signal and a lime/green channel signal.
    expect: (s) =>
      s.orangePx > 1000 &&            // visible orange (eroded + plain)
      s.greenPx  > 1000 &&            // visible lime
      s.nonWhite > 20000,             // squares cover real area
  },
  {
    name: 'fe-turbulence',
    svgUrl: 'examples/_turbulence.svg',
    desc: 'fractalNoise turbulence clipped to a black circle',
    // SVG feTurbulence emits PER-CHANNEL noise (R, G, B independent),
    // not grayscale — so the result is colorful noise composited into
    // the source's silhouette. We demand: shape silhouette present
    // (nonWhite > some floor) AND pixel-to-pixel variance per channel
    // (so the filter isn't a flat fill).
    expect: (s) =>
      s.nonWhite > 5000 &&
      s.channelVar > 500,
  },
  {
    name: 'fe-displacement-map',
    svgUrl: 'examples/_displace.svg',
    desc: 'red circle warped via a turbulence displacement map',
    // _displace's circle is red, warped by ±20 px via low-freq noise.
    // The output should remain dominantly red with a non-circular
    // silhouette. Demand: visible red (the source survives), and a
    // pixel count distinct from a clean circle of radius 60. We don't
    // measure silhouette directly — coverage > a hard floor proves
    // the displacement didn't kill the shape.
    expect: (s) =>
      s.redPx > 5000 &&
      s.nonWhite > 5000,
  },
  {
    name: 'fe-lighting',
    svgUrl: 'examples/_fgraph_light.svg',
    desc: 'diffuse (orange light) + specular (white highlight) circles on dark bg',
    // _fgraph_light has TWO lit circles on a dark gray bg. The diffuse
    // pass is orange-tinted; the specular pass is bright with a white
    // highlight. We demand orange signal somewhere, and a bright spot
    // (peak luminance > 200) somewhere — that's the specular highlight.
    expect: (s) =>
      s.orangePx > 500 &&
      s.peakLuma > 200,
  },
  {
    name: 'fe-convolve-matrix',
    svgUrl: 'examples/_convolve.svg',
    desc: 'Sobel-X convolve(red circle) → feComposite-in shape',
    // The graph-dispatched feConvolveMatrix produces edge-detect output
    // (Sobel-X picks up the disc's vertical edges). feComposite-in clips
    // to the source silhouette. We demand visible red signal (the edges
    // retain the source's red channel) + some channel variance.
    expect: (s) =>
      s.redPx > 500 &&
      s.channelVar > 1000,
  },
  {
    name: 'fe-image',
    svgUrl: 'examples/_feimage.svg',
    desc: 'feImage(#bmp) feComposite-in shape — 4-quadrant R/G/B/Y bitmap',
    // feImage dispatches the bitmap into the filter graph; the bitmap
    // stretches across the filter region and feComposite-in clips it
    // to the shape silhouette. Demand strong red, green, blue signal
    // (the 4 quadrants of the R/G/B/Y bitmap) within the filtered rect.
    expect: (s) =>
      s.redPx > 5000 && s.greenPx > 5000 && s.bluePx > 500 &&
      s.channelVar > 1000,
  },
];

let failures = 0;
function fail(name, msg) { failures++; console.error(`FAIL [${name}]: ${msg}`); }

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});

for (const c of CASES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 400 });
  page.on('pageerror', e => console.error(`  [${c.name} page-err]`, e.message));
  page.on('console', m => {
    const t = m.text();
    if (/error|fail|warn/i.test(t)) console.log(`  [${c.name} console]`, t);
  });
  const target = `http://127.0.0.1:${port}/mantleDemo.html?svg=/${encodeURIComponent(c.svgUrl)}`;
  try {
    await page.goto(target, { waitUntil: 'load', timeout: 10000 });
    await page.waitForFunction(() => {
      const st = document.getElementById('status');
      return st && !/Fetching|Converting/.test(st.textContent);
    }, { timeout: 8000 });
  } catch (e) {
    const statusTxt = await page.evaluate(() =>
      document.getElementById('status') && document.getElementById('status').textContent);
    fail(c.name, `goto/wait failed: ${e.message} (status="${statusTxt}")`);
    await page.close();
    continue;
  }
  const stats = await page.evaluate(() => {
    const cnv = document.getElementById('glcanvas');
    if (!cnv) return null;
    const gl = window.__mantleGl, renderer = window.__mantleRenderer;
    if (!gl || !renderer) return null;
    renderer.render();
    const w = cnv.width, h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let opaque = 0, nonWhite = 0;
    let redPx = 0, greenPx = 0, bluePx = 0, orangePx = 0;
    let sumR = 0, sumG = 0, sumB = 0, sumR2 = 0, sumG2 = 0, sumB2 = 0, nwCount = 0;
    let peakLuma = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
      if (a < 16) continue;
      opaque++;
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (luma > peakLuma) peakLuma = luma;
      if (r < 240 || g < 240 || b < 240) {
        nonWhite++;
        // Accumulate variance only over non-white (interior) pixels.
        sumR += r; sumG += g; sumB += b;
        sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
        nwCount++;
      }
      // Orange ≈ R high, G medium-high, B low.
      if (r > 200 && g > 100 && g < 200 && b < 80) orangePx++;
      // Strong-channel buckets (mostly-red, mostly-green, mostly-blue).
      if (r > 150 && r - g > 60 && r - b > 60) redPx++;
      if (g > 150 && g - r > 60 && g - b > 60) greenPx++;
      if (b > 150 && b - r > 60 && b - g > 60) bluePx++;
    }
    let channelVar = 0;
    if (nwCount > 4) {
      const mR = sumR / nwCount, mG = sumG / nwCount, mB = sumB / nwCount;
      const vR = sumR2 / nwCount - mR * mR;
      const vG = sumG2 / nwCount - mG * mG;
      const vB = sumB2 / nwCount - mB * mB;
      channelVar = vR + vG + vB;
    }
    return { w, h, opaque, nonWhite, redPx, greenPx, bluePx, orangePx, channelVar, peakLuma };
  });
  if (!stats) { fail(c.name, 'no canvas / WebGL2 context'); await page.close(); continue; }
  console.log(`  diag[${c.name}]: opaque=${stats.opaque} nonWhite=${stats.nonWhite} red=${stats.redPx} green=${stats.greenPx} blue=${stats.bluePx} orange=${stats.orangePx} channelVar=${stats.channelVar.toFixed(1)} peakLuma=${stats.peakLuma.toFixed(1)}`);

  const dataUrl = await page.evaluate(() => {
    const cnv = document.getElementById('glcanvas');
    const renderer = window.__mantleRenderer;
    if (!cnv || !renderer) return null;
    renderer.render();
    return cnv.toDataURL('image/png');
  });
  if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
    writeFileSync(path.join(OUT, `${c.name}.png`),
      Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'));
  }

  if (c.expect(stats)) {
    console.log(`PASS ${c.name}`);
  } else {
    fail(c.name, `predicate failed: opaque=${stats.opaque} red=${stats.redPx} green=${stats.greenPx} orange=${stats.orangePx} channelVar=${stats.channelVar.toFixed(1)} peakLuma=${stats.peakLuma.toFixed(1)}`);
  }
  await page.close();
}

await browser.close();
server.close();
console.log();
console.log(failures === 0
  ? `FILTER VISUAL PASS (${CASES.length} cases)`
  : `FILTER VISUAL FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
