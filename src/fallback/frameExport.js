// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// frameExport.js — serialize the renderer's current FRAME to an SVG
// string by replaying the frame's recorded draw list through an
// offscreen native (DOM) scene, then serializing its <svg>.
//
// Why this shape: the native scene already turns a bundle + overrides +
// recolor into real SVG DOM (cloning the retained source markup, applying
// per-shape transforms/paint, rewriting <path d> for morphs). So "export
// the current frame" is just "draw the current frame on the native
// backend instead of the GPU, then serialize." No GPU read-back.
//
// LAZY by design: everything here runs only when the consumer calls
// exportFrameSVG(). Animation-time cost on the WebGL path is limited to
// recording the draw log + a one-time back-reference stash on morphs.
//
// PRECONDITIONS / LIMITATIONS:
//  - Every drawn bundle must carry `svgSource` (import with
//    { retainSource: true }) so the native scene can clone its markup.
//    Bundles without it are skipped (and counted in the report).
//  - Morph/timeline geometry is rebuilt on the CPU from the morph's
//    src/dst bundles (see shapeMorph.js __exportMorph) — those source
//    bundles must also carry svgSource + their CPU curve/meta arrays
//    (createBundle keeps these).
//  - Raster <image> draws replay only when their source is a re-drawable
//    DOM source / URL; GPU-only image handles are skipped + counted.
//  - setScissorRect (and a dstRect draw's clipToRect box) replays as a per-draw <clipPath> in
//    pixel viewport space, and setNodeClip (in and out) as the native scene's stationary clip;
//    both need coordinateSpace 'viewport' (the default) and otherwise add a note.
//  - Retained source is sanitized: <script>, <foreignObject>, on* attributes and javascript:
//    hrefs are dropped unless { allowActiveContent: true }.
//  - Output is deterministic: the generated-id counter restarts per export, an authored id is
//    kept unless it collides, and the internal data-oid / data-mantle-rows markers are removed.

import { createNativeScene } from './nativeSvgFallback.js';
import { createNativeMorph } from './nativeMorph.js';
import { sectionsToSvgSource } from './nativeTextBundle.js';
import { shortF32, unit, allFinite } from './numFormat.js';

const EMPTY_MAP = new Map();
const SVGNS = 'http://www.w3.org/2000/svg';
const NATIVE_RESOURCE_ID = Symbol.for('@kontek/mantle.nativeResourceId');

/**
 * Replay a recorded frame onto an offscreen native scene and return the
 * resulting SVG markup.
 *
 * @param {object}   [p]
 * @param {Array}    [p.frameLog]  recorded draw entries (see renderer.js).
 *   Optional in fact — the body defaults it to [] and exports an empty frame —
 *   so it is declared optional rather than required-but-defaulted.
 * @param {[number,number]} [p.viewport]  pixel viewport [w,h] to mirror
 * @param {[number,number,number,number]|null} [p.clearColor]
 * @param {Document} [p.document] DOM document (required when globalThis
 *                                has none, e.g. a headless/SSR shim)
 * @param {'viewport'|'bundle'} [p.coordinateSpace='viewport']
 *        How worldMatrix maps to the root viewBox. The WebGL renderer is
 *        always pixel-viewport, so 'viewport' (root viewBox = the pixel
 *        viewport, worldMatrix em→pixel) reproduces on-screen output.
 *        Use 'bundle' for a single em-space bundle with an identity
 *        worldMatrix.
 * @param {(svg:Element)=>string} [p.serialize]  override serializer
 * @param {boolean} [p.allowActiveContent=false]
 *        Keep <script>, <foreignObject>, on* attributes and javascript: hrefs of a bundle's
 *        retained source. They are removed by default so an exported (or inserted) document
 *        cannot run code the source SVG carried; opt in only for a trusted source.
 * @param {boolean} [p.recoverText=false]
 *        When true, text bundles that retained their original text
 *        (createTextBundle({ retainText:true }) → bundle.textSource) are
 *        emitted as a real SVG <text> element instead of glyph outlines.
 *        Text bundles WITHOUT textSource (or with recoverText off) export
 *        as glyph-outline <path>s, synthesized from the bundle geometry.
 * @returns {{ svg: string, drawn: number, skipped: number, notes: string[] }}
 */
