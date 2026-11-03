// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// End-to-end Puppeteer proof that shape morph + timeline primitives
// paint actually-different pixels at different `t` values.
//
// Drives a real WebGL2 context, reads `gl.readPixels`, and asserts that
// the framebuffer's center-pixel color traverses src→mid→dst as the
// timeline advances. Catches the failure mode where the morph's math is
// correct but the renderer paints nothing or sticks at an endpoint.
//
// The renderer API exercised here is the one consumers should drive:
//   const morph = createShapeMorph(gl, bundleA, bundleB);
//   morph.setT(0.5);
//   renderer.render(morph);     // accepts bundles OR animation handles
//
// No `setBundle` call, no `.bundle` unwrap. The renderer auto-binds.
//
// Four more shape-morph cases, each on its own page in the same browser:
//
// MULTI-CURVE (mantleDemo.html).
// Shape-morph cover-quad coverage. Two SVGs sharing a multi-quad path (rounded
// card outline). Verifies that drawing the morph at t=0 produces the same
// pixels as drawing the src bundle directly, and that interior pixels (center
// + off-center samples inside the silhouette) are filled — no fragmentation
// gaps.
//
// MASK WIPE (page /mask-wipe).
// Shape-morph must interpolate an inherited mask. Top-down mask wipe: SRC mask
// rect height = 10px, DST = 80px, content rect = 100px wide × 100px tall.
// Driving the morph t = 0 → 0.5 → 1 should produce three distinct row-counts
// of revealed pixels.
//
// The mask is carried on a `<g mask="url(#m)">` wrapper, not the leaf shape:
// the importer must inherit mask + clip-path through container elements so the
// mask geometry becomes a matched topology-layer (FLAG_LAYER) shape that the
// curve+meta lerp interpolates.
//
// DST-ONLY (page /dst-only).
// The GL shape morph must RENDER dst-only shapes (geometry present only
// in the destination pose), faded in across t.
//
// These shapes have no counterpart in the src pose, so the merged morph
// bundle has to (a) append their curves, (b) enclose them in globalBBox,
// (c) append their band regions repointed into the merged curve plane, and
// (d) append their cover-quad mesh chunks with fresh gids so buildDrawList
// emits a draw op. Missing ANY of those → the shape silently never rasterizes.
//
// MASK OVER FILTER (mantleDemo.html).
// A shape morph over a `<g mask>` wrapping a `<path filter>` must stay
// visible. Builds two synthetic SVG poses and verifies:
//
//   1. Each individual pose renders something non-empty.
//   2. createShapeMorph(src, dst) at t=0 / 0.5 / 1 renders something
//      non-empty too.
//   3. createShapeTimeline([src, dst], keys) renders something non-empty.
//
// Asserts non-empty pixels at the center + a corner the path covers, so
// the "morph renders nothing / all black" failure mode trips immediately.
//
// Synthetic fixture: two centered squares with a circular reveal mask and
// a drop-shadow filter. Mask `<path>` differs between poses (the morph
// target); filter is identical.

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from './_launch.mjs';
import { pageTimeoutFor } from './_laneBudget.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'visuals', 'shape-animation');
mkdirSync(OUT, { recursive: true });

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js') || p.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (p.endsWith('.glsl')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}
// The mask-wipe page: a top-down mask wipe from a 10px slit to an 80px reveal.
const MASK_WIPE_HTML = (() => {
  const mk = (h) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs><mask id="m"><rect x="0" y="0" width="100" height="${h}" fill="#fff"/></mask></defs>
    <g mask="url(#m)"><rect x="0" y="0" width="100" height="100" fill="#ff0000"/></g>
  </svg>`;

  const SRC = mk(10); // thin slit at top — only ~10% red visible
  const DST = mk(80); // wide reveal — ~80% red visible

  const HTML = `<!DOCTYPE html><html><body>
  <canvas id="c" width="200" height="200"></canvas>
  <script type="module">
  import {
    importSvg, createBundle, createShapeMorph,
    createRenderer, loadShaders,
  } from '/src/index.js';

  const cnv = document.getElementById('c');
  const gl = cnv.getContext('webgl2', { stencil: true, antialias: false, depth: true, preserveDrawingBuffer: true });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  const renderer = createRenderer(gl, shaders);

  const bSrc = createBundle(gl, await importSvg(${JSON.stringify(SRC)}));
  const bDst = createBundle(gl, await importSvg(${JSON.stringify(DST)}));
  const morph = createShapeMorph(gl, bSrc, bDst);

  function snap(handle) {
    renderer.render(handle);
    const w = cnv.width, h = cnv.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    // Count rows that are >= 50% red along their middle column.
    let redPixels = 0;
    const midX = w >> 1;
    for (let y = 0; y < h; y++) {
      const i = (y * w + midX) * 4;
      if (px[i] > 128 && px[i+1] < 64 && px[i+2] < 64) redPixels++;
    }
    return redPixels;
  }

  morph.setT(0);   const cnt0   = snap(morph);
  morph.setT(0.5); const cntMid = snap(morph);
  morph.setT(1);   const cnt1   = snap(morph);
  window.__result = { cnt0, cntMid, cnt1, h: cnv.height };
  window.__done = true;
  </script>
  </body></html>`;
  return HTML;
})();

// The dst-only page: a red square, plus a blue one only the destination pose has.
const DST_ONLY_HTML = (() => {
  // SRC: a red square on the left. DST: the same red square PLUS a blue square
  // on the right (the dst-only shape) — and it sits OUTSIDE src's bbox, so the
  // bbox-union path is exercised too.
  const SRC =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="10" y="40" width="20" height="20" fill="#FF0000"/></svg>';
  const DST =
    '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
    '<rect x="10" y="40" width="20" height="20" fill="#FF0000"/>' +
    '<rect x="70" y="40" width="20" height="20" fill="#0000FF"/></svg>';

  const HTML = `<!DOCTYPE html><html><body style="margin:0">
  <canvas id="c" width="100" height="100"></canvas>
  <script type="module">
  import { importSvg, createBundle, createRenderer, loadShaders, createShapeMorph, createSpriteMorph, fillHitShape, HitMode } from '/src/index.js';
  const gl = document.getElementById('c').getContext('webgl2', { preserveDrawingBuffer: true });
  const shaders = await loadShaders(new URL('/src/shaders/', location.href).href);
  const renderer = createRenderer(gl, shaders);
  const m = createShapeMorph(gl, createBundle(gl, await importSvg(${JSON.stringify(SRC)})),
                                 createBundle(gl, await importSvg(${JSON.stringify(DST)})));
  window.__plan = { matched: m.plan.matched.length, srcOnly: m.plan.srcOnly.length, dstOnly: m.plan.dstOnly.length };
  const id = new Float32Array([1,0,0,0,1,0,0,0,1]);
  function scan(t) {
    m.setT(t);
    renderer.beginFrame([1,1,1,1]);
    renderer.drawBundle(m, { worldMatrix: id, overrides: m.overrides });
    renderer.endFrame();
    const px = new Uint8Array(100*100*4); gl.readPixels(0,0,100,100, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let blue = 0, red = 0;
    // Any pixel where blue dominates (covers partial fades over white too).
    let minRedInBlue = 255;
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
      const i = (y*100 + x) * 4;
      const r = px[i], g = px[i+1], b = px[i+2];
      if (b > 150 && b > r + 40 && b > g + 40) { blue++; if (r < minRedInBlue) minRedInBlue = r; }
      if (r > 150 && r > b + 40 && r > g + 40) red++;
    }
    // minRedInBlue: red channel at the bluest pixel. Over white bg a dst-only
    // blue fades in as red 255(absent) → ~128(half) → 0(full). null if no blue.
    return { blue, red, blueDepth: blue ? minRedInBlue : null };
  }
  window.__sweep = () => ({ t0: scan(0), t025: scan(0.25), t05: scan(0.5), t075: scan(0.75), t1: scan(1) });

  window.__packedFades = async () => {
    const svg = body => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'+body+'</svg>';
    const stable='<rect id="stable" x="91" y="91" width="5" height="5" fill="red"/>';
    let prefix='',tail=stable;
    for(let i=0;i<450;i++)prefix+='<rect x="'+(150+i%30*3)+'" y="'+(150+(i/30|0)*3)+'" width="2" height="2" fill="black"/>';
    for(let i=0;i<350;i++){const x=2+(i%25)*3,y=2+(i/25|0)*6;tail+='<path id="fade'+i+'" d="M'+x+' '+y+' h2 q1 1 0 2 h-2 z" fill="blue" fill-opacity=".6"/>';}
    const a=createBundle(gl,await importSvg(svg('<g id="source">'+stable+'</g>'),{preserveViewport:true}));
    const b=createBundle(gl,await importSvg(svg('<g id="prefix">'+prefix+'</g><g id="tail">'+tail+'</g>'),{preserveViewport:true}));
    const reference=createBundle(gl,await importSvg(svg(tail),{preserveViewport:true}));
    const morph=createSpriteMorph(gl,{bundle:a,sprite:'source'},{bundle:b,sprite:'tail'},{cpuLerp:true});
    const r=createRenderer(gl,shaders,{aacPoints:false});if(r.ready)await r.ready;r.setFillEngine({route:'none',kernel:'aac',commit:false});r.setViewport(100,100);
    const shot=target=>{r.beginFrame([1,1,1,1]);r.drawBundle(target);r.endFrame();const px=new Uint8Array(100*100*4);gl.readPixels(0,0,100,100,gl.RGBA,gl.UNSIGNED_BYTE,px);return px;};
    try{
      morph.setT(0);const zero=shot(morph);morph.setT(.5);const half=shot(morph);morph.setT(1);const end=shot(morph),ref=shot(reference);morph.setT(0);const again=shot(morph);
      let max=0,repeat=0,halfInk=0;for(let i=0;i<end.length;i++){max=Math.max(max,Math.abs(end[i]-ref[i]));if(zero[i]!==again[i])repeat++;if((i&3)===0&&half[i]<250)halfInk++;}
      const floats=morph.bundle._morphSrc.mergedCurveF32.length;
      if(max>1||repeat||halfInk<100)throw Error('Packed fade image '+JSON.stringify({max,repeat,halfInk,floats}));
      if(floats>=8*4096*4)throw Error('Destination-only curves retain per-shape rows: '+floats+' floats');
      if(gl.getError())throw Error('Packed fade GL error');
      return{floats,max,repeat,halfInk,dstOnly:morph.plan.dstOnly.length};
    }finally{morph.dispose();a.dispose();b.dispose();reference.dispose();r.dispose();}
  };
  window.__emptyEndpoints = async () => {
    const svg = alpha => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'+(alpha ? '<rect x="10" y="10" width="80" height="80" fill="blue"/>' : '')+'</svg>';
    const results=[];
    renderer.setFillEngine({route:'none',kernel:'aac',commit:false});
    for (const [from,to] of [[0,1],[1,0],[0,0]]) {
      const a=createBundle(gl,await importSvg(svg(from),{preserveViewport:true}));
      const b=createBundle(gl,await importSvg(svg(to),{preserveViewport:true}));
      a.globalBBox=b.globalBBox=[0,0,100,100];
      let morph;
      try {
        morph=createShapeMorph(gl,a,b);morph.bundle.globalBBox=[0,0,100,100];
        const states=[];
        for (const t of [0,.25,.5,.75,1]) {
          morph.setT(t);renderer.beginFrame([1,1,1,1]);renderer.drawBundle(morph);renderer.endFrame();
          const pixel=new Uint8Array(4);gl.readPixels(50,50,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
          const expected=Math.round(255*(1-(from+(to-from)*t)));
          if(Math.abs(pixel[0]-expected)>1||Math.abs(pixel[1]-expected)>1||pixel[2]!==255||pixel[3]!==255)throw Error('Empty endpoint fade: '+[from,to,t]+' '+pixel);
          const alpha=from+(to-from)*t;
          const hit=fillHitShape(morph.bundle,50,50,{mode:HitMode.Coverage,minAlpha:Math.max(.01,alpha-.01)});
          const above=fillHitShape(morph.bundle,50,50,{mode:HitMode.Coverage,minAlpha:alpha+.01});
          if((hit>=0)!==(alpha>.01)||above>=0)throw Error('Empty endpoint hit/pixel disagreement: '+[from,to,t,alpha,hit,above]);
          morph.overrides.uploadIfDirty();
          const error=gl.getError();if(error)throw Error('Empty endpoint GL error '+error);
          states.push({t,pixel:Array.from(pixel)});
        }
        if(from===0&&to===0&&(morph.overrides.numShapes!==0||morph.overrides.packedBuffer.length!==0))throw Error('Empty override table has shapes');
        results.push({from,to,states});
      } finally {morph?.dispose();a.dispose();b.dispose();}
    }
    return results;
  };

  window.__ready = true;
  </script></body></html>`;
  return HTML;
})();
const PAGES = { '/mask-wipe': MASK_WIPE_HTML, '/dst-only': DST_ONLY_HTML };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (PAGES[u.pathname]) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGES[u.pathname]);
    return;
  }
  let p = decodeURIComponent(u.pathname === '/' ? '/mantleDemo.html' : u.pathname);
  try {
    res.writeHead(200, { 'content-type': mime(p) });
    res.end(readFileSync(path.join(ROOT, p)));
  } catch (e) {
    try {
      res.writeHead(404);
      res.end();
    } catch {}
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/mantleDemo.html`;

// Two visually distinct SVGs sharing one shapeId so the morph
// matcher pairs them. Identical geometry + opacity, different fill
// colors — the meta-plane fillColor lerp produces a magenta-ish
// mid pixel between red (src) and blue (dst).
//
// We can't use positional drift as a signal because the Mantle
// renderer fits each asset's globalBBox to the canvas. Color drift
// is the reliable end-to-end test.
const SRC_SVG = readFileSync(
  new URL('../examples/smoke/shapeAnimationVisual__SRC_SVG.svg', import.meta.url),
  'utf8',
);
const DST_SVG = readFileSync(
  new URL('../examples/smoke/shapeAnimationVisual__DST_SVG.svg', import.meta.url),
  'utf8',
);

let failures = 0;
const fail = (m) => {
  failures++;
  console.error('FAIL', m);
};
const ok = (m) => console.log('ok', m);

const browser = await launchBrowser({
  headless: 'new',
  args:
    process.env.MANTLE_TEST_GL === 'swiftshader'
      ? ['--enable-unsafe-swiftshader', '--no-sandbox']
      : ['--use-angle=metal', '--use-gl=angle', '--no-sandbox'],
});

{
  const mainFailures = failures;
  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 400 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
  });

  await page.goto(url, { waitUntil: 'load', timeout: pageTimeoutFor() });
  await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
    timeout: pageTimeoutFor(),
    polling: 100,
  });

  const results = await page.evaluate(
    async (srcSvg, dstSvg) => {
      const { importSvg, createBundle, createShapeMorph, createShapeTimeline } =
        await import('/src/index.js');

      const gl = window.__mantleGl;
      const renderer = window.__mantleRenderer;
      const cnv = document.getElementById('glcanvas');

      async function bundleFromSvg(svg) {
        return createBundle(gl, await importSvg(svg));
      }

      const bSrc = await bundleFromSvg(srcSvg);
      const bDst = await bundleFromSvg(dstSvg);

      function snapshot(handle) {
        renderer.render(handle);
        const w = cnv.width,
          h = cnv.height;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        // Center pixel = the rect interior (which is full-canvas).
        const i = ((h >> 1) * w + (w >> 1)) * 4;
        return {
          w,
          h,
          data: px,
          center: [px[i], px[i + 1], px[i + 2]],
        };
      }

      // ---- Part A: createShapeMorph direct setT ---------------------
      const morph = createShapeMorph(gl, bSrc, bDst);
      morph.setT(0);
      const snapMorph0 = snapshot(morph);
      morph.setT(0.5);
      const snapMorphMid = snapshot(morph);
      morph.setT(1);
      const snapMorph1 = snapshot(morph);

      // ---- Part B: createShapeTimeline via setTime ------------------
      const tl = createShapeTimeline(
        gl,
        [bSrc, bDst],
        [
          { time: 0, bundleIndex: 0, interp: 'linear' },
          { time: 1, bundleIndex: 1, interp: 'linear' },
        ],
      );
      tl.setTime(0);
      const snapTl0 = snapshot(tl);
      tl.setTime(0.5);
      const snapTlMid = snapshot(tl);
      tl.setTime(1);
      const snapTl1 = snapshot(tl);

      function pngOf(handle, t) {
        if (handle.setT) handle.setT(t);
        else handle.setTime(t);
        renderer.render(handle);
        return cnv.toDataURL('image/png');
      }
      const pngs = {
        'morph-t-0': pngOf(morph, 0),
        'morph-t-0.5': pngOf(morph, 0.5),
        'morph-t-1': pngOf(morph, 1),
        'tl-t-0': pngOf(tl, 0),
        'tl-t-0.5': pngOf(tl, 0.5),
        'tl-t-1': pngOf(tl, 1),
      };

      morph.dispose();
      tl.dispose();
      bSrc.dispose();
      bDst.dispose();

      // Return only the small bits — full pixel buffers would be massive
      // over the JSON bridge. We keep center + the raw bytes for diff math.
      function compress(snap) {
        return {
          center: snap.center,
          // Hash-ish: sum of every 100th pixel for a cheap whole-frame
          // distinctness signal between t values.
          hash: (() => {
            let h = 0;
            for (let i = 0; i < snap.data.length; i += 400)
              h += snap.data[i] + snap.data[i + 1] * 2 + snap.data[i + 2] * 3;
            return h;
          })(),
        };
      }
      return {
        morph0: compress(snapMorph0),
        morphMid: compress(snapMorphMid),
        morph1: compress(snapMorph1),
        tl0: compress(snapTl0),
        tlMid: compress(snapTlMid),
        tl1: compress(snapTl1),
        pngs,
      };
    },
    SRC_SVG,
    DST_SVG,
  );

  await page.close();

  // Save PNGs for visual inspection.
  for (const [name, dataUrl] of Object.entries(results.pngs)) {
    if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) continue;
    writeFileSync(
      path.join(OUT, `${name}.png`),
      Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'),
    );
  }
  delete results.pngs;

  const dumpCenter = (label, s) =>
    `${label} center=(${s.center[0]},${s.center[1]},${s.center[2]}) hash=${s.hash}`;
  console.log(`  diag ${dumpCenter('morph t=0  ', results.morph0)}`);
  console.log(`  diag ${dumpCenter('morph t=0.5', results.morphMid)}`);
  console.log(`  diag ${dumpCenter('morph t=1  ', results.morph1)}`);
  console.log(`  diag ${dumpCenter('tl    t=0  ', results.tl0)}`);
  console.log(`  diag ${dumpCenter('tl    t=0.5', results.tlMid)}`);
  console.log(`  diag ${dumpCenter('tl    t=1  ', results.tl1)}`);

  // ---- Assertions: morph ---------------------------------------------
  // T1: morph @ t=0 = pure red.
  {
    const [r, g, b] = results.morph0.center;
    if (r < 250 || g > 10 || b > 10)
      fail(`T1 morph t=0 center should be pure red; got (${r},${g},${b})`);
    else ok(`T1 morph t=0 → pure red (${r},${g},${b})`);
  }
  // T2: morph @ t=1 = pure blue.
  {
    const [r, g, b] = results.morph1.center;
    if (r > 10 || g > 10 || b < 250)
      fail(`T2 morph t=1 center should be pure blue; got (${r},${g},${b})`);
    else ok(`T2 morph t=1 → pure blue (${r},${g},${b})`);
  }
  // T3: morph @ t=0.5 = magenta-ish (R+B near 128 each, G near 0).
  {
    const [r, g, b] = results.morphMid.center;
    if (!(r > 80 && r < 175 && b > 80 && b < 175 && g < 20))
      fail(`T3 morph t=0.5 center should be magenta-ish (R/B≈128, G≈0); got (${r},${g},${b})`);
    else ok(`T3 morph t=0.5 → magenta lerp (${r},${g},${b})`);
  }
  // T4: distinct hashes — t=0 / mid / 1 frames are meaningfully different.
  {
    const h0 = results.morph0.hash,
      hm = results.morphMid.hash,
      h1 = results.morph1.hash;
    if (h0 === hm || h1 === hm || h0 === h1)
      fail(`T4 morph hashes collide (h0=${h0} hMid=${hm} h1=${h1}); some t value is stuck`);
    else ok(`T4 morph hashes distinct: h0=${h0} hMid=${hm} h1=${h1}`);
  }

  // ---- Assertions: timeline (same expectations) ----------------------
  // T5: timeline @ t=0 = pure red.
  {
    const [r, g, b] = results.tl0.center;
    if (r < 250 || g > 10 || b > 10)
      fail(`T5 timeline t=0 center should be pure red; got (${r},${g},${b})`);
    else ok(`T5 timeline t=0 → pure red (${r},${g},${b})`);
  }
  // T6: timeline @ t=1 = pure blue.
  {
    const [r, g, b] = results.tl1.center;
    if (r > 10 || g > 10 || b < 250)
      fail(`T6 timeline t=1 center should be pure blue; got (${r},${g},${b})`);
    else ok(`T6 timeline t=1 → pure blue (${r},${g},${b})`);
  }
  // T7: timeline @ t=0.5 = magenta lerp.
  {
    const [r, g, b] = results.tlMid.center;
    if (!(r > 80 && r < 175 && b > 80 && b < 175 && g < 20))
      fail(`T7 timeline t=0.5 center should be magenta-ish; got (${r},${g},${b})`);
    else ok(`T7 timeline t=0.5 → magenta lerp (${r},${g},${b})`);
  }
  // T8: morph and timeline produce identical results (same shape under
  // the hood). Tolerate ±1 since premultiplied alpha + gamma can shift
  // a couple of LSBs.
  {
    const close = (a, b) => Math.abs(a - b) <= 1;
    const same =
      close(results.morph0.center[0], results.tl0.center[0]) &&
      close(results.morphMid.center[0], results.tlMid.center[0]) &&
      close(results.morph1.center[2], results.tl1.center[2]);
    if (!same) fail(`T8 morph and timeline centers disagree at matching t values`);
    else ok(`T8 morph and timeline render identically at matching t values`);
  }
  const n = failures - mainFailures;
  console.log();
  console.log(n === 0 ? 'SHAPE-ANIMATION VISUAL PASS' : `SHAPE-ANIMATION VISUAL FAIL (${n})`);
}

