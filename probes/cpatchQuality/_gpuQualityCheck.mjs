// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _gpuQualityCheck — a two-tree CPatch pixel diff: render a fixed asset set with CPatch pinned on two source
// states of the CPatch modules, and count the pixels that differ.
//
// It is written to FAIL when a prediction is wrong rather than to produce a number. The predictions come from
// the CPU -- the kernel model (src/renderer/cpatchCov.js), the exact box-filter reference
// (probes/cpatchGate/_rowGateAaRef.mjs) and the scale-1 mesh count (probes/_cpatchMeshCensus.mjs) -- and
// predictions.json carries them machine-readably (`assets.<name>.maxPixels`).
//
// HOW TO RUN IT (two trees, one diff):
//
//   GPU=1 node probes/cpatchQuality/_gpuQualityCheck.mjs --save head
//   git checkout <BASE> -- src/renderer/cpatchCov.js src/renderer/cpatchConvert.js \
//                          src/renderer/cpatchPack.js src/geom/cpatchGraph.js \
//                          src/renderer/cpatchTrace.js src/renderer/cpatchBuild.js
//   GPU=1 node probes/cpatchQuality/_gpuQualityCheck.mjs --save base
//   git checkout HEAD -- src/renderer/cpatchCov.js src/renderer/cpatchConvert.js \
//                        src/renderer/cpatchPack.js src/geom/cpatchGraph.js \
//                        src/renderer/cpatchTrace.js src/renderer/cpatchBuild.js
//   node probes/cpatchQuality/_gpuQualityCheck.mjs --diff base head
//
// Name BASE by sha rather than by a branch, which moves. --save also runs the BAKE arm on the same tree
// (below), which needs no second tree at all.
//
// THE ENGINE IS PINNED, AND THE PIN IS CHECKED. cpatchFill:true is a request and
// setFillEngine({route:'cpatch'}) is a route, not a guarantee: a bundle whose variant is still
// linking, or whose shapes CPatch declined, renders on some other engine at a correct picture and
// reads as a triumph. Every row asserts debugStats.engines.draws.cpatch > 0 and a run with no
// CPatch draw FAILS rather than reporting a clean diff.
//
// A ZERO PREDICTION IS A CLAIM, not an absence of one: a difference on an asset predicted at zero
// falsifies it. And a change that moves geometry must move `texels` between the two dumps; a diff
// with identical texel counts means the two trees did not differ and the pixel count is not
// evidence about anything.
//
// THE BAKE ARM, on one tree: render each asset normally, then render it again through
// bakeCPatchBundle -> createBundle({cpatchBake}). Both frames must be byte-identical, and the
// bake's replay must report zero MISSES (a contour with no entry re-converts, which is correct and
// slow; the claim is that the frame is the same either way).
//
// THE BAKE ARM SEES WHAT THE CPU CANNOT: the plain arm builds with the WORKER POOL and the bake arm
// turns pooling off, and node has no Worker, so a CPU check's "searched" arm is always the serial
// decomposition. A large contour converts as its count-first pieces on every route
// (cpatchConvert's contourSplit), so the two arms build the same streams;
// test/cpatchPoolSplitParitySmoke.mjs pins that without a GPU, the pool's own code included.
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
  ['tiger', 'examples/tiger.svg'],
  ['lbMemBudget', 'examples/smoke/lbMemBudget__SVG.svg'],
  ['star', 'examples/smoke/engineDeclineIsolation__STAR.svg'],
  ['far', 'examples/smoke/noAaArcRow__FAR.svg'],
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
      const la = pa[k] + pa[k + 1] + pa[k + 2],
        lb = pb[k] + pb[k + 1] + pb[k + 2];
      if (lb > la) lighter++;
      else darker++;
    }
    const p = pred.assets[name] || {};
    const ok = n <= (p.maxPixels != null ? p.maxPixels : Infinity);
    if (!ok) bad++;
    console.log(
      `  ${name.padEnd(14)} ${String(n).padStart(6)} px differ (max channel ${maxd}), ${lighter} lighter / ${darker} darker in ${B}` +
        `   predicted <= ${p.maxPixels}  ${ok ? 'ok' : 'OVER'}`,
    );
    console.log(
      `                 texels ${ra.texels} -> ${rb.texels}, all-seam ${ra.allSeam} -> ${rb.allSeam},` +
        ` cpatch draws ${ra.drew.cpatch | 0} -> ${rb.drew.cpatch | 0}`,
    );
    // THE TREES HAVE TO DIFFER, or the pixel count is not evidence about anything.
    //
    // `texels` was the wrong witness and cost a false FAIL: it is the PLANE TEXTURE's length, a
    // padded allocation (tiger sits at 589824 either way), so 111 fewer vertices do not shrink it.
    // `allSeam` is a count of what converted, and it moved 606 -> 601 on the tree where texels did
    // not move at all. A wire that must change is checked on that.
    if (p.wireMustChange && ra.allSeam === rb.allSeam && ra.texels === rb.texels) {
      console.log(`    FAIL: neither all-seam nor texels moved -- the two dumps are the same tree`);
      bad++;
    }
    if (p.texelsMustMatch && (ra.texels !== rb.texels || ra.allSeam !== rb.allSeam)) {
      console.log(
        `    FAIL: the wire moved (texels ${ra.texels} -> ${rb.texels},` +
          ` all-seam ${ra.allSeam} -> ${rb.allSeam}) and this item predicts no wire change`,
      );
      bad++;
    }
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
for (const [name, rel] of ASSETS) {
  try {
    SVGS[name] = readFileSync(path.resolve(ROOT, rel), 'utf8');
  } catch {
    console.error(`  (skipping ${name}: ${rel} not present)`);
  }
}
if (!Object.keys(SVGS).length) {
  console.error('no assets');
  process.exit(2);
}

