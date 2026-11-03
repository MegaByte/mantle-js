// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// mixedHardFillSmoke — per-row hard fill (MANTLE_HARD_MIXED) is output-identical
// and actually engages.
//
// A fill whose edge is hidden by a later opaque stroke does not need AA. That is
// proven per shape; ANDed across the whole asset ("No-AA eligibility is
// bundle-wide because one fill program draws every row") ONE uncovered fill
// anywhere would send every shape back to AA (on the tiger, 65 of 226 fills
// qualify).
//
// The fill shader has a per-row branch for this (MANTLE_HARD_MIXED, bits 15-16
// of flagsShape: 2 = hard-band, 3 = hard-tree, else AA), and JS sets the bits and
// pushes the define. This drives it.
//
// Three assertions, and the first two are what stop it being vacuous:
//
//   1. It ENGAGES on a mixed asset (debugStats.autoEngine reports hard-mixed).
//   2. It does NOT engage when the covering stroke is a hairline — the proof
//      needs the stroke >= ~2px ON SCREEN, so eligibility by shape is not
//      eligibility in fact.
//   3. Where it engages the output is BYTE-IDENTICAL to the same AA kernel with
//      the route unavailable.
//
// The control clears only the GPU metadata hard-fill bits while retaining the
// same actual warmed program. An aacFill:true renderer comparison would also
// change optional-code presence and pair-band specialization, producing a
// one-byte difference on an uncovered AAC shape. Program identity and real
// hard rows are asserted; the byte-identity bar remains zero.
//
// NOTE: createRenderer returns a FACADE, not the renderer's internal object.
// Reading `R._autoEngine` off it yields undefined, and a `|| 'slug'` fallback
// then reports "slug" for every scene however the selector actually chose.
// debugStats is the accessor.
import { readFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let failures = 0;
const ok = (m) => console.log('  ok ' + m);
const fail = (m) => {
  failures++;
  console.error('FAIL ' + m);
};

const blob = (cx, cy, r) =>
  `M${cx - r} ${cy} C${cx - r} ${cy - r} ${cx + r} ${cy - r} ${cx + r} ${cy}` +
  ` C${cx + r} ${cy + r} ${cx - r} ${cy + r} ${cx - r} ${cy}Z`;
const covered = (sw, n) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<path d="${blob(20 + (i % 3) * 30, 25 + ((i / 3) | 0) * 45, 13)}" fill="#c0392b" ` +
      `stroke="#1a1a1a" stroke-width="${sw}" stroke-linejoin="round"/>`,
  ).join('');
// Five stroke-covered fills plus one bare fill: bundle-wide eligibility is false,
// per-row eligibility is true for five of them. This is the case bundle-wide eligibility loses.
const MIXED = covered(4, 5) + '<path d="' + blob(80, 70, 13) + '" fill="#2980b9"/>';
// Same shapes, hairline stroke: eligible by shape, too thin to hide anything.
const HAIR = covered(0.2, 5) + '<path d="' + blob(80, 70, 13) + '" fill="#2980b9"/>';

const HTML = `<!DOCTYPE html><html><body><canvas id="c"></canvas>
<script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { noteExternalGlWrite } from '/src/core/glEpoch.js';
const cv = document.getElementById('c');
const gl = cv.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, stencil: true, depth: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);

