// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeDashCapsRenderSmoke -- the stroke shader's dash, cap and join behavior on the GPU. The float32
// emulation proofs are test/strokeDashCapsSmoke.mjs; this renders a few of the same cases with the real shader at 128 px (64-unit
// viewBox, white ground), as importerSemanticsRenderSmoke's importerGeometryAudit cells do:
//   svg      the document under test;
//   control  the same picture authored with simpler features (each dash as its own subpath, dots as discs, the
//            circle as cubics, a translucent solid stroke for a duty): the render must match it to within `tol` (default 4/255);
//   old      the WRONG reading, authored literally: the render must DIFFER from svg by at least 48/255 somewhere.
// Probes are analytic expectations (a stated point reads a stated color). To run the same cells against another shader tree:
//   SMOKE_SHADERS_DIR=DIR/js.kontek.mantle/src/shaders node test/strokeDashCapsRenderSmoke.mjs
//
// CAPS AND JOINS ON THE DEMO PAGE (second page): examples/_stroke_caps_joins.svg through mantleDemo.html, checking the
// envelope:
//   * the yellow line with stroke-linecap="square" has its rectangular endpoint extension (not a round cap);
//   * the white polyline with stroke-linejoin="miter" has a sharp corner filled past the round-elbow envelope.
// The _coverage.glsl LINE branch needs the perpendicular-distance override on square caps AND the miter-join math (both
// also on the cubic path); without them the stroke ends in a round envelope clipped to the segment endpoints.
// Predicates target the small but measurable per-symptom signal: yellow pixels at the FAR endpoint corners of the yellow
// line (square-cap-only territory), and white pixels in the miter wedge OUTSIDE the round-elbow envelope but INSIDE the
// miter envelope. The page's canvas is saved to test/visuals/stroke-caps-joins/fixed.png.
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { slen, tAtLen, ev } from './_strokeDashOracle.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHADERS = process.env.SMOKE_SHADERS_DIR || null;
const doc = (body, vb = '0 0 64 64') => {
  const [x, y, w, h] = vb.split(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/>${body}</svg>`;
};
const WHITE = [255, 255, 255],
  BLACK = [0, 0, 0];
const S = (d, extra = '') => `<path d="${d}" fill="none" stroke="black" ${extra}/>`;

// a dotted quad ("0 g", round caps) has NO dot at its end when the pattern has a gap there; the control draws the dots as discs
const QUAD = {
    t: 'Q',
    p: [
      [8, 48],
      [32, 8],
      [56, 48],
    ],
  },
  QL = slen(QUAD);
const GAP = [9, 10, 10.7, 11.3, 12, 13, 14.3].find((g) => QL - Math.floor(QL / g) * g > 5);
const dots = [];
for (let s = 0; s <= QL + 1e-9; s += GAP) dots.push(ev(QUAD, tAtLen(QUAD, s, QL)));
const dotDiscs = dots.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="4"/>`).join('');
const dotsPlus = dotDiscs + '<circle cx="56" cy="48" r="4"/>';

// a near-closed native arc with square caps (r 3, half width 6, sweep 330); the control is the same circle as cubics
const arcSpan = (sweep) => {
  const r = 3,
    n = Math.ceil(sweep / 90 - 1e-9),
    da = (sweep * Math.PI) / 180 / n,
    al = (4 / 3) * Math.tan(da / 4);
  const P = (t) => [32 + r * Math.cos(t), 32 + r * Math.sin(t)],
    D = (t) => [-r * Math.sin(t), r * Math.cos(t)];
  const s = P(0);
  let dC = `M${s}`,
    e = s;
  for (let i = 0; i < n; i++) {
    const t0 = i * da,
      t1 = t0 + da,
      p0 = P(t0),
      p3 = P(t1),
      d0 = D(t0),
      d3 = D(t1);
    dC += ` C${p0[0] + al * d0[0]} ${p0[1] + al * d0[1]} ${p3[0] - al * d3[0]} ${p3[1] - al * d3[1]} ${p3}`;
    e = p3;
  }
  return { dA: `M${s} A${r} ${r} 0 ${sweep > 180 ? 1 : 0} 1 ${e}`, dC };
};
const ARC = arcSpan(330);

// quad -> cubic, miter join within the limit, the cubic curls back; probe inside the tip (user point 58.5, 20 = view point 18.5, 15)
const QC =
  'M59.55075265818776 29.211091999528506 Q79.84433355733954 56.63774492062523 63.50477220653779 37.8115272604914 C59.53298570566484 66.25398638018126 48.784465803198735 58.220005053197966 60.541439075275065 32.97227860101139';
const VB312 = '40 5 64 64';

const CELLS = [
  {
    name: 'a dash ending 4 before a vertex keeps its square cap past the corner',
    svg: doc(
      S('M6 40 H34 V8', 'stroke-width="12" stroke-linecap="square" stroke-dasharray="24 60"'),
    ),
    control: doc(S('M6 40 H30', 'stroke-width="12" stroke-linecap="square"')),
    old: doc(S('M6 40 H30', 'stroke-width="12" stroke-linecap="butt"')),
    probes: [
      [33, 40, BLACK, 1],
      [35, 44, BLACK, 1],
      [38, 36, WHITE, 1],
      [34, 26, WHITE, 1],
    ],
  },
  {
    name: 'a butt dash ending 4 before a vertex paints no corner join',
    svg: doc(
      S(
        'M6 40 H34 V8',
        'stroke-width="12" stroke-linecap="butt" stroke-linejoin="miter" stroke-dasharray="24 60"',
      ),
    ),
    control: doc(S('M6 40 H30', 'stroke-width="12" stroke-linecap="butt"')),
    old: doc(S('M6 40 H34 V8', 'stroke-width="12" stroke-linecap="butt" stroke-linejoin="miter"')),
    probes: [
      [29, 40, BLACK, 1],
      [33, 40, WHITE, 1],
      [37, 45, WHITE, 1],
    ],
  },
  {
    name: 'a dotted quad shows no dot at its end (a gap there)',
    svg: doc(
      S('M8 48 Q32 8 56 48', `stroke-width="8" stroke-linecap="round" stroke-dasharray="0 ${GAP}"`),
    ),
    control: doc(dotDiscs),
    tol: 150, // a dot is a stroke cap vs a filled disc: edge AA plus a sub-pixel placement difference (about 138)

    old: doc(dotsPlus),
    probes: [
      [56, 48, WHITE, 1],
      [8, 48, BLACK, 1],
    ],
  },
  {
    name: 'a sub-pixel dash pattern reads its duty (0.25 -> 191)',
    svg: doc(S('M4 32 H60', 'stroke-width="8" stroke-dasharray="0.01 0.03"')),
    control: doc(S('M4 32 H60', 'stroke-width="8" stroke-opacity="0.25"')),
    tol: 6,
    old: doc(S('M4 32 H60', 'stroke-width="8" stroke-opacity="0.5"')),
    probes: [
      [32, 32, [191, 191, 191], 6],
      [32, 20, WHITE, 1],
    ],
  },
  {
    name: 'a native arc square cap survives a near arc part (sweep 330)',
    svg: doc(S(ARC.dA, 'stroke-width="12" stroke-linecap="square" stroke-linejoin="round"')),
    control: doc(S(ARC.dC, 'stroke-width="12" stroke-linecap="square" stroke-linejoin="round"')),
    tol: 12,
    old: doc(S(ARC.dA, 'stroke-width="12" stroke-linecap="butt" stroke-linejoin="round"')),
    probes: [[32, 32, BLACK, 1]],
  },
  {
    name: 'the miter tip at a quad-cubic vertex that curls back is painted',
    svg: doc(
      S(
        QC,
        'stroke-width="17.4" stroke-linecap="round" stroke-linejoin="miter" stroke-miterlimit="2.63"',
      ),
      VB312,
    ),
    control: doc(
      S(
        QC,
        'stroke-width="17.4" stroke-linecap="round" stroke-linejoin="miter" stroke-miterlimit="2.63"',
      ),
      VB312,
    ),
    old: doc(S(QC, 'stroke-width="17.4" stroke-linecap="round" stroke-linejoin="bevel"'), VB312),
    probes: [[18.5, 15, BLACK, 1]],
  },
  {
    name: 'an exact 180 degree reversal with a miter join is a butt end',
    svg: doc(
      S('M10 32 L32 32 L10 32', 'stroke-width="10" stroke-linejoin="miter" stroke-linecap="butt"'),
    ),
    control: doc(S('M10 32 H32', 'stroke-width="10" stroke-linecap="butt"')),
    old: doc(
      S('M10 32 H32', 'stroke-width="10" stroke-linecap="butt"') +
        '<circle cx="32" cy="32" r="5"/>',
    ),
    probes: [
      [30, 32, BLACK, 1],
      [34, 32, WHITE, 1],
      [32, 38, WHITE, 1],
    ],
  },
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="128" height="128"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { paint, viewport } from '/test/_auditPaintCases.mjs';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const R = createRenderer(gl, shaders, {}); if (R.ready) await R.ready;
window.__render = async (sources) => {
  viewport(gl, R); R.setFillEngine({ route: 'none', kernel: 'aac', primitives: 'off' });
  const out = [];
  for (const s of sources) {
    const b = createBundle(gl, await importSvg(s, { preserveViewport: true }));
    out.push(Array.from(await paint(gl, R, b))); b.dispose();
  }
  return out;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, {
      'content-type': p.endsWith('.glsl')
        ? 'text/plain'
        : p.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : p.endsWith('.svg')
            ? 'image/svg+xml; charset=utf-8'
            : 'text/javascript',
    });
    res.end(
      readFileSync(
        SHADERS && p.startsWith('/src/shaders/')
          ? path.join(SHADERS, p.slice('/src/shaders/'.length))
          : path.join(ROOT, p),
      ),
    );
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { launchBrowser } = await import('./_launch.mjs');
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const at = (px, x, y) => {
  const i = ((127 - Math.floor(y * 2)) * 128 + Math.floor(x * 2)) * 4;
  return [px[i], px[i + 1], px[i + 2]];
};
const maxDiff = (a, b) => {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};
const worstAt = (a, b) => {
  let m = 0,
    k = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) {
      m = d;
      k = i;
    }
  }
  const q = k >> 2;
  return `at px (${q % 128},${127 - (q >> 7)})`;
};
const inkOf = (px) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] < 250 || px[i + 1] < 250 || px[i + 2] < 250) n++;
  return n;
};
for (const c of CELLS) {
  let px;
  try {
    px = await page.evaluate((s) => window.__render(s), [c.svg, c.control, c.old]);
  } catch (e) {
    fail(c.name + ': ' + e.message);
    continue;
  }
  const [a, b, o] = px;
  const vsControl = maxDiff(a, b),
    vsOld = maxDiff(a, o);
  const bad = c.probes
    .filter(([x, y, want, tol]) => maxDiff(at(a, x, y), want) > tol)
    .map(([x, y, want]) => `(${x},${y}) is [${at(a, x, y)}], wanted [${want}]`);
  const line = `${c.name}: control maxByte ${vsControl}, old differs by ${vsOld}, ink px svg ${inkOf(a)} / control ${inkOf(b)} / old ${inkOf(o)}`;
  if (vsControl > (c.tol ?? 4)) fail(line + ` -- render differs from its control ${worstAt(a, b)}`);
  else if (vsOld < 48) fail(line + " -- vacuous: the wrong reading's picture is the same");
  else if (bad.length) fail(line + ' -- probes: ' + bad.join('; '));
  else ok(line);
}
// Caps and joins on the demo page (its own viewport, the demo's renderer).
async function capsJoinsSection() {
  const OUT = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'visuals',
    'stroke-caps-joins',
  );
  mkdirSync(OUT, { recursive: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 400 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));

  const target = `http://127.0.0.1:${server.address().port}/mantleDemo.html?svg=${encodeURIComponent('/examples/_stroke_caps_joins.svg')}`;
  // READINESS-KEYED: the page is ready when its status text leaves 'Fetching|Converting'. That takes ~1-2 s with a warm driver shader cache and ~11 s
  // with a cold one (the cover program's first compile), so the wait is the lane budget, not a fixed 8 s that fails whenever the cache is cold.
  const tSetup = Date.now();
  try {
    await page.goto(target, { waitUntil: 'load', timeout: pageTimeoutFor() });
    await page.waitForFunction(
      () => {
        const st = document.getElementById('status');
        return st && !/Fetching|Converting/.test(st.textContent);
      },
      { timeout: pageTimeoutFor(), polling: 100 },
    );
    console.log(`  page ready in ${((Date.now() - tSetup) / 1000).toFixed(1)} s`);
  } catch (e) {
    fail(`page setup: ${e.message}`);
    return;
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
    return;
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
    isYellow(stats.yellowCornerProbe) ||
    isYellow(stats.yellowProbe2) ||
    isYellow(stats.yellowProbe3);
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

  await page.close();
}
{
  const before = failures;
  try {
    await capsJoinsSection();
  } catch (e) {
    fail('caps and joins: ' + e.message);
  }
  console.log(
    failures === before
      ? 'STROKE-CAPS-JOINS PASS'
      : `STROKE-CAPS-JOINS FAIL (${failures - before})`,
  );
}
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nstrokeDashCapsRenderSmoke: the dash/cap shader repairs render as their controls on the GPU;' +
    ' square caps and miter joins reach past the round envelope',
);
