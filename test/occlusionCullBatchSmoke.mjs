// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// occlusionCullBatchSmoke -- a shape the occlusion cull drops must not split the bundle's cover draw.
//
// The cull removes a hidden shape from the draw list, but its cover quad stays in the middle of the handle's cover buffer, and
// the cover pass merges chunks into one drawArrays only while each starts where the last ended: every culled shape between two
// painted ones costs another draw (100 extra per frame on train_b018.svg). The handle lays its buffer out for the draw list
// instead, with the culled chunks behind the painted ones, so the culled bundle draws in as many calls as the same bundle with
// the cull off. Each case compares the cut bundle with that uncut twin (createBundle({ occlusionCull: false })), drawn the
// same way, frame by frame:
//   lateCull      the worker half of the cull lands after the handle has drawn: same draw count, byte-identical frames;
//                 an override that hides the occluder retires the cull and the hidden shape paints again (same pixels, same
//                 draw count as the uncut twin); clearing it keeps both.
//   inlineCull    a coincident layer culled at build (the correctness half of the cull): same draw count; hiding its occluder
//                 shows it.
//   unifiedRoute  the unified stream (unifiedFill 'force') draws the same scenes: the inline-culled layer appears once an
//                 override hides its occluder, and the late cull's hidden shape appears when its occluder is hidden.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = 512;

// GREEN left, BLUE under RED (hidden well clear of RED's edges, so the worker half of the cull takes it), RED, YELLOW right.
const LATE =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">` +
  `<rect id="left" x="2" y="56" width="16" height="16" fill="#00ff00"/>` +
  `<rect id="under" x="48" y="48" width="32" height="32" fill="#0000ff"/>` +
  `<rect id="over" x="24" y="24" width="80" height="80" fill="#ff0000"/>` +
  `<rect id="right" x="110" y="56" width="16" height="16" fill="#ffff00"/>` +
  `</svg>`;
// GREEN left, MAGENTA exactly under CYAN (coincident: culled inline at build), YELLOW right.
const INLINE =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">` +
  `<rect id="left" x="2" y="56" width="16" height="16" fill="#00ff00"/>` +
  `<rect id="twinUnder" x="24" y="24" width="80" height="80" fill="#ff00ff"/>` +
  `<rect id="twinOver" x="24" y="24" width="80" height="80" fill="#00ffff"/>` +
  `<rect id="right" x="110" y="56" width="16" height="16" fill="#ffff00"/>` +
  `</svg>`;

