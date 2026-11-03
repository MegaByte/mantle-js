// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// cpatchMorphUnplannedRowsRenderSmoke -- a morph pinned to route 'cpatch' draws every glyph, including the ones CPatch does not plan.
//
// CPatch plans a morph row only when both poses are one contour; a glyph with a counter (e, q) or a second piece (i) stays off the plan
// and draws its cover quad (Slug) in the same unified stream as the posed CPatch meshes. awaitLbReady(morph) also builds the Loop-Blinn
// pair meshes for the bundle, and the row count that picks the fill program must not read those pair meshes: it would see a mesh on every
// row, compile the program without the cover kernel, and the unplanned glyphs would paint nothing while the engine counter said CPatch drew.
//
// Six glyphs of real text (T h e q c i, a font's quadratics) morph under a scale and a shift. Corner marks pin the content box, so the
// morph and a static document of the same pose are framed alike. Each pose (t = 0.25, 0.5, 0.75) at two canvas sizes is drawn by a
// renderer pinned to CPatch, once after awaitLbReady and once without it, and compared with a Slug-pinned static document of that pose:
// at most BAR px may differ by more than 64/255, the ink must match within 1%, CPatch must draw, and the decline must be on record:
// the engine ledger's declines.cpatch.unsupported for the frame, and per row the plan's reason and the bundle's cause array
// (_lbSlugWhy, the one both Loop-Blinn build paths fill) marking exactly the unplanned rows as declined. A control of the one-contour
// glyphs alone, every row planned, must record no decline at all.
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync } from 'fs';
import { launchBrowser } from './_launch.mjs';
import { openReady } from './_pageReady.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TS = [0.25, 0.5, 0.75],
  BAR = 12;
