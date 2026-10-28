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
// bundle pixel interaction. That is EXACTLY SVG's own document-order
// paint model, so the whole scene maps to sibling <g> nodes inside one
// <svg>. Each draw becomes a `<g transform="matrix(...)">` wrapping that
// bundle's source content; z-order = sibling order = call order.
//
// WHAT WORKS: solid/gradient fills + strokes, <mask>/<filter>/<clipPath>
// (the browser re-evaluates them per frame natively as geometry moves),
// per-shape overrides (transform/visibility/recolor by id), animated
// clip transforms (setClipper), and geometry MORPHS (the native morph
// rewrites each shape's `d` per frame — see nativeMorph.js).
//
// WHAT DIFFERS: output is the browser's SVG rasterization, NOT Mantle's
// coverage — visually equivalent, not bit-identical.

import { curveRangeToPathD } from './curveToPathD.js';
import { mantleWarn } from '../core/diagnostics.js';
import { parseColor } from '../svg/color.js';
import { isSvgHref } from '../svg/image.js';
import { applyRecolor, hasRecolor } from './recolorColor.js';

const SVGNS = 'http://www.w3.org/2000/svg';

// Encoded preserveAspectRatio (parAx, parAy, parMs) → SVG attribute.
function parToAttr(par) {
  if (!par) return 'xMidYMid meet';
  const [ax, ay, ms] = par;
  if (ax === -1) return 'none';
  const a = ax === 0 ? 'Min' : ax === 2 ? 'Max' : 'Mid';
  const b = ay === 0 ? 'Min' : ay === 2 ? 'Max' : 'Mid';
  return `x${a}Y${b} ${ms === 1 ? 'slice' : 'meet'}`;
}

function rgbaToCss(c) {
  const r = Math.round(Math.max(0, Math.min(1, c[0])) * 255);
  const g = Math.round(Math.max(0, Math.min(1, c[1])) * 255);
  const b = Math.round(Math.max(0, Math.min(1, c[2])) * 255);
  const a = Math.max(0, Math.min(1, c.length > 3 ? c[3] : 1));
  return `rgba(${r},${g},${b},${a})`;
}

let _bundleRecordSeq = 0;   // stable per-bundle id for slot keying

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
      'render the original markup.');
  }
  const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() === 'parsererror')
    throw new Error('createNativeScene: failed to parse bundle.svgSource');

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
  const imgs = frag.querySelectorAll
    ? frag.querySelectorAll('image')
    : [];
  if (!imgs || !imgs.length) return;
  const atlasUrls = (opts && opts.inlineFromAtlas !== false)
    ? atlasDataUrls(bundle, ownerDoc) : null;
  const base = opts && opts.baseUrl;
  // atlasUrls is indexed by RASTER-claim order: the importer only pushes
  // decoded raster images to the atlas — data:/blob: hrefs are
  // self-contained and SVG-content hrefs are inlined recursively, so
  // neither takes an atlas slot. Advance the cursor only for hrefs the
  // importer would have claimed as raster, else a non-atlas <image>
  // preceding a raster one shifts every subsequent atlas index.
  let atlasIdx = 0;
  for (const im of Array.from(imgs)) {
    const href = im.getAttribute('href')
      || im.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    if (/^(data:|blob:)/i.test(href) || isSvgHref(href)) continue;
    let next = null;
    if (atlasUrls && atlasUrls[atlasIdx]) next = atlasUrls[atlasIdx];
    else if (base) { try { next = new URL(href, base).href; } catch {} }
    if (next) {
      im.setAttribute('href', next);
      im.setAttributeNS('http://www.w3.org/1999/xlink', 'href', next);
    }
    atlasIdx++;
  }
}

// Reconstruct one data: URL per atlas image (document order = imageId
// order, the same order the importer claimed them). Cached on the bundle.
function atlasDataUrls(bundle, ownerDoc) {
  if (bundle.__atlasDataUrls) return bundle.__atlasDataUrls;
  if (!bundle.imageAtlas || !bundle.imageAtlasDim || !bundle.imageAtlasRects)
    return null;
  const [atlasW] = bundle.imageAtlasDim;
  const px = new Uint8Array(bundle.imageAtlas);
  const urls = bundle.imageAtlasRects.map(([atlasY, w, h]) => {
    const cv = ownerDoc.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    const id = ctx.createImageData(w, h);
    // Copy the sub-rect (w may be < atlasW; rows are atlasW wide).
    for (let row = 0; row < h; row++) {
      const srcOff = ((atlasY + row) * atlasW) * 4;
      const dstOff = (row * w) * 4;
      id.data.set(px.subarray(srcOff, srcOff + w * 4), dstOff);
    }
    ctx.putImageData(id, 0, 0);
    return cv.toDataURL('image/png');
  });
  bundle.__atlasDataUrls = urls;
  return urls;
}

// Monotonic suffix source for per-clone id namespacing (below).
let __cloneIdSeq = 0;

// Namespace every authored id in a freshly-cloned bundle subtree so that
// id-references (`url(#m1)` masks/clips/gradients/filters, `href="#g"`
// templates) DO NOT COLLIDE across bundles in the shared host <svg>.
//
// SVG resolves `url(#id)` / `href="#id"` at DOCUMENT scope — the FIRST
// matching id wins — NOT within the referencing element's subtree. So when
// two bundles each ship `<mask id="m1">`, every `mask="url(#m1)"` in the
// document binds to whichever m1 was mounted first → broken masking.
// Per-bundle uniqueness fixes it.
//
// The original id is preserved on `data-oid` so the override path (which
// addresses clip/mask/shape elements by their AUTHORED id via `slotEl`) keeps
// working — slotEl indexes both the live (namespaced) id and `data-oid`.
const NS_REF_ATTRS = ['mask', 'clip-path', 'fill', 'stroke', 'filter',
  'marker', 'marker-start', 'marker-mid', 'marker-end'];
