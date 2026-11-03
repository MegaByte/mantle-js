// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Real renderer, one context and renderer; programs pinned at actual draw calls.
// Preparation, compilation, readback and required rest are outside timings.
// Fence-synchronised wall time includes JS submission/driver overhead. A/A shares
// the exact CPatch bundle and resources. Rotate order on each sampling round.
import {
  importSvg,
  createBundle,
  createRenderer,
  loadShaders,
  createOverrideTable,
  createShapeMorph,
} from '../../src/index.js';
import { addMonotoneVariant } from './experimentalShader.js';
import { addRawFillRuleVariant } from './rawFillRuleShader.js';
import { packPieceAtlas } from './pieceAtlas.js';
import { fixMorphAtlasCovers } from './morphAtlas.js';
import { addRootCacheVariant, createRootCache } from './rootCache.js';
import { probeMorphWorker } from './morphWorkerProbe.js';
import { createPieceResolver } from './pieceResolve.js';
import { packedGeometryStats } from './packedGeometryStats.js';
import { noteExternalGlWrite } from '../../src/core/glEpoch.js';
let gl, r, timer, forceUnified, pieceResolver, activeRootCache;
let candidateRenderer, baselineApi, baselineRenderer, baselineEpoch;
let tally = null,
  debugRaw = false,
  probeScissor = null;
