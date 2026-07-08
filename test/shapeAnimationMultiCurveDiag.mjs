// shapeAnimationMultiCurveDiag.mjs — diagnostic: at t=1 the morph
// bundle's curveTex content should match dst's curveTex content
// AT SRC POSITIONS. Dump both planes + diff regions.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  const mime = p.endsWith('.html') ? 'text/html'
    : p.endsWith('.js') || p.endsWith('.mjs') ? 'text/javascript'
    : p.endsWith('.svg') ? 'image/svg+xml'
    : p.endsWith('.glsl') ? 'text/plain'
    : 'application/octet-stream';
  try { res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
        res.end(readFileSync(path.join(ROOT, p))); }
  catch { try { res.writeHead(404); res.end(); } catch {} }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

const SRC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0.000 -9.850 267.000 153.950"><path id="card" fill="#ff0000" d="M 0.000 14.650 Q 0.000 0.200 11.700 0.000 Q 75.050 0.000 138.000 0.000 Q 196.450 0.000 254.850 0.000 Q 257.850 0.000 260.100 0.900 Q 267.000 3.650 267.000 14.650 Q 267.000 17.200 267.000 19.750 L 267.000 123.050 Q 267.000 129.450 264.900 133.000 Q 262.150 137.650 255.850 138.000 Q 193.800 138.000 132.700 138.000 Q 72.400 138.000 12.100 138.000 Q 8.600 138.000 6.100 136.750 Q 1.700 134.600 0.450 128.550 Q 0.000 126.250 0.000 123.350 Q 0.000 120.650 0.000 117.950 L 0.000 14.650 Z"/></svg>`;
const DST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0.000 -9.850 267.000 153.950"><path id="card" fill="#0000ff" d="M 0.000 18.650 Q 0.000 5.000 12.150 5.000 Q 66.950 12.450 136.550 12.450 Q 202.550 12.450 0.975 5.800 Q 252.250 5.400 254.850 5.000 Q 264.450 5.000 266.450 13.550 Q 267.000 15.800 267.000 18.650 L 267.000 119.900 Q 266.950 126.750 264.350 129.650 Q 261.750 132.600 254.850 8.350 Q 196.300 141.900 0.525 142.850 Q 4.050 9.000 18.150 134.850 Q 15.100 134.250 12.150 8.350 Q 5.900 132.250 0.013 129.550 Q 1.500 127.850 0.700 125.200 Q 0.000 122.900 0.000 119.900 L 0.000 18.650 Z"/></svg>`;

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 400 });
page.on('pageerror', e => console.error('[page-err]', e.message));
page.on('console', m => console.log('[console]', m.text()));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl);

const result = await page.evaluate(async (srcSvg, dstSvg) => {
  globalThis.__MORPH_DEBUG = true;
  const { importSvg, createBundle, createShapeMorph } =
    await import('/src/index.js');
  const gl = window.__mantleGl;
  const bSrc = createBundle(gl, await importSvg(srcSvg));
  const bDst = createBundle(gl, await importSvg(dstSvg));
  // Meta texel 4 of shape 0 — glyphLoc + bandMax.
  function metaT4(b) {
    const m = b.metaFloats;
    return [m[16] | 0, m[17] | 0, m[18] | 0, m[19] | 0];
  }
  // Read a segment's bbox from the curveFloats at (hx, hy).
  function segData(cf, hx, hy, segType) {
    const base = (hy * 4096 + hx) * 4;
    const hdr = [cf[base], cf[base+1], cf[base+2], cf[base+3]];
    const data = [cf[base+4], cf[base+5], cf[base+6], cf[base+7]];
    return { hdr, data };
  }
  const morph = createShapeMorph(gl, bSrc, bDst);
  // Get sections via the morph's createBundle output bundle.
  const mb = morph.bundle;
  morph.setT(1);

  // At t=1, after setT, the CPU-side bundle.curveFloats isn't necessarily
  // updated — only the GPU texture is. Read it back via a framebuffer +
  // readPixels.
  function readTex(tex, w, h) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    let data = null;
    if (status === gl.FRAMEBUFFER_COMPLETE) {
      data = new Float32Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, data);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    return data;
  }
  // bandTex dims aren't exposed — use bandFloats length.
  const morphBandLen = mb.bandFloats ? mb.bandFloats.length : 0;
  const dstBandLen = bDst.bandFloats ? bDst.bandFloats.length : 0;

  // Print key fields.
  const out = {
    srcMetaT4:   metaT4(bSrc),
    dstMetaT4:   metaT4(bDst),
    morphMetaT4: metaT4(mb),
    srcNumShapes: bSrc.numShapes,
    dstNumShapes: bDst.numShapes,
    morphNumShapes: mb.numShapes,
    srcBandLen: bSrc.bandFloats?.length,
    dstBandLen: bDst.bandFloats?.length,
    morphBandLen: mb.bandFloats?.length,
    srcCurveLen: bSrc.curveFloats?.length,
    dstCurveLen: bDst.curveFloats?.length,
  };
  // Dump first 64 bytes of band region for the morph (the 1x1 collapsed
  // region for shape 0).
  if (mb.bandFloats) {
    const gx = mb.metaFloats[16] | 0;
    const gy = mb.metaFloats[17] | 0;
    const off = (gy * 4096 + gx) * 4;
    out.morphBandHeader = Array.from(mb.bandFloats.subarray(off, off + 32));
  }
  // Dump first 64 floats of dst's band region.
  if (bDst.bandFloats) {
    const gx = bDst.metaFloats[16] | 0;
    const gy = bDst.metaFloats[17] | 0;
    const off = (gy * 4096 + gx) * 4;
    out.dstBandHeader = Array.from(bDst.bandFloats.subarray(off, off + 32));
  }
  morph.dispose();
  bSrc.dispose();
  bDst.dispose();
  return out;
}, SRC_SVG, DST_SVG);

await browser.close();
server.close();
console.log(JSON.stringify(result, null, 2));
