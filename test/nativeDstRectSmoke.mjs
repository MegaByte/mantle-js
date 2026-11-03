// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeDstRectSmoke.mjs: drawBundle({ dstRect, fit, clipToRect }) on the NATIVE (no-WebGL) scene places the content where the WebGL
// renderer does (node, CPU only).
//
// The WebGL draw fits the bundle's inked CONTENT bbox (globalBBox) into the rect (dstRect.js). The native scene draws the source
// markup through its root <svg>, which maps the user space to pixels by the first bundle's viewBox and preserveAspectRatio (V);
// the scene turns the rect into the group's worldMatrix, inverse(V) * T, so that V * worldMatrix = T = the em -> pixel affine
// the WebGL path performs. This test reads the scene's DOM back (the group's transform, the root viewBox, the clipPath) and
// compares, for several rects, aspect ratios, fits and viewBox paddings:
//   1. the bbox corners' pixels to dstRect.js's own bundleDrawMatrix (the matrix the GL draw uses; hit-test parity), and
//   2. to an independent restatement of the fit (meet / slice / none, nine alignments) written out below,
// in both coordinate spaces, with and without a worldMatrix, plus the clip box and the refusals.
import { M, wrap, imp, dom, els, check, finish } from './_exportHarness.mjs';
import { bundleDrawMatrix } from '../src/geom/dstRect.js';
import { parseTransform, matMul } from '../src/svg/transform.js';

const warns = [];
M.setDiagnostics({ onWarn: (m) => warns.push(String(m)) });
const art = (vb, rect) =>
  wrap(
    `<rect x="${rect[0]}" y="${rect[1]}" width="${rect[2]}" height="${rect[3]}" fill="#c00"/><circle cx="${rect[0] + 5}" cy="${rect[1] + 5}" r="5" fill="#00c"/>`,
    `viewBox="${vb}"`,
  );

// ---- the oracle ----------------------------------------------------------------------------------------------------------------
/** Where the content bbox should land: an independent statement of preserveAspectRatio (SVG 2 8.2) fitting bb into rect. */
function fitted(bb, rect, par) {
  const [a, mode] = par.split(/\s+/);
  const [x, y, w, h] = rect;
  if (a === 'none') return [x, y, w, h];
  let s = Math.min(w / bb[2], h / bb[3]);
  if (mode === 'slice') s = Math.max(w / bb[2], h / bb[3]);
  const fx = /xMin/.test(a) ? 0 : /xMax/.test(a) ? 1 : 0.5,
    fy = /YMin/.test(a) ? 0 : /YMax/.test(a) ? 1 : 0.5;
  const tw = bb[2] * s,
    th = bb[3] * s;
  return [x + (w - tw) * fx, y + (h - th) * fy, tw, th];
}
/** The root <svg>'s user space -> pixels (viewBox + preserveAspectRatio meet, as the browser does it). */
function rootFit(svg, W, H) {
  const vb = svg.getAttribute('viewBox').split(/\s+/).map(Number),
    par = svg.getAttribute('preserveAspectRatio') || 'xMidYMid meet';
  if (par === 'none')
    return [W / vb[2], 0, 0, H / vb[3], (-vb[0] * W) / vb[2], (-vb[1] * H) / vb[3]];
  const s = Math.min(W / vb[2], H / vb[3]);
  return [s, 0, 0, s, (W - vb[2] * s) / 2 - vb[0] * s, (H - vb[3] * s) / 2 - vb[1] * s];
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const invert = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
};
const groupOf = (scene) =>
  Array.from(scene.svg.childNodes)
    .filter((n) => n.nodeType === 1 && n.localName === 'g')
    .pop();
/** The em -> pixel affine the scene actually draws with: root fit * the group's transform. */
function drawnAffine(scene, W, H, space) {
  const g = groupOf(scene),
    t = g.getAttribute('transform');
  const own = t ? parseTransform(t) : [1, 0, 0, 1, 0, 0];
  return {
    m: matMul(space === 'viewport' ? [1, 0, 0, 1, 0, 0] : rootFit(scene.svg, W, H), own),
    g,
  };
}
const mapBox = (m, bb) =>
  [
    [bb[0], bb[1]],
    [bb[0] + bb[2], bb[1] + bb[3]],
  ].map(([x, y]) => apply(m, x, y));
const maxDiff = (A, B) =>
  Math.max(...A.flatMap((p, i) => [Math.abs(p[0] - B[i][0]), Math.abs(p[1] - B[i][1])]));
// ---- the WebGL side: dstRect.js's own matrix on a fake renderer ----------------------------------------------------------------
const arScale = (bb, vw, vh) => {
  const cAR = vw / vh,
    sAR = bb[2] / bb[3];
  let sx = 1,
    sy = 1;
  if (sAR > cAR) sy = cAR / sAR;
  else sx = sAR / cAR;
  return [sx, sy];
};
const glAffine = (bundle, W, H, opts) => {
  const R = { viewportSize: () => [W, H], arScale, mantleWarn: () => {}, _scissor: null };
  const m = bundleDrawMatrix(R, bundle, opts); // column-major mat3, em -> px
  return [m[0], m[1], m[3], m[4], m[6], m[7]];
};

