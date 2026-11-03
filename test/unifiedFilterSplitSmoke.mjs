// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// unifiedFilterSplitSmoke.mjs — an offscreen filter does not take the whole
// bundle off the unified route.
//
// The unified fill draw puts every shape in ONE drawArrays, and blur/morphology/
// graph filters need the shape isolated in its own target, which one draw has no
// step for. Rather than decline the bundle, the route SPLITS — the runs either side of a filtered
// shape are drawn as ranges of the same buffer, and the filtered shape's own
// range is drawn into the isolation target. That is the interruption Slug's
// drawList loop already performs.
//
// unifiedFillFeatureSmoke covers a LONE filtered shape. The failure modes of the
// split are the ones only a mixture shows:
//
//   ORDERING — the runs must composite in painter order across the interruption.
//     Getting this wrong is invisible on a lone shape and obvious here: shape 3
//     must cover the blurred shape 2, and shape 5 must cover the blurred shape 4.
//   BACKDROP — the isolation step snapshots the canvas as its filter backdrop, so
//     the run BEFORE a filtered shape must already have been drawn. Draw the runs
//     in the wrong order and the blur composites over an empty backdrop.
//   MORE THAN ONE — two filtered shapes mean three runs and two interruptions.
//
// Slug is the reference: it walks the same drawList shape by shape and has always
// interrupted for filters, so agreeing with it IS the assertion.

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const S = 160;

// Five overlapping circles in paint order, two of them blurred. Circles so every
// shape carries curves and gets a real Loop-Blinn mesh — a polygon would be
// served by a cover quad and would not exercise the LB range at all.
//
// The overlaps are what make ordering checkable: 3 sits on top of 2, and 5 on top
// of 4, so a probe inside each overlap has exactly one correct color.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
<defs>
  <filter id="b1"><feGaussianBlur stdDeviation="1.2"/></filter>
  <filter id="b2"><feGaussianBlur stdDeviation="1.2"/></filter>
</defs>
<circle cx="12" cy="12" r="7" fill="#c03030"/>
<circle cx="20" cy="14" r="7" fill="#3060c0" filter="url(#b1)"/>
<circle cx="26" cy="16" r="6" fill="#30a040"/>
<circle cx="16" cy="28" r="7" fill="#d08020" filter="url(#b2)"/>
<circle cx="24" cy="30" r="6" fill="#e8e8e8"/>
</svg>`;

const HTML = `<!DOCTYPE html><html><body>
<canvas id="c" width="${S}" height="${S}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const S = ${S};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);

async function shoot(mode, src) {
  // aacFill off so the comparison is Slug-vs-LB and not three engines at once.
  const opts = { aacFill: false };
  if (mode === 'declined') opts.unifiedFillFilters = false;   // the whole-bundle bail
  const r = createRenderer(gl, shaders, opts);
  const b = createBundle(gl, await importSvg(src));
  r.setLoopBlinnFill(mode === 'slug' ? 'off' : 'on');
  try { r.prepareBundle(b); } catch {}
  if (mode !== 'slug' && r.awaitLbReady) { try { await r.awaitLbReady(b, 20000); } catch {} }
  if (r.prewarmBundle) { try { r.prewarmBundle(b); } catch {} }
  const frame = () => { r.setViewport(S, S); r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame(); };
  // Two drains: the first draw is what makes the required variant known (the LB
  // mesh arrives off-thread), and finding it mismatched re-enqueues the bundle.
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
  const st0 = r.debugStats || {};
  const before = st0.unifiedFillDraws | 0, fBefore = st0.unifiedFilterDraws | 0;
  frame();
  const st = r.debugStats || {};
  const px = new Uint8Array(S * S * 4);
  gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
  try { b.dispose(); } catch {}
  return { px, gate: st.unifiedFillGate || '?',
           uni: (st.unifiedFillDraws | 0) - before,
           filt: (st.unifiedFilterDraws | 0) - fBefore,
           isolateFail: st.unifiedFilterIsolateFail | 0 };
}

// viewBox is 40x40 into a 160x160 canvas, and readPixels is bottom-up.
const at = (px, vx, vy) => {
  const x = Math.round(vx * S / 40), yTop = Math.round(vy * S / 40);
  const o = ((S - 1 - yTop) * S + x) * 4;
  return [px[o], px[o + 1], px[o + 2]];
};
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
// How soft the blurred shape's edge is: count pixels along a horizontal scan that
// are PARTIALLY lit. An unfiltered circle has two or three such pixels per edge
// (just the AA ramp); a blurred one has many. This is what separates "the filter
// ran" from "the shape drew and the kernel never fired".
const softness = (px, vy) => {
  const yTop = Math.round(vy * S / 40);
  let n = 0;
  for (let x = 0; x < S; x++) {
    const o = ((S - 1 - yTop) * S + x) * 4;
    const b = px[o + 2], g = px[o + 1], r = px[o];
    const lum = Math.max(r, g, b);
    if (lum > 12 && lum < 150) n++;
  }
  return n;
};

