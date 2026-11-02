// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// End-to-end Puppeteer proof that shape morph + timeline primitives
// paint actually-different pixels at different `t` values.
//
// Drives a real WebGL2 context, reads `gl.readPixels`, and asserts that
// the framebuffer's center-pixel color traverses src→mid→dst as the
// timeline advances. Catches the failure mode where the morph's math is
// correct but the renderer paints nothing or sticks at an endpoint.
//
// The renderer API exercised here is the one consumers should drive:
//   const morph = createShapeMorph(gl, bundleA, bundleB);
//   morph.setT(0.5);
//   renderer.render(morph);     // accepts bundles OR animation handles
//
// No `setBundle` call, no `.bundle` unwrap. The renderer auto-binds.

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'shape-animation');
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
  } catch (e) {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/mantleDemo.html`;

// Two visually distinct SVGs sharing one shapeId so the morph
// matcher pairs them. Identical geometry + opacity, different fill
// colors — the meta-plane fillColor lerp produces a magenta-ish
// mid pixel between red (src) and blue (dst).
//
// We can't use positional drift as a signal because the Mantle
// renderer fits each asset's globalBBox to the canvas. Color drift
// is the reliable end-to-end test.
const SRC_SVG = readFileSync(
  new URL('../examples/smoke/shapeAnimationVisual__SRC_SVG.svg', import.meta.url),
  'utf8',
);
const DST_SVG = readFileSync(
  new URL('../examples/smoke/shapeAnimationVisual__DST_SVG.svg', import.meta.url),
  'utf8',
);

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

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
  if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
});

await page.goto(url, { waitUntil: 'load', timeout: 10000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
  timeout: 10000,
  polling: 100,
});

const results = await page.evaluate(
  async (srcSvg, dstSvg) => {
    const { importSvg, createBundle, createShapeMorph, createShapeTimeline } =
      await import('/src/index.js');

    const gl = window.__mantleGl;
    const renderer = window.__mantleRenderer;
    const cnv = document.getElementById('glcanvas');

    async function bundleFromSvg(svg) {
      return createBundle(gl, await importSvg(svg));
    }

    const bSrc = await bundleFromSvg(srcSvg);
    const bDst = await bundleFromSvg(dstSvg);

    function snapshot(handle) {
      renderer.render(handle);
      const w = cnv.width,
        h = cnv.height;
      const px = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // Center pixel = the rect interior (which is full-canvas).
      const i = ((h >> 1) * w + (w >> 1)) * 4;
      return {
        w,
        h,
        data: px,
        center: [px[i], px[i + 1], px[i + 2]],
      };
    }

    // ---- Part A: createShapeMorph direct setT ---------------------
    const morph = createShapeMorph(gl, bSrc, bDst);
    morph.setT(0);
    const snapMorph0 = snapshot(morph);
    morph.setT(0.5);
    const snapMorphMid = snapshot(morph);
    morph.setT(1);
    const snapMorph1 = snapshot(morph);

    // ---- Part B: createShapeTimeline via setTime ------------------
    const tl = createShapeTimeline(
      gl,
      [bSrc, bDst],
      [
        { time: 0, bundleIndex: 0, interp: 'linear' },
        { time: 1, bundleIndex: 1, interp: 'linear' },
      ],
    );
    tl.setTime(0);
    const snapTl0 = snapshot(tl);
    tl.setTime(0.5);
    const snapTlMid = snapshot(tl);
    tl.setTime(1);
    const snapTl1 = snapshot(tl);

    function pngOf(handle, t) {
      if (handle.setT) handle.setT(t);
      else handle.setTime(t);
      renderer.render(handle);
      return cnv.toDataURL('image/png');
    }
    const pngs = {
      'morph-t-0': pngOf(morph, 0),
      'morph-t-0.5': pngOf(morph, 0.5),
      'morph-t-1': pngOf(morph, 1),
      'tl-t-0': pngOf(tl, 0),
      'tl-t-0.5': pngOf(tl, 0.5),
      'tl-t-1': pngOf(tl, 1),
    };

    morph.dispose();
    tl.dispose();
    bSrc.dispose();
    bDst.dispose();

    // Return only the small bits — full pixel buffers would be massive
    // over the JSON bridge. We keep center + the raw bytes for diff math.
    function compress(snap) {
      return {
        center: snap.center,
        // Hash-ish: sum of every 100th pixel for a cheap whole-frame
        // distinctness signal between t values.
        hash: (() => {
          let h = 0;
          for (let i = 0; i < snap.data.length; i += 400)
            h += snap.data[i] + snap.data[i + 1] * 2 + snap.data[i + 2] * 3;
          return h;
        })(),
      };
    }
    return {
      morph0: compress(snapMorph0),
      morphMid: compress(snapMorphMid),
      morph1: compress(snapMorph1),
      tl0: compress(snapTl0),
      tlMid: compress(snapTlMid),
      tl1: compress(snapTl1),
      pngs,
    };
  },
  SRC_SVG,
  DST_SVG,
);

await browser.close();
server.close();

// Save PNGs for visual inspection.
for (const [name, dataUrl] of Object.entries(results.pngs)) {
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) continue;
  writeFileSync(
    path.join(OUT, `${name}.png`),
    Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'),
  );
}
delete results.pngs;

const dumpCenter = (label, s) =>
  `${label} center=(${s.center[0]},${s.center[1]},${s.center[2]}) hash=${s.hash}`;
console.log(`  diag ${dumpCenter('morph t=0  ', results.morph0)}`);
console.log(`  diag ${dumpCenter('morph t=0.5', results.morphMid)}`);
console.log(`  diag ${dumpCenter('morph t=1  ', results.morph1)}`);
console.log(`  diag ${dumpCenter('tl    t=0  ', results.tl0)}`);
console.log(`  diag ${dumpCenter('tl    t=0.5', results.tlMid)}`);
console.log(`  diag ${dumpCenter('tl    t=1  ', results.tl1)}`);

// ---- Assertions: morph ---------------------------------------------
// T1: morph @ t=0 = pure red.
{
  const [r, g, b] = results.morph0.center;
  if (r < 250 || g > 10 || b > 10)
    fail(`T1 morph t=0 center should be pure red; got (${r},${g},${b})`);
  else ok(`T1 morph t=0 → pure red (${r},${g},${b})`);
}
// T2: morph @ t=1 = pure blue.
{
  const [r, g, b] = results.morph1.center;
  if (r > 10 || g > 10 || b < 250)
    fail(`T2 morph t=1 center should be pure blue; got (${r},${g},${b})`);
  else ok(`T2 morph t=1 → pure blue (${r},${g},${b})`);
}
// T3: morph @ t=0.5 = magenta-ish (R+B near 128 each, G near 0).
{
  const [r, g, b] = results.morphMid.center;
  if (!(r > 80 && r < 175 && b > 80 && b < 175 && g < 20))
    fail(`T3 morph t=0.5 center should be magenta-ish (R/B≈128, G≈0); got (${r},${g},${b})`);
  else ok(`T3 morph t=0.5 → magenta lerp (${r},${g},${b})`);
}
// T4: distinct hashes — t=0 / mid / 1 frames are meaningfully different.
{
  const h0 = results.morph0.hash,
    hm = results.morphMid.hash,
    h1 = results.morph1.hash;
  if (h0 === hm || h1 === hm || h0 === h1)
    fail(`T4 morph hashes collide (h0=${h0} hMid=${hm} h1=${h1}); some t value is stuck`);
  else ok(`T4 morph hashes distinct: h0=${h0} hMid=${hm} h1=${h1}`);
}

// ---- Assertions: timeline (same expectations) ----------------------
// T5: timeline @ t=0 = pure red.
{
  const [r, g, b] = results.tl0.center;
  if (r < 250 || g > 10 || b > 10)
    fail(`T5 timeline t=0 center should be pure red; got (${r},${g},${b})`);
  else ok(`T5 timeline t=0 → pure red (${r},${g},${b})`);
}
// T6: timeline @ t=1 = pure blue.
{
  const [r, g, b] = results.tl1.center;
  if (r > 10 || g > 10 || b < 250)
    fail(`T6 timeline t=1 center should be pure blue; got (${r},${g},${b})`);
  else ok(`T6 timeline t=1 → pure blue (${r},${g},${b})`);
}
// T7: timeline @ t=0.5 = magenta lerp.
{
  const [r, g, b] = results.tlMid.center;
  if (!(r > 80 && r < 175 && b > 80 && b < 175 && g < 20))
    fail(`T7 timeline t=0.5 center should be magenta-ish; got (${r},${g},${b})`);
  else ok(`T7 timeline t=0.5 → magenta lerp (${r},${g},${b})`);
}
// T8: morph and timeline produce identical results (same shape under
// the hood). Tolerate ±1 since premultiplied alpha + gamma can shift
// a couple of LSBs.
{
  const close = (a, b) => Math.abs(a - b) <= 1;
  const same =
    close(results.morph0.center[0], results.tl0.center[0]) &&
    close(results.morphMid.center[0], results.tlMid.center[0]) &&
    close(results.morph1.center[2], results.tl1.center[2]);
  if (!same) fail(`T8 morph and timeline centers disagree at matching t values`);
  else ok(`T8 morph and timeline render identically at matching t values`);
}

console.log();
console.log(
  failures === 0 ? 'SHAPE-ANIMATION VISUAL PASS' : `SHAPE-ANIMATION VISUAL FAIL (${failures})`,
);
process.exit(failures === 0 ? 0 : 1);
