// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeEndCandidateGpuSmoke -- the end-candidate gate is output-identical.
//
// A segment's own closest point is joined by its two ENDS as extra candidates: a pixel past an end plane can lie in that
// end's cap or join though another part of the segment is nearer. A round cap or join is a disc of radius halfW about the end,
// a bevel a triangle inside it and a butt end a slab, all inside the tube round the skeleton that the body distance already
// measures, so their candidate keeps that distance or raises it -- when the closest point is strictly INSIDE the segment. `strokeEndCandidate`
// (_strokeMath.glsl) skips them there; a square cap, a miter, a miter-clip or arcs join, a dash and any free butt end evaluate the candidate,
// and so does every candidate while the closest point is AT an end (its join wedge raises it; a near-closed arc with a bevel join, `arcs2`). They are a 5-18 percent share of an arc stroke's
// fragment cost on round-joined art.
//
// This renders every cap x join x segment-type x dash combination twice on the real cover pass: with the shipped shader, and with
// the gate defeated (`return true`, every end evaluated). The two pictures must be byte for byte the same, and the
// shipped shader must carry the gate (a tree without it fails the lookup).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const caps = ['butt', 'round', 'square'],
  joins = ['miter', 'round', 'bevel', 'miter-clip', 'arcs'];
const paths = {
  poly: 'M14 70 L40 16 L62 74 L86 22',
  quad: 'M12 78 Q40 6 58 60 T90 30',
  cubic: 'M10 80 C70 0 -10 10 56 70 S96 40 86 18',
  curl: 'M70 20 C10 10 10 90 50 50 S90 15 74 28',
  arc: 'M14 70 A26 16 20 0 1 56 22 A20 30 0 0 1 88 70',
  arcs2: 'M20 20 A30 30 0 1 1 22 20.5 L70 80',
  arcs3: 'M30 30 A24 24 0 1 1 33 31 Q60 50 50 80',
  arcs4: 'M30 30 A28 18 30 1 1 33.5 31 L10 84 C40 60 80 90 90 60',
  mixed: 'M12 20 L40 20 Q60 20 60 40 C60 70 30 60 30 84 A14 10 0 0 0 58 84',
  tiny: 'M40 40 L44 41 L41 46 Z',
};
const cases = [];
for (const [pn, d] of Object.entries(paths)) {
  for (const cap of caps)
    for (const join of joins) {
      cases.push({ name: `${pn} ${cap} ${join}`, d, cap, join, w: 12, dash: null });
    }
  cases.push({ name: `${pn} thin round`, d, cap: 'round', join: 'round', w: 1.4, dash: null });
  cases.push({ name: `${pn} dashed round`, d, cap: 'round', join: 'round', w: 9, dash: '14 9' });
  cases.push({
    name: `${pn} dashed butt miter`,
    d,
    cap: 'butt',
    join: 'miter',
    w: 9,
    dash: '14 9',
  });
}
const svgOf = (c) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="${c.d}" fill="none" stroke="#2050a0" stroke-width="${c.w}" stroke-linecap="${c.cap}" stroke-linejoin="${c.join}" stroke-miterlimit="4"${c.dash ? ` stroke-dasharray="${c.dash}"` : ''}/></svg>`;
const HTML = `<!doctype html><body style="margin:0"><canvas id="c" width="192" height="192"></canvas><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const gl = document.getElementById('c').getContext('webgl2', { antialias: false, depth: true, stencil: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const CASES = ${JSON.stringify(cases.map((c) => ({ name: c.name, svg: svgOf(c) })))};
const re = /bool strokeEndCandidate\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}/;
const hasGate = re.test(shaders.fillFrag);
const defeated = { ...shaders, fillFrag: shaders.fillFrag.replace(re, 'bool strokeEndCandidate(bool fs, bool fe, int sc, int ec, int js, int dash, int e) { return true; }') };
const make = (sh) => { const r = createRenderer(gl, sh, { unifiedFill: false, aacPoints: false }); r.setViewport(192, 192); return r; };
const out = { hasGate, rows: [] };
try {
  const A = make(shaders), B = make(defeated);
  await A.ready; await B.ready;
  const shoot = async (R, svg) => {
    const b = createBundle(gl, await importSvg(svg, {}));
    // The loading call links and warms the bundle's own program, so the one frame below draws what play draws, not a stand-in.
    R.prepareBundle(b); R.prewarmBundle(b); R.precompileFills();
    R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
    const px = new Uint8Array(192 * 192 * 4); gl.readPixels(0, 0, 192, 192, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const ink = (R.debugStats && R.debugStats.drawnFillVariantKey) || '';
    b.dispose && b.dispose();
    return { px, ink };
  };
  for (const c of CASES) {
    const a = await shoot(A, c.svg), b = await shoot(B, c.svg);
    let diff = 0, max = 0, ink = 0;
    for (let i = 0; i < a.px.length; i++) { const e = Math.abs(a.px[i] - b.px[i]); if (e) diff++; if (e > max) max = e; if (i % 4 === 0 && a.px[i] < 240) ink++; }
    out.rows.push({ name: c.name, diff, max, ink, key: a.ink, keyB: b.ink, err: gl.getError() });
  }
} catch (e) { out.error = String(e.stack || e); }
window.out = out;
</script>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/') {
    res.setHeader('content-type', 'text/html');
    res.end(HTML);
    return;
  }
  try {
    res.setHeader('content-type', u.pathname.endsWith('.glsl') ? 'text/plain' : 'text/javascript');
    res.end(fs.readFileSync(path.join(ROOT, decodeURIComponent(u.pathname))));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser,
  fail = 0;
const ok = (c, m) => {
  if (c) console.log('  ok ' + m);
  else {
    fail++;
    console.error('  FAIL ' + m);
  }
};
try {
  browser = await launchBrowser({
    headless: 'new',
    args: ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
    protocolTimeout: pageTimeoutFor(600000) + 10000,
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction('window.out', { timeout: pageTimeoutFor(540000), polling: 200 });
  const out = await page.evaluate(() => window.out);
  if (out.error) {
    console.error(out.error);
    fail++;
  }
  ok(out.hasGate, 'the shipped shader carries strokeEndCandidate');
  let inked = 0;
  for (const r of out.rows) {
    if (r.ink > 0) inked++;
    ok(
      r.diff === 0 && !r.err,
      `${r.name}: gated == every end evaluated (${r.diff} bytes differ, max ${r.max}, ink ${r.ink}, programs ${r.key} / ${r.keyB})`,
    );
  }
  ok(
    out.rows.length === cases.length && inked >= cases.length - 2,
    `all ${cases.length} cases drew ink (${inked})`,
  );
} finally {
  if (browser) await browser.close();
  server.close();
}
console.log(fail ? `STROKE-END-CANDIDATE-GPU FAIL (${fail})` : 'STROKE-END-CANDIDATE-GPU PASS');
process.exit(fail ? 1 : 0);
