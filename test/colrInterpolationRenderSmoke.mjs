// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// colrInterpolationRenderSmoke -- how a COLR color line interpolates, on the GPU, through a real font (test/fixtures/fonts/colrInterp.ttf).
//
// Default: OpenType CPAL, "Interpolation of colors". Linear-light values with alpha premultiplied into them, alpha directly, then
// un-premultiplied and the sRGB transfer re-applied. The oracle is that arithmetic, below, at several t, on linear, radial and sweep paints.
// new MantleFontAsset(bytes, { compat: 'chrome' }): against Chrome rasterizing the same font at 8x, box-averaged (_chrome8Ref), over each glyph's
// interior: Chrome interpolates the sRGB-encoded values, not premultiplied. The oracle for what Chrome does is Chrome.
// Also: the two modes differ (the test can tell them apart), a dark ramp has no bands, a variation's stop alpha and a stop that names the text's
// color reach the program, and drawing the compat mode links no program once the default has warmed.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openChrome8Ref } from './_chrome8Ref.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const b64Of = (f) => readFileSync(path.join(ROOT, 'test/fixtures/fonts', f)).toString('base64');
const N = 128;
const COLS = 6;

// ---- the cases: colrInterp.ttf's table (genColrSpecFonts.py) ------------------------------------------------------------------------------
const RED = [255, 0, 0],
  GREEN = [0, 255, 0],
  BLUE = [0, 0, 255],
  WHITE = [255, 255, 255],
  BLACK = [0, 0, 0],
  DARK = [32, 32, 32];
const line = (...stops) => stops.map(([o, c, a]) => ({ o, c, a }));
const FIVE = {
  'red to green': line([0, RED, 1], [1, GREEN, 1]),
  'red to blue': line([0, RED, 1], [1, BLUE, 1]),
  'white to black': line([0, WHITE, 1], [1, BLACK, 1]),
  'red to transparent blue': line([0, RED, 1], [1, BLUE, 0]),
  'transparent red to blue': line([0, RED, 0], [1, BLUE, 1]),
};
const CASES = [];
const five = (letters, kind) =>
  Object.entries(FIVE).forEach(([name, stops], i) =>
    CASES.push({ ch: letters[i], kind, name: `${kind} ${name}`, stops }),
  );
five('ABCDE', 'linear');
CASES.push({
  ch: 'F',
  kind: 'linear',
  name: 'linear red to half-transparent blue',
  stops: line([0, RED, 1], [1, BLUE, 0.5]),
});
CASES.push({
  ch: 'H',
  kind: 'linear',
  name: 'linear three stops',
  stops: line([0, RED, 1], [0.25, GREEN, 1], [1, BLUE, 1]),
});
five('IJKLM', 'radial');
five('NOPQR', 'sweep');
CASES.push({ ch: 'S', kind: 'repeat', name: 'repeat red to green', stops: FIVE['red to green'] });
CASES.push({ ch: 'T', kind: 'reflect', name: 'reflect red to green', stops: FIVE['red to green'] });
CASES.push({
  ch: 'U',
  kind: 'linear',
  name: 'linear red to the text color at alpha 0.5',
  stops: line([0, RED, 1], [1, GREEN, 0.5]),
  color: [0, 1, 0, 1],
});
const TS = [0.1, 0.25, 0.5, 0.75, 0.9];
// Levels of 8 bits. A reading against arithmetic is one rounding, plus a ramp's step inside its own pixel. A reading against Chrome is that on each side,
// and Chrome's bytes are straight here, multiplied back by an alpha that was itself rounded.
const SPEC_TOL = 1,
  CHROME_TOL = 2;

// ---- the two readings, as arithmetic. Both return premultiplied bytes, as a premultiplied target holds them ----------------------------------
const toLin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const q8 = (a) => Math.round(a * 255) / 255; // the stop table holds alpha in 8 bits
const bracket = (stops, t) => {
  if (t <= stops[0].o) return [stops[0], stops[0], 0];
  for (let i = 1; i < stops.length; i++)
    if (t <= stops[i].o)
      return [stops[i - 1], stops[i], (t - stops[i - 1].o) / (stops[i].o - stops[i - 1].o)];
  const l = stops[stops.length - 1];
  return [l, l, 0];
};
function specAt(stops, t) {
  const [p, q, k] = bracket(stops, t);
  const pa = q8(p.a),
    qa = q8(q.a),
    a = pa + (qa - pa) * k;
  return [0, 1, 2]
    .map((i) => {
      const m = toLin(p.c[i]) * pa * (1 - k) + toLin(q.c[i]) * qa * k;
      return a > 0 ? 255 * toSrgb(Math.min(1, m / a)) * a : 0;
    })
    .concat(255 * a);
}
function chromeAt(stops, t) {
  const [p, q, k] = bracket(stops, t);
  const pa = q8(p.a),
    qa = q8(q.a),
    a = pa + (qa - pa) * k;
  return [0, 1, 2].map((i) => (p.c[i] + (q.c[i] - p.c[i]) * k) * a).concat(255 * a);
}