function namespaceCloneIds(root) {
  if (!root.querySelectorAll) return;
  const idEls = root.querySelectorAll('[id]');
  if (!idEls.length) return;
  const suffix = '_b' + (__cloneIdSeq++);
  const map = new Map();
  for (const el of idEls) {
    const old = el.getAttribute('id');
    if (!old) continue;
    map.set(old, old + suffix);
    el.setAttribute('data-oid', old);
    el.setAttribute('id', old + suffix);
  }
  if (!map.size) return;
  const rewrite = (v) => v.replace(/url\(\s*#([^)\s]+)\s*\)/g,
    (m, id) => (map.has(id) ? `url(#${map.get(id)})` : m));
  for (const el of root.querySelectorAll('*')) {
    if (!el.getAttribute) continue;
    for (const a of NS_REF_ATTRS) {
      const v = el.getAttribute(a);
      if (v && v.indexOf('url(') >= 0) { const nv = rewrite(v); if (nv !== v) el.setAttribute(a, nv); }
    }
    const st = el.getAttribute('style');
    if (st && st.indexOf('url(') >= 0) { const nv = rewrite(st); if (nv !== st) el.setAttribute('style', nv); }
    for (const h of ['href', 'xlink:href']) {
      const hv = el.getAttribute(h);
      if (hv && hv.charAt(0) === '#' && map.has(hv.slice(1))) el.setAttribute(h, '#' + map.get(hv.slice(1)));
    }
  }
}

// Pull the inner markup of the source <svg> (its children) so we can
// re-host them under a <g> with our own transform. Defs (<mask>,
// <filter>, <clipPath>, <linearGradient>…) come along as children; their ids
// are NAMESPACED per-clone (see namespaceCloneIds) so cross-bundle `url(#…)`
// references don't collide in the shared host <svg>. Raster <image> hrefs are
// rewritten (atlas-inlined / absolutized) so the browser can load them.
function cloneSourceInner(rec, ownerDoc, bundle, hrefOpts) {
  const frag = ownerDoc.createDocumentFragment();
  for (const child of Array.from(rec.sourceRoot.childNodes)) {
    frag.appendChild(ownerDoc.importNode(child, true));
  }
  // querySelectorAll isn't on a DocumentFragment in every engine; wrap in a
  // temp <g> that supports it — used for both id-namespacing + image hrefs.
  const probe = ownerDoc.createElementNS(SVGNS, 'g');
  probe.appendChild(frag);
  namespaceCloneIds(probe);
  if (bundle && (bundle.imageAtlas || (hrefOpts && hrefOpts.baseUrl))) {
    rewriteImageHrefs(probe, ownerDoc, bundle, hrefOpts);
  }
  const out = ownerDoc.createDocumentFragment();
  while (probe.firstChild) out.appendChild(probe.firstChild);
  return out;
}

/**
 * Create a native-SVG scene bound to a host. `host` may be:
 *   - an <svg> element (used directly), or
 *   - any HTML element (a container; an <svg> is created inside it), or
 *   - a <canvas> — NOTE: SVG can't paint into a 2D canvas live; when a
 *     canvas is passed we create an <svg> overlay positioned over it and
 *     warn. For true canvas compositing use the (heavier) rasterize-to-
 *     image path; the DOM <svg> is the recommended, faster fallback.
 *
 * @param {Element} host
 * @param {object}  [opts]
 * @param {Document} [opts.document]  defaults to host.ownerDocument
 * @returns {object} scene with setViewport/beginFrame/drawBundle/endFrame
 */
export function createNativeScene(host, opts = {}) {
  const ownerDoc = opts.document || (host && host.ownerDocument) || (typeof document !== 'undefined' ? document : null);
  if (!ownerDoc) throw new Error('createNativeScene: no document available');

  let svg;
  if (host && host.tagName && host.tagName.toLowerCase() === 'svg') {
    svg = host;
  } else {
    svg = ownerDoc.createElementNS(SVGNS, 'svg');
    if (host && host.tagName && host.tagName.toLowerCase() === 'canvas') {
      // Best-effort overlay: position the <svg> over the canvas.
      mantleWarn('createNativeScene: a <canvas> host cannot be painted by ' +
        'SVG directly; creating an <svg> overlay. Pass an <svg> or container ' +
        'element to avoid the overlay.');
      svg.style.position = 'absolute';
      if (host.parentNode) host.parentNode.insertBefore(svg, host.nextSibling);
    } else if (host) {
      host.appendChild(svg);
    }
  }

  let vpW = 0, vpH = 0;
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
  let rasterClipSeq = 0;        // unique-id counter for raster clip/tint defs

  // ── Positional reconciliation ────────────────────────────────────────
  // The native fallback is the no-GPU path. Keep persistent DOM nodes
  // ("slots") mounted across frames and, per frame, only UPDATE what
  // changed (a <g>'s transform, an overridden shape's attrs, an <image>'s
  // dst rect) — rather than a full DOM teardown + re-clone every frame.
  // Draws are matched to last frame's slots POSITIONALLY (slot N this frame
  // reuses slot N from last frame when the bundle/href matches), so the
  // consumer keeps the same immediate-mode beginFrame/drawBundle/endFrame
  // loop. A slot is rebuilt only when the bundle/href at its position
  // changes; trailing slots no longer drawn are removed.
  const _slots = [];           // persistent [{ kind, key, node, ... }]
  let _slotCursor = 0;         // next slot index to fill this frame
  // Every live raster <image>, by href. A draw claims an unclaimed <image>
  // of its href wherever it sits (moving it into its own wrapper) before
  // creating one, so a raster joining or leaving the middle of the draw
  // order creates at most its own <image>: a slow device decodes each new
  // <image> again. endFrame detaches the <image>s no draw claimed, and keeps
  // each for `IMAGE_KEPT_FRAMES` frames so a raster that blinks or hides a
  // moment reattaches its own <image> instead of creating one.
  const _imagesByHref = new Map();
  const IMAGE_KEPT_FRAMES = 120;
  let _imageFrame = 0;

  // Acquire the slot at the current cursor for (key, kind). If the existing
  // slot matches, reuse its mounted node (reused:true → caller updates attrs
  // only). Otherwise build a fresh node via makeNode() and swap it into the
  // live DOM at this position. Advances the cursor. The node stays mounted
  // across frames; endFrame() trims slots past the cursor.
  function acquireSlot(key, kind, makeNode) {
    const i = _slotCursor++;
    const cur = _slots[i];
    if (cur && cur.key === key && cur.kind === kind) {
      return { slot: cur, node: cur.node, reused: true };
    }
    const node = makeNode();
    if (cur) {
      // Replace the live node in place (preserves document order).
      if (cur.node.parentNode === svg) svg.replaceChild(node, cur.node);
      _slots[i] = newSlot(key, kind, node);
    } else {
      svg.appendChild(node);
      _slots[i] = newSlot(key, kind, node);
    }
    return { slot: _slots[i], node, reused: false };
  }

  function newSlot(key, kind, node) {
    return {
      key, kind, node,
      // id → element index for the cloned subtree, built lazily on first
      // override (avoids a per-frame querySelector('#id') tree-walk). null
      // until indexed; rebuilt if the subtree is replaced (acquireSlot
      // makes a new slot object then).
      idIndex: null,
      // element → Map<attr, originalValue|null>: the AUTHORED value of each
      // attribute we've overridden, snapshotted once, so a dropped override
      // can revert. 'style:display' is the CSS-display pseudo-attr.
      orig: new Map(),
      // element → Map<attr, currentlyAppliedValue>: what we last wrote, so a
      // frame that writes the SAME value skips the DOM mutation entirely
      // (a paused morph / unchanged shape costs zero writes).
      applied: new Map(),
      // element → Set<attr> set THIS frame (reset per draw); used at frame
      // end to revert attrs that were applied last frame but not this one.
      frameTouch: new Map(),
    };
  }

  // ── Per-frame override application (diffing) ──────────────────────────
  // A reused bundle slot keeps its cloned subtree mounted, so overrides
  // persist on the elements. Rather than revert-everything-then-reapply, we
  // DIFF: snapshot the authored value once, write only when the desired
  // value differs from what's currently applied, and at frame end revert
  // only attrs that were applied last frame but are no longer set.

  // Resolve a shape/clip id to its element via the slot's id index, building
  // the index once on first use. After a primitive→<path> swap the caller
  // updates the index entry (see applyShapeOverride).
  function slotEl(slot, groupEl, id) {
    let idx = slot.idIndex;
    if (!idx) {
      idx = slot.idIndex = new Map();
      // One subtree walk total (not per-frame): index every id-bearing node.
      // Index by BOTH the live (per-clone namespaced) id AND the authored id
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
  const RECOLOR_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'text']);

  // Non-rendered containers. A shape element INSIDE one of these defines
  // mask/clip/paint-server/template geometry — it is NOT a rendered leaf,
  // and the importer numbers it separately (mask/clip "layer" rows come
  // AFTER the visible shapes; clip/mask geometry is addressed by id via
  // setClipper, not positionally). They also appear FIRST in document
  // order (<defs> precedes content), so counting them would shift every
  // visible shape's positional index on masked/clipped art.
  const NON_RENDER_CONTAINERS = new Set(['defs', 'mask', 'clippath', 'symbol', 'pattern', 'marker']);
  function inNonRenderContainer(el, stopAt) {
    for (let p = el.parentNode; p && p !== stopAt && p.nodeType === 1; p = p.parentNode) {
      if (NON_RENDER_CONTAINERS.has(p.tagName.toLowerCase())) return true;
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
        if (!RECOLOR_TAGS.has(el.tagName.toLowerCase())) continue;
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
    return shapeElByIndex(slot, groupEl, idx);
  }

  // Isolate ONE sprite: hide every rendered top-level child of the clone
  // except the sprite's own element (a sprite is by definition a top-level
  // id'd <g>/shape — see bundle.spriteRanges). Resolves the sprite id via
  // slotEl (works across per-clone id namespacing through data-oid) and
  // hides via applyAttr so the isolation diffs/reverts per frame like any
  // override. Returns false when the id can't be resolved inside the clone
  // (caller falls back to the meta-row range hide).
  const NON_RENDER_TOPLEVEL = new Set(['defs', 'clippath', 'mask', 'pattern',
    'symbol', 'marker', 'lineargradient', 'radialgradient', 'filter',
    'style', 'title', 'desc', 'metadata', 'script']);
  function hideAllButSprite(slot, groupEl, spriteId) {
    const target = slotEl(slot, groupEl, spriteId);
    if (!target || !groupEl.contains(target)) return false;
    // The sprite element is normally a direct child of the mount <g>
    // (top-level in the source markup). Isolate along the ancestor chain —
    // hide the siblings at EVERY level up to the mount — so a sprite inside
    // a wrapper group is still cleanly isolated from its wrapper siblings.
    for (let node = target; node !== groupEl; node = node.parentNode) {
      const parent = node.parentNode;
      if (!parent) return false;
      for (let c = parent.firstChild; c; c = c.nextSibling) {
        if (c.nodeType !== 1 || c === node) continue;
        if (NON_RENDER_TOPLEVEL.has(c.tagName.toLowerCase())) continue;
        applyAttr(slot, c, 'style:display', 'none');
      }
    }
    return true;
  }

  // Map a clip/mask LAYER shape index to its child element inside the live
  // <clipPath>/<mask>. Layer shapes are deliberately EXCLUDED from the
  // positional shapeElByIndex walk (they're not rendered leaves), but a
  // morph still computes their interpolated geometry and writes it by shape
  // index — e.g. an animated reveal <mask>. Without this the mask geometry
  // override has nowhere to land, so the mask freezes at the cloned source
  // pose and the reveal snaps at keyframes. bundle.clipperRows maps a
  // clip/mask svgId → [firstRow,lastRow]; we invert it (once per slot) to
  // resolve a row to its {svgId, ordinal} and return the ordinal-th shape
  // child of <… id="svgId">.
  function layerChildEl(slot, groupEl, bundle, idx) {
    if (!slot.layerMap) {
      slot.layerMap = new Map();
      const cr = (bundle && bundle.clipperRows) || null;
      if (cr) for (const svgId in cr) {
        const r = cr[svgId]; if (!r) continue;
        const first = r[0] | 0, last = r[1] | 0;
        for (let row = first; row <= last; row++) {
          if (!slot.layerMap.has(row)) slot.layerMap.set(row, { svgId, ord: row - first });
        }
      }
    }
    const e = slot.layerMap.get(idx);
    if (!e) return null;
    const container = slotEl(slot, groupEl, e.svgId);   // <clipPath id>/<mask id>
    if (!container) return null;
    let n = 0;
    for (let c = container.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 1 && RECOLOR_TAGS.has(c.tagName.toLowerCase())) {
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
    const gen = bundle.__streamGen | 0;
    if (slot.streamGen === gen) return;        // unchanged since this slot's last draw
    slot.streamGen = gen;
    const ds = bundle.__streamPathD, fs = bundle.__streamFills || null;
    const n = ds.length;
    let dCache = slot.streamD, fCache = slot.streamF, hCache = slot.streamHidden;
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
      // A morph's matched shape may be a primitive in the source markup —
      // convert to <path> once so the streamed `d` lands (no-op for a
      // synthesized all-<path> source).
      if (el.tagName.toLowerCase() !== 'path') el = ensurePathEl(slot, el, null, i);
      const d = dv || '';
      // An empty `d` paints nothing but still costs layout/paint walk per
      // frame. display:none drops the node from paint entirely — this is what
      // keeps a stream with many off-screen (degenerate) shapes cheap vs a
      // visible-only rebuild. Toggle is guarded so it only writes
      // on a visible↔hidden transition, and a hidden shape skips d/fill writes.
      const empty = d === '';
      if (hCache[i] !== empty) { el.style.display = empty ? 'none' : ''; hCache[i] = empty; }
      if (empty) continue;
      if (dCache[i] !== d) { el.setAttribute('d', d); dCache[i] = d; }
      if (fs) { const c = fs[i]; if (c != null && fCache[i] !== c) { el.setAttribute('fill', c); fCache[i] = c; } }
    }
  }

  // Begin a draw on this slot: clear the per-frame touch record.
  function beginSlotFrame(slot) { slot.frameTouch.clear(); }

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
    // Snapshot the authored value once (before our first override of it).
    let o = slot.orig.get(el);
    if (!o) { o = new Map(); slot.orig.set(el, o); }
    if (!o.has(attr)) {
      o.set(attr, sp ? el.style.getPropertyValue(sp) : el.getAttribute(attr));
    }
    // Record that this attr is set this frame (so it isn't reverted at end).
    let ft = slot.frameTouch.get(el);
    if (!ft) { ft = new Set(); slot.frameTouch.set(el, ft); }
    ft.add(attr);
    // Diff against the currently-applied value; skip the DOM write if equal.
    let ap = slot.applied.get(el);
    if (!ap) { ap = new Map(); slot.applied.set(el, ap); }
    if (ap.get(attr) === value) return;
    ap.set(attr, value);
    if (sp) el.style.setProperty(sp, value || '');
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
        if (ft && ft.has(attr)) { removedAll = false; continue; }
        const o = slot.orig.get(el);
        const val = o ? o.get(attr) : null;
        const sp = styleProp(attr);
        if (sp) el.style.setProperty(sp, val || '');
        else if (val == null) el.removeAttribute(attr);
        else el.setAttribute(attr, val);
        ap.delete(attr);
      }
      if (removedAll && ap.size === 0) slot.applied.delete(el);
    }
  }

  function setViewport(w, h) {
    vpW = w | 0; vpH = h | 0;
    svg.setAttribute('width', String(vpW));
    svg.setAttribute('height', String(vpH));
    if (coordSpace === 'viewport') {
      // Pixel user-space: the root viewBox IS the viewport, independent of
      // any bundle's bbox. Bundles place via their em→pixel worldMatrix.
      svg.setAttribute('viewBox', `0 0 ${vpW} ${vpH}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.__viewBoxSet = true;
    }
  }

  // Declare the coordinate space (see coordSpace above). Call before the
  // first draw. 'viewport' is the contract for a multi-bundle pixel
  // compositor: setViewport sets viewBox="0 0 w h" and worldMatrix is
  // em→pixel.
  function setCoordinateSpace(space) {
    coordSpace = space === 'viewport' ? 'viewport' : 'bundle';
    if (coordSpace === 'viewport' && vpW > 0) {
      svg.setAttribute('viewBox', `0 0 ${vpW} ${vpH}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.__viewBoxSet = true;
    } else {
      svg.__viewBoxSet = false;   // let the next bundle set its em viewBox
    }
  }

  function beginFrame(clearColor) {
    frameOpen = true;
    _slotCursor = 0;
    _imageFrame++;
    // viewBox is set on the FIRST drawn bundle (so the <svg> user-space
    // matches that bundle's em/viewBox space, matching how worldMatrix
    // operates in em space). Background clear:
    beginFrame._clearPushed = false;
    if (clearColor && clearColor[3] !== 0) {
      // Defer the clear rect until we know the viewBox; stash the color.
      beginFrame._clear = clearColor;
    } else {
      beginFrame._clear = null;
    }
  }

  // Resolve the SVG user-space (viewBox) from the first bundle drawn, and
  // (every frame) place the background clear rect ahead of the content so
  // it paints behind. The viewBox attr is set once; the clear rect is the
  // first positional slot (index 0), so it stays mounted and only its
  // attrs update across frames.
  function ensureViewBox(bundle) {
    // In viewport mode the viewBox is the pixel viewport (set in
    // setViewport); the clear rect spans it. In bundle mode the viewBox is
    // the first bundle's em-box and the clear rect spans that.
    const viewport = coordSpace === 'viewport';
    const vb = viewport
      ? [0, 0, vpW, vpH]
      : ((bundle.viewBox && bundle.viewBox[2] > 0) ? bundle.viewBox : bundle.globalBBox);
    if (!svg.__viewBoxSet) {
      svg.setAttribute('viewBox', `${vb[0]} ${vb[1]} ${vb[2]} ${vb[3]}`);
      svg.setAttribute('preserveAspectRatio',
        viewport ? 'none' : parToAttr(bundle.preserveAspectRatio));
      svg.__viewBoxSet = true;
    }
    if (beginFrame._clear && !beginFrame._clearPushed) {
      // Clear rect = the first slot, reused across frames; only its attrs
      // update when the viewport/color changes.
      const { node: r, reused } = acquireSlot('__clear__', 'rect',
        () => ownerDoc.createElementNS(SVGNS, 'rect'));
      r.setAttribute('x', String(vb[0])); r.setAttribute('y', String(vb[1]));
      r.setAttribute('width', String(vb[2])); r.setAttribute('height', String(vb[3]));
      r.setAttribute('fill', rgbaToCss(beginFrame._clear));
      beginFrame._clearPushed = true;
      void reused;
    }
  }

  // worldMatrix is a column-major mat3 (Float32Array(9)) operating in em
  // space: col0=(m00,m10,0) col1=(m01,m11,0) col2=(tx,ty,1). SVG
  // matrix(a,b,c,d,e,f) wants (m00,m10,m01,m11,tx,ty) — same em space.
  function worldMatrixToTransform(wm) {
    if (!wm) return null;
    const a = wm[0], b = wm[1], c = wm[3], d = wm[4], e = wm[6], f = wm[7];
    // Identity → omit.
    if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) return null;
    return `matrix(${a},${b},${c},${d},${e},${f})`;
  }

  // The authored (pre-tint/pre-recolor) value of a paint attr, cached per
  // element so multiplicative tint never reads its own tinted write back
  // (which would compound frame-to-frame). Shares slot.recolorBase with the
  // per-draw recolor pass so both agree on the base color. Returns the CSS
  // string, or null when the attr is absent.
  function tintBaseColor(slot, el, attr) {
    if (!slot.recolorBase) slot.recolorBase = new Map();
    let base = slot.recolorBase.get(el);
    if (!base) { base = {}; slot.recolorBase.set(el, base); }
    if (base[attr] != null) return base[attr];
    const snap = slot.orig.get(el);
    const css = (snap && snap.has(attr)) ? snap.get(attr) : el.getAttribute(attr);
    base[attr] = css;
    return css;
  }

  // Geometry-driven shapes need a <path d="…">. If the cloned source element is
  // a primitive (<rect>/<circle>/<ellipse>/<polygon>/<line>), swap it for a
  // <path> that inherits its presentation attributes so the tweened/streamed
  // `d` can land. Done once; subsequent frames reuse the <path>. Shared by the
  // override path (applyShapeOverride) and the direct-write path
  // (applyStreamGeometry). `shapeId` may be null (positional addressing).
  const PRIM_GEOM_ATTRS = ['x','y','width','height','cx','cy','r','rx','ry','points','x1','y1','x2','y2','d'];
  function ensurePathEl(slot, el, shapeId, shapeIdx) {
    if (el.tagName.toLowerCase() === 'path') return el;
    const p = ownerDoc.createElementNS(SVGNS, 'path');
    for (const attr of Array.from(el.attributes)) {
      // Primitive geometry attrs don't apply to <path>; keep id/fill/stroke/transform/clip.
      if (PRIM_GEOM_ATTRS.includes(attr.name.toLowerCase())) continue;
      p.setAttribute(attr.name, attr.value);
    }
    el.parentNode.replaceChild(p, el);
    // Keep the id index + cached shape list + snapshot/applied state pointing at
    // the new node (same document position) so later frames find the <path>.
    if (slot.idIndex && shapeId != null) slot.idIndex.set(shapeId, p);
    if (slot.shapeEls) { const k = slot.shapeEls.indexOf(el); if (k >= 0) slot.shapeEls[k] = p; }
    const o0 = slot.orig.get(el); if (o0) { slot.orig.set(p, o0); slot.orig.delete(el); }
    const a0 = slot.applied.get(el); if (a0) { slot.applied.set(p, a0); slot.applied.delete(el); }
    const rb = slot.recolorBase && slot.recolorBase.get(el);
    if (rb) { slot.recolorBase.set(p, rb); slot.recolorBase.delete(el); }
    return p;
  }

  // Apply one shape's override object to its DOM element. Addressed by the
  // authored id when present; synthetic shape_N_* ids don't exist in the
  // markup, so those fall through to POSITIONAL addressing: shape index
  // N → the N-th renderable element in document order, which matches how
  // the importer numbers shapes. Without this, morphs/overrides on id-less
  // artwork (the common case) silently no-op because every id lookup misses.
  function applyShapeOverride(slot, groupEl, shapeId, shapeIdx, o, bundle) {
    let el = (shapeId != null && shapeId !== '' && !isSyntheticId(shapeId))
      ? slotEl(slot, groupEl, shapeId)
      : null;
    if (!el) el = shapeElByRow(slot, groupEl, bundle, shapeIdx);
    // Clip/mask layer shape (no rendered leaf): route to the <mask>/
    // <clipPath> child so an animated mask/clip GEOMETRY morph lands.
    if (!el) el = layerChildEl(slot, groupEl, bundle, shapeIdx);
    if (!el) return;

    // Morph-driven geometry needs a <path d="…">; convert a primitive once.
    if (o.pathD != null) el = ensurePathEl(slot, el, shapeId, shapeIdx);

    // Transform (localPosition/Scale/Rotation) → element transform.
    const hasXform = (o.localPosition && (o.localPosition[0] || o.localPosition[1]))
      || o.localRotation || (o.localScale && (o.localScale[0] !== 1 || o.localScale[1] !== 1));
    if (hasXform) {
      const tx = o.localPosition ? o.localPosition[0] : 0;
      const ty = o.localPosition ? o.localPosition[1] : 0;
      const deg = (o.localRotation || 0) * 180 / Math.PI;
      const sx = o.localScale ? o.localScale[0] : 1;
      const sy = o.localScale ? o.localScale[1] : 1;
      applyAttr(slot, el, 'transform',
        `translate(${tx} ${ty}) rotate(${deg}) scale(${sx} ${sy})`);
    }

    // Visibility → opacity (0 ⇒ also display:none so it's fully gone).
    if (typeof o.visibility === 'number' && o.visibility < 1) {
      applyAttr(slot, el, 'opacity', String(Math.max(0, o.visibility)));
      if (o.visibility <= 0) applyAttr(slot, el, 'style:display', 'none');
    }

    // Absolute fill / stroke / strokeWidth.
    if (o.fill) applyAttr(slot, el, 'fill', rgbaToCss(o.fill));
    if (o.stroke) applyAttr(slot, el, 'stroke', rgbaToCss(o.stroke));
    if (typeof o.strokeWidth === 'number') applyAttr(slot, el, 'stroke-width', String(o.strokeWidth));

    // Tint (multiplicative RGBA) — matching the GL shader's `vFill *= tint` /
    // `vStroke *= tint`: multiply the shape's resolved fill AND stroke COLOR
    // by the full tint (all four channels into the paint). The base color is
    // the post-fill-override fill (o.fill if set this frame, else the authored
    // fill snapshot), so the result is stable + diffable and never compounds
    // its own output. Solid-fill shapes are exact; gradient/image/url() fills
    // have no single color → skipped (alpha-only fallback below so a
    // translucent tint still dims them).
    if (o.tint) {
      const t = o.tint;
      const rgbTint = (t[0] !== 1 || t[1] !== 1 || t[2] !== 1);
      let appliedToPaint = false;
      for (const attr of ['fill', 'stroke']) {
        // Base: an absolute override set this frame wins; else the authored
        // value (cached so we never read our own tinted write back).
        const overrode = o[attr] != null;
        const base = overrode ? rgbaToCss(o[attr]) : tintBaseColor(slot, el, attr);
        if (base == null || base === 'none' || /url\(/i.test(base)) continue;  // gradient/image/none
        const rgba = parseColor(base);
        if (!rgba) continue;
        applyAttr(slot, el, attr, rgbaToCss(applyRecolor(rgba, { tint: t })));
        appliedToPaint = true;
      }
      // If the tint couldn't reach any solid paint (e.g. all fills are
      // gradients) fall back to group opacity for the alpha component, so a
      // translucent tint still dims the shape as before.
      if (!appliedToPaint && rgbTint === false && t[3] != null && t[3] < 1) {
        const snap = slot.orig.get(el);
        const baseOp = snap && snap.has('opacity') ? snap.get('opacity') : el.getAttribute('opacity');
        applyAttr(slot, el, 'opacity', String(parseFloat(baseOp || '1') * t[3]));
      }
    }

    // Morph-driven geometry: rewrite the path data (el is a <path> by
    // now — converted above if the source was a primitive).
    if (o.pathD != null) applyAttr(slot, el, 'd', o.pathD);
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
      const deg = (c.localRotation || 0) * 180 / Math.PI;
      const sx = c.localScale ? c.localScale[0] : 1;
      const sy = c.localScale ? c.localScale[1] : 1;
      // gradientTransform/clipPath transform on the element itself.
      applyAttr(slot, el, 'transform',
        `translate(${tx} ${ty}) rotate(${deg}) scale(${sx} ${sy})`);
    }
  }

  // Inject + update the table's "extra shapes" — geometry that has no element
  // in the cloned source markup (the native morph's dst-only shapes). Each
  // gets a persistent <path> appended to the bundle <g>; static attrs (d,
  // fill, stroke) are set once, the fade-in opacity updates per frame. The
  // node list is cached on the slot and trimmed when the table has fewer
  // extras (or none — e.g. the morph was dropped), reusing the slot diff
  // model so a removed extra cleanly unmounts.
  function applyExtraShapes(slot, groupEl, table) {
    const extras = table.extraShapes;
    if (!slot.extraEls) slot.extraEls = [];
    const want = extras ? extras.length : 0;
    // Trim surplus nodes (fewer extras than last frame).
    for (let i = slot.extraEls.length - 1; i >= want; i--) {
      const node = slot.extraEls[i];
      if (node && node.parentNode) node.parentNode.removeChild(node);
      slot.extraEls.pop();
    }
    if (!extras) return;
    // Skip the whole pass when nothing changed since last draw on this slot.
    const gen = table.extrasGeneration | 0;
    const sameGen = slot.extrasGen === gen;
    for (let i = 0; i < want; i++) {
      const e = extras[i];
      let node = slot.extraEls[i];
      if (!node || node.__extraKey !== e.key) {
        // (Re)build this slot: fresh <path> with the static geometry/paint.
        if (node && node.parentNode) node.parentNode.removeChild(node);
        node = ownerDoc.createElementNS(SVGNS, 'path');
        node.__extraKey = e.key;
        node.setAttribute('d', e.pathD);
        if (e.fill) node.setAttribute('fill', rgbaToCss(e.fill));
        if (e.stroke && (e.strokeWidth || 0) > 0) {
          node.setAttribute('stroke', rgbaToCss(e.stroke));
          node.setAttribute('stroke-width', String(e.strokeWidth));
        }
        if (e.evenOdd) node.setAttribute('fill-rule', 'evenodd');
        node.__extraAlpha = -1;     // force the opacity write below
        groupEl.appendChild(node);
        slot.extraEls[i] = node;
      } else if (sameGen) {
        continue;                    // unchanged → no per-frame write
      }
      // Fade-in opacity (the only per-frame value). display:none at fully
      // transparent so a 0-alpha extra doesn't capture hit-testing.
      const a = Math.max(0, Math.min(1, e.alpha));
      if (node.__extraAlpha !== a) {
        node.__extraAlpha = a;
        if (a <= 0) { node.style.display = 'none'; }
        else { node.style.display = ''; node.setAttribute('opacity', String(a)); }
      }
    }
    slot.extrasGen = gen;
  }

  function drawBundle(bundle, drawOpts = {}) {
    if (!frameOpen) throw new Error('drawBundle called outside beginFrame/endFrame');
    const rec = ensureBundleRecord(bundle, useNativeText);
    ensureViewBox(bundle);

    // Positional slot: the same bundle redrawn in the same call-order
    // position reuses its mounted <g> AND its already-cloned subtree, so
    // the per-frame deep clone (importNode of the whole source SVG) only
    // happens the first time. On reuse we revert last frame's overrides
    // then re-apply this frame's — no DOM teardown, no re-clone.
    const { slot, node: g, reused } = acquireSlot(rec.id, 'bundle', () => {
      const ng = ownerDoc.createElementNS(SVGNS, 'g');
      ng.appendChild(cloneSourceInner(rec, ownerDoc, bundle, {
        baseUrl: drawOpts.baseUrl || opts.baseUrl,
        inlineFromAtlas: drawOpts.inlineFromAtlas !== undefined
          ? drawOpts.inlineFromAtlas : opts.inlineFromAtlas,
      }));
      return ng;
    });
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
    // Build the matrix(...) string ONLY when the worldMatrix actually changed
    // (a streaming bundle's <g> is often stationary — the motion lives in the
    // streamed geometry — so this is a no-op string alloc every frame otherwise). Cache
    // the 6 components + the resulting string on the slot. applyAttr is still
    // called so its diff no-ops the DOM write AND records the per-frame touch
    // (skipping it would make finishSlotFrame revert the transform).
    const wm = drawOpts.worldMatrix;
    let xform;
    if (!wm) { xform = null; slot.lastWM = null; }
    else {
      const a = wm[0], b = wm[1], c = wm[3], d = wm[4], e = wm[6], f = wm[7];
      let lw = slot.lastWM;
      if (lw && lw[0] === a && lw[1] === b && lw[2] === c && lw[3] === d && lw[4] === e && lw[5] === f) {
        xform = slot.lastXform;
      } else {
        xform = (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0)
          ? null : `matrix(${a},${b},${c},${d},${e},${f})`;
        if (!lw) lw = slot.lastWM = new Float64Array(6);
        lw[0] = a; lw[1] = b; lw[2] = c; lw[3] = d; lw[4] = e; lw[5] = f;
        slot.lastXform = xform;
      }
    }
    if (xform) applyAttr(slot, g, 'transform', xform);
    if (typeof drawOpts.alpha === 'number' && drawOpts.alpha < 1)
      applyAttr(slot, g, 'opacity', String(drawOpts.alpha));
    // Per-draw blend mode (multiply/screen/…) → CSS mix-blend-mode on the
    // <g>, as in drawImage. GL bundles can composite with a blend mode.
    const gBlend = BLEND_CSS[drawOpts.blendMode | 0];
    if (gBlend) applyAttr(slot, g, 'style:mix-blend-mode', gBlend);

    // External stationary clip (setNodeClip): apply the viewport-space
    // clip/mask and re-aim its transform at THIS frame's worldMatrix so the
    // clip stays put while the bundle animates. applyAttr → reverts cleanly
    // if the clip is later cleared.
    const extClip = _extClips.get(rec.id);
    if (extClip) {
      ensureExtClipDef(extClip);
      applyAttr(slot, g, extClip.mode === 'out' ? 'mask' : 'clip-path',
        `url(#${extClip.defId})`);
      extClip.xformEl.setAttribute('transform', extClipFrameTransform(extClip, drawOpts.worldMatrix));
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
      shapeElByIndex(slot, g, -1);            // build slot.shapeEls
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
          const o = table.get ? table.get(idx) : null;
          if (o) applyShapeOverride(slot, g, id || '', idx, o, bundle);
        }
      } else {
        const count = Math.max(ids.length, table.numShapes || 0, bundle.numShapes || 0);
        for (let idx = 0; idx < count; idx++) {
          const id = ids[idx];
          const o = table.get ? table.get(idx) : null;
          if (o) applyShapeOverride(slot, g, id || '', idx, o, bundle);
        }
      }
      applyClippers(slot, g, table);
      // Injected shapes that have no element in the source markup — the
      // native morph's dst-only shapes (present only in the destination
      // pose), faded in across t. Mounted as fresh <path>s after the cloned
      // subtree and updated per frame.
      applyExtraShapes(slot, g, table);
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
    return true;
  }

  // Recolor EVERY renderable shape's fill/stroke — addressed POSITIONALLY by
  // walking the subtree, NOT by shapeId. Recolor is a per-DRAW effect that
  // applies to every shape uniformly (like the GL fragment shader), so it
  // must work even when the source artwork has NO id attributes (the common
  // case — an id-keyed pass would miss them all and no-op). The BASE color is
  // cached per element so we recolor from the authored/override value, never
  // from last frame's recolored output. Written via applyAttr so the recolor
  // diffs + reverts when dropped.
  function applyRecolorPass(slot, groupEl, bundle, drawOpts) {
    if (!slot.recolorBase) slot.recolorBase = new Map();   // el → {fill, stroke} css
    // Reuse the same cached renderable-shape list the positional override
    // addressing uses (shapeElByIndex builds it). shapeElByIndex(slot,_,−1)
    // triggers the build without returning an element.
    shapeElByIndex(slot, groupEl, -1);
    const params = {
      tint: drawOpts.tint, channelLerp: drawOpts.channelLerp,
      colorMatrix: drawOpts.colorMatrix, colorMatrixOffset: drawOpts.colorMatrixOffset,
      palette: paletteParam(drawOpts.palette, drawOpts.paletteChannel),
    };
    for (const el of (slot.shapeEls || [])) {
      recolorOne(slot, el, 'fill', params);
      recolorOne(slot, el, 'stroke', params);
    }
    // Injected dst-only morph shapes (slot.extraEls) aren't in the cloned
    // subtree's shape list, but the recolor is a per-draw effect that applies
    // to ALL drawn geometry — so recolor them too (from their authored dst
    // paint). applyExtraShapes only writes opacity per frame, so it won't
    // fight these fill/stroke writes; finishSlotFrame reverts them if the
    // recolor is dropped.
    for (const el of (slot.extraEls || [])) {
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
    const ch = typeof channel === 'string'
      ? ({ r: 0, g: 1, b: 2, a: 3 }[channel.toLowerCase()] || 0)
      : (channel | 0);
    // Normalize entries to [0,1] once and cache on the token.
    if (!pal.__entries01) {
      pal.__entries01 = pal.entries.map(e => [
        (e[0] || 0) / 255, (e[1] || 0) / 255, (e[2] || 0) / 255,
        e[3] != null ? e[3] / 255 : 1,
      ]);
    }
    return { entries: pal.__entries01, channel: ch };
  }

  function recolorOne(slot, el, attr, params) {
    // The recolor BASE is the post-override, pre-recolor color:
    //   • if an absolute fill/stroke override set this attr THIS frame
    //     (it's in frameTouch), the override value is the base;
    //   • else the authored color — the snapshot in slot.orig if we've ever
    //     overridden this attr, otherwise the live attribute (which, on the
    //     first recolor, is still authored). We cache that authored value in
    //     recolorBase so subsequent frames don't read our own recolored write.
    const ft = slot.frameTouch.get(el);
    const overrodeThisFrame = ft && ft.has(attr);
    let css;
    if (overrodeThisFrame) {
      // An override (absolute fill/stroke or override-tint) already wrote
      // this attr THIS frame → recolor composes on top of that value (the
      // shader applies per-draw recolor AFTER per-shape override + tint).
      // Do NOT cache this into recolorBase — it's not the authored base.
      css = slot.applied.get(el).get(attr);
    } else {
      // No override this frame → recolor the authored color. tintBaseColor
      // returns (and caches once) the authored value so we never read our
      // own recolored write back.
      css = tintBaseColor(slot, el, attr);
    }
    if (css == null || css === 'none' || /url\(/i.test(css)) return;  // gradient/image/none
    const rgba = parseColor(css);
    if (!rgba) return;
    applyAttr(slot, el, attr, rgbaToCss(applyRecolor(rgba, params)));
  }

  // Resolve a sprite id (or explicit [first,last]) against the bundle's
  // spriteRanges.
  function resolveSpriteRange(bundle, sprite) {
    if (Array.isArray(sprite) && sprite.length === 2) return [sprite[0] | 0, sprite[1] | 0];
    if (typeof sprite !== 'string') return null;
    const r = bundle && bundle.spriteRanges && bundle.spriteRanges[sprite];
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
    return drawBundle(bundle, { ...drawOpts, shapeRange: range,
      spriteKey: typeof sprite === 'string' ? sprite : null });
  }

  // Instance a bundle at N transforms: one <g> per instance.
  function drawBundleInstanced(target, instances, shared = {}) {
    const bundle = target && target.bundle !== undefined ? target.bundle : target;
    if (!bundle || !Array.isArray(instances)) return 0;
    let n = 0;
    // Merge the WHOLE per-instance object over `shared` so EVERY per-instance
    // drawOpt passes through — not just worldMatrix/alpha but per-instance
    // tint / colorMatrix / channelLerp / palette / overrides / blendMode too.
    for (const inst of instances) { drawBundle(bundle, { ...shared, ...inst }); n++; }
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
    for (const inst of instances) { drawBundle(bundle, { ...shared, ...inst, shapeRange: range, spriteKey }); n++; }
    return n;
  }

  // Raster blit at N transforms.
  function drawImageInstanced(source, instances, shared = {}) {
    if (!Array.isArray(instances)) return 0;
    // Materialize raw sources once for the whole batch. drawImage(rawSource)
    // intentionally stays live, but an instanced batch should not re-encode the
    // same pixels through canvas.toDataURL() for every instance.
    const batchSource = source && source.__nativeImage ? source : createImage(source);
    let n = 0;
    // Full per-instance passthrough so per-instance tint / srcRect / blendMode
    // / opacity all apply (the GL path tints each blit independently).
    for (const inst of instances) { drawImage(batchSource, { ...shared, ...inst }); n++; }
    return n;
  }

  // drawInstance — drawBundle without an implicit frame clear. In the
  // native model every drawBundle is already additive within a frame, so
  // this is just drawBundle.
  function drawInstance(bundle, drawOpts) { return drawBundle(bundle, drawOpts || {}); }

  // Turn a raster source into a data: URL the browser can draw. Accepts
  // the same source forms as the WebGL renderer's createImage:
  //   - a data:/blob:/remote URL string (used as-is)
  //   - { width, height, rgba|data } raw pixels  (→ canvas → toDataURL)
  //   - an HTMLImageElement / HTMLCanvasElement / ImageBitmap / ImageData
  function sourceToHref(source) {
    if (source && source.__nativeImage) {
      if (source.href) return source.href;
      const href = sourceToHref(source.source);
      source.href = href;
      return href;
    }
    if (typeof source === 'string') return source;          // url / data uri
    if (source && (source.rgba || source.data) && source.width && source.height
        && !(source.nodeType)) {                            // raw pixels / ImageData
      const w = source.width | 0, h = source.height | 0;
      const cv = ownerDoc.createElement('canvas');
      cv.width = w; cv.height = h;
      const c2 = cv.getContext('2d');
      const id = c2.createImageData(w, h);
      id.data.set(source.rgba || source.data);
      c2.putImageData(id, 0, 0);
      return cv.toDataURL('image/png');
    }
    if (source && source.nodeType) {                        // <img>/<canvas>
      if (source.tagName && source.tagName.toLowerCase() === 'canvas')
        return source.toDataURL('image/png');
      if (source.src) return source.src;                    // <img>
    }
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
      const cv = ownerDoc.createElement('canvas');
      cv.width = source.width; cv.height = source.height;
      cv.getContext('2d').drawImage(source, 0, 0);
      return cv.toDataURL('image/png');
    }
    return null;
  }

  // Map a WebGL blendMode enum to the SVG/CSS mix-blend-mode keyword that
  // matches. 0 = normal (source-over). Unknown → normal.
  const BLEND_CSS = {
    0: null, 1: 'multiply', 2: 'screen', 3: 'overlay', 4: 'darken',
    5: 'lighten', 6: 'color-dodge', 7: 'color-burn', 8: 'hard-light',
    9: 'soft-light', 10: 'difference', 11: 'exclusion', 12: 'hue',
    13: 'saturation', 14: 'color', 15: 'luminosity',
  };

  // Composite a RAW RASTER into the scene (not an SVG bundle). dstRect is
  // in CANVAS PIXELS (top-left origin, y-down); placed in a nested <svg>
  // whose own viewBox = the viewport in px so the outer em/bbox viewBox
  // doesn't distort it. z-order = call order (painter's-algorithm).
  function claimImage(href) {
    let images = _imagesByHref.get(href);
    if (!images) { images = []; _imagesByHref.set(href, images); }
    for (const image of images) {
      if (image.__mantleFrame !== _imageFrame) { image.__mantleFrame = _imageFrame; return image; }
    }
    const image = ownerDoc.createElementNS(SVGNS, 'image');
    image.setAttributeNS('http://www.w3.org/1999/xlink', 'href', href);
    image.setAttribute('href', href);
    image.__mantleAttrs = new Map();
    image.__mantleBlend = '';
    image.__mantleFrame = _imageFrame;
    images.push(image);
    return image;
  }

  function dropUnclaimedImages() {
    for (const [href, images] of _imagesByHref) {
      const kept = images.filter((image) => {
        if (image.__mantleFrame === _imageFrame) return true;
        if (image.parentNode) image.parentNode.removeChild(image);
        return _imageFrame - image.__mantleFrame < IMAGE_KEPT_FRAMES;
      });
      if (kept.length) _imagesByHref.set(href, kept);
      else _imagesByHref.delete(href);
    }
  }

  function drawImage(source, drawOpts = {}) {
    if (!frameOpen) throw new Error('drawImage called outside beginFrame/endFrame');
    const href = sourceToHref(source);
    if (!href) { mantleWarn('[Mantle] native drawImage: unsupported source'); return false; }
    const rawSource = source && source.__nativeImage ? source.source : source;
    const naturalSource = source && source.__nativeImage ? source : rawSource;

    // dstRect is in VIEWPORT PIXELS. How we host the <image> depends on the
    // scene's coordinate space:
    //   'viewport' — the root <svg> viewBox is ALREADY the pixel viewport
    //                (0 0 vpW vpH), so the <image> goes straight in; it
    //                aligns with the bundles (which are also placed in
    //                pixel space via their em→pixel worldMatrix).
    //   'bundle'   — the root viewBox is some bundle's em-box, so a raster
    //                in pixels would be distorted. Wrap it in a nested
    //                <svg viewBox="0 0 vpW vpH"> to (re)establish pixel
    //                space independent of the outer em viewBox.
    // Either way z-order = call order (the layer/image is one slotted
    // node, interleaved with bundle <g> nodes).
    const viewportSpace = coordSpace === 'viewport';
    // Positional slot for the wrapper, keyed by (href, space). It stays
    // mounted across frames; we only rebuild its transient children. The key
    // folds in the coordinate space so a 'g'⇄'svg' switch rebuilds the node.
    const layerKind = viewportSpace ? 'g' : 'svg';
    const { slot, node: layer } = acquireSlot(
      'img', `image-${layerKind}`,
      () => ownerDoc.createElementNS(SVGNS, layerKind));
    // Reuse one <image> element per live positional slot, not per href. A DOM
    // node can only have one parent, so sharing the same <image> across
    // same-source instances moves it to the last wrapper. Distinct elements
    // with the same href still reuse the browser's decoded resource cache.
    const img = claimImage(href);
    // The <image> stays mounted in its wrapper across frames, and only the
    // attributes that differ from what this slot last wrote are written: a
    // slow device restyles and repaints for every DOM write, so a raster drawn
    // in place again costs no DOM mutation. Transient clip/filter defs (a
    // srcRect or recolor, rare) are regenerated per frame beside the image.
    if (slot.imageDefs) {
      for (const def of slot.imageDefs) if (def.parentNode === layer) layer.removeChild(def);
      slot.imageDefs = null;
    }
    const attrs = new Map();
    const want = (name, value) => attrs.set(name, value);
    const defs = [];
    if (!viewportSpace) {
      const layerAttrs = [['x', '0'], ['y', '0'], ['width', String(vpW)], ['height', String(vpH)],
        ['viewBox', `0 0 ${vpW} ${vpH}`], ['preserveAspectRatio', 'none']];
      for (const [name, value] of layerAttrs) if (layer.getAttribute(name) !== value) layer.setAttribute(name, value);
    }

    // `img` is this slot's <image> for this href (created/reused above; href
    // already set). Collect its placement attributes; written once below.
    // dstRect [x,y,w,h] in px; default = the source's natural size at the
    // origin (matches WebGL drawImage's [0,0,img.w,img.h]). For URL/<img>
    // sources without known dimensions and no dstRect we still emit the
    // <image> (the browser sizes it intrinsically once loaded).
    let dst = drawOpts.dstRect;
    if (!dst && naturalSource && naturalSource.width && naturalSource.height)
      dst = [0, 0, naturalSource.width, naturalSource.height];
    else if (!dst && rawSource && rawSource.nodeType
             && (rawSource.naturalWidth || rawSource.width))
      dst = [0, 0, rawSource.naturalWidth || rawSource.width, rawSource.naturalHeight || rawSource.height];
    if (dst) {
      want('x', String(dst[0])); want('y', String(dst[1]));
      want('width', String(dst[2])); want('height', String(dst[3]));
    }
    // Match WebGL drawImage semantics: the texture fills dstRect with NO
    // aspect preservation. An SVG <image> with explicit width/height still
    // defaults to preserveAspectRatio="xMidYMid meet" (letterbox), so without
    // this a non-source-aspect dstRect shows a source-aspect box with margins.
    // Honor an explicit drawOpts.par when the caller asks for one.
    want('preserveAspectRatio', drawOpts.par ? parToAttr(drawOpts.par) : 'none');
    // srcRect (sub-image) → clip via a viewBox-on-image is not supported;
    // approximate with a clipPath when given.
    if (drawOpts.srcRect && dst) {
      const sr = drawOpts.srcRect; // px in source space
      // Scale the image up so the requested sub-rect fills dst, then clip
      // to dst. Requires the natural image size; only do this when pixels
      // were given (we know w/h) — else skip (full image).
      if (naturalSource && naturalSource.width && naturalSource.height) {
        const sx = dst[2] / sr[2], sy = dst[3] / sr[3];
        const fullW = naturalSource.width * sx, fullH = naturalSource.height * sy;
        want('width', String(fullW));
        want('height', String(fullH));
        want('x', String(dst[0] - sr[0] * sx));
        want('y', String(dst[1] - sr[1] * sy));
        const clip = ownerDoc.createElementNS(SVGNS, 'clipPath');
        const clipId = `mantleRasterClip${rasterClipSeq++}`;
        clip.setAttribute('id', clipId);
        const cr = ownerDoc.createElementNS(SVGNS, 'rect');
        cr.setAttribute('x', String(dst[0])); cr.setAttribute('y', String(dst[1]));
        cr.setAttribute('width', String(dst[2])); cr.setAttribute('height', String(dst[3]));
        clip.appendChild(cr);
        layer.appendChild(clip);
        defs.push(clip);
        want('clip-path', `url(#${clipId})`);
      }
    }

    // worldMatrix (px-space mat3) + alpha + tint + blend.
    const wmStr = worldMatrixToTransform(drawOpts.worldMatrix);
    if (wmStr) want('transform', wmStr);
    let opacity = typeof drawOpts.alpha === 'number' && drawOpts.alpha < 1 ? Math.max(0, drawOpts.alpha) : 1;
    // tint: SVG <image> has no native multiply-tint; honor an alpha-only
    // tint via opacity, and an RGB tint via an feColorMatrix filter.
    // A per-draw colorMatrix rides the same filter (feColorMatrix operates
    // on straight color, like the GL path), applied BEFORE the tint.
    let rgbTint = null;
    if (drawOpts.tint) {
      const t = drawOpts.tint;
      if (t[3] != null && t[3] < 1) opacity *= t[3];
      if ((t[0] !== 1 || t[1] !== 1 || t[2] !== 1)) rgbTint = t;
    }
    if (opacity < 1) want('opacity', String(opacity));
    const cm = drawOpts.colorMatrix, cmo = drawOpts.colorMatrixOffset;
    if (cm || cmo || rgbTint) {
      want('filter', rasterRecolorFilter(layer, cm, cmo, rgbTint));
      defs.push(layer.lastChild);
    }
    if (defs.length) slot.imageDefs = defs;

    // Write only what differs from this slot's last frame, and remove what
    // last frame set but this one doesn't (a reused node can't carry a stale
    // transform, opacity, filter or clip).
    const applied = img.__mantleAttrs;
    for (const [name, value] of attrs) {
      if (applied.get(name) !== value) { img.setAttribute(name, value); applied.set(name, value); }
    }
    for (const name of [...applied.keys()]) {
      if (!attrs.has(name)) { img.removeAttribute(name); applied.delete(name); }
    }
    const blend = BLEND_CSS[drawOpts.blendMode | 0] || '';
    if (img.__mantleBlend !== blend) { img.style.mixBlendMode = blend; img.__mantleBlend = blend; }

    if (layer.lastChild !== img) layer.appendChild(img);
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
  function rasterRecolorFilter(layer, cm, cmo, tint) {
    const id = `mantleRasterTint${rasterClipSeq++}`;
    const filter = ownerDoc.createElementNS(SVGNS, 'filter');
    filter.setAttribute('id', id);
    filter.setAttribute('x', '0'); filter.setAttribute('y', '0');
    filter.setAttribute('width', '100%'); filter.setAttribute('height', '100%');
    if (cm || cmo) {
      // GL mat4 is COLUMN-major (`out = M * c`, so M[col*4+row]); SVG wants
      // 4 rows of 5 (row-major, 5th column = the offset term).
      const m = cm || [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
      const o = cmo || [0, 0, 0, 0];
      const rows = [];
      for (let r = 0; r < 4; r++)
        rows.push(`${m[r]} ${m[4 + r]} ${m[8 + r]} ${m[12 + r]} ${o[r] || 0}`);
      const feM = ownerDoc.createElementNS(SVGNS, 'feColorMatrix');
      feM.setAttribute('type', 'matrix');
      feM.setAttribute('values', rows.join('  '));
      filter.appendChild(feM);
    }
    if (tint) {
      const fe = ownerDoc.createElementNS(SVGNS, 'feColorMatrix');
      fe.setAttribute('type', 'matrix');
      fe.setAttribute('values',
        `${tint[0]} 0 0 0 0  0 ${tint[1]} 0 0 0  0 0 ${tint[2]} 0 0  0 0 0 1 0`);
      filter.appendChild(fe);
    }
    layer.appendChild(filter);
    return `url(#${id})`;
  }

  // ── Scissor — real: clip the whole <svg> to a pixel rect via CSS
  // clip-path (viewport px, y-down, like the GL scissor). ───────────────
  let _scissor = null;
  function setScissorRect(x, y, w, h) {
    _scissor = [x | 0, y | 0, Math.max(0, w | 0), Math.max(0, h | 0)];
    applyScissor();
  }
  function clearScissorRect() { _scissor = null; applyScissor(); }
  function applyScissor() {
    if (!_scissor) { svg.style.clipPath = ''; return; }
    // CSS clip-path inset() is from the top-left in px; convert the
    // scissor rect (x,y,w,h) into inset(top right bottom left).
    const [x, y, w, h] = _scissor;
    const top = y, left = x, right = Math.max(0, vpW - (x + w)), bottom = Math.max(0, vpH - (y + h));
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
  const _extClips = new Map();   // bundleRecord.id -> clip descriptor
  let _extClipSeq = 0;
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
  function wmAffine(wm) { return wm ? [wm[0], wm[1], wm[3], wm[4], wm[6], wm[7]] : IDENT; }
  function invAffine(m) {
    const [a, b, c, d, e, f] = m;
    const det = a * d - b * c;
    if (!det) return null;
    const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
    return [ia, ib, ic, id, -(ia * e + ic * f), -(ib * e + id * f)];
  }
  function mulAffine(m1, m2) {
    const [a1, b1, c1, d1, e1, f1] = m1, [a2, b2, c2, d2, e2, f2] = m2;
    return [
      a1 * a2 + c1 * b2, b1 * a2 + d1 * b2,
      a1 * c2 + c1 * d2, b1 * c2 + d1 * d2,
      a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1,
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
      mask.setAttribute('x', '-100000'); mask.setAttribute('y', '-100000');
      mask.setAttribute('width', '200000'); mask.setAttribute('height', '200000');
      // The per-frame transform must live on an INNER group — `transform` on a
      // <mask> element is NOT honored (unlike <clipPath>), so it would leave
      // the mask in the bundle's moving local space. desc.xformEl is updated
      // each frame to inverse(worldMatrix).
      const xform = ownerDoc.createElementNS(SVGNS, 'g');
      const bg = ownerDoc.createElementNS(SVGNS, 'rect');
      // White over the whole (huge) region so content shows everywhere the
      // clip shapes don't cover — sized far beyond any viewport so a later
      // setViewport/resize never leaves a stale, too-small show-area.
      bg.setAttribute('x', '-100000'); bg.setAttribute('y', '-100000');
      bg.setAttribute('width', '200000'); bg.setAttribute('height', '200000');
      bg.setAttribute('fill', '#fff');
      xform.appendChild(bg);
      const grp = ownerDoc.createElementNS(SVGNS, 'g');
      grp.setAttribute('fill', '#000'); grp.setAttribute('stroke', 'none');
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
    for (const ch of Array.from(croot.childNodes))
      cp.appendChild(ownerDoc.importNode(ch, true));
    desc.xformEl = cp;
    return cp;
  }

  function ensureExtClipDef(desc) {
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
  function setNodeClip(target, clipOpts = {}) {
    const bundle = target && target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return;
    const rec = ensureBundleRecord(bundle, useNativeText);
    // Clip geometry: an explicit maskSvg string, or a clip BUNDLE whose
    // retained svgSource is used (so both backends share one signature —
    // setNodeClip(target, { clipBundle, worldMatrix, mode })).
    const clipSrc = clipOpts.clipBundle !== undefined ? clipOpts.clipBundle : clipOpts.bundle;
    const clipBundle = clipSrc && clipSrc.bundle !== undefined ? clipSrc.bundle : clipSrc;
    const markup = clipOpts.maskSvg || clipOpts.clip
      || (clipBundle && (clipBundle.svgSource || clipBundle.svgSourceNativeText)) || null;
    if (markup == null) { clearNodeClip(target); return; }
    const prev = _extClips.get(rec.id);
    if (prev && prev.defEl && prev.defEl.parentNode) prev.defEl.parentNode.removeChild(prev.defEl);
    _extClips.set(rec.id, {
      mode: clipOpts.mode === 'out' ? 'out' : 'in',
      markup,
      clipAffine: wmAffine(clipOpts.worldMatrix),
      defId: 'mantleExtClip_' + (_extClipSeq++),
      defEl: null,
    });
  }

  function clearNodeClip(target) {
    const bundle = target && target.bundle !== undefined ? target.bundle : target;
    if (!bundle) return;
    const rec = bundle[useNativeText ? '__nativeRecordText' : '__nativeRecord'];
    if (!rec) return;
    const c = _extClips.get(rec.id);
    if (c && c.defEl && c.defEl.parentNode) c.defEl.parentNode.removeChild(c.defEl);
    _extClips.delete(rec.id);
  }

  // ── createImage — return a token drawImage already accepts (the source
  // itself). No GPU upload; drawImage decodes lazily. Lets a renderer-
  // style `const img = createImage(src); drawImage(img)` flow work. ─────
  // A canvas token resolves `ready` once the canvas is encoded to a blob: URL.
  // Its <image>s then take that short href instead of a PNG data: URL, which
  // a slow device parses and decodes again for every new <image>.
  // `dispose()` revokes the blob URL.
  function createImage(source, _opts) {
    const token = { __nativeImage: true, source, width: source && source.width, height: source && source.height, href: null, ready: null, dispose: () => {} };
    const isCanvas = source && source.nodeType && source.tagName && source.tagName.toLowerCase() === 'canvas';
    if (isCanvas && typeof source.toBlob === 'function' && typeof URL !== 'undefined' && URL.createObjectURL) {
      let blobHref = null;
      let disposed = false;
      token.ready = new Promise((resolve) => {
        source.toBlob((blob) => {
          if (blob && !disposed) { blobHref = URL.createObjectURL(blob); token.href = blobHref; }
          resolve(token);
        }, 'image/png');
      });
      token.dispose = () => {
        disposed = true;
        if (blobHref) URL.revokeObjectURL(blobHref);
        blobHref = null;
      };
    } else {
      token.ready = Promise.resolve(token);
    }
    return token;
  }

  // ── createBundleHandle — the GL handle is a per-mount GPU cache. The
  // native path has no GPU cache; return a minimal handle that carries the
  // bundle so `handle.bundle` / drawBundle(handle) both work. ───────────
  function createBundleHandle(bundle, _opts) {
    return { bundle, isNativeHandle: true, dispose() {} };
  }

  // ── GPU-only optimizations: no-ops on native (the browser re-rasterizes
  // each frame; there's no render-target cache to enable/invalidate). ──
  function enableStaticCache() { return false; }
  function disableStaticCache() {}
  function invalidateRenderState() {}

  // ── Legacy single-bundle path. setBundle stashes; render draws it. ───
  let _bundle = null;
  function setBundle(bundle) { _bundle = bundle; }

  function endFrame() {
    frameOpen = false;
    // Every draw this frame (clear rect, bundles, rasters) acquired slots
    // 0.._slotCursor in call order. acquireSlot already mounted/replaced each
    // node in place, so the live DOM order matches draw order.
    // We only TRIM the tail: slots beyond the cursor were drawn last frame
    // but not this one, so unmount and drop them. Their override state goes
    // with the discarded slot object — the whole subtree is removed, so no
    // per-attr revert is needed (a recycled index gets a fresh slot).
    for (let i = _slots.length - 1; i >= _slotCursor; i--) {
      const s = _slots[i];
      if (s && s.node.parentNode === svg) svg.removeChild(s.node);
      // A trimmed bundle's <g> is gone, so its external-clip <defs> entry is now
      // orphaned. Detach + null the def (keep the _extClips descriptor so the
      // clip survives a later redraw — ensureExtClipDef rebuilds from it). This
      // is what frees the def for a permanently-removed clipped bundle.
      if (s && s.kind === 'bundle') {
        const c = _extClips.get(s.key);
        if (c && c.defEl) {
          if (c.defEl.parentNode) c.defEl.parentNode.removeChild(c.defEl);
          c.defEl = null; c.xformEl = null;
        }
      }
      _slots.pop();
    }
    dropUnclaimedImages();
  }

  function dispose() {
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    _slots.length = 0;
    _slotCursor = 0;
    _imagesByHref.clear();
    // Drop external-clip descriptors + the (now-removed) <defs> ref so a
    // disposed scene retains no DOM nodes or parsed clip markup.
    _extClips.clear();
    _defsEl = null;
    if (svg.parentNode && svg !== host) svg.parentNode.removeChild(svg);
  }

  // Single-bundle render: if a bundle is passed, draw it; else draw the
  // setBundle()-stashed one. Matches renderer.render()'s dual use.
  function render(bundleOrOpts, maybeOpts) {
    let bundle, drawOpts;
    if (bundleOrOpts && bundleOrOpts.numShapes !== undefined) {
      bundle = bundleOrOpts; drawOpts = maybeOpts || {};
    } else {
      bundle = _bundle; drawOpts = bundleOrOpts || {};
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
    const out = exportOpts.serialize
      ? exportOpts.serialize(svg)
      : (typeof globalThis !== 'undefined' && typeof globalThis.XMLSerializer === 'function'
          ? new globalThis.XMLSerializer().serializeToString(svg)
          : (svg && typeof svg.outerHTML === 'string' ? svg.outerHTML : ''));
    return exportOpts.detail ? { svg: out, drawn: -1, skipped: 0, notes: [] } : out;
  }

  return {
    get svg() { return svg; },
    get isNative() { return true; },
    // SVG export (backend-parity with the WebGL renderer). See above.
    exportFrameSVG,
    // Shared scene surface (works on both backends).
    setViewport,
    setCoordinateSpace,   // native-only: 'viewport' | 'bundle'
    get coordinateSpace() { return coordSpace; },
    beginFrame,
    drawBundle,
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
