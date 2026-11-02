// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Filtered shape INSIDE an opacity group — the group-compositing path.
//
// examples/_filtergroup.svg: a solid blue rect outside the group, then
// <g opacity="0.5"> containing a blurred red rect (single-kind filterId
// route) and a plain green rect. The filter branch must:
//   * not clobber mainCopyTex (groupEnd's canvas snapshot),
//   * not clear shapeFbo (the group's accumulator),
//   * composite its output INTO the group, not escape to the canvas —
// so the filtered red renders at the group's 50% opacity like its green
// sibling, and the blue backdrop outside the group survives untouched.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

let failures = 0;
const fail = (msg) => {
  failures++;
  console.error('FAIL:', msg);
};
const ok = (msg) => console.log('  ok ' + msg);

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

const target = `http://127.0.0.1:${port}/mantleDemo.html?svg=/${encodeURIComponent('examples/_filtergroup.svg')}`;
try {
  await openReady(page, target, { ready: 'demoSvg' });

  const s = await page.evaluate(() => {
    const cnv = document.getElementById('glcanvas');
    const gl = window.__mantleGl,
      renderer = window.__mantleRenderer;
    if (!cnv || !gl || !renderer) return null;
    renderer.render();
    const w = cnv.width,
      h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let solidBlue = 0,
      halfRed = 0,
      halfGreen = 0,
      fullRed = 0,
      fullGreen = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i],
        g = px[i + 1],
        b = px[i + 2];
      if (b > 200 && r < 80 && g < 80) solidBlue++;
      // 50% red over white ≈ (255, 127, 127); blur softens edges, so
      // accept a generous band around the plateau.
      if (r > 200 && g > 90 && g < 200 && b > 90 && b < 200) halfRed++;
      // 50% #00c000 over white ≈ (127, 223, 127).
      if (g > 180 && r > 90 && r < 200 && b > 90 && b < 200) halfGreen++;
      if (r > 200 && g < 60 && b < 60) fullRed++;
      if (g > 200 && r < 60 && b < 60) fullGreen++;
    }
    return { w, h, solidBlue, halfRed, halfGreen, fullRed, fullGreen };
  });
  if (!s) throw new Error('no canvas / WebGL2 context');
  console.log(
    `  diag: blue=${s.solidBlue} halfRed=${s.halfRed} halfGreen=${s.halfGreen} fullRed=${s.fullRed} fullGreen=${s.fullGreen}`,
  );

  if (s.solidBlue > 500) ok(`blue rect outside the group survives (${s.solidBlue} px)`);
  else fail(`blue backdrop lost (${s.solidBlue} px) — the in-group filter clobbered the canvas`);

  if (s.halfRed > 500) ok(`filtered red renders at group opacity (${s.halfRed} px)`);
  else fail(`no half-opacity red (${s.halfRed} px) — filtered shape missing or at wrong alpha`);

  if (s.halfGreen > 500) ok(`plain sibling renders at group opacity (${s.halfGreen} px)`);
  else
    fail(
      `no half-opacity green (${s.halfGreen} px) — group content clobbered by the filter branch`,
    );

  if (s.fullRed < 50)
    ok(`no full-opacity red (${s.fullRed} px) — the filter did not escape the group`);
  else
    fail(
      `${s.fullRed} full-opacity red px — the filtered shape composited to the canvas, escaping the group`,
    );

  if (s.fullGreen < 50) ok(`no full-opacity green (${s.fullGreen} px)`);
  else fail(`${s.fullGreen} full-opacity green px — group opacity not applied`);
} catch (e) {
  fail(`render drive failed: ${e.message}`);
}

await browser.close();
server.close();
console.log();
console.log(failures === 0 ? 'FILTER-GROUP PASS' : `FILTER-GROUP FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
