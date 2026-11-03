// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _zzEnginePaint — what each engine gets WRONG on a real asset, and what it costs, in one run.
//
// Three numbers decide the fill engines' remaining work and they have to come from the same frame,
// or they are three different experiments: the pixels an engine paints that the artwork does not
// (WRONG SOLID), the error where the outline runs through a pixel (AA), and the frame time.
//
// THE REFERENCE IS THE PATH, not another engine. Every shape's exact row spans, Gauss-Legendre in
// y, composited in document order -- so "wrong" means wrong about the artwork rather than
// different from whichever engine was declared the oracle. Comparing engines to each other
// classifies every antialiased pixel as a disagreement and hides the ink in the wrong place.
//
// INTERIOR vs EDGE COMES FROM THE REFERENCE ITSELF: a pixel whose reference color matches all
// eight of its neighbours is one the outline does not run through, so any disagreement there is
// paint in the wrong place and not a filter difference. Everything else is an edge pixel and is
// scored as AA. No threshold on "how far from a curve" -- the reference already knows.
//
// THROTTLED (test/_gpuThrottle.mjs): every frame -- warm-up and timed -- is followed by an idle of at least its own
// length (MANTLE_GPU_DUTY, default 0.5) plus a rest, after its clock stopped; an older tree's link wait draws one frame
// per 16 ms instead of back to back; the browser part of the run is capped at MANTLE_GPU_WALL_MS (the node-side
// reference that follows is not). Run it in the FOREGROUND, one GPU job at a time.
import { readFileSync, writeFileSync } from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchBrowser } from '../test/_launch.mjs';
import { installGpuThrottle, capWallTime, gpuThrottleBanner } from '../test/_gpuThrottle.mjs';
import { DOMParser as DP, XMLSerializer as XS } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
globalThis.XMLSerializer = XS;
import importSvg from '../src/svg/importer.js';
import { curveRangeToContours } from '../src/geom/lbContour.js';
import { contoursToConverter } from '../src/renderer/cpatchBuild.js';
import { rowSpans, rowCross } from '../src/renderer/cpatchConvert.js';
import { buildLoopBlinnCDT } from '../src/renderer/loopBlinn.js';
import { parseMetaBin } from '../src/core/metaBin.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// PAGE_ROOT: serve the PAGE's modules and shaders from another source tree (an older release checkout) while this probe and its
// node-side reference keep running from ROOT -- one instrument and one reference across two renderers. The reference cannot
// move: it imports CPatch modules an older tree may not have.
const PAGE_ROOT = process.env.PAGE_ROOT ? path.resolve(process.env.PAGE_ROOT) : ROOT;
const N = +(process.env.N || 512);
const SVGP = process.env.SVG || '../MantleSamples/Assets/Mantle/tiger.svg';
// An absolute SVG= is taken as given: a generated asset (glyphs, a synthetic case) does not live
// under the repo, and joining it to ROOT silently produces a path that cannot exist.
const SVG_RAW = readFileSync(path.isAbsolute(SVGP) ? SVGP : path.join(ROOT, SVGP), 'utf8');
// KEEPSTROKES=1: OUTLINED assets -- fills an opaque stroke covers -- are the case the no-AA kernels exist for, and stripping the
// strokes removes the very cover that makes a hard fill edge invisible. The fill-only reference cannot judge such a frame, so
// it is flagged below and each arm is compared against the FIRST arm's frame (put the AA reference arm first).
const KEEPSTROKES = !!process.env.KEEPSTROKES;
const SVG = KEEPSTROKES
  ? SVG_RAW
  : SVG_RAW.replace(/stroke\s*=\s*"[^"]*"/g, 'stroke="none"')
      .replace(/stroke-width\s*=\s*"[^"]*"/g, '')
      // ...AND CSS / style="" strokes, which the attribute rule never reached (eat.09's .cls-1{stroke:#ed6b37}): the renderer
      // drew them and the fill-only reference did not, so every engine showed the same wrong pixels.
      .replace(/(^|[;{\s"'])stroke\s*:\s*[^;}"']+/g, '$1stroke:none');
// WHAT THE REFERENCE CANNOT DRAW. It is per-shape fill color + alpha under the shape's own fill rule, so gradients, clips,
// masks, filters, images, <use>, group opacity and blend modes make its wrong/outside counts meaningless for every engine
// alike (a dense UI illustration reads tens of thousands of "wrong" pixels for all six). Named in the report rather than scored.
const REF_LACKS = [
  ['gradient', /<(linear|radial)Gradient\b/],
  ['pattern', /<pattern\b/],
  ['paint-server fill', /\bfill\s*[=:]\s*["']?\s*url\(/],
  ['clipPath', /<clipPath\b|\bclip-path\s*[=:]/],
  ['mask', /<mask\b|\bmask\s*=\s*["']url\(/],
  ['filter', /<filter\b|\bfilter\s*=\s*["']url\(/],
  ['image', /<image\b/],
  ['use', /<use\b/],
  ['group opacity', /<g\b[^>]*\bopacity\s*=|<g\b[^>]*\bstyle\s*=\s*["'][^"']*\bopacity\s*:/],
  ['blend mode', /mix-blend-mode|\bisolation\s*:/],
]
  .filter(([, re]) => re.test(SVG))
  .map(([name]) => name)
  .concat(KEEPSTROKES ? ['strokes (KEEPSTROKES)'] : []);
const ARMS = (process.env.ARMS || 'slug,lb,cpatch').split(',');
const FRAMES = +(process.env.FRAMES || 24);
// Frames discarded before timing: a fresh renderer per arm means a full variant link each time.
// Frames discarded before timing. Each arm builds its own renderer (the previous one is disposed --
// a live renderer claims the next arm's meshes), so every arm relinks its shader variants.
const WARM = +(process.env.WARM || 4);
const OUT = process.env.OUTDIR || '';
// REPEAT: draw the bundle this many times inside each TIMED frame, so simple content clears the timer's 0.1 ms resolution
// without changing pixels per shape or draws per bundle (k copies in a scene). The quality frame is still one draw.
const REPEAT = Math.max(1, Math.floor(+(process.env.REPEAT || 1)));
// A disagreement this large on an interior pixel is ink in the wrong place. 24/255 is under 10%:
// well above any dithering and far below a shape's color difference from its neighbours.
const SOLID_BAD = +(process.env.SOLID_BAD || 24);
const NOSDF = process.env.NOSDF ? 'true' : 'false';
// IMPORT: extra importSvg opts as JSON, added to the RENDERED bundle's build only (the
// reference is computed from the curves, so a band-layout knob cannot move it). The point is to ask
// whether a defect is locked to the band grid: change bandK and see whether it moves.
const IMPORT = process.env.IMPORT || '{}';

const WHO = process.env.WHO ? 'true' : 'false';
// BLAME=1: charge each wrong pixel to the shape that PAINTED it, not the one that should own it.
const BLAME = process.env.BLAME ? 'true' : 'false';

const HTML = `<!DOCTYPE html><html><body style="margin:0"><canvas id="c" width="${N}" height="${N}"></canvas>
<script>
// IDLE CALLBACKS STILL OWED. A release tree fills its occupancy grids from requestIdleCallback with no pending flag, and a timed
// loop that never yields never lets them run -- the grids would be missing from every timed frame. Counted here, waited on below.
(() => { if (typeof requestIdleCallback !== 'function') return;
  const ric = requestIdleCallback.bind(window), cic = cancelIdleCallback.bind(window), live = new Set();
  window.__idlePending = () => live.size;
  window.requestIdleCallback = (cb, opt) => { let id = 0; id = ric((d) => { live.delete(id); cb(d); }, opt); live.add(id); return id; };
  window.cancelIdleCallback = (id) => { live.delete(id); return cic(id); }; })();
</script>
<script type="module">
globalThis.__MANTLE_DEBUG__ = true;   // createRenderer's fillDefines is a test hook, read only under it
import { importSvg, createBundle, createRenderer, loadShaders } from '/src/index.js';
// THE LB MESH CACHE OUTLIVES THE BUNDLE AND THE RENDERER. It is keyed by curve bytes, not by
// bundle, and it caches SLUG VERDICTS as well as meshes -- so the second arm of an A/B that
// changes how the build decides gets the FIRST arm's decisions back without building anything,
// and both arms report the same number. That is indistinguishable from "the switch has no
// effect", which is how it went unnoticed: an audit-off arm read identical to audit-on because
// its 84 Slug verdicts were cached. Production wants this cache (same geometry, same mesh);
// a measurement does not. Renderer.dispose clears it, but a probe that disposed its renderer
// per arm would recompile every shader variant and measure link time as frame time.
// AN OLDER RELEASE MAY NOT EXPORT IT (clearLbMeshCaches is optional here), and one failed named import kills the whole page module.
import * as _md from '/src/renderer/morphDraw.js';
const clearLbMeshCaches = _md.clearLbMeshCaches || (() => {});
import { parseMetaBin } from '/src/core/metaBin.js';
// NOSDF=1 turns the circle/ellipse recognisers off, so every shape goes down the general fill and
// a residue cannot be blamed on the disc that rides both engines' draws.
if (${NOSDF}) {
  try { const m = await import('/src/geom/shapeRecognize.js'); if (m.setSdfPrimitivesEnabled) m.setSdfPrimitivesEnabled(false); }
  catch { console.log('NOSDF: this tree has no shapeRecognize.js'); }
}
const cv=document.getElementById('c');
const gl=cv.getContext('webgl2',{antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
// THE PROGRAM THAT DREW, asked of WebGL at the draw itself. A renderer's own engine ledger is the obvious proof, and an older
// release may not keep one (no debugStats.engines and no variant key). Shadowing useProgram misses programs -- a GWN arm
// whose variant key names MANTLE_GWN_SDF would tally its one draw as OTHER -- so each draw reads gl.getParameter(CURRENT_PROGRAM)
// and that program's defines from its attached shaders' SOURCE. Calls seen through shaderSource/attachShader remain only as a
// fallback for a renderer that detaches shaders after linking. Armed only around one UNTIMED frame.
{
  const srcDefs = new WeakMap(), tracked = new WeakMap(), progCache = new WeakMap();
  // NO BACKSLASHES IN THESE PATTERNS: this code lives inside the page's template literal, where an escape like a backslash-s
  // collapses to a bare 's', and a pattern that uses one matches nothing on either tree.
  const defsIn = (src) => (String(src || '').match(/#define[ \t]+MANTLE_[A-Z0-9_]+/g) || []).map((d) => d.split(/[ \t]+/)[1]);
  const ss = gl.shaderSource.bind(gl);
  gl.shaderSource = (sh, src) => { srcDefs.set(sh, defsIn(src)); return ss(sh, src); };
  const at = gl.attachShader.bind(gl);
  gl.attachShader = (pr, sh) => { const t = tracked.get(pr) || new Set(); for (const d of srcDefs.get(sh) || []) t.add(d); tracked.set(pr, t); return at(pr, sh); };
  const programDefs = (pr) => {
    let d = progCache.get(pr);
    if (d) return d;
    d = new Set(tracked.get(pr) || []);
    for (const sh of gl.getAttachedShaders(pr) || []) for (const x of defsIn(gl.getShaderSource(sh))) d.add(x);
    progCache.set(pr, d);
    return d;
  };
  window.__glTally = null;
  const note = () => {
    const t = window.__glTally; if (!t) return;
    const pr = gl.getParameter(gl.CURRENT_PROGRAM);
    const d = pr ? programDefs(pr) : new Set();
    const k = d.has('MANTLE_GWN_SDF') ? 'GWN_SDF' : d.has('MANTLE_HARD_TREE') ? 'HARD_TREE' : d.has('MANTLE_HARD') ? 'HARD' : d.has('MANTLE_CPATCH_HARD') ? 'CPATCH_HARD'
            : d.has('MANTLE_CPATCH') ? 'CPATCH' : d.has('MANTLE_AAC') ? 'AAC' : d.has('MANTLE_LB_FILL') ? 'LB_FILL' : pr ? 'OTHER' : 'NONE';
    t[k] = (t[k] | 0) + 1;
    // WHAT an unclassified program carried, so a refusal names it instead of leaving "OTHER" to be guessed at.
    if (k === 'OTHER' && !t.otherDefs) t.otherDefs = [...d].slice(0, 14).join('|') || '(no MANTLE_ defines in source)';
  };
  for (const fn of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
    const o = gl[fn].bind(gl); gl[fn] = (...a) => { note(); return o(...a); };
  }
}
const shaders=await loadShaders(new URL('/src/shaders/',location.href).href);
const N=${N}, FRAMES=${FRAMES}, WARM=${WARM};
// A ground that differs from white in every channel AND is dark, so an alpha error shows as a large
// signed difference rather than a subtle one, and a channel swap cannot hide in a grey.
const GROUND2=[0.04,0.22,0.55,1];
window.__run=async(svg,arms)=>{
  // GWN ARMS NEED THE WINDING TREE IN THE BAND TEXTURE, and only pages carrying one build it: the tree
  // enlarges the texture every other engine on the page would read, so GWN belongs on its own page.
  const GWN_IMPORT = arms.some((a) => String(a).slice(0, 3) === 'gwn') ? { gwnTree: true } : {};
  const sec=await importSvg(svg,{preserveViewport:true,...GWN_IMPORT,...${IMPORT}});
  // STAGE markers (PAGELOG=1): where a page that never answers stopped. The last one printed names the hang.
  if (${JSON.stringify(!!process.env.PAGELOG)}) console.log('STAGE ' + 'page' + ' import ' + Math.round(performance.now()));
  // WHO=1 repaints every shape with its own INDEX (hi nibble in red, lo in green, blue 128), so a
  // frame reads back as a map of winners. "Which engine is wrong" is answered by the reference;
  // "which shape did the renderer actually put here" is not, and on a stacked asset that is the
  // question -- a pixel the clear colour survives is one NO shape won.
  if (${WHO}) {
    const mm = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
    const MF2 = mm.metaFloats, ST2 = mm.floatsPerShape | 0;
    for (let s2 = 0; s2 < mm.numShapes; s2++) {
      const o2 = s2 * ST2;
      MF2[o2 + 4] = ((s2 >> 4) & 15) / 255; MF2[o2 + 5] = (s2 & 15) / 255; MF2[o2 + 6] = 128 / 255;
      if (MF2[o2 + 7] > 0) MF2[o2 + 7] = 1;
    }
  }
  const sleepP=(ms)=>new Promise((z)=>setTimeout(z,ms));
  const out={vb:sec.viewBox};
  // ONE BUNDLE ALIVE AT A TIME: the unified route keeps one stream in a shared VBO, and two live
  // CPatch bundles make it decline them both.
  // KEYED BY INDEX, NOT BY SPEC. Two arms with the same name ('cpatch,cpatch', the usual way to
  // check an engine against itself) wrote to the same slot, so the node side read the SECOND arm's
  // frame twice and reported it as both -- which is how CPatch appeared to run at 2.4 ms when its
  // first arm actually takes 4.9 and only a repeat is fast.
  for (let _ai = 0; _ai < arms.length; _ai++) {
    const spec = arms[_ai];
    // An arm is 'engine' or 'engine:GLOBAL=value,GLOBAL=value' -- the settings are applied before
    // the bundle is built, so two CPatch configurations can be compared IN ONE RUN. A GPU probe
    // drifts 30-40% between runs; only a within-run A/B means anything.
    const [arm, cfg] = spec.split(':');
    // EVERY ARM STARTS FROM THE DEFAULTS. A setting left over from the previous arm silently
    // becomes part of this one's configuration, and two arms then differ by something other than
    // what their names say -- which is worse than no A/B at all, because the numbers look valid.
    for (const k4 of Object.keys(globalThis)) if (/^__(CP|MANTLE|LB|lb)/.test(k4)) delete globalThis[k4];
    clearLbMeshCaches();
    // Settings are separated by ';' -- ARMS itself is comma-separated, so a comma here would
    // split one arm into two.
    // An arm's globals are mostly test hooks, which read only under __MANTLE_DEBUG__ (see
    // mantleDebugHook), so an arm that sets any opens the gate. The reset above closed it.
    if ((cfg || '').split(';').some((kv) => kv.startsWith('__'))) globalThis.__MANTLE_DEBUG__ = true;
    for (const kv of (cfg || '').split(';').filter(Boolean)) {
      const [k2, v2] = kv.split('=');
      // A value that is not a number is passed through as a string (the define list).
      if (v2 === undefined || v2 === '') delete globalThis[k2];
      // 'true'/'false' become BOOLEANS: a gate written !== false is strict, and the string
      // 'false' is not false -- an arm meaning to turn one off would leave it on and read as a
      // no-op. (No backticks anywhere in this page: the whole thing is one template literal.)
      else if (v2 === 'false' || v2 === 'true') globalThis[k2] = (v2 === 'true');
      else globalThis[k2] = /^-?[0-9.]+$/.test(v2) ? +v2 : v2.split('+').join(',');
    }
    // gwn: winding tree + SDF antialiasing. gwnhard: the same tree, winding only (no AA) -- the price of AA is the
    // difference between the two, measured on one page. Both are fillDefines programs: setFillEngine has no GWN name.
    // __GWN_DEFS=A+B: extra kernel defines on a GWN arm, so the kernel's own switches A/B as arms of one page. Set it on
    // EVERY GWN arm of a page ('none' for none): arm globals persist into the arms after them.
    const GWN_EXTRA = (globalThis.__GWN_DEFS && globalThis.__GWN_DEFS !== 'none') ? String(globalThis.__GWN_DEFS).split(',').filter(Boolean) : [];
    // No-AA kernels (outlined assets): band-hard = crossing count on the band walk; CPatch-hard thresholds its own
    // coverage (MANTLE_CPATCH_HARD, per curve constraint); auto = the renderer's choice.
    const opts = arm==='cpatch' ? {cpatchFill:true, aacFill:false}
               : arm==='cpatchhard' ? {cpatchFill:true, aacFill:false, fillDefines:['MANTLE_CPATCH','MANTLE_CPATCH_HARD']}
               : arm==='auto' ? {aacFill:'auto'}
               : arm==='aac'    ? {aacFill:true}
               : arm==='gwn'    ? {fillDefines:['MANTLE_GWN','MANTLE_GWN_SDF'].concat(GWN_EXTRA)}
               : arm==='gwnhard'? {fillDefines:['MANTLE_HARD','MANTLE_HARD_TREE','MANTLE_GWN'].concat(GWN_EXTRA)} : {};
    // RENDERER OPTIONS FROM THE ARM TOO: 'lb:opt.unifiedFillDepthClaim=0' sets one on the
    // renderer rather than a global, which is where the draw-state switches live.
    for (const kv of (cfg || '').split(';').filter(Boolean)) {
      if (!kv.startsWith('opt.')) continue;
      const [k3, v3] = kv.slice(4).split('=');
      opts[k3] = v3 === '0' ? false : v3 === '1' ? true : v3;
    }
    const BOPT = window.__BOPT || {};
    // RENDERER OPTIONS, for the switches that live on the renderer rather than in a global. The
    // depth claim is one: CPatch always engages it, which makes overlapping patches mutually
    // exclusive, and whether that is what drops an edge pixel can only be asked by turning it off.
    // WARM2 — WHAT MAKES THE FIRST CPATCH RENDERER IN A PAGE SLOW. It reads 5.50 ms on tiger at
    // 512px and 2.40-2.60 for every arm after it, and that gap is not the GPU warming up: with
    // ARMS='lb,lb,cpatch,cpatch' Loop-Blinn is already fast as the FIRST arm (2.30 -> 2.10) and
    // CPatch still reads 5.50 at position three. Only a previous CPATCH renderer helps.
    //
    // Eliminated, each with its own measurement:
    //   * the fill variant -- the variant key is identical in every arm (vkey=lean), so no arm is
    //     drawing on the all-feature universal;
    //   * the program link -- r.precompileFills() before the timed loop changes nothing (5.70);
    //   * uploads or extra draws -- under GLCOUNT=1 both arms issue 24 drawArrays, zero
    //     texImage2D/bufferData, and debugStats is byte-identical between them;
    //   * time -- FRAMES of 14, 24, 48, 96 and 400 all report 4.7-5.4 for a lone arm. Two solid
    //     seconds of drawing never converge, so it is not a one-off pipeline build: the whole
    //     renderer runs slow for its whole life.
    //
    // What it IS: the FIRST LARGE ALLOCATION. WARM2=nodraw builds a throwaway renderer and bundle
    // of the same content and disposes them WITHOUT EVER DRAWING, and that alone takes the measured
    // arm from 5.50 to 3.10; drawing the throwaway eight times gets the remaining 0.5 (2.60).
    // WARM2=bundle, a throwaway bundle on the same renderer, does nothing (5.60) -- because by then
    // the measured bundle's own texture has already been allocated. The warm-up has to come FIRST.
    //
    // Which is consistent with why this is CPatch's problem and not Loop-Blinn's: CPatch's fragment
    // cost is dominated by sampling its patch texture (seven texels per curve), so where that data
    // lands matters to it and barely registers for an engine that reads a fraction as much.
    //
    //   WARM2=1        throwaway renderer + bundle, drawn, disposed   2.60 ms
    //   WARM2=nodraw   built and disposed, never drawn                3.10 ms
    //   WARM2=bundle   throwaway bundle on the measured renderer       5.60 ms
    //   (unset)                                                       5.50 ms
    if (${JSON.stringify(process.env.WARM2 || '')}) {
      const only = false && ${JSON.stringify(process.env.WARM2 || '')} === 'bundle';
      const rw = createRenderer(gl, shaders, Object.assign({}, opts, window.__ROPT || {}));
      if (!only && rw.setLoopBlinnFill) rw.setLoopBlinnFill(arm==='lb'?'on':arm==='lbonly'?'only':(arm==='slug'||arm==='aac'||arm.slice(0,3)==='gwn')?'off':'auto');
    // KERNEL PINS go through the renderer's own selector (setFillEngine), so a pinned arm takes the route auto would take.
    if (({bandhard:1,treehard:1})[arm] && rw.setFillEngine) rw.setFillEngine({ kernel: arm === 'bandhard' ? 'hard-band' : 'hard-tree' });
      const sw = await importSvg(svg, { preserveViewport: true, ...GWN_IMPORT });
      const bw = createBundle(gl, sw, BOPT);
      if (rw.prepareBundle) rw.prepareBundle(bw);
      if (arm==='cpatch') { let w=0; while(bw._cpatchConv==='pending' && w<60000){ await sleepP(5); w+=5; }
        if (rw.prepareBundle) rw.prepareBundle(bw);
        while(bw._cpatchConv==='pending' && w<60000){ await sleepP(5); w+=5; }
        if (rw.prepareBundle) rw.prepareBundle(bw); }
      if (rw.awaitLbReady) await rw.awaitLbReady(bw);
      rw.setViewport(N,N); gl.viewport(0,0,N,N);
      if (${JSON.stringify(process.env.WARM2 || '')} !== 'nodraw') {
        for (let k=0;k<8;k++){ rw.beginFrame([1,1,1,1]); rw.drawBundle(bw); rw.endFrame(); }
        const one0=new Uint8Array(4); gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,one0);
      }
      bw.dispose(); if (!only && rw.dispose) rw.dispose();
    }
    if (${JSON.stringify(!!process.env.TEXTRACE)} && !gl.__texTraced) {
      gl.__texTraced = true; const ids = new WeakMap(); let nid = 0; let bound = null;
      const oc = gl.createTexture.bind(gl); gl.createTexture = function () { const t = oc(); ids.set(t, ++nid); return t; };
      const ob = gl.bindTexture.bind(gl); gl.bindTexture = function (tg, t) { if (tg === gl.TEXTURE_2D) bound = t; return ob(tg, t); };
      const oi = gl.texImage2D.bind(gl);
      gl.texImage2D = function (...a) { if (a[0] === gl.TEXTURE_2D && a.length >= 9) console.log('TEX upload #' + (bound ? ids.get(bound) : 'null') + ' ' + a[3] + 'x' + a[4]); return oi(...a); };
      const os = gl.texSubImage2D.bind(gl);
      gl.texSubImage2D = function (...a) { if (a[0] === gl.TEXTURE_2D) console.log('TEX sub #' + (bound ? ids.get(bound) : 'null')); return os(...a); };
      const od = gl.deleteTexture.bind(gl); gl.deleteTexture = function (t) { console.log('TEX delete #' + ids.get(t)); return od(t); };
      window.__texId = (t) => ids.get(t);
    }
    const r=createRenderer(gl,shaders,Object.assign({}, opts, window.__ROPT || {}));
    // 'lbonly' suppresses the Slug fallback: a shape LB cannot build is then simply NOT DRAWN,
    // which is what separates "the fallback drew it wrong" from "the fallback never ran".
    if (r.setLoopBlinnFill) r.setLoopBlinnFill(arm==='lb'?'on':arm==='lbonly'?'only':(arm==='slug'||arm==='aac'||arm.slice(0,3)==='gwn')?'off':'auto');
    // KERNEL PINS go through the renderer's own selector (setFillEngine), so a pinned arm takes the route auto would take.
    if (({bandhard:1,treehard:1})[arm] && r.setFillEngine) r.setFillEngine({ kernel: arm === 'bandhard' ? 'hard-band' : 'hard-tree' });
    const b=createBundle(gl,sec,BOPT);
    // AN OLDER RELEASE'S prepareBundle MAY BUILD LOOP-BLINN MESHES SYNCHRONOUSLY whatever the LB mode, and on a gwnTree import that
    // constrained triangulation can spin (insertConstraints -> segsCross, still running after minutes). Its only other job there is
    // prewarming the fill variant, which the warm-up loop below does. So a GWN arm on a tree without precompileFills
    // skips it; the GWN draw path never reads LB meshes.
    const skipPrepare = arm.slice(0, 3) === 'gwn' && !r.precompileFills;
    if (r.prepareBundle && !skipPrepare) r.prepareBundle(b);
    if (${JSON.stringify(!!process.env.PAGELOG)}) console.log('STAGE ' + arm + ' bundle+prepare ' + Math.round(performance.now()));
    // THE GRIDS THE WORKER BUILDS LAND AFTER THE FIRST FRAMES: occupancy bits, and GWN's tier-3 cells (zeroed at import,
    // dormant until filled). Timing before they land measures the full walk on every fragment -- GWN's interior early
    // exit simply is not there yet. Wait for the build like the cull.
    { let w = 0; while (b._occupancyBuildPending && w < 60000) { await sleepP(5); w += 5; } }
    // A RELEASE TREE HAS NO PENDING FLAG: its grids arrive through idle callbacks, counted by the page's wrapper.
    if (!('_occupancyBuildPending' in b) && window.__idlePending) { let w = 0; while (window.__idlePending() > 0 && w < 4000) { await sleepP(10); w += 10; } }
    if (${JSON.stringify(!!process.env.PAGELOG)}) console.log('STAGE ' + arm + ' occupancy ' + Math.round(performance.now()));
    if (arm==='cpatch'){ let w=0; while(b._cpatchConv==='pending' && w<60000){ await sleepP(5); w+=5; }
      if (r.prepareBundle) r.prepareBundle(b);
      while(b._cpatchConv==='pending' && w<60000){ await sleepP(5); w+=5; }
      if (r.prepareBundle) r.prepareBundle(b); }
    if (r.awaitLbReady) await r.awaitLbReady(b);
    // ...and no awaitLbReady: poll that tree's own ready rule (a real, non-Slug mesh for this geometry), then give its worker a
    // moment to swap in its result, which would otherwise rebuild the combined buffer inside the timed frames.
    if (!r.awaitLbReady && (arm === 'lb' || arm === 'lbonly')) {
      const ready = () => b._lbMeshes && b._lbMeshes.some((m) => m && !m.slug && (m.vertexCount | 0) > 0) && (b._lbGen | 0) === (b._geomGen | 0);
      let w = 0; while (!ready() && w < 30000) { await sleepP(10); w += 10; }
      const m0 = b._lbMeshes; w = 0; while (b._lbMeshes === m0 && w < 3000) { await sleepP(20); w += 20; }
    }
    if (${JSON.stringify(!!process.env.PAGELOG)}) console.log('STAGE ' + arm + ' lb-ready ' + Math.round(performance.now()));
    // WAITCULL=1: wait for the asynchronous occlusion cull to LAND before measuring. Without it an arm's
    // result depends on whether its own build was slow enough for the worker to answer first -- which is how
    // an unsound cull hid under every fast engine and surfaced only under CPatch's pooled build.
    if (${JSON.stringify(!!process.env.WAITCULL)}) { let wc = 0; while (b._occlusionCullPending && wc < 30000) { await sleepP(20); wc += 20; } }
    // PRECOMPILE=1 drains the fill-variant and PSO queues before the timed loop, which is what an
    // embedder does behind a load screen. Without it a lean variant is not USED until its Metal
    // pipeline has been warmed in frame slack, and content draws on the all-feature universal
    // meanwhile -- see fillPass's psoReady gate. That is the whole first-arm gap for CPatch.
    if (${JSON.stringify(!!process.env.PRECOMPILE)} && r.precompileFills) r.precompileFills();
    // AN OLDER RELEASE MAY HAVE NO precompileFills -- and then needs no PSO gate: it swaps a lean variant in the moment it
    // LINKS. Linking is asynchronous, so draw yielding frames until the compile count has held still for a while; otherwise its
    // first timed frames draw the un-specialized base and the two trees are timed on different programs.
    if (${JSON.stringify(!!process.env.PRECOMPILE)} && !r.precompileFills) {
      let still = 0, last = -1, i = 0; const t0 = performance.now();
      while (i++ < 400 && (still < 20 || performance.now() - t0 < 600)) {
        r.setViewport(N, N); r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); await sleepP(16);   // app cadence, not back to back (the throttle)
        const vc = (r.debugStats && ((r.debugStats.variantCompiles | 0) + (r.debugStats.variantPolls | 0) * 0)) | 0;
        still = vc === last ? still + 1 : 0; last = vc;
      }
    }
    if (${JSON.stringify(!!process.env.PAGELOG)}) console.log('STAGE ' + arm + ' warm ' + Math.round(performance.now()));
    r.setViewport(N,N); gl.viewport(0,0,N,N);
    // A ONE-PIXEL READBACK PER FRAME forces the GPU to finish it, so the median is a frame and
    // not a queue depth. The first frames are warm-up (shader links, first-use uploads).
    // WHAT THE DRAW LOOP ACTUALLY ASKS THE GPU FOR, per frame. A first bundle that re-uploads is
    // a real defect; a first bundle that issues identical calls and still runs slower is not the
    // renderer's doing. Counted around the timed loop only.
    const GLC = {};
    if (${JSON.stringify(!!process.env.GLCOUNT)}) for (const fn of ['texImage2D','texSubImage2D','bufferData','bufferSubData','drawArrays',
                      'drawElements','drawArraysInstanced','linkProgram','compileShader',
                      'texStorage2D','createTexture','deleteTexture']) {
      const orig = gl[fn]; if (typeof orig !== 'function') continue;
      GLC[fn] = 0;
      gl[fn] = function (...a) { GLC[fn]++; return orig.apply(gl, a); };
    }
    const one=new Uint8Array(4), ts=[], tsCpu=[];
    const uniDraws0 = (r.debugStats && r.debugStats.unifiedFillDraws) | 0;
    for (let k=0;k<FRAMES;k++){ const t0=performance.now();
      if (${JSON.stringify(!!process.env.TEXTRACE)} && k === 0) console.log('CURVETEX #' + window.__texId(b.curveTex) + ' cpatchBuilt=' + (b._cpatchBuilt|0));
      if (${JSON.stringify(!!process.env.TEXTRACE)}) console.log('FRAME ' + k);
      if (${JSON.stringify(!!process.env.REUPLOAD)} && b._cpatchPlane) { gl.bindTexture(gl.TEXTURE_2D, b.curveTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, b._cpatchTexW, b._cpatchRows, 0, gl.RGBA, gl.FLOAT, b._cpatchPlane);
        gl.bindTexture(gl.TEXTURE_2D, null); }
      // NOOCC=1: switch the Slug interior-occupancy grid off for this bundle before every draw. The pooled
      // build path is the only one on which the occupancy worker runs and flips it on.
      if (${JSON.stringify(!!process.env.NOOCC)}) { if (k === 0) console.log('OCC was ' + !!b.hasOccupancy); b.hasOccupancy = false; }
      // CPU SUBMIT is the JS side up to endFrame, before the 1-px readback forces the GPU to finish; the frame time below
      // includes both. The unified route does per-draw CPU work the plain pass does not, and only this split shows it.
      const tS = performance.now();
      r.beginFrame([1,1,1,1]); for (let q = 0; q < ${REPEAT}; q++) r.drawBundle(b); r.endFrame();
      const dtCpu = performance.now() - tS;
      gl.readPixels(0,0,1,1,gl.RGBA,gl.UNSIGNED_BYTE,one); const dt=performance.now()-t0;
      // WARM-UP. Each arm builds its OWN renderer and the previous one is disposed (a renderer left
      // alive claims the next arm's meshes), so every arm recompiles its shader variants from
      // scratch -- and a variant link takes far more than four discarded frames.
      // A CPatch arm can read more than twice as slow when it follows another engine as when it is repeated,
      // which is the link showing up inside the measured window rather than anything about CPatch.
      if (k>=WARM) { ts.push(dt); tsCpu.push(dtCpu); }
      await window.__gpuIdle(dt); }   // THE THROTTLE, after the clock stopped (test/_gpuThrottle.mjs)
    if (${REPEAT} > 1) { r.beginFrame([1,1,1,1]); r.drawBundle(b); r.endFrame(); }   // the quality frame: one draw, whatever REPEAT timed
    const p=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p);
    // AND THE SAME FRAME ON A CONTRASTING GROUND. Over an opaque white clear a half-alpha blue and
    // an opaque pale blue are the SAME pixel, so every alpha error in the engine is invisible to a
    // white-ground comparison -- and the alpha channel itself is never read, because the clear makes
    // it 1 everywhere. Rendering again over a dark ground and comparing both against references
    // composited onto both grounds separates the two: a pixel whose error CHANGES with the ground
    // has the wrong alpha, and a pixel whose error is the same on both has the wrong colour.
    if (${JSON.stringify(!!process.env.PAGELOG)}) console.log('STAGE ' + arm + ' timed-done ' + Math.round(performance.now()));
    let p2 = null, glTally = null, lbRoute = 0, lbReal = 0;
    if (${JSON.stringify(process.env.GROUND2 !== '0')}) {
      const lbr0 = (r.debugStats && r.debugStats.loopBlinnRouteCount) | 0;
      window.__glTally = {};
      r.beginFrame(GROUND2); r.drawBundle(b); r.endFrame();
      glTally = window.__glTally; window.__glTally = null;
      lbRoute = ((r.debugStats && r.debugStats.loopBlinnRouteCount) | 0) - lbr0;
      lbReal = b._lbMeshes ? b._lbMeshes.filter((m) => m && !m.slug && (m.vertexCount | 0) > 0).length : 0;
      p2 = new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,p2);
    }
    // BLAME: the same arm again, every shape repainted with its own INDEX, so a wrong pixel can be
    // charged to the shape that PUT IT THERE. The reference names the shape that SHOULD own a
    // pixel, which is the wrong end of an over-paint: the ink belongs to whatever painted over it.
    let who = null;
    if (${BLAME}) {
      const sec2 = await importSvg(svg, { preserveViewport: true, ...GWN_IMPORT });
      const mm2 = parseMetaBin(sec2.meta, sec2.metaFloatsPerShape);
      const MF3 = mm2.metaFloats, ST3 = mm2.floatsPerShape | 0;
      for (let s3 = 0; s3 < mm2.numShapes; s3++) {
        const o3 = s3 * ST3;
        MF3[o3 + 4] = ((s3 >> 4) & 15) / 255; MF3[o3 + 5] = (s3 & 15) / 255; MF3[o3 + 6] = 128 / 255;
        if (MF3[o3 + 7] > 0) MF3[o3 + 7] = 1;
      }
      clearLbMeshCaches();
      const BOPT = window.__BOPT || {};
      const r2 = createRenderer(gl, shaders, Object.assign({}, opts, window.__ROPT || {}));
      if (r2.setLoopBlinnFill) r2.setLoopBlinnFill(arm==='lb'?'on':arm==='lbonly'?'only':(arm==='slug'||arm==='aac'||arm.slice(0,3)==='gwn')?'off':'auto');
    // KERNEL PINS go through the renderer's own selector (setFillEngine), so a pinned arm takes the route auto would take.
    if (({bandhard:1,treehard:1})[arm] && r2.setFillEngine) r2.setFillEngine({ kernel: arm === 'bandhard' ? 'hard-band' : 'hard-tree' });
      const b2 = createBundle(gl, sec2, BOPT);
      if (r2.prepareBundle) r2.prepareBundle(b2);
      if (arm==='cpatch'){ let w=0; while(b2._cpatchConv==='pending' && w<60000){ await sleepP(5); w+=5; }
        if (r2.prepareBundle) r2.prepareBundle(b2); }
      if (r2.awaitLbReady) await r2.awaitLbReady(b2);
      r2.setViewport(N,N); gl.viewport(0,0,N,N);
      r2.beginFrame([1,1,1,1]); r2.drawBundle(b2); r2.endFrame();
      who=new Uint8Array(N*N*4); gl.readPixels(0,0,N,N,gl.RGBA,gl.UNSIGNED_BYTE,who);
      b2.dispose();
    }
    const draws=(r.debugStats&&r.debugStats.engines&&r.debugStats.engines.draws)||{};
    if (${JSON.stringify(!!process.env.CULLINFO)}) console.log('CULLINFO culled=' + JSON.stringify(b._culledShapes ? [...b._culledShapes].sort((x, y) => x - y) : null)
      + ' drawList=' + (b.drawList ? b.drawList.length : 'n/a') + ' numShapes=' + (b.numShapes|0)
      + ' cullGen=' + (b._cullGen|0) + ' pending=' + !!b._occlusionCullPending + ' cpatchBuilt=' + (b._cpatchBuilt|0));
    // MESHHASH=1: one hash per shape of what the GPU is actually handed, so two builds of the same asset
    // can be diffed shape by shape instead of argued about.
    if (${JSON.stringify(!!process.env.MESHHASH)}) {
      const fnv = (a) => { let h = 2166136261 >>> 0; if (!a) return 0;
        const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619) >>> 0; return h; };
      const rows = [];
      (b._lbMeshes || []).forEach((m, si) => { if (m) rows.push(si + ':' + (m.vertexCount|0) + ':' + fnv(m.verts).toString(16)); });
      console.log('MESHHASH ' + rows.join(' '));
    }
    // THE FIT THE RENDERER ACTUALLY USED. It maps the bundle's CONTENT bbox onto the canvas with an
    // aspect-preserving scale -- not the viewBox -- so a reference built from the viewBox is
    // misaligned, and every engine then reads as ~98k wrong interior pixels because the REFERENCE
    // is in the wrong place. Reported from the page so there is one source of truth for it.
    out.bbox = Array.from(b.globalBBox);
    b.dispose();
    // DISPOSE THE RENDERER TOO. Renderers register themselves as mesh builders and claim a
    // bundle's fill meshes, so one left alive from a previous arm can claim the next arm's bundle
    // before its own engine does -- a 'slug' arm followed by a 'cpatch' arm produced a CPatch arm
    // drawing entirely Slug, and reporting Slug's zero wrong pixels under CPatch's name. Disposing
    // also drops the LB caches, which the reset above wants anyway.
    if (r.dispose) { try { r.dispose(); } catch (e) { } }
    // AND THE FIRST ARM OF A PAGE IS NOT A FRAME TIME AT ALL, whatever the minimum says. An arm
    // that has no CPatch arm before it reads 4.7-4.9 ms on tiger at 512px; the SAME arm, run again
    // in the same page, reads 2.40. That is not warm-up inside the arm and no frame count fixes
    // it -- 14, 24, 48 and 96 frames all report 4.7-4.8 for a lone arm, because the minimum over
    // ninety-six samples is still ninety-six slow samples. It is driver state that outlives the
    // renderer: every arm builds and disposes its own, so the first one in a page pays for
    // whatever the second one finds already there.
    //
    // Two rules follow, and ignoring them cost this session most of a day:
    //   * NEVER compare arms at different POSITIONS. A sweep reading 4.90, 2.70, 2.60, 2.40 down
    //     the ARMS list is measuring the list, not the knob -- reversing the order reproduced the
    //     same ladder on the reversed knobs.
    //   * To compare two configurations, give each its OWN page with the same arm repeated three
    //     times and read the second and third. ARMS='X,X,X' against ARMS='Y,Y,Y'.
    // The gap is engine-specific and worth knowing on its own: LB pays 2.60 -> 2.20 for it and
    // CPatch pays 4.90 -> 2.40, so CPatch's first render after a fresh renderer really is twice
    // its steady-state frame.
    //
    // THE MINIMUM, NOT THE MEDIAN. A median moves with WHERE IN THE RUN its samples sit, and these
    // arms do not run at a constant clock: the same build read 5.20 ms at FRAMES=40 and 2.50 ms at
    // FRAMES=48, and discarding MORE warm-up frames made it read HIGHER, not lower -- the arm gets
    // slower as it runs, which is the GPU ramping rather than anything about the engine. The
    // fastest frame is the one least contaminated by that, and it is stable across frame counts.
    ts.sort((a,b2)=>a-b2);
    let s2=''; for(let i=0;i<p.length;i+=4096) s2+=String.fromCharCode.apply(null,p.subarray(i,i+4096));
    let w2=''; if (who) for(let i=0;i<who.length;i+=4096) w2+=String.fromCharCode.apply(null,who.subarray(i,i+4096));
    // WHY AN ENGINE DID NOT DRAW, in the line that says it did not. A CPatch bundle whose pooled
    // conversion never lands reports conv=pending with no error anywhere, and without this the
    // only symptom is the arm quietly measuring Slug.
    const _vk = ((r.debugStats && r.debugStats.fillVariantKey) ? 'lean' : 'n/a')
              + ' conv=' + (b._cpatchConv === 'pending' ? 'PENDING'
                : (b._cpatchConv instanceof Map ? ('Map(' + b._cpatchConv.size + ')') : String(b._cpatchConv)))
              + ' rules=' + ((b._cpatchRules || []).length)
              // HOW MANY SHAPES ACTUALLY GOT A MESH. cpatchBuild skips a shape whose pack fails and
              // keeps going, so the mesh array has HOLES -- and a hole is not a refusal: the shape is
              // not drawn by anything, and whatever is underneath shows through as an exact
              // neighbouring colour. That reads as a wrong-solid blob and looks nothing like a
              // decline, which is why it went unnoticed.
              + ' meshes=' + ((b._lbMeshes || []).filter(Boolean).length) + '/' + (b.numShapes | 0)
              // PATCHES THE PACKER THREW AWAY. A dropped patch is ink that never reaches the
              // rasterizer, and no fence or cover knob can bring it back -- which is what separates
              // it from every other way CPatch loses pixels.
              + ' dropped=' + (b._cpatchDropped | 0) + ' unresolved=' + (b._cpatchUnresolved | 0)
              + (b._cpatchBail ? (' BAIL[' + b._cpatchBail + ']') : '')
              + (Object.keys(GLC).length ? ' gl=' + JSON.stringify(Object.fromEntries(
                  Object.entries(GLC).filter(([, v]) => v > 0))) : '');
    let s3=''; if (p2) for(let i=0;i<p2.length;i+=4096) s3+=String.fromCharCode.apply(null,p2.subarray(i,i+4096));
    tsCpu.sort((x, y) => x - y);
    out[_ai]={px:btoa(s2), px2: p2?btoa(s3):null, ms:ts[0], msMed:ts[ts.length>>1], msMax:ts[ts.length-1],
              cpuMed: tsCpu.length ? tsCpu[tsCpu.length >> 1] : null,
              via: JSON.stringify((r.debugStats && r.debugStats.engines && r.debugStats.engines.viaRoute) || null),
              uniDraws: ((r.debugStats && r.debugStats.unifiedFillDraws) | 0) - uniDraws0,
              vkey:String(_vk), draws:JSON.stringify(draws), who: who?btoa(w2):null,
              fvk:String((r.debugStats && (r.debugStats.drawnFillVariantKey || r.debugStats.fillVariantKey)) || ''),
              glTally: JSON.stringify(glTally), lbRoute, lbReal, hasCpatch: ('_cpatchConv' in b) || !!(r.debugStats && r.debugStats.engines) || b._cpatchBuilt !== undefined   /* NOWORKER converts on the main thread and never sets _cpatchConv */,
              hasLedger: !!(r.debugStats && r.debugStats.engines)};
  }
  return out;
};
</script></body></html>`;

const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  if (u === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(HTML);
  }
  try {
    const p = path.join(PAGE_ROOT, u);
    if (!p.startsWith(PAGE_ROOT)) throw new Error('esc');
    const body = readFileSync(p);
    const ct =
      u.endsWith('.js') || u.endsWith('.mjs')
        ? 'text/javascript'
        : u.endsWith('.glsl') || u.endsWith('.wgsl')
          ? 'text/plain'
          : 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('no');
  }
});
await new Promise((z) => srv.listen(0, z));
const browser = await launchBrowser({
  headless: 'new',
  args: ['--use-gl=angle', '--use-angle=metal', '--enable-unsafe-webgpu', '--no-sandbox'],
});
const cap = capWallTime('_zzEnginePaint', async () => {
  await browser.close();
  srv.close();
});
const page = await browser.newPage();
// HANGSTACK's debugger is attached HERE, before the page runs: a renderer already spinning in a loop never answers
// Debugger.enable (attached later, it prints nothing at all), while an attached debugger's pause interrupts the loop.
const hangCdp = process.env.HANGSTACK ? await page.createCDPSession() : null;
// Chrome leaves callFrame.url empty; a frame names its script only by scriptId, resolved through scriptParsed.
const hangScripts = new Map();
if (hangCdp) {
  hangCdp.on('Debugger.scriptParsed', (ev) => hangScripts.set(ev.scriptId, ev.url));
  await hangCdp.send('Debugger.enable');
}
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
// AND THE PAGE'S own LOGS, under PAGELOG=1. Without this a console.log added to the renderer to
// answer "does this knob even reach the packer?" prints into a void, and the silence reads as "the
// code did not run" -- which is a different answer, and the one I took four times.
if (process.env.PAGELOG) page.on('console', (m) => console.log('[page] ' + m.text()));
// WHICH RESOURCE FAILED. Chrome's console says only "Failed to load resource: 404" -- on a release tree that is a module the
// page expects and the tree never had, and a failed module import leaves __run undefined until the protocol times out.
if (process.env.PAGELOG) {
  page.on('response', (r) => {
    if (r.status() >= 400) console.log('[page] HTTP ' + r.status() + ' ' + r.url());
  });
  page.on('requestfailed', (q) =>
    console.log(
      '[page] REQUEST FAILED ' + q.url() + ' ' + ((q.failure() && q.failure().errorText) || ''),
    ),
  );
}
// BUNDLE OPTIONS, so a composite-only defect can be tested against the things that only exist in
// a composite. occlusionCull drops a shape a later opaque one covers, and it decides that ONCE
// from static geometry -- a shape missing from the frame and present when drawn alone is exactly
// what that would look like. BOPT='{"occlusionCull":false}'.
await page.evaluateOnNewDocument(
  (o) => {
    window.__BOPT = o;
  },
  JSON.parse(process.env.BOPT || '{}'),
);
await page.evaluateOnNewDocument(
  (o) => {
    window.__ROPT = o;
  },
  JSON.parse(process.env.ROPT || '{}'),
);
// NOWORKER=1 removes Worker before anything reads it, which is how both engines' build paths decide
// whether to use a pool. A defect that survives this is in the geometry or the kernel; one that
// disappears is in what the pool converts, or in how its result is carried back.
if (process.env.NOWORKER)
  await page.evaluateOnNewDocument(() => {
    window.Worker = undefined;
  });
// WORKERALLOW / WORKERBLOCK: comma lists of URL substrings. NOWORKER removes every worker in the page, so a
// defect that vanishes under it has not yet been charged to any one of them; these let one class through
// at a time. A blocked constructor throws, which every pool here catches and falls back from.
if (process.env.WORKERLOG || process.env.WORKERALLOW || process.env.WORKERBLOCK)
  await page.evaluateOnNewDocument(
    (allow, block, log) => {
      const Real = window.Worker;
      if (!Real) return;
      const A = allow ? allow.split(',') : null,
        B = block ? block.split(',') : [];
      window.Worker = function (url, o) {
        const u = String(url);
        const ok = (!A || A.some((a) => u.includes(a))) && !B.some((b) => u.includes(b));
        if (log) console.log('WORKER ' + (ok ? 'spawn ' : 'BLOCKED ') + u.replace(/^.*\//, ''));
        if (!ok) throw new Error('worker blocked by probe: ' + u);
        return new Real(url, o);
      };
    },
    process.env.WORKERALLOW || '',
    process.env.WORKERBLOCK || '',
    !!process.env.WORKERLOG,
  );
await page.goto(`http://127.0.0.1:${srv.address().port}/`, { waitUntil: 'networkidle0' });
await page.waitForFunction('!!window.__run', { timeout: 120000 });
await installGpuThrottle(page);
console.log(gpuThrottleBanner());
// HANGSTACK=<seconds>: a page that has not answered by then is paused in the debugger and its JS stack printed, then resumed.
// A page stuck in a loop never reaches its next STAGE marker and its protocol call just times out, naming nothing; this names the
// function. No pause arriving means the main thread is idle: the page awaits a promise that never settles.
let hangTimer = null;
if (process.env.HANGSTACK)
  hangTimer = setTimeout(async () => {
    try {
      const c = hangCdp;
      let got = false;
      c.on('Debugger.paused', (ev) => {
        got = true;
        console.log(`HANGSTACK after ${process.env.HANGSTACK}s:`);
        for (const f of ev.callFrames.slice(0, 16))
          console.log(
            `   at ${f.functionName || '(anon)'}  ${String(f.url || hangScripts.get(f.location.scriptId) || '?').replace(/^.*?[/]src[/]/, 'src/')}:${f.location.lineNumber + 1}`,
          );
        c.send('Debugger.resume').catch(() => {});
      });
      await c.send('Debugger.pause');
      setTimeout(() => {
        if (!got)
          console.log(
            `HANGSTACK after ${process.env.HANGSTACK}s: no pause -- the main thread is idle, awaiting something that never settles`,
          );
      }, 8000);
    } catch (e) {
      console.log('HANGSTACK failed: ' + e.message);
    }
  }, 1000 * +process.env.HANGSTACK);
const got = await page.evaluate((s, a) => window.__run(s, a), SVG, ARMS);
if (hangTimer) clearTimeout(hangTimer);
cap.clear();
await browser.close();
srv.close();

// ---- the exact reference, composited in document order ----
const sec = await importSvg(SVG, { preserveViewport: true });
const cf = sec.curves64 ? new Float64Array(sec.curves64) : new Float32Array(sec.curves);
const meta = parseMetaBin(sec.meta, sec.metaFloatsPerShape);
const MF = meta.metaFloats,
  ST = meta.floatsPerShape | 0;
// THE INVERSE OF THE RENDERER'S own MAPPING (mantle.vert.glsl emToNdc + renderer.js arScale):
//   ndc.x = arX * (2 * (x - bb.x) / bb.w - 1)      ndc.y = arY * (1 - 2 * (y - bb.y) / bb.h)
// with the canvas square, arX = min(1, aspect) and arY = min(1, 1 / aspect). Pixel rows here are
// counted from the BOTTOM, the order readPixels returns, so nothing is flipped twice.
const bb = got.bbox;
const _sAR = bb[2] / bb[3];
const arX = _sAR > 1 ? 1 : _sAR,
  arY = _sAR > 1 ? 1 / _sAR : 1;
const emX = (i) => bb[0] + ((((2 * (i + 0.5)) / N - 1) / arX + 1) / 2) * bb[2];
const emY = (jb) => bb[1] + ((1 - ((2 * (jb + 0.5)) / N - 1) / arY) / 2) * bb[3];
// One pixel's footprint in em, per axis.
const SCX = bb[2] / (arX * N),
  SCY = bb[3] / (arY * N);
const SC = Math.max(SCX, SCY);
const GL5 = [
  [-0.906179845938664, 0.2369268850561891],
  [-0.5384693101056831, 0.4786286704993665],
  [0, 0.5688888888888889],
  [0.5384693101056831, 0.4786286704993665],
  [0.906179845938664, 0.2369268850561891],
];
const shapes = [];
for (let s = 0; s < meta.numShapes; s++) {
  const o = s * ST,
    r = sec.curveRangesByShape && sec.curveRangesByShape[s];
  if (!r || !(MF[o + 7] > 0)) {
    shapes.push(null);
    continue;
  }
  let cs = null;
  try {
    cs = contoursToConverter(curveRangeToContours(cf, r.begin | 0, r.end | 0), null);
  } catch {
    cs = null;
  }
  if (!cs || !cs.length) {
    shapes.push(null);
    continue;
  }
  const all = [];
  for (const c of cs) for (const sg of c) all.push(sg);
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const sg of all)
    for (const P of sg.P) {
      if (P[0] < x0) x0 = P[0];
      if (P[0] > x1) x1 = P[0];
      if (P[1] < y0) y0 = P[1];
      if (P[1] > y1) y1 = P[1];
    }
  shapes.push({
    i: s,
    segs: all,
    rgb: [MF[o + 4] * 255, MF[o + 5] * 255, MF[o + 6] * 255],
    a: MF[o + 7],
    evenOdd: MF[o + 13] > 0.5,
    bb: [x0, y0, x1, y1],
  });
}
// THE SHAPE'S own FILL RULE. rowSpans folds crossings by the NONZERO rule, and asking it about an
// even-odd shape says a hole is filled -- so the reference is wrong exactly where the engines are
// right, and every number taken from it on such an asset is noise. complex_nested is one compound
// even-odd path (square + circle + self-intersecting star) and read 286 "wrong" pixels owned by no
// shape at all, which is what a wrong reference looks like.
const spansOf = (sh, y) => {
  if (!sh.evenOdd) return rowSpans(sh.segs, y) || [];
  const xs = [];
  for (const sg of sh.segs) rowCross(sg, y, (x) => xs.push(x));
  xs.sort((p, q) => p - q);
  const out = [];
  for (let k = 0; k + 1 < xs.length; k += 2)
    if (xs[k + 1] - xs[k] > 1e-9) out.push([xs[k], xs[k + 1]]);
  return out;
};
// How far a pixel's error may move with the ground before its ALPHA is called wrong. A correct
// engine's error is ground-independent to within the rounding of two composites.
const ALPHA_BAD = +(process.env.ALPHA_BAD || 8);
// Deliberately wrong reference alpha, to prove the ALPHA metric is not vacuous.
const REF_ALPHA_SCALE = +(process.env.REF_ALPHA_SCALE || 1);
const ref = new Uint8Array(N * N * 3);
// The same reference on the page's second ground, and the reference's own ALPHA. Must stay in step
// with GROUND2 in the page source above. refA is the drawing's alpha AS AUTHORED -- REF_ALPHA_SCALE
// does not touch it -- because it classifies pixels (solid or not), and the non-vacuity check has to
// move the reference's colors without moving which pixels it is judged on.
const G2 = [0.04 * 255, 0.22 * 255, 0.55 * 255];
const refB = new Uint8Array(N * N * 3);
const refA = new Uint8Array(N * N);
const owner = new Int16Array(N * N).fill(-1); // the last shape to put ink in this pixel
const featW = new Float32Array(N * N).fill(Infinity); // narrowest covering span, in pixels
for (let j = 0; j < N; j++) {
  const cy = emY(j);
  for (let i = 0; i < N; i++) {
    const cx = emX(i);
    let pr = 0,
      pg = 0,
      pb = 0,
      pa = 0,
      pa1 = 0; // premultiplied, over TRANSPARENT
    for (const sh of shapes) {
      if (!sh) continue;
      if (cx < sh.bb[0] - SC || cx > sh.bb[2] + SC || cy < sh.bb[1] - SC || cy > sh.bb[3] + SC)
        continue;
      let t = 0,
        wNar = Infinity;
      for (const [q, w] of GL5) {
        const y = cy + 0.5 * SCY * q;
        let c2 = 0;
        for (const sp of spansOf(sh, y)) {
          c2 += Math.max(0, Math.min(cx + SCX / 2, sp[1]) - Math.max(cx - SCX / 2, sp[0]));
          // THE LOCAL FEATURE WIDTH, for the span this pixel actually sits in. A half-pixel error on
          // a fat edge is invisible and on a hairline it IS the feature, so the two must not be
          // averaged together.
          if (cx >= sp[0] - SCX && cx <= sp[1] + SCX) wNar = Math.min(wNar, (sp[1] - sp[0]) / SCX);
        }
        t += (w * 0.5 * c2) / SCX;
      }
      const a1 = Math.min(1, Math.max(0, t)) * sh.a,
        a = a1 * REF_ALPHA_SCALE;
      if (a1 > 0) pa1 = a1 + pa1 * (1 - a1);
      if (a <= 0) continue;
      if (Number.isFinite(wNar) && wNar < featW[j * N + i]) featW[j * N + i] = wNar;
      // OVER, in premultiplied form. Starting from white and doing R += (rgb-R)*a is the same
      // thing specialized to one ground; this keeps the ground out of the accumulation so it can be
      // substituted afterwards, exactly, for any ground.
      pr = sh.rgb[0] * a + pr * (1 - a);
      pg = sh.rgb[1] * a + pg * (1 - a);
      pb = sh.rgb[2] * a + pb * (1 - a);
      pa = a + pa * (1 - a);
      if (a > 0.5) owner[j * N + i] = sh.i;
    }
    const k = (j * N + i) * 3;
    ref[k] = Math.round(pr + (1 - pa) * 255);
    ref[k + 1] = Math.round(pg + (1 - pa) * 255);
    ref[k + 2] = Math.round(pb + (1 - pa) * 255);
    refB[k] = Math.round(pr + (1 - pa) * G2[0]);
    refB[k + 1] = Math.round(pg + (1 - pa) * G2[1]);
    refB[k + 2] = Math.round(pb + (1 - pa) * G2[2]);
    refA[j * N + i] = Math.round(pa1 * 255);
  }
}
if (OUT) writeFileSync(`${OUT}_ref.raw`, Buffer.from(ref));

// A pixel the outline does not run through: the reference agrees with all eight neighbours.
const flat = new Uint8Array(N * N);
for (let j = 0; j < N; j++)
  for (let i = 0; i < N; i++) {
    let same = 1;
    const k = (j * N + i) * 3;
    for (let dj = -1; dj <= 1 && same; dj++)
      for (let di = -1; di <= 1; di++) {
        const jj = j + dj,
          ii = i + di;
        if (jj < 0 || jj >= N || ii < 0 || ii >= N) continue;
        const k2 = (jj * N + ii) * 3;
        if (
          Math.abs(ref[k] - ref[k2]) > 2 ||
          Math.abs(ref[k + 1] - ref[k2 + 1]) > 2 ||
          Math.abs(ref[k + 2] - ref[k2 + 2]) > 2
        ) {
          same = 0;
          break;
        }
      }
    flat[j * N + i] = same;
  }
let nFlat = 0;
for (let i = 0; i < N * N; i++) nFlat += flat[i];

console.log(
  `  viewBox ${JSON.stringify(got.vb)}  content bbox ${JSON.stringify(bb.map((v) => +v.toFixed(2)))}  arX ${arX.toFixed(4)} arY ${arY.toFixed(4)}`,
);
console.log(
  `${path.basename(SVGP)} at ${N}px   reference: ${nFlat} interior px, ${N * N - nFlat} edge px`,
);
if (REF_LACKS.length)
  console.log(
    `  REFERENCE LACKS ${REF_LACKS.join(', ')} -- wrong/outside/AA are not quality for this asset`,
  );
if (PAGE_ROOT !== ROOT) console.log(`  PAGE_ROOT ${PAGE_ROOT}`);
// FIDELITY: when auto picks a kernel that an arm also pins, the two must be the same draw -- same engines, same counts -- or
// the pinned arm measured something auto does not ship. Printed after the arms; a mismatch is the harness's error, not data.
process.on('beforeExit', () => {
  if (globalThis.__fidelityDone) return;
  globalThis.__fidelityDone = true;
  const rows = ARMS.map((sp, i) => ({ sp, arm: sp.split(':')[0], g: got[i] })).filter((x) => x.g);
  const fillSet = (d) =>
    Object.keys(d)
      .filter((k) => (d[k] | 0) > 0 && k !== 'stroke' && k !== 'inert')
      .sort()
      .join('+');
  for (const a of rows.filter((x) => x.arm === 'auto')) {
    const da = JSON.parse(a.g.draws || '{}'),
      pick = fillSet(da);
    for (const b of rows.filter((x) => x.arm === 'bandhard' || x.arm === 'treehard')) {
      const db = JSON.parse(b.g.draws || '{}');
      // A REFUSED pin (a tree pin on a bundle with no tree draws band-hard) is not an arm of that engine; skip it.
      const want = b.arm === 'bandhard' ? 'hard-band' : 'hard-tree';
      if (fillSet(db) !== want) continue;
      if (fillSet(db) !== pick) continue;
      const same = JSON.stringify(da) === JSON.stringify(db);
      console.log(
        `FIDELITY ${a.sp} picked ${pick} = ${b.sp}: draws ${same ? 'IDENTICAL' : 'DIFFER ' + a.g.draws + ' vs ' + b.g.draws}` +
          `  ms ${Number(a.g.ms).toFixed(2)} vs ${Number(b.g.ms).toFixed(2)} (x${(b.g.ms / a.g.ms).toFixed(2)})`,
      );
    }
  }
});
for (let ai = 0; ai < ARMS.length; ai++) {
  const spec = ARMS[ai];
  const arm = spec.split(':')[0];
  // A dump carries the whole spec: two arms of one engine on different routes (slug, slug:opt.unifiedFill=0) wrote one file.
  const dumpName = spec.replace(/[^A-Za-z0-9_.=-]/g, '_');
  if (!got[ai]) {
    console.log(`${spec}: (no frame)`);
    continue;
  }
  // DID this ARM DRAW WITH THE ENGINE IT NAMES? An engine that declined and fell back renders
  // CORRECTLY, so its numbers look like a triumph -- zero wrong pixels under the failing engine's
  // name. The draw tally is the evidence and it is checked, not assumed.
  const _dr = JSON.parse(got[ai].draws || '{}');
  // DID this ARM DRAW WITH THE ENGINE IT NAMES? Proven from the renderer's own engine ledger where it keeps one, and otherwise from
  // the PROGRAMS the untimed proof frame bound (an older release may keep no engine ledger). A fallback renders correctly, so an unproven
  // arm's numbers would read as a triumph under the wrong name.
  const _gt = JSON.parse(got[ai].glTally || 'null'),
    _ledger = !!got[ai].hasLedger;
  let _refuse = null;
  if (arm === 'cpatch' && !got[ai].hasCpatch) _refuse = 'CPATCH — not in this build';
  else if (arm === 'cpatch' && !(_dr.cpatch > 0)) _refuse = `CPATCH — draws ${got[ai].draws}`;
  else if (arm === 'gwn' || arm === 'gwnhard') {
    const k = arm === 'gwn' ? 'GWN_SDF' : 'HARD_TREE',
      def = arm === 'gwn' ? 'MANTLE_GWN_SDF' : 'MANTLE_HARD_TREE';
    const ok = _gt ? (_gt[k] | 0) > 0 : String(got[ai].fvk || '').includes(def);
    if (!ok)
      _refuse = `${arm.toUpperCase()} — ${k} program draws ${_gt ? _gt[k] | 0 : 'n/a'}, variant ${JSON.stringify(got[ai].fvk)}`;
  } else if (arm === 'bandhard' || arm === 'treehard') {
    // STRICT: the pinned kernel must shade every fill draw. Its program drawing once is not enough -- a forced tree arm passed
    // that test while the frame went through the unified route with SDF discs and a Slug-attributed cover kernel.
    const want = arm === 'bandhard' ? 'hard-band' : 'hard-tree';
    const other = Object.keys(_dr).filter(
      (k) => (_dr[k] | 0) > 0 && k !== want && k !== 'stroke' && k !== 'inert',
    );
    if (!_ledger)
      _refuse = `${arm.toUpperCase()} — needs the draw ledger (pinning needs setFillEngine; not in this build)`;
    else if (!(_dr[want] > 0) || other.length)
      _refuse = `${arm.toUpperCase()} — draws ${got[ai].draws}: every fill draw must be ${want}`;
  } else if (arm === 'cpatchhard') {
    if (!(_dr.cpatch > 0 && _gt && (_gt.CPATCH_HARD | 0) > 0))
      _refuse = `CPATCH-HARD — draws ${got[ai].draws}, CPATCH_HARD program draws ${_gt ? _gt.CPATCH_HARD | 0 : 'n/a'}`;
  } else if (arm === 'aac') {
    const ok = _ledger ? _dr.aac > 0 : !!(_gt && (_gt.AAC | 0) > 0);
    if (!ok)
      _refuse = `AAC — draws ${got[ai].draws}, AAC program draws ${_gt ? _gt.AAC | 0 : 'n/a'}`;
  } else if (arm === 'lb' || arm === 'lbonly') {
    const ok = _ledger ? _dr.lb > 0 : got[ai].lbRoute > 0 && got[ai].lbReal > 0;
    if (!ok)
      _refuse = `LB — draws ${got[ai].draws}, route count +${got[ai].lbRoute}, real meshes ${got[ai].lbReal}`;
  }
  // __ROUTE=unified|cover: the arm must have drawn every fill through that route (strokes excepted), or it measured the other path.
  const _wantRoute = (spec.match(/__ROUTE=(unified|cover)/) || [])[1];
  if (!_refuse && _wantRoute) {
    const via = JSON.parse(got[ai].via || 'null');
    const fillKeys = via
      ? Object.keys(via).filter((k) => (via[k] | 0) > 0 && !/^(stroke|inert)@/.test(k))
      : [];
    const off = fillKeys.filter((k) => !k.endsWith('@' + _wantRoute));
    if (!via) _refuse = `ROUTE ${_wantRoute} — no route ledger in this build`;
    else if (!fillKeys.length || off.length) _refuse = `ROUTE ${_wantRoute} — drew ${got[ai].via}`;
  }
  if (_refuse) {
    console.log(
      `${spec}: DID NOT DRAW WITH ${_refuse}. Numbers withheld; this arm measured something else.`,
    );
    console.log(`        draws ${got[ai].draws}  gl ${got[ai].glTally}  ${got[ai].vkey}`);
    continue;
  }
  const px = Buffer.from(got[ai].px, 'base64');
  // VS FIRST ARM (KEEPSTROKES): with strokes kept, the fill-only reference is not the truth -- the AA frame of the first arm
  // is. A hard fill under an opaque stroke should differ from it nowhere; where it does, a jagged edge shows past the stroke.
  if (KEEPSTROKES) {
    if (!globalThis.__firstFrame) {
      globalThis.__firstFrame = px;
      globalThis.__firstArm = spec;
    } else {
      const f0 = globalThis.__firstFrame;
      let d3 = 0,
        d5 = 0,
        dMax = 0,
        dSum = 0;
      for (let q = 0; q < N * N; q++) {
        const s4 = q * 4;
        let d = 0;
        for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(px[s4 + c] - f0[s4 + c]));
        if (d > 0.3 * 255) {
          d3++;
          if (d > 0.5 * 255) d5++;
        }
        if (d > dMax) dMax = d;
        dSum += d;
      }
      got[ai].vsFirst =
        `VS ${globalThis.__firstArm}  over0.3 ${d3}  over0.5 ${d5}  max ${(dMax / 255).toFixed(3)}  mean ${(dSum / (N * N) / 255).toFixed(5)}`;
    }
  }
  if (OUT && got[ai].who)
    writeFileSync(`${OUT}_${dumpName}_who.raw`, Buffer.from(got[ai].who, 'base64'));
  const px2 = got[ai].px2 ? Buffer.from(got[ai].px2, 'base64') : null;
  if (OUT) writeFileSync(`${OUT}_${dumpName}.raw`, px);
  let bad = 0,
    aaSum = 0,
    aaN = 0,
    aaMax = 0,
    aaMaxAt = -1,
    aa30 = 0,
    aa50 = 0,
    jag = 0,
    jagV = 0,
    jagHV = 0;
  const fwN = [0, 0, 0, 0],
    fwSum = [0, 0, 0, 0],
    fwMax = [0, 0, 0, 0],
    fwAt = [-1, -1, -1, -1],
    fw30 = [0, 0, 0, 0];
  const jagW = [0, 0, 0, 0];
  const jagAt = [];
  const isBad = new Uint8Array(N * N);
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      const q = j * N + i; // both are bottom-up: no flip
      const s = q * 4,
        k = q * 3;
      const d = Math.max(
        Math.abs(px[s] - ref[k]),
        Math.abs(px[s + 1] - ref[k + 1]),
        Math.abs(px[s + 2] - ref[k + 2]),
      );
      if (flat[q]) {
        if (d > SOLID_BAD) {
          bad++;
          isBad[q] = 1;
        }
      } else {
        aaSum += d;
        aaN++;
        if (d > aaMax) {
          aaMax = d;
          aaMaxAt = q;
        }
        // BY FEATURE WIDTH. Aliasing that matters is aliasing on fine detail; a total over every edge
        // pixel lets a thousand half-pixel differences on fat edges drown out the handful of whole-
        // feature errors on hairlines, which are the ones anyone can see.
        const fw = featW[q];
        const bi = fw < 1 ? 0 : fw < 2 ? 1 : fw < 4 ? 2 : 3;
        fwN[bi]++;
        fwSum[bi] += d;
        if (d > fwMax[bi]) {
          fwMax[bi] = d;
          fwAt[bi] = q;
        }
        if (d > 0.3 * 255) fw30[bi]++;
        // JAGGEDNESS: a spike whose neighbours ALONG THE EDGE are both much better is what reads as a
        // stair-step, as against a ramp that is simply offset. Measured on the signed error so an
        // over/under alternation counts and a uniform bias does not.
        //
        // both AXES, because a stair-step is only visible across the edge it steps along: a defect on
        // a near-horizontal boundary spikes against its pixels ABOVE and BELOW and a horizontal-only
        // test cannot see it at all. Either axis counts the pixel once.
        {
          const sg = (qq) => {
            const k3 = qq * 3,
              s3 = qq * 4;
            return (px[s3] - ref[k3] + (px[s3 + 1] - ref[k3 + 1]) + (px[s3 + 2] - ref[k3 + 2])) / 3;
          };
          const e1 = sg(q);
          const spike = (a2, b2) =>
            Math.abs(e1 - a2) > 0.25 * 255 &&
            Math.abs(e1 - b2) > 0.25 * 255 &&
            (e1 - a2) * (e1 - b2) > 0;
          if (Math.abs(e1) > 0.25 * 255) {
            const h = i > 0 && i < N - 1 && spike(sg(q - 1), sg(q + 1));
            const v = j > 0 && j < N - 1 && spike(sg(q - N), sg(q + N));
            if (h || v) {
              jag++;
              jagW[bi]++;
              jagAt.push(q);
              if (h && v) jagHV++;
              else if (v) jagV++;
            }
          }
        }
        // BUCKETS, not just a mean and a max. A mean hides how many pixels are badly wrong and a max
        // is one pixel; what an edge looks like is decided by how many of its pixels are off by
        // enough to see, so the counts past 0.3 and 0.5 of a channel are the quality number.
        if (d > 0.3 * 255) {
          aa30++;
          if (d > 0.5 * 255) aa50++;
        }
      }
    }
  // Components, so a count becomes a list of places to look.
  const seen = new Uint8Array(N * N);
  const comps = [];
  for (let q0 = 0; q0 < N * N; q0++) {
    if (!isBad[q0] || seen[q0]) continue;
    const st = [q0];
    seen[q0] = 1;
    let n = 0,
      sx = 0,
      sy = 0,
      own = -1;
    while (st.length) {
      const q = st.pop();
      n++;
      const i = q % N,
        j = (q / N) | 0;
      sx += i;
      sy += j;
      if (own < 0) own = owner[q];
      for (const [di, dj] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const ii = i + di,
          jj = j + dj;
        if (ii < 0 || ii >= N || jj < 0 || jj >= N) continue;
        const q2 = jj * N + ii;
        if (isBad[q2] && !seen[q2]) {
          seen[q2] = 1;
          st.push(q2);
        }
      }
    }
    comps.push({ n, x: Math.round(sx / n), y: Math.round(sy / n), own });
  }
  comps.sort((a, b) => b.n - a.n);
  const aaMaxXY = aaMaxAt >= 0 ? `(${aaMaxAt % N},${(aaMaxAt / N) | 0})` : '';
  // A frame time is a nicety; a missing one must not take the measurement down with it. FRAMES
  // below the warm-up leaves no sample, and the crash that followed hid every number the run had.
  console.log(
    `${spec.padEnd(7)} ${Number.isFinite(got[ai].ms) ? got[ai].ms.toFixed(2) : '  -  '} ms  (med ${Number(got[ai].msMed).toFixed(2)} max ${Number(got[ai].msMax).toFixed(2)})  draws ${got[ai].draws}  vkey=${got[ai].vkey}`,
  );
  // GLTALLY=1: the programs the untimed proof frame bound, on every arm -- a proof that passes should still show WHAT drew.
  if (process.env.GLTALLY) console.log(`        gl ${got[ai].glTally}`);
  if (got[ai].via && got[ai].via !== 'null')
    console.log(
      `        route ${got[ai].via}  unified draws ${got[ai].uniDraws | 0}  cpu med ${got[ai].cpuMed == null ? '-' : Number(got[ai].cpuMed).toFixed(2)} ms`,
    );
  if (got[ai].vsFirst) console.log(`        ${got[ai].vsFirst}`);
  // WRONG SOLID IS A COUNT AT ONE RESOLUTION, and it is flattered by the small one. A pixel is
  // only eligible for it where the REFERENCE is a solid interior, so ink a pixel outside the
  // outline is an edge pixel at 512 and a solid one at 768, and the same defects report 2 and 21.
  // Counting everything badly wrong -- this plus AA over 0.5 -- gives 28 and 46, which tracks the
  // resolution rather than any change in the artwork, so that is the number to compare across
  // sizes. Quote N with any of these, and check a second N before believing a small count.
  // COMPONENT COORDINATES ARE IN BOTTOM-UP ROWS -- the readPixels order the component search walks -- while the
  // AA max below is printed top-down. Reading a component's pixel with a flip lands a whole row-mirror away, and
  // on a one-pixel component that reads as "nothing wrong here". The values are kept bottom-up because the WHY
  // block further down reads them that way; the label says so.
  console.log(
    `        WRONG SOLID ${bad} px in ${comps.length} components [rows bottom-up]` +
      (comps.length
        ? '  |  ' +
          comps
            .slice(0, 6)
            .map((c) => `${c.n}px@(${c.x},${c.y})s${c.own}`)
            .join(' ')
        : ''),
  );
  // INK WHERE THE PATH HAS NONE. WRONG SOLID needs a shape UNDER the defect to notice it, so on an
  // isolated drawing a leak past a patch's own boundary is invisible to it -- and "painted outside"
  // is exactly the bar the cover fence exists to hold. Counted against the CLEAR color: a pixel the
  // ---- COLOR vs ALPHA, from the two grounds ----------------------------------------------
  // The same geometry composited onto two different grounds. An error that is the same on both is a
  // color error -- the engine put the wrong ink down. An error that CHANGES with the ground is an
  // ALPHA error: the engine's effective opacity is wrong, and on white that is invisible because
  // 1 - a multiplies a white ground into exactly the color a too-opaque pale fill would give.
  //
  // Measured as the ground-dependent part, |errDark - errWhite| per channel, which cancels any
  // color error common to both grounds.
  //
  // ON INTERIOR PIXELS only, and that restriction is what makes it mean anything. A COVERAGE error
  // at an edge is also ground-dependent -- the error is da * (color - ground) -- so an unrestricted
  // test cannot tell a half-pixel of AA from a wrong opacity, and every engine reported ~482 such
  // pixels on a translucent test card with the worst at the corner of an OPAQUE rectangle.
  // REF_ALPHA_SCALE is the non-vacuity check: it perturbs the reference's own alpha, and the count
  // must then jump for every engine.
  //
  // INTERIOR MEANS THE REFERENCE IS SOLID THERE, not merely flat on white. `flat` is
  // judged on the WHITE-ground reference, and near-white ink over white is flat at ANY coverage: the
  // silhouette of a pale shape is invisible on white, so its edge pixels would pass as interior and every
  // engine's AA error on them would move with the ground and read as interior error. A CPU painter's
  // composite of the kernels' own coverage (the package GLSL in float32, one draw, src-over, LEQUAL on
  // a per-shape z that only ever lets a later shape through) reproduces such counts to the pixel, and
  // every one of those pixels has reference alpha below 1. Restricted to refA = 255,
  // it is 0 for Slug, AAC and the exact coverage alike (test/alphaInteriorMetricSmoke.mjs). The edge
  // pixels are still worth seeing -- they are AA error the white ground hides -- so they are counted,
  // separately, as EDGE.
  if (px2) {
    let aBad = 0,
      aMax = 0,
      aMaxAt = -1,
      cBad = 0,
      eBad = 0,
      eMax = 0;
    for (let q = 0; q < N * N; q++) {
      if (!flat[q]) continue;
      const s4 = q * 4,
        k3 = q * 3;
      let gd = 0,
        cm = 1e9;
      for (let c = 0; c < 3; c++) {
        const eW = px[s4 + c] - ref[k3 + c],
          eD = px2[s4 + c] - refB[k3 + c];
        gd = Math.max(gd, Math.abs(eD - eW));
        cm = Math.min(cm, Math.max(Math.abs(eW), Math.abs(eD)) - Math.abs(eD - eW));
      }
      if (gd > ALPHA_BAD && refA[q] < 255) {
        eBad++;
        if (gd > eMax) eMax = gd;
      } else if (gd > ALPHA_BAD) {
        aBad++;
        if (gd > aMax) {
          aMax = gd;
          aMaxAt = q;
        }
      } else if (cm > SOLID_BAD) cBad++;
    }
    const at = aMaxAt < 0 ? '' : ` @(${aMaxAt % N},${N - 1 - ((aMaxAt / N) | 0)})`;
    console.log(
      `        ALPHA  ${aBad} interior px whose error moves with the ground ` +
        `(max ${(aMax / 255).toFixed(3)}${at})   COLOR-only ${cBad} px   ` +
        `EDGE ${eBad} flat-on-white px of pale ink whose AA error moves with the ground (max ${(eMax / 255).toFixed(3)})`,
    );
  }
  // reference leaves untouched and the engine inked.
  {
    let outInk = 0,
      outMax = 0,
      outAt = -1;
    for (let q = 0; q < N * N; q++) {
      const k = q * 3,
        s3 = q * 4;
      if (!(ref[k] > 250 && ref[k + 1] > 250 && ref[k + 2] > 250)) continue; // reference: empty
      const d = Math.max(255 - px[s3], 255 - px[s3 + 1], 255 - px[s3 + 2]);
      if (d > SOLID_BAD) {
        outInk++;
        if (d > outMax) {
          outMax = d;
          outAt = q;
        }
      }
    }
    console.log(
      `        PAINTED OUTSIDE ${outInk} px  max ${(outMax / 255).toFixed(3)}` +
        (outAt >= 0 ? ` @(${outAt % N},${(outAt / N) | 0})` : ''),
    );
  }
  // INK TOTAL: the whole frame's darkness against the reference's, in pixel-equivalents (sum of 765 - r - g - b, / 765),
  // split into the part the engine inks MORE than the reference and the part it inks LESS. For black-on-white text this is
  // total coverage: an engine that thickens sub-pixel stems puts a few percent on every edge pixel, which no per-pixel
  // threshold above counts, and a symmetric AA error nets to zero here while an over-cover does not.
  {
    let inkPx = 0,
      inkRef = 0,
      over = 0,
      under = 0;
    for (let q = 0; q < N * N; q++) {
      const k = q * 3,
        s4 = q * 4;
      const r0 = 765 - ref[k] - ref[k + 1] - ref[k + 2],
        e0 = 765 - px[s4] - px[s4 + 1] - px[s4 + 2];
      inkRef += r0;
      inkPx += e0;
      if (e0 > r0) over += e0 - r0;
      else under += r0 - e0;
    }
    const pct = (v) => (inkRef > 0 ? ((100 * v) / inkRef).toFixed(2) : '-');
    console.log(
      `        INK TOTAL ${(inkPx / 765).toFixed(1)} vs reference ${(inkRef / 765).toFixed(1)} px-eq  net ${inkRef > 0 ? (100 * (inkPx / inkRef - 1)).toFixed(2) : '-'}%` +
        `   over +${pct(over)}%  under -${pct(under)}%`,
    );
  }
  console.log(
    `        AA  over0.3 ${aa30}  over0.5 ${aa50}  max ${(aaMax / 255).toFixed(3)}${aaMaxXY}  mean ${(aaSum / Math.max(1, aaN) / 255).toFixed(4)}`,
  );
  // The same error, split by how fine the feature under it is.
  const FWL = ['under 1px', '1-2px', '2-4px', 'over 4px'];
  const _at = (q) => (q >= 0 ? `@(${q % N},${(q / N) | 0})s${owner[q]}` : '');
  const fwLine = FWL.map((L, b3) =>
    fwN[b3]
      ? `${L} n=${fwN[b3]} max ${(fwMax[b3] / 255).toFixed(3)}${_at(fwAt[b3])} mean ${(fwSum[b3] / fwN[b3] / 255).toFixed(4)} over0.3 ${fw30[b3]}`
      : `${L} -`,
  ).join('   ');
  console.log(`        FINE  ${fwLine}`);
  // Split the same way: a jaggy on a hairline is the feature, one on a wide edge is a seam.
  console.log(
    `        JAGGY ${jag} edge pixels spike against both neighbours along the edge ` +
      `(${jag - jagV - jagHV} across a vertical edge, ${jagV} across a horizontal one, ${jagHV} both)   by width: ` +
      FWL.map((L, b3) => `${L} ${jagW[b3]}`).join('  '),
  );
  // ARE THE JAGGIES AT THE SEAMS? Both engines cut a contour into per-segment primitives and
  // combine their coverage; Slug does not, and Slug has no jaggies. If the spikes sit at the
  // JOINTS between consecutive segments, the defect is the combination and one fix serves both
  // engines. The control is every edge pixel's distance to a joint -- without it, "most jaggies
  // are within 2px of a joint" says nothing, because most edge pixels might be.
  if (process.env.SEAM) {
    // A chamfer distance field over the pixel grid: joints number in the thousands and edge pixels
    // in the tens of thousands, and a two-pass sweep is exact enough to bucket by whole pixels.
    const DF = new Float32Array(N * N).fill(1e9);
    for (const sh of shapes) {
      if (!sh) continue;
      for (const sg of sh.segs) {
        const P0 = sg.P[0];
        if (!P0) continue;
        // The inverses of emX/emY -- emY flips, so a naive subtraction lands nothing on the grid.
        const u = (P0[0] - bb[0]) / bb[2],
          v2 = (P0[1] - bb[1]) / bb[3];
        const i2 = Math.round((N * ((2 * u - 1) * arX + 1)) / 2 - 0.5);
        const j2 = Math.round((N * ((1 - 2 * v2) * arY + 1)) / 2 - 0.5);
        if (i2 >= 0 && i2 < N && j2 >= 0 && j2 < N) DF[j2 * N + i2] = 0;
      }
    }
    const D1 = 1,
      D2 = Math.SQRT2;
    for (let j2 = 0; j2 < N; j2++)
      for (let i2 = 0; i2 < N; i2++) {
        const q2 = j2 * N + i2;
        let v = DF[q2];
        if (i2 > 0) v = Math.min(v, DF[q2 - 1] + D1);
        if (j2 > 0) {
          v = Math.min(v, DF[q2 - N] + D1);
          if (i2 > 0) v = Math.min(v, DF[q2 - N - 1] + D2);
          if (i2 < N - 1) v = Math.min(v, DF[q2 - N + 1] + D2);
        }
        DF[q2] = v;
      }
    for (let j2 = N - 1; j2 >= 0; j2--)
      for (let i2 = N - 1; i2 >= 0; i2--) {
        const q2 = j2 * N + i2;
        let v = DF[q2];
        if (i2 < N - 1) v = Math.min(v, DF[q2 + 1] + D1);
        if (j2 < N - 1) {
          v = Math.min(v, DF[q2 + N] + D1);
          if (i2 < N - 1) v = Math.min(v, DF[q2 + N + 1] + D2);
          if (i2 > 0) v = Math.min(v, DF[q2 + N - 1] + D2);
        }
        DF[q2] = v;
      }
    const dJoint = (q) => DF[q];
    const B2 = [0.5, 1, 2, 4, 8, Infinity];
    const tally = (list) => {
      const h = new Array(B2.length).fill(0);
      for (const q of list) {
        const d3 = dJoint(q);
        h[B2.findIndex((b4) => d3 < b4)]++;
      }
      return h;
    };
    const edgeQ = [];
    for (let q = 0; q < N * N; q++) if (!flat[q] && featW[q] < Infinity) edgeQ.push(q);
    const hj = tally(jagAt),
      he = tally(edgeQ);
    // WHICH WAY the joint pixels are wrong. Two primitives meet there and their coverage is
    // combined; a MAX undercounts (ink missing) and a sum double-counts (ink added). The sign
    // names the mechanism, and a mean over a mixed bag would cancel it -- so count both ways.
    {
      const sg2 = (qq) => {
        const k3 = qq * 3,
          s3 = qq * 4;
        return (px[s3] - ref[k3] + (px[s3 + 1] - ref[k3 + 1]) + (px[s3 + 2] - ref[k3 + 2])) / 3;
      };
      // "lighter than the reference" is ink missing only where the ink is darker than the ground;
      // ask the owning shape instead, so a white shape on black is not read backwards.
      const dir = (qq) => {
        const o2 = owner[qq];
        const sh2 = o2 >= 0 ? shapes[o2] : null;
        const k3 = qq * 3;
        const inkDark = sh2
          ? (sh2.rgb[0] + sh2.rgb[1] + sh2.rgb[2]) / 3 < (ref[k3] + ref[k3 + 1] + ref[k3 + 2]) / 3
          : true;
        const e = sg2(qq);
        return inkDark ? (e > 0 ? 'less' : 'more') : e > 0 ? 'more' : 'less';
      };
      let less = 0,
        more = 0,
        n3 = 0,
        sum = 0;
      for (const q of jagAt)
        if (dJoint(q) < 0.5) {
          n3++;
          sum += Math.abs(sg2(q)) / 255;
          if (dir(q) === 'less') less++;
          else more++;
        }
      if (n3)
        console.log(
          `        SEAM-SIGN  of the ${n3} jaggies within 0.5px of a joint: ` +
            `${less} have TOO LITTLE ink, ${more} TOO MUCH   mean |err| ${(sum / n3).toFixed(3)}`,
        );
      if (process.env.SEAMAT) {
        const list = jagAt
          .filter((q) => dJoint(q) < 0.5)
          .sort((a2, b4) => Math.abs(sg2(b4)) - Math.abs(sg2(a2)))
          .slice(0, +(process.env.SEAMAT || 8));
        console.log(
          '          worst: ' +
            list
              .map(
                (q) =>
                  `(${q % N},${(q / N) | 0})s${owner[q]}:${dir(q)}` +
                  `${(Math.abs(sg2(q)) / 255).toFixed(2)}`,
              )
              .join(' '),
        );
      }
    }
    const pct = (h) =>
      h.map(
        (n2) =>
          `${(
            (100 * n2) /
            Math.max(
              1,
              h.reduce((a2, b4) => a2 + b4, 0),
            )
          ).toFixed(0)}%`,
      );
    console.log(
      `        SEAM  distance to the nearest segment joint: ` +
        B2.map((b4, z) => `<${b4}px`).join(' '),
    );
    console.log(`          jaggies  (n=${jagAt.length}): ` + pct(hj).join(' '));
    console.log(`          all edge (n=${edgeQ.length}): ` + pct(he).join(' '));
  }
  // IS this EDGE ANTIALIASED AT ALL? Neither the error metrics nor JAGGY answer it. An engine can
  // hold a small mean error and a low spike count while painting an edge as a hard staircase --
  // the steps land where the reference is near 0 or near 1, so they cost little error each -- and
  // what the eye reads is the absence of the in-between pixels. So count them: over the pixels the
  // REFERENCE antialiases, how many does the engine also render as an intermediate value rather
  // than saturating to one side of its own local neighbourhood? Computed identically for both, so
  // the reference's own count is the ceiling and the ratio is the answer.
  {
    const luma = (buf, q, st) =>
      0.299 * buf[q * st] + 0.587 * buf[q * st + 1] + 0.114 * buf[q * st + 2];
    const partial = (buf, st, q) => {
      const i = q % N,
        j = (q / N) | 0;
      if (i < 1 || j < 1 || i >= N - 1 || j >= N - 1) return false;
      let lo = Infinity,
        hi = -Infinity;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const v = luma(buf, (j + dj) * N + i + di, st);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      if (hi - lo < 6) return false; // no edge here to antialias
      const v = luma(buf, q, st);
      return v > lo + 2 && v < hi - 2; // strictly between its own extremes
    };
    // AAREGION='x,y,r' restricts the count to one box. A whole-frame ratio is dominated by the
    // long easy edges and says nothing about the one feature being looked at.
    const RG = (process.env.AAREGION || '').split(',').map(Number);
    const inRegion =
      RG.length === 3 && RG.every(Number.isFinite)
        ? (q) => Math.abs((q % N) - RG[0]) <= RG[2] && Math.abs(((q / N) | 0) - RG[1]) <= RG[2]
        : () => true;
    let refP = 0,
      gotP = 0;
    for (let q = 0; q < N * N; q++) {
      if (flat[q] || !inRegion(q)) continue;
      if (!partial(ref, 3, q)) continue;
      refP++;
      if (partial(px, 4, q)) gotP++;
    }
    console.log(
      `        AA PIXELS  ${gotP} of the reference's ${refP} edge pixels are rendered as a` +
        ` partial value  (${((100 * gotP) / Math.max(1, refP)).toFixed(0)}%)`,
    );
  }
  // WHOSE edge is jagged. A count is a score; a list of shapes is somewhere to look.
  {
    const by = new Map();
    for (const q of jagAt) {
      const o = owner[q];
      if (o >= 0) by.set(o, (by.get(o) || 0) + 1);
    }
    const top = [...by].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length)
      console.log(
        `        JAGBY  ${top.map(([o, n2]) => `s${o}:${n2}`).join('  ')}` +
          `   (${by.size} shapes; ${jagAt.length - [...by.values()].reduce((x, y) => x + y, 0)} unowned)`,
      );
  }
  if (process.env.JAGAT && jagAt.length) {
    const wide = jagAt.filter((q) => featW[q] >= 4).slice(0, +(process.env.JAGAT || 6));
    console.log(
      '        widest-feature jaggies at: ' +
        wide.map((q) => `(${q % N},${(q / N) | 0})`).join(' '),
    );
  }
  // WHO won each of the requested points.
  if (process.env.WHO && process.env.WHOPTS) {
    for (const q of process.env.WHOPTS.split(' ')) {
      const [i, j] = q.split(',').map(Number);
      const s3 = (j * N + i) * 4;
      const win = px[s3 + 2] === 128 ? (px[s3] << 4) | px[s3 + 1] : -1;
      console.log(
        `        who @(${i},${j}): ${win < 0 ? 'NOBODY (clear)' : 's' + win}   raw rgb(${px[s3]},${px[s3 + 1]},${px[s3 + 2]})`,
      );
    }
  }
  // ONE ROW, as numbers: what the engine actually put there, beside what the path says.
  if (process.env.ROW) {
    const [ry, rx0, rx1] = process.env.ROW.split(',').map(Number);
    const out2 = [];
    for (let i = rx0; i <= rx1; i++) {
      const q = ry * N + i,
        k2 = q * 3,
        s3 = q * 4;
      out2.push(
        `${i}:${px[s3]},${px[s3 + 1]},${px[s3 + 2]}|${ref[k2]},${ref[k2 + 1]},${ref[k2 + 2]}`,
      );
    }
    console.log('   got|ref  ' + out2.join('  '));
  }
  // A CROP, as text: the SHAPE of a defect says more than its size. '.' agrees, a digit is the
  // magnitude of the disagreement (1 = just over the bar, 9 = a whole channel).
  if (process.env.CROP) {
    const [cx0, cy0, cw2] = process.env.CROP.split(',').map(Number);
    const R2 = cw2 || 24;
    for (let j = cy0 + R2; j >= cy0 - R2; j--) {
      let line = '';
      for (let i = cx0 - R2; i <= cx0 + R2; i++) {
        if (i < 0 || i >= N || j < 0 || j >= N) {
          line += ' ';
          continue;
        }
        const q = j * N + i,
          k2 = q * 3,
          s3 = q * 4;
        const d2 = Math.max(
          Math.abs(px[s3] - ref[k2]),
          Math.abs(px[s3 + 1] - ref[k2 + 1]),
          Math.abs(px[s3 + 2] - ref[k2 + 2]),
        );
        line += d2 <= SOLID_BAD ? (flat[q] ? '.' : ',') : String(Math.min(9, Math.round(d2 / 28)));
      }
      console.log('   ' + line);
    }
  }
  // BLAME: tally the wrong pixels by the shape that PAINTED them. An over-paint is charged to the
  // over-painter, which is the shape whose routing has to change -- the reference's owner is the
  // victim, and fixing the victim fixes nothing.
  if (process.env.BLAME && got[ai].who) {
    const wh = Buffer.from(got[ai].who, 'base64');
    const by = new Map();
    for (let q = 0; q < N * N; q++) {
      if (!isBad[q]) continue;
      const s3 = q * 4;
      // Blue 128 marks a shape-painted pixel; anything else is the clear color (nobody won).
      const win = Math.abs(wh[s3 + 2] - 128) <= 2 ? (wh[s3] << 4) | wh[s3 + 1] : -1;
      by.set(win, (by.get(win) || 0) + 1);
    }
    const rows = [...by].sort((a2, b2) => b2[1] - a2[1]);
    const shown = rows.slice(0, +(process.env.BLAME_N || 14));
    console.log(`        BLAME (painter of the wrong pixel): ${rows.length} shapes`);
    console.log(
      '          ' + shown.map(([o, n]) => `${o < 0 ? 'CLEAR' : 's' + o}:${n}`).join(' '),
    );
    if (process.env.BLAME_LIST)
      console.log(
        '          all painters: ' +
          rows
            .filter(([o]) => o >= 0)
            .map(([o]) => o)
            .join(','),
      );
  }
  // PER-SHAPE, so "this shape is missing" and "this shape has a bad wedge" read differently: the
  // first is a routing failure and the second a geometry or shading one.
  if (process.env.PERSHAPE) {
    const tot = new Map(),
      bad2 = new Map();
    for (let q = 0; q < N * N; q++) {
      const o = owner[q];
      if (o < 0 || !flat[q]) continue;
      tot.set(o, (tot.get(o) || 0) + 1);
      if (isBad[q]) bad2.set(o, (bad2.get(o) || 0) + 1);
    }
    const rows = [...bad2]
      .map(([o, n]) => ({ o, n, t: tot.get(o) || 0 }))
      .sort((a, b) => b.n - a.n);
    console.log(
      '        per shape: ' +
        rows
          .slice(0, 10)
          .map(
            (r2) => `s${r2.o} ${r2.n}/${r2.t} (${((100 * r2.n) / Math.max(1, r2.t)).toFixed(0)}%)`,
          )
          .join('  '),
    );
  }
  // THE WORST AA PIXEL, in the same terms. Once the solid count is at zero or one, the edge error
  // is what is left to fix, and a maximum with no context is not a lead: which shapes cover it,
  // what the path says the coverage is, and what came back all have to be on the same line.
  if (process.env.AAWHY && aaMaxAt >= 0) {
    const i = aaMaxAt % N,
      j = (aaMaxAt / N) | 0;
    const cx = emX(i),
      cy = emY(j),
      k = aaMaxAt * 3,
      sp2 = aaMaxAt * 4;
    const cov = [];
    for (const sh of shapes) {
      if (!sh) continue;
      if (cx < sh.bb[0] - SC || cx > sh.bb[2] + SC || cy < sh.bb[1] - SC || cy > sh.bb[3] + SC)
        continue;
      let t = 0;
      for (const [q, w] of GL5) {
        const y = cy + 0.5 * SCY * q;
        let c2 = 0;
        for (const sp of spansOf(sh, y))
          c2 += Math.max(0, Math.min(cx + SCX / 2, sp[1]) - Math.max(cx - SCX / 2, sp[0]));
        t += (w * 0.5 * c2) / SCX;
      }
      const a2 = Math.min(1, Math.max(0, t));
      if (a2 > 1e-6)
        cov.push(
          `s${sh.i} cov ${a2.toFixed(3)} rgb(${sh.rgb.map((v) => Math.round(v)).join(',')}) a${sh.a.toFixed(2)}`,
        );
    }
    console.log(
      `        AA worst @(${i},${j}) em(${cx.toFixed(1)},${cy.toFixed(1)})  ref rgb(${ref[k]},${ref[k + 1]},${ref[k + 2]})  got rgb(${px[sp2]},${px[sp2 + 1]},${px[sp2 + 2]})`,
    );
    console.log(`          exact coverage here: ${cov.join(' | ') || 'nothing covers this pixel'}`);
  }
  // every SHAPE THAT COVERS ONE NAMED PIXEL, with what the path says it contributes. A composite
  // defect is rarely the shape the frame blames: the pixel's color is a stack, and a stray tint
  // usually means a shape ABOVE the one showing through never painted. COVAT='x,y'.
  if (process.env.COVAT) {
    const [ci, cj] = process.env.COVAT.split(',').map(Number);
    const q = cj * N + ci,
      cx = emX(ci),
      cy = emY(cj),
      k = q * 3,
      sp2 = q * 4;
    const rows2 = [];
    for (const sh of shapes) {
      if (!sh) continue;
      if (cx < sh.bb[0] - SC || cx > sh.bb[2] + SC || cy < sh.bb[1] - SC || cy > sh.bb[3] + SC)
        continue;
      let t = 0;
      for (const [g, w] of GL5) {
        const y = cy + 0.5 * SCY * g;
        let c2 = 0;
        for (const sp of spansOf(sh, y))
          c2 += Math.max(0, Math.min(cx + SCX / 2, sp[1]) - Math.max(cx - SCX / 2, sp[0]));
        t += (w * 0.5 * c2) / SCX;
      }
      const a2 = Math.min(1, Math.max(0, t)) * sh.a;
      if (a2 > 1e-6)
        rows2.push(`s${sh.i} ${a2.toFixed(3)} rgb(${sh.rgb.map((v) => Math.round(v)).join(',')})`);
    }
    console.log(
      `        COVAT @(${ci},${cj}) em(${cx.toFixed(1)},${cy.toFixed(1)})  ref rgb(${ref[k]},${ref[k + 1]},${ref[k + 2]})  got rgb(${px[sp2]},${px[sp2 + 1]},${px[sp2 + 2]})`,
    );
    console.log(`          in document order: ${rows2.join(' | ') || 'nothing covers this pixel'}`);
  }
  // WHY, for the worst components: is the geometry there and shaded wrong, or never built?
  // The two need different fixes and cost differently -- geometry is triangles at build time,
  // shading is ALU on every fragment.
  if (process.env.WHY && comps.length) {
    for (const c of comps.slice(0, +(process.env.WHY_N || 8))) {
      const q = c.y * N + c.x,
        k = q * 3,
        sp2 = q * 4;
      const cx = emX(c.x),
        cy = emY(c.y);
      const sh = c.own >= 0 ? shapes[c.own] : null;
      const dir =
        px[sp2] + px[sp2 + 1] + px[sp2 + 2] > ref[k] + ref[k + 1] + ref[k + 2]
          ? 'LIGHTER (ink missing)'
          : 'DARKER (ink added)';
      let why = 'no owner';
      if (sh) {
        const r2 = sec.curveRangesByShape[c.own];
        const evenOdd = MF[c.own * ST + 13] > 0.5;
        let mesh = null;
        try {
          mesh = buildLoopBlinnCDT(
            curveRangeToContours(new Float32Array(sec.curves), r2.begin | 0, r2.end | 0),
            { fillRule: evenOdd ? 'evenodd' : 'nonzero' },
          );
        } catch {
          mesh = null;
        }
        if (!mesh) why = 'LB DECLINED this shape (drawn by the fallback)';
        else {
          const tri = mesh.interior || new Float32Array(0);
          let hit = 0;
          for (let t = 0; t + 5 < tri.length; t += 6) {
            const A = [tri[t], tri[t + 1]],
              B = [tri[t + 2], tri[t + 3]],
              C = [tri[t + 4], tri[t + 5]];
            const d = (a, b, c2) => (b[0] - a[0]) * (c2[1] - a[1]) - (c2[0] - a[0]) * (b[1] - a[1]);
            const d1 = d(A, B, [cx, cy]),
              d2 = d(B, C, [cx, cy]),
              d3 = d(C, A, [cx, cy]);
            if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) hit++;
          }
          why = hit ? `covered by ${hit} interior tri -> SHADING` : 'no interior tri -> GEOMETRY';
          why += `  [${(mesh.interior || []).length / 6} tris, ${(mesh.quads || []).length} quads, ${(mesh.cubics || []).length} cubics, ${(mesh.fallback || []).length} fallback]`;
        }
      }
      const shRgb = sh ? `shape rgb(${sh.rgb.map((v) => Math.round(v)).join(',')})` : '';
      // every shape whose path contains the point, in document order: an "ink missing" hole that
      // sits exactly where a LATER shape overlaps is a draw-ORDER defect, not a fill one.
      const stack = [];
      for (const sh2 of shapes) {
        if (!sh2) continue;
        if (cx < sh2.bb[0] || cx > sh2.bb[2] || cy < sh2.bb[1] || cy > sh2.bb[3]) continue;
        let inside = false;
        for (const sp3 of rowSpans(sh2.segs, cy) || [])
          if (cx >= sp3[0] && cx <= sp3[1]) {
            inside = true;
            break;
          }
        if (inside) stack.push(sh2.i);
      }
      console.log(
        `          ${String(c.n).padStart(4)}px @(${c.x},${c.y}) em(${cx.toFixed(1)},${cy.toFixed(1)}) s${c.own} ${dir}`,
      );
      console.log(
        `               ref rgb(${ref[k]},${ref[k + 1]},${ref[k + 2]})  got rgb(${px[sp2]},${px[sp2 + 1]},${px[sp2 + 2]})  ${shRgb}`,
      );
      console.log(`               covering shapes (doc order): ${stack.join(' ')}`);
      console.log(`               ${why}`);
    }
  }
}
