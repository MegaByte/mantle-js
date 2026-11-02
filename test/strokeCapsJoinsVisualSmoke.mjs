// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Verifies stroke caps/joins render with the correct envelope. Renders
// examples/_stroke_caps_joins.svg and checks that:
//   * Yellow line with stroke-linecap="square" has its rectangular
//     endpoint extension (not a round cap).
//   * White polyline with stroke-linejoin="miter" has a sharp corner
//     filled past the round-elbow envelope.
//
// The _coverage.glsl LINE branch needs the perpendicular-distance
// override on square caps AND the miter-join math (both also on the cubic
// path); without them the stroke ends in a round envelope clipped to the
// segment endpoints.
//
// Predicates target the small but measurable per-symptom signal:
//   * count of yellow pixels at the FAR endpoint corners of the
//     yellow line (square-cap-only territory)
//   * count of white pixels in the miter wedge OUTSIDE the round-
//     elbow envelope but INSIDE the miter envelope.
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'stroke-caps-joins');
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

const target = `http://127.0.0.1:${port}/mantleDemo.html?svg=${encodeURIComponent('/examples/_stroke_caps_joins.svg')}`;
// READINESS-KEYED: the page is ready when its status text leaves 'Fetching|Converting'. That takes ~1-2 s with a warm driver shader cache and ~11 s
// with a cold one (the cover program's first compile), so the wait is capped at 60 s, not a fixed 8 s that fails whenever the cache is cold.
const tSetup = Date.now();
try {
  await page.goto(target, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    () => {
      const st = document.getElementById('status');
      return st && !/Fetching|Converting/.test(st.textContent);
    },
    { timeout: 60000, polling: 100 },
  );
  console.log(`  page ready in ${((Date.now() - tSetup) / 1000).toFixed(1)} s`);
} catch (e) {
  fail(`page setup: ${e.message}`);
  await browser.close();
  server.close();
  process.exit(failures);
}

const stats = await page.evaluate(() => {
  const cnv = document.getElementById('glcanvas');
  const gl = window.__mantleGl,
    renderer = window.__mantleRenderer;
  if (!cnv || !gl || !renderer) return null;
  renderer.render();
  const w = cnv.width,
    h = cnv.height;
  const px = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // Map viewBox (-25..25, -25..25) → viewport (0..w, 0..h). gl.readpixels
  // returns bottom-up, so for an SVG point at viewBox-y=Y the gl row is
  //   glY = h - 1 - Math.round(((Y + 25) / 50) * h).
  const emToPxX = (em) => Math.round(((em + 25) / 50) * w);
  const emToPxY = (em) => Math.round(((25 - em) / 50) * h);
  const sample = (svgX, svgY) => {
    const gx = Math.round(((svgX + 25) / 50) * w);
    const gy = h - 1 - Math.round(((svgY + 25) / 50) * h);
    if (gx < 0 || gx >= w || gy < 0 || gy >= h) return [0, 0, 0, 0];
    const o = (gy * w + gx) * 4;
    return [px[o], px[o + 1], px[o + 2], px[o + 3]];
  };
  // Yellow signal probe: a square-cap extension covers the rectangle
  // beyond the line endpoint. The yellow line has endpoints (10, -16)
  // and (18, 16), direction tangent ≈ (8, 32)/√1088 ≈ (0.243, 0.970),
  // half stroke width = 3 em. The square envelope CORNER lies outside the
  // round cap envelope, so probe there:
  //   corner = endpoint + tangent*halfW + normal*halfW
  //          = (18, 16) + (0.243, 0.970)*3 + (-0.970, 0.243)*3
  //          = (15.82, 19.64).
  // Distance from endpoint to corner = √18 ≈ 4.24 > 3 (round radius)
  // → inside square cap, outside round cap.
  const yellowCornerProbe = sample(15.82, 19.64);
  // Two more diagnostic probes near the corner — yellow under a SQUARE
  // cap, background-gray under a ROUND cap.
  const yellowProbe2 = sample(16.5, 19.0);
  const yellowProbe3 = sample(15.0, 19.0);
  // White miter probe: the elbow vertex is at (-6, 10). The interior
  // angle between s0 (direction (12, 12)/√288 ≈ (0.707, 0.707)) and
  // s1 (direction (12, -20)/√544 ≈ (0.514, -0.857)) is acos(s0·s1)
  // = acos(0.707*0.514 + 0.707*(-0.857)) = acos(-0.243) ≈ 104°.
  // Half-angle ≈ 52°. Miter direction is the OUTWARD bisector. The
  // miter tip extends by halfW / cos(52°) = 3 / 0.616 = 4.87 em from
  // the elbow vertex. miterLimit=4 allows up to halfW * 4 = 12 em,
  // so we're well within the limit.
  //
  // The OUTWARD bisector direction: rotate the average of s0 outTan
  // and -s1 inTan by 90° outward. s0 ends pointing (0.707, 0.707);
  // s1 starts pointing (0.514, -0.857). The OUTWARD side (where the
  // miter goes) is the side AWAY from the interior. For an elbow that
  // bends DOWN-RIGHT (s0 going up-right, s1 going down-right), the
  // outward side is the UPPER LEFT. Perpendicular to s0 outTan
  // (0.707, 0.707) pointing OUTWARD = (-0.707, 0.707) [rotated +90°].
  // Perpendicular to s1 inTan (0.514, -0.857) pointing OUTWARD =
  // (-0.857, -0.514) [rotated -90°]. The miter direction is the
  // bisector of these two perpendiculars:
  //   sum = (-0.707, 0.707) + (-0.857, -0.514) = (-1.564, 0.193)
  //   |sum| = √(2.446 + 0.037) = 1.575
  //   normalized = (-0.993, 0.123).
  // Miter tip at elbow (-6, 10) + (-0.993, 0.123) * 4.87:
  //   = (-6 - 4.84, 10 + 0.60) = (-10.84, 10.60)
  //
  // Round-envelope radius = halfW = 3 em. Distance from elbow to miter
  // tip = 4.87 > 3 → miter tip is OUTSIDE the round envelope, INSIDE
  // the miter envelope.
  const whiteMiterTip = sample(-10.84, 10.6);
  // Also probe a point on the miter wedge midway: 3.5 em out (just
  // past the round radius).
  const whiteMiterMid = sample(-6 + -0.993 * 3.5, 10 + 0.123 * 3.5);
  // Body probes — must light up REGARDLESS of cap/join fix (sanity).
  const yellowBody = sample(14, 0); // midpoint of yellow line ≈ (14, 0)
  const whiteBody1 = sample(-12, 4); // midpoint of s0 ≈ (-12, 4)
  const whiteBody2 = sample(0, 0); // midpoint of s1 ≈ (0, 0)
  const bgProbe = sample(-22, -22); // backdrop corner
  // Count yellow / white pixels.
  let yellowPx = 0,
    whitePx = 0,
    grayPx = 0;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i],
      g = px[i + 1],
      b = px[i + 2],
      a = px[i + 3];
    if (a < 16) continue;
    // Yellow ≈ R high, G high, B low.
    if (r > 200 && g > 180 && b < 80) yellowPx++;
    // White: R/G/B all high.
    else if (r > 240 && g > 240 && b > 240) whitePx++;
    // Backdrop gray #444444 ≈ (68,68,68).
    else if (Math.abs(r - 68) < 20 && Math.abs(g - 68) < 20 && Math.abs(b - 68) < 20) grayPx++;
  }
  return {
    w,
    h,
    yellowCornerProbe,
    yellowProbe2,
    yellowProbe3,
    yellowBody,
    whiteMiterTip,
    whiteMiterMid,
    whiteBody1,
    whiteBody2,
    bgProbe,
    yellowPx,
    whitePx,
    grayPx,
  };
});