const SIZES = [
  [576, 208],
  [1728, 624],
];
const GLYPHS = [
  'M0.57373 0.36621 L0.34521 0.36621 L0.34521 1 L0.25195 1 L0.25195 0.36621 L0.02393 0.36621 L0.02393 0.28906 L0.57373 0.28906 L0.57373 0.36621 Z',
  'M0.75537 0.53564 Q0.81543 0.46191 0.91162 0.46191 Q1.0791 0.46191 1.08057 0.65088 L1.08057 1 L0.99023 1 L0.99023 0.65039 Q0.98975 0.59326 0.96411 0.56592 Q0.93848 0.53857 0.88428 0.53857 Q0.84033 0.53857 0.80713 0.56201 Q0.77393 0.58545 0.75537 0.62354 L0.75537 1 L0.66504 1 L0.66504 0.25 L0.75537 0.25 L0.75537 0.53564 Z',
  'M1.43506 1.00977 Q1.32764 1.00977 1.26025 0.93921 Q1.19287 0.86865 1.19287 0.75049 L1.19287 0.73389 Q1.19287 0.65527 1.2229 0.59351 Q1.25293 0.53174 1.30688 0.49683 Q1.36084 0.46191 1.42383 0.46191 Q1.52686 0.46191 1.58398 0.52979 Q1.64111 0.59766 1.64111 0.72412 L1.64111 0.76172 L1.2832 0.76172 Q1.28516 0.83984 1.32886 0.88794 Q1.37256 0.93604 1.43994 0.93604 Q1.48779 0.93604 1.521 0.9165 Q1.5542 0.89697 1.5791 0.86475 L1.63428 0.90771 Q1.56787 1.00977 1.43506 1.00977 Z M1.42383 0.53613 Q1.36914 0.53613 1.33203 0.57593 Q1.29492 0.61572 1.28613 0.6875 L1.55078 0.6875 L1.55078 0.68066 Q1.54688 0.61182 1.51367 0.57397 Q1.48047 0.53613 1.42383 0.53613 Z',
  'M1.97119 0.73145 Q1.97119 0.60693 2.02832 0.53442 Q2.08545 0.46191 2.18164 0.46191 Q2.27539 0.46191 2.32959 0.5249 L2.3335 0.47168 L2.4165 0.47168 L2.4165 1.20313 L2.32617 1.20313 L2.32617 0.95117 Q2.27148 1.00977 2.18066 1.00977 Q2.08496 1.00977 2.02808 0.9353 Q1.97119 0.86084 1.97119 0.73779 L1.97119 0.73145 Z M2.06152 0.7417 Q2.06152 0.83252 2.09985 0.88428 Q2.13818 0.93604 2.20313 0.93604 Q2.28369 0.93604 2.32617 0.86475 L2.32617 0.60596 Q2.2832 0.53613 2.2041 0.53613 Q2.13867 0.53613 2.1001 0.58813 Q2.06152 0.64014 2.06152 0.7417 Z',
  'M2.8877 0.94775 Q2.83496 1.00977 2.73291 1.00977 Q2.64844 1.00977 2.60425 0.96069 Q2.56006 0.91162 2.55957 0.81543 L2.55957 0.47168 L2.6499 0.47168 L2.6499 0.81299 Q2.6499 0.93311 2.74756 0.93311 Q2.85107 0.93311 2.88525 0.85596 L2.88525 0.47168 L2.97559 0.47168 L2.97559 1 L2.88965 1 L2.8877 0.94775 Z',
  'M3.21094 1 L3.12061 1 L3.12061 0.47168 L3.21094 0.47168 L3.21094 1 Z M3.11328 0.33154 Q3.11328 0.30957 3.12671 0.29443 Q3.14014 0.2793 3.1665 0.2793 Q3.19287 0.2793 3.20654 0.29443 Q3.22021 0.30957 3.22021 0.33154 Q3.22021 0.35352 3.20654 0.36816 Q3.19287 0.38281 3.1665 0.38281 Q3.14014 0.38281 3.12671 0.36816 Q3.11328 0.35352 3.11328 0.33154 Z',
];
// Rows 2, 3 and 5 (e, q, i) have two contours; 0, 1 and 4 (T, h, c) have one. Rows 6 and 7 are the corner marks.
const MULTI = [2, 3, 5];
const M = [1.03, 0, 0, 1.03, 0.12, 0.04];
const VB = '-0.15 0.1 3.6 1.3';
const MARKS = '<path d="M-0.15 0.1h0.02v0.02h-0.02Z"/><path d="M3.43 1.38h0.02v0.02h-0.02Z"/>';
const bodyOf = (rows) => rows.map((s) => `<path d="${GLYPHS[s]}"/>`).join('');
const doc = (m, rows = GLYPHS.map((_, s) => s)) => {
  const body = bodyOf(rows);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${VB}" fill="#111">${m ? `<g transform="matrix(${m.join(' ')})">${body}</g>` : body}${MARKS}</svg>`;
};
// The control: only the one-contour glyphs (T h c), every row planned, so CPatch draws all of them and no decline may be recorded.
const PLANNED = GLYPHS.map((_, s) => s).filter((s) => !MULTI.includes(s));
// Control points lerp linearly, so pose t is the source under (1-t)I + tM.
const poseOf = (t) => [1 + (M[0] - 1) * t, 0, 0, 1 + (M[3] - 1) * t, M[4] * t, M[5] * t];
const A = doc(null),
  B = doc(M);

