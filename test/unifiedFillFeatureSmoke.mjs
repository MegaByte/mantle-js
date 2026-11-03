// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedFillFeatureSmoke.mjs — the unified fill draw across the FEATURE MATRIX.
//
// The whole point of hosting Loop-Blinn coverage in the ubershader is that a
// bundle's cover quads and LB triangles go in ONE drawArrays, with no per-shape
// coverage render target. That only earns its place if it serves what the RT
// paths served, so this walks the features one at a time and asserts three
// things per feature:
//
//   1. the route either TAKES the bundle or declines with a NAMED gate
//      (debugStats.unifiedFillGate) — never silently
//   2. it costs no more GL draws than the route it replaces, and ZERO
//      coverage-RT draws
//   3. it is no further from Slug than the route it replaces
//
// (3) is the one that matters. Comparing the two routes to each OTHER only says
// they differ, not which is right — and on two features here the older route is
// the wrong one: dashed strokes are 356 px / 192 off Slug through the coverage RT
// and exact through this draw.
//
// The A/B holds the shader variant fixed via `unifiedFill: false`. Comparing
// "MANTLE_LB_FILL on" to "off" would move the variant and the route together,
// and a GL draw count of 1 does not identify the route either — the classic
// combined route also paints a solid bundle in one drawArrays.

import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const D = 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z';
const svg = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">${defs}${body}</svg>`;

// `filtered`: an offscreen filter needs the shape isolated in its own target
// first, and a single draw has no isolation step; taken as one draw it renders
// unfiltered — thousands of px off Slug at worst 97/255.
//
// It is SERVED, by splitting the draw into runs around the filtered shape and
// rendering that shape's own vertex range into the isolation target — the same
// interruption Slug's drawList loop performs. So it faces the ordinary bar here,
// and the unfiltered signature is what a defect would look like.
const CASES = {
  solid: svg(`<path fill="#3060c0" d="${D}"/>`),
  twoShapes: svg(`<path fill="#3060c0" d="${D}"/><circle cx="28" cy="12" r="8" fill="#c04030"/>`),
  translucent: svg(`<path fill="#3060c0" fill-opacity="0.5" d="${D}"/>`),
  gradient: svg(
    `<path fill="url(#g)" d="${D}"/>`,
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#3060c0"/>' +
      '<stop offset="1" stop-color="#c04030"/></linearGradient></defs>',
  ),
  stroked: svg(`<path fill="#3060c0" stroke="#102040" stroke-width="3" d="${D}"/>`),
  strokeOnly: svg(`<path fill="none" stroke="#3060c0" stroke-width="3" d="${D}"/>`),
  dashed: svg(
    `<path fill="none" stroke="#3060c0" stroke-width="3" stroke-dasharray="4 2" d="${D}"/>`,
  ),
  clipped: svg(
    `<path fill="#3060c0" clip-path="url(#c)" d="${D}"/>`,
    '<defs><clipPath id="c"><rect x="4" y="4" width="22" height="32"/></clipPath></defs>',
  ),
  masked: svg(
    `<path fill="#3060c0" mask="url(#m)" d="${D}"/>`,
    '<defs><mask id="m"><rect x="4" y="4" width="22" height="32" fill="#fff"/></mask></defs>',
  ),
  filtered: svg(
    `<path fill="#3060c0" filter="url(#f)" d="${D}"/>`,
    '<defs><filter id="f"><feGaussianBlur stdDeviation="1"/></filter></defs>',
  ),
  evenOdd: svg(
    `<path fill="#3060c0" fill-rule="evenodd" d="${D} M20 12 C26 12 28 14 28 20 ` +
      `C28 26 26 28 20 28 C14 28 12 26 12 20 C12 14 14 12 20 12 Z"/>`,
  ),
  // Taken as one plain draw, both render WRONG: an opacity group loses the group's
  // opacity (and the group ops read as shape 0 a second time), up to 123/255 off
  // Slug, and a multiply leaf never applies the blend, up to 192/255.
  //
  // both are SERVED. The span walk interrupts for them exactly as it does for an
  // offscreen filter, and drives renderer.js's own code rather than a copy of it:
  // R._groupBegin / R._groupEnd for the accumulator bracket, R._blendLeaf (taking a
  // renderSource callback) for the isolated leaf. Nothing on this matrix declines.
  opacityGroup: svg(
    `<g opacity="0.5"><path fill="#3060c0" d="${D}"/>` +
      `<circle cx="28" cy="12" r="8" fill="#c04030"/></g>`,
  ),
  blendLeaf: svg(
    `<path fill="#3060c0" d="${D}"/>` +
      `<circle cx="28" cy="12" r="8" fill="#c04030" style="mix-blend-mode:multiply"/>`,
  ),
};
// name -> the gate it must decline with. A decline is only acceptable when it is
// NAMED: the failure this guards against is the route taking a bundle it cannot
// serve and painting something plausible but wrong.
const MUST_DECLINE = new Map();
// LB curve AA is 2-3x less accurate than Slug; a lone cubic squircle measures 58.
const LB_AA_ENVELOPE = 60;