const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
const fence = async () => {
  if (!(await window.__gpuFence(gl, 60000)))
    throw new Error(
      'GPU fence failed/timed out lost=' + gl.isContextLost() + ' err=' + gl.getError(),
    );
};
export async function init(options = {}) {
  globalThis.__MANTLE_DEBUG__ = true;
  globalThis.__MANTLE_NO_INSTANCED_FAST = options.fastInstancing !== true;
  globalThis.__MANTLE_NO_SDF_PRIMS = options.sdfRecognition !== true;
  const recognize = await import('../../src/geom/shapeRecognize.js');
  recognize.setSdfPrimitivesEnabled(options.sdfRecognition === true);
  gl = document.getElementById('c').getContext('webgl2', {
    antialias: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    depth: true,
    stencil: true,
  });
  if (!gl) throw new Error('WebGL2 unavailable');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = ext
    ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  if (/swiftshader|llvmpipe|software/i.test(renderer))
    throw new Error('Refusing software renderer: ' + renderer);
  const defs = (src) => [...String(src).matchAll(/^\s*#define\s+(MANTLE_\w+)/gm)].map((x) => x[1]);
  const ss = gl.shaderSource.bind(gl),
    at = gl.attachShader.bind(gl),
    sources = new WeakMap(),
    programs = new WeakMap(),
    fillShaders = new WeakSet(),
    fillPrograms = new WeakSet();
  gl.shaderSource = (s, src) => {
    sources.set(s, defs(src));
    if (
      (gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER &&
        src.includes('uniform sampler2D uCurveData;')) ||
      (gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.VERTEX_SHADER &&
        defs(src).includes('MANTLE_AAC') &&
        /uniform\s+sampler2D\s+uCurveData\s*;/.test(src) &&
        src.includes('gl_PointSize'))
    )
      fillShaders.add(s);
    ss(s, src);
  };
  gl.attachShader = (p, s) => {
    if (fillShaders.has(s)) fillPrograms.add(p);
    programs.set(p, [...new Set([...(programs.get(p) || []), ...(sources.get(s) || [])])]);
    at(p, s);
  };
  for (const name of [
    'drawArrays',
    'drawElements',
    'drawArraysInstanced',
    'drawElementsInstanced',
  ]) {
    const f = gl[name].bind(gl);
    gl[name] = (...args) => {
      if (activeRootCache) {
        const p = gl.getParameter(gl.CURRENT_PROGRAM);
        if ((programs.get(p) || []).includes('MANTLE_AAC_ROOT_CACHE') && fillPrograms.has(p))
          activeRootCache.bind(p);
      }
      pieceResolver?.beforeDraw();
      if (tally) {
        const p = gl.getParameter(gl.CURRENT_PROGRAM),
          d = programs.get(p) || [];
        const key = !fillPrograms.has(p)
          ? 'auxiliary'
          : d.includes('MANTLE_CPATCH')
            ? 'cpatch'
            : d.includes('MANTLE_AAC')
              ? 'aac'
              : d.includes('MANTLE_LB_FILL')
                ? 'lb'
                : 'slug';
        if (name.endsWith('Instanced')) tally.instancedDraws = (tally.instancedDraws || 0) + 1;
        if (tally.drawCalls)
          tally.drawCalls.push({ method: name, first: args[1], count: args[2], defines: d });
        tally.states = [
          ...new Set([
            ...(tally.states || []),
            JSON.stringify({
              depth: gl.isEnabled(gl.DEPTH_TEST),
              depthFunc: gl.isEnabled(gl.DEPTH_TEST) ? gl.getParameter(gl.DEPTH_FUNC) : null,
              depthWrite: gl.getParameter(gl.DEPTH_WRITEMASK),
              blend: gl.isEnabled(gl.BLEND),
              srcRGB: gl.getParameter(gl.BLEND_SRC_RGB),
              dstRGB: gl.getParameter(gl.BLEND_DST_RGB),
            }),
          ]),
        ];
        tally[key] = (tally[key] || 0) + 1;
        tally.defines = [...new Set([...(tally.defines || []), ...d])];
      }
      if (probeScissor) {
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(...probeScissor);
      }
      if (debugRaw) gl.disable(gl.BLEND);
      return f(...args);
    };
  }
  timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!timer) throw new Error('GPU timer queries unavailable');
  const loaded = await loadShaders(new URL('/src/shaders/', location.href));
  const shaders = options.productionShaders
    ? loaded
    : addRootCacheVariant(addRawFillRuleVariant(addMonotoneVariant(loaded)));
  forceUnified = !!options.forceUnified;
  r = createRenderer(gl, shaders, {
    psoWarmIdle: () => true,
    cpatchFill: true,
    aacPoints: options.aacPoints === true,
    ...(options.initialKernel === 'aac' ? { aacFill: true } : {}),
  });
  candidateRenderer = r;
  if (options.baseline) {
    baselineApi = await import('/__baseline/src/index.js');
    baselineEpoch = await import('/__baseline/src/core/glEpoch.js');
    (await import('/__baseline/src/geom/shapeRecognize.js')).setSdfPrimitivesEnabled(
      options.sdfRecognition === true,
    );
    const baselineShaders = await baselineApi.loadShaders(
      new URL('/__baseline/src/shaders/', location.href),
    );
    baselineRenderer = baselineApi.createRenderer(gl, baselineShaders, {
      psoWarmIdle: () => true,
      cpatchFill: true,
      aacPoints: options.aacPoints === true,
      ...(options.initialKernel === 'aac' ? { aacFill: true } : {}),
    });
  }
  return {
    renderer,
    vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
    version: gl.getParameter(gl.VERSION),
    timerQuery: true,
    timing:
      'EXT_disjoint_timer_query_webgl2 GPU elapsed + GPU-fence synchronised wall ms per frame',
    shaderSource:
      'workspace source assembled by loadShaders, generated cache disabled; hashes recorded',
    fastInstancing: options.fastInstancing === true,
    sdfRecognition: options.sdfRecognition === true,
    baseline: !!baselineRenderer,
    forceUnified,
    instrumentation:
      'Server inserts __setProbeUnified setter for existing opts.unifiedFill flag; CPatch always uses natural release routing. Cover reach is unset for normal production arms; explicit controls change only the existing uniform setting.',
  };
}
function select(a) {
  const next = a.source === 'baseline' ? baselineRenderer : candidateRenderer;
  if (!next) throw Error('Baseline not configured');
  if (r !== next) {
    noteExternalGlWrite();
    baselineEpoch?.noteExternalGlWrite();
    r = next;
    r.invalidateRenderState();
  }
  activeRootCache = a.rootCache || null;
  r.__setProbeCoverAaReach(a.coverAaReach);
  probeScissor = a.probeScissor || null;
  globalThis.__CP_AREA_SPLIT = a.cpatchAreaSplit !== false;
  globalThis.__CP_PROBE_CUTS_FIRST = !!a.cutFirst;
  globalThis.__CP_PROBE_WHOLE_ARC = !!a.cpatchWholeArc;
  debugRaw = (a.defines || []).some(
    (d) => d.startsWith('MANTLE_CP_QUERY_') || d.startsWith('MANTLE_AREA_QUERY_'),
  );
  r.__setProbeUnified(
    a.engine !== 'cpatch' && a.engine !== 'lb' && a.engine !== 'default' && a.unified,
  );
  r.setFillEngine({
    route:
      a.engine === 'cpatch'
        ? 'cpatch'
        : a.engine === 'lb'
          ? 'lb'
          : a.engine === 'default'
            ? 'auto'
            : 'none',
    commit: false,
    ...(a.primitives === undefined ? {} : { primitives: a.primitives }),
    kernel: a.fallbackKernel || (a.engine === 'aac' ? 'aac' : 'slug'),
  });
  r.__setAbDefines(a.defines || []);
}
function setMorphPose(a, t) {
  if (a.morphAtlases) {
    const atlas = a.morphAtlases.find(
      (p) => t >= p.interval.t0 - 1e-9 && t <= p.interval.t1 + 1e-9,
    );
    if (!atlas) throw Error('Pose has no resident certified interval');
    a.pieceAtlas = atlas;
    a.bundle = atlas.bundle;
    a.morphInterval = atlas.interval;
    t = Math.max(0, Math.min(1, (t - atlas.interval.t0) / (atlas.interval.t1 - atlas.interval.t0)));
  }
  a.bundle.probeMorph?.setT(t);
}
function draw(a, count = 1, animate = false) {
  select(a);
  if (animate && a.morphCycle) {
    setMorphPose(a, a.morphCycle[a.morphCycleIndex++ % a.morphCycle.length]);
  }
  if (a.rootCache) a.rootCache.draw();
  if (a.pieceAtlas) {
    pieceResolver.drawAtlas(a.pieceAtlas, gl.canvas.width, count, a.drawOptions, a.coverageFormat);
    return;
  }
  if (a.pieceGroups) {
    pieceResolver.draw(a.pieceGroups, gl.canvas.width, count, a.drawOptions, a.coverageFormat);
    return;
  }
  gl.disable(gl.SCISSOR_TEST);
  r.beginFrame([0, 0, 0, 0]);
  if (a.instances) {
    r._setInstancedFast(a.instancedFast !== false);
    for (let i = 0; i < count; i++) r.drawBundleInstanced(a.bundle, a.instances, a.drawOptions);
  } else
    for (let i = 0; i < count; i++)
      r.drawBundle(a.bundle.probeMorph || a.bundle, a.drawOptions || {});
  r.endFrame();
}
async function frame(a, count = 1) {
  const t = performance.now();
  draw(a, count);
  await fence();
  await window.__gpuIdle(performance.now() - t);
}
function pin(a) {
  select(a);
  const beforeEngines = r.debugStats.engines,
    before = beforeEngines.draws;
  tally = a.captureDrawCalls ? { drawCalls: [] } : {};
  draw(a);
  const p = tally;
  tally = null;
  p.ledger = {};
  for (const [k, n] of Object.entries(r.debugStats.engines.draws)) {
    const d = n - (before[k] || 0);
    if (d) p.ledger[k] = d;
  }
  p.routeLedger = {};
  for (const [k, n] of Object.entries(r.debugStats.engines.viaRoute)) {
    const d = n - (beforeEngines.viaRoute[k] || 0);
    if (d) p.routeLedger[k] = d;
  }
  // LB_FILL declares the shared vertex wire. Cover-only unified draws can use
  // it with no LB geometry. Confirm their kernel using the draw-site engine ledger.
  if (p.lb && p.ledger.slug && !p.ledger.lb && !p.ledger.cpatch) {
    p.slug = p.lb;
    delete p.lb;
  }
  return p;
}
function read(size) {
  const p = new Uint8Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, p);
  return p;
}
function captureCPatchGeometry(b) {
  if (!gl.getExtension('EXT_color_buffer_float'))
    throw Error('CPatch diagnostic requires float texture readback');
  const rows = b._cpatchMorphPlane?.rows || Math.ceil((b._cpatchPlane?.length || 0) / 16384);
  if (!rows) throw Error('CPatch diagnostic has no live texture dimensions');
  const fbo = gl.createFramebuffer(),
    plane = new Float32Array(rows * 16384);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, b.curveTex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
    throw Error('CPatch readback framebuffer incomplete');
  gl.readPixels(0, 0, 4096, rows, gl.RGBA, gl.FLOAT, plane);
  const error = gl.getError();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  noteExternalGlWrite();
  r.invalidateRenderState();
  if (error !== gl.NO_ERROR) throw Error('CPatch live coefficient readback failed ' + error);
  return {
    plane: Array.from(plane),
    planeSource: 'GPU live texture after current-pose interpolation',
    meshes: (b._lbMeshes || []).map((m) => ({ verts: Array.from(m?.verts || []) })),
  };
}
function quality(p, c) {
  if (!c.samples) return null;
  let maxError = 0,
    sum = 0,
    worst = null;
  for (const s of c.samples) {
    const actual = p[((c.size - 1 - s.y) * c.size + s.x) * 4 + 3] / 255,
      error = Math.abs(actual - s.area);
    sum += error;
    if (error > maxError) {
      maxError = error;
      worst = { ...s, actual };
    }
  }
  return { pixels: c.samples.length, maxError, meanError: sum / c.samples.length, worst };
}
function colorQuality(p, c) {
  if (!c.colorSamples) return null;
  let maxByte = 0,
    sum = 0,
    overOne = 0,
    worst = null;
  for (const s of c.colorSamples) {
    const actual = Array.from(
      p.subarray(
        ((c.size - 1 - s.y) * c.size + s.x) * 4,
        ((c.size - 1 - s.y) * c.size + s.x) * 4 + 4,
      ),
    );
    let worstHere = 0;
    for (let k = 0; k < 4; k++) {
      const e = Math.abs(actual[k] - s.rgba[k]);
      sum += e;
      worstHere = Math.max(worstHere, e);
      if (e > maxByte) {
        maxByte = e;
        worst = { ...s, actual, channel: k };
      }
    }
    if (worstHere > 1) overOne++;
  }
  return {
    pixels: c.colorSamples.length,
    maxByte,
    meanByte: sum / (c.colorSamples.length * 4),
    overOne,
    worst,
  };
}
export async function run(c) {
  const size = c.size || 128;
  gl.canvas.width = gl.canvas.height = size;
  candidateRenderer.setViewport(size, size);
  baselineRenderer?.setViewport(size, size);
  globalThis.__CP_KEEP_PLANE = !!c.captureGeometry;
  const workerMorphPreparation = c.prepareMorphWorker
    ? await probeMorphWorker(gl, r, c, frame)
    : null;
  const arms = [],
    bundles = new Map(),
    overrideTables = new Map(),
    morphDestinations = new Map(),
    result = {
      name: c.name,
      size,
      accuracyScissor: c.accuracyScissor || null,
      primer: !!c.primer,
      timingScope: c.accuracyScissor
        ? 'SCISSORED accuracy diagnostic; not full-frame performance'
        : c.primer
          ? 'full frame GPU query excludes primer; fence wall includes queued primer'
          : 'full frame',
      morphCycle: c.morphCycle || null,
      morphPreparation: c.morphPreparation || null,
      workerMorphPreparation,
      arms: [],
      batch: c.batch || 4,
      samples: c.rounds || 7,
      repetitions: c.repetitions || 1,
    };
  for (const spec of c.arms || [
    { name: 'cpatch', engine: 'cpatch' },
    { name: 'area', engine: 'aac', normalized: true },
    { name: 'cpatchAA', engine: 'cpatch' },
  ]) {
    if (spec.analyticArea || spec.monotone || (spec.defines || []).includes('MANTLE_AREA_MONOTONE'))
      throw new Error('Prepared AAC is not a package route: ' + spec.name);
    spec.unified =
      (forceUnified && spec.unified !== false) || spec.engine === 'cpatch' || spec.engine === 'lb';
    select(spec); // Build policy is read during createBundle, before prepareBundle.
    const api =
      spec.source === 'baseline'
        ? baselineApi
        : { importSvg, createBundle, createShapeMorph, createOverrideTable };
    const {
      importSvg: importSourceSvg,
      createBundle: createSourceBundle,
      createShapeMorph: createSourceMorph,
      createOverrideTable: createSourceOverrides,
    } = api;
    const dstSvg = spec.morphSvgDst || c.morphSvgDst;
    if (spec.morph && !morphDestinations.has(dstSvg))
      morphDestinations.set(dstSvg, morphDestinations.size);
    const key =
      (spec.morph ? 'dst' + morphDestinations.get(dstSvg) + ':' : '') +
      (spec.source || 'candidate') +
      ':' +
      (spec.normalizeFill === false ? 'authored:' : '') +
      spec.engine +
      ':' +
      (spec.pose ? 'pose:' : '') +
      (spec.morphPieceAtlas
        ? 'morphPieceAtlas:'
        : spec.pieceAtlas
          ? 'pieceAtlas:'
          : spec.pieceResolve
            ? 'pieceResolve:'
            : '') +
      (spec.morphHullCovers ? 'hullCovers:' : '') +
      (spec.rootCache ? 'rootCache:' : '') +
      (spec.preciseMorphTypes ? 'typed:' : '') +
      (spec.morph ? 'morph:' + !!spec.morphCpu + ':' : '') +
      (spec.cutFirst ? 'cutsFirst:' : '') +
      (spec.cpatchWholeArc ? 'wholeArc:' : '') +
      (spec.analyticArea
        ? 'analytic'
        : spec.monotone
          ? 'monotone'
          : spec.normalized
            ? 'normalized'
            : 'raw');
    let b = bundles.get(key);
    if (!b) {
      const start = performance.now();
      if (spec.morphPieceAtlas) {
        if (
          spec.engine !== 'aac' ||
          spec.analyticArea ||
          spec.monotone ||
          (spec.defines || []).includes('MANTLE_AREA_MONOTONE')
        )
          throw Error('Prepared morph uses general AAC');
        const tPose = c.morphT ?? 0.5,
          atlases = [],
          buildStart = performance.now();
        if (!c.morphPieceIntervals?.length) throw Error('No certified morph intervals');
        pieceResolver ||= createPieceResolver(gl, r);
        for (const interval of c.morphPieceIntervals) {
          const lo = packPieceAtlas({ ...c, pieceGroups: interval.groupsLo }),
            hi = packPieceAtlas({ ...c, pieceGroups: interval.groupsHi });
          if (
            lo.size !== hi.size ||
            JSON.stringify(lo.groups.map((g) => [g.rect, g.atlas, g.matrix])) !==
              JSON.stringify(hi.groups.map((g) => [g.rect, g.atlas, g.matrix]))
          )
            throw Error('Endpoint atlas layouts differ');
          const t = performance.now(),
            endpoints = [];
          for (const atlas of [lo, hi]) {
            const sections = fixMorphAtlasCovers(
              await importSourceSvg(atlas.svg, { preserveViewport: true }),
              atlas,
              { hull: spec.morphHullCovers },
            );
            const endpoint = createSourceBundle(gl, sections);
            endpoint.globalBBox = [0, 0, atlas.size, atlas.size];
            if (endpoint.drawListUnculled) endpoint.drawList = endpoint.drawListUnculled;
            endpoints.push(endpoint);
          }
          const morph = createSourceMorph(gl, ...endpoints),
            mb = morph.bundle;
          if (
            morph.plan.matched.length !== lo.stats.pieces ||
            morph.plan.srcOnly.length ||
            morph.plan.dstOnly.length
          )
            throw Error('Prepared pieces failed positional/identity matching');
          mb.globalBBox = [0, 0, lo.size, lo.size];
          mb._morphSrc.gpuSmallPlanes = true;
          // Fixed boxes, paint, stroke, and transform slots must agree before
          // omitting a metadata mix. Compare the actual composed f32 records.
          const ms = mb._morphSrc,
            slots = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 36, 37, 38, 39];
          for (const m of morph.plan.matched)
            for (const k of slots) {
              if (
                endpoints[0].metaFloats[m.srcIdx * endpoints[0].metaFloatsPerShape + k] !==
                endpoints[1].metaFloats[m.dstIdx * endpoints[1].metaFloatsPerShape + k]
              )
                throw Error('Prepared metadata is not constant');
            }
          ms.skipMetaLerp = true;
          morph.setT(0.5);
          if (!morph.usesGpuCurveLerp) throw Error('Prepared morph fell back to CPU curve upload');
          mb.probeMorph = morph;
          mb.probeMorphEndpoints = endpoints;
          mb.probeMorphInterval = interval;
          lo.bundle = mb;
          lo.morph = morph;
          lo.interval = interval;
          lo.stats.importUploadMorphMs = performance.now() - t;
          lo.stats.fixedCovers = true;
          lo.stats.skipConstantMetaLerp = true;
          mb.probePieceAtlas = lo;
          r.prepareBundle(mb);
          atlases.push(lo);
        }
        const current = atlases.find(
          (p) => tPose >= p.interval.t0 - 1e-9 && tPose <= p.interval.t1 + 1e-9,
        );
        if (!current) throw Error('No certified morph interval at checked pose');
        b = current.bundle;
        b.probeMorphAtlases = atlases;
        b.probeMorphBrowserPreparationMs = performance.now() - buildStart;
        current.morph.setT(
          (tPose - current.interval.t0) / (current.interval.t1 - current.interval.t0),
        );
      } else if (spec.pieceAtlas) {
        pieceResolver ||= createPieceResolver(gl, r);
        const atlas = packPieceAtlas(c),
          t = performance.now();
        b = createSourceBundle(
          gl,
          await importSourceSvg(atlas.svg, {
            preserveViewport: true,
            analyticArea: spec.analyticArea === true,
            normalizeFill: spec.normalizeFill !== false,
          }),
        );
        b.globalBBox = [0, 0, atlas.size, atlas.size];
        if (b.drawListUnculled) b.drawList = b.drawListUnculled;
        r.prepareBundle(b);
        atlas.bundle = b;
        atlas.stats.importUploadMs = performance.now() - t;
        b.probePieceAtlas = atlas;
      } else if (spec.pieceResolve) {
        pieceResolver ||= createPieceResolver(gl, r);
        if (!c.pieceGroups?.length) throw Error('Prepared CPatch pieces required');
        const groups = [];
        for (const g of c.pieceGroups) {
          const bundle = createSourceBundle(
            gl,
            await importSourceSvg(g.svg, {
              preserveViewport: true,
              analyticArea: spec.analyticArea === true,
              normalizeFill: spec.normalizeFill !== false,
            }),
          );
          if (c.bbox) bundle.globalBBox = c.bbox.slice();
          if (bundle.drawListUnculled) bundle.drawList = bundle.drawListUnculled;
          r.prepareBundle(bundle);
          groups.push({ ...g, bundle });
        }
        b = groups[0].bundle;
        b.probePieceGroups = groups;
      } else
        b = createSourceBundle(
          gl,
          await importSourceSvg(
            spec.monotone
              ? c.monotone
              : spec.normalized
                ? c.normalized
                : spec.pose
                  ? c.poseSvg
                  : c.svg,
            {
              preserveViewport: true,
              analyticArea: spec.analyticArea === true,
              normalizeFill: spec.normalizeFill !== false,
            },
          ),
        );
      if (c.bbox && !spec.pieceAtlas && !spec.morphPieceAtlas) b.globalBBox = c.bbox.slice();
      if (spec.morph) {
        const morphSvgDst = spec.morphSvgDst || c.morphSvgDst;
        if (!morphSvgDst) throw Error('Morph requires an authored destination pose');
        if (
          spec.pieceAtlas ||
          spec.pieceResolve ||
          spec.analyticArea ||
          spec.monotone ||
          spec.normalized
        )
          throw Error('Prepared static boundaries need a separate morph correspondence proof');
        const dst = createSourceBundle(
          gl,
          await importSourceSvg(morphSvgDst, {
            preserveViewport: true,
            normalizeFill: spec.normalizeFill !== false,
          }),
        );
        if (c.bbox) dst.globalBBox = c.bbox.slice();
        const morph = createSourceMorph(gl, b, dst, { cpuLerp: spec.morphCpu === true });
        if (c.morphGpuSmallPlanes) morph.bundle._morphSrc.gpuSmallPlanes = true;
        const endpoints = [b, dst];
        morph.setT(c.morphT ?? 0.5);
        b = morph.bundle;
        b.probeMorph = morph;
        b.probeMorphEndpoints = endpoints;
      }
      bundles.set(key, b);
      result['importMs_' + key] = performance.now() - start;
    }
    if (spec.preciseMorphTypes && b.probeMorph)
      b.segTypeMask = b.probeMorphEndpoints.reduce(
        (mask, endpoint) => mask | (endpoint.segTypeMask || 15),
        0,
      );
    if (spec.rootCache && !b.probeRootCache) {
      const M = c.drawOptions?.worldMatrix || [1, 0, 0, 0, 1, 0, 0, 0, 1];
      if (
        spec.engine !== 'aac' ||
        spec.analyticArea ||
        spec.pieceAtlas ||
        spec.morphPieceAtlas ||
        c.instances ||
        c.overrideAll ||
        M[1] !== 0 ||
        M[3] !== 0 ||
        M[2] !== 0 ||
        M[5] !== 0 ||
        M[8] !== 1 ||
        b.segTypeMask & 8
      )
        throw Error('Root cache prototype requires axis-aligned polynomial AAC');
      const s = size / Math.max(c.bbox[2], c.bbox[3]);
      b.probeRootCache = createRootCache(gl, r, b, [s * M[0], s * M[4]]);
    }
    if (spec.requiredSegTypeMask !== undefined && b.segTypeMask !== spec.requiredSegTypeMask)
      throw Error('Unexpected segment types: ' + b.segTypeMask);
    let drawOptions = c.drawOptions;
    if (c.overrideAll) {
      if (spec.pieceAtlas || spec.pieceResolve)
        throw Error('Runtime override diagnostics require an original-shape bundle');
      let ov = overrideTables.get(b);
      if (!ov) {
        ov = createSourceOverrides(gl, b);
        for (let i = 0; i < b.numShapes; i++)
          if (!ov.set(i, c.overrideAll)) throw Error('Override row missing ' + i);
        overrideTables.set(b, ov);
      }
      drawOptions = { ...drawOptions, overrides: ov };
    }
    if (
      (spec.morph || spec.morphPieceAtlas) &&
      spec.engine !== 'cpatch' &&
      spec.engine !== 'lb' &&
      spec.engine !== 'default'
    )
      r.setLoopBlinnMorphFill('off');
    const a = {
      ...spec,
      rootCache: spec.rootCache ? b.probeRootCache : null,
      instances: c.instances,
      probeScissor: c.accuracyScissor || null,
      drawOptions,
      bundle: b,
      pieceAtlas: spec.pieceAtlas || spec.morphPieceAtlas ? b.probePieceAtlas : null,
      morphInterval: b.probeMorphInterval,
      morphAtlases: b.probeMorphAtlases,
      morphCycle: b.probeMorph ? c.morphCycle : null,
      morphCycleIndex: 0,
      pieceGroups: spec.pieceResolve ? b.probePieceGroups : null,
      rawMs: [],
      rawGpuMs: [],
    };
    select(a);
    const prepStart = performance.now();
    r.prepareBundle(b);
    if (spec.engine === 'cpatch' || spec.engine === 'lb' || spec.engine === 'default') {
      const readiness = r.awaitEngine(b, spec.engine === 'default' ? 'lb' : spec.engine, 15000);
      if (spec.capturePending) {
        a.pendingPlanState = b._cpatchMorphPlan;
        a.pendingPin = pin(a);
        await fence();
        a.pendingPixels = read(size);
        await window.__gpuIdle(1);
      }
      a.awaitEngineReady = await readiness;
      if (a.awaitEngineReady) {
        a.firstReadyPin = pin(a);
        await fence();
        await window.__gpuIdle(1);
      }
      if (
        !a.awaitEngineReady &&
        spec.engine !== 'default' &&
        !(spec.morph && spec.engine === 'cpatch')
      )
        throw new Error(
          'Engine preparation timed out ' +
            spec.name +
            ' ' +
            JSON.stringify({
              matched: Array.from(b._morphSrc?.matchedSrcIdxs || []),
              built: b._morphMeshesBuilt,
              meshes: b._morphMeshes?.length,
              why: Array.from(b._morphSlugWhy || []),
              pairWhy: b._morphPairWhy,
            }),
        );
    }
    a.geometryStats = packedGeometryStats(b, c);
    if (
      (a.defines || []).includes('MANTLE_LB_PREPARED_MONOTONE') &&
      a.geometryStats.maxReverseDerivativePx > 0.001
    )
      throw new Error('LB packed geometry is not monotone: ' + JSON.stringify(a.geometryStats));
    if (spec.morph && spec.engine === 'cpatch') {
      const until = performance.now() + 15000;
      while (!(b._cpatchBuilt > 0) && b._cpatchMorphPlan !== null && performance.now() < until) {
        await frame(a);
        r.prepareBundle(b);
        r.precompileFills();
        await fence();
        await window.__gpuIdle(1);
      }
      if (!(b._cpatchBuilt > 0) && !spec.allowCpatchDecline)
        throw Error(
          'CPatch morph not prepared: ' +
            JSON.stringify({
              plan: b._cpatchMorphPlan === null ? 'declined' : typeof b._cpatchMorphPlan,
              built: b._cpatchBuilt,
              matched: b.probeMorph.plan?.matched?.length,
              matchedAll: b._morphSrc?.matchedAll,
              bail: b._cpatchBail,
              why: b._cpatchMorphWhy,
            }),
        );
    }
    a.prepareMs = performance.now() - prepStart;
    if ((spec.morph || spec.morphPieceAtlas) && c.morphWarmTs) {
      for (const t of c.morphWarmTs) {
        setMorphPose(a, t);
        await frame(a);
        r.precompileFills();
      }
      setMorphPose(a, c.morphT ?? 0.5);
    }
    const expectedEngine = spec.expectedEngine || spec.engine;
    let pinned;
    const warmupImages = [];
    for (let w = 0; w < 24; w++) {
      await frame(a);
      if (spec.captureWarmImages) {
        const ds = r.debugStats;
        warmupImages.push({
          pixels: read(size),
          key: ds.drawnFillVariantKey,
          variantCompiles: ds.variantCompiles,
        });
      }
      r.precompileFills();
      pinned = pin(a);
      await fence();
      await window.__gpuIdle(1);
      const names = Object.keys(pinned).filter(
        (x) =>
          x !== 'defines' &&
          x !== 'ledger' &&
          x !== 'states' &&
          x !== 'auxiliary' &&
          x !== 'instancedDraws' &&
          x !== 'routeLedger' &&
          x !== 'drawCalls',
      );
      if (
        (spec.engine === 'default'
          ? names.length > 0 && names.every((n) => n === 'lb' || n === 'slug')
          : names.length === 1 && names[0] === expectedEngine) &&
        (!spec.unified || spec.allowCpatchDecline || pinned.defines.includes('MANTLE_LB_FILL')) &&
        (a.defines || []).every((d) => pinned.defines.includes(d)) &&
        (!spec.requireAreaSplit ||
          (pinned.defines.includes('MANTLE_CPATCH_QUADRATIC_AREA_ONLY') &&
            pinned.defines.includes('MANTLE_CPATCH_NO_QUADRATIC_AREA'))) &&
        w >= 3
      )
        break;
    }
    const names = Object.keys(pinned).filter(
      (x) =>
        x !== 'defines' &&
        x !== 'ledger' &&
        x !== 'states' &&
        x !== 'auxiliary' &&
        x !== 'instancedDraws' &&
        x !== 'routeLedger' &&
        x !== 'drawCalls',
    );
    if (
      spec.engine === 'default'
        ? !(names.length > 0 && names.every((n) => n === 'lb' || n === 'slug'))
        : names.length !== 1 || names[0] !== expectedEngine
    )
      throw new Error(
        'Wrong program ' +
          spec.name +
          ': ' +
          JSON.stringify({ pin: pinned, gate: r._unifiedFillGate, stats: r.debugStats }),
      );
    if (spec.unified && !spec.allowCpatchDecline && !pinned.defines.includes('MANTLE_LB_FILL'))
      throw new Error('Unified stream not active: ' + spec.name);
    if (!(a.defines || []).every((d) => pinned.defines.includes(d)))
      throw new Error('Experimental defines not active: ' + spec.name);
    if (
      spec.requireAreaSplit &&
      !(
        pinned.defines.includes('MANTLE_CPATCH_QUADRATIC_AREA_ONLY') &&
        pinned.defines.includes('MANTLE_CPATCH_NO_QUADRATIC_AREA')
      )
    )
      throw Error('Both split shaders were not drawn: ' + JSON.stringify(pinned));
    if (
      spec.engine === 'default'
        ? !(pinned.ledger.lb || pinned.ledger.slug || pinned.ledger.sdf)
        : !pinned.ledger[expectedEngine]
    )
      throw new Error('Requested engine absent from draw ledger: ' + JSON.stringify(pinned));
    for (let w = 0; w < 3; w++) await frame(a, c.repetitions || 1);
    await frame(a);
    const pixels = read(size);
    a.pixels = pixels;
    a.result = {
      name: a.name,
      engine: a.engine,
      unified: !!a.unified || a.engine === 'cpatch',
      pin: pinned,
      alpha: c.pixel ? pixels[((size - 1 - c.pixel[1]) * size + c.pixel[0]) * 4 + 3] : null,
      inkAlpha: pixels.filter((_, i) => i % 4 === 3).reduce((s, x) => s + x, 0),
      quality: quality(pixels, c),
      colorQuality: colorQuality(pixels, c),
      rawMs: a.rawMs,
      rawGpuMs: a.rawGpuMs,
    };
    if (spec.captureWarmImages)
      a.result.warmupImages = warmupImages.map(({ pixels: p, ...info }) => ({
        ...info,
        maxDelta: p.reduce((m, v, i) => Math.max(m, Math.abs(v - pixels[i])), 0),
      }));
    if (debugRaw && c.pixel) {
      const off = ((size - 1 - c.pixel[1]) * size + c.pixel[0]) * 4;
      a.result.debugFloat = new DataView(pixels.buffer, pixels.byteOffset + off, 4).getFloat32(
        0,
        true,
      );
      a.result.debugBytes = Array.from(pixels.slice(off, off + 4));
    }
    a.result.imageHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
    if (a.result.inkAlpha === 0 && !spec.allowBlank) throw new Error('Blank output ' + a.name);
    if (c.captureGeometry && spec.engine === 'cpatch') a.result.packed = captureCPatchGeometry(b);
    if (c.captureReferencePixels)
      a.result.referencePixels = (c.referencePixels || []).map(([x, y]) => {
        const at = ((size - 1 - y) * size + x) * 4;
        return { x, y, rgba: Array.from(pixels.subarray(at, at + 4)) };
      });
    if (c.savePixels) a.result.rgba = Array.from(pixels);
    if (c.saveImage) a.result.png = gl.canvas.toDataURL('image/png').split(',')[1];
    a.result.segmentTypeMask = b.segTypeMask;
    if (a.rootCache) a.result.rootCache = a.rootCache.stats;
    if (b.probeMorph)
      a.result.morph = {
        t: c.morphT ?? 0.5,
        areaMonotone: !!b.areaMonotone,
        usesGpuCurveLerp: b.probeMorph.usesGpuCurveLerp,
        matched: b.probeMorph.plan?.matched?.length,
        preparedInterval: a.morphInterval
          ? { t0: a.morphInterval.t0, t1: a.morphInterval.t1 }
          : null,
        cycle: c.morphCycle || null,
        poseUpdatesInTiming: !!a.morphCycle,
        cpatchGpuBlend: !!b._cpatchBlend,
        cpatchPlanReady: typeof b._cpatchMorphPlan === 'object' && !!b._cpatchMorphPlan,
        cpatchNativeShapes:
          b._cpatchMorphPlan?.shapes?.filter((s) => s?.plan?.[0]?.nativeArea).length || 0,
      };
    if (a.pieceAtlas) {
      a.result.atlas = a.pieceAtlas.stats;
      if (a.morphAtlases)
        a.result.morphAtlasPreparation = {
          totalBrowserMs: b.probeMorphBrowserPreparationMs,
          intervals: a.morphAtlases.map((p) => ({
            t0: p.interval.t0,
            t1: p.interval.t1,
            ...p.stats,
          })),
        };
      if (c.inspectAtlas)
        a.result.atlasPixels = pieceResolver.inspectAtlas(a.pieceAtlas, size, c.inspectAtlas);
    }
    a.result.preparation = {
      pendingQuality: a.pendingPixels ? quality(a.pendingPixels, c) : undefined,
      pendingMaxDelta: a.pendingPixels
        ? pixels.reduce((m, v, i) => Math.max(m, Math.abs(v - a.pendingPixels[i])), 0)
        : undefined,
      pendingPlanState: a.pendingPlanState,
      pendingPin: a.pendingPin,
      bail: b._cpatchBail,
      ms: a.prepareMs,
      awaitEngineReady: a.awaitEngineReady,
      firstReadyPin: a.firstReadyPin,
      geometry: a.geometryStats,
      owner: b._fillMeshOwner,
      lbMorphBuilt: !!b._morphMeshesBuilt,
      built: b._cpatchBuilt,
      dropped: b._cpatchDropped,
      unresolved: b._cpatchUnresolved,
      cells: b._cpatchCells,
      meshKinds: (b._lbMeshes || []).reduce((counts, m) => {
        const key =
          !m || m.slug ? 'cover' : m.kindMask & (1 << 14) ? 'cpatch' : m.prim ? 'primitive' : 'lb';
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {}),
    };
    arms.push(a);
    console.log('probe: warmed ' + c.name + ' ' + a.name);
  }
  for (let k = 0; k < (c.rounds || 7); k++)
    for (let j = 0; j < arms.length; j++) {
      const a = arms[(j + k) % arms.length];
      a.morphCycleIndex = 0;
      let q,
        gpuMs = 0,
        primerCpuMs = 0;
      const t = await window.__gpuFrames(
        c.batch || 4,
        () => draw(a, c.repetitions || 1, true),
        async () => {
          gl.endQuery(timer.TIME_ELAPSED_EXT);
          await fence();
        },
        {
          firstBurst: 1,
          begin: () => {
            // Optional untimed frame in the same burst. It reduces clock-ramp
            // confounds after mandatory idle. Its CPU submission gets extra rest;
            // queued GPU work is also covered by the following fence wall time.
            if (c.primer) {
              const t = performance.now();
              draw(a, c.repetitions || 1);
              primerCpuMs = performance.now() - t;
            }
            q = gl.createQuery();
            gl.beginQuery(timer.TIME_ELAPSED_EXT, q);
          },
          end: async () => {
            const start = performance.now();
            while (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
              if (performance.now() - start > 10000) throw new Error('GPU timer query timeout');
              await window.__gpuYield();
            }
            if (gl.getParameter(timer.GPU_DISJOINT_EXT))
              throw new Error('Disjoint GPU timer; reject run');
            gpuMs += gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
            gl.deleteQuery(q);
            if (c.primer) await window.__gpuIdle(primerCpuMs);
          },
        },
      );
      a.rawMs.push(t.ms / (c.batch || 4));
      a.rawGpuMs.push(gpuMs / (c.batch || 4));
    }
  for (const a of arms) {
    a.result.medianMs = med(a.rawMs);
    a.result.minMs = Math.min(...a.rawMs);
    a.result.medianGpuMs = med(a.rawGpuMs);
    a.result.minGpuMs = Math.min(...a.rawGpuMs);
    if (a.bundle.probeMorph) {
      setMorphPose(a, c.morphT ?? 0.5);
      await frame(a);
    }
    a.result.finalPin = pin(a);
    await fence();
    await window.__gpuIdle(1);
    if (JSON.stringify(a.result.finalPin) !== JSON.stringify(a.result.pin))
      throw new Error(
        'Program changed during timing ' +
          a.name +
          ': ' +
          JSON.stringify({ before: a.result.pin, after: a.result.finalPin }),
      );
    if (c.checkImageRestoration || (c.checkMorphRestoration && a.bundle.probeMorph)) {
      const pixels = read(size);
      a.result.finalImageHash = Array.from(
        new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)),
      )
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('');
      if (a.result.finalImageHash !== a.result.imageHash)
        throw Error('Pose restoration changed image ' + a.name);
    }
    result.arms.push(a.result);
  }
  result.comparisons = [];
  for (const a of arms) {
    const base = arms.find(
      (b) => b.name === (a.comparisonBase || c.comparisonBase || 'areaUnified'),
    );
    if (!base || a === base) continue;
    let maxByte = 0,
      changedPixels = 0,
      sum = 0,
      worst = null;
    const overOne = c.captureOverOne ? [] : null;
    for (let i = 0; i < a.pixels.length; i += 4) {
      let changed = false,
        pixelMax = 0;
      for (let k = 0; k < 4; k++) {
        const delta = Math.abs(a.pixels[i + k] - base.pixels[i + k]);
        sum += delta;
        changed ||= delta > 0;
        pixelMax = Math.max(pixelMax, delta);
        if (delta > maxByte) {
          maxByte = delta;
          worst = {
            x: (i / 4) % size,
            y: size - 1 - Math.floor(i / 4 / size),
            channel: k,
            base: base.pixels[i + k],
            actual: a.pixels[i + k],
          };
        }
      }
      if (changed) changedPixels++;
      // Optional sparse-oracle input. Retain every >1-byte disagreement,
      // including all channels; no silent sample/count cap.
      if (overOne && pixelMax > 1)
        overOne.push({
          x: (i / 4) % size,
          y: size - 1 - Math.floor(i / 4 / size),
          baseRGBA: Array.from(base.pixels.subarray(i, i + 4)),
          actualRGBA: Array.from(a.pixels.subarray(i, i + 4)),
        });
    }
    result.comparisons.push({
      base: base.name,
      arm: a.name,
      maxByte,
      changedPixels,
      meanByte: sum / a.pixels.length,
      worst,
      ...(overOne ? { overOne } : {}),
    });
  }
  if (pieceResolver) {
    result.coverageTargets = pieceResolver.targetInfo();
    result.groupTargets = pieceResolver.groupTargetInfo();
  }
  result.duty = window.__gpuDuty();
  result.glError = gl.getError();
  if (result.glError !== gl.NO_ERROR) throw new Error('GL error ' + result.glError);
  // Bundle disposal also stops pending per-bundle conversion resources.
  for (const ov of overrideTables.values()) ov.dispose();
  for (const b of bundles.values()) {
    b.probeRootCache?.dispose();
    if (b.probeMorphAtlases) {
      for (const atlas of b.probeMorphAtlases) {
        atlas.morph.dispose();
        for (const endpoint of atlas.bundle.probeMorphEndpoints) endpoint.dispose();
      }
    } else if (b.probeMorph) {
      b.probeMorph.dispose();
      for (const endpoint of b.probeMorphEndpoints) endpoint.dispose();
    } else if (b.probePieceGroups) {
      for (const g of b.probePieceGroups) g.bundle.dispose();
    } else if (b.dispose) b.dispose();
  }
  return result;
}

export async function preparation(config) {
  return (await import('./preparation.js')).measurePreparation(gl, r, config);
}
