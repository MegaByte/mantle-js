// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// lbKindOmitSmoke.mjs — LB coverage is componentized BY KIND, and it is free.
//
// lbCoverage() is one big per-kind dispatch and a typical mesh reaches a handful
// of kinds, so the renderer compiles the unused blocks out (MANTLE_LB_NO_DISC /
// _EDGE_STRIP / _CHAIN_STRIP) — the same omit-define mechanism as MANTLE_NO_GRADIENT, one level
// down. Kind 10 alone is the largest single block in the file.
//
// Two things have to hold, and the second is the one that makes the first
// meaningful:
//   1. the omits actually FIRE (the variant key names them) — otherwise the test
//      passes vacuously on a full program
//   2. the output MATCHES the same render with the omits disabled
//      (`lbKindOmit: false`)
//
// On (2): two of the three shapes come out byte-identical, and the circle differs
// by 1/255 on ONE of 20324 ink pixels. That is compiler codegen variance, not a
// logic difference, and the argument is structural rather than a hand-wave: the
// circle keeps DISC and the DISC block is TEXTUALLY IDENTICAL in both
// programs, so nothing on the executed path changed. Removing dead code around it
// shifts register allocation and can move the last bit. The bound below is
// therefore 1/255 on a handful of pixels, not zero — asserting zero would be
// asserting something about the driver's optimizer.
//
// A shape with only curves reaches no EDGE_STRIP; a rounded rect (curves AND
// straight edges) reaches kind 10 but no disc; a circle lifts to the kind-7 SDF.
// So the three shapes here should each omit a DIFFERENT set, which is what proves
// the mask is per-bundle rather than a constant.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const CASES = {
  // All-curve blob: no straight boundary edge, so no EDGE_STRIP.
  curvesOnly:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
    '<path fill="#3060c0" d="M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36' +
    ' C9 36 4 31 4 20 C4 9 9 4 20 4 Z"/></svg>',
  // Curves AND straight edges: EDGE_STRIP is reachable.
  roundRect:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
    '<path fill="#3060c0" d="M10 6 L30 6 Q36 6 36 12 L36 28 Q36 34 30 34' +
    ' L10 34 Q4 34 4 28 L4 12 Q4 6 10 6 Z"/></svg>',
  // A circle lifts to the analytic DISC.
  circle:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
    '<circle cx="20" cy="20" r="15" fill="#3060c0"/></svg>',
};

const SIZE = 160;
const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = ${SIZE};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);

async function shoot(svg, lean) {
  const r = createRenderer(gl, shaders, { aacFill: false, lbKindOmit: lean });
  const b = createBundle(gl, await importSvg(svg));
  r.setLoopBlinnFill('on');
  try { r.prepareBundle(b); } catch {}
  if (r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  const frame = () => { r.setViewport(S, S); r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame(); };
  // precompileFills must follow a draw: the LB mesh (and so the kind mask, and so
  // the variant) is only known once the off-thread build has been adopted. It
  // force-links every pending program and builds Metal pipelines, so it is
  // expensive: TWO drains, not one and not one per frame. The first draw is what
  // makes the required variant known (the LB mesh arrives off-thread), and
  // finding it mismatched is what re-enqueues the bundle — so the SECOND drain is
  // the one that warms the right program. Draining per iteration makes this
  // smoke slow enough to time other suite tests out while still passing on its own.
  frame();
  if (r.precompileFills) { try { r.precompileFills(); } catch {} }
  frame();
  if (r.precompileFills) { try { r.precompileFills(); } catch {} }
  for (let i = 0; i < 8; i++) {
    frame();
    if ((r.debugStats && r.debugStats.unifiedFillDraws | 0) > 0) break;
    // rAF ALONE NEVER SETTLES in a headless page with no visible work. Timeout wins if rAF stalls.
      await new Promise((res) => { const _t = setTimeout(res, 100); requestAnimationFrame(() => { clearTimeout(_t); res(); }); });
  }

  frame();
  const st = r.debugStats || {};
  const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  try { b.dispose(); } catch {}
  return { px, key: st.fillVariantKey || '', uni: st.unifiedFillDraws | 0 };
}

const out = {};
for (const [name, svg] of Object.entries(${JSON.stringify(CASES)})) {
  const lean = await shoot(svg, true);
  const full = await shoot(svg, false);
  let diff = 0, worst = 0, ink = 0;
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    if (lean.px[o] > 8 || lean.px[o+1] > 8 || lean.px[o+2] > 8) ink++;
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(lean.px[o+k] - full.px[o+k]));
    if (d) { diff++; if (d > worst) worst = d; }
  }
  out[name] = { ink, diff, worst, uni: lean.uni,
                omits: (lean.key.match(/MANTLE_LB_NO_[A-Z_]+/g) || []).sort(),
                fullOmits: (full.key.match(/MANTLE_LB_NO_[A-Z_]+/g) || []).sort() };
}
window.out = out;
</script></body></html>`;

const mime = (p) =>
  /\.(js|mjs)$/.test(p) ? 'text/javascript' : p.endsWith('.glsl') ? 'text/plain' : 'text/html';
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const b = readFileSync(path.join(ROOT, decodeURIComponent(u.pathname)));
    res.writeHead(200, { 'content-type': mime(u.pathname) + '; charset=utf-8' });
    res.end(b);
  } catch {
    try {
      res.writeHead(404);
    } catch {}
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
  protocolTimeout: 300000,
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => {
  if (m.type() === 'error') logs.push(m.text());
});
page.on('pageerror', (e) => logs.push(String(e.message)));
await page.goto(`http://127.0.0.1:${server.address().port}/`, {
  waitUntil: 'load',
  timeout: 30000,
});
try {
  await page.waitForFunction('typeof window.out !== "undefined"', {
    timeout: pageTimeoutFor(280000),
    polling: 100,
  });
} catch {
  console.log('  page never finished:\n    ' + (logs.join('\n    ') || '(none)'));
  await browser.close();
  server.close();
  process.exit(1);
}
const r = await page.evaluate(() => window.out);
await browser.close();
server.close();

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
for (const [k, v] of Object.entries(r)) {
  console.log(
    `   ${k.padEnd(11)} ink ${String(v.ink).padStart(5)}  omits [${v.omits.join(' ')}]` +
      `  vs full: ${v.diff}px w${v.worst}`,
  );
}
console.log('');
for (const [k, v] of Object.entries(r)) {
  ok(v.ink > 300, `${k}: renders (${v.ink} ink px)`);
  ok(v.uni > 0, `${k}: on the unified route (so the variant is the one being tested)`);
  ok(v.omits.length > 0, `${k}: omitted at least one kind [${v.omits.join(' ')}] — not vacuous`);
  ok(v.fullOmits.length === 0, `${k}: lbKindOmit:false really compiles them all in`);
  ok(
    v.worst <= 1 && v.diff <= Math.max(4, v.ink * 0.001),
    `${k}: matches the full program within codegen noise (${v.diff}px, worst ${v.worst}/255)`,
  );
}
// Per-bundle, not a constant: the three shapes must not all omit the same set.
const sets = new Set(Object.values(r).map((v) => v.omits.join(',')));
ok(sets.size > 1, `the omit set is PER BUNDLE (${sets.size} distinct sets across 3 shapes)`);

console.log(
  `\nlbKindOmitSmoke: ${fail ? 'FAIL' : 'PASS'} — per-kind LB componentization, output-identical`,
);
process.exit(fail ? 1 : 0);
