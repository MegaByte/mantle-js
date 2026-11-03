// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeSceneDomSmoke -- what the native (no-WebGL) scene writes into its DOM, in node under test/_domShim.mjs.
//
// Each case drives createNativeScene / createNativeMorph and asserts on the element tree the scene leaves behind (which
// element a morph writes to, its `d`, its paint attributes, which elements are reused or trimmed), never on pixels: the
// render lane's nativeFallbackSmoke rasterizes the scene in a real browser. The shim supports tag and `[id]` selectors
// only, so the cases find elements by walking the tree. Cases:
//   textMaskMorph        a matched-shape morph stays addressed beside expanded <text> glyphs and a <mask>
//   morphInterp          the morph interpolates geometry every frame, and an id-less morph reaches its shape
//   reconciler           the positional reconciler reuses, resets and trims its slots
//   openStrokePaintMorph an open contour stays open, and a fill-opacity fade tweens
//   morphAutoApply       drawBundle(morph.bundle) draws the tween without forwarding morph.overrides
//   maskGeometryMorph    an animated <mask>'s geometry interpolates through the morph
//   morphPerf            a morph frame writes each changed `d` once and nothing for an unchanged one, with no tree walk
import { readFileSync } from 'fs';
import { xmldom, doc } from './_domShim.mjs';
import { fontFixture, requireAsset } from './_assets.mjs';
import { emitFixture } from './_fixtures.mjs';

globalThis.DOMParser = xmldom.DOMParser;
globalThis.XMLSerializer = xmldom.XMLSerializer;
if (!globalThis.document) globalThis.document = doc;
const { importSvg, createNativeScene, createNativeMorph, createNativeOverrideTable } =
  await import('../src/index.js');
const { MantleFontAsset } = await import('../src/font/fontAsset.js');
const { buildSvgTextGlyphs } = await import('../src/font/textRun.js');

let failures = 0,
  current = '';
const ok = (m) => console.log(`ok [${current}] ${m}`);
const fail = (m) => {
  failures++;
  console.error(`FAIL [${current}] ${m}`);
};
const host = () => {
  const d = doc.createElement('div');
  doc.documentElement.appendChild(d);
  return d;
};
/** The first descendant (document order) whose authored id is `id`: the scene namespaces ids per clone and keeps the authored one on data-oid. */
const byOid = (root, id) =>
  root
    .querySelectorAll('*')
    .find((e) => e.getAttribute('id') === id || e.getAttribute('data-oid') === id) || null;
/** The root's own <g> children (`:scope > g`). */
const childGroups = (root) => root.children.filter((c) => (c.localName || c.tagName) === 'g');
/** Whether `el` has an ancestor named `name` below `root`. */
const under = (el, name, root) => {
  for (let n = el.parentNode; n && n !== root; n = n.parentNode)
    if ((n.localName || n.tagName || '').toLowerCase() === name) return true;
  return false;
};
/** Paths outside <mask>, <defs> and <clipPath>: the visible leaves. */
const visiblePaths = (svg) =>
  svg.querySelectorAll('path').filter((p) => {
    for (let n = p.parentNode; n && n !== svg; n = n.parentNode) {
      const t = n.tagName && n.tagName.toLowerCase();
      if (t === 'mask' || t === 'defs' || t === 'clippath') return false;
    }
    return true;
  });
const ID = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const fontBytes = readFileSync(requireAsset(fontFixture('roboto-regular.ttf')));

