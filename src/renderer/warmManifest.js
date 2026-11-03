// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// warmManifest.js -- record the draw states a session actually met, and replay exactly those at load.
//
// Warming every state a bundle COULD be drawn in (every candidate engine, a rotated map, a recolor) can build a couple of hundred programs
// and take a minute on a cold GPU cache, while a minute of play draws a few dozen of them at most. A manifest is the set of draw states that play reached, per bundle:
// recorded once by the game's dev pipeline (`createRenderer(gl, shaders, { recordWarmManifest: true })` ... `renderer.exportWarmManifest()`),
// bundled with the app and handed back at load (`createRenderer(..., { warmManifest })` or `precompileFillsAsync({ manifest })`).
//
// A bundle is named by a hash of its geometry and metadata, so a manifest cannot apply to content that changed: a bundle the manifest does
// not know (new, edited, streamed) simply gets the exhaustive warm. A state is the world map (the scale decides the engine; the rotation
// decides the footprint program), the recolor matrix, and whether the draw was instanced or carried an override table.
//
// The replay draws the bundle in that state under the warm's one-pixel scissor (fillPass _warmBundlePso), so every program family the
// draw reaches -- fill variants, point programs, mask bakes, instanced programs, filters -- is linked and built by the real draw path.

import { overridesAxisAligned, overridesRaiseStroke } from './shapeScale.js';

const FNV = 0x811c9dc5;
const MAX_STATES_PER_BUNDLE = 16;
const MANIFEST_FORMAT = 3;
const MANIFEST_MINOR = 2;

