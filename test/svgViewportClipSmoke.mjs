// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Nested SVG/symbol viewports clip independently of author path styles.
// Explicit clip intersections and overflow:visible retain their geometry.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const S = 400; // canvas px
const VB = 100; // viewBox units
// Corner dots pin globalBBox to the full viewBox, so em -> px stays the viewBox mapping whatever the scene clips away.
const DOTS =
  '<rect x="0" y="0" width="0.5" height="0.5" fill="#000"/>' +
  '<rect x="99.5" y="99.5" width="0.5" height="0.5" fill="#000"/>';
// A 60x60 black rect at (20,20). Every scene puts it inside a viewport or a clip that keeps only part of it.
const BIG = '<rect x="20" y="20" width="60" height="60" fill="#000"/>';

const SCENES = {
  // No viewBox, so the viewport fit is a translate by x/y: the 20..80 rect lands at root 40..100, and the viewport
  // keeps root 20..60. Only 40..60 survives, in both axes.
  'nested svg clips its content': {
    svg: `<style>path { display:none!important }</style><svg x="20" y="20" width="40" height="40">${BIG}</svg>`,
    keep: { x: 40, y: 40, w: 20, h: 20 },
    twin: 'nested svg with overflow:visible does not clip',
  },
  // Same viewport, overflow:visible — the control. The rect must reach past the viewport, or nothing here is measuring.
  'nested svg with overflow:visible does not clip': {
    svg: `<svg x="20" y="20" width="40" height="40" overflow="visible">${BIG}</svg>`,
    keep: { x: 40, y: 40, w: 60, h: 60 },
    control: true,
  },
  // The viewport moves with an ancestor transform: the clip must move with it, not stay in root coordinates.
  'nested svg clip follows an ancestor transform': {
    svg: `<g transform="translate(10 0)"><svg x="20" y="20" width="40" height="40">${BIG}</svg></g>`,
    keep: { x: 50, y: 40, w: 20, h: 20 },
    twin: 'nested svg with overflow:visible does not clip',
  },
  // <use> instantiates the symbol as a 40x40 viewport at (20,20); the symbol's own content reaches further.
  'use of a symbol clips to the use viewport': {
    svg: `<style>path { visibility:hidden!important;fill:none!important;opacity:0!important }</style><defs><symbol id="s">${BIG}</symbol></defs><use href="#s" x="20" y="20" width="40" height="40"/>`,
    keep: { x: 40, y: 40, w: 20, h: 20 },
    twin: 'nested svg with overflow:visible does not clip',
  },
  // The clip def keeps x 20..60; its own clip-path keeps y 20..60. Only the intersection may be drawn.
  'clipPath with its own clip-path intersects': {
    svg:
      '<defs>' +
      '<clipPath id="outer"><rect x="0" y="20" width="100" height="40"/></clipPath>' +
      '<clipPath id="inner" clip-path="url(#outer)"><rect x="20" y="0" width="40" height="100"/></clipPath>' +
      `</defs><g clip-path="url(#inner)">${BIG}</g>`,
    keep: { x: 20, y: 20, w: 40, h: 40 },
    twin: 'clipPath whose own clip covers everything keeps the inner clip',
  },
  // The same def whose own clip covers everything: the control for the case above.
  'clipPath whose own clip covers everything keeps the inner clip': {
    svg:
      '<defs>' +
      '<clipPath id="outer2"><rect x="0" y="0" width="100" height="100"/></clipPath>' +
      '<clipPath id="inner2" clip-path="url(#outer2)"><rect x="20" y="0" width="40" height="100"/></clipPath>' +
      `</defs><g clip-path="url(#inner2)">${BIG}</g>`,
    keep: { x: 20, y: 20, w: 40, h: 60 },
    control: true,
  },
};

