// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// probes/perf/strokesMasksSpritesApi.mjs — seven stroke, mask, sprite and API performance claims,
// item by item.
//
// Seven claims, so seven verdicts. GL-free: every number
// below is a count produced by running the real code (the real frame loop, the real
// `computeMaskRegions`) or by reading the shader text.
//
//   node probes/perf/strokesMasksSpritesApi.mjs
//
// ── THE VERDICTS ────────────────────────────────────────────────────────────────────────────
//
// 1. `submitBundle` allocates per submit.                    NO: pooled, counted below.
// 2. One full-screen draw per masked child.  COUNTED, AND MOSTLY PRICED AWAY BY A CACHE: the
//    bake is skipped entirely while the handle, the geometry
//    generation, the canvas size and the mask-child override generation all hold
//    (renderer.js _renderCanvasInner, `maskValid`). So K full-canvas draws is a per-BAKE cost,
//    not a per-frame one, and it is paid per frame only by an ANIMATED mask child. On this
//    repo's corpus the worst region has 5 children (see below), which bounds the whole thing
//    at 5 canvas passes on one re-bake. GPU A and B are written anyway, because the shape of the
//    cost is real and an asset with 50 mask children would not be exotic — but they are
//    explicitly NOT worth taking on anything measured here.
// 3. Blur weights exp() per fragment.                                        COUNTED; GPU C.
// 4. Stroke cover quads rasterize the empty interior.  PRICED AND REJECTED — an interior-skip
//    grid for strokes does not pay: the saving does not survive the gate that decides whether a
//    fragment is interior. Nothing here re-proposes it; what would
//    change the verdict is a stroke whose interior is a large fraction of its cover quad, and
//    the cover quad is already the baked miter-padded OBB rather than the shape's box.
// 5. Consecutive `drawSprite` calls not merged.  PRICED AND REJECTED — the merge exists and is
//    an explicit API: `drawSpriteInstanced(target, sprite, instances, shared)` puts N copies of
//    one sprite in ONE instanced draw (drawSprites.js). Two consecutive `drawSprite` calls for
//    DIFFERENT sprites cannot be merged into one drawArrays unless their shape ranges are
//    adjacent, and merging them implicitly would mean deferring the draw — which is what
//    `submitBundle` already does, under the caller's control. An implicit merge would buy the
//    adjacent-range case only, and the measured batching ceiling for a whole extra bundle is
//    0.011 ms; the adjacent-sprite case is a fraction of that.
// 6. Import-time style walks, regex tokenizer, no IVS cache.  OUT OF SCOPE HERE — import cost is
//    not a frame cost, and it is the subject of its own measurement (importSvg profiling).
// 7. Bands are 66% of bundle bytes.  NOT A FRAME COST BY ITSELF. Bytes are a memory and upload
//    number; the band WALK is the frame cost and it is priced separately
//    (probes/perf/coverKernelExcess.mjs). Recorded rather than re-derived.
import { fileURLToPath } from 'url';
import path from 'path';
import { readFileSync, readdirSync } from 'fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JS = path.resolve(HERE, '../..');
const REPO = path.resolve(JS, '..');

// ── 1. submitBundle allocations ─────────────────────────────────────────────────────────────
console.log('\n== 1. submitBundle: queue records allocated ==');
{
  const { attachFrameLoop } = await import(path.join(JS, 'src/renderer/frameLoop.js'));
  const glStub = () =>
    new Proxy(
      {},
      {
        get: (_t, k) => (typeof k === 'string' && /^[A-Z_0-9]+$/.test(k) ? 0 : () => null),
      },
    );
  const run = (mounts, frames) => {
    const R = {
      gl: glStub(),
      opts: {},
      draw: {},
      _inFrame: false,
      _contextLost: false,
      _frameSerial: 0,
      _lastSeenW: 0,
      _lastSeenH: 0,
      _scissor: null,
      _captureFrames: false,
      _frameLog: [],
      viewportSize: () => [256, 256],
      _canvasUnsized: () => false,
      glViewport: () => {},
      glDisable: () => {},
      glEnable: () => {},
      glDepthMask: () => {},
      fillWarmTick: () => {},
      drawBundle: () => {},
    };
    attachFrameLoop(R);
    for (let f = 0; f < frames; f++) {
      R.beginFrame([0, 0, 0, 0]);
      for (let m = 0; m < mounts; m++) R.submitBundle({ id: m }, { zOrder: m });
      R.endFrame();
    }
    return R._submitEntryAllocs;
  };
  console.log('  mounts x frames    records allocated   before (= mounts x frames + frames)');
  for (const [m, f] of [
    [1, 60],
    [4, 60],
    [8, 600],
    [32, 600],
  ]) {
    const got = run(m, f);
    console.log(
      `  ${String(m).padStart(3)} x ${String(f).padStart(4)}        ${String(got).padStart(8)}` +
        `            ${String(m * f + f).padStart(8)}`,
    );
  }
  console.log('  (the "before" column counts the per-submit record AND the per-flush array an');
  console.log(
    '   unpooled queue allocates; both are pooled. Guarded by test/submitQueueAllocSmoke.mjs.)',
  );
}