// ---- multi-curve morph: cover-quad coverage at t=0 equals the source bundle ----
{
  const before = failures;
  // Card-flip pose pair: 14 quads + 2 lines, with intermediate poses where
  // dst's control points can wander far from the card silhouette so the
  // interpolated curves at arbitrary t look right — the kind of payload a
  // shape-morph exporter produces.
  const SRC_SVG = readFileSync(
    new URL('../examples/smoke/shapeAnimationMultiCurveRepro__SRC_SVG.svg', import.meta.url),
    'utf8',
  );
  const DST_SVG = readFileSync(
    new URL('../examples/smoke/shapeAnimationMultiCurveRepro__DST_SVG.svg', import.meta.url),
    'utf8',
  );

  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 400 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));

  await page.goto(url, { waitUntil: 'load', timeout: pageTimeoutFor() });
  await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
    timeout: pageTimeoutFor(),
    polling: 100,
  });

  const results = await page.evaluate(
    async (srcSvg, dstSvg) => {
      const { importSvg, createBundle, createShapeMorph } = await import('/src/index.js');

      const gl = window.__mantleGl;
      const renderer = window.__mantleRenderer;
      const cnv = document.getElementById('glcanvas');

      async function bundleFromSvg(svg) {
        return createBundle(gl, await importSvg(svg));
      }

      function snapshot(handle) {
        renderer.render(handle);
        const w = cnv.width,
          h = cnv.height;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return { w, h, data: px };
      }

      function pixelAt(snap, x, y) {
        const i = (y * snap.w + x) * 4;
        return [snap.data[i], snap.data[i + 1], snap.data[i + 2], snap.data[i + 3]];
      }

      // Count "filled" pixels — any pixel where R+G+B > 30 (avoids the
      // ~black background while accepting magenta lerp at t=0.5).
      function filledArea(snap) {
        let n = 0;
        for (let i = 0; i < snap.data.length; i += 4) {
          const sum = snap.data[i] + snap.data[i + 1] + snap.data[i + 2];
          if (sum > 30) n++;
        }
        return n;
      }

      // Per-pixel diff count between two snaps (ignores fully-black pixels
      // outside the canvas-rect intersection).
      function diffCount(a, b, tol = 4) {
        if (a.w !== b.w || a.h !== b.h) return -1;
        let n = 0;
        for (let i = 0; i < a.data.length; i += 4) {
          if (Math.abs(a.data[i] - b.data[i]) > tol) {
            n++;
            continue;
          }
          if (Math.abs(a.data[i + 1] - b.data[i + 1]) > tol) {
            n++;
            continue;
          }
          if (Math.abs(a.data[i + 2] - b.data[i + 2]) > tol) {
            n++;
            continue;
          }
        }
        return n;
      }

      const bSrc = await bundleFromSvg(srcSvg);
      const bDst = await bundleFromSvg(dstSvg);

      function pngOf(snap) {
        return cnv.toDataURL('image/png');
      }

      // Reference: draw src directly.
      const refSrc = snapshot(bSrc);
      const refSrcPng = cnv.toDataURL('image/png');
      const refSrcArea = filledArea(refSrc);

      const refDst = snapshot(bDst);
      const refDstPng = cnv.toDataURL('image/png');

      // Morph path at t=0 — should match refSrc.
      const morph = createShapeMorph(gl, bSrc, bDst);
      morph.setT(0);
      const morph0 = snapshot(morph);
      const morph0Png = cnv.toDataURL('image/png');
      const morph0Area = filledArea(morph0);

      morph.setT(1);
      const morph1 = snapshot(morph);
      const morph1Png = cnv.toDataURL('image/png');

      morph.setT(0.5);
      const morphMid = snapshot(morph);
      const morphMidPng = cnv.toDataURL('image/png');

      const refDiff = diffCount(refSrc, morph0);

      // Sample 9 points across the silhouette interior (the card outline
      // covers most of the 100×100 viewBox, ~90% of pixels).
      const w = morph0.w,
        h = morph0.h;
      const samples = [];
      for (const ys of [0.25, 0.5, 0.75]) {
        for (const xs of [0.25, 0.5, 0.75]) {
          const x = Math.floor(xs * w),
            y = Math.floor(ys * h);
          samples.push({
            x,
            y,
            refSrc: pixelAt(refSrc, x, y),
            morph0: pixelAt(morph0, x, y),
            morph1: pixelAt(morph1, x, y),
            morphMid: pixelAt(morphMid, x, y),
          });
        }
      }

      morph.dispose();
      bSrc.dispose();
      bDst.dispose();

      return {
        refSrcArea,
        morph0Area,
        morph1Area: filledArea(morph1),
        morphMidArea: filledArea(morphMid),
        refDiff,
        samples,
        centerSrc: pixelAt(refSrc, w >> 1, h >> 1),
        centerM0: pixelAt(morph0, w >> 1, h >> 1),
        centerM1: pixelAt(morph1, w >> 1, h >> 1),
        centerMid: pixelAt(morphMid, w >> 1, h >> 1),
        canvasW: w,
        canvasH: h,
        pngs: {
          refSrc: refSrcPng,
          refDst: refDstPng,
          morph0: morph0Png,
          morph1: morph1Png,
          morphMid: morphMidPng,
        },
      };
    },
    SRC_SVG,
    DST_SVG,
  );

  await page.close();

  // Save PNGs for visual inspection.
  const OUT = path.join(__dirname, 'visuals', 'multi-curve-morph');
  mkdirSync(OUT, { recursive: true });
  for (const [name, dataUrl] of Object.entries(results.pngs)) {
    if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) continue;
    writeFileSync(
      path.join(OUT, `${name}.png`),
      Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'),
    );
  }
  console.log(`  PNGs saved to ${OUT}`);
  delete results.pngs;

  console.log(`  canvas = ${results.canvasW}x${results.canvasH}`);
  console.log('  refSrc area =', results.refSrcArea);
  console.log('  morph t=0 area =', results.morph0Area);
  console.log('  morph t=0.5 area =', results.morphMidArea);
  console.log('  morph t=1 area =', results.morph1Area);
  console.log('  refSrc vs morph0 pixel diff =', results.refDiff);
  console.log('  center src=', results.centerSrc);
  console.log('  center m0 =', results.centerM0);
  console.log('  center mid=', results.centerMid);
  console.log('  center m1 =', results.centerM1);

  // T1: morph at t=0 must have the same filled area as a direct
  // drawBundle(src). Allow a tiny tolerance for AA differences.
  {
    const delta = Math.abs(results.refSrcArea - results.morph0Area);
    const tolerance = Math.max(20, results.refSrcArea * 0.005);
    if (delta > tolerance) {
      fail(
        `T1 morph t=0 filled area (${results.morph0Area}) differs from refSrc (${results.refSrcArea}) by ${delta} > tolerance ${tolerance}`,
      );
    } else {
      ok(`T1 morph t=0 silhouette area matches refSrc (Δ=${delta})`);
    }
  }
  // T2: morph at t=0 should be near-pixel-identical to refSrc (small
  // tolerance for FBO compositing differences).
  {
    const tolerance = Math.max(200, results.refSrcArea * 0.02);
    if (results.refDiff > tolerance) {
      fail(
        `T2 morph t=0 differs from refSrc by ${results.refDiff} pixels > tolerance ${tolerance}`,
      );
    } else {
      ok(`T2 morph t=0 vs refSrc pixel diff = ${results.refDiff} (≤ ${tolerance})`);
    }
  }
  // T3: morph at t=0 center is solid red.
  {
    const [r, g, b] = results.centerM0;
    if (r < 200 || g > 30 || b > 30)
      fail(`T3 morph t=0 center should be red; got (${r},${g},${b})`);
    else ok(`T3 morph t=0 center = red (${r},${g},${b})`);
  }
  // T4: morph at t=1 center is solid blue.
  {
    const [r, g, b] = results.centerM1;
    if (r > 30 || g > 30 || b < 200)
      fail(`T4 morph t=1 center should be blue; got (${r},${g},${b})`);
    else ok(`T4 morph t=1 center = blue (${r},${g},${b})`);
  }
  // T5: morph at t=0.5 center is magenta-ish.
  {
    const [r, g, b] = results.centerMid;
    if (r < 60 || r > 195 || b < 60 || b > 195 || g > 30)
      fail(`T5 morph t=0.5 center should be magenta-ish; got (${r},${g},${b})`);
    else ok(`T5 morph t=0.5 center = magenta (${r},${g},${b})`);
  }
  // T6: per-sample interior pixels — each interior sample at t=0 should
  // match refSrc within tolerance.
  {
    let bad = 0;
    for (const s of results.samples) {
      const dr = Math.abs(s.refSrc[0] - s.morph0[0]);
      const dg = Math.abs(s.refSrc[1] - s.morph0[1]);
      const db = Math.abs(s.refSrc[2] - s.morph0[2]);
      if (dr > 4 || dg > 4 || db > 4) {
        bad++;
        console.log(`  diff at (${s.x},${s.y}): refSrc=${s.refSrc} morph0=${s.morph0}`);
      }
    }
    if (bad > 0) fail(`T6 ${bad}/${results.samples.length} interior samples differ at t=0`);
    else ok(`T6 all ${results.samples.length} interior samples match refSrc at t=0`);
  }
  const n = failures - before;
  console.log();
  console.log(n === 0 ? 'MULTI-CURVE MORPH PASS' : `MULTI-CURVE MORPH FAIL (${n})`);
}

