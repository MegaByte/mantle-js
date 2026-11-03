// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _cpatchMorphRender — does a CPatch MORPH paint, at each t, what Slug paints?
//
// The static CPatch route is verified (_cpatchRouteRender). A morph is the harder half: the
// decomposition is built for one pose and has to stay correct as the geometry moves, which is
// what cpatchMorphCert certifies and cpatchMorphBuild turns into frames.
//
// Compared against a SLUG morph of the same pair, at several t. Ink alone is not enough — a
// route that silently falls back to another engine also matches Slug exactly, which is the
// failure this project has hit repeatedly — so the CPatch arm also reports whether the CPatch
// route was actually entered (built shapes, kind mask) and what a frame costs.
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = +(process.env.N || 320);
const TS = (process.env.TS || '0,0.25,0.5,0.75,1').split(',').map(Number);
// Two poses of one blob: same curve count and correspondence, which is what a morph needs.
const A = 'M20 4 C31 4 36 9 36 20 C36 31 31 36 20 36 C9 36 4 31 4 20 C4 9 9 4 20 4 Z';
// NEAR by default: the wide pair below plans in 40 segments and about 75 seconds, which no page
// timeout survives. PAIR=wide asks for it anyway.
const B =
  process.env.PAIR === 'wide'
    ? 'M20 8 C28 2 34 10 33 20 C32 30 28 34 20 33 C11 32 6 28 7 20 C8 10 12 2 20 8 Z'
    : 'M20 5 C30 5 35 10 35 20 C35 30 30 35 20 35 C10 35 5 30 5 20 C5 10 10 5 20 5 Z';