// A matched-shape morph stays correctly addressed when the bundle has expanded <text> glyphs AND a <mask>.
//
// Two poses: a box whose apex Y moves (2 → 20) plus masked text. The box is matched shape 0; the morph must write the box's
// lerped geometry to the BOX element, not to the mask's <path> in <defs> or to a glyph. Asserts the box element's apex Y lerps
// MONOTONICALLY 2 → 20 across the bracket, with a constant visible-element count and no slot accumulation.
async function textMaskMorph() {
  const pose = (apexY) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">
  <defs><mask id="m"><path d="M0 0 L120 0 L120 ${30 + apexY} L0 ${30 + apexY} Z" fill="#fff"/></mask></defs>
  <g mask="url(#m)">
    <path d="M60 ${apexY} L80 ${apexY + 18} L40 ${apexY + 18} Z" fill="#0000ff"/>
    <text x="20" y="50" font-family="Roboto" font-size="16" fill="#ff0000">Hi</text>
  </g>
</svg>`;
  const FONT = new MantleFontAsset(new Uint8Array(fontBytes));
  const o = {
    retainSource: true,
    keepInvisibleShapes: true,
    fonts: { Roboto: FONT },
    svgTextLayout: buildSvgTextGlyphs,
  };
  const a = await importSvg(pose(2), o);
  const b = await importSvg(pose(20), o);
  const scene = createNativeScene(host(), { coordinateSpace: 'bundle' });
  const morph = createNativeMorph(a, b);
  const frame = (t) => {
    morph.setT(t);
    scene.beginFrame([0, 0, 0, 0]);
    scene.drawBundle(morph.bundle, { worldMatrix: ID, overrides: morph.overrides });
    scene.endFrame();
  };
  const s = [];
  for (const t of [0, 0.25, 0.5, 0.75, 1.0]) {
    frame(t);
    const vp = visiblePaths(scene.svg);
    const box = vp[0] ? vp[0].getAttribute('d') : '';
    const m = box.match(/M\s*60\s+([\d.]+)/);
    s.push({ t, slots: scene.svg.children.length, nVis: vp.length, boxApexY: m ? +m[1] : null });
  }
  console.log('samples:', JSON.stringify(s));
  const ys = s.map((x) => x.boxApexY);
  if (s.every((x) => x.slots === 1)) ok('one slot (no accumulation)');
  else fail('slot count varied: ' + s.map((x) => x.slots));
  if (s.every((x) => x.nVis === s[0].nVis && x.nVis >= 3))
    ok(`visible-element count constant (${s[0].nVis})`);
  else fail('visible count varied: ' + s.map((x) => x.nVis));
  if (ys.every((y) => y != null)) ok('box element addressed at every t (apex Y present)');
  else fail('box apex Y missing at some t (addressing lost): ' + ys);
  // Monotonic increasing 2 → 20 (the box element gets the BOX morph, not the mask's frozen geometry or a glyph).
  const mono = ys.every((y, i) => i === 0 || y >= ys[i - 1] - 0.01);
  if (mono && ys[0] < 5 && ys[ys.length - 1] > 15)
    ok(
      `box apex Y lerps monotonically ${ys[0]}→${ys[ys.length - 1]} (matched-shape morph correct)`,
    );
  else fail('box apex Y not monotonic 2→20 (desync / triangle-backwards): ' + ys);
}

// The native morph truly interpolates geometry every frame, rather than snapping between keyframes. It sweeps t in fine
// steps and asserts the decoded path geometry advances in small monotonic increments -- only true if per-frame curve lerp
// is real.
async function morphInterp() {
  // poseA rect at x=20, poseB rect at x=220 -- a 200px slide. A real tween moves the left edge linearly; keyframe snapping
  // would jump.
  const SHEET =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100" width="300" height="100">' +
    '<g id="poseA"><rect id="ra" x="20" y="20" width="60" height="60" fill="#ff0000"/></g>' +
    '<g id="poseB"><rect id="rb" x="220" y="20" width="60" height="60" fill="#0000ff"/></g></svg>';
  const sheet = await importSvg(SHEET, { retainSource: true });
  const scene = createNativeScene(host());
  scene.setViewport(300, 100);
  const morph = createNativeMorph(sheet, sheet, { srcSprite: 'poseA', dstSprite: 'poseB' });
  // The morphing rect's left-edge x out of its decoded path d: the smallest x in "M x y L x y ..." (even indices).
  const leftEdgeX = (d) => {
    if (!d) return null;
    const nums = d.match(/-?\d+(?:\.\d+)?/g);
    if (!nums) return null;
    let minX = Infinity;
    for (let i = 0; i < nums.length; i += 2) minX = Math.min(minX, parseFloat(nums[i]));
    return isFinite(minX) ? minX : null;
  };
  const sweep = (steps) => {
    const xs = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      morph.setT(t);
      scene.beginFrame([1, 1, 1, 1]);
      scene.drawBundle(morph.bundle, { overrides: morph.overrides });
      scene.endFrame();
      const el = byOid(scene.svg, 'ra');
      const d = el ? el.getAttribute('d') : null;
      xs.push({ t, x: leftEdgeX(d), isPath: !!(el && el.tagName.toLowerCase() === 'path') });
    }
    return xs;
  };
  // Id-less morph: two single-<path> SVGs with no id attributes (real exported artwork). The morph's pathD must reach the
  // shape positionally (the importer gives it a synthetic shape_N_* id that doesn't exist in the markup), or the geometry
  // never moves.
  const IDLESS_A =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 50L20 50L20 60L10 60Z" fill="#3a3"/></svg>';
  const IDLESS_B =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M70 50L80 50L80 60L70 60Z" fill="#3a3"/></svg>';
  const idlessA = await importSvg(IDLESS_A, { retainSource: true });
  const idlessB = await importSvg(IDLESS_B, { retainSource: true });
  const idlessScene = createNativeScene(host());
  idlessScene.setViewport(100, 100);
  const idlessMorph = createNativeMorph(idlessA, idlessB);
  const idlessSweep = (steps) => {
    const xs = [];
    for (let s = 0; s <= steps; s++) {
      idlessMorph.setT(s / steps);
      idlessScene.beginFrame([1, 1, 1, 1]);
      idlessScene.drawBundle(idlessMorph.bundle, { overrides: idlessMorph.overrides });
      idlessScene.endFrame();
      const el = idlessScene.svg.querySelector('path');
      xs.push(leftEdgeX(el ? el.getAttribute('d') : null));
    }
    return xs;
  };

  const STEPS = 20;
  const xs = sweep(STEPS);
  // All frames must produce a real <path> with a parseable left edge.
  const bad = xs.filter((r) => r.x == null || !r.isPath);
  if (bad.length === 0)
    ok('all ' + (STEPS + 1) + ' sweep frames decoded a <path d> (geometry rewritten per frame)');
  else fail('frames without a decoded path: ' + JSON.stringify(bad.slice(0, 3)));
  // Endpoints: t=0 ≈ 20 (poseA), t=1 ≈ 220 (poseB).
  const x0 = xs[0].x,
    x1 = xs[xs.length - 1].x;
  if (Math.abs(x0 - 20) < 2) ok('t=0 left edge at poseA (' + x0 + ' ≈ 20)');
  else fail('t=0 not at poseA: ' + x0);
  if (Math.abs(x1 - 220) < 2) ok('t=1 left edge at poseB (' + x1 + ' ≈ 220)');
  else fail('t=1 not at poseB: ' + x1);
  // The KEY test: intermediate t values land at DISTINCT, monotonically increasing positions -- not collapsed onto 20 or
  // 220 (which is what "keyframe snapping" would produce). Check monotonic + small steps.
  let monotonic = true,
    maxStep = 0,
    distinct = new Set();
  for (let i = 1; i < xs.length; i++) {
    const dx = xs[i].x - xs[i - 1].x;
    if (dx < -0.5) monotonic = false;
    maxStep = Math.max(maxStep, Math.abs(dx));
    distinct.add(Math.round(xs[i].x));
  }
  const expectedStep = 200 / STEPS; // ~10px per step for a linear tween
  if (monotonic) ok('left edge advances monotonically poseA→poseB across the sweep');
  else fail('non-monotonic sweep (snapping?): ' + xs.map((r) => r.x).join(','));
  if (distinct.size >= STEPS - 2)
    ok(
      'sweep hits ' +
        distinct.size +
        ' DISTINCT positions over ' +
        STEPS +
        ' steps (true interpolation, not keyframes)',
    );
  else
    fail(
      'only ' +
        distinct.size +
        ' distinct positions — geometry is snapping to keyframes, not tweening: ' +
        [...distinct].sort((a, b) => a - b).join(','),
    );
  if (maxStep < expectedStep * 2.5)
    ok(
      'max per-step jump ' +
        maxStep.toFixed(1) +
        'px ≈ linear ' +
        expectedStep.toFixed(1) +
        'px (no keyframe jumps)',
    );
  else
    fail(
      'a step jumped ' +
        maxStep.toFixed(1) +
        'px (expected ~' +
        expectedStep.toFixed(1) +
        ') — keyframe snapping',
    );
  // Sample the midpoint explicitly: t=0.5 must be near x=120 (halfway), NOT at 20 or 220.
  const mid = xs[Math.round(STEPS / 2)];
  if (Math.abs(mid.x - 120) < 12)
    ok('t=0.5 left edge at the MIDPOINT (' + mid.x + ' ≈ 120), not snapped to a pose');
  else fail('t=0.5 not at midpoint: ' + mid.x + ' (snapped to a keyframe?)');
  // Id-less morph: the synthetic-id shape must still receive its tweened pathD via positional addressing, or every id-less
  // morph freezes on native.
  const idInfo = { ids: idlessA.shapeIds, matched: idlessMorph.plan.matched.length };
  const synthetic = (idInfo.ids || []).every((id) => /^shape_(?:L)?\d+_(fill|stroke)$/.test(id));
  if (synthetic)
    ok('id-less bundle has only synthetic shape ids (' + JSON.stringify(idInfo.ids) + ')');
  else fail('fixture not id-less: ' + JSON.stringify(idInfo.ids));
  if (idInfo.matched >= 1) ok('id-less morph matched ' + idInfo.matched + ' shape(s)');
  else fail('id-less morph matched nothing: ' + idInfo.matched);
  const il = idlessSweep(STEPS);
  const ilDistinct = new Set(il.map((x) => (x == null ? 'null' : Math.round(x)))).size;
  if (!il.includes(null) && ilDistinct >= STEPS - 2)
    ok(
      'ID-LESS morph geometry INTERPOLATES (' +
        ilDistinct +
        ' distinct x over ' +
        STEPS +
        ' steps, ' +
        il[0] +
        '→' +
        il[il.length - 1] +
        ')',
    );
  else
    fail('ID-LESS MORPH FROZEN — pathD not reaching the shape positionally: ' + JSON.stringify(il));
}

// The native fallback's POSITIONAL RECONCILER.
//
// The no-GPU path keeps persistent DOM "slots" mounted across frames and, per frame, only UPDATES what changed instead of
// tearing down and re-cloning the whole subtree. This pins the properties that make that safe and worthwhile:
//   1. REUSE -- the same bundle drawn in the same call-order position keeps the same <g> element (and its already-cloned
//      subtree) across frames. No per-frame deep clone, no remove-all/append-all.
//   2. RESET -- overrides/sprite-hiding mutate the reused subtree in place, so they MUST revert when dropped: a shape
//      recolored/hidden on frame N returns to its authored state on frame N+1 when the override is gone. Otherwise stale
//      mutations accumulate and animations corrupt.
//   3. TRIM -- drawing fewer bundles than last frame unmounts the tail.
async function reconciler() {
  // Two addressable shapes so we can override one and watch it revert.
  const PREFAB =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">' +
    '<rect id="bg" x="0" y="0" width="100" height="100" fill="#2ecc71"/>' +
    '<rect id="fg" x="25" y="25" width="50" height="50" fill="#e74c3c"/></svg>';
  const prefab = await importSvg(PREFAB, { retainSource: true });
  const scene = createNativeScene(host(), { coordinateSpace: 'viewport' });
  scene.setViewport(100, 100);
  const svg = scene.svg;
  const fgEl = () => byOid(svg, 'fg');
  const bundleGroups = () => childGroups(svg);

  // shapeIds the override table addresses by index: importSvg fills bundle.shapeIds, so the authored ids must be present.
  const ids = (prefab.shapeIds || []).slice();
  if (ids.includes('fg') && ids.includes('bg'))
    ok('bundle.shapeIds addresses #fg/#bg (' + JSON.stringify(ids) + ')');
  else fail('shapeIds missing fg/bg: ' + JSON.stringify(ids));

  // Frame 1: override #fg to blue. Frame 2: NO override. #fg must be blue after f1 and back to its authored red after f2
  // -- and it must be the SAME <g> and SAME #fg element both frames (reused, not recloned).
  const oc = (() => {
    const table = createNativeOverrideTable(prefab);
    table.set('fg', { fill: [0, 0, 1, 1] }); // blue
    scene.beginFrame([0, 0, 0, 0]);
    scene.drawBundle(prefab, { overrides: table });
    scene.endFrame();
    const g1 = bundleGroups()[0];
    const fg1 = fgEl();
    const fill1 = fg1 && fg1.getAttribute('fill');
    scene.beginFrame([0, 0, 0, 0]);
    scene.drawBundle(prefab, {}); // override dropped
    scene.endFrame();
    const g2 = bundleGroups()[0];
    const fg2 = fgEl();
    const fill2 = fg2 && fg2.getAttribute('fill');
    return {
      fill1,
      fill2,
      sameGroup: g1 === g2,
      sameFg: fg1 === fg2,
      groupCount2: bundleGroups().length,
    };
  })();
  const isBlue = (f) => f === 'rgba(0,0,255,1)' || f === 'rgb(0,0,255)' || f === '#0000ff';
  const isRed = (f) => /e74c3c/i.test(f) || f === 'rgb(231,76,60)';
  if (isBlue(oc.fill1)) ok('frame 1: #fg override applied (fill=' + oc.fill1 + ')');
  else fail('override not applied: ' + oc.fill1);
  if (isRed(oc.fill2))
    ok('frame 2: #fg reverts to AUTHORED red when override dropped (fill=' + oc.fill2 + ')');
  else fail('STALE OVERRIDE — #fg did not revert: ' + oc.fill2);
  if (oc.sameGroup) ok('bundle <g> is the SAME element across frames (reused, not recloned)');
  else fail('<g> was recloned — reuse broken');
  if (oc.sameFg) ok('#fg is the SAME element across frames (subtree reused)');
  else fail('#fg was recloned — subtree not reused');
  if (oc.groupCount2 === 1) ok('one bundle <g> mounted');
  else fail('group count: ' + oc.groupCount2);

  // Sprite-hide reset: draw a sprite range hiding #fg, then the full bundle. #fg is display:none after the ranged frame and
  // visible after the full one.
  const sh = (() => {
    const bgIdx = ids.indexOf('bg');
    const fgIdx = ids.indexOf('fg');
    if (bgIdx < 0 || fgIdx < 0) return { skipped: 'missing ids', ids };
    scene.beginFrame([0, 0, 0, 0]);
    scene.drawBundle(prefab, { shapeRange: [bgIdx, bgIdx] }); // hide #fg
    scene.endFrame();
    const hidden = fgEl() && fgEl().style.display;
    scene.beginFrame([0, 0, 0, 0]);
    scene.drawBundle(prefab, {}); // no range
    scene.endFrame();
    const shown = fgEl() && fgEl().style.display;
    return { hidden, shown };
  })();
  if (sh.skipped) fail('spriteHide: ' + sh.skipped);
  else {
    if (sh.hidden === 'none') ok('sprite range hides #fg (display:none)');
    else fail('#fg not hidden: ' + sh.hidden);
    if (sh.shown !== 'none')
      ok('#fg SHOWN again when range dropped (hide reverts: "' + sh.shown + '")');
    else fail('STALE HIDE — #fg stayed display:none: ' + sh.shown);
  }

  // Tail trim: a frame with 2 bundles, then a frame with 1, leaves exactly one bundle <g> mounted.
  scene.beginFrame([0, 0, 0, 0]);
  scene.drawBundle(prefab, {});
  scene.drawBundle(prefab, {});
  scene.endFrame();
  const two = bundleGroups().length;
  scene.beginFrame([0, 0, 0, 0]);
  scene.drawBundle(prefab, {});
  scene.endFrame();
  const one = bundleGroups().length;
  if (two === 2) ok('two bundles → two <g>');
  else fail('expected 2 groups, got ' + two);
  if (one === 1) ok('one bundle next frame → tail slot trimmed (one <g>)');
  else fail('tail not trimmed: ' + one);
}

// Two things the native (no-WebGL) morph must get right, as the WebGL path does:
//   1. OPEN CONTOURS STAY OPEN. A `Z` appended to every subpath would give a stroked open contour (a checkmark's tick, a
//      viewfinder bracket) a phantom edge back to its start -- the tick would render as a triangle. The header's freeEnd
//      bit says which contours are open.
//   2. PAINT TWEENS. Lerping curves only, while the GL path also lerps the morphable meta slots (fill RGBA, stroke RGBA,
//      stroke width), a fade -- identical geometry, fill-opacity 0.2 → 1 -- would snap from pose to pose instead of fading.
//      The rgba the morph writes REPLACES the resolved paint (whose alpha already folded in the authored fill-opacity), so
//      the scene must neutralise that attribute too or it multiplies in twice.
async function openStrokePaintMorph() {
  // An open stroked tick (3 points, 2 segments) that grows; plus a square whose fill fades in over identical geometry.
  const TICK_A =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<path d="M20 50L45 75L80 25" fill="none" stroke="#ffffff" stroke-width="10"/></svg>';
  const TICK_B =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<path d="M10 50L45 85L90 15" fill="none" stroke="#ffffff" stroke-width="10"/></svg>';
  const FADE_A =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<path d="M20 20L80 20L80 80L20 80Z" fill="#ff0000" fill-opacity="0.2"/></svg>';
  const FADE_B =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<path d="M20 20L80 20L80 80L20 80Z" fill="#ff0000" fill-opacity="1"/></svg>';
  const mount = async (a, b) => {
    const src = await importSvg(a, { retainSource: true });
    const dst = await importSvg(b, { retainSource: true });
    const scene = createNativeScene(doc.createElement('div'));
    scene.setViewport(100, 100);
    const morph = createNativeMorph(src, dst);
    return (t) => {
      morph.setT(t);
      scene.beginFrame([0, 0, 0, 1]);
      scene.drawBundle(morph.bundle, { overrides: morph.overrides });
      scene.endFrame();
      const el = scene.svg.querySelector('path');
      return el
        ? {
            d: el.getAttribute('d'),
            fill: el.getAttribute('fill'),
            fillOpacity: el.getAttribute('fill-opacity'),
            stroke: el.getAttribute('stroke'),
          }
        : null;
    };
  };
  const tickAt = await mount(TICK_A, TICK_B);
  const fadeAt = await mount(FADE_A, FADE_B);
  const TS = [0, 0.25, 0.5, 0.75, 1];
  const tick = TS.map((t) => tickAt(t));
  if (tick.every((r) => r && r.d)) ok('open-stroke morph decodes a path at every t');
  else fail('no path decoded: ' + JSON.stringify(tick));
  const closed = tick.filter((r) => r && /[Zz]/.test(r.d));
  if (closed.length === 0) ok('open contour stays OPEN at every t (no Z appended)');
  else
    fail(
      'open contour closed with Z — the tick renders as a triangle: ' +
        JSON.stringify(closed.map((r) => r.d)),
    );
  // Geometry still tweens (the paint tween must not freeze it).
  const firstX = tick.map((r) => parseFloat(r.d.match(/-?\d+(?:\.\d+)?/)[0]));
  if (firstX[0] > firstX[4] && new Set(firstX.map((x) => Math.round(x))).size >= 4)
    ok('open contour still interpolates (start x ' + firstX.join(' → ') + ')');
  else fail('open contour geometry not tweening: ' + firstX.join(','));
  const fade = TS.map((t) => fadeAt(t));
  const alpha = fade.map((r) => {
    const m = r && r.fill && r.fill.match(/rgba?\([^)]*?,\s*([\d.]+)\s*\)/);
    return m ? Number(m[1]) : null;
  });
  if (alpha.every((a) => a != null)) ok('paint morph writes an rgba fill at every t');
  else fail('no rgba fill written — paint is not tweening: ' + JSON.stringify(fade));
  if (alpha[0] != null && Math.abs(alpha[0] - 0.2) < 0.02 && alpha[4] > 0.98)
    ok('fade endpoints: ' + alpha[0].toFixed(2) + ' → ' + alpha[4].toFixed(2));
  else fail('fade endpoints wrong: ' + JSON.stringify(alpha));
  if (alpha[2] != null && Math.abs(alpha[2] - 0.6) < 0.05)
    ok('t=0.5 fill alpha at the MIDPOINT (' + alpha[2].toFixed(2) + '), not snapped to a pose');
  else fail('t=0.5 alpha ' + alpha[2] + ' — the fade snaps instead of tweening');
  // The authored fill-opacity is already inside that rgba: left in place it would multiply in again and the fade would top
  // out at the authored 0.2.
  const stacked = fade.filter((r) => r.fillOpacity != null && Number(r.fillOpacity) !== 1);
  if (stacked.length === 0)
    ok('authored fill-opacity neutralised — the rgba alpha is the whole fade');
  else
    fail(
      'fill-opacity still multiplying the override: ' +
        JSON.stringify(stacked.map((r) => r.fillOpacity)),
    );
}

// drawBundle(morph.bundle) draws the tween on native even when the caller does not forward morph.overrides.
//
// On GL a shape morph bakes interpolated geometry into the bundle's mesh, so `drawBundle(morph.bundle)` alone animates. On
// native the tween lives in a separate override table; a caller that forgets to forward it would render the static src pose
// and the animation would snap pose-to-pose at bracket edges. createNativeMorph stashes its table on the bundle and the scene
// auto-applies it when no explicit table is passed, restoring the "just draw the bundle" parity. This draws without passing
// overrides and asserts the box still lerps.
async function morphAutoApply() {
  const pose = (apexY) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">
  <defs><mask id="m"><rect x="0" y="0" width="120" height="60" fill="#fff"/></mask></defs>
  <g mask="url(#m)">
    <path d="M60 ${apexY} L80 ${apexY + 18} L40 ${apexY + 18} Z" fill="#0000ff"/>
    <text x="20" y="50" font-family="Roboto" font-size="16" fill="#ff0000">Hi</text>
  </g>
</svg>`;
  const FONT = new MantleFontAsset(new Uint8Array(fontBytes));
  const o = {
    retainSource: true,
    keepInvisibleShapes: true,
    fonts: { Roboto: FONT },
    svgTextLayout: buildSvgTextGlyphs,
  };
  const a = await importSvg(pose(2), o);
  const b = await importSvg(pose(20), o);
  const scene = createNativeScene(host(), { coordinateSpace: 'bundle' });
  const morph = createNativeMorph(a, b);
  // Draw without { overrides } -- the auto-apply path under test.
  const frame = (t) => {
    morph.setT(t);
    scene.beginFrame([0, 0, 0, 0]);
    scene.drawBundle(morph.bundle, { worldMatrix: ID });
    scene.endFrame();
  };
  const out = [];
  for (const t of [0, 0.25, 0.5, 0.75, 1.0]) {
    frame(t);
    const vp = visiblePaths(scene.svg);
    const d = vp[0] ? vp[0].getAttribute('d') : '';
    const m = d.match(/M\s*60\s+([\d.]+)/);
    out.push({ t, boxApexY: m ? +m[1] : null });
  }
  const ys = out.map((x) => x.boxApexY);
  console.log('box apex Y (no overrides passed):', JSON.stringify(ys));
  if (ys.every((y) => y != null)) ok('box element addressed at every t');
  else fail('box apex Y missing: ' + ys);
  const distinct = new Set(ys).size;
  if (distinct >= 4) ok('geometry changes per t — tween auto-applied (not snapping to src pose)');
  else fail('box apex Y barely changes — morph NOT auto-applied (snapping): ' + ys);
  const mono = ys.every((y, i) => i === 0 || y >= ys[i - 1] - 0.01);
  if (mono && ys[0] < 5 && ys[ys.length - 1] > 15)
    ok(`monotonic 2→20 without forwarding overrides (${ys[0]}→${ys[ys.length - 1]})`);
  else fail('not monotonic 2→20: ' + ys);
}

