// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _recogCensus — how much REAL artwork reaches the SDF primitive?
//
// Element counts cannot answer this. A design tool emits a circle as <path>, and a real corpus is
// mostly paths — so counting <circle> tags undercounts the recognizer badly. This asks the question
// the renderer asks: decode each shape's contours and see whether the recognizer claims it.
//
// Runs in a page because importSvg needs a DOM.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = process.argv.slice(2);
const svgs = [];
for (const f of files) {
  try {
    svgs.push(readFileSync(f, 'utf8'));
  } catch {
    /* skip */
  }
}

const PAGE = `<!doctype html><body><canvas id=c width=8 height=8></canvas><script type="module">
// The decoded geometry lives on the BUNDLE, not the imported doc — createBundle is what produces
// curveFloats and the per-shape ranges, so a context is needed even though nothing is drawn.
import { importSvg, createBundle } from '/src/index.js';
import { curveRangeToContours } from '/src/geom/lbContour.js';
import { circleFromContours, ellipseFromContours } from '/src/geom/shapeRecognize.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false });
window.__run = async (list) => {
  let shapes = 0, circ = 0, ell = 0, ok = 0, threw = 0;
  for (const txt of list) {
    let doc = null, b = null;
    try { doc = await importSvg(txt); b = createBundle(gl, doc); } catch { threw++; continue; }
    const cf = (b && (b.curveFloats64 || b.curveFloats));
    const ranges = b && b.curveRangesByShape;
    if (!cf || !ranges || !ranges.length) continue;
    ok++;
    for (const r of ranges) {
      if (!r) continue;
      shapes++;
      let cs = null;
      try { cs = curveRangeToContours(cf, r.begin, r.end); } catch { cs = null; }
      if (!cs || !cs.length) continue;
      if (circleFromContours(cs)) circ++; else if (ellipseFromContours(cs)) ell++;
    }
    try { b.dispose && b.dispose(); } catch { /* keep going */ }
  }
  return { ok, threw, shapes, circ, ell };
};
window.__ready = true;
</script></body>`;
const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((q, res) => {
  try {
    const p = q.url.split('?')[0];
    if (p === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
      return;
    }
    res.writeHead(200, { 'content-type': mime(p) + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, decodeURIComponent(p))));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser({
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600000,
});
const pg = await br.newPage();
pg.on('pageerror', (e) => console.log('[page-err]', e.message));
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 60000 });
await pg.waitForFunction(() => window.__ready === true, { timeout: 60000, polling: 100 });
const CH = 200;
const tot = { ok: 0, threw: 0, shapes: 0, circ: 0, ell: 0 };
for (let i = 0; i < svgs.length; i += CH) {
  const r = await pg.evaluate((l) => window.__run(l), svgs.slice(i, i + CH));
  for (const k of Object.keys(tot)) tot[k] += r[k] | 0;
}
await br.close();
server.close();
const rec = tot.circ + tot.ell;
console.log(`  files ${tot.ok} of ${svgs.length} (${tot.threw} threw)   shapes ${tot.shapes}`);
console.log(
  `  RECOGNIZED ${rec}  (${tot.shapes ? ((100 * rec) / tot.shapes).toFixed(2) : 0}% of shapes)   circle ${tot.circ}   ellipse ${tot.ell}`,
);