const svg = (d) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><path d="${d}" fill="#fff"/></svg>`;

// DEFINES=MANTLE_CPATCH_DEBUG makes the kernel return full cover-box coverage, which
// separates "these fragments never run" from "the coefficients are wrong" — the only two things
// a blank render can mean once the route is confirmed to draw.
const EXTRA = (process.env.DEFINES || '').split(',').filter(Boolean);
const HTML = `<!DOCTYPE html><html><body><canvas id="c" width="${N}" height="${N}"></canvas>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createShapeMorph, createRenderer, loadShaders } from '/src/index.js';
const S = ${N};
const gl = document.getElementById('c').getContext('webgl2',
  { antialias: false, depth: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
const px = new Uint8Array(S * S * 4);
const shoot = async (mode) => {
  const r = createRenderer(gl, shaders, mode === 'cpatch'
    ? { cpatchFill: true, cpatchOpts: { interiorN: 8, gpuBlend: ${JSON.stringify(process.env.BLEND === '1')}, skipPaintUploads: ${JSON.stringify(process.env.NOUP === '1')} }, aacFill: false, unifiedMorph: true, unifiedFillCurveTex: ${JSON.stringify(process.env.CURVETEX !== '0')}, fillDefines: ${JSON.stringify(EXTRA)} }
    : { aacFill: false });
  r.setLoopBlinnFill(mode === 'slug' ? 'off' : 'on');
  const morph = createShapeMorph(gl, createBundle(gl, await importSvg(${JSON.stringify(svg(A))})),
                                     createBundle(gl, await importSvg(${JSON.stringify(svg(B))})));
  // prepareBundle EVERY FRAME for a morph: it is the public hook the CPatch route hangs off,
  // and a morph re-dirties its geometry on every setT, so a one-time call prepares a pose that
  // is already gone by the next draw.
  const frame = (t) => { morph.setT(t);
    if (r.prepareBundle) { try { r.prepareBundle(morph.bundle || morph); } catch (e) { window.__prepErr = String(e && e.message); } }
    // AFTER prepare, BEFORE draw: separates "prepareBundle never wrote them" from "the draw
    // threw them away", which read identically from the far side of the frame.
    { const bb = morph.bundle || morph;
      window.__afterPrep = (bb._lbMeshes ? bb._lbMeshes.length : -1) + ':' + (bb._lbMeshes && bb._lbMeshes[0] ? bb._lbMeshes[0].vertexCount : 'null'); }
    r.setViewport(S, S);
    r.beginFrame([0, 0, 0, 1]); r.drawBundle(morph, {}); r.endFrame();
    { const bb = morph.bundle || morph;
      window.__afterDraw = (bb._lbMeshes ? bb._lbMeshes.length : -1) + ':' + (bb._lbMeshes && bb._lbMeshes[0] ? bb._lbMeshes[0].vertexCount : 'null'); } };
  // PLAN FIRST, THEN WARM. prepareBundle is what requests the plan, and it needs no draw to do
  // it — so the certificate runs while nothing is rendering, and the warm-up frames below see a
  // bundle that is already CPatch rather than hundreds of frames of another engine first.
  if (mode === 'cpatch') {
    const bb0 = morph.bundle || morph;
    morph.setT(0);
    if (r.prepareBundle) { try { r.prepareBundle(bb0); } catch {} }
    for (let i = 0; i < 1200 && bb0._cpatchMorphPlan === 'pending'; i++) {
      await new Promise((res) => setTimeout(res, 25));
    }
  }
  frame(0);
  if (r.awaitLbReady) { try { await r.awaitLbReady(morph, 20000); } catch {} }
  if (r.precompileFills) { try { r.precompileFills(); } catch {} }
  for (let i = 0; i < 30; i++) {
    frame(0);
    if (r.precompileFills) { try { r.precompileFills(); } catch {} }
    if (((r.debugStats && r.debugStats.unifiedFillDraws) | 0) > 0) break;
    await new Promise((res) => requestAnimationFrame(res));
  }

  const out = [];
  for (const t of ${JSON.stringify(TS)}) {
    const t0 = performance.now();
    frame(t);
    const ms = performance.now() - t0;
    gl.readPixels(0, 0, S, S, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // LUMINANCE, not alpha: the clear is opaque, so every pixel's alpha is 255 and an
    // alpha-based ink reads the whole canvas for both arms — which looks like a perfect match.
    let ink = 0; const bits = new Uint8Array(S * S);
    for (let i = 0; i < S * S; i++) { const v = px[i * 4]; ink += v / 255; bits[i] = v > 127 ? 1 : 0; }
    const b = morph.bundle || morph;
    out.push({ t, ink, ms, bits: Array.from(bits),
               built: b._cpatchBuilt | 0, gate: r._lbClassicLastGate || r._unifiedFillGate || '?',
               meshN: (b._lbMeshes && b._lbMeshes.length) | 0,
               wroteN: b._cpatchMeshN | 0, wroteAt: b._cpatchMeshAt || '-',
               numShapes: b.numShapes | 0,
               // WHERE the cover quads actually are. A blank render with the unconditional
               // kernel is a rasterization question, and the first thing to check is whether the
               // triangles are anywhere near the shape.
               vxy: (b._lbMeshes && b._lbMeshes[0] && b._lbMeshes[0].verts)
                 ? (() => { const V = b._lbMeshes[0].verts, st = 24, out = [];
                     for (let k = 0; k * st < V.length; k++) out.push([+V[k*st].toFixed(1), +V[k*st+1].toFixed(1)]);
                     return out; })() : null,
               meshAt: b._lbMeshes ? b._lbMeshes.map((m, i) => (m ? i : -1)).filter((i) => i >= 0).join('/') : 'none',
               bail: b._cpatchBail || (morph.bundle ? 'wrapped' : 'bare'),
               // PROOF THE ROUTE DREW, not merely that it built. A mesh whose kindMask carries
               // 1<<14 and whose vertex count is the morph packer's six-per-patch is CPatch
               // geometry; matching Slug proves nothing on its own, since a silent fallback to
               // Slug matches Slug exactly.
               kindMask: (b._lbMeshes && b._lbMeshes[0] && b._lbMeshes[0].kindMask) | 0,
               vcount: (b._lbMeshes && b._lbMeshes[0] && b._lbMeshes[0].vertexCount) | 0,
               ufDraws: (r.debugStats && r.debugStats.unifiedFillDraws) | 0,
               hasMorphSrc: !!b._morphSrc, hasCurveTex: !!b.curveTex,
               ranges: b._morphSrc && b._morphSrc.curveRanges ? b._morphSrc.curveRanges.filter(Boolean).length : -1,
               plan: (b._cpatchMorphPlan && b._cpatchMorphPlan !== 'pending') ? b._cpatchMorphPlan.planned : 0,
               planMs: b._cpatchPlanMs | 0,
               segs: (b._cpatchMorphPlan && b._cpatchMorphPlan !== 'pending' && b._cpatchMorphPlan.shapes)
                 ? b._cpatchMorphPlan.shapes.filter(Boolean).map((sh) => sh.plan.length).join(',') : '-',
               curvesAB: (b._cpatchMorphPlan && b._cpatchMorphPlan !== 'pending' && b._cpatchMorphPlan.shapes)
                 ? b._cpatchMorphPlan.shapes.filter(Boolean).map((sh) => sh.A.length + '/' + sh.B.length).join(',') : '-' });
  }
  try { morph.dispose(); } catch {}
  return out;
};
window.__out = { slug: await shoot('slug'), cpatch: await shoot('cpatch') };
window.__out.prepErr = window.__prepErr || null;
window.__out.afterPrep = window.__afterPrep || null;
window.__out.afterDraw = window.__afterDraw || null;
window.__ready = 1;
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }
  try {
    const fs = await import('fs');
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
    const body = fs.readFileSync(p);
    const ext = path.extname(p);
    res.writeHead(200, {
      'Content-Type':
        ext === '.js'
          ? 'text/javascript'
          : ext === '.glsl'
            ? 'text/plain'
            : 'application/octet-stream',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('nope');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--use-angle=metal', '--no-sandbox'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGE ERROR:', e.message));
await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle0' });
await page.waitForFunction('window.__ready === 1', { timeout: 540000 });
const o = await page.evaluate('window.__out');
await browser.close();
server.close();

console.log(`\nCPatch MORPH vs Slug morph, ${N}x${N}\n`);
console.log('    t   |   slug ink |  cpatch ink | ratio |  XOR | frame ms | built | plan | gate');
let bad = 0;
for (let i = 0; i < o.slug.length; i++) {
  const s = o.slug[i],
    c = o.cpatch[i];
  let xor = 0;
  for (let k = 0; k < s.bits.length; k++) if (s.bits[k] !== c.bits[k]) xor++;
  const ratio = c.ink / Math.max(s.ink, 1e-9);
  // A ROUTE THAT never RAN ALSO MATCHES SLUG exactly, because what painted was Slug. `built`
  // is the only column that separates "correct" from "absent", so it gates the verdict.
  // AND THE ROUTE MUST HAVE DRAWN. Correct meshes sitting in the bundle prove the build; only a
  // unified-fill draw proves they reached the screen, and without that the ink match is Slug's.
  // TRIANGLES, not six-per-patch: since the morph frame regained the cell split a patch emits one
  // fan per cell and cells are polygons, so the count is a multiple of 3 and nothing tighter.
  const ran =
    c.built > 0 &&
    (c.kindMask & (1 << 14)) !== 0 &&
    c.vcount % 3 === 0 &&
    c.vcount > 0 &&
    c.ufDraws > 0;
  const ok = ran && c.ink > 0 && ratio > 0.97 && ratio < 1.03;
  if (!ok) bad++;
  console.log(
    `  ${String(s.t).padStart(4)}  | ${s.ink.toFixed(0).padStart(10)} | ${c.ink.toFixed(0).padStart(11)} | ${ratio.toFixed(3)} | ${String(xor).padStart(4)} | ${c.ms.toFixed(1).padStart(8)} | ${String(c.built).padStart(5)} | ${String(c.plan).padStart(4)} | ${c.gate}${ok ? '' : ran ? '  <-- OFF' : '  <-- CPATCH NEVER BUILT'}`,
  );
}
if (o.prepErr) console.log('  prepareBundle threw: ' + o.prepErr);
console.log(
  '  _lbMeshes after prepare: ' +
    o.afterPrep +
    '   after draw: ' +
    o.afterDraw +
    '   (length:mesh0.vertexCount)',
);
for (const c of o.cpatch)
  console.log(
    '   t=' +
      String(c.t).padEnd(5) +
      ' built ' +
      c.built +
      '  kindMask ' +
      c.kindMask +
      '  verts ' +
      c.vcount +
      '  ufDraws ' +
      c.ufDraws +
      '  meshN ' +
      c.meshN +
      ' [' +
      c.meshAt +
      ']  wrote ' +
      c.wroteN +
      ' [' +
      c.wroteAt +
      ']',
  );
console.log(
  '  plan certified off-thread in ' +
    o.cpatch[0].planMs +
    'ms   segments [' +
    o.cpatch[0].segs +
    ']   curves A/B [' +
    o.cpatch[0].curvesAB +
    ']',
);
console.log('  cover quad xy: ' + JSON.stringify(o.cpatch[0].vxy));
console.log(
  '  meshes at draw ' +
    o.cpatch[0].meshN +
    ' non-null [' +
    o.cpatch[0].meshAt +
    ']' +
    '   written ' +
    o.cpatch[0].wroteN +
    ' non-null [' +
    o.cpatch[0].wroteAt +
    ']' +
    '   bundle.numShapes ' +
    o.cpatch[0].numShapes,
);
console.log(
  '  kind mask ' +
    o.cpatch[0].kindMask +
    ' (1<<14 = ' +
    (1 << 14) +
    '), mesh 0 verts ' +
    o.cpatch[0].vcount +
    ' = ' +
    o.cpatch[0].vcount / 3 +
    ' triangles, unified draws ' +
    o.cpatch[0].ufDraws,
);
console.log(
  '\n  diag: ' +
    JSON.stringify({
      bail: o.cpatch[0].bail,
      morphSrc: o.cpatch[0].hasMorphSrc,
      curveTex: o.cpatch[0].hasCurveTex,
      ranges: o.cpatch[0].ranges,
    }),
);
console.log(
  bad
    ? `\n${bad} pose(s) wrong.`
    : '\nthe CPatch morph matches Slug at every sampled pose, in kind 14.',
);
process.exit(bad ? 1 : 0);