const SIZE = Number(process.env.SEAM_SIZE || 160);
const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${SIZE}" height="${SIZE}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = ${SIZE};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
let draws = 0;
for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
  const o = gl[m].bind(gl);
  gl[m] = (...a) => { draws++; return o(...a); };
}
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);

async function shoot(svgSrc, mode) {
  const opts = { aacFill: false };
  if (mode === 'classic') opts.unifiedFill = false;
  const r = createRenderer(gl, shaders, opts);
  const b = createBundle(gl, await importSvg(svgSrc));
  r.setLoopBlinnFill(mode === 'slug' ? 'off' : 'on');
  try { r.prepareBundle(b); } catch {}
  if (mode !== 'slug' && r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  if (r.prewarmBundle) { try { r.prewarmBundle(b); } catch {} }
  const frame = () => { r.setViewport(S, S); r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame(); };
  // precompileFills force-links every pending program and builds Metal
  // pipelines, so it is expensive: call it ONCE after the first draw (which is
  // what makes the required variant known) and then just spin frames. Calling it
  // per iteration made this smoke slow enough to time out other tests in the
  // suite while still passing on its own.
  // TWO drains, not one and not thirty. The first draw is what makes the required
  // variant known (the LB mesh arrives off-thread), and finding it mismatched is
  // what re-enqueues the bundle — so the SECOND drain is the one that warms the
  // right program. Draining per-iteration instead made this smoke slow enough to
  // time other suite tests out while still passing on its own.
  frame();
  if (r.precompileFills) { try { r.precompileFills(); } catch {} }
  frame();
  if (r.precompileFills) { try { r.precompileFills(); } catch {} }
  // (only the unified arm waits for a unified draw: the slug and classic arms never make one)
  for (let i = 0; mode === 'unified' && i < 8; i++) {
    frame();
    if ((r.debugStats && r.debugStats.unifiedFillDraws | 0) > 0) break;
    // NEVER WAIT ON rAF ALONE. Headless Chrome stops producing animation frames once this page
    // has no visible work left, so an rAF used only for pacing can simply never fire -- the
    // promise never settles, window.out is never assigned, and the test hangs until its wait
    // gives up. The timeout is the guarantee; rAF is still preferred when it works.
    // (No backticks in here: this comment lives inside the page's template literal.)
    await new Promise((res) => {
      const t = setTimeout(res, 100);
      requestAnimationFrame(() => { clearTimeout(t); res(); });
    });
  }

  // Baseline the CUMULATIVE counters before the measured frame. The warm frames
  // above legitimately take the RT fallback while the variant links, so a lifetime
  // total would report those and say the route still uses a render target.
  const st0 = r.debugStats || {};
  const before = st0.unifiedFillDraws | 0;
  const fBefore = st0.unifiedFilterDraws | 0;
  const rt0 = (st0.composedFillFromRT | 0) + (st0.composedStrokeFromRT | 0);
  draws = 0; frame();
  const st = r.debugStats || {};
  const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  try { b.dispose(); } catch {}
  r.dispose();
  // Route participation = spans drawn PLUS shapes isolated for a filter. A frame
  // whose only shape is a filtered one that HIT the result cache issues no spans at
  // all — that is the cache working, not the route declining — so counting
  // unifiedFillDraws alone would read as "not taken".
  return { px, draws, gate: st.unifiedFillGate || '?',
           uni: ((st.unifiedFillDraws | 0) - before) + ((st.unifiedFilterDraws | 0) - fBefore),
           lb: (st.loopBlinnRouteCount | 0) + (st.loopBlinnMorphRouteCount | 0),
           rt: ((st.composedFillFromRT | 0) + (st.composedStrokeFromRT | 0)) - rt0 };
}

// Worst per-channel delta and how many pixels differ at all. The WORST case is
// the metric: a mean over the shape buries a one-pixel seam ~60x.
const vs = (a, b) => {
  let n = 0, worst = 0;
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    let d = 0;
    for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a[o+k] - b[o+k]));
    if (d) { n++; if (d > worst) worst = d; }
  }
  return { n, worst };
};