// ---- mask wipe: an inherited mask interpolates ----
{
  const before = failures;

  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  await page.setViewport({ width: 300, height: 300 });
  await page.goto(`http://127.0.0.1:${port}/mask-wipe`, {
    waitUntil: 'load',
    timeout: pageTimeoutFor(),
  });
  await page.waitForFunction(() => window.__done === true, {
    timeout: pageTimeoutFor(),
    polling: 100,
  });
  const r = await page.evaluate(() => window.__result);
  await page.close();

  console.log('canvas height =', r.h);
  console.log(`red rows at t=0   = ${r.cnt0}  (expect ~10% of canvas h)`);
  console.log(`red rows at t=0.5 = ${r.cntMid}  (expect ~45% — midpoint of 10% and 80%)`);
  console.log(`red rows at t=1   = ${r.cnt1}  (expect ~80%)`);

  if (r.cnt0 <= 2 || r.cntMid <= 2 || r.cnt1 <= 2) {
    failures++;
    console.error('FAIL one or more reads produced zero / negligible red — mask is fully clipping');
  } else if (r.cntMid <= r.cnt0 + 5) {
    failures++;
    console.error('FAIL midpoint not visibly bigger than t=0 (mask not interpolating)');
  } else if (r.cntMid >= r.cnt1 - 5) {
    failures++;
    console.error('FAIL midpoint not visibly smaller than t=1 (mask not interpolating)');
  } else
    console.log(
      'ok mask geometry interpolates monotonically across t (' +
        r.cnt0 +
        ' < ' +
        r.cntMid +
        ' < ' +
        r.cnt1 +
        ')',
    );
  const n = failures - before;
  console.log();
  console.log(n === 0 ? 'MASK-WIPE PASS' : `MASK-WIPE FAIL (${n})`);
}