const HTML = `<!doctype html><html><body><script type="module">
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
import { bakeCPatchBundle, headlessCPatchBundle } from '/src/renderer/cpatchBuild.js';
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const SVGS = ${JSON.stringify(SVGS)};
const SIZE = ${SIZE};
globalThis.__MANTLE_DEBUG__ = true;   // __CP_KEEP_PLANE is a test hook, read only under it
globalThis.__CP_KEEP_PLANE = true;
const frame = async (SVG, bake) => {
  const c = document.createElement('canvas'); c.width = SIZE; c.height = SIZE; document.body.appendChild(c);
  const gl = c.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, depth: true, stencil: true });
  const r = createRenderer(gl, shaders, { precompileFillsBudgetMs: 5000, cpatchFill: true });
  await r.ready;
  r.setViewport(SIZE, SIZE);
  r.setFillEngine({ route: 'cpatch' });
  const sections = await importSvg(SVG, {});
  const b = createBundle(gl, sections, bake ? { cpatchBake: bake } : {});
  if (r.awaitEngine) await r.awaitEngine(b, 'cpatch', 120000);
  for (let i = 0; i < 3; i++) { r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame(); }
  const e0 = Object.assign({}, ((r.debugStats.engines || {}).draws) || {});
  r.beginFrame([0, 0, 0, 1]); r.drawBundle(b, {}); r.endFrame();
  const E = r.debugStats.engines || { draws: {} };
  const drew = {};
  for (const k of Object.keys(E.draws || {})) { const n = (E.draws[k] | 0) - (e0[k] | 0); if (n) drew[k] = n; }
  const px = new Uint8Array(SIZE * SIZE * 4);
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let ink = 0, s = '';
  for (let i = 0; i < px.length; i += 4) if (px[i] || px[i + 1] || px[i + 2]) ink++;
  for (let i = 0; i < px.length; i += 8192) s += String.fromCharCode.apply(null, px.subarray(i, Math.min(i + 8192, px.length)));
  return { sections, bundle: b, drew, ink, b64: btoa(s),
           texels: (b._cpatchPlane ? b._cpatchPlane.length : -1),
           allSeam: b._cpatchAllSeam | 0, built: b._cpatchBuilt | 0, dropped: b._cpatchDropped | 0 };
};
window.__run = async () => {
  const out = [];
  for (const [name, SVG] of Object.entries(SVGS)) {
    // A THROWAWAY FRAME FIRST. The first frame a page draws of an asset pays that asset's first
    // compiles; without it the A/A below compares a first-compile frame with a warm one and reads the
    // first compile itself. Every arm below is warm: plain, its A/A, and the bake.
    await frame(SVG, null);
    const plain = await frame(SVG, null);
    // THE A/A CONTROL, and it comes FIRST. The bake arm renders in a second canvas with a second
    // GL context; if two plain frames in two contexts already differ, a bake difference smaller
    // than that gap is the harness talking and not the bake.
    let aaDiff = -1;
    {
      const again = await frame(SVG, null);
      const a = atob(plain.b64), c = atob(again.b64);
      aaDiff = 0;
      for (let i = 0; i < Math.min(a.length, c.length); i++) if (a[i] !== c[i]) aaDiff++;
    }
    // THE BAKE ARM, on this tree alone.
    let bakeSame = null, bakeBytes = 0, bakeWhy = null;
    try {
      // RE-IMPORT for the bake. plain.sections has already been through createBundle, which takes
      // ownership of its buffers; handing the same object to the headless baker measures a
      // difference that is the harness and not the bake.
      const fresh = await importSvg(SVG, {});
      const bytes = bakeCPatchBundle(headlessCPatchBundle(fresh), {});
      bakeBytes = bytes.length | 0;
      const viaBake = await frame(SVG, bytes);
      bakeSame = viaBake.b64 === plain.b64 && viaBake.texels === plain.texels;
      if (!bakeSame) {
        let nd = 0;
        const a = atob(plain.b64), c = atob(viaBake.b64);
        for (let i = 0; i < Math.min(a.length, c.length); i++) if (a[i] !== c[i]) nd++;
        bakeWhy = 'texels ' + plain.texels + ' -> ' + viaBake.texels + ', ink ' + plain.ink + ' -> '
          + viaBake.ink + ', sampled bytes differing ' + nd + ' of ' + a.length
          + ', bakeBytes ' + bakeBytes;
      }
    } catch (e) { bakeSame = 'threw: ' + e.message; }
    out.push({ name, shapes: plain.sections.numShapes | 0, cpatchBuilt: plain.built,
               dropped: plain.dropped, allSeam: plain.allSeam, texels: plain.texels,
               drew: plain.drew, ink: plain.ink, bakeBytes, bakeSame, bakeWhy, aaDiff, b64: plain.b64 });
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
await pg.waitForFunction(() => window.__ready === 1, { timeout: 240000, polling: 100 });
const rows = await pg.evaluate(() => window.__run());
await br.close();
server.close();

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
let bad = 0;
console.log(
  '\n  asset          shapes  patches   texels  all-seam   engines drew            ink   bake',
);
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
      String(r.allSeam).padStart(10) +
      '   ' +
      drew.padEnd(22) +
      String(r.ink).padStart(8) +
      '   ' +
      String(r.bakeSame),
  );
  if (!(r.drew.cpatch > 0)) {
    console.log('    FAIL: no draw attributed to cpatch -- the route did not take');
    bad++;
  }
  if (!r.ink) {
    console.log('    FAIL: painted nothing');
    bad++;
  }
  // The bake arm's falsifiable claim, on one tree: a baked build is the same frame as a searched one.
  if (r.bakeSame !== true) {
    console.log(`    bake arm: ${r.bakeSame} -- ${r.bakeWhy || ''}`);
    console.log(`    A/A control (two plain frames, two contexts): ${r.aaDiff} bytes differ`);
    if (r.aaDiff === 0) {
      console.log('    FAIL: a replayed frame is not the searched one');
      bad++;
    } else
      console.log(
        '    NOT A BAKE FAILURE: the harness floor is nonzero, so this gap is not evidence',
      );
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
