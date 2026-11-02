// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// clipperAnimVisualSmoke.mjs — animatable-clipper API.
//
// Verifies that calling overrides.setClipper(svgId, { localPosition })
// translates the clip mask in world em-space without touching the
// clipped shape's geometry. The fixture is a full-canvas orange rect
// clipped to a 20×20 window at SVG (40, 40)–(60, 60). Translating the
// clipper by +20 in X should move the visible orange region right.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'clipper-anim');
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
  try {
    res.writeHead(200, { 'content-type': mime(p) });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

let failures = 0;
const fail = (m) => {
  failures++;
  console.error(`FAIL: ${m}`);
};

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 400 });
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
page.on('console', (m) => {
  const t = m.text();
  if (/error|fail/i.test(t)) console.log(`  [console]`, t);
});

await openReady(
  page,
  `http://127.0.0.1:${port}/mantleDemo.html?svg=${encodeURIComponent('/examples/_clipper_anim.svg')}`,
  { ready: 'demoSvg' },
);

// Verify the bundle exposes clipperRows.
const meta = await page.evaluate(() => {
  const b = window.__mantleGetBundle && window.__mantleGetBundle();
  return {
    clipperRows: b && b.clipperRows,
    numShapes: b && b.numShapes,
    shapeIds: b && b.shapeIds,
  };
});
console.log('bundle:', JSON.stringify(meta, null, 2));
if (!meta.clipperRows || !meta.clipperRows.window) {
  fail(`bundle.clipperRows missing 'window' entry: ${JSON.stringify(meta.clipperRows)}`);
}

// Install an OverrideTable on the page. Drive draws via renderer.drawBundle
// so the override texture binds correctly each frame.
const installOk = await page.evaluate(async () => {
  const renderer = window.__mantleRenderer;
  const bundle = window.__mantleGetBundle();
  if (!bundle || !renderer) return false;
  const mod = await import('/src/animation/overrides.js');
  const overrides = mod.createOverrideTable(window.__mantleGl, bundle);
  window.__mantleOverrides = overrides;
  // A frame per draw: the frame owns the clear (the frame-entry contract); a bare drawBundle composes.
  window.__mantleDraw = () => {
    renderer.beginFrame([1, 1, 1, 1]);
    renderer.drawBundle(bundle, { overrides });
    renderer.endFrame();
  };
  return true;
});
if (!installOk) fail('failed to install override table');

// Sample pixel colors from the rendered framebuffer at named SVG coords.
async function samplePixels(probes) {
  return await page.evaluate((probes) => {
    const cnv = document.getElementById('glcanvas');
    const gl = window.__mantleGl;
    window.__mantleDraw();
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out = {};
    for (const [name, x, y] of probes) {
      // SVG viewBox 0..100 maps to viewport 0..w.
      const gx = Math.max(0, Math.min(w - 1, Math.round((x / 100) * w)));
      const gy = Math.max(0, Math.min(h - 1, h - 1 - Math.round((y / 100) * h)));
      const o = (gy * w + gx) * 4;
      out[name] = [px[o], px[o + 1], px[o + 2], px[o + 3]];
    }
    return out;
  }, probes);
}

const isOrange = (rgba) => rgba[0] > 200 && rgba[1] > 80 && rgba[1] < 180 && rgba[2] < 50;
// The demo's default backdrop is white when no clip covers.
const isWhite = (rgba) => rgba[0] > 240 && rgba[1] > 240 && rgba[2] > 240;

// --- Frame 0: identity transform ---------------------------------------
{
  const probes = await samplePixels([
    ['inside_window', 50, 50], // SVG center of clip window
    ['outside_left', 30, 50], // left of window
    ['outside_right', 70, 50], // right of window
  ]);
  console.log('frame 0 probes:', JSON.stringify(probes));
  if (isOrange(probes.inside_window)) console.log('ok F0 inside window is orange');
  else fail(`F0 inside_window not orange: ${JSON.stringify(probes.inside_window)}`);
  if (!isOrange(probes.outside_left)) console.log('ok F0 outside-left not orange');
  else fail(`F0 outside_left unexpectedly orange: ${JSON.stringify(probes.outside_left)}`);
  if (!isOrange(probes.outside_right)) console.log('ok F0 outside-right not orange');
  else fail(`F0 outside_right unexpectedly orange: ${JSON.stringify(probes.outside_right)}`);
}

// --- Frame 1: translate clipper +20 em in X --------------------------
{
  const ok = await page.evaluate(() => {
    return window.__mantleOverrides.setClipper('window', { localPosition: [20, 0] });
  });
  if (!ok) {
    fail('setClipper returned false');
  }
  const probes = await samplePixels([
    ['old_window', 50, 50], // inside the clip before the move, outside after it (the clip moves right)
    ['new_window', 70, 50], // new location of clip (shifted +20)
    ['far_right', 90, 50],
  ]);
  console.log('frame 1 probes:', JSON.stringify(probes));
  if (!isOrange(probes.old_window)) console.log('ok F1 old window position not orange');
  else
    fail(`F1 old_window still orange after clip translate: ${JSON.stringify(probes.old_window)}`);
  if (isOrange(probes.new_window)) console.log('ok F1 new window position is orange');
  else fail(`F1 new_window not orange: ${JSON.stringify(probes.new_window)}`);
}

// Save snapshot.
const dataUrl = await page.evaluate(() => {
  const cnv = document.getElementById('glcanvas');
  window.__mantleDraw();
  return cnv.toDataURL('image/png');
});
if (dataUrl) {
  writeFileSync(
    path.join(OUT, 'translated.png'),
    Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'),
  );
}

const auditClips = await page.evaluate(async () => {
  const { runClipCases } = await import('/test/_auditPaintCases.mjs');
  return runClipCases(window.__mantleGl, window.__mantleRenderer);
});
for (const row of auditClips)
  if (row.maxByte > 1 || row.clearMax > 1) fail('placed clip audit ' + JSON.stringify(row));
await browser.close();
server.close();
console.log();
console.log(failures === 0 ? 'CLIPPER-ANIM PASS' : `CLIPPER-ANIM FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