/** @param {import('./rendererContext.js').RendererContext} R */
export function attachWarmManifest(R) {
  const recording = R.opts && R.opts.recordWarmManifest === true;
  /** @type {Map<string, Map<string, object>>} */
  const rec = new Map();
  let index = null; // bundle key -> [state]
  let programList = []; // [{ t: 'bake'|'points'|'inst', a }] the non-fill programs the recorded session used
  const programSet = new Map();
  R._wmPrelinkers = R._wmPrelinkers || {};
  let variantList = []; // the fill variant keys the recorded session bound
  const seen = new Set(); // every bundle key the session loaded, drawn or not
  const variantKeys = new Set(); // every fill variant key the session bound for a draw
  const variantInfo = new Map(); // key -> { k, b: bundle key, w: world map, cm } of the first draw that bound it
  const variantClasses = new Map(); // key -> the viewport classes of every draw that bound it (any bundle, a moving one too)

  function words(a, h) {
    if (!a || !a.length) return Math.imul(h ^ 0x9e3779b9, 16777619) >>> 0;
    const u = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >> 2);
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619) >>> 0;
    return h;
  }
  /** A name for the bundle's content, stable across sessions; null for a bundle whose geometry moves (streamed, morphed, incremental). */
  function keyOf(b) {
    if (!b) return null;
    if (
      b._wmKey !== undefined &&
      b._wmGen === (b._geomGen | 0) &&
      b._wmMorph === (b._morphSrc || null)
    )
      return b._wmKey;
    let key = null;
    if (
      b._morphSrc &&
      b._morphSrc.mergedCurveF32 &&
      b._morphSrc.mergedCurveF32.length &&
      b._morphSrc.dstCurveF32 &&
      b._morphSrc.dstCurveF32.length &&
      !b._lbStream &&
      !b._incStroke
    ) {
      // A morph moves its own curve texture every frame: it is named by the two poses it blends.
      let h = Math.imul(FNV ^ 0x6d, 16777619) >>> 0;
      h = words(b._morphSrc.mergedCurveF32, h);
      h = words(b._morphSrc.dstCurveF32, h);
      key = 'm' + h.toString(16) + ':' + (b.numShapes | 0);
    } else if (!b._lbStream && !b._morphSrc && !b._incStroke && b.curveFloats) {
      // GEOMETRY only: the metadata (colors, opacities, transforms) is animated and re-uploaded in place; a name that included it would not
      // be the same twice.
      let h = FNV;
      h = words(b.curveFloats, h);
      h = Math.imul(h ^ (b.numShapes | 0), 16777619) >>> 0;
      key = h.toString(16) + ':' + (b.numShapes | 0);
    }
    b._wmKey = key;
    b._wmGen = b._geomGen | 0;
    b._wmMorph = b._morphSrc || null;
    return key;
  }
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  /** Rounds one part of a map (the linear part; the translation) to 1e-4 of its own magnitude below 1 and to 1e-4 above it: the digits that are kept follow the map, so a tiny map keeps its scale and rotation. */
  function roundMap(v) {
    let mag = 0;
    for (const x of v) mag = Math.max(mag, Math.abs(x));
    const q = mag > 0 && mag < 1 ? 1e4 / 10 ** Math.floor(Math.log10(mag)) : 1e4;
    return v.map((x) => Math.round(x * q) / q);
  }
  const isIdentityCm = (m, o) => {
    if (m)
      for (let i = 0; i < 16; i++)
        if (Math.abs(m[i] - ((i & 3) === i >> 2 ? 1 : 0)) > 1e-6) return false;
    if (o) for (let i = 0; i < 4; i++) if (Math.abs(o[i]) > 1e-6) return false;
    return true;
  };
  /** What an override table does to the program key: 0 none or harmless, 1 turns a row (the rotated footprint), 2 raises a stroke width (the stroke walk). */
  const ovr = (ov) => (!ov ? 0 : overridesRaiseStroke(ov) ? 2 : overridesAxisAligned(ov) ? 0 : 1);
  function sigOf(world, inst, rotAny) {
    const d = R.draw;
    const w = world
      ? [...roundMap([world[0], world[1], world[3], world[4]]), ...roundMap([world[6], world[7]])]
      : [1, 0, 0, 1, 0, 0];
    const rot =
      rotAny != null
        ? rotAny
        : Math.abs(w[1]) + Math.abs(w[2]) > 1e-4 * (Math.abs(w[0]) + Math.abs(w[3]));
    const det = Math.abs(w[0] * w[3] - w[1] * w[2]);
    const scale = Math.round(4 * Math.log2(Math.sqrt(det) || 1e-9));
    const hasCm = !isIdentityCm(d.colorMatrix, d.colorMatrixOffset);
    const cm = hasCm
      ? [
          Array.from(d.colorMatrix || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], r4),
          Array.from(d.colorMatrixOffset || [0, 0, 0, 0], r4),
        ]
      : null;
    return {
      coarse: [
        scale,
        rot ? 1 : 0,
        hasCm ? 1 : 0,
        inst ? 1 : 0,
        ovr(d.overrides),
        d.channelLerp ? 1 : 0,
        d.palette && d.palette.texture ? 1 : 0,
      ].join(','),
      sig: {
        w,
        cm,
        i: inst ? 1 : 0,
        ov: ovr(d.overrides),
        cl: d.channelLerp ? 1 : 0,
        pal: d.palette && d.palette.texture ? 1 : 0,
      },
    };
  }
  const scaleClasses = new Map(); // quarter-octave class of the viewport's linear size -> [w, h] first met (the live-resize classes of the session)
  const classOfVp = (w, h) =>
    Math.round(4 * Math.log2(Math.max(1, Math.sqrt(Math.max(1, w) * Math.max(1, h)))));
  function noteViewport() {
    try {
      const v = R.viewportSize && R.viewportSize();
      if (v && v[0] >= 1 && v[1] >= 1) {
        const c = classOfVp(v[0], v[1]);
        if (!scaleClasses.has(c) && scaleClasses.size < 64)
          scaleClasses.set(c, [v[0] | 0, v[1] | 0]);
      }
    } catch {
      /* no viewport yet */
    }
  }
  function note(bundle, world, inst, rotAny) {
    noteViewport();
    const key = keyOf(bundle);
    if (!key) return;
    let m = rec.get(key);
    if (!m) rec.set(key, (m = new Map()));
    const { coarse, sig } = sigOf(world, inst, rotAny);
    if (m.size < MAX_STATES_PER_BUNDLE && !m.has(coarse)) m.set(coarse, sig);
  }
  /** The plain draw, at its entry (renderer.js _renderCanvasInner). */
  R._wmNote = () => {
    if (recording && R._handle && R._handle.bundle && !R._psoWarming)
      note(R._handle.bundle, R.draw.worldM, false, null);
  };
  /** The instanced fast path, at its entry: the first instance's map, or the first rotated one when any instance is rotated. */
  R._wmNoteInst = (bundle, instances) => {
    if (!recording || R._psoWarming || !instances || !instances.length) return;
    let pick = instances[0] && instances[0].worldMatrix,
      rot = false;
    for (let i = 0; i < instances.length; i++) {
      const m = instances[i] && instances[i].worldMatrix;
      if (m && Math.abs(m[1]) + Math.abs(m[3]) > 1e-6 * (Math.abs(m[0]) + Math.abs(m[4]))) {
        pick = m;
        rot = true;
        break;
      }
    }
    note(bundle, pick || R.draw.worldM, true, rot);
  };
  /** A bundle the session loaded (called when it is first prewarmed). */
  R._wmSeen = (b) => {
    if (recording) {
      const k = keyOf(b);
      if (k) seen.add(k);
    }
  };
  /** A fill variant key the session bound (called from the fill pass). */
  R._wmVariant = (key) => {
    if (!recording || !key) return;
    variantKeys.add(key);
    try {
      const v = R.viewportSize && R.viewportSize();
      if (v && v[0] >= 1 && v[1] >= 1) {
        let cs = variantClasses.get(key);
        if (!cs) variantClasses.set(key, (cs = new Set()));
        cs.add(classOfVp(v[0], v[1]));
      }
    } catch {
      /* no viewport yet */
    }
    const bundle = R._handle && R._handle.bundle,
      bk = keyOf(bundle);
    if (!bk) return;
    const { coarse, sig } = sigOf(R.draw.worldM, false, null);
    const st = rec.get(bk) && rec.get(bk).get(coarse);
    if (st && !st.k) st.k = key; // the fill variant this state's draw bound first
    if (!variantInfo.has(key)) variantInfo.set(key, { k: key, b: bk, w: sig.w, cm: sig.cm }); // and the first draw that bound each variant
  };
  /** Every viewport class that bound this key, ascending (the warm queue's "needed at this resolution"); null for a key no draw bound (a warm-only pipeline: needed at any size). */
  const classesOf = (key) => {
    const cs = variantClasses.get(key);
    return cs && cs.size ? Array.from(cs).sort((a, b) => a - b) : null;
  };
  /** A non-fill program the session used (mask bake, point, instanced): kind and the arguments that start it. */
  R._wmProgram = (t, a) => {
    if (recording && !R._psoWarming) {
      const k = t + JSON.stringify(a);
      if (!programSet.has(k)) programSet.set(k, { t, a });
    }
  };
  R._wmPrelinkAll = () => {
    if (R.opts.fillTwins === false) return;
    for (const { t, a } of programList) {
      try {
        const f = R._wmPrelinkers[t];
        if (f) f(a);
      } catch {
        /* the draw starts it */
      }
    }
  };
  R.exportWarmManifest = () => {
    if (!recording)
      throw new Error(
        'exportWarmManifest: create the renderer with { recordWarmManifest: true } to record a session',
      );
    const entries = {};
    for (const [k, m] of rec) entries[k] = Array.from(m.values());
    // Every bundle the session had loaded, drawn or not: one that is listed with no states was never drawn, and the replay builds nothing for it.
    for (const k of seen) if (!(k in entries)) entries[k] = [];
    noteViewport();
    const keys = Object.keys(entries).sort();
    // VERSION 3 adds what a scene needs to be warmed WITHOUT its bundles: the pipelines (fill variant x vertex layout x target kind x instancing x blend x
    // color mask) the session built, the live-resize scale classes it met, and the fingerprints that say whether the manifest still describes this build.
    // minor 2 (additive): `vcs` on each variant and pipeline, every viewport class a draw bound the key at. It replaces minor 1's `vc`, the FIRST such class only, which read as "needed
    // at this class alone" and paused the programs a recording through two classes also bound at the second; the warm queue reads no class from a minor below 2 (needed at any size).
    return {
      version: 3,
      format: MANIFEST_FORMAT,
      minor: MANIFEST_MINOR,
      shaders: shaderHash(),
      bundleSet: hashStrings(keys),
      bundles: keys.length,
      entries,
      variants: Array.from(variantInfo.values(), (v) => {
        const vcs = classesOf(v.k);
        return vcs ? { ...v, vcs } : v;
      }),
      programs: Array.from(programSet.values()),
      pipelines: pipelinesV3(),
      scales: Array.from(scaleClasses.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([c, v]) => ({ c, w: v[0], h: v[1] })),
    };
  };
  let _shaderHash = null;
  /** A fingerprint of the fill program sources this renderer builds from: a manifest recorded against other sources names programs this build never makes. */
  function shaderHash() {
    if (_shaderHash) return _shaderHash;
    let h = FNV;
    const S = R.shaderSources || {};
    for (const k of ['fillVert', 'fillFrag']) {
      const t = S[k] || '';
      h = Math.imul(h ^ t.length, 16777619) >>> 0;
      for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619) >>> 0;
    }
    return (_shaderHash = h.toString(16));
  }
  R._wmShaderHash = shaderHash;
  function hashStrings(list) {
    let h = FNV;
    for (const t of list) {
      for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619) >>> 0;
      h = Math.imul(h ^ 0x2c, 16777619) >>> 0;
    }
    return h.toString(16);
  }
  /** The pipelines the gate saw this session build, for fill variant programs only (the other programs are rebuilt by the draws that use them). */
  function pipelinesV3() {
    const recs = R._gatePipeRecords ? R._gatePipeRecords() : [],
      out = [],
      seenSig = new Set();
    if (!R._wq) return out;
    const keyCache = new Map();
    for (const r of recs) {
      let k = keyCache.get(r.prog);
      if (k === undefined) {
        k = R._wq.keyOfProgram(r.prog);
        keyCache.set(r.prog, k);
      }
      if (k === null || !r.lay || !r.lay.length) continue;
      const e = { k, lay: r.lay, tex: !!r.tex, inst: !!r.inst, blend: r.blend, cmask: r.cmask };
      if (variantInfo.has(k)) {
        const vcs = classesOf(k);
        if (vcs) e.vcs = vcs;
      }
      const sig = JSON.stringify(e);
      if (seenSig.has(sig)) continue;
      seenSig.add(sig);
      out.push(e);
    }
    return out;
  }
  /** How a manifest relates to this build: 'ok' | 'unverified' (older format: bundle states only) | 'stale' (other shader sources or format: bundle states only) | 'invalid'. */
  R._wmCheck = (m) => {
    try {
      const o = typeof m === 'string' ? JSON.parse(m) : m;
      if (!o || typeof o !== 'object' || !o.entries || typeof o.entries !== 'object')
        return { status: 'invalid', manifest: null };
      if (o.version !== 1 && o.version !== 2 && o.version !== 3)
        return { status: 'invalid', manifest: null };
      if (o.version < 3) return { status: 'unverified', manifest: o };
      if (o.format !== MANIFEST_FORMAT || o.shaders !== shaderHash())
        return { status: 'stale', manifest: o };
      return { status: 'ok', manifest: o };
    } catch {
      return { status: 'invalid', manifest: null };
    }
  };
  /** Accept a manifest (an object from exportWarmManifest, or its JSON). Anything else is ignored: the exhaustive warm is the fallback. */
  R._wmUse = (m) => {
    try {
      const o = typeof m === 'string' ? JSON.parse(m) : m;
      if (
        !o ||
        (o.version !== 1 && o.version !== 2 && o.version !== 3) ||
        !o.entries ||
        typeof o.entries !== 'object'
      )
        return false;
      index = o.entries;
      variantList = Array.isArray(o.variants)
        ? o.variants.map((v) => (typeof v === 'string' ? { k: v } : v)).filter((v) => v && v.k)
        : [];
      programList = Array.isArray(o.programs) ? o.programs : [];
      if (R._wmPrelink) R._wmPrelink();
      if (R._wmPrelinkAll && R._ready_) R._wmPrelinkAll();
      return true;
    } catch {
      return false;
    }
  };
  /** The recorded states of this bundle, or null when the manifest does not know it. */
  R._wmStatesFor = (bundle) => {
    if (!index) return null;
    const key = keyOf(bundle);
    const list = key && index[key];
    return Array.isArray(list) ? list : null;
  };
  R._wmKeyOf = keyOf;
  R._wmVariantList = () => variantList; // [{ k, b?, w?, cm? }]
  R._wmCovers = (bundle) => !!R._wmStatesFor(bundle);
  if (R.opts && R.opts.warmManifest) R._wmUse(R.opts.warmManifest);
}

/** A manifest state as the warm's draw-state object (fillPass _warmState). */
export function warmStateOf(sig) {
  const [a, b, c, d, tx, ty] = sig.w;
  return {
    world: new Float32Array([a, b, 0, c, d, 0, tx, ty, 1]),
    cm: sig.cm ? new Float32Array(sig.cm[0]) : null,
    off: sig.cm ? new Float32Array(sig.cm[1]) : null,
    inst: !!sig.i,
    overrides: !!sig.ov,
    force: sig.k || null,
  };
}
