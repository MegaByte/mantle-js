// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

import { checkedSpriteBounds, ownSpriteRange } from '../core/spriteRange.js';
import { buildStylesheet, setActiveStylesheet } from '../svg/stylesheet.js';
import { getStyleProp } from '../svg/style.js';
import { parseTransform, matMul, viewBoxFit } from '../svg/transform.js';
import { parseLengthOr } from '../svg/length.js';
import { clipperRowGroups } from '../bundle/layout.js';
import { svgElementName } from '../svg/utils.js';
// nativeSvgFallback.js — render Mantle bundles WITHOUT WebGL by handing
// the browser the original source SVG and letting its native SVG engine
// rasterize. The drop-in fallback for environments with no WebGL2
// context (GPU blocklist, ancient browsers, some headless setups).
//
// It mirrors the renderer's multi-bundle scene API:
//
//     const scene = createNativeScene(canvas);   // or an <svg> host
//     scene.setViewport(w, h);
//     function frame() {
//       scene.beginFrame([r, g, b, a]);
//       for (const node of nodes)
//         scene.drawBundle(node.bundle, { worldMatrix, overrides });
//       scene.endFrame();
//       requestAnimationFrame(frame);
//     }
//
// so a consumer's existing scene loop runs unchanged — only the factory
// at the seam differs: `gl ? createRenderer(gl, …) : createNativeScene(canvas)`.
//
// COMPOSITION MODEL (why ONE <svg>, not N overlaid):
// The renderer composites bundles by painter's algorithm — each
// drawBundle paints over the previous in call order, with NO cross-
// bundle pixel interaction. That is exactly SVG's own document-order
// paint model, so the whole scene maps to sibling <g> nodes inside one
// <svg>. Each draw becomes a `<g transform="matrix(...)">` wrapping that
// bundle's source content; z-order = sibling order = call order.
//
// What works: solid/gradient fills + strokes, <mask>/<filter>/<clipPath>
// (the browser re-evaluates them per frame natively as geometry moves),
// per-shape overrides (transform/visibility/recolor by id), animated
// clip transforms (setClipper), and geometry MORPHS (the native morph
// rewrites each shape's `d` per frame — see nativeMorph.js).
//
// What differs: output is the browser's SVG rasterization, NOT Mantle's
// coverage — visually equivalent, not bit-identical.

import { curveRangeToPathD, transformPathD } from './curveToPathD.js';
import { dstRectAffine } from '../geom/dstRect.js';
import { mantleWarn } from '../core/diagnostics.js';
import { parseColor } from '../svg/color.js';
import { isSvgHref } from '../svg/image.js';
import { applyRecolor, hasRecolor } from './recolorColor.js';
import { scopeCssText } from './scopeCss.js';
import { unit, shortF32, badMatrix } from './numFormat.js';
import { clampArg } from '../core/argCheck.js';
import { createSlotIndex } from './nativeSlotIndex.js';

const SVGNS = 'http://www.w3.org/2000/svg';
/**
 * @typedef {object} NativeImageToken
 * @property {boolean} __nativeImage
 * @property {any} source
 * @property {number|undefined} width
 * @property {number|undefined} height
 * @property {string|null} href
 * @property {Promise<NativeImageToken>} ready Resolves once the image href is settled.
 * @property {() => void} dispose Releases the token's blob URL.
 */
const NATIVE_RESOURCE_ID = Symbol.for('@kontek/mantle.nativeResourceId');
function nativeResourceId(document, prefix) {
  const next = (document[NATIVE_RESOURCE_ID] || 0) + 1;
  document[NATIVE_RESOURCE_ID] = next;
  return prefix + next;
}

// Encoded preserveAspectRatio (parAx, parAy, parMs) → SVG attribute.
function parToAttr(par) {
  if (!par) return 'xMidYMid meet';
  const [ax, ay, ms] = par;
  if (ax === -1) return 'none';
  const a = ax === 0 ? 'Min' : ax === 2 ? 'Max' : 'Mid';
  const b = ay === 0 ? 'Min' : ay === 2 ? 'Max' : 'Mid';
  return `x${a}Y${b} ${ms === 1 ? 'slice' : 'meet'}`;
}

/// A number as the shortest decimal that keeps 7 significant digits (a tweened gradient is rewritten every frame).
function shortNumber(v) {
  return Number.isFinite(v) ? String(+v.toPrecision(7)) : '0';
}

function rgbaToCss(c) {
  const r = Math.round(unit(c[0]) * 255);
  const g = Math.round(unit(c[1]) * 255);
  const b = Math.round(unit(c[2]) * 255);
  const a = unit(c.length > 3 ? c[3] : 1);
  return `rgba(${r},${g},${b},${a})`;
}

const cloneOpacity = new WeakMap();
let _bundleRecordSeq = 0; // stable per-bundle id for slot keying

// Build a per-bundle render record: parse the source SVG once, index
// the inner content + the elements addressable by override id. Cached
// on the bundle so re-drawing the same bundle each frame is cheap.
function ensureBundleRecord(bundle, nativeText) {
  // Two cache slots: the default (expanded) svgSource and the optional
  // authored-<text> form. A bundle can be drawn in both modes by
  // different scenes without the records colliding.
  const cacheKey = nativeText ? '__nativeRecordText' : '__nativeRecord';
  if (bundle[cacheKey]) return bundle[cacheKey];
  // nativeText mode renders the authored markup (real <text>, drawn by the
  // browser's own text engine). Falls back to svgSource when the bundle
  // carries no separate native-text form (i.e. it had no <text>).
  const source = (nativeText && bundle.svgSourceNativeText) || bundle.svgSource;
  if (!source) {
    throw new Error(
      'createNativeScene: bundle has no svgSource. Import with ' +
        '`importSvg(text, { retainSource: true })` so the fallback can ' +
        'render the original markup.',
    );
  }
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() === 'parsererror')
    throw new Error('createNativeScene: failed to parse bundle.svgSource');

  setActiveStylesheet(root, buildStylesheet(root));
  const rec = { sourceRoot: root, doc, id: `b${_bundleRecordSeq++}` };
  bundle[cacheKey] = rec;
  return rec;
}

// Rewrite a re-hosted subtree's raster <image> hrefs so the browser can
// resolve them. The browser resolves a relative href against the PAGE
// url (not the SVG file's), and a cross-origin remote href taints —
// either can make an <image> silently fail. Two fixes, in priority:
//   1. inline from the bundle's decoded atlas (cross-origin-safe, exact
//      bytes the WebGL path used) when `bundle.imageAtlas` is present;
//   2. else absolutize relative hrefs against `opts.baseUrl`.
// data:/blob: hrefs are left as-is (already self-contained).
function rewriteImageHrefs(frag, ownerDoc, bundle, opts) {
  const imgs = frag.querySelectorAll ? frag.querySelectorAll('image') : [];
  if (!imgs || !imgs.length) return;
  const atlasUrls = opts && opts.inlineFromAtlas !== false ? atlasDataUrls(bundle, ownerDoc) : null;
  const base = opts && opts.baseUrl;
  // atlasUrls is indexed by RASTER-claim order: the importer only pushes
  // decoded raster images to the atlas — data:/blob: hrefs are
  // self-contained and SVG-content hrefs are inlined recursively, so
  // neither takes an atlas slot. Advance the cursor only for hrefs the
  // importer would have claimed as raster, else a non-atlas <image>
  // preceding a raster one shifts every subsequent atlas index.
  let atlasIdx = 0;
  for (const im of Array.from(imgs)) {
    const href =
      im.getAttribute('href') || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (/^(data:|blob:)/i.test(href) || isSvgHref(href)) continue;
    let next = null;
    if (atlasUrls && atlasUrls[atlasIdx]) next = atlasUrls[atlasIdx];
    else if (base) {
      try {
        next = new URL(href, base).href;
      } catch {}
    }
    if (next) {
      im.setAttribute('href', next);
      im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', next);
    }
    atlasIdx++;
  }
}

// Reconstruct one data: URL per atlas image (document order = imageId
// order, the same order the importer claimed them). Cached on the bundle.
function atlasDataUrls(bundle, ownerDoc) {
  if (bundle.__atlasDataUrls) return bundle.__atlasDataUrls;
  if ((!bundle.imageAtlas && !bundle.secondaryImageAtlas) || !bundle.imageAtlasRects) return null;
  const urls = bundle.imageAtlasRects.map(([atlasY, w, h], index) => {
    const secondary = bundle.imageAtlasSources?.[index] === 1;
    const [atlasW] = (secondary ? bundle.secondaryImageAtlasDim : bundle.imageAtlasDim) || [0, 0];
    const px = new Uint8Array((secondary ? bundle.secondaryImageAtlas : bundle.imageAtlas) || 0);
    const cv = ownerDoc.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d');
    const id = ctx.createImageData(w, h);
    // Copy the sub-rect (w may be < atlasW; rows are atlasW wide).
    for (let row = 0; row < h; row++) {
      const srcOff = (atlasY + row) * atlasW * 4;
      const dstOff = row * w * 4;
      id.data.set(px.subarray(srcOff, srcOff + w * 4), dstOff);
    }
    ctx.putImageData(id, 0, 0);
    return cv.toDataURL('image/png');
  });
  bundle.__atlasDataUrls = urls;
  return urls;
}

// The data: URL of a Blob's bytes.
function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// Namespace every authored id in a freshly-cloned bundle subtree so that
// id-references (`url(#m1)` masks/clips/gradients/filters, `href="#g"`
// templates) DO NOT COLLIDE across bundles in the shared host <svg>.
//
// The original id is preserved on `data-oid` so the override path (which
// addresses clip/mask/shape elements by their AUTHORED id via `slotEl`) keeps
// working — slotEl indexes both the live (namespaced) id and `data-oid`.
const NS_REF_ATTRS = [
  'mask',
  'clip-path',
  'fill',
  'stroke',
  'filter',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
];
//
// `ns.usedIds` (a Set, the stable-id mode the frame export uses) keeps an authored id as it is
// unless that id is already in use in the scene or collides with a generated resource id; only
// the colliding ids are renamed. Without it every id is renamed (the live-scene default).
//
// Retained <style> text is scoped to this clone and its renamed ids are rewritten in it (see
// scopeCss.js). Returns the scope value to put on the clone's host group as `data-mantle-scope`,
// or null when the clone has no <style>.
const GENERATED_ID =
  /^(morphBitmap|morphPaint|mantleNativeInstance|mantleRasterClip|mantleRasterTint|mantleExtClip_)\d*/;
function namespaceCloneIds(root, ns) {
  if (!root.querySelectorAll) return null;
  const idEls = root.querySelectorAll('[id]');
  const styleEls = root.querySelectorAll('style');
  if (!idEls.length && !styleEls.length) return null;
  const used = ns && ns.usedIds;
  let suffix = null;
  const sfx = () => suffix || (suffix = nativeResourceId(root.ownerDocument, '_b'));
  const map = new Map();
  for (const el of idEls) {
    const old = el.getAttribute('id');
    if (!old) continue;
    if (used && !used.has(old) && !map.has(old) && !GENERATED_ID.test(old)) {
      used.add(old);
      map.set(old, old);
      continue;
    }
    const live = old + sfx();
    if (used) used.add(live);
    if (!map.has(old)) map.set(old, live);
    el.setAttribute('data-oid', old);
    el.setAttribute('id', live);
  }
  let scope = null;
  if (styleEls.length) {
    scope = sfx();
    for (const st of styleEls) {
      const text = st.textContent;
      if (text) st.textContent = scopeCssText(text, scope, map);
    }
  }
  if (!map.size) return scope;
  const rewrite = (v) =>
    v.replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (m, quote, id) =>
      map.has(id) ? `url(#${map.get(id)})` : m,
    );
  for (const el of root.querySelectorAll('*')) {
    if (!el.getAttribute) continue;
    for (const a of NS_REF_ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.indexOf('url(') >= 0) {
        const nv = rewrite(v);
        if (nv !== v) el.setAttribute(a, nv);
      }
    }
    const st = el.getAttribute('style');
    if (st && st.indexOf('url(') >= 0) {
      const nv = rewrite(st);
      if (nv !== st) el.setAttribute('style', nv);
    }
    for (const h of ['href', 'xlink:href']) {
      const hv = el.getAttribute(h);
      if (
        hv &&
        hv.charAt(0) === '#' &&
        map.has(hv.slice(1)) &&
        map.get(hv.slice(1)) !== hv.slice(1)
      )
        el.setAttribute(h, '#' + map.get(hv.slice(1)));
    }
  }
  return scope;
}

// Whether a URL value runs script when followed. The URL parser drops leading C0 controls and spaces, and tabs and newlines anywhere,
// so `java&#9;script:` is the same scheme.
const isScriptUrl = (v) =>
  /^javascript:/i.test(
    String(v)
      .replace(/^[\u0000-\u0020]+/, '')
      .replace(/[\t\n\r]/g, ''),
  );
const ANIMATES_HREF = /^(set|animate)$/i;

// Remove the active content a retained source can carry before it is cloned into a live
// document: <script>, <foreignObject>, an HTML element that loads a document, on* event-handler
// attributes, javascript: hrefs and the animations that would write one.
// The retained svgSource string is untouched; only the cloned DOM (and so the export) is cleaned.
// createNativeScene / exportFrameSVG({ allowActiveContent: true }) keeps it for a trusted source.
function stripActiveContent(root) {
  if (!root.querySelectorAll) return;
  for (const el of Array.from(
    root.querySelectorAll('script, foreignObject, iframe, embed, object'),
  ))
    el.remove();
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (!el.attributes) continue;
    if (
      ANIMATES_HREF.test(el.localName || el.tagName || '') &&
      /(^|:)href$/i.test(el.getAttribute('attributeName') || '') &&
      ['to', 'from', 'by', 'values'].some(
        (a) =>
          el.getAttribute(a) != null && String(el.getAttribute(a)).split(';').some(isScriptUrl),
      )
    ) {
      el.remove();
      continue;
    }
    for (const a of Array.from(el.attributes)) {
      const name = a.name.toLowerCase();
      if (name.startsWith('on')) el.removeAttribute(a.name);
      else if (
        (name === 'href' || name === 'xlink:href' || name.endsWith(':href')) &&
        isScriptUrl(a.value)
      )
        el.removeAttribute(a.name);
    }
  }
}

function cloneSourceInner(rec, ownerDoc, bundle, hrefOpts, mount, ns) {
  const frag = ownerDoc.createDocumentFragment();
  const snapshotOpacity = (source, copy) => {
    if (source.nodeType === 1) {
      let value = getStyleProp(source, 'opacity', '1'),
        parent = source.parentNode;
      while (value === 'inherit' && parent?.nodeType === 1) {
        value = getStyleProp(parent, 'opacity', '1');
        parent = parent.parentNode;
      }
      cloneOpacity.set(copy, value);
    }
    for (let i = 0; i < source.childNodes.length; i++)
      snapshotOpacity(source.childNodes[i], copy.childNodes[i]);
  };
  for (const child of Array.from(rec.sourceRoot.childNodes)) {
    const copy = ownerDoc.importNode(child, true);
    snapshotOpacity(child, copy);
    frag.appendChild(copy);
  }
  // querySelectorAll isn't on a DocumentFragment in every engine; wrap in a
  // temp <g> that supports it — used for both id-namespacing + image hrefs.
  const probe = ownerDoc.createElementNS(SVGNS, 'g');
  probe.appendChild(frag);
  if (!(ns && ns.allowActiveContent)) stripActiveContent(probe);
  const scope = namespaceCloneIds(probe, ns);
  if (scope && mount) mount.setAttribute('data-mantle-scope', scope);
  if (bundle && (bundle.imageAtlas || (hrefOpts && hrefOpts.baseUrl))) {
    rewriteImageHrefs(probe, ownerDoc, bundle, hrefOpts);
  }
  const out = ownerDoc.createDocumentFragment();
  while (probe.firstChild) out.appendChild(probe.firstChild);
  return out;
}

/**
 *
 * Returns the scene: setViewport / beginFrame / drawBundle / endFrame (its type is inferred from the returned object).
 *
 * @param {Element} host  an <svg>, a container element or a <canvas>; required
 * @param {object}  [opts]
 * @param {Document} [opts.document]  defaults to host.ownerDocument
 * @param {'bundle'|'viewport'} [opts.coordinateSpace='bundle']  user space of
 *   the root <svg>: 'bundle' adopts the first drawn bundle's viewBox (so a
 *   worldMatrix operates in em space, as on WebGL); 'viewport' makes it the
 *   pixel viewport, and bundles place themselves via their em→pixel matrix
 * @param {string} [opts.baseUrl]  resolves relative href/url() references in
 *   cloned source markup
 * @param {(href: string) => string|null} [opts.inlineFromAtlas]  hook to
 *   resolve an <image> href against a caller-side atlas, returning a data URI
 *   to inline (null = leave the href alone)
 * @param {boolean} [opts.nativeText=false]  keep <text> elements as live text
 *   instead of importer-emitted glyph outlines. Cheaper and selectable, but the
 *   result depends on locally available fonts — static / whole-bundle-recolor
 *   text only
 * @param {boolean} [opts.allowActiveContent=false]  keep <script>, <foreignObject>,
 *   on* attributes and javascript: hrefs in the cloned source (removed by default;
 *   enable only for a source you trust)
 * @param {boolean} [opts.stableIds=false]  keep an authored id unless a second clone
 *   would collide with it (default: rename every id with a per-clone suffix). The
 *   frame export sets it so its markup reads like its source
 * @param {boolean} [opts.compactNumbers=false]  print a Float32Array worldMatrix with
 *   the shortest decimals that keep its float32 values
 * @param {boolean} [opts.shareInstanceDefs=false]  let an instanced draw of art with
 *   defs, gradients, images, masks, clips or filters share one template through
 *   <use> (default: only definition-free art does)
 */