// ---- geometry: glyph space (u right, v up, 0..1 across the square), the gradient parameter there, and where to read one t -------------------
function tAt(kind, u, v) {
  if (kind === 'linear') return u;
  if (kind === 'radial') return Math.min(1, Math.hypot(u - 0.5, v - 0.5) / 0.5);
  if (kind === 'sweep') {
    const a = Math.atan2(v - 0.5, u - 0.5) / (2 * Math.PI);
    return a < 0 ? a + 1 : a;
  }
  const w = u * 2;
  if (kind === 'repeat') return w - Math.floor(w);
  const f = w / 2 - Math.floor(w / 2); // reflect
  return f < 0.5 ? f * 2 : (1 - f) * 2;
}
function pixelFor(kind, t) {
  let u = t,
    v = 0.5;
  if (kind === 'radial') u = 0.5 + 0.5 * t;
  if (kind === 'sweep') {
    u = 0.5 + 0.35 * Math.cos(t * 2 * Math.PI);
    v = 0.5 + 0.35 * Math.sin(t * 2 * Math.PI);
  }
  if (kind === 'repeat' || kind === 'reflect') u = 0.25 * t + 0.5 * (kind === 'repeat' ? 1 : 0); // inside one period (reflect's first half-period)
  return [Math.min(N - 1, Math.floor(u * N)), Math.min(N - 1, Math.floor((1 - v) * N))];
}
// A pixel's center in glyph space: rows top-down.
const centerUV = (x, y) => [(x + 0.5) / N, 1 - (y + 0.5) / N];

const svgFont = (family, b64) =>
  `<style>@font-face{font-family:'${family}';src:url(data:font/ttf;base64,${b64})}</style>`;
const CH = b64Of('colrInterp.ttf'),
  VAR = b64Of('colrInterpVar.ttf');
