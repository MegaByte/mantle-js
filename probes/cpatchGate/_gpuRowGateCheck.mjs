// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _gpuRowGateCheck — the GPU half of the CPatch hull-row gate check: render the assets whose hull-row
// set the gate moves, without and with it, and count the pixels that differ.
//
// The predictions in this directory come from the CPU model (probes/cpatchGate/_rowGateSpill.mjs);
// this file confirms them on a real GPU.
//
// HOW TO RUN IT (two trees, one diff):
//
//   GPU=1 node probes/cpatchGate/_gpuRowGateCheck.mjs --save head
//   git checkout <BASE> -- src/renderer/cpatchConvert.js src/renderer/cpatchPack.js
//   GPU=1 node probes/cpatchGate/_gpuRowGateCheck.mjs --save base
//   git checkout HEAD -- src/renderer/cpatchConvert.js src/renderer/cpatchPack.js
//   node probes/cpatchGate/_gpuRowGateCheck.mjs --diff base head
//
// CHOOSE A BASE WHOSE DECOMPOSITION IS BYTE-IDENTICAL to the tree under test, so a diff against it
// isolates the row set by construction and nothing else can creep in. A base whose search differs
// too (for example one where the monotone leak ask also reaches the search) scores both changes at
// once and reads far above the prediction.
//
// Name BASE by sha rather than by a branch, which moves.
//
// --save writes probes/cpatchGate/out/<asset>.<label>.bin (raw RGBA) and out/<label>.json (the
// per-asset stats). --diff reads two of those and prints, per asset, how many pixels differ, by
// how much, and whether the direction matches the prediction. The dumps are gitignored noise --
// delete out/ when finished.
//
// THE ENGINE IS PINNED, AND THE PIN IS CHECKED. cpatchFill:true is a request and
// setFillEngine({route:'cpatch'}) is a route, not a guarantee: a bundle whose variant is still
// linking, or whose shapes CPatch declined, renders on some other engine at a correct picture and
// reads as a triumph. Every row asserts debugStats.engines.draws.cpatch > 0 and reports the whole
// engine ledger, and a run with no CPatch draw FAILS rather than reporting a clean diff.
//
// WHAT TO EXPECT (predictions.json carries the same numbers machine-readably). The change only ever
// ADDS fencing rows -- across the whole corpus not one patch loses the rows a flat bar would give
// it, and every shape's vertex count is unchanged -- so every pixel that moves must move the same
// way: ink a patch was painting OUTSIDE its own shape stops being painted. Per asset, at 512x512,
// from the CPU model at the asset's own raster:
//
//   tiger.svg            288 patches in 122 shapes gain rows: they hold 123.2 px^2 of ink the
//                        shapes do NOT have and orphan 4.4 px^2 of interior they do, 28:1 in
//                        favor. Expect order 150-400 pixels, and the frame CLOSER to Slug and
//                        AAC, not further. This asset carries the case.
//   lbMemBudget__SVG     76 patches in 44 shapes: 15.3 px^2 held outside against 0.4 orphaned,
//                        38:1. Expect order 15-60 pixels, predominantly darker.
//   engineDeclineIsolation__STAR
//                        86 patches, and this one gets slightly WORSE: 0.2 px^2 held outside
//                        against 2.6 px^2 orphaned, 13:1 against. Expect order 80-150 pixels and a
//                        small rise against the references. It is the cleanest test of what a
//                        fence COSTS, because it has no hull rows at all without the gate.
//
// A HULL ROW IS NOT A FREE FENCE, and an earlier version of this header said it was ("a fence can
// only take ink away, so it can only be better"). It takes ink away INSIDE the shape too, wherever
// the kernel's redundancy test does not recognize the plane as the patch's own edge -- that is the
// star's whole cost. What the row set growing does guarantee is that no pixel GAINS a shape's
// color outside that shape; if one does, the superset property is broken somewhere.
//
// AND THE OTHER HALF OF THE CHECK IS NOT HERE. This counts pixels that MOVED; it does not say the
// new ones are right. probes/cpatchGate/_rowGateAaRef.mjs does, on the CPU, against an exact
// box-filter reference of the contour itself. Over the 175 tiger shapes either change touches the
// coverage error is 1577.3 px^2 with both fixes out and 1486.0 here (-5.8%); on the star it is
// 61.9 and 64.2 (+2.3), which the GPU independently measured as +3.6 against Slug and +3.0
// against AAC.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../../test/_launch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(HERE, 'out');
const SIZE = +(process.env.SIZE || 512);
const ASSETS = [
  ['tiger', '../MantleSamples/Assets/Mantle/tiger.svg'],
  ['lbMemBudget', 'examples/smoke/lbMemBudget__SVG.svg'],
  ['star', 'examples/smoke/engineDeclineIsolation__STAR.svg'],
];

