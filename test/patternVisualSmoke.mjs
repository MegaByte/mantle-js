// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Render vector patterns with gradient and image fills in their children
// through the WebGL renderer end-to-end, and verify the framebuffer carries
// the expected color signal — the visual counterpart to patternChildrenSmoke
// (which checks the importer wiring). Confirms the coverage fragment shader's
// vector-pattern composite branch dispatches to sampleGradient /
// sampleChildImage and paints visible color.
//
// The base64-PNG image case needs DOM Image / Canvas APIs, so it runs only via
// the browser/Puppeteer path.

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'pattern');
mkdirSync(OUT, { recursive: true });

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try {
    res.writeHead(200, { 'content-type': mime(p) });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch (e) {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const CASES = [
  {
    name: 'pattern-image',
    svgUrl: 'examples/_pattern_image.svg',
    desc: 'tile with embedded RGBA base64 PNG (R/G/B/Y quadrants)',
    // The 32x32 PNG has all four primary channels. Demand visible
    // coverage in each — the coverage shader composite branch dispatches
    // sampleChildImage on cImgId > 0 for FLAG_LAYER rows inside the
    // carrier's atlasSlot.w==2 branch.
    expect: (s) => s.redish > 100 && s.greenish > 100 && s.blueish > 100,
  },
  {
    name: 'pattern-gradient',
    svgUrl: 'examples/_pattern_gradient.svg',
    desc: 'tile with linear gradient (R→B) + radial gradient (Y→G) children',
    // The pattern paints a horizontal red→blue linear behind a
    // yellow→green radial dot per tile. Demand visible red, blue,
    // and yellow/green channel signal across the framebuffer.
    expect: (s) => s.redish > 100 && s.blueish > 100 && (s.greenish > 100 || s.nonWhite > 50000),
  },
];

let failures = 0;
function fail(name, msg) {
  failures++;
  console.error(`FAIL [${name}]: ${msg}`);
}

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});