const out = {};
for (const [name, s] of Object.entries(${JSON.stringify(CASES)})) {
  const slug = await shoot(s, 'slug');
  const classic = await shoot(s, 'classic');
  const unified = await shoot(s, 'unified');
  let ink = 0;
  for (let i = 0; i < S * S; i++) {
    const o = i * 4;
    if (slug.px[o] > 8 || slug.px[o+1] > 8 || slug.px[o+2] > 8) ink++;
  }
  out[name] = { gate: unified.gate, uni: unified.uni, ink,
                draws: { classic: classic.draws, unified: unified.draws },
                rt: { classic: classic.rt, unified: unified.rt },
                classicUsedLb: classic.lb > 0,
                cvs: vs(slug.px, classic.px), uvs: vs(slug.px, unified.px) };
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
  } catch (e) {
    // NAME WHAT COULD NOT BE SERVED. A page that 404s on a module never finishes, so the test hangs
    // until its wait gives up -- and "Failed to load resource: 404" with no path is not a diagnosis.
    console.error(`  [404] ${u.pathname} (${(e && e.code) || 'unreadable'})`);
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

console.log(
  '   feature       gate              draws c/u   RT c/u   ink    classic-vs-slug  unified-vs-slug',
);
for (const [k, v] of Object.entries(r)) {
  console.log(
    `   ${k.padEnd(13)} ${String(v.gate).padEnd(17)} ${String(v.draws.classic).padStart(3)}/` +
      `${String(v.draws.unified).padEnd(4)} ${String(v.rt.classic).padStart(3)}/${String(v.rt.unified).padEnd(4)}` +
      ` ${String(v.ink).padStart(5)}  ${String(v.cvs.n).padStart(6)}px w${String(v.cvs.worst).padStart(4)}` +
      `  ${String(v.uvs.n).padStart(6)}px w${String(v.uvs.worst).padStart(4)}`,
  );
}
console.log('');

for (const [k, v] of Object.entries(r)) {
  ok(v.ink > 300, `${k}: renders (${v.ink} ink px)`);
  if (MUST_DECLINE.has(k)) {
    ok(
      v.uni === 0 && v.gate === MUST_DECLINE.get(k),
      `${k}: DECLINED with a named gate (${v.gate}) — this route cannot isolate it`,
    );
    // And declining has to be CORRECT, not merely honest: the classic route it
    // falls to must land on Slug. This is the assertion that would have caught
    // both cases being taken and rendered wrong.
    ok(
      v.uvs.worst === 0,
      `${k}: declining renders exactly like Slug (${v.uvs.n}px, worst ${v.uvs.worst})`,
    );
    continue;
  }
  ok(v.uni > 0 && v.gate === 'on', `${k}: taken by the unified route (gate ${v.gate})`);
  ok(v.rt.unified === 0, `${k}: no coverage RT (${v.rt.classic} -> ${v.rt.unified})`);
  // The comparison arm is `unifiedFill: false`, which means SLUG. The split pays extra
  // draws to isolate a filtered shape, but the filter result cache removes them again
  // on a steady-state redraw, so the same bar holds.
  ok(
    v.draws.unified <= v.draws.classic,
    `${k}: ${v.draws.classic} -> ${v.draws.unified} GL draw(s)`,
  );
  // "No worse than the route it replaces" is only a fair test when that route
  // ALSO used Loop-Blinn. Where the comparison route falls back to Slug for the whole
  // bundle it scores a perfect 0 against Slug by construction, and holding LB to
  // that would be comparing LB-vs-Slug against Slug-vs-Slug. There the bar is
  // instead the documented LB curve-AA envelope (LB curve AA is 2-3x less
  // accurate than Slug; the same shape drawn alone measures 58).
  //
  // +2/255 of slack on the like-for-like case: both routes run the same kernels,
  // so a real defect is a seam or a dropped feature and shows up far above
  // the rounding floor.
  if (v.classicUsedLb) {
    ok(
      v.uvs.worst <= v.cvs.worst + 2,
      `${k}: no further from Slug than the RT route (worst ${v.uvs.worst} vs ${v.cvs.worst})`,
    );
  } else {
    ok(
      v.uvs.worst <= LB_AA_ENVELOPE,
      `${k}: the comparison route is whole-bundle Slug, so this is a ROUTING widening —` +
        ` LB's own curve AA, within envelope (worst ${v.uvs.worst} <= ${LB_AA_ENVELOPE})`,
    );
  }
}

console.log(
  `\nunifiedFillFeatureSmoke: ${fail ? 'FAIL' : 'PASS'} — ` +
    `${Object.keys(r).length} features, ${Object.values(r).filter((v) => v.uni > 0).length} on the unified route`,
);
process.exit(fail ? 1 : 0);
