// Puppeteer-driven WebGL render harness for the text pipeline.
//
// Serves the repo root via a tiny static HTTP server, opens
// mantleDemo.html in headless Chromium, calls
// window.mantleRenderText(ttfBytes, markup, opts) for each test case,
// screenshots the canvas, and writes PNGs into font/test/visuals/.
//
// Pass/fail checks (per case): hook returned numShapes > 0, the
// canvas has some non-background pixels (the text actually drew), the
// painted bbox roughly matches the bundle's reported bbox.
//
// Run from the worktree root:
//
//   node font/test/textVisualHarness.mjs
//
// Optional flags:
//   --keep-open  : don't close the browser at the end (open the
//                  served URL in a real browser for debugging).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const OUT  = path.join(__dirname, 'visuals');
mkdirSync(OUT, { recursive: true });

// -------------------- static file server --------------------
function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.ttf') || p.endsWith('.otf')) return 'font/sfnt';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(u.pathname);
  if (p === '/') p = '/mantleDemo.html';
  // Allow access to /System/Library/Fonts via a virtual /__sysfont/ prefix.
  let fp;
  if (p.startsWith('/__sysfont/')) {
    fp = '/System/Library/Fonts/Supplemental/' + p.slice('/__sysfont/'.length);
  } else {
    fp = path.join(ROOT, p);
    if (!fp.startsWith(ROOT) && !fp.startsWith('/System/Library/Fonts')) {
      res.writeHead(403); res.end(); return;
    }
  }
  try {
    const data = readFileSync(fp);
    res.writeHead(200, { 'content-type': mime(fp), 'cache-control': 'no-store' });
    res.end(data);
  } catch (e) {
    res.writeHead(404); res.end(String(e && e.message));
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/mantleDemo.html`;
console.log('serving', ROOT, 'at', url);

// -------------------- test cases --------------------
const FONT_PATH = process.env.MANTLE_FONT || '/System/Library/Fonts/Supplemental/Arial.ttf';
const ttfBytes = new Uint8Array(readFileSync(FONT_PATH));
const ttfArr = Array.from(ttfBytes);   // serializable across page boundary

const cases = [
  {
    name: 'plain',
    markup: 'Hello, World!',
    opts: { defaultColor: [0, 0, 0, 1] },
    expect: { minShapes: 12, maxShapes: 12 },
  },
  {
    name: 'multicolor',
    markup: 'Hello, <color=#f00>World</color>!',
    opts: { defaultColor: [0, 0, 0, 1] },
    expect: { minShapes: 12, maxShapes: 12, hasRed: true },
  },
  {
    name: 'wrap',
    markup: 'Hello World wrapping nicely across lines',
    opts: { defaultColor: [0, 0, 0, 1], maxWidthEm: 6, align: 'left' },
    expect: { minShapes: 30, minLines: 2 },
  },
  {
    name: 'size',
    markup: 'A<size=0.5>b</size>C',
    opts: { defaultColor: [0, 0, 0, 1] },
    expect: { minShapes: 3, maxShapes: 3 },
  },
];

// -------------------- driver --------------------
// Chromium 130+: --use-gl=swiftshader produces a context without
// WebGL2. --enable-unsafe-swiftshader keeps the software path but
// preserves WebGL2.
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});

let failures = 0;
const fail = (caseName, msg) => { console.error(`FAIL [${caseName}]: ${msg}`); failures++; };

for (const c of cases) {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 800, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // Wait for the page's IIFE to wire up window.mantleRenderText.
  await page.waitForFunction(() => window.mantleTextReady === true, { timeout: 5000 });

  const result = await page.evaluate(
    async (ttfArr, markup, opts) => {
      try {
        const ret = await window.mantleRenderText(new Uint8Array(ttfArr), markup, opts);
        return { ok: true, ...ret };
      } catch (e) {
        return { ok: false, err: e && (e.stack || e.message || String(e)) };
      }
    },
    ttfArr, c.markup, c.opts,
  );

  if (!result.ok) { fail(c.name, `hook threw: ${result.err}`); await page.close(); continue; }

  // Pull the captured frame buffer that the hook stashed on window.
  // gl.readPixels returns bottom-up; we flip + composite over white
  // here (the WebGL context has premultipliedAlpha=true).
  const stats = await page.evaluate(() => {
    const f = window.__mantleLastFrame;
    if (!f) return null;
    const w = f.w, h = f.h;
    let dark = 0, red = 0, opaque = 0, minX = w, minY = h, maxX = -1, maxY = -1;
    // Build a composited RGBA buffer (top-down, over-white) for PNG.
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      // Flip Y (readPixels is bottom-up).
      const srcY = h - 1 - y;
      for (let x = 0; x < w; x++) {
        const so = (srcY * w + x) * 4;
        const r = f.data[so], g = f.data[so + 1], b = f.data[so + 2], a = f.data[so + 3];
        // Composite over white (premultiplied -> just src + (1-a)*255).
        const rr = Math.min(255, r + (255 - a));
        const gg = Math.min(255, g + (255 - a));
        const bb = Math.min(255, b + (255 - a));
        const o = (y * w + x) * 4;
        out[o] = rr; out[o + 1] = gg; out[o + 2] = bb; out[o + 3] = 255;
        if (a > 16) {
          opaque++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        if (rr < 128 && gg < 128 && bb < 128) dark++;
        if (rr > 200 && gg < 96 && bb < 96) red++;
      }
    }
    // btoa needs a binary string; build it in chunks to avoid the
    // argument-count limit on String.fromCharCode for ~3MB Uint8Arrays.
    let bin = '';
    for (let i = 0; i < out.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
    }
    return {
      w, h, dark, red, opaque, minX, minY, maxX, maxY,
      pngB64: btoa(bin),
    };
  });
  if (!stats) { fail(c.name, 'no captured frame'); await page.close(); continue; }

  // Encode our composited RGBA as PNG via node's zlib + minimal PNG.
  // Cheaper than shipping a dep — but we already have a Canvas in the
  // page; just round-trip through page.evaluate to encode.
  const pngB64 = await page.evaluate((w, h, raw) => {
    const cnv = document.createElement('canvas');
    cnv.width = w; cnv.height = h;
    const ctx = cnv.getContext('2d');
    const id = ctx.createImageData(w, h);
    // raw is a base64-encoded RGBA byte string from above.
    const bin = atob(raw);
    for (let i = 0; i < bin.length; i++) id.data[i] = bin.charCodeAt(i);
    ctx.putImageData(id, 0, 0);
    return cnv.toDataURL('image/png').split(',')[1];
  }, stats.w, stats.h, stats.pngB64);
  const outPng = path.join(OUT, `${c.name}.png`);
  writeFileSync(outPng, Buffer.from(pngB64, 'base64'));

  // Assertions
  if (c.expect.minShapes != null && result.numShapes < c.expect.minShapes)
    fail(c.name, `numShapes ${result.numShapes} < ${c.expect.minShapes}`);
  if (c.expect.maxShapes != null && result.numShapes > c.expect.maxShapes)
    fail(c.name, `numShapes ${result.numShapes} > ${c.expect.maxShapes}`);
  if (stats.opaque < 50)
    fail(c.name, `only ${stats.opaque} opaque pixels — text didn't draw`);
  if (c.expect.hasRed && stats.red < 10)
    fail(c.name, `expected red pixels (found ${stats.red})`);
  if (c.expect.minLines != null) {
    // Crude: a wrapped run should occupy a taller painted region than
    // a single-line run. We don't know single-line height a-priori,
    // so check the painted box's height/width ratio is > 0.4 (single
    // line is typically <0.3 for this string).
    const h = stats.maxY - stats.minY, w = stats.maxX - stats.minX;
    if (h < w * 0.4) fail(c.name, `painted aspect ${h}/${w}=${(h / w).toFixed(2)} too short for multi-line`);
  }

  const errStr = consoleErrors.length ? ` [console errors: ${consoleErrors.length}]` : '';
  console.log(`${failures === 0 ? 'PASS' : 'CHECK'} ${c.name}: shapes=${result.numShapes} bbox=[${result.bbox.map(v => v.toFixed(2)).join(',')}] opaque=${stats.opaque}px dark=${stats.dark}px red=${stats.red}px → ${outPng}${errStr}`);

  await page.close();
}

if (!process.argv.includes('--keep-open')) {
  await browser.close();
  server.close();
}
console.log();
console.log(failures === 0 ? `VISUAL HARNESS PASS (${cases.length} cases)` : `VISUAL HARNESS FAIL (${failures} failures)`);
process.exit(failures === 0 ? 0 : 1);