// ---------------------------------------------------------------- diff mode
if (process.argv.includes('--diff')) {
  const i = process.argv.indexOf('--diff');
  const [A, B] = [process.argv[i + 1], process.argv[i + 2]];
  if (!A || !B) {
    console.error('usage: --diff <labelA> <labelB>');
    process.exit(2);
  }
  const sa = JSON.parse(readFileSync(path.join(OUT, A + '.json'), 'utf8'));
  const sb = JSON.parse(readFileSync(path.join(OUT, B + '.json'), 'utf8'));
  const pred = JSON.parse(readFileSync(path.join(HERE, 'predictions.json'), 'utf8'));
  let bad = 0;
  for (const [name] of ASSETS) {
    const ra = sa.rows.find((r) => r.name === name),
      rb = sb.rows.find((r) => r.name === name);
    if (!ra || !rb) {
      console.log(`  ${name}: missing in one dump`);
      bad++;
      continue;
    }
    const pa = readFileSync(path.join(OUT, `${name}.${A}.bin`));
    const pb = readFileSync(path.join(OUT, `${name}.${B}.bin`));
    if (pa.length !== pb.length) {
      console.log(`  ${name}: different sizes`);
      bad++;
      continue;
    }
    let n = 0,
      maxd = 0,
      lighter = 0,
      darker = 0;
    for (let k = 0; k < pa.length; k += 4) {
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(pa[k + c] - pb[k + c]));
      if (!d) continue;
      n++;
      if (d > maxd) maxd = d;
      // A pixel that LOST a shape's color reads as the background (or the shape behind it), which
      // is the direction the fix predicts. Summed luminance is a crude but sufficient sign.
      const la = pa[k] + pa[k + 1] + pa[k + 2],
        lb = pb[k] + pb[k + 1] + pb[k + 2];
      if (lb > la) lighter++;
      else darker++;
    }
    const p = pred[name] || {};
    const ok = n <= (p.maxPixels != null ? p.maxPixels : Infinity);
    if (!ok) bad++;
    console.log(
      `  ${name.padEnd(14)} ${String(n).padStart(6)} px differ (max channel ${maxd}), ${lighter} lighter / ${darker} darker in ${B}` +
        `   predicted <= ${p.maxPixels}  ${ok ? 'ok' : 'OVER'}`,
    );
    console.log(
      `                 texels ${ra.texels} -> ${rb.texels}, cpatch draws ${ra.drew.cpatch | 0} -> ${rb.drew.cpatch | 0}`,
    );
  }
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------- render mode
const LABEL = (() => {
  const i = process.argv.indexOf('--save');
  return i >= 0 ? process.argv[i + 1] || 'run' : null;
})();
if (!LABEL) {
  console.error('usage: --save <label> | --diff <labelA> <labelB>');
  process.exit(2);
}

const SVGS = {};
for (const [name, rel] of ASSETS) SVGS[name] = readFileSync(path.resolve(ROOT, rel), 'utf8');