export function exportFrameToSvg(p = {}) {
  const frameLog = Array.isArray(p.frameLog) ? p.frameLog : [];
  const doc = p.document || (typeof globalThis !== 'undefined' && globalThis.document) || null;
  if (!doc)
    throw new Error(
      'exportFrameToSvg: no DOM document available — pass ' +
        '{ document } (a real document or a DOM shim) when running headless.',
    );

  const notes = [];
  let drawn = 0,
    skipped = 0;

  // The generated-id counter lives on the document, so two exports on one document would number
  // their ids differently. A top-level export restarts it at 0 and restores it afterwards; a nested
  // one (a morph source rendered for its rows) continues the outer export's numbering.
  const nested = p.__nested === true;
  const savedCounter = doc[NATIVE_RESOURCE_ID];
  if (!nested) doc[NATIVE_RESOURCE_ID] = 0;

  // Detached host — the native scene mounts its <svg> here; nothing is
  // added to the live page. Disposed at the end.
  const host = doc.createElement('div');
  const scene = createNativeScene(host, {
    document: doc,
    coordinateSpace: p.coordinateSpace || 'viewport',
    recordRows: true,
    stableIds: true,
    compactNumbers: true,
    shareInstanceDefs: true,
    allowActiveContent: p.allowActiveContent === true,
  });
  const viewportSpace = (p.coordinateSpace || 'viewport') !== 'bundle';
  const scissorWraps = []; // { node, rect } to wrap after the frame is built
  let viewportH = 0;

  // Per-export caches so a bundle drawn N times (or a morph re-used
  // across draws) builds its native morph once.
  const morphCache = new Map(); // __exportMorph object → native morph
  const builtMorphs = [];

  function nativeMorphFor(ref) {
    let nm = morphCache.get(ref);
    if (!nm) {
      let source = ref.srcBundle;
      if (source.__exportMorph) {
        const box = source.globalBBox || [0, 0, 1, 1];
        const inner = exportFrameToSvg({
          frameLog: [{ kind: 'bundle', bundle: source, opts: {} }],
          viewport: [box[2] || 1, box[3] || 1],
          clearColor: [0, 0, 0, 0],
          coordinateSpace: 'bundle',
          document: doc,
          allowActiveContent: p.allowActiveContent,
          __nested: true,
        });
        if (inner.skipped)
          throw new Error('Cannot export a nested morph source: ' + inner.notes.join('; '));
        const root = new DOMParser().parseFromString(inner.svg, 'image/svg+xml').documentElement,
          paths = new Array(source.numShapes).fill(null);
        const visit = (node, path) => {
          for (const row of (node.getAttribute('data-mantle-rows') || '')
            .split(' ')
            .filter(Boolean)
            .map(Number))
            if (row >= 0 && row < paths.length) paths[row] = path;
          Array.from(node.children || []).forEach((child, index) =>
            visit(child, path.concat(index)),
          );
        };
        visit(root, []);
        source = {
          ...source,
          svgSource: inner.svg,
          shapeDomPaths: paths,
          shapeDomIndex: new Array(source.numShapes).fill(-1),
        };
        delete source.__morphInput;
        delete source.__exportMorph;
      }
      nm = createNativeMorph(source, ref.dstBundle, {
        srcSprite: ref.srcSprite,
        dstSprite: ref.dstSprite,
        compat: ref.compat,
        arcRotation: ref.arcRotation,
      });
      morphCache.set(ref, nm);
      builtMorphs.push(nm);
    }
    return nm;
  }

  // A scissor box needs the pixel-viewport user space; in 'bundle' space it cannot be placed.
  let warnedBundleSpace = false;
  function trackScissor(entry, before) {
    if (!entry.scissor) return;
    if (!viewportSpace) {
      if (!warnedBundleSpace)
        notes.push(
          "setScissorRect / clipToRect and setNodeClip are not replayed with coordinateSpace 'bundle' (they are pixel-viewport boxes).",
        );
      warnedBundleSpace = true;
      return;
    }
    const node = scene.svg.lastChild;
    if (node && node !== before) scissorWraps.push({ node, rect: entry.scissor });
  }

  // A draw whose matrices or recolor hold NaN / Infinity places nothing on GL; it is skipped and
  // reported instead of writing matrix(NaN,...) that a browser would drop and draw unplaced.
  function nonFiniteProblem(opts) {
    if (!allFinite(opts.worldMatrix, 9) || !allFinite(opts.viewportWorldMatrix, 9))
      return 'a draw with a non-finite worldMatrix was skipped (GL draws nothing for it).';
    if (!allFinite(opts.colorMatrix, 16) || !allFinite(opts.colorMatrixOffset, 4))
      return 'a draw with a non-finite colorMatrix / colorMatrixOffset was skipped.';
    return null;
  }

  // Entries that may share one <use> template: a plain full-bundle draw whose only per-draw state
  // is worldMatrix and alpha (what drawBundleInstanced records per instance).
  function groupable(e, bundle) {
    if (!e || e.kind !== 'bundle' || e.bundle !== bundle || !bundle || !bundle.svgSource)
      return false;
    if (bundle.__exportMorph || bundle.fontMetrics || bundle.runMetrics) return false;
    const o = e.opts || {};
    return (
      !e.spriteRange &&
      !e.spriteKey &&
      !e.scissor &&
      !e.nodeClip &&
      !o.overrides &&
      !o.colorMatrix &&
      !o.colorMatrixOffset &&
      !o.palette &&
      !o.channelLerp &&
      !nonFiniteProblem(o)
    );
  }
  const placedMatrix = (o) =>
    (p.coordinateSpace !== 'bundle' && o.viewportWorldMatrix) || o.worldMatrix || undefined;

  try {
    if (p.viewport && p.viewport[0] > 0 && p.viewport[1] > 0) {
      scene.setViewport(p.viewport[0], p.viewport[1]);
      viewportH = p.viewport[1];
    }
    const clearColor = p.clearColor === undefined ? [1, 1, 1, 1] : p.clearColor;
    if (!allFinite(clearColor, 4)) notes.push('a non-finite clearColor channel was written as 0.');
    scene.beginFrame(clearColor);

    for (let i = 0; i < frameLog.length; i++) {
      const entry = frameLog[i];
      if (!entry) continue;
      if (entry.kind === 'image') {
        const before = scene.svg.lastChild;
        if (replayImage(scene, entry, notes)) {
          drawn++;
          trackScissor(entry, before);
        } else skipped++;
        continue;
      }
      // Bundle draw (covers drawBundle + per-instance entries).
      const opts = entry.opts || {};
      const problem = nonFiniteProblem(opts);
      if (problem) {
        notes.push(problem);
        skipped++;
        continue;
      }
      const drawOpts = baseDrawOpts(opts, notes);
      if (p.coordinateSpace !== 'bundle' && opts.viewportWorldMatrix) {
        drawOpts.worldMatrix = opts.viewportWorldMatrix;
      }
      if (entry.nodeClip) {
        const cb =
          entry.nodeClip.clipBundle && entry.nodeClip.clipBundle.bundle !== undefined
            ? entry.nodeClip.clipBundle.bundle
            : entry.nodeClip.clipBundle;
        if (!viewportSpace) {
          if (!warnedBundleSpace)
            notes.push(
              "setScissorRect / clipToRect and setNodeClip are not replayed with coordinateSpace 'bundle' (they are pixel-viewport boxes).",
            );
          warnedBundleSpace = true;
        } else if (!(cb && (cb.svgSource || cb.svgSourceNativeText))) {
          notes.push(
            'a setNodeClip clip bundle lacks svgSource (retainSource); its clip was not replayed.',
          );
        } else drawOpts.nodeClip = entry.nodeClip;
      }

      const morphRef = entry.bundle && entry.bundle.__exportMorph;
      if (morphRef) {
        const nm = nativeMorphFor(morphRef);
        nm.setT(morphRef.t);
        if (morphRef.currentPaths) {
          for (let row = 0; row < morphRef.currentPaths.length; row++) {
            const pathD = morphRef.currentPaths[row];
            if (pathD == null) continue;
            if (row < (morphRef.srcBundle.numShapes | 0)) nm.overrides.update(row, { pathD });
            else {
              const extra = nm.overrides.extraShapes?.find((e) => e.mergedRow === row);
              if (extra) extra.pathD = pathD;
            }
          }
          nm.overrides.bumpExtras?.();
        }
        // The native morph carries geometry (pathD) + crossfade
        // visibility + dst-only extras on its own table; merge any
        // user-supplied override table on top (tint/paint/transform).
        drawOpts.overrides =
          opts.overrides || opts.morphVisibilityResolved
            ? mergedOverrides(
                nm.overrides,
                nativeOverrideView(opts.overrides),
                opts.morphVisibilityResolved === true,
              )
            : nm.overrides;
        // Draw the morph's SRC bundle — it owns the cloned markup the
        // native scene rewrites per shape.
        if (!nm.bundle || !nm.bundle.svgSource) {
          notes.push(
            'morph source bundle lacks svgSource (retainSource); ' + 'skipped a morph draw.',
          );
          skipped++;
          continue;
        }
        const before = scene.svg.lastChild;
        scene.drawBundle(nm.bundle, drawOpts);
        drawn++;
        trackScissor(entry, before);
        continue;
      }

      const bundle = entry.bundle;
      const isText = !!(bundle && (bundle.fontMetrics || bundle.runMetrics));

      // Text recovery: emit a real <text> instead of glyph outlines when
      // the bundle retained its original string (createTextBundle with
      // retainText:true). Built directly (the GL text bundle has no
      // svgSource) under a group carrying the same worldMatrix the scene
      // would apply, so placement matches the outlined glyphs.
      if (isText && p.recoverText && bundle.textSource) {
        const before = scene.svg.lastChild;
        appendRecoveredText(scene.svg, doc, bundle.textSource, drawOpts.worldMatrix, notes);
        drawn++;
        trackScissor(entry, before);
        continue;
      }

      // Resolve renderable markup. SVG bundles carry svgSource; GL text
      // bundles don't (geometry goes straight to the GPU) — synthesize
      // glyph-outline markup from the bundle's own curves/meta so text
      // still exports (as outlines) without an explicit retain flag.
      let drawTarget = bundle;
      if (bundle && !bundle.svgSource && isText) {
        const src = glyphSourceFor(bundle);
        if (src) drawTarget = textBundleView(bundle, src);
      }
      if (!drawTarget || !drawTarget.svgSource) {
        notes.push(
          isText
            ? 'text bundle geometry could not be serialized to glyph outlines; skipped a draw.'
            : 'bundle lacks svgSource (import with retainSource:true); skipped a draw.',
        );
        skipped++;
        continue;
      }
      // A run of plain draws of one bundle (drawBundleInstanced records one entry per instance)
      // shares one template through <use> instead of repeating the clone, its <defs> and its images.
      if (groupable(entry, bundle)) {
        let j = i + 1;
        while (j < frameLog.length && groupable(frameLog[j], bundle)) j++;
        if (j - i >= 2) {
          const instances = [];
          for (let k = i; k < j; k++) {
            const o = frameLog[k].opts || {};
            const inst = { worldMatrix: placedMatrix(o) };
            if (typeof o.alpha === 'number' && Number.isFinite(o.alpha)) inst.alpha = o.alpha;
            instances.push(inst);
          }
          drawn += scene.drawBundleInstanced(drawTarget, instances, {});
          i = j - 1;
          continue;
        }
      }
      drawOpts.overrides = nativeOverrideView(opts.overrides) || undefined;
      // Sprite-subset draw: prefer the sprite id — the native drawBundle
      // isolates that element directly (correct for fill+stroke shapes,
      // where meta rows outnumber DOM elements); the [first,last] row
      // range remains the positional fallback.
      if (entry.spriteRange) drawOpts.shapeRange = entry.spriteRange;
      if (entry.spriteKey) drawOpts.spriteKey = entry.spriteKey;
      const before = scene.svg.lastChild;
      scene.drawBundle(drawTarget, drawOpts);
      drawn++;
      trackScissor(entry, before);
    }

    scene.endFrame();

    // Each scissored draw sits in a wrapper group clipped to its box (pixel viewport space; the GL
    // scissor origin is the lower left, so the top edge is viewport height - (y + h)).
    if (scissorWraps.length) {
      if (!(viewportH > 0))
        notes.push('setScissorRect was not replayed: the export has no pixel viewport.');
      else {
        const defs = doc.createElementNS(SVGNS, 'defs');
        scissorWraps.forEach(({ node, rect }, k) => {
          const id = 'mantleScissor' + k;
          const cp = doc.createElementNS(SVGNS, 'clipPath');
          cp.setAttribute('id', id);
          cp.setAttribute('clipPathUnits', 'userSpaceOnUse');
          const r = doc.createElementNS(SVGNS, 'rect');
          r.setAttribute('x', String(rect[0]));
          r.setAttribute('y', String(viewportH - (rect[1] + rect[3])));
          r.setAttribute('width', String(Math.max(0, rect[2])));
          r.setAttribute('height', String(Math.max(0, rect[3])));
          cp.appendChild(r);
          defs.appendChild(cp);
          const wrap = doc.createElementNS(SVGNS, 'g');
          wrap.setAttribute('clip-path', `url(#${id})`);
          node.parentNode.insertBefore(wrap, node);
          wrap.appendChild(node);
        });
        scene.svg.insertBefore(defs, scene.svg.firstChild);
      }
    }

    const svgEl = scene.svg;
    // The addressing markers (data-oid, data-mantle-rows) serve the replay only; a nested export
    // keeps them because its caller reads the rows.
    if (!nested) stripMarkers(svgEl);
    const svg = p.serialize ? p.serialize(svgEl) : serializeSvg(svgEl);
    return { svg, drawn, skipped, notes: dedupe(notes) };
  } finally {
    for (const nm of builtMorphs) {
      try {
        nm.dispose();
      } catch {
        /* ignore */
      }
    }
    try {
      scene.dispose();
    } catch {
      /* ignore */
    }
    if (!nested) {
      if (savedCounter === undefined) delete doc[NATIVE_RESOURCE_ID];
      else doc[NATIVE_RESOURCE_ID] = savedCounter;
    }
  }
}