// ── 2. one full-screen draw per masked child ────────────────────────────────────────────────
console.log('\n== 2. mask bake: draws and full-canvas fragment passes per frame ==');
{
  if (typeof DOMParser === 'undefined') {
    const x = await import('@xmldom/xmldom');
    globalThis.DOMParser = x.DOMParser;
    globalThis.XMLSerializer = x.XMLSerializer;
  }
  const { default: importSvg } = await import(path.join(JS, 'src/svg/importer.js'));
  const { parseMetaBin } = await import(path.join(JS, 'src/renderer/bundle.js'));
  const { computeMaskRegions } = await import(path.join(JS, 'src/renderer/renderer.js'));
  const dirs = [path.join(REPO, 'MantleSamples/Assets/Mantle'), path.join(REPO, 'fixtures/svg')];
  const files = [];
  for (const d of dirs) {
    try {
      for (const f of readdirSync(d)) if (f.endsWith('.svg')) files.push(path.join(d, f));
    } catch {}
  }
  files.sort();
  let assets = 0,
    totRegions = 0,
    totChildren = 0,
    worst = 0,
    worstName = '';
  for (const f of files) {
    let sec, pm;
    try {
      const src = readFileSync(f, 'utf8');
      if (!/<mask\b/.test(src)) continue;
      sec = await importSvg(src, { preserveViewport: true });
      pm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
    } catch {
      continue;
    }
    const regions = computeMaskRegions({
      metaFloats: pm.metaFloats,
      metaFloatsPerShape: pm.floatsPerShape,
      numShapes: sec.numShapes,
    });
    if (!regions.length) continue;
    let draws = 0;
    for (const r of regions) draws += r.lastChild - r.firstChild + 1;
    assets++;
    totRegions += regions.length;
    totChildren += draws;
    if (draws > worst) {
      worst = draws;
      worstName = path.basename(f);
    }
    console.log(
      `  ${path.basename(f).padEnd(30)} regions ${String(regions.length).padStart(3)}` +
        `  full-canvas draws/bake ${String(draws).padStart(4)}` +
        `  innerMask ${regions.filter((r) => r.hasInnerMask).length}`,
    );
  }
  console.log(
    `  -> ${assets} masked assets, ${totRegions} regions, ${totChildren} full-canvas` +
      ` draws per bake; worst ${worst} (${worstName})`,
  );
  console.log(
    '  Each of those is gl.drawArrays(TRIANGLE_STRIP, 0, 4) at the FULL CANVAS viewport,',
  );
  console.log(
    '  preceded by one gl.uniform1i (maskBake.js bakeOneRegion) — so a region of K children',
  );
  console.log('  shades K x canvas-area fragments, whatever the children cover.');
  console.log(
    '  BUT NOT PER FRAME. renderer.js skips the whole bake while the handle, the geometry',
  );
  console.log(
    '  generation, the canvas size and the mask-child override generation are unchanged,',
  );
  console.log('  so this is paid once per invalidation — and per frame only by an ANIMATED mask');
  console.log(`  child (mask_anim.svg here). Worst region in this corpus: ${worst} children.`);
}