// ---- dst-only shapes render, faded in across t ----
{
  const before = failures;
  const ok = (m) => console.log('ok ' + m);
  const fail = (m) => {
    failures++;
    console.error('FAIL: ' + m);
  };

  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  let ready = true;
  try {
    await page.goto(`http://127.0.0.1:${port}/dst-only`, {
      waitUntil: 'load',
      timeout: pageTimeoutFor(),
    });
    await page.waitForFunction(() => window.__ready === true, {
      timeout: pageTimeoutFor(),
      polling: 100,
    });
  } catch (e) {
    fail('setup: ' + e.message);
    ready = false;
  }
  if (ready) {
    const plan = await page.evaluate(() => window.__plan);
    if (plan.matched === 1 && plan.dstOnly === 1) ok('plan: 1 matched (red), 1 dst-only (blue)');
    else fail('plan wrong: ' + JSON.stringify(plan));

    const s = await page.evaluate(() => window.__sweep());
    // Red is matched → always present.
    if (s.t0.red > 100 && s.t1.red > 100) ok('matched red shape renders at all t');
    else fail('matched red missing: ' + JSON.stringify(s));
    // Blue is dst-only → absent at t=0, present at t=1.
    if (s.t0.blue === 0) ok('t=0: dst-only blue ABSENT (not yet faded in)');
    else fail('t=0 blue should be 0: ' + s.t0.blue);
    if (s.t1.blue > 100 && s.t1.blueDepth < 60)
      ok(
        't=1: dst-only blue FULLY RENDERED (' +
          s.t1.blue +
          ' px, depth=' +
          s.t1.blueDepth +
          ') — the merged-bundle gap is fixed',
      );
    else fail('t=1 dst-only not full: ' + JSON.stringify(s.t1));
    // CROSSFADE: blue must FADE in continuously (over white bg the bluest pixel's
    // red channel ramps 255→~128→0), not pop. blueDepth strictly decreases.
    const depths = [
      s.t0.blueDepth,
      s.t025.blueDepth,
      s.t05.blueDepth,
      s.t075.blueDepth,
      s.t1.blueDepth,
    ];
    if (s.t05.blueDepth != null && s.t05.blueDepth > 70 && s.t05.blueDepth < 190)
      ok(
        't=0.5: dst-only blue is HALF-faded (depth=' +
          s.t05.blueDepth +
          '), not popped — continuous crossfade',
      );
    else fail('t=0.5 not a partial fade (binary pop?): ' + JSON.stringify(s.t05));
    if (
      s.t025.blueDepth != null &&
      s.t075.blueDepth != null &&
      s.t025.blueDepth > s.t05.blueDepth &&
      s.t05.blueDepth > s.t075.blueDepth
    )
      ok(
        'dst-only opacity ramps monotonically t.25>t.5>t.75 (depths ' +
          depths.slice(1, 4).join('>') +
          ')',
      );
    else fail('fade not monotonic — visibility may be binary: ' + JSON.stringify(depths));

    try {
      const empty = await page.evaluate(() => window.__emptyEndpoints());
      if (empty.length === 3 && empty.every((x) => x.states.length === 5))
        ok(
          'empty-source, empty-target and empty-pair morphs: exact interior fades, valid empty overrides, no GL errors',
        );
      else fail('empty endpoint matrix incomplete');
    } catch (e) {
      fail('empty endpoints: ' + e.message);
    }

    try {
      const p = await page.evaluate(() => window.__packedFades());
      ok('Compact sprite fades cross curve rows and match the destination: ' + JSON.stringify(p));
    } catch (e) {
      fail('Compact sprite fades: ' + e.message);
    }
  }
  await page.close();
  if (failures === before) console.log('\ndst-only: all checks passed');
}