function stripMarkers(root) {
  for (let el = root; el;) {
    if (el.nodeType === 1) {
      el.removeAttribute('data-oid');
      el.removeAttribute('data-mantle-rows');
    }
    if (el.firstChild) el = el.firstChild;
    else {
      while (el && el !== root && !el.nextSibling) el = el.parentNode;
      el = el && el !== root ? el.nextSibling : null;
    }
  }
}

// Forwardable per-draw options shared by both backends. Recolor params
// (colorMatrix/channelLerp/palette/paletteChannel) and worldMatrix/alpha
// pass through unchanged; palette is the one handle that needs a shape
// translation (GL texture handle → native entries token).
function baseDrawOpts(opts, notes) {
  const out = {};
  if (opts.worldMatrix) out.worldMatrix = opts.worldMatrix;
  if (typeof opts.alpha === 'number') out.alpha = opts.alpha;
  if (opts.colorMatrix) out.colorMatrix = opts.colorMatrix;
  if (opts.colorMatrixOffset) out.colorMatrixOffset = opts.colorMatrixOffset;
  if (opts.channelLerp) out.channelLerp = opts.channelLerp;
  if (opts.palette) {
    const np = nativePalette(opts.palette);
    if (np) {
      out.palette = np;
      if (opts.paletteChannel != null) out.paletteChannel = opts.paletteChannel;
    } else {
      notes.push(
        'palette handle could not be translated to the native ' +
          'backend (no readable entries); recolor palette omitted for a draw.',
      );
    }
  }
  return out;
}