window.__run = async (inner, S) => {
  const sec = await importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' + inner + '</svg>');
  cv.width = S; cv.height = S;
  const b = createBundle(gl, sec);
  const grab = (R) => {
    R.setViewport(S, S);
    R.beginFrame([1, 1, 1, 1]); R.drawBundle(b); R.endFrame();
    const px = new Uint8Array(S * S * 4);
    gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  // 'auto' is what turns the engine selector on at all; every no-AA route is
  // inert without it.
  const R = createRenderer(gl, shaders, { aacFill: 'auto' });
  R.setLoopBlinnFill('off');R.prewarmBundle(b);R.precompileFills();
  for (let i = 0; i < 6; i++) grab(R);           // let lazy variants finish linking
  const got = grab(R);
  const engine = (R.debugStats || {}).autoEngine || 'none';
  // Hold the shader, resources, draw layout and optional-code presence fixed.
  // Clear only the hard-fill row bits on the GPU. The CPU metadata stays intact
  // so variant selection still requests the same mixed program for the control.
  const prog=gl.getParameter(gl.CURRENT_PROGRAM);
  const mixedProgram=gl.getAttachedShaders(prog).some(sh=>/^#define MANTLE_HARD_MIXED$/m.test(gl.getShaderSource(sh)));
  const meta=new Float32Array(b.metaFloats),stride=b.metaFloatsPerShape;
  if(stride!==48)throw Error('Unexpected meta layout for flag control');
  let hardRows=0;
  for(let i=0;i<b.numShapes;i++) {
    const at=i*stride+27,flags=Math.round(meta[at]);
    if(((flags>>15)&3)!==0)hardRows++;
    meta[at]=flags&~(3<<15);
  }
  const upload=(data)=>{
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,b.metaTex);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,12,b.numShapes,gl.RGBA,gl.FLOAT,data);
    noteExternalGlWrite();
  };
  upload(meta);const ref=grab(R);
  const sameProgram=gl.getParameter(gl.CURRENT_PROGRAM)===prog;
  upload(b.metaFloats);
  let maxDiff = 0, nDiff = 0, ink = 0;
  for (let i = 0; i < got.length; i++) {
    const d = Math.abs(got[i] - ref[i]);
    if (d > maxDiff) maxDiff = d;
    if (d) nDiff++;
    if ((i & 3) === 3 && ref[i] !== 0) ink++;
  }
  R.dispose(); b.dispose();
  return { engine, maxDiff, nDiff, ink, mixedProgram,sameProgram,hardRows,noAaMixed: !!sec.noAaMixed, noAaFill: !!sec.noAaFill };
};
window.__ready = true;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const p = decodeURIComponent(q.url.split('?')[0]);
    const mime = /\.(js|mjs)$/.test(p)
      ? 'text/javascript'
      : p.endsWith('.glsl')
        ? 'text/plain'
        : 'application/octet-stream';
    const b = readFileSync(path.join(ROOT, p));
    res.writeHead(200, { 'content-type': mime + '; charset=utf-8' });
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
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('  [page-err]', e.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`, {
    waitUntil: 'load',
    timeout: 30000,
  });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000, polling: 100 });

  const results = [];
  for (const S of [256, 512, 1024]) {
    results.push([S, await page.evaluate((i, s) => window.__run(i, s), MIXED, S)]);
  }
  const hair = await page.evaluate((i, s) => window.__run(i, s), HAIR, 256);

  for (const [S, r] of results) {
    console.log(
      `   ${String(S).padStart(4)}px  engine ${r.engine.padEnd(16)} maxDiff ${r.maxDiff}` +
        `  nDiff ${r.nDiff}  ink ${r.ink}  [noAaMixed=${r.noAaMixed}, noAaFill=${r.noAaFill}]`,
    );
  }
  console.log(`   hairline 256px  engine ${hair.engine}`);

  const engaged = results.filter(([, r]) => /hard-mixed/.test(r.engine));
  if (!results.every(([, r]) => r.ink > 0)) {
    fail('nothing rendered — the comparison would be two blank canvases');
  } else if (engaged.length === 0) {
    fail(
      'the per-row hard route never engaged on a mixed asset, so byte-identity here ' +
        'proves nothing. Check the importer stamps flagsShape bits 15-16 and that ' +
        'fillPass pushes MANTLE_HARD_MIXED.',
    );
  } else {
    ok(`per-row hard engaged at ${engaged.length}/${results.length} sizes (non-vacuous)`);
    if (!engaged.every(([, r]) => r.mixedProgram && r.sameProgram && r.hardRows > 0)) {
      fail('control did not toggle real hard rows in the same actual mixed shader');
    }
    const bad = results.filter(([, r]) => /hard-mixed/.test(r.engine) && r.maxDiff !== 0);
    if (bad.length === 0) {
      ok('output is byte-identical to the same AA kernel without the per-row route');
    } else {
      fail(
        `per-row hard changed pixels at ${bad.map(([S]) => S + 'px').join(', ')} ` +
          `(maxDiff ${bad.map(([, r]) => r.maxDiff).join('/')}). The covering stroke is ` +
          'not hiding the fill edge — the eligibility proof is wrong, not the shader.',
      );
    }
    if (/hard-mixed/.test(hair.engine)) {
      fail(
        'a hairline stroke engaged the per-row route; it cannot hide a fill edge, so ' +
          'the draw-time >= 2px screen-width gate is not being applied',
      );
    } else {
      ok(`hairline strokes correctly stay on AA (engine ${hair.engine})`);
    }
  }
} catch (e) {
  fail('drive failed: ' + e.message);
}

await browser.close();
server.close();
console.log();
console.log(failures === 0 ? 'MIXED-HARD-FILL PASS' : `MIXED-HARD-FILL FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
