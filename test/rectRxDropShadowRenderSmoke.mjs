// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Guards that rounded-rect and feDropShadow both render, WITH and WITHOUT a
// worldMatrix.
//   A: <rect rx>            — mixed line + native-arc contour
//   B: <path> rounded rect  — control (always rendered)
//   D: <circle> + feDropShadow — card + a visible soft shadow
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const mime = (p) =>
  p.endsWith('.html')
    ? 'text/html'
    : p.endsWith('.js') || p.endsWith('.mjs')
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
const server = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://l');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  let buf = null;
  try {
    buf = readFileSync(path.join(ROOT, p));
  } catch {}
  if (buf) {
    r.writeHead(200, { 'content-type': mime(p) });
    r.end(buf);
  } else {
    r.writeHead(404);
    r.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const A = readFileSync(
  new URL('../examples/smoke/rectRxDropShadowRender__A.svg', import.meta.url),
  'utf8',
);
const B = readFileSync(
  new URL('../examples/smoke/rectRxDropShadowRender__B.svg', import.meta.url),
  'utf8',
);
const D = readFileSync(
  new URL('../examples/smoke/rectRxDropShadowRender__D.svg', import.meta.url),
  'utf8',
);
const br = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const pg = await br.newPage();
await pg.setViewport({ width: 300, height: 300 });
pg.on('pageerror', (e) => console.error('[page]', e.message));
await pg.goto(url, { waitUntil: 'load', timeout: 20000 });
await pg.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
  timeout: 20000,
  polling: 100,
});
const out = await pg.evaluate(
  async (A, B, D) => {
    const { importSvg, createBundle } = await import('/src/index.js');
    const gl = window.__mantleGl,
      r = window.__mantleRenderer,
      cnv = document.getElementById('glcanvas');
    cnv.width = 300;
    cnv.height = 300;
    r.setViewport(300, 300);
    const px = new Uint8Array(300 * 300 * 4);
    async function render(svg, wm) {
      let white = 0,
        dark = 0,
        err = null;
      try {
        const b = createBundle(gl, await importSvg(svg));
        r.beginFrame([0.3, 0.3, 0.3, 1]);
        r.drawBundle(b, wm ? { worldMatrix: wm } : undefined);
        r.endFrame();
        gl.readPixels(0, 0, 300, 300, gl.RGBA, gl.UNSIGNED_BYTE, px);
        for (let i = 0; i < px.length; i += 4) {
          const lum = px[i] * 0.3 + px[i + 1] * 0.6 + px[i + 2] * 0.1;
          if (lum > 200) white++;
          else if (lum < 60 && px[i] + px[i + 1] + px[i + 2] > 4) dark++;
        }
        b.dispose();
      } catch (e) {
        err = e.message;
      }
      return { white, dark, err };
    }
    const wm = new Float32Array([0.9, 0, 0, 0, 0.9, 0, 0, 0, 1]);
    return {
      A: await render(A),
      Awm: await render(A, wm),
      B: await render(B),
      D: await render(D),
      Dwm: await render(D, wm),
    };
  },
  A,
  B,
  D,
);
await br.close();
server.close();

let fail = 0;
const need = (cond, msg) => {
  if (!cond) {
    console.error('  FAIL:', msg);
    fail++;
  }
};
need(
  !out.A.err && out.A.white > 5000,
  `rect rx renders (white=${out.A.white}${out.A.err ? ' err=' + out.A.err : ''})`,
);
need(
  !out.Awm.err && out.Awm.white > 5000,
  `rect rx renders under worldMatrix (white=${out.Awm.white})`,
);
need(out.B.white > 5000, `path rounded-rect renders (white=${out.B.white})`);
need(
  !out.D.err && out.D.white > 5000,
  `feDropShadow card renders (white=${out.D.white}${out.D.err ? ' err=' + out.D.err : ''})`,
);
need(out.D.dark > 500, `feDropShadow soft shadow renders (shadow px=${out.D.dark})`);
need(
  out.Dwm.white > 5000 && out.Dwm.dark > 500,
  `feDropShadow renders under worldMatrix (white=${out.Dwm.white} shadow=${out.Dwm.dark})`,
);
if (!fail)
  console.log(
    `rect-rx renders (${out.A.white}px), feDropShadow renders card+shadow (${out.D.white}px + ${out.D.dark} shadow px)`,
  );
console.log(fail ? 'rectRxDropShadowRenderSmoke: FAIL' : 'rectRxDropShadowRenderSmoke: PASS');
process.exit(fail ? 1 : 0);
