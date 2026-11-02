// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeDashCapsRenderSmoke -- the stroke shader's dash, cap and join behavior on the GPU. The float32
// emulation proofs are test/strokeDashCapsSmoke.mjs; this renders a few of the same cases with the real shader at 128 px (64-unit
// viewBox, white ground), as importerGeometryAuditRenderSmoke does:
//   svg      the document under test;
//   control  the same picture authored with simpler features (each dash as its own subpath, dots as discs, the
//            circle as cubics, a translucent solid stroke for a duty): the render must match it to within `tol` (default 4/255);
//   old      the WRONG reading, authored literally: the render must DIFFER from svg by at least 48/255 somewhere.
// Probes are analytic expectations (a stated point reads a stated color). To run the same cells against another shader tree:
//   SMOKE_SHADERS_DIR=DIR/js.kontek.mantle/src/shaders node test/strokeDashCapsRenderSmoke.mjs
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { slen, tAtLen, ev } from './_strokeDashOracle.mjs';

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
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
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
await browser.close();
server.close();
if (failures) {
  console.error('\n' + failures + ' failure(s)');
  process.exit(1);
}
console.log(
  '\nstrokeDashCapsRenderSmoke: the dash/cap shader repairs render as their controls on the GPU',
);