// GL palette handle → native palette token. The native createPalette
// token is { __nativePalette, entries, size }; a GL palette exposes its
// entries (createPalette keeps them). Pass through if already native.
function nativePalette(pal) {
  if (!pal) return null;
  if (pal.__nativePalette) return pal;
  const entries = pal.entries || (typeof pal.getEntries === 'function' ? pal.getEntries() : null);
  if (!Array.isArray(entries)) return null;
  return { __nativePalette: true, entries, size: entries.length };
}

// Adapt a GL override table to the native-read surface the scene's
// drawBundle loop expects (isNative + activeIndices + get + clippers +
// extraShapes). A native table passes through untouched.
function nativeOverrideView(t) {
  if (!t) return null;
  if (t.isNative) return t;
  return {
    isNative: true,
    get numShapes() {
      return t.numShapes;
    },
    get generation() {
      return t.generation;
    },
    get(k) {
      return t.getEffective ? t.getEffective(k) : t.get(k);
    },
    activeIndices() {
      return t.activeIndices();
    },
    isOverridden(k) {
      const r = t.get(k);
      return !!r;
    },
    // Animated-clipper transforms (overrideTable.setClipper) ride a
    // clipSvgId→affine map on the GL table, so the native scene's
    // applyClippers() reproduces them on the live <clipPath>/<mask>.
    get clippers() {
      return t.clippers || EMPTY_MAP;
    },
    get extraShapes() {
      return null;
    },
    get extrasGeneration() {
      return 0;
    },
    bumpExtras() {},
    setExtraShapes() {},
    uploadIfDirty() {},
    markDirty() {},
    dispose() {},
  };
}