const HTML = `<!DOCTYPE html><html><body style="margin:0"><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
async function side(W, H, route) {
  const c = document.createElement('canvas'); c.width = W; c.height = H; document.body.appendChild(c);
  const gl = c.getContext('webgl2', { antialias: false, premultipliedAlpha: true, preserveDrawingBuffer: true });
  const R = createRenderer(gl, shaders, route === 'cpatch' ? { cpatchFill: true } : {});
  if (R.ready) await R.ready;
  R.setViewport(W, H);
  R.setFillEngine({ route, kernel: 'slug' });
  return { c, gl, R, W, H };
}
function draw(S, target) {
  const before = Object.assign({}, (S.R.debugStats.engines || {}).draws || {});
  S.R.beginFrame([1, 1, 1, 1]); S.R.drawBundle(target); S.R.endFrame();
  const after = (S.R.debugStats.engines || {}).draws || {}, drew = {};
  for (const k of Object.keys(after)) { const n = (after[k] | 0) - (before[k] | 0); if (n) drew[k] = n; }
  const px = new Uint8Array(S.W * S.H * 4);
  S.gl.readPixels(0, 0, S.W, S.H, S.gl.RGBA, S.gl.UNSIGNED_BYTE, px);
  return { px, drew };
}
function close(S) { try { S.R.dispose(); } catch {} S.gl.getExtension('WEBGL_lose_context')?.loseContext(); S.c.remove(); }
window.__run = async (W, H, a, b, poses, ts, lbReady) => {
  const S = await side(W, H, 'cpatch');
  const m = createShapeMorph(S.gl, createBundle(S.gl, await importSvg(a)), createBundle(S.gl, await importSvg(b)));
  const out = [];
  for (let k = 0; k < ts.length; k++) {
    m.setT(ts[k]);
    draw(S, m);
    const ready = await S.R.awaitEngine(m, 'cpatch');
    if (lbReady) await S.R.awaitLbReady(m, 20000);
    S.R.prewarmBundle(m);
    if (S.R.precompileFills) S.R.precompileFills();
    draw(S, m);
    const got = draw(S, m);
    const declines = ((S.R.debugStats.engines || {}).declines || {}).cpatch || {};
    const bb = m.bundle || m;
    const ref = await side(W, H, 'none');
    const sb = createBundle(ref.gl, await importSvg(poses[k]));
    draw(ref, sb);
    const want = draw(ref, sb);
    close(ref);
    const causes = bb._lbSlugWhy ? Array.from(bb._lbSlugWhy) : null;
    // compared here: pixels off the static pose by more than 64/255 on a color channel, and each side's ink
    let off = 0, inkA = 0, inkB = 0;
    for (let i = 0; i < got.px.length; i += 4) {
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(got.px[i + c] - want.px[i + c]));
      if (d > 64) off++;
      if (got.px[i] < 250) inkA++;
      if (want.px[i] < 250) inkB++;
    }
    out.push({ t: ts[k], ready, drew: got.drew, unsupported: declines.unsupported | 0,
      declinedRows: causes ? causes.map((w, s) => (w === 1 ? s : -1)).filter((s) => s >= 0).join(',') : null,
      rowWhy: bb._cpatchMorphRowWhy || null, off, inkA, inkB });
  }
  close(S);
  return out;
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((req, res) => {
  try {
    const u = req.url.split('?')[0];
    if (u === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(u);
    res.writeHead(200, { 'content-type': p.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let failures = 0;
const ok = (m) => console.log('ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL: ' + m);
};
const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => fail('page: ' + e.message));
try {
  await openReady(page, 'http://127.0.0.1:' + server.address().port + '/', {
    name: 'cpatchMorphUnplannedRowsRenderSmoke',
  });
  const CASES = [];
  for (const [W, H] of SIZES)
    for (const lbReady of [true, false])
      CASES.push({ set: 'mixed', rows: undefined, want: MULTI.join(','), W, H, lbReady });
  for (const lbReady of [true, false])
    CASES.push({
      set: 'all planned',
      rows: PLANNED,
      want: '',
      W: SIZES[0][0],
      H: SIZES[0][1],
      lbReady,
    });
  for (const { set, rows, want, W, H, lbReady } of CASES) {
    const poses = TS.map((t) => doc(poseOf(t), rows));
    const res = await page.evaluate(
      (w, h, a, b, p, ts, lr) => window.__run(w, h, a, b, p, ts, lr),
      W,
      H,
      doc(null, rows),
      doc(M, rows),
      poses,
      TS,
      lbReady,
    );
    for (const r of res) {
      const { off, inkA, inkB } = r;
      const unplanned = r.rowWhy
        ? Object.keys(r.rowWhy)
            .map(Number)
            .sort((x, y) => x - y)
            .join(',')
        : '';
      const tag = `${set} ${W}x${H} ${lbReady ? 'after awaitLbReady' : 'no awaitLbReady'} t=${r.t}: ${off} px off the static pose by >64/255, ink ${inkA} vs ${inkB}, drew ${JSON.stringify(r.drew)}, ledger declines.cpatch.unsupported ${r.unsupported}, declined rows [${r.declinedRows}], unplanned [${unplanned}]`;
      if (!r.ready) fail(tag + ' (awaitEngine said CPatch cannot draw)');
      else if (!r.drew.cpatch) fail(tag + ' (CPatch did not draw)');
      else if (off > BAR || Math.abs(inkA - inkB) > 0.01 * Math.max(inkA, inkB, 1))
        fail(tag + ' (glyphs missing or misplaced)');
      else if (
        unplanned !== want ||
        r.declinedRows !== want ||
        (want ? !(r.unsupported > 0) : r.unsupported !== 0)
      )
        fail(
          tag +
            (want
              ? ' (the decline of the unplanned glyphs is not on record)'
              : ' (a decline is recorded where every row is planned)'),
        );
      else ok(tag);
    }
  }
} finally {
  await browser.close();
  server.close();
}
if (failures) {
  console.error(failures + ' failure(s)');
  process.exit(1);
}
console.log('cpatchMorphUnplannedRowsRenderSmoke ok');