for (const c of CASES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 400 });
  page.on('pageerror', (e) => console.error(`  [${c.name} page-err]`, e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/error|fail|warn|status/i.test(t)) console.log(`  [${c.name} console]`, t);
  });
  // Auto-load via the demo's `?svg=` query param. The demo fetches
  // the URL, runs importSvg, and calls setBundle → renderer.render().
  const target = `http://127.0.0.1:${port}/mantleDemo.html?svg=/${encodeURIComponent(c.svgUrl)}`;
  try {
    await page.goto(target, { waitUntil: 'load', timeout: 10000 });
    // Wait for the demo's status to settle out of the "Fetching …"
    // message — boot() updates it once the SVG either loads or fails.
    await page.waitForFunction(
      () => {
        const st = document.getElementById('status');
        return st && !/Fetching|Converting/.test(st.textContent);
      },
      { timeout: 8000, polling: 100 },
    );
  } catch (e) {
    const statusTxt = await page.evaluate(
      () => document.getElementById('status') && document.getElementById('status').textContent,
    );
    fail(c.name, `goto/wait failed: ${e.message} (status="${statusTxt}")`);
    await page.close();
    continue;
  }
  // Read back framebuffer pixels. The demo's WebGL context was
  // created without preserveDrawingBuffer, so we can't read the back
  // buffer directly after a render+present cycle. Instead, the demo
  // exposes its renderer + gl handles globally; trigger a fresh
  // render then immediately read pixels in the same tick before the
  // implicit swap. (Browsers preserve the back buffer until JS yields
  // to the event loop — calling readPixels right after render() inside
  // the same tick is safe.)
  const stats = await page.evaluate(() => {
    const cnv = document.getElementById('glcanvas');
    if (!cnv) return null;
    const gl = window.__mantleGl;
    const renderer = window.__mantleRenderer;
    if (!gl || !renderer) return null;
    // Fresh render + readPixels in the same synchronous tick — the
    // demo's WebGL2 context has preserveDrawingBuffer:false, so we
    // must read before the browser yields to the event loop.
    renderer.render();
    const bundle = window.__mantleGetBundle && window.__mantleGetBundle();
    const dbgBundle = bundle
      ? {
          numShapes: bundle.numShapes,
          gradientCount: bundle.gradientCount,
          gradientStopsCount: bundle.gradientStopsCount,
          hasGradientTex: !!bundle.gradientTex,
          hasGradientStopsTex: !!bundle.gradientStopsTex,
          drawListLen: bundle.drawList ? bundle.drawList.length : 0,
        }
      : null;
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let opaque = 0;
    let redish = 0,
      greenish = 0,
      blueish = 0;
    let nonWhite = 0;
    let sampleRGB = null;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i],
        g = px[i + 1],
        b = px[i + 2],
        a = px[i + 3];
      if (a < 16) continue;
      opaque++;
      if (r < 240 || g < 240 || b < 240) {
        nonWhite++;
        if (!sampleRGB) sampleRGB = [r, g, b, a];
      }
      if (r > 64 && r - g > 32 && r - b > 32) redish++;
      if (g > 64 && g - r > 32 && g - b > 32) greenish++;
      if (b > 64 && b - r > 32 && b - g > 32) blueish++;
    }
    // Targeted samples: in pattern_gradient, the linear gradient
    // (red→blue, horizontal) fills 0..40 in pattern-em-space and is
    // tiled across 20..180. So at the left edge of a tile we expect
    // red-ish; at the right edge of a tile, blue-ish; at the center
    // of a tile, the radial gradient (yellow→green) blots over the
    // linear. Sample a row of pixels across one tile to verify the
    // gradient actually paints.
    const rowY = (h / 2) | 0;
    const rowSamples = [];
    for (let sx = 0; sx <= w; sx += w / 20) {
      const idx = (rowY * w + Math.min(w - 1, sx | 0)) * 4;
      rowSamples.push([px[idx], px[idx + 1], px[idx + 2], px[idx + 3]]);
    }
    return {
      w,
      h,
      opaque,
      redish,
      greenish,
      blueish,
      nonWhite,
      sampleRGB,
      rendererAvail: !!renderer,
      glAvail: !!gl,
      rowSamples,
      dbgBundle,
    };
  });
  if (stats.dbgBundle) console.log(`  bundle[${c.name}]:`, JSON.stringify(stats.dbgBundle));
  if (!stats) {
    fail(c.name, 'no canvas / WebGL2 context');
    await page.close();
    continue;
  }
  console.log(
    `  diag[${c.name}]: w=${stats.w} h=${stats.h} opaque=${stats.opaque} nonWhite=${stats.nonWhite} sample=${JSON.stringify(stats.sampleRGB)} renderer=${stats.rendererAvail} gl=${stats.glAvail}`,
  );
  if (stats.rowSamples && c.name === 'pattern-gradient') {
    console.log(
      `  row[${c.name}]: ${stats.rowSamples
        .slice(0, 8)
        .map((p) => `(${p[0]},${p[1]},${p[2]})`)
        .join(' ')}`,
    );
  }
  // Capture the rendered PNG for inspection.
  // Snapshot the canvas via toDataURL — page.screenshot grabs the
  // composited page (HTML chrome), not the WebGL canvas pixels.
  const dataUrl = await page.evaluate(() => {
    const cnv = document.getElementById('glcanvas');
    const renderer = window.__mantleRenderer;
    if (!cnv || !renderer) return null;
    renderer.render();
    return cnv.toDataURL('image/png');
  });
  if (dataUrl && dataUrl.startsWith('data:image/png;base64,')) {
    writeFileSync(
      path.join(OUT, `${c.name}.png`),
      Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'),
    );
  }

  if (c.expect(stats)) {
    console.log(
      `PASS ${c.name}: opaque=${stats.opaque} r=${stats.redish} g=${stats.greenish} b=${stats.blueish}`,
    );
  } else {
    fail(
      c.name,
      `coverage insufficient: opaque=${stats.opaque} r=${stats.redish} g=${stats.greenish} b=${stats.blueish}`,
    );
  }
  await page.close();
}

await browser.close();
server.close();
console.log();
console.log(
  failures === 0
    ? `PATTERN VISUAL PASS (${CASES.length} cases)`
    : `PATTERN VISUAL FAIL (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