const SVG = ${JSON.stringify(SVG)};
// The SAME scene with both filters removed. Loop-Blinn's curve AA is 2-3x less
// accurate than Slug's, so unified-vs-Slug is never zero on circles and a raw
// threshold would either be meaningless or would fail on that alone. This control
// measures exactly that gap on this scene, so the assertion can ask what the SPLIT
// costs on top of it.
const PLAIN = SVG.replace(/ filter="url\\(#b[12]\\)"/g, '');

const slug = await shoot('slug', SVG);
const unified = await shoot('unified', SVG);
const declined = await shoot('declined', SVG);
const slugPlain = await shoot('slug', PLAIN);
const uniPlain = await shoot('unified', PLAIN);
window.out = {
  gate: { unified: unified.gate, declined: declined.gate },
  uni: { unified: unified.uni, declined: declined.uni },
  filt: unified.filt, isolateFail: unified.isolateFail,
  vsSlug: { unified: vs(slug.px, unified.px), declined: vs(slug.px, declined.px),
            plain: vs(slugPlain.px, uniPlain.px) },
  // Inside shape 3 (green, on top of the blurred 2) and shape 5 (white, on top of
  // the blurred 4). Painter order decides both.
  over1: { slug: at(slug.px, 28, 16), unified: at(unified.px, 28, 16) },
  over2: { slug: at(slug.px, 26, 30), unified: at(unified.px, 26, 30) },
  // Inside shape 1, which is drawn BEFORE the first filtered shape — the run that
  // has to exist and has to come first.
  first: { slug: at(slug.px, 10, 10), unified: at(unified.px, 10, 10) },
  soft: { slug: softness(slug.px, 14), unified: softness(unified.px, 14) },
};
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
const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

console.log('  ', JSON.stringify(r));
console.log('');

ok(
  r.gate.unified === 'on',
  `two blurred shapes among three plain ones stay on the unified route (gate ${r.gate.unified})`,
);
ok(
  r.uni.unified >= 3,
  `the draw SPLIT into runs (${r.uni.unified} spans; 3 runs + 2 isolated renders expected)`,
);
ok(r.filt === 2, `both filtered shapes were isolated (${r.filt} of 2)`);
ok(r.isolateFail === 0, `no isolation failed (${r.isolateFail})`);

// Ordering. A wrong split shows here first: if the runs composite out of order the
// blurred shape lands on top of the plain one that should cover it.
ok(
  near(r.over1.unified, r.over1.slug, 6),
  `paint order across the FIRST split: ${JSON.stringify(r.over1.unified)} vs Slug ${JSON.stringify(r.over1.slug)}`,
);
ok(
  near(r.over2.unified, r.over2.slug, 6),
  `paint order across the SECOND split: ${JSON.stringify(r.over2.unified)} vs Slug ${JSON.stringify(r.over2.slug)}`,
);
ok(
  near(r.first.unified, r.first.slug, 6),
  `the run BEFORE the first filter drew: ${JSON.stringify(r.first.unified)} vs Slug ${JSON.stringify(r.first.slug)}`,
);

// The filter actually ran. Taken wrongly — shape drawn, kernel skipped — the edge
// is a hard AA ramp and this collapses toward Slug's unblurred count.
ok(
  r.soft.unified >= r.soft.slug * 0.6 && r.soft.unified > 8,
  `the blur KERNEL ran (${r.soft.unified} partially-lit px on the scan, Slug ${r.soft.slug})`,
);

// The whole point: no further from Slug than the same SCENE UNFILTERED already is.
// That control is the LB curve-AA gap on these circles (LB is 2-3x less accurate
// than Slug on curves, so an absolute threshold would measure that and not the
// split). What is left over is what the isolation and the run-splitting cost.
ok(
  r.vsSlug.unified.worst <= r.vsSlug.plain.worst + 4,
  `no further from Slug than the unfiltered control: worst ${r.vsSlug.unified.worst} vs ` +
    `${r.vsSlug.plain.worst} (${r.vsSlug.unified.n}px / ${r.vsSlug.plain.n}px)`,
);
// ...and nowhere near the signature of a filter that never fired (9680px, w97).
ok(
  r.vsSlug.unified.worst < 40,
  `not the 'filter never ran' signature (worst ${r.vsSlug.unified.worst}, that defect is w97)`,
);
// And the decline still works as a bisection tool.
ok(
  r.gate.declined === 'offscreen-filter' && r.uni.declined === 0,
  `unifiedFillFilters:false still declines the bundle (gate ${r.gate.declined})`,
);

if (fail) {
  console.error(`\nunifiedFilterSplitSmoke: FAIL — ${fail} assertion(s)`);
  process.exit(1);
}
console.log('\nunifiedFilterSplitSmoke: PASS');
