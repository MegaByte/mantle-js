// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// arcsJoinRenderSmoke.mjs — SVG2 stroke-linejoin:arcs render golden. Renders the
// same corner stroked with arcs / round / miter and asserts the validated
// relationships: a curved-segment corner makes arcs DISTINCT from both round and
// miter, while a straight (polyline) corner makes arcs IDENTICAL to miter (arcs
// reduces to miter at zero edge curvature).

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CURVED = 'M 20 140 Q 20 20 100 80 Q 180 20 180 140';
const POLY = 'M 20 140 L 100 60 L 180 140';
const svg = (d, join) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 160" width="200" height="160">` +
  `<rect width="200" height="160" fill="white"/>` +
  `<path d="${d}" fill="none" stroke="#1a6" stroke-width="26" stroke-linejoin="${join}" stroke-miterlimit="10"/></svg>`;
const svgs = {
  '/_c_arcs.svg': svg(CURVED, 'arcs'),
  '/_c_round.svg': svg(CURVED, 'round'),
  '/_c_miter.svg': svg(CURVED, 'miter'),
  '/_p_arcs.svg': svg(POLY, 'arcs'),
  '/_p_miter.svg': svg(POLY, 'miter'),
};

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  return 'application/octet-stream';
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  if (svgs[p]) {
    res.writeHead(200, { 'content-type': mime(p) });
    res.end(svgs[p]);
    return;
  }
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

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
let failures = 0;
const fail = (m) => {
  console.error('FAIL:', m);
  failures++;
};

async function pixels(url) {
  const page = await browser.newPage();
  await page.setViewport({ width: 200, height: 160 });
  page.on('pageerror', (e) => fail(`[${url}] ${e.message}`));
  await openReady(
    page,
    `http://127.0.0.1:${port}/mantleDemo.html?svg=/${encodeURIComponent(url)}`,
    { ready: 'demoSvg' },
  ).catch(() => {});
  const px = await page.evaluate(() => {
    const cnv = document.getElementById('glcanvas'),
      gl = window.__mantleGl,
      r = window.__mantleRenderer;
    if (!cnv || !gl || !r) return null;
    r.render();
    const p = new Uint8Array(cnv.width * cnv.height * 4);
    gl.readPixels(0, 0, cnv.width, cnv.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
    return Array.from(p);
  });
  await page.close();
  return px;
}
const diff = (a, b) => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4)
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24)
      n++;
  return n;
};

const cArcs = await pixels('_c_arcs.svg'),
  cRound = await pixels('_c_round.svg'),
  cMiter = await pixels('_c_miter.svg');
const pArcs = await pixels('_p_arcs.svg'),
  pMiter = await pixels('_p_miter.svg');

if (![cArcs, cRound, cMiter, pArcs, pMiter].every(Array.isArray))
  fail('a render produced no pixels');
else {
  const arcsVsRound = diff(cArcs, cRound),
    arcsVsMiter = diff(cArcs, cMiter),
    polyArcsVsMiter = diff(pArcs, pMiter);
  console.log(
    `curved: arcs-vs-round=${arcsVsRound}  arcs-vs-miter=${arcsVsMiter}   poly: arcs-vs-miter=${polyArcsVsMiter}`,
  );
  if (arcsVsRound < 30) fail(`curved arcs should differ from round (got ${arcsVsRound})`);
  if (arcsVsMiter < 1) fail(`curved arcs should differ from miter (got ${arcsVsMiter})`);
  if (arcsVsMiter >= arcsVsRound)
    fail(
      `curved arcs should be closer to miter than round (miter ${arcsVsMiter} vs round ${arcsVsRound})`,
    );
  if (polyArcsVsMiter !== 0)
    fail(`polyline arcs must equal miter exactly (got ${polyArcsVsMiter})`);
}

await browser.close();
server.close();
if (failures === 0) {
  console.log('ARCS-JOIN-RENDER PASS');
  process.exit(0);
}
console.log(`ARCS-JOIN-RENDER FAIL (${failures})`);
process.exit(1);