// Combine a morph's native override table (geometry pathD + crossfade
// visibility + dst-only extras) with a user override view (paint /
// transform / tint). User paint + transform win; morph pathD is kept;
// visibilities multiply (a hidden shape stays hidden either way).
function mergedOverrides(morphTable, userView, resolvedVisibility = false) {
  if (!userView && !resolvedVisibility) return morphTable;
  userView = userView || { generation: 0, get: () => null, activeIndices: () => [] };
  return {
    isNative: true,
    get numShapes() {
      return morphTable.numShapes;
    },
    get generation() {
      return morphTable.generation + userView.generation;
    },
    get(k) {
      const m = morphTable.get(k) || {};
      const u = userView.getEffective ? userView.getEffective(k) : userView.get(k);
      if (!u) return resolvedVisibility ? { ...m, visibility: 1 } : m;
      const out = { ...m };
      if (u.localPosition) out.localPosition = u.localPosition;
      if (typeof u.localRotation === 'number') out.localRotation = u.localRotation;
      if (u.localScale) out.localScale = u.localScale;
      if (u.matrix) out.matrix = u.matrix;
      if (u.tint) out.tint = u.tint;
      if (u.fill) out.fill = u.fill;
      if (u.stroke) out.stroke = u.stroke;
      if (typeof u.strokeWidth === 'number') out.strokeWidth = u.strokeWidth;
      const mv = typeof m.visibility === 'number' ? m.visibility : 1;
      const uv = typeof u.visibility === 'number' ? u.visibility : 1;
      out.visibility = resolvedVisibility ? uv : mv * uv;
      return out; // out.pathD from the morph is preserved
    },
    activeIndices() {
      const s = new Set(morphTable.activeIndices());
      for (const i of userView.activeIndices()) s.add(i);
      return [...s];
    },
    isOverridden(k) {
      return !!this.get(k);
    },
    get clippers() {
      return userView.clippers || morphTable.clippers || EMPTY_MAP;
    },
    get extraShapes() {
      const extras = morphTable.extraShapes;
      return !resolvedVisibility || !extras
        ? extras
        : extras.map((e) => ({ ...e, alpha: userView.get(e.mergedRow)?.visibility ?? 1 }));
    },
    get extrasGeneration() {
      return morphTable.extrasGeneration;
    },
    bumpExtras() {},
    setExtraShapes() {},
    uploadIfDirty() {},
    markDirty() {},
    dispose() {},
  };
}

