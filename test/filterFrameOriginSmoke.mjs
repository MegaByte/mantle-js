// filterFrameOriginSmoke.mjs — a filtered draw must not displace the NEXT draw.
//
// A filtered shape renders into an RT covering only itself, which means its fill pass
// runs with a TRANSLATED viewport and the shader is told where its framebuffer sits
// (uFragOrigin). That origin belongs to exactly one pass. If it outlives the pass,
// everything drawn afterwards is rendered through the leftover shift — displaced by the
// filter's rect, in a LATER frame, far from the code that set it.
//
// It happened. The reset was written into the wrong branch (the COLR one, which is the
// first textual match of the same three lines), so the filter-graph route set the origin
// and never cleared it. Every suite stayed green: no fixture drew anything after a
// filtered shape. endFillPass now owns the origin's lifetime, so a caller cannot forget.
//
// Draw a plain bundle twice — once after a FILTERED draw, once after a PLAIN one. The
// two frames must be identical. Nothing about the plain bundle depends on what was
// drawn before it.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  const m = p.endsWith('.html') ? 'text/html'
    : (p.endsWith('.js') || p.endsWith('.mjs')) ? 'text/javascript'
    : p.endsWith('.glsl') ? 'text/plain' : 'application/octet-stream';
  let body;
  try { body = readFileSync(path.join(ROOT, p)); } catch { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': m + '; charset=utf-8' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/mantleDemo.html`;

// The filtered draw — a drop shadow, so it takes the filter-GRAPH route.
const FILTERED = readFileSync(new URL('../examples/smoke/filterFrameOrigin__FILTERED.svg', import.meta.url), 'utf8');
// A lone blur — the SINGLE-KIND route, which shifts its viewport too.
const BLURRED = readFileSync(new URL('../examples/smoke/filterFrameOrigin__BLURRED.svg', import.meta.url), 'utf8');
// The victim: no filter at all. Where it lands must not depend on the frame before.
const PLAIN = readFileSync(new URL('../examples/smoke/filterFrameOrigin__PLAIN.svg', import.meta.url), 'utf8');

let failures = 0;
const fail = (m) => { failures++; console.error('FAIL', m); };
const ok = (m) => console.log('ok', m);

const browser = await puppeteer.launch({
  headless: 'new', args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 500, height: 500 });
page.on('pageerror', e => console.error('  [page-err]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 20000 });
await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, { timeout: 20000 });

const res = await page.evaluate(async (svgs) => {
  const { importSvg, createBundle } = await import('/src/index.js');
  const gl = window.__mantleGl;
  const renderer = window.__mantleRenderer;
  const cnv = document.getElementById('glcanvas');
  // A small shape on a big canvas — the case the rect RTs exist for, and the one where
  // a leaked origin displaces by the most.
  const W = 820, H = 1000;
  cnv.width = W; cnv.height = H;
  const WM = [0.55, 0, 0, 0, 0.55, 0, 0.12, 0.18, 1];

  const drawOnce = async (svg) => {
    const b = createBundle(gl, await importSvg(svg));
    const h = renderer.createBundleHandle(b);
    renderer.beginFrame([1, 1, 1, 1]);
    h.draw({ worldMatrix: WM });
    renderer.endFrame();
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    h.dispose(); b.dispose();
    return px;
  };
  // `after` is drawn in its own frame FIRST; then PLAIN, in a frame of its own.
  const plainAfter = async (after) => {
    await drawOnce(after);
    return drawOnce(svgs.PLAIN);
  };

  const baseline = await plainAfter(svgs.PLAIN);      // plain after plain
  const afterGraph = await plainAfter(svgs.FILTERED); // plain after a filter GRAPH
  const afterBlur = await plainAfter(svgs.BLURRED);   // plain after a SINGLE-KIND filter

  const cmp = (a, b) => {
    let d = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) > 8 || Math.abs(a[i + 1] - b[i + 1]) > 8 ||
          Math.abs(a[i + 2] - b[i + 2]) > 8) d++;
    }
    return d;
  };
  let ink = 0;
  for (let i = 0; i < baseline.length; i += 4) {
    if (baseline[i] < 250 || baseline[i + 1] < 250 || baseline[i + 2] < 250) ink++;
  }
  return { ink, graph: cmp(baseline, afterGraph), blur: cmp(baseline, afterBlur), total: W * H };
}, { FILTERED, BLURRED, PLAIN });

console.log(`  plain bundle ink ${res.ink}px   `
          + `diff after graph-filter ${res.graph}px, after single-kind filter ${res.blur}px`);

if (res.ink < 5000) {
  fail(`the plain bundle barely rendered (${res.ink}px) — a displaced shape would look `
     + `the same as this, so the comparisons below prove nothing`);
} else {
  ok(`the plain bundle renders (${res.ink}px of ink)`);
}
for (const [name, d] of [['filter graph', res.graph], ['single-kind filter', res.blur]]) {
  if (d > 0) {
    fail(`a plain draw after a ${name} differs from the same draw after a plain one — `
       + `${d}px. The filtered pass's frame origin outlived it, so this draw rendered `
       + `through a leftover viewport shift. endFillPass must clear R._fragOrigin.`);
  } else {
    ok(`a plain draw after a ${name} is unaffected by it (0px differ)`);
  }
}

await browser.close();
server.close();
console.log(failures ? `\nFAILURES: ${failures}` : '\nFILTER-FRAME-ORIGIN PASS');
process.exit(failures ? 1 : 0);