// ---- a morph over <g mask> wrapping <path filter> stays visible ----
{
  const before = failures;
  // Two poses. Same shared `<defs>` id space.
  // - Mask `m1`: a circle at (50,50) r=40 (pose A) vs (50,50) r=20 (pose B).
  //   So pose A reveals nearly the full square, pose B reveals only the
  //   center disc.
  // - Filter `f1`: drop shadow, identical in both poses.
  // - Filled rectangle 10..90 × 10..90 wrapped in `<g mask filter>`.
  //
  // Both poses produce a non-empty center pixel (the square interior is
  // the green fill). Pose A also produces a non-empty pixel at e.g.
  // (15,15) — the corner of the square (mask radius covers it). Pose B
  // has the corner masked out, so corner pixel is empty there. The center
  // pixel is the signal: if the morph renders nothing it falls back to
  // canvas-clear white.
  const POSE_A = readFileSync(
    new URL('../examples/smoke/shapeMorphMaskFilter__POSE_A.svg', import.meta.url),
    'utf8',
  );
  const POSE_B = readFileSync(
    new URL('../examples/smoke/shapeMorphMaskFilter__POSE_B.svg', import.meta.url),
    'utf8',
  );

  const page = await browser.newPage();
  await page.setViewport({ width: 200, height: 200 });
  page.on('pageerror', (e) => console.error('  [page-err]', e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (/error|fail|warn/i.test(t)) console.log('  [console]', t);
  });
  await page.goto(url, { waitUntil: 'load', timeout: pageTimeoutFor() });
  await page.waitForFunction(() => window.__mantleRenderer && window.__mantleGl, {
    timeout: pageTimeoutFor(),
    polling: 100,
  });

  const results = await page.evaluate(
    async (poseA, poseB) => {
      const { importSvg, createBundle, createShapeMorph, createShapeTimeline } =
        await import('/src/index.js');
      const gl = window.__mantleGl;
      const renderer = window.__mantleRenderer;
      const cnv = document.getElementById('glcanvas');

      async function bundleFromSvg(svg) {
        return createBundle(gl, await importSvg(svg));
      }
      const bA = await bundleFromSvg(poseA);
      const bB = await bundleFromSvg(poseB);

      function snapshot(handle) {
        renderer.render(handle);
        const w = cnv.width,
          h = cnv.height;
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        // y is flipped (gl readPixels origin bottom-left). Canvas is
        // 200×200; the square covers ~ x∈[20,180], y∈[20,180] in canvas
        // coords. Pick the dead-center pixel — it should be GREEN
        // (post-mask, since mask radius covers center in both poses).
        const cIdx = ((h >> 1) * w + (w >> 1)) * 4;
        return {
          center: [px[cIdx], px[cIdx + 1], px[cIdx + 2], px[cIdx + 3]],
        };
      }

      // ---- 1. Individual poses render (sanity) ----
      const aSnap = snapshot(bA);
      const bSnap = snapshot(bB);

      // ---- 2. createShapeMorph(A, B) at t = 0, 0.5, 1 ----
      const morph = createShapeMorph(gl, bA, bB);
      morph.setT(0);
      const m0 = snapshot(morph);
      morph.setT(0.5);
      const mMid = snapshot(morph);
      morph.setT(1);
      const m1 = snapshot(morph);

      // ---- 3. createShapeTimeline([A, B], keys) at t = 0, 0.5, 1 ----
      const tl = createShapeTimeline(
        gl,
        [bA, bB],
        [
          { time: 0, bundleIndex: 0, interp: 'linear' },
          { time: 1, bundleIndex: 1, interp: 'linear' },
        ],
      );
      tl.setTime(0);
      const t0 = snapshot(tl);
      tl.setTime(0.5);
      const tMid = snapshot(tl);
      tl.setTime(1);
      const t1 = snapshot(tl);

      morph.dispose();
      tl.dispose();
      bA.dispose();
      bB.dispose();

      return { aSnap, bSnap, m0, mMid, m1, t0, tMid, t1 };
    },
    POSE_A,
    POSE_B,
  );

  await page.close();

  // ---- Assertions --------------------------------------------------
  //
  // `renders something` = center alpha > ~10. The "renders nothing" mode
  // leaves center at canvas clear-color (alpha 0 on the FBO readback in
  // some browsers; here the clear is white opaque, so we look for "center
  // is GREEN-ish" instead of "center is white").
  //
  // Green test fixture is #58B92D = (88, 185, 45) — predominantly green.
  // We accept "center's green channel > red + blue" as the signal that
  // the masked fill is reaching the center pixel. Pure-white (canvas
  // clear, mask drops everything) reads (255,255,255) — red == green,
  // fails the test. Drop-shadow halo + AA fuzz the actual values.

  function isGreenish(rgba, label) {
    const [r, g, b] = rgba;
    if (g <= r || g <= b) {
      fail(
        `${label}: center is NOT green-dominant — RGB=(${r},${g},${b}). Expected G > R + G > B (fill = #58B92D, mask should let center through).`,
      );
      return false;
    }
    ok(`${label}: center is green-dominant — RGB=(${r},${g},${b})`);
    return true;
  }

  isGreenish(results.aSnap.center, 'pose A direct render');
  isGreenish(results.bSnap.center, 'pose B direct render');
  isGreenish(results.m0.center, 'createShapeMorph t=0');
  isGreenish(results.mMid.center, 'createShapeMorph t=0.5');
  isGreenish(results.m1.center, 'createShapeMorph t=1');
  isGreenish(results.t0.center, 'createShapeTimeline t=0');
  isGreenish(results.tMid.center, 'createShapeTimeline t=0.5');
  isGreenish(results.t1.center, 'createShapeTimeline t=1');
  if (failures === before)
    console.log(
      "\nmask over filter: PASS (bug NOT reproduced — either fixed already, or fixture doesn't trip it)",
    );
}

await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