// An animated <mask>'s geometry interpolates through a native morph (the reveal-wipe path).
//
// A mask layer shape is excluded from the positional shapeElByIndex walk (it's not a rendered leaf), so a morph's per-frame
// interpolated mask `pathD` would otherwise have nowhere to land and the mask would freeze at the source pose while the
// shapes lerp smoothly. The importer exposes mask svgId→row range in bundle.clipperRows, and the native scene routes a
// layer-shape override to the <mask>'s child <path>. This morphs a mask whose reveal rect grows 12→52 and asserts the mask
// child's bottom edge lerps continuously (not stepped).
async function maskGeometryMorph() {
  // Two poses: a box revealed by a mask whose bottom edge moves 12 → 52.
  const pose = (maskBottom) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60">
  <defs><mask id="rev"><path d="M0 0 L100 0 L100 ${maskBottom} L0 ${maskBottom} Z" fill="#fff"/></mask></defs>
  <g mask="url(#rev)"><rect x="10" y="10" width="80" height="40" fill="#0000ff"/></g>
</svg>`;
  const o = { retainSource: true, keepInvisibleShapes: true };
  const a = await importSvg(pose(12), o);
  const b = await importSvg(pose(52), o);
  const scene = createNativeScene(host(), { coordinateSpace: 'bundle' });
  const morph = createNativeMorph(a, b);
  const maskBottom = () => {
    const mp = scene.svg.querySelectorAll('path').find((p) => under(p, 'mask', scene.svg));
    if (!mp) return null;
    const nums = [...(mp.getAttribute('d') || '').matchAll(/(-?\d+\.?\d*)/g)].map((m) => +m[1]);
    let maxY = -1e9;
    for (let i = 1; i < nums.length; i += 2) if (nums[i] > maxY) maxY = nums[i];
    return +maxY.toFixed(3);
  };
  const frame = (t) => {
    morph.setT(t);
    scene.beginFrame([0, 0, 0, 0]);
    scene.drawBundle(morph.bundle, { worldMatrix: ID, overrides: morph.overrides });
    scene.endFrame();
  };
  const out = [];
  for (const t of [0, 0.25, 0.5, 0.75, 1.0]) {
    frame(t);
    out.push({ t, maskBottom: maskBottom() });
  }
  const ys = out.map((x) => x.maskBottom);
  console.log('mask bottom edge across morph:', JSON.stringify(ys));
  if (ys.every((y) => y != null)) ok('mask child element addressed (geometry override landed)');
  else fail('mask child not addressed: ' + ys);
  if (new Set(ys).size >= 4) ok('mask geometry CHANGES per t — interpolates (not frozen/stepped)');
  else fail('mask geometry barely changes — frozen/snapping: ' + ys);
  const mono = ys.every((y, i) => i === 0 || y >= ys[i - 1] - 0.01);
  if (mono && ys[0] < 20 && ys[ys.length - 1] > 44)
    ok(
      `mask bottom lerps 12→52 monotonically (${ys[0]}→${ys[ys.length - 1]}) — smooth reveal wipe`,
    );
  else fail('mask bottom not monotonic 12→52: ' + ys);
}

// The morph hot-path cost of the native fallback reconciler. Morph re-applies a `d` (and friends) to the same shapes every
// frame; the reconciler must do that WITHOUT a per-shape querySelector tree-walk and WITHOUT redundant DOM writes, or frames
// drop. The element prototype is instrumented to COUNT setAttribute / removeAttribute calls on the cloned subtree and the
// scene <svg>'s querySelectorAll calls, then a multi-shape morph is driven for many frames, asserting:
//   • querySelectorAll runs O(1) total (id index built once), not per frame.
//   • a CHANGING morph costs ~1 setAttribute per shape per frame (the new `d`), not 2 (revert-then-set).
//   • a PAUSED morph (same `d` re-applied) costs ZERO writes (value diff).
// Under the shim a style write is a setAttribute('style') too, so it counts here where a CSSOM write in a browser would not.
async function morphPerf() {
  // A bundle whose shapes are <path>s with ids, so morph rewrites `d` directly (no primitive→path swap to muddy the
  // per-frame write count). N shapes.
  const N = 12;
  let shapes = '';
  for (let i = 0; i < N; i++) {
    const x = (i % 4) * 25,
      y = Math.floor(i / 4) * 25;
    shapes += `<path id="s${i}" d="M${x} ${y}h20v20h-20Z" fill="#3366cc"/>`;
  }
  const PREFAB = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">${shapes}</svg>`;
  emitFixture('nativeMorphPerf__PREFAB', PREFAB);
  const prefab = await importSvg(PREFAB, { retainSource: true });
  const scene = createNativeScene(host(), { coordinateSpace: 'viewport' });
  scene.setViewport(100, 100);
  // Instrument the prototype the reconciler mutates through. Calls are counted on ELEMENTS INSIDE the scene svg (the cloned
  // shape subtree) and querySelectorAll on the svg root. Counters are reset per measurement.
  const counts = { setAttr: 0, removeAttr: 0, qsa: 0 };
  const EP = Object.getPrototypeOf(doc.documentElement);
  const origSet = EP.setAttribute,
    origRemove = EP.removeAttribute,
    origQsa = EP.querySelectorAll;
  const inScene = (el) => {
    const s = scene.svg;
    return el !== s && s.contains(el);
  };
  EP.setAttribute = function (...a) {
    if (inScene(this)) counts.setAttr++;
    return origSet.apply(this, a);
  };
  EP.removeAttribute = function (...a) {
    if (inScene(this)) counts.removeAttr++;
    return origRemove.apply(this, a);
  };
  Object.defineProperty(EP, 'querySelectorAll', {
    configurable: true,
    value: function (...a) {
      if (this === scene.svg || inScene(this)) counts.qsa++;
      return origQsa.apply(this, a);
    },
  });
  const reset = () => {
    counts.setAttr = 0;
    counts.removeAttr = 0;
    counts.qsa = 0;
  };
  // A morph-like override table: every shape gets a fresh d each frame.
  const table = createNativeOverrideTable(prefab);
  const setFrame = (t) => {
    for (let i = 0; i < N; i++) {
      const x = (i % 4) * 25 + Math.round(t * 5),
        y = Math.floor(i / 4) * 25;
      table.set('s' + i, { pathD: 'M' + x + ' ' + y + 'h20v20h-20Z' });
    }
  };
  const drawOnce = (t) => {
    setFrame(t);
    scene.beginFrame([0, 0, 0, 0]);
    scene.drawBundle(prefab, { overrides: table });
    scene.endFrame();
  };
  let cm, pm;
  try {
    // Warm up (frame 1 clones + indexes; the steady state is measured).
    drawOnce(0);
    drawOnce(0.1);
    // 10 frames, each with a DIFFERENT d per shape.
    reset();
    const FRAMES = 10;
    for (let f = 0; f < FRAMES; f++) drawOnce(0.2 + f * 0.07);
    cm = { ...counts, frames: FRAMES, shapes: N };
    // Re-apply the SAME d 10 frames running: should be ~zero shape writes.
    drawOnce(0.5); // establish the value
    reset();
    for (let f = 0; f < 10; f++) drawOnce(0.5);
    pm = { ...counts, frames: 10, shapes: N };
  } finally {
    EP.setAttribute = origSet;
    EP.removeAttribute = origRemove;
    Object.defineProperty(EP, 'querySelectorAll', { configurable: true, value: origQsa });
  }
  // querySelectorAll must NOT scale with frames: the index is built once (during warmup), so steady-state frames do zero
  // subtree walks.
  if (cm.qsa === 0)
    ok('changing morph: ZERO querySelectorAll over ' + cm.frames + ' frames (id index reused)');
  else
    fail(
      'querySelectorAll ran ' + cm.qsa + 'x in steady state — per-frame tree-walk not eliminated',
    );
  // ~1 write per shape per frame (the new d). Allow a little slack but it must be well under the 2x that revert-then-set
  // would cost.
  const perFrame = cm.setAttr / cm.frames;
  if (perFrame <= cm.shapes * 1.2)
    ok(
      'changing morph: ' +
        cm.setAttr +
        ' writes / ' +
        cm.frames +
        ' frames = ' +
        perFrame.toFixed(1) +
        '/frame (~1 per ' +
        cm.shapes +
        ' shapes, no revert-then-set)',
    );
  else
    fail(
      'too many writes: ' +
        perFrame.toFixed(1) +
        '/frame for ' +
        cm.shapes +
        ' shapes (revert-then-set not eliminated?)',
    );
  if (cm.removeAttr === 0) ok('changing morph: zero removeAttribute churn');
  else fail('unexpected removeAttribute: ' + cm.removeAttr);
  if (pm.setAttr === 0 && pm.removeAttr === 0)
    ok('paused morph: ZERO DOM writes over ' + pm.frames + ' identical frames (value diff)');
  else
    fail(
      'paused morph wrote to DOM: setAttr=' +
        pm.setAttr +
        ' removeAttr=' +
        pm.removeAttr +
        ' (unchanged d should be a no-op)',
    );
}

for (const [name, fn] of [
  ['textMaskMorph', textMaskMorph],
  ['morphInterp', morphInterp],
  ['reconciler', reconciler],
  ['openStrokePaintMorph', openStrokePaintMorph],
  ['morphAutoApply', morphAutoApply],
  ['maskGeometryMorph', maskGeometryMorph],
  ['morphPerf', morphPerf],
]) {
  current = name;
  try {
    await fn();
  } catch (e) {
    fail('threw: ' + String((e && e.stack) || e));
  }
}
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nnativeSceneDomSmoke: all checks passed');
process.exit(0);