if (!stats) {
  fail('no canvas / WebGL2 context');
  await browser.close();
  server.close();
  process.exit(failures);
}

console.log('diag:', JSON.stringify(stats, null, 2));

// Save PNG snapshot.
const dataUrl = await page.evaluate(() => {
  const cnv = document.getElementById('glcanvas');
  return cnv ? cnv.toDataURL('image/png') : null;
});
if (dataUrl) {
  writeFileSync(
    path.join(OUT, 'fixed.png'),
    Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'),
  );
}

// Sanity: body probes must light up the right color (separates "broken
// render" from "fix didn't land").
const isYellow = (rgba) => rgba[0] > 200 && rgba[1] > 180 && rgba[2] < 80 && rgba[3] > 200;
const isWhite = (rgba) => rgba[0] > 240 && rgba[1] > 240 && rgba[2] > 240 && rgba[3] > 200;
if (!isYellow(stats.yellowBody))
  fail(`yellow body probe (14, 0) not yellow: ${JSON.stringify(stats.yellowBody)}`);
else console.log('ok yellow body probe lit');
if (!isWhite(stats.whiteBody1) || !isWhite(stats.whiteBody2))
  fail(
    `white body probes not white: s0=${JSON.stringify(stats.whiteBody1)} s1=${JSON.stringify(stats.whiteBody2)}`,
  );
else console.log('ok white body probes lit');

// Square cap test: at least one of the corner probes must be yellow
// (background gray if the square-cap extension is missing).
const squareCapLit =
  isYellow(stats.yellowCornerProbe) || isYellow(stats.yellowProbe2) || isYellow(stats.yellowProbe3);
if (squareCapLit) console.log('ok square cap extension reaches corner probes');
else
  fail(
    `square cap probes all dark — endpoint extension missing. ` +
      `corner=${JSON.stringify(stats.yellowCornerProbe)} ` +
      `p2=${JSON.stringify(stats.yellowProbe2)} ` +
      `p3=${JSON.stringify(stats.yellowProbe3)}`,
  );

// Miter join test: at least one miter-tip probe must be white
// (background gray if the miter-join math is missing).
const miterLit = isWhite(stats.whiteMiterTip) || isWhite(stats.whiteMiterMid);
if (miterLit) console.log('ok miter wedge extends past round envelope');
else
  fail(
    `miter probes all dark — miter join math missing. ` +
      `tip=${JSON.stringify(stats.whiteMiterTip)} ` +
      `mid=${JSON.stringify(stats.whiteMiterMid)}`,
  );

await browser.close();
server.close();
console.log();
console.log(failures === 0 ? 'STROKE-CAPS-JOINS PASS' : `STROKE-CAPS-JOINS FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