function replayImage(scene, entry, notes) {
  const src = entry.source;
  // GPU-only image handle (createImage output) carries a WebGLTexture and
  // can't be re-rasterized on the DOM backend.
  if (src && src._mantleImage) {
    notes.push(
      'a GPU image handle (createImage) was skipped — re-draw ' +
        'raster images from a re-drawable source (URL / ImageBitmap / ' +
        'canvas) to include them in the export.',
    );
    return false;
  }
  if (typeof scene.drawImage !== 'function') return false;
  try {
    scene.drawImage(src, entry.opts || {});
    return true;
  } catch (e) {
    notes.push(
      'an <image> draw failed to replay on the native backend: ' +
        (e && e.message ? e.message : String(e)),
    );
    return false;
  }
}

// Synthesize glyph-outline SVG from a GL text bundle's geometry. The GL
// bundle stores its curve plane as `curveFloats`; sectionsToSvgSource
// reads `curveTexels`/`curves`, so map it across. Returns null on failure.
function glyphSourceFor(bundle) {
  try {
    return (
      sectionsToSvgSource({
        globalBBox: bundle.globalBBox,
        curveTexels: bundle.curveFloats,
        curveRangesByShape: bundle.curveRangesByShape,
        metaFloats: bundle.metaFloats,
        metaFloatsPerShape: bundle.metaFloatsPerShape,
        shapeIds: bundle.shapeIds,
        numShapes: bundle.numShapes,
      }) || null
    );
  } catch {
    return null;
  }
}