const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas><canvas id="u" width="${N}" height="${N}"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createOverrideTable } from '/src/index.js';
try {
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const ctx = (id, ropts) => {
  const gl = document.getElementById(id).getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const r = createRenderer(gl, shaders, ropts);
  r.setViewport(${N}, ${N});
  let draws = 0, inst = 0;
  const da = gl.drawArrays.bind(gl), dai = gl.drawArraysInstanced.bind(gl);
  gl.drawArrays = (...a) => { draws++; return da(...a); };
  gl.drawArraysInstanced = (...a) => { inst++; return dai(...a); };
  const grab = () => { const p = new Uint8Array(${N} * ${N} * 4); gl.readPixels(0, 0, ${N}, ${N}, gl.RGBA, gl.UNSIGNED_BYTE, p); return p; };
  // One frame of one handle: its drawArrays count, instanced draws, unified draws and pixels.
  const paint = (h, opts) => {
    r.beginFrame([1, 1, 1, 1]);
    draws = 0; inst = 0;
    const u0 = r.debugStats.unifiedFillDraws | 0;
    h.draw(opts || {});
    const out = { draws, inst, uni: (r.debugStats.unifiedFillDraws | 0) - u0, route: r.debugStats.unifiedFillGate };
    r.endFrame();
    out.px = grab();
    return out;
  };
  return { gl, r, paint };
};
const settle = async (b) => { while (b._occlusionCullPending) await new Promise((res) => setTimeout(res, 10)); };
const has = (px, rgb) => { for (let i = 0; i < px.length; i += 4) if (px[i] === rgb[0] && px[i + 1] === rgb[1] && px[i + 2] === rgb[2]) return true; return false; };
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
const BLUE = [0, 0, 255], MAGENTA = [255, 0, 255], RED = [255, 0, 0], CYAN = [0, 255, 255];
const C = ctx('c', {}), U = ctx('u', { unifiedFill: 'force' });
const bundles = async (X, svg) => {
  const sec = await importSvg(svg, { preserveViewport: true });
  const cut = createBundle(X.gl, sec), whole = createBundle(X.gl, await importSvg(svg, { preserveViewport: true }), { occlusionCull: false });
  return { cut, whole, hc: X.r.createBundleHandle(cut), hw: X.r.createBundleHandle(whole), ovc: createOverrideTable(X.gl, cut), ovw: createOverrideTable(X.gl, whole) };
};
// A state of the pair: both drawn the same way, compared.
const pair = (X, s, opts) => {
  const a = X.paint(s.hc, opts && opts(s.ovc)), b = X.paint(s.hw, opts && opts(s.ovw));
  return { cut: a.draws, whole: b.draws, inst: a.inst + b.inst, uni: a.uni, route: a.route, diff: diff(a.px, b.px), px: a.px };
};
const strip = (o) => { const { px, ...rest } = o; return rest; };
const out = {};

// lateCull: the handle draws before the worker's answer lands.
{
  const s = await bundles(C, ${JSON.stringify(LATE)});
  out.lateBefore = strip(pair(C, s));
  await settle(s.cut);
  out.lateCulled = Array.from(s.cut._culledShapes || []);
  pair(C, s);
  const culled = pair(C, s);
  out.late = { ...strip(culled), blue: has(culled.px, BLUE), red: has(culled.px, RED) };
  const hide = (ov) => (ov.set('over', { visibility: 0 }), { overrides: ov });
  const hidden = pair(C, s, hide);
  out.lateHidden = { ...strip(hidden), blue: has(hidden.px, BLUE), red: has(hidden.px, RED), retired: !!s.cut._cullRetired };
  const back = (ov) => (ov.set('over', {}), { overrides: ov });
  pair(C, s, back);
  const restored = pair(C, s, back);
  out.lateRestored = { ...strip(restored), blue: has(restored.px, BLUE), red: has(restored.px, RED) };
}
// inlineCull: a coincident layer, culled at build.
{
  const s = await bundles(C, ${JSON.stringify(INLINE)});
  await settle(s.cut);
  out.inlineCulled = Array.from(s.cut._culledShapes || []);
  pair(C, s);
  const culled = pair(C, s);
  out.inline = { ...strip(culled), magenta: has(culled.px, MAGENTA), cyan: has(culled.px, CYAN) };
  const hide = (ov) => (ov.set('twinOver', { visibility: 0 }), { overrides: ov });
  pair(C, s, hide);
  const hidden = pair(C, s, hide);
  out.inlineHidden = { ...strip(hidden), magenta: has(hidden.px, MAGENTA), cyan: has(hidden.px, CYAN) };
}
// unifiedRoute: the same reveals on the unified stream.
{
  const s = await bundles(U, ${JSON.stringify(INLINE)});
  await settle(s.cut);
  // until its program is warm the unified route hands the draw to another route
  let culled = pair(U, s);
  while (!(culled.uni > 0)) {
    await new Promise((res) => setTimeout(res, 10));
    culled = pair(U, s);
  }
  out.uniInline = { ...strip(culled), magenta: has(culled.px, MAGENTA), cyan: has(culled.px, CYAN) };
  const hide = (ov) => (ov.set('twinOver', { visibility: 0 }), { overrides: ov });
  pair(U, s, hide);
  const hidden = pair(U, s, hide);
  out.uniInlineHidden = { ...strip(hidden), magenta: has(hidden.px, MAGENTA), cyan: has(hidden.px, CYAN) };
  const t = await bundles(U, ${JSON.stringify(LATE)});
  pair(U, t);
  await settle(t.cut);
  pair(U, t);
  const hideL = (ov) => (ov.set('over', { visibility: 0 }), { overrides: ov });
  pair(U, t, hideL);
  const lateHidden = pair(U, t, hideL);
  out.uniLateHidden = { ...strip(lateHidden), blue: has(lateHidden.px, BLUE), red: has(lateHidden.px, RED) };
}
window.__out = out;
} catch (e) { window.__error = String(e && e.stack || e); }
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(req.url.split('?')[0]);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await launchBrowser({
  headless: 'new',
  args: ['--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page]', e.message));
await openReady(page, `http://127.0.0.1:${server.address().port}/`, {
  name: 'occlusionCullBatchSmoke',
});
const { out, error } = await page.evaluate(() => ({ out: window.__out, error: window.__error }));
await browser.close();
server.close();

if (error || !out) {
  console.error('FAIL page error: ' + error);
  process.exit(1);
}
let fail = 0;
const ok = (condition, message) =>
  condition ? console.log('ok ' + message) : (fail++, console.error('FAIL ' + message));
for (const [k, v] of Object.entries(out)) console.log(`  ${k}: ${JSON.stringify(v)}`);

// Vacuity guards: the cull fired, and the classic arms drew on the cover pass (not the AAC points route or the unified stream).
ok(out.lateCulled.length === 1, 'the worker half of the cull dropped the shape under RED');
ok(out.inlineCulled.length === 1, 'the inline half of the cull dropped the coincident layer');
ok(
  [out.late, out.inline].every((o) => o.inst === 0 && o.uni === 0 && o.whole > 0),
  'the classic arms draw on the cover pass',
);

ok(out.lateBefore.diff === 0, 'before the late cull lands: cut and uncut bundles paint the same');
ok(
  out.late.cut === out.late.whole,
  `late cull: the culled bundle draws in as many calls as the uncut one (${out.late.cut} vs ${out.late.whole})`,
);
ok(
  out.late.diff === 0,
  `late cull: byte-identical to the uncut bundle (${out.late.diff} bytes differ)`,
);
ok(out.late.red && !out.late.blue, 'late cull: RED covers BLUE');
ok(out.lateHidden.retired, 'hiding the occluder retires the cull');
ok(out.lateHidden.blue && !out.lateHidden.red, 'occluder hidden: the culled shape paints again');
ok(
  out.lateHidden.diff === 0,
  `occluder hidden: byte-identical to the uncut bundle (${out.lateHidden.diff} bytes differ)`,
);
ok(
  out.lateHidden.cut === out.lateHidden.whole,
  `occluder hidden: as many calls as the uncut bundle (${out.lateHidden.cut} vs ${out.lateHidden.whole})`,
);
ok(
  out.lateRestored.red && !out.lateRestored.blue && out.lateRestored.diff === 0,
  'override cleared: RED covers BLUE, byte-identical to the uncut bundle',
);
ok(
  out.lateRestored.cut === out.lateRestored.whole,
  `override cleared: as many calls as the uncut bundle (${out.lateRestored.cut} vs ${out.lateRestored.whole})`,
);

ok(
  out.inline.cut === out.inline.whole,
  `inline cull: the culled bundle draws in as many calls as the uncut one (${out.inline.cut} vs ${out.inline.whole})`,
);
ok(out.inline.cyan && !out.inline.magenta, 'inline cull: CYAN covers MAGENTA');
ok(out.inlineHidden.magenta && !out.inlineHidden.cyan, 'inline cull: hiding CYAN shows MAGENTA');
ok(
  out.inlineHidden.diff === 0 && out.inlineHidden.cut === out.inlineHidden.whole,
  `inline cull, occluder hidden: byte-identical to the uncut bundle in as many calls (${out.inlineHidden.diff} bytes, ${out.inlineHidden.cut} vs ${out.inlineHidden.whole})`,
);

ok(out.uniInline.uni > 0, 'the unified arm draws on the unified stream');
ok(out.uniInline.cyan && !out.uniInline.magenta, 'unified: CYAN covers MAGENTA');
ok(
  out.uniInlineHidden.magenta && !out.uniInlineHidden.cyan,
  'unified: hiding CYAN shows the inline-culled MAGENTA',
);
ok(
  out.uniLateHidden.blue && !out.uniLateHidden.red,
  'unified: hiding RED shows the late-culled BLUE',
);

if (fail) {
  console.log(`\nOCCLUSION-CULL-BATCH FAIL (${fail})`);
  process.exit(1);
}
console.log('\nOCCLUSION-CULL-BATCH PASS');
