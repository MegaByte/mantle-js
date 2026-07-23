// Verifies importSvg({ computeSilhouette: true }): the opt-in silhouette
// computation injects one synthetic stroke-only "__silhouette__" shape
// (numShapes N -> N+1) and, for disjoint inputs, emits all cycles as ONE
// shape. No GL — checks importer output; runs in a browser context for the
// DOMParser dependency.

import { readFileSync, mkdirSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const SVG_TWO_SQUARES = readFileSync(new URL('../examples/smoke/pathBooleanSlice8__SVG_TWO_SQUARES.svg', import.meta.url), 'utf8');

const SVG_THREE_DISJOINT = readFileSync(new URL('../examples/smoke/pathBooleanSlice8__SVG_THREE_DISJOINT.svg', import.meta.url), 'utf8');

const HTML = `<!DOCTYPE html><html><body>
<script type="module">
import { importSvg } from '/src/index.js';

const SVG_TWO_SQUARES = ${JSON.stringify(SVG_TWO_SQUARES)};
const SVG_THREE_DISJOINT = ${JSON.stringify(SVG_THREE_DISJOINT)};

const results = {};

// Test 1: import WITHOUT computeSilhouette — bundle.numShapes unchanged.
{
  const b = await importSvg(SVG_TWO_SQUARES);
  results.noFlag = {
    numShapes: b.numShapes,
    shapeIds: b.shapeIds,
  };
}

// Test 2: import WITH computeSilhouette — extra synthetic shape "__silhouette__"
// prepended. numShapes should be N+1; bundle.shapeIds[0] should be the
// silhouette marker.
{
  const b = await importSvg(SVG_TWO_SQUARES, { computeSilhouette: true });
  results.flagOn = {
    numShapes: b.numShapes,
    shapeIds: b.shapeIds,
  };
}

// Test 3: three disjoint shapes → silhouette becomes one synthetic shape
// containing 3 separate cycles (12 segments total but emitted as ONE stroke
// shape).
{
  const b = await importSvg(SVG_THREE_DISJOINT, { computeSilhouette: true });
  results.disjoint = {
    numShapes: b.numShapes,
    shapeIds: b.shapeIds,
  };
}

window.__r = results;
window.__d = true;
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/' || u.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }
  let p = decodeURIComponent(u.pathname);
  const mime = p.endsWith('.js') || p.endsWith('.mjs') ? 'text/javascript'
             : p.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream';
  try {
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    try { res.writeHead(404); res.end(); } catch {}
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({ headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'] });
const page = await browser.newPage();
page.on('pageerror', e => console.error('  [page-err]', e.message));
page.on('console', m => console.error(`  [console-${m.type()}]`, m.text()));
page.on('error', e => console.error('  [page-error]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 10000 });
try {
  await page.waitForFunction(() => window.__d === true, { timeout: 30000 });
} catch (e) {
  console.error('  [wait-timeout]', e.message);
}
const r = await page.evaluate(() => window.__r);
await browser.close();
server.close();

let failures = 0;
const ok = m => console.log('ok', m);
const fail = m => { failures++; console.error('FAIL', m); };

// No flag: 2 filled shapes → 2 shape meta rows (no silhouette injected).
if (r.noFlag.numShapes === 2 && !r.noFlag.shapeIds.includes('__silhouette__'))
  ok('no-flag: numShapes=2, no synthetic silhouette shape injected');
else fail(`no-flag: numShapes=${r.noFlag.numShapes}, shapeIds=${JSON.stringify(r.noFlag.shapeIds)}`);

// Flag on: 2 filled shapes + 1 synthetic silhouette = 3 shapes
// (the silhouette is stroke-only so it gets its own meta row).
// Shape ID 0 should be the silhouette marker.
if (r.flagOn.numShapes === 3 && r.flagOn.shapeIds.some(id => id.includes('__silhouette__')))
  ok(`flag-on: numShapes=${r.flagOn.numShapes}, silhouette shape injected (shapeIds=${JSON.stringify(r.flagOn.shapeIds)})`);
else fail(`flag-on: numShapes=${r.flagOn.numShapes}, shapeIds=${JSON.stringify(r.flagOn.shapeIds)}`);

// Three disjoint squares + 1 silhouette = 4 shapes.
if (r.disjoint.numShapes === 4 && r.disjoint.shapeIds.some(id => id.includes('__silhouette__')))
  ok('disjoint: 3 squares + 1 silhouette = 4 shapes');
else fail(`disjoint: numShapes=${r.disjoint.numShapes}, shapeIds=${JSON.stringify(r.disjoint.shapeIds)}`);

if (failures > 0) {
  console.error(`\nPATH-BOOLEAN SLICE-8 FAIL (${failures})`);
  process.exit(1);
}
console.log('\nPATH-BOOLEAN SLICE-8 PASS');
