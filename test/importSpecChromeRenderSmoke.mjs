// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importSpecChromeRenderSmoke -- spec readings of the importer, drawn and compared with Chrome.
//
// A viewBox of zero width or height disables rendering, and an objectBoundingBox gradient on a shape with no width or height is no paint server, so the url()'s fallback paints.
// Both follow the specs; these cases say whether the browser reads them the same. The reference is Chrome rasterizing the SVG at 8x, box-averaged. If Chrome differs the spec stays the
// default and the difference belongs behind compat:'chrome'. The bar is a pixel off by more than 48/255: the worst edge pixel of a case here is 42, the difference between this renderer's
// box-filtered antialiasing and the reference's, and a wrong paint is off by far more.
//
// Two more readings run on the Chrome 8x reference page (test/_chrome8Ref.mjs), each on its own page in this browser:
//
// EVEN-ODD COINCIDENT CONTOURS: under even-odd a contour drawn twice adds nothing, so its pair leaves no ink. The winding integral on the
// default cover route reads 2c on a pixel the two copies' edge crosses, and folded by even-odd that is a full pixel at c = 1/2 where the
// coverage is 0: a ring round the contour (249/255 at 128 px), in whatever direction and from whatever start the copies run. A third copy
// stays, and a shape beside the pair is untouched. Under nonzero a lone contour drawn twice the same way overstated its edge, fold(2c), for
// the same reason.
//
// CLIP-PATH ON A <mask>: the property applies to container elements and a mask is one; CSS Masking 1 names only opacity, filter and display
// as not applying. So by default the mask's content is clipped, which is the picture of the same clip placed on the content. Chrome ignores
// it: importSvg({ compat: 'chrome' }) does the same. The default's reference is Chrome drawing the clip on a <g> inside the mask; the compat
// arm's is Chrome drawing the source itself.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
import { openChrome8Ref, compare } from './_chrome8Ref.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 128;
const doc = (body, attrs = 'viewBox="0 0 100 100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${N}" height="${N}" ${attrs}>${body}</svg>`;
const R = '<rect width="60" height="60" fill="#c33"/>';
const MARK = '<rect x="70" y="70" width="20" height="20" fill="#06c"/>'; // beside what is under test: says the document drew at all
const GRAD =
  '<linearGradient id="g"><stop stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>';
const sub = (t) => `data:image/svg+xml,${encodeURIComponent(t)}`;
const STROKE = 'stroke-width="12" fill="none"';
const CASES = [
  ['root viewBox of zero width', doc(R, 'viewBox="0 0 0 100"')],
  ['root viewBox of zero height', doc(R, 'viewBox="0 0 100 0"')],
  ['root viewBox of zero size', doc(R, 'viewBox="0 0 0 0"')],
  ['nested <svg>', doc(`<svg width="50" height="50" viewBox="0 0 0 10">${R}</svg>${MARK}`)],
  [
    '<symbol> through <use>',
    doc(
      `<symbol id="s" viewBox="0 0 10 0">${R}</symbol><use href="#s" width="50" height="50"/>${MARK}`,
    ),
  ],
  [
    '<pattern>',
    doc(
      `<pattern id="p" viewBox="0 0 0 5" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#0a0"/></pattern><rect width="60" height="60" fill="url(#p)"/>${MARK}`,
    ),
  ],
  // Where Chrome departs from the spec's "no paint is applied": it paints the fallback, so these compare under compat: 'chrome'. (importSpecEdgesSmoke holds the default.)
  [
    '<pattern>, a fill with a fallback',
    doc(
      `<pattern id="p" viewBox="0 0 0 5" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#0a0"/></pattern><rect width="60" height="60" fill="url(#p) #fa0"/>${MARK}`,
    ),
    { compat: 'chrome' },
  ],
  [
    '<pattern>, a stroke with a fallback',
    doc(
      `<pattern id="p" viewBox="0 0 0 5" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#0a0"/></pattern><path d="M0 30H60" fill="none" stroke-width="12" stroke="url(#p) #fa0"/>${MARK}`,
    ),
    { compat: 'chrome' },
  ],
  [
    '<marker>',
    doc(
      `<marker id="m" markerWidth="4" markerHeight="4" markerUnits="userSpaceOnUse" viewBox="0 0 0 10"><rect width="20" height="20" fill="#0a0"/></marker><path d="M20 30H60" stroke="#c33" stroke-width="4" fill="none" marker-start="url(#m)"/>${MARK}`,
    ),
  ],
  [
    'a referenced SVG <image>',
    doc(
      `<image href="${sub(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 0 10">${R}</svg>`)}" width="50" height="50"/>${MARK}`,
    ),
  ],
  [
    'usable viewBoxes draw (control)',
    doc(`<svg width="50" height="50" viewBox="0 0 100 100">${R}</svg>${MARK}`),
  ],
  [
    'gradient on a level <line>, with a fallback',
    doc(
      `${GRAD}<line x1="10" y1="40" x2="90" y2="40" stroke="url(#g) #0a0" stroke-width="12"/>${MARK}`,
    ),
  ],
  [
    'gradient on a level <line>, no fallback',
    doc(`${GRAD}<line x1="10" y1="40" x2="90" y2="40" stroke="url(#g)" stroke-width="12"/>${MARK}`),
  ],
  [
    'gradient on an upright <line>, with a fallback',
    doc(
      `${GRAD}<line x1="40" y1="10" x2="40" y2="60" stroke="url(#g) #0a0" stroke-width="12"/>${MARK}`,
    ),
  ],
  [
    'gradient on a level <path>, with a fallback',
    doc(`${GRAD}<path d="M10 40H60" stroke="url(#g) #0a0" ${STROKE}/>${MARK}`),
  ],
  [
    'gradient on a level <path>, no fallback',
    doc(`${GRAD}<path d="M10 40H60" stroke="url(#g)" ${STROKE}/>${MARK}`),
  ],
  [
    'a user-space gradient on a level <line> keeps it',
    doc(
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="10" x2="90" y1="0" y2="0"><stop stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient><line x1="10" y1="40" x2="90" y2="40" stroke="url(#g) #0a0" stroke-width="12"/>${MARK}`,
    ),
  ],
  [
    'a gradient on a shape with a box keeps it (control)',
    doc(
      `${GRAD}<line x1="10" y1="20" x2="60" y2="50" stroke="url(#g) #0a0" stroke-width="12"/>${MARK}`,
    ),
  ],
  // A group's mask and a leaf's own both apply.
  [
    "a group's mask and a leaf's own",
    doc(
      '<mask id="m1" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect width="100" height="40" fill="#fff"/></mask><mask id="m2" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"><rect y="20" width="100" height="60" fill="#fff"/></mask><g mask="url(#m1)"><rect width="80" height="80" fill="#c33" mask="url(#m2)"/></g>',
    ),
  ],
];

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true, depth: true, stencil: true });
const R = createRenderer(gl, await loadShaders(new URL('/src/shaders/', location.href).href), {}); if (R.ready) await R.ready;
R.setViewport(${N}, ${N}); gl.viewport(0, 0, ${N}, ${N});
const BUDGET = ${pageTimeoutFor(120000, 30000)};
window.__case = async (svg, opts) => {
  const sec = await importSvg(svg, { preserveViewport: true, ...opts });
  let m = new Uint8Array(${N} * ${N} * 4).fill(255);
  if (sec.numShapes) {
    const b = createBundle(gl, sec);
    if (R.prepareBundle) R.prepareBundle(b);
    if (R.awaitLbReady) await R.awaitLbReady(b, BUDGET);
    for (let i = 0; i < 3; i++) { R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame(); }
    const px = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, px);
    for (let y = 0; y < ${N}; y++) m.set(px.subarray((${N} - 1 - y) * ${N} * 4, (${N} - y) * ${N} * 4), y * ${N} * 4);
    if (b.dispose) b.dispose();
  }
  const SS = 8, M2 = ${N} * SS;
  const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.replace('width="${N}" height="${N}"', 'width="' + M2 + '" height="' + M2 + '"'));
  let broken = false; await img.decode().catch(() => { broken = true; });
  const c2 = document.createElement('canvas'); c2.width = c2.height = M2;
  const ctx = c2.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, M2, M2); if (!broken) ctx.drawImage(img, 0, 0, M2, M2);
  const big = ctx.getImageData(0, 0, M2, M2).data, ref = new Uint8ClampedArray(${N} * ${N} * 4);
  for (let y = 0; y < ${N}; y++) for (let x = 0; x < ${N}; x++) for (let ch = 0; ch < 4; ch++) {
    let s = 0; for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) s += big[((y * SS + j) * M2 + x * SS + i) * 4 + ch];
    ref[(y * ${N} + x) * 4 + ch] = Math.round(s / (SS * SS));
  }
  return { rows: sec.numShapes, broken, mantle: Array.from(m), chrome: Array.from(ref) };
};
// Whether a visible <tspan> under a hidden <text> paints: Chrome alone, the importer's half is in importTextElementSmoke.
window.__tspan = async () => {
  const mk = (inner) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><text x="5" y="45" font-size="40" font-family="sans-serif" visibility="hidden">' + inner + '</text></svg>');
  const ink = async (u) => { const i = new Image(); i.src = u; await i.decode(); const c = document.createElement('canvas'); c.width = 200; c.height = 60; const x = c.getContext('2d'); x.drawImage(i, 0, 0); const d = x.getImageData(0, 0, 200, 60).data; let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 32) n++; return n; };
  return { visible: await ink(mk('A<tspan visibility="visible">B</tspan>')), hidden: await ink(mk('A<tspan>B</tspan>')) };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await openReady(page, `http://127.0.0.1:${server.address().port}/`, { ready: 'flag' });
let failures = 0;
for (const [name, svg, opts] of CASES) {
  const o = await page.evaluate((s, q) => window.__case(s, q), svg, opts || {});
  let off = 0,
    worst = 0,
    inkM = 0,
    inkC = 0;
  for (let i = 0; i < o.mantle.length; i += 4) {
    const d = Math.max(
      Math.abs(o.mantle[i] - o.chrome[i]),
      Math.abs(o.mantle[i + 1] - o.chrome[i + 1]),
      Math.abs(o.mantle[i + 2] - o.chrome[i + 2]),
    );
    if (d > worst) worst = d;
    if (d > 48) off++;
    if (o.mantle[i] + o.mantle[i + 1] + o.mantle[i + 2] < 700) inkM++;
    if (o.chrome[i] + o.chrome[i + 1] + o.chrome[i + 2] < 700) inkC++;
  }
  const good = off === 0 && !o.broken;
  console.log(
    `  ${good ? 'ok' : 'FAIL'} ${name}: ${off} px off by more than 48/255 (worst ${worst}), ink ${inkM} here, ${inkC} in Chrome, ${o.rows} rows${o.broken ? ', Chrome could not decode it' : ''}`,
  );
  if (!good) failures++;
}
const t = await page.evaluate(() => window.__tspan());
const tOk = t.visible > 0 && t.hidden === 0;
console.log(
  `  ${tOk ? 'ok' : 'FAIL'} Chrome paints a visible <tspan> under a hidden <text>: ${t.visible} px, and nothing without it: ${t.hidden} px`,
);
if (!tOk) failures++;
const specFailures = failures;
// The Chrome 8x reference page opened in this browser: closing the ref closes its page, not the browser.
const inThisBrowser = async () => {
  let p = null;
  return { newPage: async () => (p = await browser.newPage()), close: async () => p && p.close() };
};
// Even-odd coincident contours against Chrome 8x (N is the cell size above, 128).
async function evenOddCoincidentSection() {
  const svg = (body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 ${N} ${N}">${body}</svg>`;
  const eo = (d) => svg(`<path fill="#000" fill-rule="evenodd" d="${d}"/>`);
  const CUB = 'M20 64C20 108 108 108 108 64C108 20 20 20 20 64Z',
    CUB_REV = 'M20 64C20 20 108 20 108 64C108 108 20 108 20 64Z',
    CUB_ROT = 'M108 64C108 20 20 20 20 64C20 108 108 108 108 64Z';
  const QUAD = 'M20.5 64Q64 10 107.5 64Q64 118 20.5 64Z',
    TRI = 'M20.5 20.5L108 40L60 108Z',
    ARC = 'M24.5 64A40 30 20 0 1 104.5 64A40 30 20 0 1 24.5 64Z',
    SQUARE = 'M50 50H78V78H50Z';
  const CASES = [
    ['a cubic contour twice', eo(CUB + CUB)],
    ['the copy reversed', eo(CUB + CUB_REV)],
    ['the copy from another start', eo(CUB + CUB_ROT)],
    ['a quad contour twice', eo(QUAD + QUAD)],
    ['a line contour twice', eo(TRI + TRI)],
    ['an arc contour twice', eo(ARC + ARC)],
    ['a pair and a square inside it', eo(TRI + SQUARE + TRI)],
    ['three copies', eo(CUB + CUB + CUB)],
    ['nonzero: a cubic contour twice', svg(`<path fill="#000" d="${CUB + CUB}"/>`)],
    [
      'nonzero: from another start',
      svg(`<path fill="#000" d="${CUB + 'M108 64C108 20 20 20 20 64C20 108 108 108 108 64Z'}"/>`),
    ],
    [
      'nonzero: the copy reversed, which winds to nothing',
      svg(`<path fill="#000" d="${CUB + CUB_REV}"/>`),
    ],
  ];
  const ref = await openChrome8Ref(inThisBrowser);
  const before = failures;
  for (const [name, s] of CASES) {
    const { mantle, chrome, drew } = await ref.render(s, { w: N, h: N });
    let off = 0,
      worst = 0;
    for (let i = 0; i < N * N * 4; i += 4) {
      const d = Math.abs(mantle[i + 1] - chrome[i + 1]);
      if (d > worst) worst = d;
      if (d > 24) off++;
    }
    const ok = off === 0;
    console.log(
      `  ${ok ? 'ok' : 'FAIL'} ${name}: ${off} px off Chrome 8x by more than 24/255 (worst ${worst}, drew ${Object.keys(drew).join('+') || 'nothing'})`,
    );
    if (!ok) failures++;
  }
  await ref.close();
  console.log(
    failures === before
      ? `  even-odd coincident contours: ${CASES.length} cases match Chrome 8x`
      : `  even-odd coincident contours: ${failures - before} of ${CASES.length} failed`,
  );
}
// clip-path on a <mask>, the default and the compat arm, against Chrome 8x.
async function maskOwnClipPathSection() {
  const BAR = 48;
  const CLIP = '<clipPath id="c"><rect width="50" height="100"/></clipPath>';
  const doc = (extra, content, style = '') =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${N}" height="${N}" viewBox="0 0 100 100">${style}${CLIP}<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100"${extra}>${content}</mask><rect width="100" height="100" fill="#c33" mask="url(#m)"/></svg>`;
  const WHITE = '<rect width="100" height="60" fill="#fff"/>';
  const CASES = [
    [
      'the content has its own fill',
      doc(' clip-path="url(#c)"', WHITE),
      doc('', `<g clip-path="url(#c)">${WHITE}</g>`),
    ],
    [
      "the content styled through the mask's id",
      doc(
        ' clip-path="url(#c)"',
        '<rect width="100" height="60"/>',
        '<style>#m rect{fill:white}</style>',
      ),
      doc('', `<g clip-path="url(#c)">${WHITE}</g>`),
    ],
    [
      'the content inherits from the mask',
      doc(' fill="#808080" clip-path="url(#c)"', '<rect width="100" height="60"/>'),
      doc(' fill="#808080"', '<g clip-path="url(#c)"><rect width="100" height="60"/></g>'),
    ],
  ];
  const ref = await openChrome8Ref(inThisBrowser);
  const before = failures;
  let cells = 0;
  const check = (label, r) => {
    const c = compare(r.mantle, r.chrome, N, N, { tol: BAR });
    cells++;
    const good = c.over === 0;
    console.log(`  ${good ? 'ok' : 'FAIL'} ${label}: ${c.over} px off by more than ${BAR}/255`);
    if (!good) failures++;
  };
  try {
    for (const [name, svg, spec] of CASES) {
      check(
        `${name}, default: the content is clipped`,
        await ref.render(svg, { w: N, h: N, chromeSvg: spec }),
      );
      check(
        `${name}, compat chrome: Chrome draws the source`,
        await ref.render(svg, { w: N, h: N, importOpts: { compat: 'chrome' } }),
      );
    }
    // The premise of the compat arm: Chrome really ignores it. If this stops holding, the option has nothing to follow.
    const held = await ref.render(CASES[0][1], {
      w: N,
      h: N,
      chromeSvg: CASES[0][2],
      importOpts: { compat: 'chrome' },
    });
    const c = compare(held.chrome, (await ref.render(CASES[0][1], { w: N, h: N })).chrome, N, N, {
      tol: BAR,
    });
    const moved = c.over > 1000;
    console.log(
      `  ${moved ? 'ok' : 'FAIL'} (premise) Chrome's source and its clipped reference differ: ${c.over} px`,
    );
    if (!moved) failures++;
    if (ref.pageErrors.length) {
      console.error(ref.pageErrors.join('\n'));
      failures++;
    }
  } finally {
    await ref.close();
  }
  console.log(
    failures === before
      ? `  clip-path on a <mask>: PASS, ${cells} cells`
      : `  clip-path on a <mask>: ${failures - before} failed of ${cells}`,
  );
}
await evenOddCoincidentSection();
await maskOwnClipPathSection();
await browser.close();
server.close();
if (failures) {
  console.error(
    `importSpecChromeRenderSmoke: ${specFailures} of ${CASES.length + 1} differ from Chrome, ${failures} failures in all`,
  );
  process.exit(1);
}
console.log(`importSpecChromeRenderSmoke: ${CASES.length + 1} cases agree with Chrome`);