const FITS = [
  'xMidYMid meet',
  'xMinYMin meet',
  'xMaxYMax meet',
  'xMinYMax slice',
  'xMidYMid slice',
  'xMaxYMin slice',
  'none',
];
// viewBox padding on purpose: the native default fits the viewBox, the rect fits the content
const BUNDLES = [
  ['padded wide', '0 0 200 100', [30, 20, 60, 40]],
  ['offset viewBox', '-20 -10 100 150', [10, 0, 30, 90]],
];
const VIEWPORTS = [
  [400, 300],
  [300, 400],
  [64, 64],
];
const RECTS = [
  [0, 0, 400, 300],
  [40, 30, 200, 100],
  [10.5, 20.25, 90, 180],
  [100, 100, 1, 1],
  [-50, -20, 120, 60],
];

let cases = 0;
for (const space of ['bundle', 'viewport']) {
  for (const [bname, vb, rect] of BUNDLES) {
    const bundle = await imp(art(vb, rect));
    const bb = bundle.globalBBox;
    for (const [W, H] of VIEWPORTS) {
      for (const fit of FITS) {
        for (const dst of RECTS) {
          const scene = M.createNativeScene(dom.createElement('div'), {
            document: dom,
            coordinateSpace: space,
          });
          scene.setViewport(W, H);
          scene.beginFrame([0, 0, 0, 0]);
          scene.drawBundle(bundle, { dstRect: dst, fit });
          scene.endFrame();
          const { m } = drawnAffine(scene, W, H, space);
          const got = mapBox(m, bb),
            gl = mapBox(glAffine(bundle, W, H, { dstRect: dst, fit }), bb);
          const f = fitted(bb, dst, fit),
            want = [
              [f[0], f[1]],
              [f[0] + f[2], f[1] + f[3]],
            ];
          const dGl = maxDiff(got, gl),
            dWant = maxDiff(got, want),
            tol = 1e-6 * Math.max(1, W, H, Math.abs(dst[0]) + dst[2]);
          cases++;
          if (!(dGl < tol && dWant < tol)) {
            check(
              `${space} ${bname} ${W}x${H} fit ${fit} rect ${dst}: bbox lands on WebGL's pixels and on the fitted rect`,
              false,
              `vs GL ${dGl}, vs oracle ${dWant}: got ${JSON.stringify(got)} gl ${JSON.stringify(gl)} want ${JSON.stringify(want)}`,
            );
          }
          scene.dispose();
        }
      }
    }
  }
}
check(
  `${cases} placements (2 spaces x ${BUNDLES.length} bundles x ${VIEWPORTS.length} viewports x ${FITS.length} fits x ${RECTS.length} rects) match WebGL's bundleDrawMatrix and the independent fit`,
  true,
);