const ROWS = Math.ceil(CASES.length / COLS);
const cellOf = (i) => [(i % COLS) * N, Math.floor(i / COLS) * N];
const hex = (c) =>
  '#' +
  c
    .slice(0, 3)
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
// One Chrome pass over a grid of glyphs: each cell is N x N with the glyph's square exactly on it (the font's ascent 1000, upem 1000).
const chromeGrid = (W, H, family, b64, items) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svgFont(family, b64)}` +
  items
    .map(
      ({ ch, x, y, color, wght }) =>
        `<text x="${x}" y="${y + N}" font-family="${family}" font-size="${N}" fill="${color ? hex(color) : '#000'}"` +
        `${wght != null ? ` style="font-variation-settings:'wght' ${wght}"` : ''}>${ch}</text>`,
    )
    .join('') +
  '</svg>';

let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const worstOf = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
const fmt = (a) => a.map((v) => Math.round(v * 10) / 10).join(',');

const ref = await openChrome8Ref(launchBrowser);
const { page } = ref;
await page.evaluate(
  async (N0, chB64, varB64) => {
    const M = await import('/src/index.js');
    const { MantleFontAsset } = await import('/src/font/fontAsset.js');
    const { registerColorEmojiReaders } = await import('/src/font/color/index.js');
    const { registerVariableFontReaders } = await import('/src/font/variations/index.js');
    registerColorEmojiReaders();
    registerVariableFontReaders();
    const bytes = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
    const cv = document.createElement('canvas');
    cv.width = cv.height = N0;
    const gl = cv.getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: true,
      alpha: true,
    });
    const links = { n: 0 };
    const realLink = gl.linkProgram.bind(gl);
    gl.linkProgram = (p) => {
      links.n++;
      realLink(p);
    };
    const shaders = await M.loadShaders(new URL('/src/shaders/', location.href).href);
    const R = M.createRenderer(gl, shaders, {});
    if (R.ready) await R.ready;
    const fonts = {
      interp: {
        spec: new MantleFontAsset(bytes(chB64)),
        chrome: new MantleFontAsset(bytes(chB64), { compat: 'chrome' }),
      },
      var: {
        spec: new MantleFontAsset(bytes(varB64)),
        chrome: new MantleFontAsset(bytes(varB64), { compat: 'chrome' }),
      },
    };
    const draw = (tb) => {
      R.setViewport(N0, N0);
      gl.viewport(0, 0, N0, N0);
      R.beginFrame([0, 0, 0, 0]);
      R.drawBundle(tb);
      R.endFrame();
    };
    // Premultiplied bytes as the target holds them, rows top-down.
    const read = () => {
      const px = new Uint8Array(N0 * N0 * 4),
        out = new Uint8Array(N0 * N0 * 4);
      gl.readPixels(0, 0, N0, N0, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let y = 0; y < N0; y++)
        out.set(px.subarray((N0 - 1 - y) * N0 * 4, (N0 - y) * N0 * 4), y * N0 * 4);
      return Array.from(out);
    };
    window.__glyph = async (font, mode, ch, color, varCoords) => {
      const tb = await M.createTextBundle(gl, {
        font: fonts[font][mode],
        text: ch,
        style: { fontSize: 1, fill: color || [0, 0, 0, 1], varCoords: varCoords || null },
      });
      const warmed = await R.warmScene([{ draw: () => draw(tb) }], {
        maxPasses: 16,
        fenceTimeoutMs: 60000,
      });
      if (!warmed.complete) throw Error('did not warm: ' + JSON.stringify(warmed));
      draw(tb);
      const px = read();
      tb.dispose();
      return px;
    };
    // Warm the default mode's glyph, then draw the same glyph in compat mode with no warm of its own: what a game does in play.
    window.__linksInPlay = async () => {
      const warm = await M.createTextBundle(gl, {
        font: fonts.interp.spec,
        text: 'A',
        style: { fontSize: 1, fill: [0, 0, 0, 1] },
      });
      const warmed = await R.warmScene([{ draw: () => draw(warm) }], {
        maxPasses: 16,
        fenceTimeoutMs: 60000,
      });
      if (!warmed.complete) throw Error('did not warm');
      const compat = await M.createTextBundle(gl, {
        font: fonts.interp.chrome,
        text: 'A',
        style: { fontSize: 1, fill: [0, 0, 0, 1] },
      });
      const before = links.n;
      draw(compat);
      const n = links.n - before;
      const px = read();
      warm.dispose();
      compat.dispose();
      return {
        links: n,
        total: links.n,
        mid: px.slice(((N0 / 2) * N0 + N0 / 2) * 4, ((N0 / 2) * N0 + N0 / 2) * 4 + 4),
      };
    };
  },
  N,
  CH,
  VAR,
);
const at = (px, x, y) => {
  const i = (y * N + x) * 4;
  return [px[i], px[i + 1], px[i + 2], px[i + 3]];
};

try {
  // The glyph's square has to sit exactly on the canvas for t to be known at a pixel.
  const box = await page.evaluate((c) => window.__glyph('interp', 'spec', c), 'B');
  const edges = [
    at(box, 0, N >> 1)[3],
    at(box, N - 1, N >> 1)[3],
    at(box, N >> 1, 0)[3],
    at(box, N >> 1, N - 1)[3],
  ];
  if (edges.every((a) => a === 255)) ok('the square glyph fills the canvas');
  else fail(`the square glyph does not fill the canvas: edge alphas ${edges}`);

  // ---- the default against the spec's arithmetic ------------------------------------------------------------------------------------------
  const spec = {};
  for (const c of CASES) {
    spec[c.ch] = await page.evaluate(
      (ch, col) => window.__glyph('interp', 'spec', ch, col),
      c.ch,
      c.color || null,
    );
    let worst = 0,
      where = '';
    for (const t0 of TS) {
      const [x, y] = pixelFor(c.kind, t0),
        [u, v] = centerUV(x, y),
        t = tAt(c.kind, u, v);
      const got = at(spec[c.ch], x, y),
        want = specAt(c.stops, t),
        d = worstOf(got, want);
      if (d > worst) {
        worst = d;
        where = `t ${t.toFixed(3)}: got ${got}, want ${fmt(want)}`;
      }
    }
    const msg = `spec, ${c.name}: within ${worst.toFixed(2)} levels of OpenType's arithmetic at ${TS.length} t (${where})`;
    if (worst <= SPEC_TOL) ok(msg);
    else fail(msg);
  }

  // ---- compat against Chrome, over each glyph's interior -----------------------------------------------------------------------------------
  const W = COLS * N,
    H = ROWS * N;
  const chromeSvg = chromeGrid(
    W,
    H,
    'colrInterp',
    CH,
    CASES.map((c, i) => {
      const [x, y] = cellOf(i);
      return { ch: c.ch, x, y, color: c.color };
    }),
  );
  const blank = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="1" height="1" fill="#000"/></svg>`;
  const cr = await ref.render(blank, { w: W, h: H, ground: 'transparent', chromeSvg });
  const chromeAtPx = (cell, x, y) => {
    // premultiplied, as Mantle's target
    const [cx, cy] = cellOf(cell),
      i = ((cy + y) * W + cx + x) * 4,
      a = cr.chrome[i + 3];
    return [
      (cr.chrome[i] * a) / 255,
      (cr.chrome[i + 1] * a) / 255,
      (cr.chrome[i + 2] * a) / 255,
      a,
    ];
  };
  // The discontinuities, not interpolation: a border pixel, the sweep's seam and center, repeat's seam, each of which Chrome point-samples.
  const interior = (kind, x, y) => {
    if (x < 2 || y < 2 || x >= N - 2 || y >= N - 2) return false;
    const [u, v] = centerUV(x, y);
    if (kind === 'sweep')
      return !(Math.hypot(u - 0.5, v - 0.5) < 0.08 || (u > 0.5 && Math.abs(v - 0.5) < 0.03));
    if (kind === 'radial') return Math.hypot(u - 0.5, v - 0.5) > 0.03;
    if (kind === 'repeat') return Math.abs(u * 2 - Math.round(u * 2)) > 0.04;
    return true;
  };
  CASES.forEach((c, i) => {
    const [x, y] = pixelFor(c.kind, 0.5),
      [u, v] = centerUV(x, y),
      t = tAt(c.kind, u, v);
    const got = chromeAtPx(i, x, y),
      want = chromeAt(c.stops, t),
      d = worstOf(got, want);
    const msg = `Chrome's own render is sRGB-encoded and straight, ${c.name}: ${d.toFixed(2)} levels from that arithmetic at t ${t.toFixed(3)} (${fmt(got)})`;
    if (d <= SPEC_TOL) ok(msg);
    else fail(msg);
  });
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const px = await page.evaluate(
      (ch, col) => window.__glyph('interp', 'chrome', ch, col),
      c.ch,
      c.color || null,
    );
    let worst = 0,
      where = '',
      n = 0;
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        if (!interior(c.kind, x, y)) continue;
        n++;
        const got = at(px, x, y),
          want = chromeAtPx(i, x, y),
          d = worstOf(got, want);
        if (d > worst) {
          worst = d;
          where = `(${x},${y}): got ${got}, Chrome ${fmt(want)}`;
        }
      }
    const msg = `compat chrome, ${c.name}: within ${worst.toFixed(2)} levels of Chrome over ${n} px (${where})`;
    if (worst <= CHROME_TOL) ok(msg);
    else fail(msg);
    // The modes must be told apart where they differ, or none of this reads anything.
    if (c.ch === 'A') {
      const [mx, my] = pixelFor('linear', 0.5),
        a = at(spec.A, mx, my),
        b = at(px, mx, my);
      console.log(
        `  midpoint of red to green: default ${a}, compat ${b}, Chrome ${fmt(chromeAtPx(i, mx, my))}`,
      );
      if (a[1] - b[1] >= 50)
        ok('the default and compat chrome read differently at the midpoint of an opaque line');
      else
        fail(
          `the default and compat chrome read the same at the midpoint of an opaque line: ${a} / ${b}`,
        );
    }
    if (c.ch === 'D') {
      const [mx, my] = pixelFor('linear', 0.5);
      console.log(
        `  midpoint of red to transparent blue: default ${at(spec.D, mx, my)}, compat ${at(px, mx, my)}, Chrome ${fmt(chromeAtPx(i, mx, my))}`,
      );
    }
  }

  // ---- no bands: every sRGB level of a dark ramp is drawn, in order. A linear table of 8 bits holds 4 steps of it ----------------------------
  const dark = await page.evaluate(() => window.__glyph('interp', 'spec', 'G'));
  const row = [];
  for (let x = 0; x < N; x++) row.push(at(dark, x, N >> 1)[0]);
  let monotone = true,
    maxStep = 0;
  for (let x = 1; x < N; x++) {
    if (row[x] < row[x - 1]) monotone = false;
    maxStep = Math.max(maxStep, row[x] - row[x - 1]);
  }
  const levels = new Set(row).size;
  const lut8 = new Set();
  for (let x = 0; x < N; x++) {
    const l = (toLin(32) * (x + 0.5)) / N;
    lut8.add(Math.round(255 * toSrgb(Math.round(l * 255) / 255)));
  }
  const msg = `a dark ramp draws ${levels} distinct levels over ${N} px, step at most ${maxStep}, ${monotone ? 'monotone' : 'NOT monotone'} (a linear 8-bit table would draw ${lut8.size})`;
  if (monotone && maxStep <= 1 && levels >= 32) ok(msg);
  else fail(msg);

  // ---- a variation's stop alpha reaches the program, in both modes ----------------------------------------------------------------------------
  // The fixture's second stop has alpha 1 - wght.
  const WGHTS = [0, 0.5, 1];
  const crVar = await ref.render(blank, {
    w: WGHTS.length * N,
    h: N,
    ground: 'transparent',
    chromeSvg: chromeGrid(
      WGHTS.length * N,
      N,
      'colrInterpVar',
      VAR,
      WGHTS.map((wght, i) => ({ ch: 'A', x: i * N, y: 0, wght })),
    ),
  });
  for (let w = 0; w < WGHTS.length; w++) {
    const wght = WGHTS[w],
      fade = line([0, RED, 1], [1, BLUE, 1 - wght]);
    const px = await page.evaluate(
      (v) => window.__glyph('var', 'spec', 'A', null, { wght: v }),
      wght,
    );
    let worst = 0,
      where = '';
    for (const t0 of TS) {
      const [x, y] = pixelFor('linear', t0),
        [u] = centerUV(x, y);
      const got = at(px, x, y),
        want = specAt(fade, u),
        d = worstOf(got, want);
      if (d > worst) {
        worst = d;
        where = `t ${u.toFixed(3)}: got ${got}, want ${fmt(want)}`;
      }
    }
    const m1 = `spec, the variation at wght ${wght}: within ${worst.toFixed(2)} levels (${where})`;
    if (worst <= SPEC_TOL) ok(m1);
    else fail(m1);
    const cp = await page.evaluate(
      (v) => window.__glyph('var', 'chrome', 'A', null, { wght: v }),
      wght,
    );
    let cw = 0,
      cwhere = '';
    for (let y = 8; y < N - 8; y += 4)
      for (let x = 2; x < N - 2; x++) {
        const i = (y * (WGHTS.length * N) + w * N + x) * 4,
          a = crVar.chrome[i + 3];
        const want = [
            (crVar.chrome[i] * a) / 255,
            (crVar.chrome[i + 1] * a) / 255,
            (crVar.chrome[i + 2] * a) / 255,
            a,
          ],
          got = at(cp, x, y),
          d = worstOf(got, want);
        if (d > cw) {
          cw = d;
          cwhere = `(${x},${y}): got ${got}, Chrome ${fmt(want)}`;
        }
      }
    const m2 = `compat chrome, the variation at wght ${wght}: within ${cw.toFixed(2)} levels of Chrome (${cwhere})`;
    if (cw <= CHROME_TOL) ok(m2);
    else fail(m2);
  }

  // ---- selecting the mode links nothing ------------------------------------------------------------------------------------------------------
  const lp = await page.evaluate(() => window.__linksInPlay());
  // The counter has to be able to read something: the renderer's own programs went through it.
  if (!(lp.total > 0)) fail('the link counter never moved, so its zero below means nothing');
  if (lp.links === 0)
    ok(
      `drawing compat chrome after only the default warmed links no program, of ${lp.total} linked in the page (mid ${lp.mid})`,
    );
  else fail(`drawing compat chrome after only the default warmed linked ${lp.links} program(s)`);
} catch (e) {
  fail('setup: ' + ((e && e.stack) || e));
}
if (ref.pageErrors.length) fail('page errors: ' + ref.pageErrors.slice(0, 5).join(' | '));
await ref.close();
if (failures) {
  console.error(`colrInterpolationRenderSmoke FAIL (${failures})`);
  process.exit(1);
}
console.log('colrInterpolationRenderSmoke PASS');