// ── 3. blur weights ─────────────────────────────────────────────────────────────────────────
console.log('\n== 3. blur: transcendental calls per fragment ==');
{
  const src = readFileSync(path.join(JS, 'src/shaders/blur.frag.glsl'), 'utf8');
  const exps = (src.match(/\bexp\s*\(/g) || []).length;
  console.log(`  blur.frag.glsl contains ${exps} exp() call sites, both INSIDE the tap loop.`);
  console.log('  The loop runs ceil(min(radius,32)/2) pairs, radius = min(ceil(3*sigma), 32):');
  console.log('   sigma   radius   pairs   exp()/fragment   exp() per 1024x1024 pass   two passes');
  for (const s of [1, 2, 4, 8, 16, 32]) {
    const radius = Math.min(Math.ceil(s * 3), 32);
    const pairs = Math.min(16, Math.ceil(radius / 2));
    const e = 2 * pairs;
    const per = e * 1024 * 1024;
    console.log(
      `   ${String(s).padStart(5)}   ${String(radius).padStart(6)}   ${String(pairs).padStart(5)}` +
        `   ${String(e).padStart(14)}   ${String(per).padStart(24)}   ${((2 * per) / 1e6).toFixed(1)}M`,
    );
  }
  console.log('  EVERY ONE OF THOSE IS A PER-DRAW CONSTANT. The weights depend only on uSigma (a');
  console.log(
    '  uniform) and the loop index, so the whole tap table — offset and weight per pair,',
  );
  console.log(
    '  and the weight sum — is computable once on the CPU and uploaded as a uniform array.',
  );
  console.log(
    '  That is the same class of defect as "per-fragment constants" in the Slug/AAC kernel.',
  );
}

// ── 7. bands as a share of bundle bytes ─────────────────────────────────────────────────────
console.log('\n== 7. bands as a share of bundle bytes ==');
console.log('  Recorded, not re-derived: a bundle-bytes audit puts bands at 66.4% of bundle');
console.log('  bytes (651,408 of the measured total). It is a MEMORY and UPLOAD number. The frame');
console.log(
  '  cost of bands is the WALK, which coverKernelExcess.mjs prices; the two must not be conflated: a',
);
console.log(
  '  band layout that halved the bytes and doubled the walk would read as a win here and',
);
console.log('  a loss in the frame.');

console.log(`
== WHAT NEEDS A GPU, AND EXACTLY WHAT TO FILL IN =============================================

GPU A  Scissor each mask child to its own bbox.
  change:  in maskBake.js bakeOneRegion, wrap each child's drawArrays in a scissor set to that
           child's device-space bbox (the child row's meta texel 0, projected the way the region's
           emBBox already is). NOT a smaller viewport: the bake quad's UV spans the viewport, so
           shrinking it rescales the sample instead of cropping it — the same trap
           _compositeFilteredTex documents.
  arms:    A = default (K full-canvas draws), B = scissored.
  assets:  the masked assets listed above; _mask_multi.svg and _mask_features.svg have the most
           children. Sizes 512 and 2048.
  gate:    frames BYTE-IDENTICAL (a scissor cannot change what a child paints inside its own
           bbox, and outside it the child contributes nothing to an ADDITIVE bake — verify that
           claim on the frames, do not assume it).
  PREDICTION: the win is (1 - sum(child bbox area) / (K x canvas area)) of the bake's fragment
  cost, so it is large exactly where K is large and each child is small, and ~0 for a mask whose
  children each cover the canvas. Read it at 2048, where the bake is fill-rate bound.
  fill in: A/A ____ %  |  _mask_multi @512 ____ x  @2048 ____ x  |  bytes identical [ ]

GPU B  Instance the children: one draw per region instead of K.
  change:  drawArraysInstanced(TRIANGLE_STRIP, 0, 4, K) with uRow replaced by uFirstRow +
           gl_InstanceID in maskBake.vert. The bake blend is ONE/ONE, which is commutative, so
           the children's order within a region does not matter.
  measure: draws per frame (debugStats) must fall from K to 1 per region — CHECK THIS FIRST; a
           shader that failed to compile falls back and the timing arm then measures the
           per-child path at its count.
  PREDICTION: this removes K-1 draw calls and K-1 uniform1i per region and changes NO fragment
  work, so it pays only where K is large and the canvas small — i.e. it is the CPU-side twin of
  GPU A and they compose. With GPU A's scissor in, run this against that arm, not against A.
  fill in: draws/frame A ____ B ____  |  @512 ____ x  |  @2048 ____ x

GPU C  Hoist the blur's Gaussian weights to uniforms.
  change:  compute the (offset, weight) pair table and the weight sum in JS from sigma; upload
           as uniform vec2 uTaps[16] + uTapCount + uWSum; the loop becomes two texture fetches
           and a multiply-add per pair.
  NOT output-identical, and that is the whole risk: JS computes the weights in float64 and
  rounds once, the GPU computes them in float32 per fragment. The new values are the MORE
  accurate ones, so this is a "moving scale-1 output is fine if the new output is shown
  correct" case, not a byte-identity one.
  gate:    max per-channel difference against the current shader over sigma in
           {0.6, 1, 2, 4, 8, 16, 32} on a step-edge and on a real asset (_blur.svg, _glow.svg);
           report the max and the count of pixels moving by more than 1/255, and show the moved
           pixels land on the side a float64 reference puts them.
  PREDICTION: up to 32 exp() per fragment become 0. On a 1024x1024 two-pass blur at sigma 16
  that is 67.1M transcendental calls per filtered frame removed. Expect a large win at big
  sigma and none at sigma < 1 (where the loop breaks on the first iteration).
  fill in: A/A ____ %  |  sigma 4 ____ x  |  sigma 16 ____ x  |  sigma 32 ____ x
           max |delta| ____ /255  |  px moved > 1/255 ____  |  all on the reference's side [ ]
`);