const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const SVGS = ${JSON.stringify(SVGS)};
const SIZE = ${SIZE};
// The packed plane is the witness that the two trees differ at all: a frame that is identical
// because nothing changed is not evidence about the gate.
globalThis.__MANTLE_DEBUG__ = true;   // __CP_KEEP_PLANE is a test hook, read only under it
globalThis.__CP_KEEP_PLANE = true;
window.__run = async () => {
  const out = [];
  for (const [name, SVG] of Object.entries(SVGS)) {
    const c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE; document.body.appendChild(c);
    const gl = c.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, depth: true, stencil: true });
    const r = createRenderer(gl, shaders, { precompileFillsBudgetMs: 5000, cpatchFill: true });
    await r.ready;
    r.setViewport(SIZE, SIZE);
    r.setFillEngine({ route: 'cpatch' });
    const b = createBundle(gl, await importSvg(SVG, {}));
    if (r.awaitEngine) await r.awaitEngine(b, 'cpatch', 60000);
    // Warm frames: a variant still linking reports the fallback's draws and the fallback's pixels.
    for (let i = 0; i < 3; i++) { r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame(); }
    const d0 = r.debugStats, e0 = Object.assign({}, (d0.engines || {}).draws || {});
    r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame();
    const d = r.debugStats, E = d.engines || { draws: {} };
    const drew = {};
    for (const k of Object.keys(E.draws || {})) { const n = (E.draws[k] | 0) - (e0[k] | 0); if (n) drew[k] = n; }
    const px = new Uint8Array(SIZE * SIZE * 4);
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let ink = 0, s = '';
    for (let i = 0; i < px.length; i += 4) if (px[i] || px[i + 1] || px[i + 2]) ink++;
    for (let i = 0; i < px.length; i += 8192) s += String.fromCharCode.apply(null, px.subarray(i, Math.min(i + 8192, px.length)));
    out.push({ name, shapes: b.numShapes | 0, cpatchBuilt: b._cpatchBuilt | 0, cells: b._cpatchCells | 0,
               dropped: b._cpatchDropped | 0, texels: (b._cpatchPlane ? b._cpatchPlane.length : -1),
               drew, ink, b64: btoa(s) });
  }
  return out;
};
window.__ready = 1;
</script></body></html>`;

const server = http.createServer((q, res) => {
  try {
    if (q.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(HTML);
      return;
    }
    const pp = decodeURIComponent(q.url.split('?')[0]);
    res.writeHead(200, { 'content-type': pp.endsWith('.glsl') ? 'text/plain' : 'text/javascript' });
    res.end(readFileSync(path.join(ROOT, pp)));
  } catch {
    if (!res.headersSent) res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const br = await launchBrowser(
  process.env.GPU === '1'
    ? { headless: 'new', args: ['--no-sandbox', '--use-angle=metal', '--enable-gpu'] }
    : { headless: 'new', args: ['--no-sandbox'] },
);
const pg = await br.newPage();
pg.on('pageerror', (e) => console.error(' [err]', String(e.message).slice(0, 200)));
pg.on('console', (m) => {
  const t = m.text();
  if (/link failed|not compiled|ERROR/i.test(t)) console.error(' [console]', t.slice(0, 300));
});
await pg.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load', timeout: 90000 });
await pg.waitForFunction(() => window.__ready === 1, { timeout: 180000, polling: 100 });
const rows = await pg.evaluate(() => window.__run());
await br.close();
server.close();

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
let bad = 0;
console.log('\n  asset          shapes  patches   texels   engines drew            ink');
for (const r of rows) {
  const drew =
    Object.entries(r.drew)
      .map(([k, v]) => k + ':' + v)
      .join(' ') || '-';
  console.log(
    '  ' +
      r.name.padEnd(14) +
      String(r.shapes).padStart(5) +
      String(r.cpatchBuilt).padStart(9) +
      String(r.texels).padStart(9) +
      '   ' +
      drew.padEnd(22) +
      String(r.ink).padStart(8),
  );
  if (!(r.drew.cpatch > 0)) {
    console.log('    FAIL: no draw attributed to cpatch -- the route did not take');
    bad++;
  }
  if (!r.ink) {
    console.log('    FAIL: painted nothing');
    bad++;
  }
  writeFileSync(path.join(OUT, `${r.name}.${LABEL}.bin`), Buffer.from(r.b64, 'base64'));
  delete r.b64;
}
writeFileSync(
  path.join(OUT, LABEL + '.json'),
  JSON.stringify({ label: LABEL, size: SIZE, rows }, null, 1),
);
console.log(
  `\n  wrote ${OUT}/*.${LABEL}.bin and ${LABEL}.json` + (bad ? `  -- ${bad} FAILURE(S)` : ''),
);
process.exit(bad ? 1 : 0);
