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

const SRC_SVG = readFileSync(new URL('../examples/smoke/shapeAnimationMultiCurveDiag__SRC_SVG.svg', import.meta.url), 'utf8');
const DST_SVG = readFileSync(new URL('../examples/smoke/shapeAnimationMultiCurveDiag__DST_SVG.svg', import.meta.url), 'utf8');

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