const mime = (p) =>
  /\.(js|mjs)$/.test(p)
    ? 'text/javascript'
    : p.endsWith('.glsl')
      ? 'text/plain'
      : 'application/octet-stream';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<canvas id=c width=${S} height=${S}></canvas>`);
    return;
  }
  const p = decodeURIComponent(u.pathname);
  try {
    const b = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': mime(p) + '; charset=utf-8' });
    res.end(b);
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

let failures = 0;
const ok = (m) => console.log('  ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL ' + m);
};

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});

const out = await page.evaluate(
  async (scenes, S, VB, DOTS) => {
    const { importSvg, createBundle, createRenderer, loadShaders } = await import('/src/index.js');
    const gl = document.getElementById('c').getContext('webgl2', {
      antialias: false,
      preserveDrawingBuffer: true,
      stencil: true,
      depth: true,
    });
    const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
    const R = createRenderer(gl, shaders, {});
    const res = {};
    for (const [name, sc] of Object.entries(scenes)) {
      const sec = await importSvg(
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${VB} ${VB}">${DOTS}${sc.svg}</svg>`,
      );
      const b = createBundle(gl, sec);
      R.setViewport(S, S);
      R.beginFrame([1, 1, 1, 1]);
      R.drawBundle(b);
      R.endFrame();
      const px = new Uint8Array(S * S * 4);
      gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
      // globalBBox is what the renderer fits to the viewport; the corner dots make it the whole viewBox.
      const gb = sec.globalBBox;
      const sx = S / gb[2],
        sy = S / gb[3];
      const kx0 = (sc.keep.x - gb[0]) * sx,
        ky0 = (sc.keep.y - gb[1]) * sy;
      const kx1 = kx0 + sc.keep.w * sx,
        ky1 = ky0 + sc.keep.h * sy;
      let inside = 0,
        outside = 0;
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const i = (y * S + x) * 4;
          if (px[i] > 245 && px[i + 1] > 245 && px[i + 2] > 245) continue; // background
          if (x < 6 || x > S - 6 || y < 6 || y > S - 6) continue; // the pinning dots
          const yTop = S - 1 - y; // canvas y is GL-bottom-up
          // One pixel of slack on each edge: the clip boundary is antialiased and lands between samples.
          if (x >= kx0 - 1 && x <= kx1 + 1 && yTop >= ky0 - 1 && yTop <= ky1 + 1) inside++;
          else outside++;
        }
      res[name] = { inside, outside };
      b.dispose();
    }
    return res;
  },
  SCENES,
  S,
  VB,
  DOTS,
);

await browser.close();
server.close();

for (const [name, v] of Object.entries(out)) {
  console.log(
    `   ${name.padEnd(52)} inside ${String(v.inside).padStart(6)}   outside ${String(v.outside).padStart(6)}`,
  );
}
for (const [name, sc] of Object.entries(SCENES)) {
  const v = out[name];
  if (!v) {
    fail(`${name}: did not render`);
    continue;
  }
  if (v.inside === 0) {
    fail(`${name}: nothing drawn inside the allowed rect, over-clipped`);
    continue;
  }
  if (sc.control) {
    // A control states the rect the UNCLIPPED drawing fills, so it must fill it and nothing may sit outside either.
    if (v.outside === 0) ok(`${name}: draws the whole shape (${v.inside} px, 0 outside)`);
    else
      fail(
        `${name}: ${v.outside} px outside the shape's own rect, so this control is measuring something else`,
      );
  } else if (v.outside !== 0) {
    fail(
      `${name}: ${v.outside} px outside the allowed rect, so the clip is missing or on the wrong rect`,
    );
  } else if (sc.twin && !(out[sc.twin] && out[sc.twin].inside > v.inside)) {
    // A rect that is merely generous would also report 0 outside. The unclipped twin has to draw strictly more.
    fail(
      `${name}: the unclipped case draws ${out[sc.twin] ? out[sc.twin].inside : 'no'} px against this case's ${v.inside}, so nothing was actually clipped away`,
    );
  } else {
    ok(
      `${name}: clipped to the viewport (0 px outside, ${v.inside} px inside` +
        (sc.twin ? `, unclipped twin ${out[sc.twin].inside}` : '') +
        ')',
    );
  }
}
console.log();
console.log(failures === 0 ? 'SVG-VIEWPORT-CLIP PASS' : `SVG-VIEWPORT-CLIP FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