// Minimal native-drawable view of a text bundle with synthesized markup —
// only the fields the native scene's drawBundle reads. Avoids mutating the
// caller's bundle or invoking its getters.
function textBundleView(bundle, svgSource) {
  return {
    svgSource,
    shapeIds: bundle.shapeIds,
    numShapes: bundle.numShapes,
    shapeDomPaths: bundle.shapeDomPaths || null,
    shapeDomIndex: bundle.shapeDomIndex || null,
    clipperRowSets: bundle.clipperRowSets || null,
    clipperRows: bundle.clipperRows || {},
    curveRangesByShape: bundle.curveRangesByShape,
    spriteRanges: bundle.spriteRanges || {},
  };
}

// Emit a recovered <text> inside a group carrying the bundle's worldMatrix
// (same matrix convention as nativeSvgFallback.worldMatrixToTransform).
function appendRecoveredText(svg, doc, ts, worldMatrix, notes) {
  const g = doc.createElementNS(SVGNS, 'g');
  const tf = worldMatrixToTransform(worldMatrix);
  if (tf) g.setAttribute('transform', tf);
  const t = doc.createElementNS(SVGNS, 'text');
  t.setAttribute('x', String(ts.originX || 0));
  t.setAttribute('y', String(ts.baselineY || 0));
  t.setAttribute('font-size', String(ts.fontSizeEm || 1));
  if (ts.fontFamily) t.setAttribute('font-family', ts.fontFamily);
  t.setAttribute('fill', rgbaToCss(ts.fill));
  if (ts.textAnchor && ts.textAnchor !== 'start') t.setAttribute('text-anchor', ts.textAnchor);
  t.textContent = ts.text || '';
  g.appendChild(t);
  svg.appendChild(g);
  if (ts.unrecovered && ts.unrecovered.length)
    notes.push(
      `recovered <text> does not carry style.${ts.unrecovered.join(', style.')}: the glyph outlines were shaped ` +
        'with it, the exported text element is not.',
    );
  if ((ts.lineCount | 0) > 1)
    notes.push(
      'recovered <text> for a multi-line run as a single element; ' +
        'wrapped line breaks are not reconstructed (the break positions ' +
        'are not retained).',
    );
}

function worldMatrixToTransform(wm) {
  if (!wm) return null;
  const a = wm[0],
    b = wm[1],
    c = wm[3],
    d = wm[4],
    e = wm[6],
    f = wm[7];
  if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) return null;
  const n = wm instanceof Float32Array ? shortF32 : String;
  return `matrix(${n(a)},${n(b)},${n(c)},${n(d)},${n(e)},${n(f)})`;
}

function rgbaToCss(c) {
  if (!c) return '#000';
  const r = Math.round(unit(c[0]) * 255);
  const g = Math.round(unit(c[1]) * 255);
  const b = Math.round(unit(c[2]) * 255);
  const a = unit(c.length > 3 ? c[3] : 1);
  return `rgba(${r},${g},${b},${a})`;
}

function serializeSvg(svgEl) {
  if (!svgEl) return '';
  if (typeof globalThis !== 'undefined' && typeof globalThis.XMLSerializer === 'function') {
    return new globalThis.XMLSerializer().serializeToString(svgEl);
  }
  // DOM shims that don't ship XMLSerializer usually still implement
  // outerHTML on elements.
  if (typeof svgEl.outerHTML === 'string') return svgEl.outerHTML;
  throw new Error(
    'exportFrameToSvg: no XMLSerializer and no outerHTML on the ' +
      'native <svg> — pass a { serialize } function to control serialization.',
  );
}

function dedupe(arr) {
  return [...new Set(arr)];
}