export function createNativeScene(host, opts = {}) {
  if (host == null)
    throw new Error(
      'createNativeScene: host required (an <svg>, a container element or a <canvas>)',
    );
  const ownerDoc =
    opts.document ||
    (host && host.ownerDocument) ||
    (typeof document !== 'undefined' ? document : null);
  if (!ownerDoc) throw new Error('createNativeScene: no document available');

  let svg;
  if (host && host.tagName && svgElementName(host) === 'svg') {
    svg = host;
  } else {
    svg = ownerDoc.createElementNS(SVGNS, 'svg');
    if (host && host.tagName && host.tagName.toLowerCase() === 'canvas') {
      // Best-effort overlay: position the <svg> over the canvas.
      mantleWarn(
        'createNativeScene: a <canvas> host cannot be painted by ' +
          'SVG directly; creating an <svg> overlay. Pass an <svg> or container ' +
          'element to avoid the overlay.',
      );
      svg.style.position = 'absolute';
      if (host.parentNode) host.parentNode.insertBefore(svg, host.nextSibling);
    } else if (host) {
      host.appendChild(svg);
    }
  }

  // Clone-time policy shared by every clone this scene makes: `stableIds` keeps authored ids that
  // do not collide (the frame export sets it, so an export reads like its source), and active
  // content (script, on* handlers, javascript: hrefs, foreignObject) is stripped from the cloned
  // source unless `allowActiveContent` opts in for a trusted source.
  // `compactNumbers` prints a Float32Array matrix with the shortest decimals that keep its float32
  // value; `shareInstanceDefs` lets an instanced draw of art with <defs>, gradients, images, masks,
  // clips or filters share one template through <use>. Both are set by the frame export.
  const compactNumbers = !!opts.compactNumbers;
  const shareInstanceDefs = !!opts.shareInstanceDefs;
  const idNs = {
    usedIds: opts.stableIds ? new Set() : null,
    allowActiveContent: !!opts.allowActiveContent,
  };

  let vpW = 0,
    vpH = 0;
  let activeViewBox = null;
  // Coordinate space (mirrors how a consumer drives worldMatrix):
  //   'bundle'   (default) — single-bundle / simple use. The root viewBox
  //               is the (first) bundle's em/viewBox space and worldMatrix
  //               is an em-space SVG transform. Back-compat default.
  //   'viewport' — MULTI-BUNDLE PIXEL COMPOSITOR. The root
  //               viewBox is the pixel viewport (0 0 w h); each bundle's
  //               worldMatrix is an em→pixel affine (maps the bundle's own
  //               em vertices straight to viewport pixels). This matches a
  //               DOM/CSS compositor and the WebGL path's pixel-space
  //               result — see setCoordinateSpace.
  let coordSpace = opts.coordinateSpace === 'viewport' ? 'viewport' : 'bundle';
  // nativeText: render <text> via the browser's own text engine (crisper,
  // selectable) using the authored markup, instead of the default
  // expanded glyph <path>s. Per-glyph morph/override addressing is NOT
  // available in this mode (a <text> is one element, not N glyph shapes),
  // so use it for static / whole-bundle-recolor text only.
  const useNativeText = opts.nativeText === true;
  let frameOpen = false;
  let frameEpoch = 0;
  // Reserve the clear before content; the first bundle can refine its bounds.
  let _clearColor = null;
  const clearValues = new Float64Array(4);
  let clearSlot = null,
    clearViewBox = null;
  let _clearPushed = false;
  // One warning per scene and cause for a dstRect that cannot be honored, so a per-frame draw cannot flood.
  const _warnedDstRect = new Set();
  // Deferred z-order submission mirrors the WebGL frame-loop surface. Native
  // paint order is DOM sibling order, so flushing this queue before endFrame's
  // slot reconciliation gives the same `(zOrder, submission)` semantics.
  let _submitQ = [];
  let _submitSeq = 0;

  // ── Positional reconciliation ────────────────────────────────────────
  // The native fallback is the no-GPU path. Keep persistent DOM nodes
  // ("slots") mounted across frames and, per frame, only UPDATE what
  // changed (a <g>'s transform, an overridden shape's attrs, an <image>'s
  // dst rect) — rather than a full DOM teardown + re-clone every frame.
  // Match slots by draw position until the order changes, then index unused slots.
  // Skipped nodes stay mounted until reused or removed by endFrame. Separate
  // input/output arrays avoid repeated shifts; steady frames reuse their array.
  let _slots = [],
    _nextSlots = [];
  let _readCursor = 0,
    _slotIndex = null,
    _reconciling = false,
    _reconcileFrom = 0;
  // Retain one detached raster slot per href for brief absences, oldest first.
  const _restingRasters = new Map();
  const RASTER_KEPT_FRAMES = 120;
  const MAX_RESTING_RASTERS = 32;
  let _rebuildNextBundle = false;
  // Per-scene SVG templates for the native instancing fast path. Templates
  // live under <defs>; each instance is a lightweight <g><use/></g> slot in
  // painter order. A failed construction is cached as { failed:true } so a
  // hostile/custom document takes the clone path without retrying per frame.
  let _instanceTemplates = new WeakMap();
  const activeTemplates = new Set();

  function startReconcile() {
    if (_reconciling) return;
    _reconciling = true;
    _reconcileFrom = _readCursor;
    for (let i = 0; i < _readCursor; i++) _nextSlots.push(_slots[i]);
  }

  // Prefer the next old slot, then a matching slot ahead, then one stepped over.
  // Only a returning node moves; a skipped node stays mounted until endFrame.
  function acquireSlot(key, kind, makeNode, source, rebuild = false) {
    const cur = _slots[_readCursor];
    if (
      !rebuild &&
      cur &&
      cur.key === key &&
      cur.kind === kind &&
      (!cur.streamSource || cur.streamSource === source)
    ) {
      _readCursor++;
      if (_reconciling) {
        cur.seenFrame = frameEpoch;
        _nextSlots.push(cur);
      }
      return { slot: cur, node: cur.node, reused: true };
    }
    startReconcile();
    let slot = null;
    if (!rebuild) {
      if (!_slotIndex) _slotIndex = createSlotIndex(_slots, frameEpoch, _reconcileFrom);
      slot = _slotIndex(key, kind, source, _readCursor);
      if (slot) {
        if (slot.position >= _readCursor) _readCursor = slot.position + 1;
        else mountAt(slot.node, cur);
      }
      if (!slot && kind.startsWith('image-')) {
        const resting = _restingRasters.get(key);
        if (resting && resting.kind === kind) {
          slot = resting;
          _restingRasters.delete(key);
          for (const def of [slot.rasterCrop?.clip, slot.rasterFilter?.filter, slot.dstClip?.clip])
            if (def && !def.parentNode) ensureDefs().appendChild(def);
          mountAt(slot.node, cur);
        }
      }
    }
    const reused = !!slot;
    if (!slot) {
      const node = makeNode();
      mountAt(node, cur);
      slot = newSlot(key, kind, node);
    }
    slot.seenFrame = frameEpoch;
    _nextSlots.push(slot);
    return { slot, node: slot.node, reused };
  }

  // Mount `node` just before the slot now at the cursor (document order is
  // draw order), or last when the cursor is past the slots.
  function mountAt(node, before) {
    if (before && before.node.parentNode === svg) svg.insertBefore(node, before.node);
    else svg.appendChild(node);
  }

  function dropSlot(slot) {
    if (slot.node.parentNode === svg) svg.removeChild(slot.node);
    releaseRasterDefinitions(slot);
  }

  function retireSlot(slot) {
    dropSlot(slot);
    if (!slot.imageEl || slot.rasterDisposed) return;
    slot.restFrame = frameEpoch;
    _restingRasters.delete(slot.key);
    _restingRasters.set(slot.key, slot);
  }

  function trimRestingRasters() {
    for (const [key, slot] of _restingRasters) {
      if (
        _restingRasters.size <= MAX_RESTING_RASTERS &&
        frameEpoch - slot.restFrame < RASTER_KEPT_FRAMES
      )
        break;
      _restingRasters.delete(key);
    }
  }

  function releaseRasterDefinitions(slot) {
    if (!slot) return;
    if (slot.rasterCrop && slot.rasterCrop.clip.parentNode)
      slot.rasterCrop.clip.parentNode.removeChild(slot.rasterCrop.clip);
    if (slot.rasterFilter && slot.rasterFilter.filter.parentNode)
      slot.rasterFilter.filter.parentNode.removeChild(slot.rasterFilter.filter);
    if (slot.dstClip && slot.dstClip.clip.parentNode)
      slot.dstClip.clip.parentNode.removeChild(slot.dstClip.clip);
  }

  function newSlot(key, kind, node) {
    return {
      key,
      kind,
      node,
      // id → element index for the cloned subtree, built lazily on first
      // override (avoids a per-frame querySelector('#id') tree-walk). null
      // until indexed; rebuilt if the subtree is replaced (acquireSlot
      // makes a new slot object then).
      idIndex: null,

      orig: new Map(),

      applied: new Map(),
      // element → Set<attr> set this frame (reset per draw); used at frame
      // end to revert attrs that were applied last frame but not this one.
      frameTouch: new Map(),
      // element → Map<attr, value> written by the last override pass, written again
      // when the table's generation says nothing changed.
      overrideAttrs: new Map(),
      // Identity + revision of the override table this slot last walked.
      overrideTable: null,
      overrideGeneration: -1,
    };
  }

  function slotEl(slot, groupEl, id) {
    let idx = slot.idIndex;
    if (!idx) {
      idx = slot.idIndex = new Map();
      // One subtree walk total (not per-frame): index every id-bearing node.
      // Index by both the live (per-clone namespaced) id AND the authored id
      // recorded on `data-oid` (see namespaceCloneIds) so override addressing —
      // which uses authored clip/mask/shape ids — resolves regardless of the
      // namespacing applied at host time. Per-group scope keeps authored ids
      // unique here even though they collide document-wide.
      const all = groupEl.querySelectorAll('[id]');
      for (const el of all) {
        idx.set(el.getAttribute('id'), el);
        const oid = el.getAttribute('data-oid');
        if (oid && !idx.has(oid)) idx.set(oid, el);
      }
    }
    return idx.get(id) || null;
  }

  // Renderable shape tags whose fill/stroke/geometry overrides + recolor
  // target. (Containers like <g>/<svg>/<defs> and paint servers excluded —
  // addressing acts on leaf geometry, matching importer shape numbering.)
  const RECOLOR_TAGS = new Set([
    'path',
    'rect',
    'circle',
    'ellipse',
    'polygon',
    'polyline',
    'line',
    'text',
  ]);

  // Non-rendered containers. A shape element INSIDE one of these defines
  // mask/clip/paint-server/template geometry — it is NOT a rendered leaf,
  // and the importer numbers it separately (mask/clip "layer" rows come
  // AFTER the visible shapes; clip/mask geometry is addressed by id via
  // setClipper, not positionally). They also appear FIRST in document
  // order (<defs> precedes content), so counting them would shift every
  // visible shape's positional index on masked/clipped art.
  const NON_RENDER_CONTAINERS = new Set([
    'defs',
    'mask',
    'clippath',
    'symbol',
    'pattern',
    'marker',
  ]);
  // The groups a split <use> leaves behind (splitUseInstances) hold the <use>'s rows, which the importer numbers apart from its
  // rendered leaves (shapeDomIndex -1, routed by shapeDomPaths to the template and on to the instance); counting their copies
  // as leaves would shift the ordinal of every shape drawn after the use.
  const _splitWraps = new WeakSet();
  function inNonRenderContainer(el, stopAt) {
    for (let p = el.parentNode; p && p !== stopAt && p.nodeType === 1; p = p.parentNode) {
      if (NON_RENDER_CONTAINERS.has(svgElementName(p)) || _splitWraps.has(p)) return true;
    }
    return false;
  }

  // Synthetic importer ids (shape_<N>_fill / _stroke) never exist in the
  // source markup — treat them as "no id" so addressing falls back to
  // positional. Authored ids (anything else) are looked up directly.
  function isSyntheticId(id) {
    return /^shape_\d+_(fill|stroke)$/.test(id);
  }

  // Map a shape INDEX to its element positionally: the N-th renderable leaf
  // in document order, matching the importer's shape numbering. Built once
  // per slot and rebuilt when a primitive→<path> swap mutates the subtree
  // (recolorElsStale shares the same invalidation). This is what makes
  // morphs/overrides work on id-less artwork.
  function shapeElByIndex(slot, groupEl, idx) {
    if (!slot.shapeEls || slot.shapeElsStale) {
      slot.shapeEls = [];
      const all = groupEl.querySelectorAll('*');
      for (const el of all) {
        if (!RECOLOR_TAGS.has(svgElementName(el))) continue;
        // Skip shape elements inside <defs>/<mask>/<clipPath>/… — they are
        // not rendered leaves and would shift every visible shape's index.
        if (inNonRenderContainer(el, groupEl)) continue;
        slot.shapeEls.push(el);
      }
      slot.shapeElsStale = false;
    }
    if (idx == null || idx < 0) return null;
    return slot.shapeEls[idx] || null;
  }

  // Map a META ROW to its DOM element. Meta rows outnumber DOM elements
  // whenever a shape emits both a fill and a stroke row, so a row index
  // must route through bundle.shapeDomIndex (the importer's per-row
  // renderable-leaf ordinal) before the positional element walk. Bundles
  // without the map (text bundles / synthesized streaming sections) align
  // 1:1 by construction → identity. Rows mapped to -1 (<use> expansions,
  // pattern/clip/mask layer rows) have no addressable element → null.
  function shapeElByRow(slot, groupEl, bundle, row) {
    const map = bundle && bundle.shapeDomIndex;
    const idx = map ? (map[row] != null ? map[row] : -1) : row;
    const element = shapeElByIndex(slot, groupEl, idx);
    if (element) return element;
    const path = bundle && bundle.shapeDomPaths && bundle.shapeDomPaths[row];
    if (!path) return null;
    let current = groupEl;
    for (const index of path) {
      current = current && Array.from(current.children || [])[index];
      if (!current) break;
    }
    return current;
  }

  // Isolate ONE sprite: hide every rendered top-level child of the clone
  // except the sprite's own element (a sprite is by definition a top-level
  // id'd <g>/shape — see bundle.spriteRanges). Resolves the sprite id via
  // slotEl (works across per-clone id namespacing through data-oid) and
  // hides via applyAttr so the isolation diffs/reverts per frame like any
  // override. Returns false when the id can't be resolved inside the clone
  // (caller falls back to the meta-row range hide).
  const NON_RENDER_TOPLEVEL = new Set([
    'defs',
    'clippath',
    'mask',
    'pattern',
    'symbol',
    'marker',
    'lineargradient',
    'radialgradient',
    'filter',
    'style',
    'title',
    'desc',
    'metadata',
    'script',
  ]);
  function hideAllButSprite(slot, groupEl, spriteId) {
    const target = slotEl(slot, groupEl, spriteId);
    if (!target || !groupEl.contains(target)) return false;
    // The sprite element is normally a direct child of the mount <g>
    // (top-level in the source markup). Isolate along the ancestor chain —
    // hide the siblings at every level up to the mount — so a sprite inside
    // a wrapper group is still cleanly isolated from its wrapper siblings.
    for (let node = target; node !== groupEl; node = node.parentNode) {
      const parent = node.parentNode;
      if (!parent) return false;
      for (let c = parent.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1 || c === node) continue;
        if (NON_RENDER_TOPLEVEL.has(svgElementName(c))) continue;
        applyAttr(slot, c, 'style:display', 'none');
      }
    }
    return true;
  }

  function layerChildEl(slot, groupEl, bundle, idx) {
    if (!slot.layerMap) {
      slot.layerMap = new Map();
      const cr = bundle && (bundle.clipperRowSets || bundle.clipperRows);
      if (cr)
        for (const svgId in cr) {
          const groups = clipperRowGroups(bundle, svgId) || [];
          for (const rows of groups)
            for (let ord = 0; ord < rows.length; ord++) {
              if (!slot.layerMap.has(rows[ord])) slot.layerMap.set(rows[ord], { svgId, ord });
            }
        }
    }
    const e = slot.layerMap.get(idx);
    if (!e) return null;
    const container = slotEl(slot, groupEl, e.svgId); // <clipPath id>/<mask id>
    if (!container) return null;
    let n = 0;
    for (let c = container.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && RECOLOR_TAGS.has(svgElementName(c))) {
        if (n === e.ord) return c;
        n++;
      }
    }
    return null;
  }

  // Direct per-shape geometry stream (updateNativeBundleGeometry). Writes each
  // shape's path `d` (+ optional fill) onto its cached <path> element with a
  // per-shape last-applied guard, skipping the whole slot when the bundle's
  // stream generation hasn't advanced. No override-table allocation/diffing —
  // this is the cost difference vs the generic override loop when N shapes
  // change every frame. The bundle's synthesized svgSource is all <path>s in
  // shape-index order, so shapeElByIndex(i) is shape i's element directly.
  function applyStreamGeometry(slot, groupEl, bundle) {
    slot.rootVp = bundle.viewBox || null;
    const gen = bundle.__streamGen | 0;
    if (slot.streamGen === gen) return; // unchanged since this slot's last draw
    slot.streamGen = gen;
    const ds = bundle.__streamPathD,
      fs = bundle.__streamFills || null;
    slot.streamSource = ds;
    const n = ds.length;
    let dCache = slot.streamD,
      fCache = slot.streamF,
      hCache = slot.streamHidden;
    if (!dCache || dCache.length !== n) dCache = slot.streamD = new Array(n);
    if (fs && (!fCache || fCache.length !== n)) fCache = slot.streamF = new Array(n);
    if (!hCache || hCache.length !== n) hCache = slot.streamHidden = new Array(n);
    for (let i = 0; i < n; i++) {
      const dv = ds[i];
      // undefined ⇒ this shape isn't stream-driven (a morph fills only its
      // matched shapes; the rest keep their source geometry). '' is distinct —
      // it clears a degenerate shape (e.g. one scrolled off-screen).
      if (dv === undefined) continue;
      // Route META ROW → element through shapeDomIndex (identity for
      // synthesized streaming sources, which have no map): a retained-
      // source morph whose shapes emit fill+stroke rows would otherwise
      // land the tweened `d` on the wrong <path>.
      let el = shapeElByRow(slot, groupEl, bundle, i);
      if (!el) continue;
      const instance = useInstanceEl(slot, groupEl, bundle, i, el);
      if (instance === null) {
        if (!slot.warnedUse) {
          slot.warnedUse = true;
          mantleWarn(
            'native scene: a <use> instance inside a pattern, clip, mask or marker cannot be split from its template; its streamed geometry is not drawn',
          );
        }
        continue;
      }
      if (instance) el = instance;
      // A morph's matched shape may be a primitive in the source markup —
      // convert to <path> once so the streamed `d` lands (no-op for a
      // synthesized all-<path> source).
      if (svgElementName(el) !== 'path') el = ensurePathEl(slot, el, null, i);
      const d = placeD(slot, groupEl, el, dv || '');
      // An empty `d` paints nothing but still costs layout/paint walk per
      // frame. display:none drops the node from paint entirely — this is what
      // keeps a stream with many off-screen (degenerate) shapes cheap vs a
      // visible-only rebuild. Toggle is guarded so it only writes
      // on a visible↔hidden transition, and a hidden shape skips d/fill writes.
      const empty = d === '';
      if (hCache[i] !== empty) {
        el.style.display = empty ? 'none' : '';
        hCache[i] = empty;
      }
      if (empty) continue;
      if (dCache[i] !== d) {
        el.setAttribute('d', d);
        dCache[i] = d;
      }
      if (fs) {
        const c = fs[i];
        if (c != null && fCache[i] !== c) {
          el.setAttribute('fill', c);
          fCache[i] = c;
        }
      }
    }
  }

  // Begin a draw on this slot: clear the per-frame touch record.
  function beginSlotFrame(slot) {
    slot.frameTouch.clear();
  }

  // Apply one attribute to an element, diffing against the last applied
  // value. Snapshots the authored original once so it can be reverted later.
  // A `style:<prop>` pseudo-attr addresses a CSS style property (e.g.
  // 'style:display', 'style:mix-blend-mode') instead of an attribute, so the
  // diff/revert machinery covers both. Returns [isStyle, propName].
  function styleProp(attr) {
    return attr.startsWith('style:') ? attr.slice(6) : null;
  }
  function applyAttr(slot, el, attr, value) {
    const sp = styleProp(attr);

    let o = slot.orig.get(el);
    if (!o) {
      o = new Map();
      slot.orig.set(el, o);
    }
    if (!o.has(attr)) {
      o.set(attr, sp ? el.style.getPropertyValue(sp) : el.getAttribute(attr));
      if (sp) o.set('priority:' + sp, el.style.getPropertyPriority?.(sp) || '');
    }
    // Record that this attr is set this frame (so it isn't reverted at end).
    let ft = slot.frameTouch.get(el);
    if (!ft) {
      ft = new Set();
      slot.frameTouch.set(el, ft);
    }
    ft.add(attr);
    // What the override pass writes is remembered, with its value: an unchanged table replays exactly this.
    if (slot.inOverridePass) {
      let written = slot.overrideAttrs.get(el);
      if (!written) {
        written = new Map();
        slot.overrideAttrs.set(el, written);
      }
      written.set(attr, value);
    }
    // Diff against the currently-applied value; skip the DOM write if equal.
    let ap = slot.applied.get(el);
    if (!ap) {
      ap = new Map();
      slot.applied.set(el, ap);
    }
    if (ap.get(attr) === value) return;
    ap.set(attr, value);
    if (sp) el.style.setProperty(sp, value || '', sp === 'opacity' ? 'important' : '');
    else if (value == null) el.removeAttribute(attr);
    else el.setAttribute(attr, value);
  }

  // End a draw on this slot: revert every attribute that was applied on a
  // prior frame but NOT set this frame (a dropped override) to its authored
  // value, and forget it. Attrs still set this frame stay applied.
  function finishSlotFrame(slot) {
    if (!slot.applied.size) return;
    for (const [el, ap] of slot.applied) {
      const ft = slot.frameTouch.get(el);
      let removedAll = true;
      for (const attr of ap.keys()) {
        if (ft && ft.has(attr)) {
          removedAll = false;
          continue;
        }
        const o = slot.orig.get(el);
        const val = o ? o.get(attr) : null;
        const sp = styleProp(attr);
        if (sp) el.style.setProperty(sp, val || '', o?.get('priority:' + sp) || '');
        else if (val == null) el.removeAttribute(attr);
        else el.setAttribute(attr, val);
        // A primitive swapped for a <path> has no authored `d` to go back to: only a fresh clone has its geometry.
        if (attr === 'd' && val == null) slot.lostGeometry = true;
        ap.delete(attr);
      }
      if (removedAll && ap.size === 0) slot.applied.delete(el);
    }
  }

  // Same rules as the WebGL renderer's setViewport: sizes truncate to whole pixels and clamp to
  // [1, 32767]; NaN and non-numbers throw; a missing height is the width.
  function setViewport(w, h) {
    vpW = Math.trunc(clampArg('setViewport', 'width', w, 1, 32767));
    vpH = Math.trunc(clampArg('setViewport', 'height', h == null ? w : h, 1, 32767));
    svg.setAttribute('width', String(vpW));
    svg.setAttribute('height', String(vpH));
    if (coordSpace === 'viewport') {
      // Pixel user-space: the root viewBox IS the viewport, independent of
      // any bundle's bbox. Bundles place via their em→pixel worldMatrix.
      activeViewBox = [0, 0, vpW, vpH];
      svg.setAttribute('viewBox', `0 0 ${vpW} ${vpH}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.__viewBoxSet = true;
    }
    if (_scissor) applyScissor(); // its insets are measured from the viewport's far edges
  }

  // Declare the coordinate space (see coordSpace above). Call before the
  // first draw. 'viewport' is the contract for a multi-bundle pixel
  // compositor: setViewport sets viewBox="0 0 w h" and worldMatrix is
  // em→pixel.
  function setCoordinateSpace(space) {
    coordSpace = space === 'viewport' ? 'viewport' : 'bundle';
    if (coordSpace === 'viewport' && vpW > 0) {
      activeViewBox = [0, 0, vpW, vpH];
      svg.setAttribute('viewBox', `0 0 ${vpW} ${vpH}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.__viewBoxSet = true;
    } else {
      svg.__viewBoxSet = false; // let the next bundle set its em viewBox
      activeViewBox = null;
    }
  }

  function beginFrame(clearColor) {
    if (frameOpen) endFrame();
    frameOpen = true;
    frameEpoch++;
    _readCursor = 0;
    _slotIndex = null;
    _reconciling = false;
    _clearPushed = false;
    clearSlot = null;
    clearViewBox = null;
    if (clearColor && clearColor[3] !== 0) {
      for (let i = 0; i < 3; i++) clearValues[i] = clearColor[i];
      clearValues[3] = clearColor[3] == null ? 1 : clearColor[3];
      _clearColor = clearValues;
    } else _clearColor = null;
    // Reserve the first slot before any raster or vector content. A later
    // first bundle can update its bounds without changing painter order.
    ensureBackground(activeViewBox || [0, 0, vpW, vpH]);
  }

  function ensureViewBox(bundle) {
    const viewport = coordSpace === 'viewport';
    const vb = viewport
      ? [0, 0, vpW, vpH]
      : bundle.viewBox && bundle.viewBox[2] > 0
        ? bundle.viewBox
        : bundle.globalBBox;
    if (!svg.__viewBoxSet) {
      svg.setAttribute('viewBox', `${vb[0]} ${vb[1]} ${vb[2]} ${vb[3]}`);
      svg.setAttribute(
        'preserveAspectRatio',
        viewport ? 'none' : parToAttr(bundle.preserveAspectRatio),
      );
      activeViewBox = [vb[0], vb[1], vb[2], vb[3]];
      svg.__viewBoxSet = true;
    }
    ensureBackground(activeViewBox || vb);
  }

  function ensureBackground(vb) {
    if (!_clearColor || !(vb[2] > 0 && vb[3] > 0) || (_clearPushed && clearViewBox === vb)) return;
    if (!clearSlot)
      clearSlot = acquireSlot('__clear__', 'rect', () => ownerDoc.createElementNS(SVGNS, 'rect'));
    const slot = clearSlot.slot,
      r = clearSlot.node,
      c = _clearColor;
    let sig = slot.clearSig;
    const same =
      sig &&
      sig[0] === vb[0] &&
      sig[1] === vb[1] &&
      sig[2] === vb[2] &&
      sig[3] === vb[3] &&
      sig[4] === c[0] &&
      sig[5] === c[1] &&
      sig[6] === c[2] &&
      sig[7] === c[3];
    if (!same) {
      r.setAttribute('x', String(vb[0]));
      r.setAttribute('y', String(vb[1]));
      r.setAttribute('width', String(vb[2]));
      r.setAttribute('height', String(vb[3]));
      r.setAttribute('fill', rgbaToCss(c));
      if (!sig) sig = slot.clearSig = new Float64Array(8);
      sig[0] = vb[0];
      sig[1] = vb[1];
      sig[2] = vb[2];
      sig[3] = vb[3];
      for (let i = 0; i < 4; i++) sig[4 + i] = c[i];
    }
    _clearPushed = true;
    clearViewBox = vb;
  }

  // worldMatrix is a column-major mat3 (Float32Array(9)) operating in em
  // space: col0=(m00,m10,0) col1=(m01,m11,0) col2=(tx,ty,1). SVG
  // matrix(a,b,c,d,e,f) wants (m00,m10,m01,m11,tx,ty) — same em space.
  function worldMatrixToTransform(wm) {
    if (!wm) return null;
    const a = wm[0],
      b = wm[1],
      c = wm[3],
      d = wm[4],
      e = wm[6],
      f = wm[7];
    // Identity → omit.
    if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) return null;
    const n = compactNumbers && wm instanceof Float32Array ? shortF32 : String;
    return `matrix(${n(a)},${n(b)},${n(c)},${n(d)},${n(e)},${n(f)})`;
  }

  // worldMatrixToTransform memoized on a slot. A stationary wrapper is the
  // common case (a streaming bundle's motion lives in its geometry, an
  // instanced slot holds still between layout changes), and the raw call
  // allocates a fresh matrix(...) string every frame. Cache the 6 components
  // alongside the string and only rebuild when one moves. Callers must still
  // pass the result to applyAttr so the per-frame touch is recorded —
  // finishSlotFrame reverts any attr it does not see this frame.
  function slotWorldTransform(slot, wm) {
    if (!wm) {
      slot.lastWM = null;
      return null;
    }
    const a = wm[0],
      b = wm[1],
      c = wm[3],
      d = wm[4],
      e = wm[6],
      f = wm[7];
    let lw = slot.lastWM;
    if (
      lw &&
      lw[0] === a &&
      lw[1] === b &&
      lw[2] === c &&
      lw[3] === d &&
      lw[4] === e &&
      lw[5] === f
    ) {
      return slot.lastXform;
    }
    if (!lw) lw = slot.lastWM = new Float64Array(6);
    lw[0] = a;
    lw[1] = b;
    lw[2] = c;
    lw[3] = d;
    lw[4] = e;
    lw[5] = f;
    const n = compactNumbers && wm instanceof Float32Array ? shortF32 : String;
    slot.lastXform =
      a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0
        ? null
        : `matrix(${n(a)},${n(b)},${n(c)},${n(d)},${n(e)},${n(f)})`;
    return slot.lastXform;
  }

  // The authored (pre-tint/pre-recolor) value of a paint attr, cached per
  // element so multiplicative tint never reads its own tinted write back
  // (which would compound frame-to-frame). Shares slot.recolorBase with the
  // per-draw recolor pass so both agree on the base color. Returns the CSS
  // string, or null when the attr is absent.
  function tintBaseColor(slot, el, attr) {
    if (!slot.recolorBase) slot.recolorBase = new Map();
    let base = slot.recolorBase.get(el);
    if (!base) {
      base = {};
      slot.recolorBase.set(el, base);
    }
    if (base[attr] != null) return base[attr];
    const snap = slot.orig.get(el);
    const css = snap && snap.has(attr) ? snap.get(attr) : el.getAttribute(attr);
    base[attr] = css;
    return css;
  }

  // Geometry-driven shapes need a <path d="…">. If the cloned source element is
  // a primitive (<rect>/<circle>/<ellipse>/<polygon>/<line>), swap it for a
  // <path> that inherits its presentation attributes so the tweened/streamed
  // `d` can land. Done once; subsequent frames reuse the <path>. Shared by the
  // override path (applyShapeOverride) and the direct-write path
  // (applyStreamGeometry). `shapeId` may be null (positional addressing).
  const PRIM_GEOM_ATTRS = [
    'x',
    'y',
    'width',
    'height',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'points',
    'x1',
    'y1',
    'x2',
    'y2',
    'd',
  ];
  function ensurePathEl(slot, el, shapeId, shapeIdx, tag = 'path') {
    if (svgElementName(el) === tag) return el;
    el.__bitmapPaint?.defs.remove();
    dropGradientPaint(el);
    const p = ownerDoc.createElementNS(SVGNS, tag);
    for (const attr of Array.from(el.attributes)) {
      // Primitive geometry attrs don't apply to <path>; keep id/fill/stroke/transform/clip.
      if (PRIM_GEOM_ATTRS.includes(attr.name.toLowerCase())) continue;
      p.setAttribute(attr.name, attr.value);
    }
    if (cloneOpacity.has(el)) cloneOpacity.set(p, cloneOpacity.get(el));
    el.parentNode.replaceChild(p, el);
    // Keep the id index + cached shape list + snapshot/applied state pointing at
    // the new node (same document position) so later frames find the <path>.
    if (slot.idIndex)
      for (const key of [shapeId, el.getAttribute('id'), el.getAttribute('data-oid')]) {
        if (key != null && slot.idIndex.get(key) === el) slot.idIndex.set(key, p);
      }
    if (slot.shapeEls) {
      const k = slot.shapeEls.indexOf(el);
      if (k >= 0) slot.shapeEls[k] = p;
    }
    if (slot.sharedRows?.has(el)) {
      slot.sharedRows.set(p, slot.sharedRows.get(el));
      slot.sharedRows.delete(el);
    }
    if (slot.useInst) {
      if (slot.useInst.has(el)) {
        slot.useInst.set(p, slot.useInst.get(el));
        slot.useInst.delete(el);
      }
      for (const list of slot.useInst.values()) {
        const k = list ? list.indexOf(el) : -1;
        if (k >= 0) list[k] = p;
      }
    }
    // Earlier rows may already have written this element in the current frame.
    // Keep those touches or frame cleanup would restore their authored values.
    for (const map of [
      slot.orig,
      slot.applied,
      slot.frameTouch,
      slot.overrideAttrs,
      slot.recolorBase,
    ]) {
      const state = map && map.get(el);
      if (state) {
        map.set(p, state);
        map.delete(el);
      }
    }
    return p;
  }

  // Morph and stream geometry is decoded from the bundle's curves, which are stored in BUNDLE coordinates (after every
  // ancestor transform and the shape's own). A retained element sits inside those transforms again, so the `d` that lands on
  // it must be carried back through inverse(ancestors * own authored transform): then the browser composes the same CTM the
  // static pose gets, and everything else on the element (clip-path, userSpaceOnUse paint, filter, stroke width, a local
  // override transform, a group override that moves the ancestors) keeps its authored meaning. The AUTHORED transforms are
  // used (the first-write snapshot), never one an override wrote this frame. Returns null when the chain is the identity (the
  // common case: no work per frame), is singular, or the element is layer geometry (<clipPath>/<mask>/<pattern>... children,
  // which are positioned by their referencing element's user space, not by where they sit in the tree).
  const NO_PLACEMENT = new Set([
    'clippath',
    'mask',
    'defs',
    'pattern',
    'marker',
    'symbol',
    'filter',
    'lineargradient',
    'radialgradient',
  ]);
  const placementCache = new WeakMap();
  function authoredTransform(slot, node) {
    const snap = slot.orig.get(node);
    return snap && snap.has('transform') ? snap.get('transform') : node.getAttribute('transform');
  }
  const viewBoxOf = (n) => {
    const p = (n.getAttribute('viewBox') || '')
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    return p.length === 4 && p.every(Number.isFinite) && p[2] > 0 && p[3] > 0 ? p : null;
  };
  // The size of the viewport that percentages written on `from` resolve against: the nearest enclosing <svg>'s viewBox (or its
  // own box), else the root's.
  function viewportAbove(slot, groupEl, from) {
    for (let n = from; n && n !== groupEl; n = n.parentNode) {
      if (n.nodeType !== 1 || svgElementName(n) !== 'svg') continue;
      const vb = viewBoxOf(n);
      if (vb) return { w: vb[2], h: vb[3] };
      const up = viewportAbove(slot, groupEl, n.parentNode);
      return {
        w: parseLengthOr(n.getAttribute('width'), up.w, {
          parentWidth: up.w,
          parentHeight: up.h,
          axis: 'x',
        }),
        h: parseLengthOr(n.getAttribute('height'), up.h, {
          parentWidth: up.w,
          parentHeight: up.h,
          axis: 'y',
        }),
      };
    }
    const r = slot.rootVp;
    return r ? { w: r[2], h: r[3] } : { w: 0, h: 0 };
  }
  function svgFitMatrix(slot, groupEl, svgEl) {
    const up = viewportAbove(slot, groupEl, svgEl.parentNode),
      ctx = { parentWidth: up.w, parentHeight: up.h };
    const x = parseLengthOr(svgEl.getAttribute('x'), 0, { ...ctx, axis: 'x' }),
      y = parseLengthOr(svgEl.getAttribute('y'), 0, { ...ctx, axis: 'y' });
    const w = parseLengthOr(svgEl.getAttribute('width'), up.w, { ...ctx, axis: 'x' }),
      h = parseLengthOr(svgEl.getAttribute('height'), up.h, { ...ctx, axis: 'y' });
    const vb = viewBoxOf(svgEl);
    return vb && w > 0 && h > 0
      ? viewBoxFit(
          vb[0],
          vb[1],
          vb[2],
          vb[3],
          svgEl.getAttribute('preserveAspectRatio'),
          x,
          y,
          w,
          h,
        )
      : [1, 0, 0, 1, x, y];
  }
  function placementInverse(slot, groupEl, el) {
    const hit = placementCache.get(el);
    if (hit !== undefined) return hit;
    let matrix = [1, 0, 0, 1, 0, 0],
      skip = false,
      any = false;
    for (let node = el; node && node !== groupEl; node = node.parentNode) {
      if (!node.getAttribute) continue;
      if (node !== el && NO_PLACEMENT.has(svgElementName(node).toLowerCase())) {
        skip = true;
        break;
      }
      const t = authoredTransform(slot, node);
      let local = t ? parseTransform(t) : null;
      // A nested <svg> (an authored one, or the viewport a split <use> of a <symbol>/<svg> keeps) places its content by its
      // x/y and the fit of its viewBox into its width/height.
      if (node !== el && svgElementName(node) === 'svg') {
        const fit = svgFitMatrix(slot, groupEl, node);
        local = local ? matMul(local, fit) : fit;
      }
      if (local) {
        matrix = matMul(local, matrix);
        any = true;
      }
    }
    let inverse = null;
    if (!skip && any) {
      const [a, b, c, d, tx, ty] = matrix,
        det = a * d - b * c;
      const identity = a === 1 && b === 0 && c === 0 && d === 1 && tx === 0 && ty === 0;
      if (!identity && det !== 0 && Number.isFinite(det)) {
        // The importer scales a stroke by the CTM's largest singular value (the mean column length when conformal, which is the
        // same number): a width read from the bundle is in that unit, the element's stroke-width is in its own.
        const sum = a * a + b * b + c * c + d * d;
        inverse = {
          m: [
            d / det,
            -b / det,
            -c / det,
            a / det,
            (c * ty - d * tx) / det,
            (b * tx - a * ty) / det,
          ],
          strokeScale: Math.sqrt(0.5 * (sum + Math.sqrt(Math.max(0, sum * sum - 4 * det * det)))),
        };
      }
    }
    placementCache.set(el, inverse);
    return inverse;
  }
  function placeD(slot, groupEl, el, d) {
    if (!d) return d;
    const inverse = placementInverse(slot, groupEl, el);
    return inverse ? transformPathD(d, inverse.m) : d;
  }
  function placeStrokeWidth(slot, groupEl, el, width) {
    const inverse = placementInverse(slot, groupEl, el);
    if (!inverse || !(inverse.strokeScale > 0)) return width;
    const fixed = (
      el.getAttribute('vector-effect') ||
      getStyleProp(el, 'vector-effect', '') ||
      ''
    ).includes('non-scaling-stroke');
    return fixed ? width : width / inverse.strokeScale;
  }

  // <use> instances. Rows an expanded <use> produced address ONE element: the template's (or the referenced shape's own), so
  // a per-row geometry write would land on every instance at once, each composing its own <use> transform on top of the last
  // writer's bundle-space `d`. Before a geometry override lands, the shared element is split: each <use> that instantiates it
  // is replaced by a <g> carrying the use's presentation attributes and placement (transform + x/y) around a private copy of the
  // referenced element, and row k is routed to the copy of the k-th instance in document order (the order the importer expands
  // them in), nested uses and <symbol>/<svg> targets included. A use that does not line up with the rows (one inside a <pattern>,
  // <clipPath>, <mask> or <marker>) is left alone: the geometry is then NOT written (the shape holds its authored pose) rather than
  // drawn displaced.
  const SKIP_WALK = new Set([
    'defs',
    'clippath',
    'mask',
    'pattern',
    'marker',
    'symbol',
    'filter',
    'lineargradient',
    'radialgradient',
    'style',
  ]);
  function useInstanceEl(slot, groupEl, bundle, row, el) {
    if (slot.hasUse === undefined) slot.hasUse = !!groupEl.querySelector('use');
    if (!slot.hasUse) return undefined;
    if (!slot.sharedRows) {
      slot.sharedRows = new Map();
      const n = bundle.numShapes | 0;
      for (let r = 0; r < n; r++) {
        const e = shapeElByRow(slot, groupEl, bundle, r);
        if (!e) continue;
        const list = slot.sharedRows.get(e);
        if (list) list.push(r);
        else slot.sharedRows.set(e, [r]);
      }
    }
    const rows = slot.sharedRows.get(el);
    const k = rows ? rows.indexOf(row) : -1;
    const inTemplate = isUseTemplate(el, groupEl);
    if (!rows || k < 0 || (rows.length < 2 && !inTemplate)) return undefined;
    slot.useInst = slot.useInst || new Map();
    if (slot.useInst.get(el) === undefined) {
      // Every element the uses share is split in ONE pass: the split replaces the uses, so a second pass for the next shared
      // element would find none left.
      const tracked = new Map();
      for (const [e, list] of slot.sharedRows)
        if (list.length > 1 || isUseTemplate(e, groupEl)) tracked.set(e, list.length);
      const split = splitUseInstances(groupEl, tracked);
      for (const [e, list] of split) slot.useInst.set(e, list);
      slot.shapeElsStale = true;
    }
    const instances = slot.useInst.get(el);
    return instances && k < instances.length ? instances[k] : null;
  }
  // The instances of every tracked element (element -> row count), one private copy each, in the order the importer expands them
  // (depth-first through every <use>, nested ones included). `relevant` is the set of nodes that hold a tracked element or a <use>
  // that leads to one, so the walk touches only what matters. A <use> becomes a <g> carrying its presentation attributes and
  // placement (transform + x/y) around a copy of its target. A <symbol> target is instantiated as the nested <svg> the spec says
  // it is (SVG 2 5.9.3), and an <svg> target keeps its own element with the use's width/height on it, so the BROWSER applies the
  // viewBox fit and the viewport clip exactly as it does for the unsplit <use>; placementInverse reads the same viewport fit back
  // to carry a `d` into the copy's coordinates. The importer numbers the rows a <use> inside a <pattern>, <clipPath>, <mask> or
  // <marker> produces AFTER every visible row, and those uses are not walked: an element with fewer copies than rows keeps the
  // copies for its first rows and holds the rest (useInstanceEl returns null for them), and one with more copies than rows
  // maps to null. A held row is not drawn displaced.
  function splitUseInstances(groupEl, tracked) {
    const ids = new Map();
    for (const e of groupEl.querySelectorAll('[id]')) ids.set(e.getAttribute('id'), e);
    const hrefTarget = (u) => {
      const h = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
      return h[0] === '#' ? ids.get(h.slice(1)) : null;
    };
    const relevant = new Set();
    const addChain = (n) => {
      for (; n && n !== groupEl && !relevant.has(n); n = n.parentNode) relevant.add(n);
    };
    for (const e of tracked.keys()) addChain(e);
    const uses = Array.from(groupEl.querySelectorAll('use'));
    for (let changed = true; changed;) {
      changed = false;
      for (const u of uses) {
        if (relevant.has(u)) continue;
        const t = hrefTarget(u);
        if (t && relevant.has(t)) {
          addChain(u);
          changed = true;
        }
      }
    }
    const strip = (n) => {
      if (n.removeAttribute) n.removeAttribute('id');
      for (const c of n.children || []) strip(c);
    };
    const instantiate = (t, use) => {
      const name = svgElementName(t);
      let root;
      if (name === 'symbol') {
        root = ownerDoc.createElementNS(SVGNS, 'svg');
        for (const a of Array.from(t.attributes))
          if (!/^(id|x|y|width|height|transform)$/.test(a.name)) root.setAttribute(a.name, a.value);
        for (const kid of Array.from(t.childNodes)) root.appendChild(kid.cloneNode(true));
      } else root = t.cloneNode(true);
      if (name === 'symbol' || name === 'svg') {
        for (const a of ['width', 'height'])
          if (use.getAttribute(a) != null) root.setAttribute(a, use.getAttribute(a));
      }
      strip(root);
      return root;
    };
    const leaves = new Map();
    for (const e of tracked.keys()) leaves.set(e, []);
    const emit = (orig, live, active) => {
      const oc = Array.from(orig.children),
        lc = Array.from(live.children);
      for (let i = 0; i < oc.length; i++) {
        const c = oc[i],
          l = lc[i],
          name = svgElementName(c);
        if (SKIP_WALK.has(name) || !relevant.has(c)) continue;
        if (leaves.has(c)) {
          leaves.get(c).push(l);
          continue;
        }
        if (name === 'use') {
          const t = hrefTarget(c);
          if (!t || active.has(t)) continue;
          const wrap = ownerDoc.createElementNS(SVGNS, 'g');
          _splitWraps.add(wrap);
          for (const a of Array.from(l.attributes)) {
            if (/^(href|xlink:href|x|y|width|height|id|transform)$/.test(a.name)) continue;
            wrap.setAttribute(a.name, a.value);
          }
          const ux = +l.getAttribute('x') || 0,
            uy = +l.getAttribute('y') || 0;
          const place = [
            l.getAttribute('transform') || '',
            ux || uy ? `translate(${ux} ${uy})` : '',
          ]
            .filter(Boolean)
            .join(' ');
          if (place) wrap.setAttribute('transform', place);
          const copy = instantiate(t, l);
          wrap.appendChild(copy);
          l.parentNode.replaceChild(wrap, l);
          if (leaves.has(t)) leaves.get(t).push(copy);
          else {
            active.add(t);
            emit(t, copy, active);
            active.delete(t);
          }
          continue;
        }
        emit(c, l, active);
      }
    };
    emit(groupEl, groupEl, new Set());
    const out = new Map();
    for (const [e, list] of leaves) out.set(e, list.length <= tracked.get(e) ? list : null);
    return out;
  }
  function isUseTemplate(el, groupEl) {
    for (let n = el.parentNode; n && n !== groupEl; n = n.parentNode) {
      const name = n.nodeType === 1 ? svgElementName(n) : '';
      if (name === 'defs' || name === 'symbol') return true;
    }
    return false;
  }

  // Apply one shape's override object to its DOM element. Addressed by the
  // authored id when present; synthetic shape_N_* ids don't exist in the
  // markup, so those fall through to POSITIONAL addressing: shape index
  // N → the N-th renderable element in document order, which matches how
  // the importer numbers shapes. Without this, morphs/overrides on id-less
  // artwork (the common case) silently no-op because every id lookup misses.
  function recordRow(el, row) {
    const rows = new Set((el.getAttribute('data-mantle-rows') || '').split(' ').filter(Boolean));
    rows.add(String(row));
    el.setAttribute('data-mantle-rows', Array.from(rows).join(' '));
  }
  // A local override transform composes with the authored one: it is prepended, so it
  // acts in the parent's space on the element as authored (the authored transform is
  // snapshotted by applyAttr on first write, so a re-applied frame never compounds).
  function composeLocalTransform(slot, el, local) {
    const snap = slot.orig.get(el);
    const authored =
      snap && snap.has('transform') ? snap.get('transform') : el.getAttribute('transform');
    return authored ? `${local} ${authored}` : local;
  }
  // Effective group overrides are in bundle space. Remove the live ancestor placement before applying them to a DOM leaf.
  function groupOverrideInParent(slot, groupEl, el, m) {
    let authored = [1, 0, 0, 1, 0, 0],
      live = authored;
    for (let node = el.parentNode; node && node !== groupEl; node = node.parentNode) {
      if (!node.getAttribute) continue;
      let a = parseTransform(authoredTransform(slot, node) || '');
      let b = parseTransform(node.getAttribute('transform') || '');
      if (svgElementName(node) === 'svg') {
        const fit = svgFitMatrix(slot, groupEl, node);
        a = matMul(a, fit);
        b = matMul(b, fit);
      }
      authored = matMul(a, authored);
      live = matMul(b, live);
    }
    const [a, b, c, d, x, y] = live,
      det = a * d - b * c;
    if (det === 0 || !Number.isFinite(det)) return [1, 0, 0, 1, 0, 0];
    const inverse = [
      d / det,
      -b / det,
      -c / det,
      a / det,
      (c * y - d * x) / det,
      (b * x - a * y) / det,
    ];
    return matMul(matMul(inverse, [m[0], m[2], m[1], m[3], m[4], m[5]]), authored);
  }
  function applyShapeOverride(slot, groupEl, shapeId, shapeIdx, o, bundle) {
    slot.rootVp = bundle.viewBox || null;
    let el =
      shapeId != null && shapeId !== '' && !isSyntheticId(shapeId)
        ? slotEl(slot, groupEl, shapeId)
        : null;
    if (!el) el = shapeElByRow(slot, groupEl, bundle, shapeIdx);
    // Clip/mask layer shape (no rendered leaf): route to the <mask>/
    // <clipPath> child so an animated mask/clip GEOMETRY morph lands.
    if (!el) {
      const path = bundle.shapeDomPaths && bundle.shapeDomPaths[shapeIdx];
      if (path) {
        let candidate = groupEl;
        for (const index of path) {
          candidate = candidate && Array.from(candidate.children || [])[index];
          if (!candidate) break;
        }
        el = candidate;
      }
    }
    if (!el) el = layerChildEl(slot, groupEl, bundle, shapeIdx);
    if (!el) return null;
    if (o.pathD != null || o.bitmapPaint || o.gradientPaint) {
      const instance = useInstanceEl(slot, groupEl, bundle, shapeIdx, el);
      if (instance === null) {
        if (!slot.warnedUse) {
          slot.warnedUse = true;
          mantleWarn(
            'native scene: a <use> instance inside a pattern, clip, mask or marker cannot be split from its template; its geometry override is not drawn',
          );
        }
        return el;
      }
      if (instance) el = instance;
    }

    if (opts.recordRows) recordRow(el, shapeIdx);
    // A fill row and a stroke row of one shape address the same element. A paint a
    // previous row already wrote this frame must not be re-based on the authored value.
    const priorTouch = slot.frameTouch.get(el);
    const priorPaint = {
      fill: !!(priorTouch && priorTouch.has('fill')),
      stroke: !!(priorTouch && priorTouch.has('stroke')),
    };
    if (typeof o.groupOpacity === 'number') {
      applyAttr(slot, el, 'opacity', String(Math.max(0, Math.min(1, o.groupOpacity))));
      return el;
    }
    // Morph-driven geometry needs a <path d="…">; convert a primitive once.
    if (o.pathD != null)
      el = ensurePathEl(slot, el, shapeId, shapeIdx, o.bitmapPaint?.direct ? 'image' : 'path');
    if (o.bitmapPaint) applyBitmapPaint(slot, el, groupEl, o.bitmapPaint);
    if (o.gradientPaint) applyGradientPaint(slot, el, groupEl, o.gradientPaint);

    // Transform (localPosition/Scale/Rotation) → element transform.
    const hasXform =
      (o.localPosition && (o.localPosition[0] || o.localPosition[1])) ||
      o.localRotation ||
      (o.localScale && (o.localScale[0] !== 1 || o.localScale[1] !== 1));
    if (o.matrix) {
      // A row under a group override: the exact composed affine (it can shear, which position / rotation / scale cannot say).
      const m = groupOverrideInParent(slot, groupEl, el, o.matrix);
      applyAttr(slot, el, 'transform', composeLocalTransform(slot, el, `matrix(${m.join(' ')})`));
    } else if (hasXform) {
      const tx = o.localPosition ? o.localPosition[0] : 0;
      const ty = o.localPosition ? o.localPosition[1] : 0;
      const deg = ((o.localRotation || 0) * 180) / Math.PI;
      const sx = o.localScale ? o.localScale[0] : 1;
      const sy = o.localScale ? o.localScale[1] : 1;
      applyAttr(
        slot,
        el,
        'transform',
        composeLocalTransform(slot, el, `translate(${tx} ${ty}) rotate(${deg}) scale(${sx} ${sy})`),
      );
    }

    const opacitySnapshot = slot.orig.get(el);
    const opacityStyle = opacitySnapshot?.has('style:opacity')
      ? opacitySnapshot.get('style:opacity')
      : el.style.getPropertyValue('opacity');
    const opacityAttribute = opacitySnapshot?.has('opacity')
      ? opacitySnapshot.get('opacity')
      : el.getAttribute('opacity');
    const opacityText = cloneOpacity.get(el) ?? (opacityStyle || opacityAttribute || '1');
    const parsedOpacity = parseFloat(opacityText);
    const authoredOpacity = Number.isFinite(o.bitmapPaint?.opacity)
      ? Math.max(0, Math.min(1, o.bitmapPaint.opacity))
      : Number.isFinite(parsedOpacity)
        ? Math.max(0, Math.min(1, parsedOpacity * (String(opacityText).includes('%') ? 0.01 : 1)))
        : 1;
    const visibility =
      typeof o.visibility === 'number' ? Math.max(0, Math.min(1, o.visibility)) : 1;
    const opacityAttr = 'style:opacity';
    // A morph's composited group with no element of its own (a leaf's opacity over its fill and stroke, morphGroups.js) drives the
    // element's opacity from here; every row of the leaf carries the same value.
    const elementOpacity =
      typeof o.elementOpacity === 'number' ? Math.max(0, Math.min(1, o.elementOpacity)) : null;
    let opacityBase = elementOpacity != null ? elementOpacity : authoredOpacity;
    if (o.bitmapPaint?.opacity != null)
      applyAttr(slot, el, opacityAttr, String(authoredOpacity * visibility));
    // Visibility → opacity (0 ⇒ also display:none so it's fully gone).
    if (typeof o.visibility === 'number' && o.visibility < 1) {
      applyAttr(slot, el, opacityAttr, String(authoredOpacity * visibility));
      if (o.visibility <= 0) applyAttr(slot, el, 'style:display', 'none');
    }

    // Absolute fill / stroke / strokeWidth. An rgba override REPLACES the
    // shape's resolved paint, and that paint's alpha already folded in the
    // authored fill-opacity / stroke-opacity / opacity (the importer bakes
    // them into the meta color, which is exactly what the GL path
    // overrides). So the attributes they came from have to be neutralized
    // here, or they multiply in a second time — a morph fade written as rgba
    // would top out at the authored alpha instead of reaching it.
    const filterOpacity =
      typeof o.filterOpacity === 'number' ? Math.max(0, Math.min(1, o.filterOpacity)) : null;
    const inputPaint = (c) => (filterOpacity > 0 ? [c[0], c[1], c[2], c[3] / filterOpacity] : c);
    if (o.fill) {
      applyAttr(slot, el, 'fill', rgbaToCss(inputPaint(o.fill)));
      applyAttr(slot, el, 'fill-opacity', '1');
    }
    if (o.stroke) {
      applyAttr(slot, el, 'stroke', rgbaToCss(inputPaint(o.stroke)));
      applyAttr(slot, el, 'stroke-opacity', '1');
    }
    // Element `opacity` covers both paints, so it can only be neutralized
    // when every paint this element actually uses was overridden; otherwise
    // the un-overridden one would lose its dimming.
    if (o.fill || o.stroke) {
      // An ABSENT fill attribute still paints (SVG defaults to black); an
      // absent stroke does not.
      const fillCovered = !!o.fill || tintBaseColor(slot, el, 'fill') === 'none';
      const strokeBase = tintBaseColor(slot, el, 'stroke');
      const strokeCovered = !!o.stroke || strokeBase == null || strokeBase === 'none';
      if (fillCovered && strokeCovered) {
        opacityBase = elementOpacity != null ? elementOpacity : 1;
        applyAttr(slot, el, opacityAttr, String(opacityBase * visibility));
      }
    }
    if (elementOpacity != null)
      applyAttr(slot, el, opacityAttr, String(elementOpacity * visibility));
    if (filterOpacity != null) {
      opacityBase = filterOpacity;
      applyAttr(slot, el, opacityAttr, String(filterOpacity * visibility));
    }
    if (typeof o.strokeWidth === 'number')
      applyAttr(
        slot,
        el,
        'stroke-width',
        String(placeStrokeWidth(slot, groupEl, el, o.strokeWidth)),
      );

    // Tint (multiplicative RGBA) — matching the GL shader's `vFill *= tint` /
    // `vStroke *= tint`: multiply the shape's resolved fill AND stroke COLOR
    // by the full tint (all four channels into the paint). The base color is
    // the post-fill-override fill (o.fill if set this frame, else the authored
    // fill snapshot), so the result is stable + diffable and never compounds
    // its own output. Solid-fill shapes are exact; gradient/image/url() fills
    // have no single color → skipped (alpha-only fallback below so a
    // translucent tint still dims them).
    // An identity tint (the override table's default for a row that sets none) is a no-op:
    // applying it would re-write the authored paint over another row's fill or stroke.
    if (o.tint && !(o.tint[0] === 1 && o.tint[1] === 1 && o.tint[2] === 1 && o.tint[3] === 1)) {
      const t = o.tint;
      const rgbTint = t[0] !== 1 || t[1] !== 1 || t[2] !== 1;
      const postFilterTint = filterOpacity != null || /url\(/i.test(getStyleProp(el, 'filter', ''));
      const paintTint = postFilterTint ? [t[0], t[1], t[2], 1] : t;
      let appliedToPaint = false;
      for (const attr of ['fill', 'stroke']) {
        const overrode = o[attr] != null;
        const base = overrode
          ? rgbaToCss(inputPaint(o[attr]))
          : priorPaint[attr]
            ? (slot.applied.get(el)?.get(attr) ?? null)
            : tintBaseColor(slot, el, attr);
        if (base == null || base === 'none' || /url\(/i.test(base)) continue; // gradient/image/none
        const rgba = parseColor(base);
        if (!rgba) continue;
        applyAttr(slot, el, attr, rgbaToCss(applyRecolor(rgba, { tint: paintTint })));
        appliedToPaint = true;
      }
      // If the tint couldn't reach any solid paint (e.g. all fills are
      // gradients) fall back to group opacity for the alpha component, so a
      // translucent tint still dims the shape as before.
      if ((postFilterTint || (!appliedToPaint && rgbTint === false)) && t[3] != null && t[3] < 1) {
        applyAttr(slot, el, opacityAttr, String(opacityBase * visibility * t[3]));
      }
    }

    // Morph-driven geometry: rewrite the path data (el is a <path> by
    // now — converted above if the source was a primitive).
    if (o.pathD != null) applyAttr(slot, el, 'd', placeD(slot, groupEl, el, o.pathD));
    return el;
  }

  // An override table that has not changed needs no scan and none of the get() wrappers it allocates: the pass's own writes
  // (slot.overrideAttrs, recorded by applyAttr: a sprite's hide earlier in the draw is not one of them) are written again.
  // The diff makes that a no-op in the steady state, and restores them after a draw that dropped them (a hidden draw, a draw
  // without the table) and after a recolor that has gone. While a recolor is drawn the value stays as it is: recolorOne recomposes on the override's own value.
  function replayOverrideAttrs(slot, recoloring) {
    for (const [el, attrs] of slot.overrideAttrs) {
      for (const [attr, value] of attrs) {
        if (recoloring && slot.applied.get(el)?.has(attr)) touchAttr(slot, el, attr);
        else applyAttr(slot, el, attr, value);
      }
    }
  }
  function touchAttr(slot, el, attr) {
    let frame = slot.frameTouch.get(el);
    if (!frame) {
      frame = new Set();
      slot.frameTouch.set(el, frame);
    }
    frame.add(attr);
  }

  // Apply animated clip transforms (setClipper) to the live <clipPath>/
  // <mask> elements in this group's cloned subtree.
  function applyClippers(slot, groupEl, table) {
    if (!table || !table.clippers) return;
    for (const [clipId, c] of table.clippers) {
      const el = slotEl(slot, groupEl, clipId);
      if (!el) continue;
      const tx = c.localPosition ? c.localPosition[0] : 0;
      const ty = c.localPosition ? c.localPosition[1] : 0;
      const deg = ((c.localRotation || 0) * 180) / Math.PI;
      const sx = c.localScale ? c.localScale[0] : 1;
      const sy = c.localScale ? c.localScale[1] : 1;
      // A <clipPath> takes a transform of its own; a <mask> does not, so its content moves instead.
      const local = `translate(${tx} ${ty}) rotate(${deg}) scale(${sx} ${sy})`;
      for (const target of svgElementName(el) === 'mask' ? Array.from(el.children || []) : [el])
        applyAttr(slot, target, 'transform', composeLocalTransform(slot, target, local));
    }
  }

  // Inject + update the table's "extra shapes" — geometry that has no element
  // in the cloned source markup (the native morph's dst-only shapes). Each
  // gets a persistent <path> appended to the bundle <g>; static attrs (d,
  // fill, stroke) are set once, the fade-in opacity updates per frame. The
  // node list is cached on the slot and trimmed when the table has fewer
  // extras (or none — e.g. the morph was dropped), reusing the slot diff
  // model so a removed extra cleanly unmounts.
  const bitmapCrops = new WeakMap();
  function bitmapUrls(bundle, id) {
    let cache = bitmapCrops.get(bundle);
    if (!cache) {
      cache = new Map();
      bitmapCrops.set(bundle, cache);
    }
    if (cache.has(id)) return cache.get(id);
    const secondary = bundle.imageAtlasSources?.[id - 1] === 1,
      [atlasY, w, h] = bundle.imageAtlasRects[id - 1];
    const data = new Uint8Array((secondary ? bundle.secondaryImageAtlas : bundle.imageAtlas) || 0),
      aw = (secondary ? bundle.secondaryImageAtlasDim : bundle.imageAtlasDim)[0];
    const crop = (x, y, cw, ch) => {
      const canvas = ownerDoc.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d'),
        image = ctx.createImageData(cw, ch);
      for (let row = 0; row < ch; row++)
        image.data.set(
          data.subarray(((atlasY + y + row) * aw + x) * 4, ((atlasY + y + row) * aw + x + cw) * 4),
          row * cw * 4,
        );
      ctx.putImageData(image, 0, 0);
      return canvas.toDataURL('image/png');
    };
    const urls = [
      crop(0, 0, 1, 1),
      crop(0, 0, w, 1),
      crop(w - 1, 0, 1, 1),
      crop(0, 0, 1, h),
      crop(0, 0, w, h),
      crop(w - 1, 0, 1, h),
      crop(0, h - 1, 1, 1),
      crop(0, h - 1, w, 1),
      crop(w - 1, h - 1, 1, 1),
    ];
    cache.set(id, urls);
    return urls;
  }
  // A tweened gradient (nativeGradientPaint.js): one gradient element per element and role, built once into a <defs> of the
  // group and rewritten per frame; the element's fill/stroke points at it. The authored gradient stays in the clone, so
  // an override that clears restores it through the slot diff.
  function dropGradientPaint(el) {
    const state = el.__gradPaint;
    if (!state) return;
    for (const role of ['fill', 'stroke']) state[role]?.defs.remove();
    el.__gradPaint = null;
  }
  function applyGradientPaint(slot, el, groupEl, paint) {
    for (const role of ['fill', 'stroke']) {
      const spec = paint[role];
      if (!spec) continue;
      const state = el.__gradPaint || (el.__gradPaint = {});
      const tag = spec.type === 'radial' ? 'radialGradient' : 'linearGradient';
      let g = state[role];
      if (g && g.tag !== tag) {
        g.defs.remove();
        g = state[role] = null;
      }
      if (!g) {
        const defs = ownerDoc.createElementNS(SVGNS, 'defs'),
          grad = ownerDoc.createElementNS(SVGNS, tag),
          id = nativeResourceId(ownerDoc, 'morphGradient');
        grad.setAttribute('id', id);
        defs.appendChild(grad);
        groupEl.appendChild(defs);
        g = state[role] = { defs, grad, id, tag, stops: [] };
      }
      const grad = g.grad,
        set = (k, v) => {
          const text = typeof v === 'number' ? shortNumber(v) : String(v);
          if (grad.getAttribute(k) !== text) grad.setAttribute(k, text);
        };
      const unset = (k) => {
        if (grad.hasAttribute(k)) grad.removeAttribute(k);
      };
      if (spec.units === 'userSpaceOnUse') set('gradientUnits', 'userSpaceOnUse');
      else unset('gradientUnits');
      if (spec.spread !== 'pad') set('spreadMethod', spec.spread);
      else unset('spreadMethod');
      if (spec.transform)
        set('gradientTransform', `matrix(${spec.transform.map(shortNumber).join(' ')})`);
      else unset('gradientTransform');
      if (spec.type === 'linear') {
        set('x1', spec.x1);
        set('y1', spec.y1);
        set('x2', spec.x2);
        set('y2', spec.y2);
      } else {
        set('cx', spec.cx);
        set('cy', spec.cy);
        set('r', spec.r);
        if (spec.fx === spec.cx && spec.fy === spec.cy) {
          unset('fx');
          unset('fy');
        } else {
          set('fx', spec.fx);
          set('fy', spec.fy);
        }
      }
      while (g.stops.length > spec.stops.length) g.stops.pop().remove();
      while (g.stops.length < spec.stops.length) {
        const stop = ownerDoc.createElementNS(SVGNS, 'stop');
        grad.appendChild(stop);
        g.stops.push(stop);
      }
      spec.stops.forEach((s, i) => {
        const stop = g.stops[i],
          color = `rgb(${shortNumber(s[1])},${shortNumber(s[2])},${shortNumber(s[3])})`,
          offset = shortNumber(s[0]);
        if (stop.getAttribute('offset') !== offset) stop.setAttribute('offset', offset);
        if (stop.getAttribute('stop-color') !== color) stop.setAttribute('stop-color', color);
        const alpha = shortNumber(unit(s[4]));
        if (stop.getAttribute('stop-opacity') !== alpha) stop.setAttribute('stop-opacity', alpha);
      });
      applyAttr(slot, el, role, `url(#${g.id})`);
    }
  }
  function applyBitmapPaint(slot, el, groupEl, paint) {
    if (paint.direct) {
      for (const [key, value] of Object.entries({
        x: paint.rect[0],
        y: paint.rect[1],
        width: paint.rect[2],
        height: paint.rect[3],
      }))
        applyAttr(slot, el, key, String(value));
    } else {
      let state = el.__bitmapPaint;
      if (!state) {
        const defs = ownerDoc.createElementNS(SVGNS, 'defs'),
          pattern = ownerDoc.createElementNS(SVGNS, 'pattern'),
          id = nativeResourceId(ownerDoc, 'morphBitmap');
        pattern.setAttribute('id', id);
        pattern.setAttribute('patternUnits', 'userSpaceOnUse');
        pattern.setAttribute('patternContentUnits', 'userSpaceOnUse');
        defs.appendChild(pattern);
        groupEl.appendChild(defs);
        state = el.__bitmapPaint = { defs, pattern, id, images: [], key: null };
      }
      const { rect, bounds, frame, repeat } = paint,
        [x, y, w, h] = rect;
      if (!(w > 0 && h > 0)) return;
      const key = JSON.stringify([rect, bounds, frame, repeat, paint.tile, paint.id]);
      if (state.key !== key) {
        state.key = key;
        const pattern = state.pattern;
        let xs, ys;
        if (repeat) {
          xs = [0, 0, paint.tile[0], paint.tile[0]];
          ys = [0, 0, paint.tile[1], paint.tile[1]];
        } else {
          const pad = Math.max(w, h, bounds[2] - bounds[0], bounds[3] - bounds[1], 1);
          xs = [Math.min(x, bounds[0]) - pad, x, x + w, Math.max(x + w, bounds[2]) + pad];
          ys = [Math.min(y, bounds[1]) - pad, y, y + h, Math.max(y + h, bounds[3]) + pad];
        }
        pattern.setAttribute('x', String(xs[0]));
        pattern.setAttribute('y', String(ys[0]));
        pattern.setAttribute('width', String(xs[3] - xs[0]));
        pattern.setAttribute('height', String(ys[3] - ys[0]));
        if (frame) pattern.setAttribute('patternTransform', `matrix(${frame.join(' ')})`);
        else pattern.removeAttribute('patternTransform');
        const urls = bitmapUrls(paint.bundle, paint.id),
          want = repeat ? 1 : 9;
        while (state.images.length > want) state.images.pop().remove();
        while (state.images.length < want) {
          const image = ownerDoc.createElementNS(SVGNS, 'image');
          image.setAttribute('preserveAspectRatio', 'none');
          pattern.appendChild(image);
          state.images.push(image);
        }
        state.images.forEach((image, i) => {
          const ix = repeat ? 1 : i % 3,
            iy = repeat ? 1 : Math.floor(i / 3),
            ix0 = repeat ? x : xs[ix],
            iy0 = repeat ? y : ys[iy],
            iw = repeat ? w : xs[ix + 1] - xs[ix],
            ih = repeat ? h : ys[iy + 1] - ys[iy];
          for (const [k, v] of Object.entries({
            x: ix0 - xs[0],
            y: iy0 - ys[0],
            width: iw,
            height: ih,
            href: urls[repeat ? 4 : i],
          }))
            image.setAttribute(k, String(v));
        });
      }
      applyAttr(slot, el, paint.role, `url(#${state.id})`);
    }
    // Curves and paint frames are in bundle coordinates; cancel retained ancestors.
    let matrix = [1, 0, 0, 1, 0, 0];
    for (let parent = el.parentNode; parent && parent !== groupEl; parent = parent.parentNode)
      if (parent.getAttribute)
        matrix = matMul(parseTransform(parent.getAttribute('transform') || ''), matrix);
    const [a, b, c, d, tx, ty] = matrix,
      det = a * d - b * c;
    if (det !== 0) {
      const inverse = [
        d / det,
        -b / det,
        -c / det,
        a / det,
        (c * ty - d * tx) / det,
        (b * tx - a * ty) / det,
      ];
      const placed = paint.directFrame ? matMul(inverse, paint.directFrame) : inverse;
      applyAttr(slot, el, 'transform', `matrix(${placed.join(' ')})`);
    }
  }

  function retainedFilteredExtra(e, groupEl) {
    const source = new DOMParser().parseFromString(e.filterSource, 'image/svg+xml').documentElement;
    setActiveStylesheet(source, buildStylesheet(source));
    const copy = ownerDoc.importNode(source, true);
    let selected = copy,
      original = source;
    if (e.filterDomPath)
      for (const ordinal of e.filterDomPath) {
        selected = selected?.children?.[ordinal];
        original = original?.children?.[ordinal];
      }
    else selected = null;
    if (!selected && e.filterShapeId)
      selected = Array.from(copy.querySelectorAll('[id]')).find(
        (el) => el.getAttribute('id') === e.filterShapeId,
      );
    if (!selected || selected === copy) return null;
    // Inline decoded feImage resources before the endpoint's GL textures vanish.
    const filterValue = getStyleProp(original, 'filter', selected.getAttribute('filter') || '');
    selected.style.setProperty('filter', filterValue, 'important');
    const filterRef = filterValue.match(/url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/);
    const filter =
      filterRef &&
      Array.from(copy.querySelectorAll('[id]')).find(
        (el) => el.getAttribute('id') === filterRef[1],
      );
    const imageNodes = (e.filterGraph?.nodes || []).filter((n) => n.type === 'feImage');
    const images = filter ? Array.from(filter.querySelectorAll('feImage')) : [];
    const urls = e.filterBundle ? atlasDataUrls(e.filterBundle, ownerDoc) : null;
    for (let i = 0; i < images.length; i++) {
      const url = urls?.[(imageNodes[i]?.params.imageId || 0) - 1];
      if (url) {
        images[i].setAttribute('href', url);
        images[i].removeAttribute('xlink:href');
      }
    }
    if (!idNs.allowActiveContent) stripActiveContent(copy);
    const filterScope = namespaceCloneIds(copy, idNs);
    const node = ownerDoc.createElementNS(SVGNS, 'g'),
      defs = ownerDoc.createElementNS(SVGNS, 'defs');
    if (filterScope) {
      node.setAttribute('data-mantle-scope', filterScope);
      defs.setAttribute('data-mantle-scope', filterScope);
    }
    let branch = selected.cloneNode(true);
    if (opts.recordRows && Number.isInteger(e.mergedRow)) recordRow(branch, e.mergedRow);
    branch.removeAttribute('id');
    branch.removeAttribute('data-oid');
    // The source scene already carries the ancestor effects. Retain their
    // placement and inherited paint while isolating this target-only leaf.
    for (let parent = selected.parentNode; parent && parent !== copy; parent = parent.parentNode) {
      const shell = parent.cloneNode(false);
      shell.removeAttribute('id');
      shell.removeAttribute('data-oid');
      for (const effect of ['opacity', 'filter', 'mask', 'clip-path', 'mix-blend-mode']) {
        shell.removeAttribute(effect);
        shell.style?.setProperty(effect, effect === 'opacity' ? '1' : 'none', 'important');
      }
      shell.appendChild(branch);
      branch = shell;
    }
    while (copy.firstChild) defs.appendChild(copy.firstChild);
    node.appendChild(branch);
    groupEl.appendChild(defs);
    node.__extraDefs = defs;
    return node;
  }

  function applyExtraShapes(slot, groupEl, table, bundle) {
    const extras = table.extraShapes;
    if (slot.extraTable !== table) {
      for (const node of slot.extraEls || []) {
        node.__extraDefs?.remove();
        node.remove();
      }
      slot.extraEls = [];
      slot.extraTable = table;
      slot.extraPlacement = new Map();
      for (const e of extras || []) {
        const parent =
          e.parentRow >= 0 ? shapeElByRow(slot, groupEl, bundle, e.parentRow) : groupEl;
        const before = e.beforeRow >= 0 ? shapeElByRow(slot, groupEl, bundle, e.beforeRow) : null;
        slot.extraPlacement.set(e, { parent: parent || groupEl, before });
      }
    }
    if (!slot.extraEls) slot.extraEls = [];
    const want = extras ? extras.length : 0;
    // Trim surplus nodes (fewer extras than last frame).
    for (let i = slot.extraEls.length - 1; i >= want; i--) {
      const node = slot.extraEls[i];
      if (node && node.parentNode) {
        node.__extraDefs?.remove();
        node.parentNode.removeChild(node);
      }
      slot.extraEls.pop();
    }
    if (!extras) return;
    // Skip the whole pass when nothing changed since last draw on this slot.
    const gen = table.extrasGeneration | 0;
    const sameGen = slot.extrasGen === gen;
    for (let i = 0; i < want; i++) {
      const e = extras[i];
      let node = slot.extraEls[i];
      if (!node || node.__extraKey !== e.key || node.__extraDescriptor !== e) {
        // (Re)build this slot: fresh <path> with the static geometry/paint.
        if (node && node.parentNode) {
          node.__extraDefs?.remove();
          node.parentNode.removeChild(node);
        }
        const retained = e.filterSource ? retainedFilteredExtra(e, groupEl) : null;
        node = retained || ownerDoc.createElementNS(SVGNS, 'path');
        node.__extraKey = e.key;
        node.__extraDescriptor = e;
        if (!retained) {
          if (opts.recordRows && Number.isInteger(e.mergedRow)) recordRow(node, e.mergedRow);
          node.setAttribute('d', e.pathD);
          if (e.fill) node.setAttribute('fill', rgbaToCss(e.fill));
          if (e.stroke && (e.strokeWidth || 0) > 0) {
            node.setAttribute('stroke', rgbaToCss(e.stroke));
            node.setAttribute('stroke-width', String(e.strokeWidth));
          }
          if (e.evenOdd) node.setAttribute('fill-rule', 'evenodd');
          if (e.strokeWidth > 0) {
            node.setAttribute('stroke-linecap', ['butt', 'round', 'square'][e.cap] || 'butt');
            node.setAttribute(
              'stroke-linejoin',
              ['miter', 'round', 'bevel', 'miter-clip', 'arcs'][e.join] || 'miter',
            );
            node.setAttribute('stroke-miterlimit', String(e.miter || 4));
            if (e.dash) {
              node.setAttribute('stroke-dasharray', e.dash.values.join(' '));
              node.setAttribute('stroke-dashoffset', String(e.dash.offset));
            }
            if (e.nonScaling) node.setAttribute('vector-effect', 'non-scaling-stroke');
          }
          for (const role of ['fill', 'stroke']) {
            const paint = role === 'fill' ? e.fillImage : e.strokeImage;
            if (!paint) continue;
            const href = atlasDataUrls(paint.bundle, ownerDoc)?.[paint.id - 1];
            const [x, y, w, h] = paint.rect;
            if (!href || !(w > 0 && h > 0)) continue;
            let defs = node.__extraDefs;
            if (!defs) {
              defs = ownerDoc.createElementNS(SVGNS, 'defs');
              groupEl.appendChild(defs);
              node.__extraDefs = defs;
            }
            const id = nativeResourceId(ownerDoc, 'morphPaint'),
              pattern = ownerDoc.createElementNS(SVGNS, 'pattern');
            const mirror = (paint.flags & 3) === 3;
            for (const [key, value] of Object.entries({
              id,
              x,
              y,
              width: w * (mirror ? 2 : 1),
              height: h * (mirror ? 2 : 1),
              patternUnits: 'userSpaceOnUse',
              patternContentUnits: 'userSpaceOnUse',
            }))
              pattern.setAttribute(key, String(value));
            for (const [flipX, flipY] of mirror
              ? [
                  [false, false],
                  [true, false],
                  [false, true],
                  [true, true],
                ]
              : [[false, false]]) {
              const image = ownerDoc.createElementNS(SVGNS, 'image');
              for (const [key, value] of Object.entries({
                x: 0,
                y: 0,
                width: w,
                height: h,
                preserveAspectRatio: 'none',
                href,
              }))
                image.setAttribute(key, String(value));
              if (flipX || flipY)
                image.setAttribute(
                  'transform',
                  `matrix(${flipX ? -1 : 1} 0 0 ${flipY ? -1 : 1} ${flipX ? 2 * w : 0} ${flipY ? 2 * h : 0})`,
                );
              if (paint.flags & 4) image.setAttribute('style', 'image-rendering:pixelated');
              pattern.appendChild(image);
            }
            defs.appendChild(pattern);
            node.setAttribute(role, `url(#${id})`);
            const color = role === 'fill' ? e.fill : e.stroke;
            if (color) node.setAttribute(role + '-opacity', String(color[3]));
          }
        }
        node.__extraAlpha = -1; // force the opacity write below
        const placement = slot.extraPlacement.get(e) || { parent: groupEl, before: null };
        const parent = placement.parent;
        if (parent !== groupEl) {
          let matrix = [1, 0, 0, 1, 0, 0];
          for (
            let ancestor = parent;
            ancestor && ancestor !== groupEl;
            ancestor = ancestor.parentNode
          )
            if (ancestor.getAttribute)
              matrix = matMul(parseTransform(ancestor.getAttribute('transform') || ''), matrix);
          const [a, b, c, d, x, y] = matrix,
            det = a * d - b * c;
          if (det !== 0)
            node.setAttribute(
              'transform',
              `matrix(${d / det} ${-b / det} ${-c / det} ${a / det} ${(c * y - d * x) / det} ${(b * x - a * y) / det})`,
            );
        }
        parent.insertBefore(
          node,
          placement.before?.parentNode === parent ? placement.before : null,
        );
        slot.extraEls[i] = node;
      } else if (sameGen) {
        continue; // unchanged → no per-frame write
      }
      // Fade-in opacity (the only per-frame value). display:none at fully
      // transparent so a 0-alpha extra doesn't capture hit-testing.
      const a = Math.max(0, Math.min(1, e.alpha));
      if (node.__extraAlpha !== a) {
        node.__extraAlpha = a;
        if (a <= 0) {
          node.style.display = 'none';
        } else {
          node.style.display = '';
          node.setAttribute('opacity', String(a));
        }
      }
    }
    slot.extrasGen = gen;
  }

  // opts.dstRect on the native scene. The WebGL renderer fits the bundle's inked CONTENT bbox (globalBBox) into the rect
  // (dstRect.js: parseDstFit / fittedRectPx, here through dstRectAffine, so the two backends share one fit rule), and the
  // result is an em -> viewport-pixel affine T. This scene's root <svg> maps the user space (the first bundle's viewBox, fitted by
  // its preserveAspectRatio; the pixel viewport itself under coordinateSpace 'viewport') to pixels with V, so the group's
  // worldMatrix is inverse(V) * T. A worldMatrix given with the rect keeps this scene's own meaning (em space) and acts first:
  // rect * yours. The rect's clip (opts.clipToRect, default on) is a <clipPath> in pixel space re-aimed at the group's final
  // matrix each frame, so it stays at the rect while the content moves under it. Returns null (and warns once per cause) when the
  // rect cannot be honored; the draw then proceeds as if no rect were given, as on WebGL.
  function warnDstRectOnce(kind, text) {
    if (_warnedDstRect.has(kind)) return;
    _warnedDstRect.add(kind);
    mantleWarn('[Mantle] native scene: drawBundle ' + text + ' (Warned once.)');
  }
  function dstRectPlacement(bundle, drawOpts) {
    const bb = bundle.globalBBox;
    let r = dstRectAffine(bb, drawOpts.dstRect, drawOpts.fit);
    if (r.error === 'fit') {
      warnDstRectOnce(
        'fit',
        `fit ${JSON.stringify(drawOpts.fit)} is not a preserveAspectRatio value ('none', or 'xMidYMid meet' / 'xMinYMax slice' / ...); using 'xMidYMid meet'.`,
      );
      r = dstRectAffine(bb, drawOpts.dstRect, undefined);
    }
    if (r.error === 'rect') {
      warnDstRectOnce(
        'rect',
        'dstRect must be [x, y, w, h] with w > 0 and h > 0 (viewport pixels, y-down); ignoring it.',
      );
      return null;
    }
    if (r.error === 'bbox') {
      warnDstRectOnce(
        'bbox',
        'dstRect needs the bundle to have an inked bounding box; this one has none, so the rect is ignored.',
      );
      return null;
    }
    if (!(vpW > 0 && vpH > 0)) {
      warnDstRectOnce(
        'viewport',
        'dstRect is in viewport pixels and needs scene.setViewport(w, h) first; ignoring it.',
      );
      return null;
    }
    let V = IDENT;
    if (coordSpace !== 'viewport') {
      const vb = activeViewBox;
      if (vb && vb[2] > 0 && vb[3] > 0)
        V = viewBoxFit(
          vb[0],
          vb[1],
          vb[2],
          vb[3],
          svg.getAttribute('preserveAspectRatio'),
          0,
          0,
          vpW,
          vpH,
        );
    }
    const toUser = mulAffine(invAffine(V), r.m);
    const user =
      drawOpts.worldMatrix && drawOpts.worldMatrix.length >= 9
        ? mulAffine(toUser, wmAffine(drawOpts.worldMatrix))
        : toUser;
    const [a, b, c, d, e, f] = user;
    const out = { worldMatrix: Float64Array.of(a, b, 0, c, d, 0, e, f, 1), clip: null };
    if (drawOpts.clipToRect !== false) {
      const to = invAffine(mulAffine(V, user));
      if (to) out.clip = { box: r.clip, back: to };
    }
    return out;
  }
  // The <clipPath> of one slot's dstRect clip: a pixel-space rect carried back into the group's space.
  function applyDstClip(slot, g, clip) {
    let c = slot.dstClip;
    if (!c) {
      const el = ownerDoc.createElementNS(SVGNS, 'clipPath'),
        rect = ownerDoc.createElementNS(SVGNS, 'rect');
      const id = nativeResourceId(ownerDoc, 'mantleDstClip');
      el.setAttribute('id', id);
      el.setAttribute('clipPathUnits', 'userSpaceOnUse');
      el.appendChild(rect);
      ensureDefs().appendChild(el);
      c = slot.dstClip = { clip: el, rect, id, sig: '' };
    }
    if (c.clip.parentNode == null) ensureDefs().appendChild(c.clip);
    const [x0, y0, x1, y1] = clip.box,
      back = affineToMatrix(clip.back),
      sig = `${x0},${y0},${x1},${y1},${back}`;
    if (c.sig !== sig) {
      c.sig = sig;
      c.rect.setAttribute('x', String(x0));
      c.rect.setAttribute('y', String(y0));
      c.rect.setAttribute('width', String(Math.max(0, x1 - x0)));
      c.rect.setAttribute('height', String(Math.max(0, y1 - y0)));
      if (back) c.rect.setAttribute('transform', back);
      else c.rect.removeAttribute('transform');
    }
    applyAttr(slot, g, 'clip-path', `url(#${c.id})`);
    return c;
  }

  function drawBundle(bundle, drawOpts = {}) {
    if (!frameOpen) throw new Error('drawBundle called outside beginFrame/endFrame');
    if (!bundle) return false; // the WebGL renderer ignores a null target the same way
    const rec = ensureBundleRecord(bundle, useNativeText);
    ensureViewBox(bundle);
    // opts.dstRect: the placement the WebGL renderer computes, as an equivalent worldMatrix (see dstRectPlacement).
    let dstClip = null;
    if (drawOpts.dstRect != null) {
      const placed = dstRectPlacement(bundle, drawOpts);
      if (placed) {
        drawOpts = { ...drawOpts, worldMatrix: placed.worldMatrix };
        dstClip = placed.clip;
      }
    }

    // Attribute diffs cannot restore streamed geometry from a different source.
    // Irreversible geometry changes require a fresh clone.
    const rebuild = _rebuildNextBundle;
    _rebuildNextBundle = false;
    const {
      slot,
      node: g,
      reused,
    } = acquireSlot(
      rec,
      'bundle',
      () => {
        const ng = ownerDoc.createElementNS(SVGNS, 'g');
        ng.appendChild(
          cloneSourceInner(
            rec,
            ownerDoc,
            bundle,
            {
              baseUrl: drawOpts.baseUrl || opts.baseUrl,
              inlineFromAtlas:
                drawOpts.inlineFromAtlas !== undefined
                  ? drawOpts.inlineFromAtlas
                  : opts.inlineFromAtlas,
            },
            ng,
            idNs,
          ),
        );
        return ng;
      },
      bundle.__streamPathD,
      rebuild,
    );
    // Begin this slot's frame: clear the per-frame touch record. Overrides
    // applied below are diffed against last frame; anything applied last
    // frame but not this one is reverted in finishSlotFrame() at the end.
    beginSlotFrame(slot);

    // The <g>'s own transform/alpha change per frame. Route them through
    // the same diffing applyAttr so an unchanged value is a no-op and a
    // dropped one is reverted in finishSlotFrame (the <g> has no authored
    // transform/opacity, so the snapshot is null → revert removes it). Only
    // APPLY when present; absence is handled by finishSlotFrame not seeing
    // the attr in frameTouch.
    // A worldMatrix with a NaN or infinite entry places nothing (the GL draw is empty): hide.
    if (badMatrix(drawOpts.worldMatrix)) {
      slot.lastWM = null;
      applyAttr(slot, g, 'style:display', 'none');
      finishSlotFrame(slot);
      return true;
    }
    const xform = slotWorldTransform(slot, drawOpts.worldMatrix);
    if (xform) applyAttr(slot, g, 'transform', xform);
    if (typeof drawOpts.alpha === 'number' && drawOpts.alpha < 1)
      applyAttr(slot, g, 'opacity', String(drawOpts.alpha));
    // Native viewport culling retains the positional slot and hides only its
    // wrapper. Removing an offscreen subtree would make a scrolling re-entry
    // pay a full clone/import cost and defeat browser retained-paint caches.
    if (drawOpts.hidden) {
      applyAttr(slot, g, 'style:display', 'none');
      finishSlotFrame(slot);
      return true;
    }
    // Per-draw blend mode (multiply/screen/…) → CSS mix-blend-mode on the
    // <g>, as in drawImage. GL bundles can composite with a blend mode.
    const gBlend = BLEND_CSS[drawOpts.blendMode | 0];
    if (gBlend) applyAttr(slot, g, 'style:mix-blend-mode', gBlend);

    // External stationary clip (setNodeClip): apply the viewport-space
    // clip/mask and re-aim its transform at this frame's worldMatrix so the
    // clip stays put while the bundle animates. applyAttr → reverts cleanly
    // if the clip is later cleared.
    // drawOpts.nodeClip is the same clip for ONE draw ({ clipBundle, worldMatrix, mode }); the frame
    // export replays a recorded setNodeClip that way, one clip def per recorded draw.
    const extClip = drawOpts.nodeClip ? drawClipDesc(drawOpts.nodeClip) : _extClips.get(rec);
    const dstClipDef = dstClip ? applyDstClip(slot, g, dstClip) : null;
    if (dstClipDef && !(extClip && extClip.mode !== 'out'))
      dstClipDef.clip.removeAttribute('clip-path');
    if (extClip) {
      ensureExtClipDef(extClip);
      // A node clip that clips (mode 'in') and the rect's clip both want the group's clip-path: the rect's clipPath carries the
      // node clip as its own clip-path, which intersects them.
      if (dstClipDef && extClip.mode !== 'out')
        dstClipDef.clip.setAttribute('clip-path', `url(#${extClip.defId})`);
      else
        applyAttr(slot, g, extClip.mode === 'out' ? 'mask' : 'clip-path', `url(#${extClip.defId})`);
      extClip.xformEl.setAttribute(
        'transform',
        extClipFrameTransform(extClip, drawOpts.worldMatrix),
      );
    }

    // Sprite subset: drawSprite names a top-level id'd element; hide every
    // OTHER rendered top-level child of the clone so only that sprite
    // renders. Addressed by the sprite's own element (via slotEl/data-oid) —
    // NOT by replaying the meta-row range positionally: sprite ranges live
    // in meta-row space where a fill+stroke shape occupies TWO rows, so row
    // index ≠ N-th DOM element and a positional hide lands on the wrong
    // shapes (or, on big sheets, on none — painting the whole sheet).
    // Tracked so the hiding reverts when the sprite changes next frame.
    if (drawOpts.spriteKey != null && hideAllButSprite(slot, g, drawOpts.spriteKey)) {
      // isolated by id — nothing more to hide
    } else if (drawOpts.shapeRange) {
      // Explicit [first,last] meta-row range (no sprite id to resolve).
      // Keep every ELEMENT that owns a row inside the range (a fill+stroke
      // element owns two rows — either one keeps it), hide the rest. Rows
      // route through bundle.shapeDomIndex; identity when the bundle has no
      // map (synthesized sections, 1 row = 1 element by construction).
      const count = (bundle.shapeIds || []).length;
      const [lo, hi] = drawOpts.shapeRange;
      const map = bundle.shapeDomIndex || null;
      const keep = new Set();
      for (let r = Math.max(0, lo | 0); r <= (hi | 0) && r < count; r++) {
        const j = map ? map[r] : r;
        if (j >= 0) keep.add(j);
      }
      shapeElByIndex(slot, g, -1); // build slot.shapeEls
      const els = slot.shapeEls || [];
      for (let j = 0; j < els.length; j++) {
        if (keep.has(j)) continue;
        applyAttr(slot, els[j], 'style:display', 'none');
      }
    }

    // Streaming fast path: a buildStreamableSections bundle updated via
    // updateNativeBundleGeometry carries per-shape path `d` (+ fills) on the
    // bundle. Write them STRAIGHT to the cached <path> elements — no override
    // table, no get()/snapshot diffing, no per-shape allocation. This is the
    // per-frame streaming hot path; the generic override loop below is too
    // heavy when N shapes change every frame (it loses to a full SVG rebuild).
    if (bundle.__streamPathD) applyStreamGeometry(slot, g, bundle);

    // Apply overrides (transform/visibility/recolor/morph-d by id) and
    // animated clip transforms. The table may be the GL override table
    // (read via get()) or the native CPU table — both expose get() and
    // a shapeIds-indexed surface.
    //
    // Fall back to a morph table the bundle carries when the caller passes
    // none: createNativeMorph stashes its per-frame interpolated-geometry
    // table on the bundle so drawBundle(morph.bundle) draws the tween even
    // if the consumer's draw path forgot to forward morph.overrides. An
    // explicitly-passed table still wins.
    const table = drawOpts.overrides || bundle.__nativeMorphOverrides || null;
    if (table) {
      const generation = typeof table.generation === 'number' ? table.generation : null;
      const unchanged =
        generation !== null &&
        slot.overrideTable === table &&
        slot.overrideGeneration === generation &&
        !bundle.__streamPathD;
      if (unchanged) {
        replayOverrideAttrs(slot, hasRecolor(drawOpts));
      } else {
        slot.overrideAttrs.clear();
        slot.inOverridePass = true;
        const ids = bundle.shapeIds || [];
        // Only walk ids that are actually overridden when the table tells us
        // (activeIndices may report duplicates → dedupe with `seen`); else walk
        // all rows by index — no array/Set allocation per frame (the
        // cheap querySelector miss for un-overridden shapes is fine).
        const active = table.activeIndices ? table.activeIndices() : null;
        if (active) {
          const seen = new Set();
          for (const idx of active) {
            const id = ids[idx];
            if (seen.has(idx)) continue;
            seen.add(idx);
            const o = table.getEffective
              ? table.getEffective(idx)
              : table.get
                ? table.get(idx)
                : null;
            if (o) applyShapeOverride(slot, g, id || '', idx, o, bundle);
          }
        } else {
          const count = Math.max(ids.length, table.numShapes || 0, bundle.numShapes || 0);
          for (let idx = 0; idx < count; idx++) {
            const id = ids[idx];
            const o = table.getEffective
              ? table.getEffective(idx)
              : table.get
                ? table.get(idx)
                : null;
            if (o) applyShapeOverride(slot, g, id || '', idx, o, bundle);
          }
        }
        applyClippers(slot, g, table);
        slot.inOverridePass = false;
        slot.overrideTable = table;
        slot.overrideGeneration = generation === null ? -1 : generation;
      }
      // Injected shapes that have no element in the source markup — the
      // native morph's dst-only shapes (present only in the destination
      // pose), faded in across t. Mounted as fresh <path>s after the cloned
      // subtree and updated per frame.
      if (!unchanged || slot.extrasGen !== (table.extrasGeneration | 0))
        applyExtraShapes(slot, g, table, bundle);
    } else if (slot.extraEls && slot.extraEls.length) {
      // The table that injected them is gone from this draw, and they with it.
      applyExtraShapes(slot, g, { extraShapes: null }, bundle);
      slot.extrasGen = -1;
    }

    // Per-draw recolor (tint / channelLerp / palette / colorMatrix): apply
    // the GL fill shader's color algebra to each shape's resolved fill +
    // stroke COLOR (not via a filter — the shader's channel-encoded recolor
    // maps a flat color to a tint, so the per-shape result equals the GL
    // per-pixel result for solid-fill art). Runs AFTER overrides so it sees
    // the post-override fill, matching the shader pipeline order. Gradient /
    // image / url() fills have no single color → skipped (left as-is).
    if (hasRecolor(drawOpts)) applyRecolorPass(slot, g, bundle, drawOpts);

    // Revert any override/sprite-hide applied last frame but not this one
    // (e.g. a shape that stopped being hidden, or a dropped recolor).
    finishSlotFrame(slot);
    if (slot.lostGeometry) {
      startReconcile();
      dropSlot(_nextSlots.pop());
      _rebuildNextBundle = true;
      return drawBundle(bundle, drawOpts);
    }
    return true;
  }

  function applyRecolorPass(slot, groupEl, bundle, drawOpts) {
    if (!slot.recolorBase) slot.recolorBase = new Map(); // el → {fill, stroke} css
    // Reuse the same cached renderable-shape list the positional override
    // addressing uses (shapeElByIndex builds it). shapeElByIndex(slot,_,−1)
    // triggers the build without returning an element.
    shapeElByIndex(slot, groupEl, -1);
    const params = {
      tint: drawOpts.tint,
      channelLerp: drawOpts.channelLerp,
      colorMatrix: drawOpts.colorMatrix,
      colorMatrixOffset: drawOpts.colorMatrixOffset,
      palette: paletteParam(drawOpts.palette, drawOpts.paletteChannel),
    };
    for (const el of slot.shapeEls || []) {
      recolorOne(slot, el, 'fill', params);
      recolorOne(slot, el, 'stroke', params);
    }
    // Injected dst-only morph shapes (slot.extraEls) aren't in the cloned
    // subtree's shape list, but the recolor is a per-draw effect that applies
    // to ALL drawn geometry — so recolor them too (from their authored dst
    // paint). applyExtraShapes only writes opacity per frame, so it won't
    // fight these fill/stroke writes; finishSlotFrame reverts them if the
    // recolor is dropped.
    for (const el of slot.extraEls || []) {
      if (!el) continue;
      recolorOne(slot, el, 'fill', params);
      recolorOne(slot, el, 'stroke', params);
    }
  }

  // Translate the per-draw palette (a native palette token from
  // scene.createPalette, entries [r,g,b,a] in [0,255]) + paletteChannel
  // ('r'|'g'|'b'|'a' or 0..3) into the { entries:[0,1], channel:int } shape
  // applyRecolor expects. Returns null when no palette is set.
  function paletteParam(pal, channel) {
    if (!pal || !pal.entries || !pal.entries.length) return null;
    const ch =
      typeof channel === 'string'
        ? { r: 0, g: 1, b: 2, a: 3 }[channel.toLowerCase()] || 0
        : channel | 0;
    // Normalize entries to [0,1] once and cache on the token.
    if (!pal.__entries01) {
      pal.__entries01 = pal.entries.map((e) => [
        (e[0] || 0) / 255,
        (e[1] || 0) / 255,
        (e[2] || 0) / 255,
        e[3] != null ? e[3] / 255 : 1,
      ]);
    }
    return { entries: pal.__entries01, channel: ch };
  }

  function recolorOne(slot, el, attr, params) {
    const ft = slot.frameTouch.get(el);
    const overrodeThisFrame = ft && ft.has(attr);
    let css;
    if (overrodeThisFrame) {
      // An override (absolute fill/stroke or override-tint) already wrote
      // this attr this frame → recolor composes on top of that value (the
      // shader applies per-draw recolor AFTER per-shape override + tint).
      // Do NOT cache this into recolorBase — it's not the authored base. The value is the
      // override's own, not last frame's recolored result: an unchanged table leaves that applied.
      const written = slot.overrideAttrs.get(el);
      css = written && written.has(attr) ? written.get(attr) : slot.applied.get(el).get(attr);
    } else {
      css = tintBaseColor(slot, el, attr);
    }
    if (css == null || css === 'none' || /url\(/i.test(css)) return; // gradient/image/none
    const rgba = parseColor(css);
    if (!rgba) return;
    applyAttr(slot, el, attr, rgbaToCss(applyRecolor(rgba, params)));
  }

  // Resolve a sprite id (or explicit [first,last]) against the bundle's
  // spriteRanges.
  function resolveSpriteRange(bundle, sprite) {
    if (Array.isArray(sprite) && sprite.length === 2) {
      const range = checkedSpriteBounds(
        sprite,
        bundle &&
          (bundle.numShapes != null ? bundle.numShapes : bundle.shapeIds && bundle.shapeIds.length),
      );
      if (!range)
        mantleWarn(
          '[Mantle] native drawSprite: shape range [' +
            sprite.join(', ') +
            '] is not 0 <= first <= last < shape count',
        );
      return range;
    }
    if (typeof sprite !== 'string') return null;
    const r = ownSpriteRange(bundle, sprite);
    if (!r) {
      mantleWarn('[Mantle] native drawSprite: unknown sprite id "' + sprite + '"');
      return null;
    }
    return r;
  }

  // Draw ONE sprite from a sheet — a real subset draw: the sprite's shapes
  // render, the rest are hidden.
  function drawSprite(target, sprite, drawOpts = {}) {
    const bundle = target && target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return false;
    const range = resolveSpriteRange(bundle, sprite);
    if (!range) return false;
    return drawBundle(bundle, {
      ...drawOpts,
      shapeRange: range,
      spriteKey: typeof sprite === 'string' ? sprite : null,
    });
  }

  function instanceTemplateEligible(rec, bundle, instances, shared) {
    if (
      instances.length < 2 ||
      _extClips.has(rec) ||
      bundle.__streamPathD ||
      bundle.__streamGen !== undefined
    )
      return false;
    const root = rec.sourceRoot;
    // Effects and subtree indirection are deliberately left on the clone path:
    // their references inside <use> differ across older Android SVG engines.
    if (
      root &&
      root.querySelector &&
      root.querySelector(
        shareInstanceDefs
          ? 'text,animate,animateTransform,set'
          : 'mask,clipPath,filter,pattern,marker,use,text,style,animate,animateTransform,set',
      )
    )
      return false;
    // Keep templates to direct, definition-free vector content. A browser
    // smoke cannot establish that <use>-shadow-tree id resolution remains
    // correct on the older Android engines native fallback supports; cloned
    // subtrees preserve those references exactly.
    if (
      !shareInstanceDefs &&
      root &&
      root.querySelector &&
      root.querySelector('defs,linearGradient,radialGradient,image')
    )
      return false;
    const fixed = shared || {};
    if (
      fixed.overrides ||
      fixed.spriteKey != null ||
      fixed.shapeRange ||
      hasRecolor(fixed) ||
      fixed.blendMode ||
      fixed.baseUrl !== undefined ||
      fixed.inlineFromAtlas !== undefined
    )
      return false;
    for (const instance of instances) {
      if (
        instance.overrides ||
        instance.spriteKey != null ||
        instance.shapeRange ||
        hasRecolor(instance) ||
        instance.blendMode ||
        instance.baseUrl !== undefined ||
        instance.inlineFromAtlas !== undefined
      )
        return false;
    }
    return true;
  }

  function ensureInstanceTemplate(rec, bundle) {
    const cached = _instanceTemplates.get(rec);
    if (cached) {
      if (cached.failed) return null;
      if (cached.group.parentNode !== ensureDefs()) ensureDefs().appendChild(cached.group);
      cached.lastUsedFrame = frameEpoch;
      activeTemplates.add(cached);
      return cached;
    }
    let group = null;
    try {
      const id = nativeResourceId(ownerDoc, 'mantleNativeInstance');
      group = ownerDoc.createElementNS(SVGNS, 'g');
      group.setAttribute('id', id);
      group.appendChild(
        cloneSourceInner(
          rec,
          ownerDoc,
          bundle,
          {
            baseUrl: opts.baseUrl,
            inlineFromAtlas: opts.inlineFromAtlas,
          },
          group,
          idNs,
        ),
      );
      ensureDefs().appendChild(group);
      const template = { id, group, lastUsedFrame: frameEpoch };
      activeTemplates.add(template);
      _instanceTemplates.set(rec, template);
      return template;
    } catch {
      if (group && group.parentNode) group.parentNode.removeChild(group);
      _instanceTemplates.set(rec, { failed: true });
      return null;
    }
  }

  function drawTemplateInstance(template, drawOpts) {
    const { slot, node: group } = acquireSlot(`inst:${template.id}`, 'instance', () => {
      const node = ownerDoc.createElementNS(SVGNS, 'g');
      const use = ownerDoc.createElementNS(SVGNS, 'use');
      use.setAttribute('href', `#${template.id}`);
      use.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', `#${template.id}`);
      node.appendChild(use);
      return node;
    });
    beginSlotFrame(slot);
    if (badMatrix(drawOpts.worldMatrix)) {
      slot.lastWM = null;
      applyAttr(slot, group, 'style:display', 'none');
      finishSlotFrame(slot);
      return;
    }
    const xform = slotWorldTransform(slot, drawOpts.worldMatrix);
    if (xform) applyAttr(slot, group, 'transform', xform);
    if (typeof drawOpts.alpha === 'number' && drawOpts.alpha < 1)
      applyAttr(slot, group, 'opacity', String(drawOpts.alpha));
    if (drawOpts.hidden) applyAttr(slot, group, 'style:display', 'none');
    const blend = BLEND_CSS[drawOpts.blendMode | 0];
    if (blend) applyAttr(slot, group, 'style:mix-blend-mode', blend);
    finishSlotFrame(slot);
  }

  // Instance a bundle at N transforms: one <g> per instance.
  function drawBundleInstanced(target, instances, shared = {}) {
    const bundle = target && target.bundle !== undefined ? target.bundle : target;
    if (!bundle || !Array.isArray(instances)) return 0;
    // As on WebGL: a shared rect has no good meaning for N instances (one clip or N?), so it is refused; give each its own worldMatrix.
    if (shared && shared.dstRect != null) {
      warnDstRectOnce(
        'instanced',
        'drawBundleInstanced: dstRect is not supported here; give each instance a worldMatrix. Ignoring it.',
      );
      shared = { ...shared, dstRect: undefined };
    }
    const rec = ensureBundleRecord(bundle, useNativeText);
    if (instanceTemplateEligible(rec, bundle, instances, shared)) {
      if (!frameOpen) throw new Error('drawBundleInstanced called outside beginFrame/endFrame');
      const template = ensureInstanceTemplate(rec, bundle);
      if (template) {
        ensureViewBox(bundle);
        for (const inst of instances) drawTemplateInstance(template, { ...shared, ...inst });
        return instances.length;
      }
    }
    let n = 0;
    // Merge the whole per-instance object over `shared` so every per-instance
    // drawOpt passes through — not just worldMatrix/alpha but per-instance
    // tint / colorMatrix / channelLerp / palette / overrides / blendMode too.
    for (const inst of instances) {
      drawBundle(bundle, { ...shared, ...inst });
      n++;
    }
    return n;
  }

  // Instance ONE sprite at N transforms.
  function drawSpriteInstanced(target, sprite, instances, shared = {}) {
    const bundle = target && target.bundle !== undefined ? target.bundle : target;
    if (!bundle || !Array.isArray(instances)) return 0;
    const range = resolveSpriteRange(bundle, sprite);
    if (!range) return 0;
    let n = 0;
    // Full per-instance passthrough (see drawBundleInstanced). shapeRange /
    // spriteKey are forced last so an instance can't override the sprite subset.
    const spriteKey = typeof sprite === 'string' ? sprite : null;
    for (const inst of instances) {
      drawBundle(bundle, { ...shared, ...inst, shapeRange: range, spriteKey });
      n++;
    }
    return n;
  }

  // Raster blit at N transforms.
  function drawImageInstanced(source, instances, shared = {}) {
    if (!Array.isArray(instances)) return 0;
    // Materialize raw sources once for the whole batch. drawImage(rawSource)
    // intentionally stays live, but an instanced batch should not re-encode the
    // same pixels through canvas.toDataURL() for every instance. A plain token: a createImage
    // token would encode a blob: URL per call that nothing disposes.
    const batchSource = source && source.__nativeImage ? source : plainToken(source);
    let n = 0;
    // Full per-instance passthrough so per-instance tint / srcRect / blendMode
    // / opacity all apply (the GL path tints each blit independently).
    for (const inst of instances) {
      drawImage(batchSource, { ...shared, ...inst });
      n++;
    }
    return n;
  }

  // drawInstance — drawBundle without an implicit frame clear. In the
  // native model every drawBundle is already additive within a frame, so
  // this is just drawBundle.
  function drawInstance(bundle, drawOpts) {
    return drawBundle(bundle, drawOpts || {});
  }

  // Turn a raster source into a data: URL the browser can draw. Accepts
  // the same source forms as the WebGL renderer's createImage:
  //   - a data:/blob:/remote URL string (used as-is)
  //   - { width, height, rgba|data } raw pixels  (→ canvas → toDataURL)
  //   - an HTMLImageElement / HTMLCanvasElement / ImageBitmap / ImageData
  function sourceToHref(source) {
    if (source && source.__nativeImage) {
      if (source.href) return source.href;
      // Drawn before its blob: URL is ready, or with none: a data: URL, kept for the token's
      // life (its <image>s never change href, so none is decoded twice).
      const href = sourceToHref(_tokenPixels.get(source) || source.source);
      source.href = href;
      _tokenPixels.delete(source);
      return href;
    }
    if (typeof source === 'string') return source; // url / data uri
    if (source && source.nodeType && !isCanvas(source)) return source.src || null; // <img>
    const cv = rasterCanvas(source);
    return cv ? cv.toDataURL('image/png') : null;
  }

  const isCanvas = (source) =>
    !!(source && source.nodeType && source.tagName && source.tagName.toLowerCase() === 'canvas');

  // The canvas holding a pixel source's pixels: a canvas itself, else a new one with the raw
  // pixels, ImageData or ImageBitmap's. null for a URL string or an <img>.
  function rasterCanvas(source) {
    if (isCanvas(source)) return source;
    if (!source || typeof source === 'string') return null;
    const raw = (source.rgba || source.data) && source.width && source.height && !source.nodeType;
    const bitmap = typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap;
    if (!raw && !bitmap) return null;
    const cv = ownerDoc.createElement('canvas');
    cv.width = source.width | 0;
    cv.height = source.height | 0;
    const c2 = cv.getContext('2d');
    if (raw) {
      const id = c2.createImageData(cv.width, cv.height);
      id.data.set(source.rgba || source.data);
      c2.putImageData(id, 0, 0);
    } else c2.drawImage(source, 0, 0);
    return cv;
  }

  // Map a WebGL blendMode enum to the SVG/CSS mix-blend-mode keyword that
  // matches. 0 = normal (source-over). Unknown → normal.
  const BLEND_CSS = {
    0: null,
    1: 'multiply',
    2: 'screen',
    3: 'overlay',
    4: 'darken',
    5: 'lighten',
    6: 'color-dodge',
    7: 'color-burn',
    8: 'hard-light',
    9: 'soft-light',
    10: 'difference',
    11: 'exclusion',
    12: 'hue',
    13: 'saturation',
    14: 'color',
    15: 'luminosity',
    19: 'plus-lighter',
  };

  // Composite a RAW RASTER into the scene (not an SVG bundle). dstRect is
  // in CANVAS PIXELS (top-left origin, y-down); placed in a nested <svg>
  // whose own viewBox = the viewport in px so the outer em/bbox viewBox
  // doesn't distort it. z-order = call order (painter's-algorithm).
  function drawImage(source, drawOpts = {}) {
    if (!frameOpen) throw new Error('drawImage called outside beginFrame/endFrame');
    const href = sourceToHref(source);
    if (!href) {
      mantleWarn('[Mantle] native drawImage: unsupported source');
      return false;
    }
    const rawSource = source && source.__nativeImage ? source.source : source;
    const naturalSource = source && source.__nativeImage ? source : rawSource;

    const viewportSpace = coordSpace === 'viewport';

    const layerKind = viewportSpace ? 'g' : 'svg';
    // Keyed by the href itself: the same string each frame compares by identity, where a key
    // built per draw copied and compared a canvas's whole data: URL every frame.
    const { slot, node: layer } = acquireSlot(href, `image-${layerKind}`, () =>
      ownerDoc.createElementNS(SVGNS, layerKind),
    );
    beginSlotFrame(slot);
    // Reuse one <image> element per live positional slot, not per href. A DOM
    // node can only have one parent, so sharing the same <image> across
    // same-source instances moves it to the last wrapper. Distinct elements
    // with the same href still reuse the browser's decoded resource cache.
    let img = slot.imageEl;
    if (!img) {
      img = ownerDoc.createElementNS(SVGNS, 'image');
      slot.imageEl = img;
    }
    if (slot.imageHref !== href) {
      img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', href);
      img.setAttribute('href', href);
      slot.imageHref = href;
    }
    // The wrapper and its image remain mounted. Crop clips and recolor filters
    // are persistent defs as well; changing a raster frame means attribute
    // diffs rather than delete/recreate/re-append churn.
    if (!viewportSpace) {
      applyAttr(slot, layer, 'x', '0');
      applyAttr(slot, layer, 'y', '0');
      applyAttr(slot, layer, 'width', String(vpW));
      applyAttr(slot, layer, 'height', String(vpH));
      applyAttr(slot, layer, 'viewBox', `0 0 ${vpW} ${vpH}`);
      applyAttr(slot, layer, 'preserveAspectRatio', 'none');
    }

    let dst = drawOpts.dstRect;
    if (!dst && naturalSource && naturalSource.width && naturalSource.height)
      dst = [0, 0, naturalSource.width, naturalSource.height];
    else if (!dst && rawSource && rawSource.nodeType && (rawSource.naturalWidth || rawSource.width))
      dst = [
        0,
        0,
        rawSource.naturalWidth || rawSource.width,
        rawSource.naturalHeight || rawSource.height,
      ];
    if (dst) {
      applyAttr(slot, img, 'x', String(dst[0]));
      applyAttr(slot, img, 'y', String(dst[1]));
      applyAttr(slot, img, 'width', String(dst[2]));
      applyAttr(slot, img, 'height', String(dst[3]));
    }
    // Match WebGL drawImage semantics: the texture fills dstRect with NO
    // aspect preservation. An SVG <image> with explicit width/height still
    // defaults to preserveAspectRatio="xMidYMid meet" (letterbox), so without
    // this a non-source-aspect dstRect shows a source-aspect box with margins.
    // Honor an explicit drawOpts.par when the caller asks for one. Set
    // unconditionally each frame (a reused node can't carry a stale value).
    applyAttr(slot, img, 'preserveAspectRatio', drawOpts.par ? parToAttr(drawOpts.par) : 'none');
    // srcRect (sub-image) → clip via a viewBox-on-image is not supported;
    // approximate with a clipPath when given.
    if (drawOpts.srcRect && dst) {
      const sr = drawOpts.srcRect;
      if (naturalSource && naturalSource.width && naturalSource.height) {
        const sx = dst[2] / sr[2],
          sy = dst[3] / sr[3];
        const fullW = naturalSource.width * sx,
          fullH = naturalSource.height * sy;
        applyAttr(slot, img, 'width', String(fullW));
        applyAttr(slot, img, 'height', String(fullH));
        applyAttr(slot, img, 'x', String(dst[0] - sr[0] * sx));
        applyAttr(slot, img, 'y', String(dst[1] - sr[1] * sy));
        let crop = slot.rasterCrop;
        if (!crop) {
          const clip = ownerDoc.createElementNS(SVGNS, 'clipPath');
          const clipId = nativeResourceId(ownerDoc, 'mantleRasterClip');
          clip.setAttribute('id', clipId);
          clip.setAttribute('clipPathUnits', 'userSpaceOnUse');
          const rect = ownerDoc.createElementNS(SVGNS, 'rect');
          clip.appendChild(rect);
          ensureDefs().appendChild(clip);
          crop = slot.rasterCrop = { clip, rect, clipId };
        }
        applyAttr(slot, crop.rect, 'x', String(dst[0]));
        applyAttr(slot, crop.rect, 'y', String(dst[1]));
        applyAttr(slot, crop.rect, 'width', String(dst[2]));
        applyAttr(slot, crop.rect, 'height', String(dst[3]));
        applyAttr(slot, img, 'clip-path', `url(#${crop.clipId})`);
      }
    }

    // A worldMatrix with a NaN or infinite entry places nothing, as in drawBundle.
    if (badMatrix(drawOpts.worldMatrix)) {
      applyAttr(slot, layer, 'style:display', 'none');
      finishSlotFrame(slot);
      return true;
    }
    // worldMatrix (px-space mat3) + alpha + tint + blend.
    const wmStr = worldMatrixToTransform(drawOpts.worldMatrix);
    if (wmStr) applyAttr(slot, img, 'transform', wmStr);
    let opacity = typeof drawOpts.alpha === 'number' ? Math.max(0, drawOpts.alpha) : 1;
    const blend = BLEND_CSS[drawOpts.blendMode | 0];
    if (blend) applyAttr(slot, img, 'style:mix-blend-mode', blend);
    // tint: SVG <image> has no native multiply-tint; honor an alpha-only
    // tint via opacity, and an RGB tint via an feColorMatrix filter.
    // A per-draw colorMatrix rides the same filter (feColorMatrix operates
    // on straight color, like the GL path), applied BEFORE the tint.
    let rgbTint = null;
    if (drawOpts.tint) {
      const t = drawOpts.tint;
      if (t[3] != null && t[3] < 1) {
        opacity *= t[3];
      }
      if (t[0] !== 1 || t[1] !== 1 || t[2] !== 1) rgbTint = t;
    }
    const cm = drawOpts.colorMatrix,
      cmo = drawOpts.colorMatrixOffset;
    if (opacity !== 1) applyAttr(slot, img, 'opacity', String(opacity));
    if (cm || cmo || rgbTint)
      applyAttr(slot, img, 'filter', rasterRecolorFilter(slot, cm, cmo, rgbTint));
    if (img.parentNode !== layer) layer.appendChild(img);
    finishSlotFrame(slot);
    // The wrapper is already mounted (slotted); nothing to push.
    return true;
  }

  // Build an feColorMatrix filter that multiplies RGB by the tint and
  // append its <filter> to the layer; return url(#id).
  // Recolor filter for a raster blit: an optional per-draw colorMatrix
  // (+ offset) followed by an optional RGB tint multiply — the native
  // analogue of drawImage's `uColorMatrix` then `uTint` in
  // src/shaders/drawImage.frag.glsl. Both stages are feColorMatrix, which
  // (like the shader) works on straight, un-premultiplied color.
  // Numeric signature for the recolor state, laid out as
  // [cmPresent, 16 matrix, cmoPresent, 4 offset, tintPresent, 4 tint].
  // Returns true when it MATCHES (nothing to rebuild); otherwise it overwrites
  // the stored signature and returns false. Compared component-wise rather
  // than via JSON.stringify: an animated tint reaches this every frame, and
  // stringifying a mat4 + offset + tint per draw costs far more than 27 float
  // compares plus the garbage it makes.
  const RECOLOR_SIG_LEN = 27;
  function recolorSigMatches(sig, cm, cmo, tint) {
    let i = 0,
      same = true;
    const put = (v) => {
      if (sig[i] !== v) {
        same = false;
        sig[i] = v;
      }
      i++;
    };
    put(cm ? 1 : 0);
    for (let k = 0; k < 16; k++) put(cm ? cm[k] : 0);
    put(cmo ? 1 : 0);
    for (let k = 0; k < 4; k++) put(cmo ? cmo[k] : 0);
    put(tint ? 1 : 0);
    for (let k = 0; k < 4; k++) put(tint ? tint[k] : 0);
    return same;
  }

  function rasterRecolorFilter(slot, cm, cmo, tint) {
    let state = slot.rasterFilter;
    if (state && recolorSigMatches(state.sig, cm, cmo, tint)) return state.url;
    if (!state) {
      const id = nativeResourceId(ownerDoc, 'mantleRasterTint');
      const filter = ownerDoc.createElementNS(SVGNS, 'filter');
      filter.setAttribute('id', id);
      filter.setAttribute('x', '0');
      filter.setAttribute('y', '0');
      filter.setAttribute('width', '100%');
      filter.setAttribute('height', '100%');
      ensureDefs().appendChild(filter);
      // NaN-filled so the first compare always misses and builds the children.
      state = slot.rasterFilter = {
        id,
        filter,
        url: `url(#${id})`,
        sig: new Float64Array(RECOLOR_SIG_LEN).fill(NaN),
      };
      recolorSigMatches(state.sig, cm, cmo, tint); // seed it for next time
    }
    // Reuse the two feColorMatrix children across frames. An animating tint or
    // colorMatrix changes their `values`, never the graph SHAPE, so tearing the
    // subtree down and rebuilding it cost a removeChild + appendChild per frame
    // for what is a single attribute write. Nodes are created only when a stage
    // appears and removed only when it goes away; matrix always precedes tint
    // (the shader applies uColorMatrix then uTint), which insertBefore keeps
    // true even when the matrix stage appears after the tint node exists.
    const filter = state.filter;
    const stage = (key, wanted, values) => {
      let node = state[key];
      if (!wanted) {
        if (node) {
          filter.removeChild(node);
          state[key] = null;
        }
        return null;
      }
      if (!node) {
        node = state[key] = ownerDoc.createElementNS(SVGNS, 'feColorMatrix');
        node.setAttribute('type', 'matrix');
        filter.appendChild(node);
      }
      node.setAttribute('values', values);
      return node;
    };
    let matrixValues = null;
    if (cm || cmo) {
      // GL mat4 is COLUMN-major (`out = M * c`, so M[col*4+row]); SVG wants
      // 4 rows of 5 (row-major, 5th column = the offset term).
      const m = cm || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const o = cmo || [0, 0, 0, 0];
      const rows = [];
      for (let r = 0; r < 4; r++)
        rows.push(`${m[r]} ${m[4 + r]} ${m[8 + r]} ${m[12 + r]} ${o[r] || 0}`);
      matrixValues = rows.join('  ');
    }
    const feM = stage('feMatrix', matrixValues !== null, matrixValues);
    stage(
      'feTint',
      !!tint,
      tint ? `${tint[0]} 0 0 0 0  0 ${tint[1]} 0 0 0  0 0 ${tint[2]} 0 0  0 0 0 1 0` : null,
    );
    if (feM && feM.nextSibling === null && state.feTint) filter.insertBefore(feM, state.feTint);
    return state.url;
  }

  // ── Scissor — real: clip the whole <svg> to a pixel rect via CSS
  // clip-path (viewport px, origin lower left, like the GL scissor). ────
  let _scissor = null;
  function setScissorRect(x, y, w, h) {
    // The WebGL renderer's rule: whole pixels, x and y clamp to +-2^30, w and h to [0, 2^30], NaN throws.
    const LIM = 2 ** 30;
    _scissor = [
      Math.trunc(clampArg('setScissorRect', 'x', x, -LIM, LIM)),
      Math.trunc(clampArg('setScissorRect', 'y', y, -LIM, LIM)),
      Math.trunc(clampArg('setScissorRect', 'width', w, 0, LIM)),
      Math.trunc(clampArg('setScissorRect', 'height', h, 0, LIM)),
    ];
    applyScissor();
  }
  function clearScissorRect() {
    _scissor = null;
    applyScissor();
  }
  function applyScissor() {
    if (!_scissor) {
      svg.style.clipPath = '';
      return;
    }
    // CSS clip-path inset() is from the top-left in px; convert the scissor rect
    // (x, y its LOWER-left corner, as gl.scissor and the WebGL renderer's setScissorRect
    // take it) into inset(top right bottom left).
    const [x, y, w, h] = _scissor;
    const top = Math.max(0, vpH - (y + h)),
      left = x,
      right = Math.max(0, vpW - (x + w)),
      bottom = y;
    svg.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px)`;
  }

  // ── External stationary clip (setNodeClip) ───────────────────────────
  // A viewport-space clip/mask that MOVING content is drawn through — the
  // case an intra-bundle <mask> can't express (an intra-bundle mask shares
  // the bundle's em-space and translates WITH it). On native it is FULLY
  // ANALYTIC and needs no RT: a <clipPath> (mode 'in') or a luminance <mask>
  // (mode 'out' = destination-out) is injected into <defs>, and each frame
  // transformed into the target <g>'s LOCAL space via inverse(worldMatrix)
  // so its net viewport placement stays fixed while the <g>'s own transform
  // animates.
  let _extClips = new WeakMap(); // bundle record -> clip descriptor
  const activeClipDefs = new Set();
  let _defsEl = null;
  function ensureDefs() {
    if (_defsEl && _defsEl.parentNode === svg) return _defsEl;
    _defsEl = ownerDoc.createElementNS(SVGNS, 'defs');
    svg.insertBefore(_defsEl, svg.firstChild);
    return _defsEl;
  }

  // Affine helpers — (a,b,c,d,e,f) == SVG matrix(); point p' = M·p with
  // x'=a·x+c·y+e, y'=b·x+d·y+f (matches worldMatrixToTransform's column map).
  const IDENT = [1, 0, 0, 1, 0, 0];
  function wmAffine(wm) {
    return wm ? [wm[0], wm[1], wm[3], wm[4], wm[6], wm[7]] : IDENT;
  }
  function invAffine(m) {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (!det) return null;
    const ia = d / det,
      ib = -b / det,
      ic = -c / det,
      id = a / det;
    return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
  }
  function mulAffine(m1, m2) {
    const [a1, b1, c1, d1, e1, f1] = m1,
      [a2, b2, c2, d2, e2, f2] = m2;
    return [
      a1 * a2 + c1 * b2,
      b1 * a2 + d1 * b2,
      a1 * c2 + c1 * d2,
      b1 * c2 + d1 * d2,
      a1 * e2 + c1 * f2 + e1,
      b1 * e2 + d1 * f2 + f1,
    ];
  }
  function affineToMatrix(m) {
    if (!m) return '';
    const [a, b, c, d, e, f] = m;
    if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) return '';
    return `matrix(${a},${b},${c},${d},${e},${f})`;
  }

  // Strip per-element paint so a wrapping group's fill is inherited.
  function stripPaint(el) {
    if (el.removeAttribute) {
      for (const a of ['fill', 'stroke', 'style', 'opacity', 'fill-opacity', 'stroke-opacity'])
        el.removeAttribute(a);
    }
    if (el.children) for (const ch of Array.from(el.children)) stripPaint(ch);
  }

  function buildClipDef(desc) {
    const cdoc = new DOMParser().parseFromString(desc.markup, 'image/svg+xml');
    const croot = cdoc.documentElement;
    if (!croot || croot.tagName.toLowerCase() === 'parsererror')
      throw new Error('setNodeClip: failed to parse clip markup');
    const clipAffine = desc.clipAffine;
    if (desc.mode === 'out') {
      // destination-out luminance mask: white over the whole viewport, minus
      // the clip shapes (black). The mask's own transform (set per frame) is
      // inverse(worldMatrix) → bg rect maps to the viewport; the shapes carry
      // their clip worldMatrix as an inner group so they place independently.
      const mask = ownerDoc.createElementNS(SVGNS, 'mask');
      mask.setAttribute('id', desc.defId);
      mask.setAttribute('maskUnits', 'userSpaceOnUse');
      // Non-clamping region: the mask's x/y/width/height are evaluated in the
      // (moving) referencing element's user space, so a viewport-sized region
      // would slide with the bundle and clip the wrong area. A huge fixed box
      // makes the painted geometry — not the region — decide coverage.
      mask.setAttribute('x', '-100000');
      mask.setAttribute('y', '-100000');
      mask.setAttribute('width', '200000');
      mask.setAttribute('height', '200000');
      // The per-frame transform must live on an INNER group — `transform` on a
      // <mask> element is NOT honored (unlike <clipPath>), so it would leave
      // the mask in the bundle's moving local space. desc.xformEl is updated
      // each frame to inverse(worldMatrix).
      const xform = ownerDoc.createElementNS(SVGNS, 'g');
      const bg = ownerDoc.createElementNS(SVGNS, 'rect');
      // White over the whole (huge) region so content shows everywhere the
      // clip shapes don't cover — sized far beyond any viewport so a later
      // setViewport/resize never leaves a stale, too-small show-area.
      bg.setAttribute('x', '-100000');
      bg.setAttribute('y', '-100000');
      bg.setAttribute('width', '200000');
      bg.setAttribute('height', '200000');
      bg.setAttribute('fill', '#fff');
      xform.appendChild(bg);
      const grp = ownerDoc.createElementNS(SVGNS, 'g');
      grp.setAttribute('fill', '#000');
      grp.setAttribute('stroke', 'none');
      const cm = affineToMatrix(clipAffine === IDENT ? null : clipAffine);
      if (cm) grp.setAttribute('transform', cm);
      for (const ch of Array.from(croot.childNodes)) {
        const c = ownerDoc.importNode(ch, true);
        stripPaint(c);
        grp.appendChild(c);
      }
      xform.appendChild(grp);
      mask.appendChild(xform);
      desc.xformEl = xform;
      return mask;
    }
    // mode 'in': clipPath (geometry only — paint ignored). The clip
    // worldMatrix folds into the element transform set per frame. Unlike
    // <mask>, `transform` on a <clipPath> IS honored, so it carries it.
    const cp = ownerDoc.createElementNS(SVGNS, 'clipPath');
    cp.setAttribute('id', desc.defId);
    cp.setAttribute('clipPathUnits', 'userSpaceOnUse');
    for (const ch of Array.from(croot.childNodes)) cp.appendChild(ownerDoc.importNode(ch, true));
    desc.xformEl = cp;
    return cp;
  }

  function releaseClipDef(desc) {
    if (desc.defEl && desc.defEl.parentNode) desc.defEl.parentNode.removeChild(desc.defEl);
    desc.defEl = null;
    desc.xformEl = null;
    activeClipDefs.delete(desc);
  }

  function ensureExtClipDef(desc) {
    desc.lastUsedFrame = frameEpoch;
    activeClipDefs.add(desc);
    if (desc.defEl && desc.defEl.parentNode) return desc.defEl;
    desc.defEl = buildClipDef(desc);
    ensureDefs().appendChild(desc.defEl);
    return desc.defEl;
  }

  // The def's per-frame transform that holds it viewport-stationary while the
  // target <g> carries `wm`. 'out': inv(wm) (clip worldMatrix is baked into
  // the inner group); 'in': inv(wm)·clipWM on the clipPath element.
  function extClipFrameTransform(desc, wm) {
    const inv = invAffine(wmAffine(wm)) || IDENT;
    if (desc.mode === 'out' || desc.clipAffine === IDENT) return affineToMatrix(inv);
    return affineToMatrix(mulAffine(inv, desc.clipAffine));
  }

  // NOTE: single-instance. The clip is keyed by the bundle record and shares
  // one <defs> entry whose per-frame transform tracks THE draw's worldMatrix.
  // If the same bundle is drawn N times via drawBundleInstanced, every instance
  // references that one def, so the last instance's inverse-worldMatrix wins —
  // a stationary screen-space clip on instanced copies would need a def per
  // instance. setNodeClip targets a single mounted node, so this is a
  // documented limitation, not a per-frame hazard.
  // The clip descriptor for a setNodeClip-style options object, or null when it names no geometry.
  function clipDescFor(clipOpts) {
    // Clip geometry: an explicit maskSvg string, or a clip BUNDLE whose
    // retained svgSource is used (so both backends share one signature —
    // setNodeClip(target, { clipBundle, worldMatrix, mode })).
    const clipSrc = clipOpts.clipBundle !== undefined ? clipOpts.clipBundle : clipOpts.bundle;
    const clipBundle = clipSrc && clipSrc.bundle !== undefined ? clipSrc.bundle : clipSrc;
    const markup =
      clipOpts.maskSvg ||
      clipOpts.clip ||
      (clipBundle && (clipBundle.svgSource || clipBundle.svgSourceNativeText)) ||
      null;
    if (markup == null) return null;
    return {
      mode: clipOpts.mode === 'out' ? 'out' : 'in',
      markup,
      clipAffine: wmAffine(clipOpts.worldMatrix),
      defId: nativeResourceId(ownerDoc, 'mantleExtClip_'),
      defEl: null,
    };
  }
  // One descriptor per drawOpts.nodeClip object, so a clip object reused across frames keeps its def.
  const _drawClipDescs = new WeakMap();
  function drawClipDesc(nodeClip) {
    let desc = _drawClipDescs.get(nodeClip);
    if (desc === undefined) {
      desc = clipDescFor(nodeClip);
      _drawClipDescs.set(nodeClip, desc);
    }
    return desc;
  }
  function setNodeClip(target, clipOpts = {}) {
    const bundle = target && target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return;
    const rec = ensureBundleRecord(bundle, useNativeText);
    const desc = clipDescFor(clipOpts);
    if (!desc) {
      clearNodeClip(target);
      return;
    }
    const prev = _extClips.get(rec);
    if (prev) releaseClipDef(prev);
    _extClips.set(rec, desc);
  }

  function clearNodeClip(target) {
    const bundle = target && target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return;
    const rec = bundle[useNativeText ? '__nativeRecordText' : '__nativeRecord'];
    if (!rec) return;
    const c = _extClips.get(rec);
    if (c) releaseClipDef(c);
    _extClips.delete(rec);
  }

  // Pixel sources are encoded at creation. A draw before encoding completes
  // uses a data: URL for the token's lifetime. dispose() revokes blob: URLs;
  // exportFrameSVG() embeds their bytes as data: URLs.
  // Token -> the canvas its blob: URL is being encoded from, until the href settles.
  const _tokenPixels = new Map();
  // Token -> the Blob behind its live blob: href (for export, and revoked by dispose).
  const _blobTokens = new Map();

  function plainToken(source) {
    return {
      __nativeImage: true,
      source,
      width: source && source.width,
      height: source && source.height,
      href: null,
    };
  }

  /** @param {any} source @param {object} [_opts] @returns {NativeImageToken} */
  function createImage(source, _opts) {
    const token = /** @type {NativeImageToken} */ (plainToken(source));
    token.dispose = () => disposeToken(token);
    const pixels = rasterCanvas(source);
    if (
      !pixels ||
      typeof pixels.toBlob !== 'function' ||
      typeof URL === 'undefined' ||
      !URL.createObjectURL
    ) {
      token.ready = Promise.resolve(token);
      return token;
    }
    _tokenPixels.set(token, pixels);
    token.ready = new Promise((resolve) => {
      try {
        pixels.toBlob((blob) => {
          // Unless a draw, the token's dispose() or the scene's settled it first.
          if (blob && _tokenPixels.has(token)) {
            token.href = URL.createObjectURL(blob);
            _blobTokens.set(token, blob);
          }
          _tokenPixels.delete(token);
          resolve(token);
        }, 'image/png');
      } catch {
        resolve(token); // a tainted canvas: its draw takes the data: path, as before
      }
    });
    return token;
  }

  // Release a token's blob: URL. A later draw of it takes the data: path from its source.
  function disposeToken(token) {
    _tokenPixels.delete(token);
    if (token.href) {
      _restingRasters.delete(token.href);
      for (const slots of [_slots, _nextSlots])
        for (const slot of slots) if (slot.imageHref === token.href) slot.rasterDisposed = true;
    }
    if (!_blobTokens.delete(token)) return;
    URL.revokeObjectURL(token.href);
    token.href = null;
  }

  function createBundleHandle(bundle, opts = {}) {
    const cacheCfg = opts && opts.staticCache;
    if (!cacheCfg) {
      return {
        bundle,
        isNativeHandle: true,
        draw(drawOpts) {
          drawBundle(bundle, drawOpts || {});
        },
        dispose() {},
      };
    }

    let bake = null; // { href, x, y, w, h, contentKey }
    let bakeInflight = null;
    let disposed = false;

    // What the baked bitmap DEPICTS. worldMatrix and alpha are deliberately
    // absent: drawBaked re-applies both to the wrapper <g> every frame, so
    // keying on them would re-bake a fading or moving card once per frame —
    // the exact per-paint cost the bake exists to remove.
    function contentKey(drawOpts) {
      const ov = drawOpts && drawOpts.overrides;
      const gen = ov && typeof ov.generation === 'number' ? ov.generation : 0;
      const geom = (bundle && bundle._geomGen) | 0;
      return geom + ':' + gen;
    }

    function stayLive(drawOpts) {
      // The bake is the source as authored, under the wrapper's matrix and alpha. A draw that changes the picture any other way is drawn live.
      if (
        drawOpts &&
        (hasRecolor(drawOpts) ||
          drawOpts.blendMode ||
          drawOpts.dstRect != null ||
          drawOpts.nodeClip ||
          drawOpts.spriteKey != null ||
          drawOpts.shapeRange ||
          badMatrix(drawOpts.worldMatrix))
      )
        return true;
      if (
        bundle.__streamPathD ||
        bundle.__nativeMorphOverrides ||
        _extClips.has(ensureBundleRecord(bundle, useNativeText))
      )
        return true;
      const table = drawOpts && drawOpts.overrides;
      if (
        table &&
        !(
          table.activeIndices &&
          Array.from(table.activeIndices()).length === 0 &&
          !table.extraShapes &&
          !(table.clippers && table.clippers.size)
        )
      )
        return true;
      try {
        if (typeof cacheCfg.isAnimatorActive === 'function' && cacheCfg.isAnimatorActive())
          return true;
        if (typeof cacheCfg.isMorphActive === 'function' && cacheCfg.isMorphActive()) return true;
      } catch {
        /* predicate threw — stay live */
      }
      // Overrides that aren't a generation-tracked table can't be keyed.
      const ov = drawOpts && drawOpts.overrides;
      if (ov && typeof ov.generation !== 'number') return true;
      return false;
    }

    function scheduleBake(key) {
      if (bakeInflight || disposed) return;
      const source = bundle && bundle.svgSource;
      // The bitmap covers what the live clone can paint: the document's viewBox and the inked box, whichever reach further.
      const box = (r) => (r && r[2] > 0 && r[3] > 0 ? r : null);
      const vb = box(bundle && bundle.viewBox),
        gb = box(bundle && bundle.globalBBox);
      const bbox =
        vb && gb
          ? [
              Math.min(vb[0], gb[0]),
              Math.min(vb[1], gb[1]),
              Math.max(vb[0] + vb[2], gb[0] + gb[2]) - Math.min(vb[0], gb[0]),
              Math.max(vb[1] + vb[3], gb[1] + gb[3]) - Math.min(vb[1], gb[1]),
            ]
          : vb || gb;
      if (!source || !bbox) return;
      // Cap bake resolution: enough for retina HUD/card sizes, cheap to blit.
      const longest = Math.max(bbox[2], bbox[3]);
      const scale = Math.max(1, Math.min(3, 768 / longest));
      const pw = Math.max(1, Math.ceil(bbox[2] * scale));
      const ph = Math.max(1, Math.ceil(bbox[3] * scale));
      // Standalone SVG document in the bundle's em space so filters rasterize
      // with the same geometry the live <g> would have used: the root's viewport
      // becomes exactly the box the bitmap is drawn back at. Only the ROOT TAG is
      // rewritten -- a child's width= / xmlns: are not the root's.
      let svgText = source;
      const rootTag = (svgText.match(/<svg\b[^>]*>/i) || [''])[0];
      if (!rootTag) return;
      const closes = rootTag.endsWith('/>');
      let rootNext = rootTag
        .slice(0, closes ? -2 : -1)
        .replace(/\s(width|height|viewBox|preserveAspectRatio)\s*=\s*("[^"]*"|'[^']*')/gi, '');
      if (!/\sxmlns\s*=/i.test(rootNext)) rootNext += ' xmlns="http://www.w3.org/2000/svg"';
      // Force explicit pixel size for the Image decode path.
      rootNext += ` viewBox="${bbox[0]} ${bbox[1]} ${bbox[2]} ${bbox[3]}" width="${pw}" height="${ph}" preserveAspectRatio="none"`;
      svgText = svgText.replace(rootTag, () => rootNext + (closes ? '/>' : '>'));
      const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
      const url =
        typeof URL !== 'undefined' && URL.createObjectURL ? URL.createObjectURL(blob) : null;
      if (!url) return;
      bakeInflight = key;
      const img = new Image();
      img.onload = () => {
        try {
          if (disposed || bakeInflight !== key) return;
          const cv = ownerDoc.createElement('canvas');
          cv.width = pw;
          cv.height = ph;
          const ctx = cv.getContext('2d');
          if (!ctx) {
            bake = null;
            return;
          }
          ctx.drawImage(img, 0, 0, pw, ph);
          bake = {
            href: cv.toDataURL('image/png'),
            x: bbox[0],
            y: bbox[1],
            w: bbox[2],
            h: bbox[3],
            contentKey: key,
          };
        } finally {
          try {
            URL.revokeObjectURL(url);
          } catch {
            /* ignore */
          }
          if (bakeInflight === key) bakeInflight = null;
        }
      };
      img.onerror = () => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          /* ignore */
        }
        if (bakeInflight === key) bakeInflight = null;
      };
      img.src = url;
    }

    function drawBaked(b, drawOpts) {
      // Same placement contract as live SVG: wrapper takes worldMatrix, image
      // sits at the bundle's em bbox so translation-only motion never rebakes.
      const { slot, node: g } = acquireSlot(
        'bake:' + ensureBundleRecord(bundle, useNativeText).id + ':' + b.contentKey,
        'bundle-bake',
        () => ownerDoc.createElementNS(SVGNS, 'g'),
      );
      beginSlotFrame(slot);
      const xform = slotWorldTransform(slot, drawOpts.worldMatrix);
      if (xform) applyAttr(slot, g, 'transform', xform);
      if (typeof drawOpts.alpha === 'number' && drawOpts.alpha < 1)
        applyAttr(slot, g, 'opacity', String(drawOpts.alpha));
      if (drawOpts.hidden) {
        applyAttr(slot, g, 'style:display', 'none');
        finishSlotFrame(slot);
        return;
      }
      let img = slot.bakeImg;
      if (!img) {
        img = ownerDoc.createElementNS(SVGNS, 'image');
        img.setAttribute('preserveAspectRatio', 'none');
        slot.bakeImg = img;
        g.appendChild(img);
      }
      if (slot.bakeHref !== b.href) {
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', b.href);
        img.setAttribute('href', b.href);
        slot.bakeHref = b.href;
      }
      applyAttr(slot, img, 'x', String(b.x));
      applyAttr(slot, img, 'y', String(b.y));
      applyAttr(slot, img, 'width', String(b.w));
      applyAttr(slot, img, 'height', String(b.h));
      finishSlotFrame(slot);
    }

    function draw(drawOpts) {
      drawOpts = drawOpts || {};
      if (!frameOpen) {
        // Matches drawBundle's contract when called outside a frame.
        beginFrame();
        try {
          draw(drawOpts);
        } finally {
          endFrame();
        }
        return;
      }
      if (stayLive(drawOpts)) {
        bake = null;
        drawBundle(bundle, drawOpts);
        return;
      }
      const key = contentKey(drawOpts);
      if (bake && bake.contentKey === key) {
        drawBaked(bake, drawOpts);
        return;
      }
      drawBundle(bundle, drawOpts);
      scheduleBake(key);
    }

    // A stable object, not a getter that rebuilds one per access: consumers
    // hold on to `handle.staticCache` and compare it across frames. Narrower
    // than the WebGL state machine on purpose — native has no RT, no levels
    // and no shared groups, so only validity and invalidation are meaningful.
    const nativeStaticCache = {
      get isCacheValid() {
        return !!bake;
      },
      invalidate() {
        bake = null;
      },
    };

    return {
      bundle,
      isNativeHandle: true,
      staticCache: nativeStaticCache,
      draw,
      invalidate() {
        bake = null;
      },
      dispose() {
        disposed = true;
        bake = null;
        bakeInflight = null;
      },
    };
  }

  /** Queue a bundle for stable z-order painting at endFrame. Lower zOrder
   * paints underneath; equal values preserve submission order. Immediate
   * drawBundle calls remain underneath queued submissions, matching WebGL. */
  function submitBundle(target, drawOpts = {}) {
    if (!target) return;
    if (!frameOpen) {
      drawBundle(target, drawOpts);
      return;
    }
    const z =
      typeof drawOpts.zOrder === 'number' && Number.isFinite(drawOpts.zOrder) ? drawOpts.zOrder : 0;
    _submitQ.push({ target, drawOpts, z, seq: _submitSeq++ });
  }

  function flushSubmitQueue() {
    const queued = _submitQ;
    if (!queued.length) return;
    let ordered = true;
    for (let i = 1; i < queued.length; i++) {
      const prev = queued[i - 1],
        next = queued[i];
      if (prev.z > next.z || (prev.z === next.z && prev.seq > next.seq)) {
        ordered = false;
        break;
      }
    }
    if (!ordered) queued.sort((a, b) => (a.z !== b.z ? a.z - b.z : a.seq - b.seq));
    _submitQ = [];
    _submitSeq = 0;
    for (const entry of queued) drawBundle(entry.target, entry.drawOpts);
  }

  // ── GPU-only optimizations: no-ops on native (the browser re-rasterizes
  // each frame; there's no render-target cache to enable/invalidate). ──
  function enableStaticCache() {
    return false;
  }
  function disableStaticCache() {}
  function invalidateRenderState() {}

  // ── Legacy single-bundle path. setBundle stashes; render draws it. ───
  let _bundle = null;
  function setBundle(bundle) {
    _bundle = bundle;
  }

  function endFrame() {
    // Drain before trimming positional slots: a submit issued while a queued
    // draw is being resolved belongs to the same frame, just as on WebGL.
    // The depth cap breaks a submit-from-a-submit cycle; anything still queued
    // then would be dropped silently, so say so and clear it rather than carry
    // it into the next frame's ordering.
    let guard = 0;
    while (_submitQ.length && guard++ < 8) flushSubmitQueue();
    if (_submitQ.length) {
      console.warn(
        `[Mantle] native submitBundle: ${_submitQ.length} submission(s) ` +
          'dropped — draws kept re-submitting for 8 drain passes.',
      );
      _submitQ.length = 0;
      _submitSeq = 0;
    }
    frameOpen = false;

    if (_reconciling) {
      for (let i = _reconcileFrom; i < _slots.length; i++)
        if (_slots[i].seenFrame !== frameEpoch) retireSlot(_slots[i]);
      const old = _slots;
      _slots = _nextSlots;
      _nextSlots = old;
      _nextSlots.length = 0;
      _readCursor = _slots.length;
      _reconciling = false;
    } else {
      for (let i = _readCursor; i < _slots.length; i++) retireSlot(_slots[i]);
      _slots.length = _readCursor;
    }
    _slotIndex = null;
    trimRestingRasters();
    // A definition stays mounted while any draw in this frame uses it.
    for (const template of activeTemplates)
      if (template.lastUsedFrame !== frameEpoch) {
        if (template.group.parentNode) template.group.parentNode.removeChild(template.group);
        activeTemplates.delete(template);
      }
    for (const desc of activeClipDefs) if (desc.lastUsedFrame !== frameEpoch) releaseClipDef(desc);
  }

  function dispose() {
    frameOpen = false;
    svg.__viewBoxSet = false;
    _bundle = null;
    _clearColor = null;
    clearSlot = null;
    clearViewBox = null;
    activeViewBox = null;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    _slots.length = 0;
    _nextSlots.length = 0;
    _slotIndex = null;
    _restingRasters.clear();
    _tokenPixels.clear();
    for (const token of _blobTokens.keys()) {
      URL.revokeObjectURL(token.href);
      token.href = null;
    }
    _blobTokens.clear();
    _readCursor = 0;
    _submitQ.length = 0;
    _submitSeq = 0;
    _instanceTemplates = new WeakMap();
    activeTemplates.clear();
    // Drop external-clip descriptors + the (now-removed) <defs> ref so a
    // disposed scene retains no DOM nodes or parsed clip markup.
    _extClips = new WeakMap();
    activeClipDefs.clear();
    _defsEl = null;
    if (svg.parentNode && svg !== host) svg.parentNode.removeChild(svg);
  }

  // Single-bundle render: if a bundle is passed, draw it; else draw the
  // setBundle()-stashed one. Matches renderer.render()'s dual use.
  function render(bundleOrOpts, maybeOpts) {
    let bundle, drawOpts;
    if (bundleOrOpts && bundleOrOpts.numShapes !== undefined) {
      bundle = bundleOrOpts;
      drawOpts = maybeOpts || {};
    } else {
      bundle = _bundle;
      drawOpts = bundleOrOpts || {};
    }
    if (!bundle) return false;
    beginFrame(drawOpts.clearColor);
    drawBundle(bundle, drawOpts);
    endFrame();
    return true;
  }

  // SVG export — the native scene IS live SVG DOM, so "export the current
  // frame" is just serializing the root <svg>. A createMantleScene consumer
  // can call scene.exportFrameSVG() regardless of backend. Async-shaped for
  // that parity (the value is ready synchronously; `await` works either way).
  async function exportFrameSVG(exportOpts = {}) {
    let out = exportOpts.serialize
      ? exportOpts.serialize(svg)
      : typeof globalThis !== 'undefined' && typeof globalThis.XMLSerializer === 'function'
        ? new globalThis.XMLSerializer().serializeToString(svg)
        : svg && typeof svg.outerHTML === 'string'
          ? svg.outerHTML
          : '';
    // A blob: href resolves only in this page: write each token's as the data: URL of its pixels.
    if (typeof out === 'string')
      for (const [href, blob] of [..._blobTokens].map(([token, b]) => [token.href, b]))
        if (out.includes(href)) out = out.split(href).join(await blobDataUrl(blob));
    return exportOpts.detail ? { svg: out, drawn: -1, skipped: 0, notes: [] } : out;
  }

  return {
    get svg() {
      return svg;
    },
    get isNative() {
      return true;
    },
    // SVG export (backend-parity with the WebGL renderer). See above.
    exportFrameSVG,
    // Shared scene surface (works on both backends).
    setViewport,
    setCoordinateSpace, // native-only: 'viewport' | 'bundle'
    get coordinateSpace() {
      return coordSpace;
    },
    beginFrame,
    drawBundle,
    submitBundle,
    drawImage,
    endFrame,
    dispose,
    render,
    setBundle,
    // Renderer-parity methods — REAL fallbacks (subset draw / per-instance
    // loop), so a renderer-style consumer's calls keep working on native:
    drawSprite,
    drawSpriteInstanced,
    drawBundleInstanced,
    drawImageInstanced,
    drawInstance,
    createImage,
    createBundleHandle,
    setScissorRect,
    clearScissorRect,
    // setNodeClip — stationary viewport-space clip (mode 'in') / mask
    // (mode 'out' = destination-out) the target bundle is drawn THROUGH.
    // Vector + analytic (browser-rendered), no RT.
    setNodeClip,
    clearNodeClip,
    // GPU-only optimizations → no-ops on native (browser re-rasterizes):
    enableStaticCache,
    disableStaticCache,
    invalidateRenderState,
  };
}

export { curveRangeToPathD };