// ---- the clip box ---------------------------------------------------------------------------------------------------------------
{
  const bundle = await imp(art('0 0 200 100', [30, 20, 60, 40]));
  for (const space of ['bundle', 'viewport']) {
    const scene = M.createNativeScene(dom.createElement('div'), {
      document: dom,
      coordinateSpace: space,
    });
    scene.setViewport(400, 300);
    const wm = new Float32Array([1, 0, 0, 0, 1, 0, 7, -3, 1]); // a worldMatrix given with the rect acts first, in em space
    scene.beginFrame([0, 0, 0, 0]);
    scene.drawBundle(bundle, {
      dstRect: [40.4, 30.5, 200, 100.6],
      fit: 'xMinYMin slice',
      worldMatrix: wm,
    });
    scene.endFrame();
    const { m, g } = drawnAffine(scene, 400, 300, space);
    const url = /url\(#(.*)\)/.exec(g.getAttribute('clip-path') || '');
    const clip = url && els(scene.svg, 'clipPath').find((c) => c.getAttribute('id') === url[1]);
    check(`${space}: a rect draw is clipped by a clipPath on its group`, !!clip);
    if (clip) {
      const r = els(clip, 'rect')[0],
        t = r.getAttribute('transform');
      // the clip rect, carried through the group's transform to pixels, is the rect rounded to whole pixels (the GL scissor's rounding)
      const back = t ? parseTransform(t) : [1, 0, 0, 1, 0, 0];
      const x = +r.getAttribute('x'),
        y = +r.getAttribute('y'),
        w = +r.getAttribute('width'),
        h = +r.getAttribute('height');
      const px = [
        [x, y],
        [x + w, y + h],
      ].map(([a, b]) => apply(m, ...apply(back, a, b)));
      check(
        `${space}: the clip box is the rect rounded to whole pixels`,
        maxDiff(px, [
          [40, 31],
          [240, 131],
        ]) < 1e-6,
        JSON.stringify(px),
      );
      check(
        `${space}: the clip is a pixel box [40,31]-[240,131] before the group's transform`,
        [x, y, w, h].join() === '40,31,200,100',
        [x, y, w, h].join(),
      );
    }
    // the worldMatrix acted first: moving the em by (7, -3) moves the bbox by (7, -3) scaled by the placement
    const { m: m0 } = (() => {
      const s2 = M.createNativeScene(dom.createElement('div'), {
        document: dom,
        coordinateSpace: space,
      });
      s2.setViewport(400, 300);
      s2.beginFrame([0, 0, 0, 0]);
      s2.drawBundle(bundle, { dstRect: [40.4, 30.5, 200, 100.6], fit: 'xMinYMin slice' });
      s2.endFrame();
      return drawnAffine(s2, 400, 300, space);
    })();
    const a = apply(m, 0, 0),
      b = apply(m0, 7, -3);
    check(
      `${space}: a worldMatrix given with the rect acts first, in em space (rect * yours)`,
      Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6,
      `${a} vs ${b}`,
    );
    scene.dispose();

    const off = M.createNativeScene(dom.createElement('div'), {
      document: dom,
      coordinateSpace: space,
    });
    off.setViewport(400, 300);
    off.beginFrame([0, 0, 0, 0]);
    off.drawBundle(bundle, { dstRect: [40, 30, 200, 100], clipToRect: false });
    off.endFrame();
    check(
      `${space}: clipToRect:false places without clipping`,
      !groupOf(off).getAttribute('clip-path'),
    );
    // the rect goes away on the next frame: the group returns to its authored state (no stale transform, no stale clip)
    off.beginFrame([0, 0, 0, 0]);
    off.drawBundle(bundle, { dstRect: [40, 30, 200, 100] });
    off.endFrame();
    off.beginFrame([0, 0, 0, 0]);
    off.drawBundle(bundle, {});
    off.endFrame();
    check(
      `${space}: dropping the rect restores the draw (no transform, no clip)`,
      !groupOf(off).getAttribute('transform') && !groupOf(off).getAttribute('clip-path'),
      groupOf(off).getAttribute('transform') + ' ' + groupOf(off).getAttribute('clip-path'),
    );
    off.dispose();
  }
}

// ---- refusals: warned once per cause, the draw proceeds as if there were no rect ------------------------------------------------
{
  const bundle = await imp(art('0 0 200 100', [30, 20, 60, 40]));
  const drawn = (setup, opts) => {
    warns.length = 0;
    const s = M.createNativeScene(dom.createElement('div'), { document: dom });
    setup(s);
    for (let i = 0; i < 3; i++) {
      s.beginFrame([0, 0, 0, 0]);
      s.drawBundle(bundle, opts);
      s.endFrame();
    }
    const g = groupOf(s);
    const out = {
      transform: g.getAttribute('transform'),
      clip: g.getAttribute('clip-path'),
      warns: warns.slice(),
    };
    s.dispose();
    return out;
  };
  for (const [name, setup, opts, re] of [
    ['no setViewport', () => {}, { dstRect: [0, 0, 10, 10] }, /setViewport/],
    [
      'a zero-width rect',
      (s) => s.setViewport(100, 100),
      { dstRect: [0, 0, 0, 10] },
      /w > 0 and h > 0/,
    ],
    ['a non-array rect', (s) => s.setViewport(100, 100), { dstRect: 5 }, /w > 0 and h > 0/],
    ['a NaN rect', (s) => s.setViewport(100, 100), { dstRect: [0, 0, NaN, 10] }, /w > 0 and h > 0/],
  ]) {
    const r = drawn(setup, opts);
    check(
      `${name}: ignored (no transform, no clip) and warned once`,
      !r.transform && !r.clip && r.warns.length === 1 && re.test(r.warns[0]),
      JSON.stringify(r),
    );
  }
  {
    const r = drawn((s) => s.setViewport(100, 100), { dstRect: [0, 0, 50, 50], fit: 'sideways' });
    const ref = drawn((s) => s.setViewport(100, 100), { dstRect: [0, 0, 50, 50] });
    check(
      'a bad fit falls back to xMidYMid meet, warned once',
      r.transform === ref.transform &&
        r.warns.length === 1 &&
        /preserveAspectRatio/.test(r.warns[0]),
      JSON.stringify(r),
    );
  }
  {
    warns.length = 0;
    const s = M.createNativeScene(dom.createElement('div'), { document: dom });
    s.setViewport(100, 100);
    s.beginFrame([0, 0, 0, 0]);
    s.drawBundleInstanced(
      bundle,
      [
        { worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]) },
        { worldMatrix: new Float32Array([1, 0, 0, 0, 1, 0, 5, 5, 1]) },
      ],
      { dstRect: [0, 0, 50, 50] },
    );
    s.endFrame();
    const g = Array.from(s.svg.childNodes).filter((n) => n.nodeType === 1 && n.localName === 'g');
    check(
      'drawBundleInstanced refuses a shared dstRect, as WebGL does (warned, instances unplaced)',
      warns.length === 1 &&
        /drawBundleInstanced/.test(warns[0]) &&
        g.every((n) => !n.getAttribute('clip-path')),
      JSON.stringify(warns),
    );
    s.dispose();
  }
}
finish('nativeDstRectSmoke');
