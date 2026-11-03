// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// feImageExternalSmoke.mjs — an <feImage> with an EXTERNAL raster href (a data: URL, or a URL the
// browser can load) is loaded, and placed per Filter Effects 1 §15.14: fitted by preserveAspectRatio
// into the primitive subregion (x/y/width/height in primitiveUnits, the filter region's where unstated),
// and clipped to it.
//
// feImage resolved "#id" only; any other href left an untyped node with no inputs in the graph. Asserts:
//   (a) the importer preloads the href against the <feImage> and the graph node carries the atlas slot
//       and its placement (align, meet/slice/none, subregion, units); an href that cannot load (an SVG
//       one, here) is a transparent source node, not an untyped one;
//   (b) a filter entry records the referencing element's CTM, where a userSpaceOnUse subregion lives;
//   (c) the placement math (filterGraph/feImagePlace.js) for each unit system, fit and alignment;
//   (d) the renderer resolves it to canvas pixels for a shape, the way it resolves the filter region.
//
// No GPU: preloadImages' <img> + canvas decode is stubbed (a solid 20x10 raster), as
// imageMaskInheritanceSmoke does, and (d) runs the renderer's placement on the fake GL.
import { DOMParser as DP } from '@xmldom/xmldom';
globalThis.DOMParser = DP;
import { createFakeGl } from '../_fakeGl.mjs';

let failures = 0;
const fail = (msg) => {
  console.error('FAIL', msg);
  failures++;
};
const ok = (msg) => console.log('ok', msg);
const near = (a, b, tol = 1e-6) =>
  !!a &&
  !!b &&
  a.length === b.length &&
  a.every((v, i) => (v === null && b[i] === null) || Math.abs(v - b[i]) <= tol);
const fmt = (a) =>
  a ? '[' + a.map((v) => (v === null ? 'null' : +(+v).toFixed(3))).join(', ') + ']' : String(a);

const IW = 20,
  IH = 10;
globalThis.Image = class FakeImage {
  set src(_) {
    this.naturalWidth = IW;
    this.naturalHeight = IH;
    setTimeout(() => this.onload && this.onload(), 0);
  }
};
globalThis.document = {
  createElement(tag) {
    if (tag !== 'canvas') throw new Error('FakeDoc: only canvas');
    return {
      width: 0,
      height: 0,
      getContext() {
        return {
          drawImage() {},
          getImageData(_x, _y, w, h) {
            return { data: new Uint8ClampedArray(w * h * 4).fill(255) };
          },
        };
      },
    };
  },
};

const { importSvg, createBundle } = await import('../../src/index.js');
const { attachFilterDraw } = await import('../../src/renderer/filterDraw.js');
const place = await import('../../src/filterGraph/feImagePlace.js').catch(() => ({}));
const feImagePlacement = place.feImagePlacement || (() => undefined);

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const svg = (defs, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><defs>${defs}</defs>${body}</svg>`;
const feNodes = (b) =>
  (b.filterGraphs || [])
    .filter(Boolean)
    .flatMap((g) => g.nodes.filter((n) => n.type === 'feImage'));

// ---- (a) the graph node ----
{
  const b = await importSvg(
    svg(
      `<filter id="u" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="100">` +
        `<feImage href="${PNG}" x="10" y="20" width="30" height="40" preserveAspectRatio="xMaxYMin slice"/></filter>` +
        `<filter id="o" primitiveUnits="objectBoundingBox"><feImage href="${PNG}" x="0.5" width="50%" preserveAspectRatio="none"/></filter>` +
        `<filter id="s"><feImage href="data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E"/></filter>`,
      `<rect x="100" y="10" width="40" height="20" filter="url(#u)"/><rect x="100" y="40" width="40" height="20" filter="url(#o)"/>` +
        `<rect x="100" y="70" width="40" height="20" filter="url(#s)"/>`,
    ),
    {},
  );
  const [u, o, sv] = feNodes(b);
  const slots = (b.imageAtlasRects || []).length;
  if (
    u &&
    u.params.external === 1 &&
    u.params.imageId >= 1 &&
    u.params.imgW === IW &&
    u.params.imgH === IH &&
    near(u.params.align, [2, 0]) &&
    u.params.fit === 1 &&
    u.params.subUnits === 0 &&
    near(u.params.sub, [10, 20, 30, 40])
  )
    ok(
      `userSpaceOnUse feImage: slot ${u.params.imageId} of ${slots}, ${u.params.imgW}x${u.params.imgH}, align ${fmt(u.params.align)}, slice, sub ${fmt(u.params.sub)}`,
    );
  else fail(`userSpaceOnUse feImage node: ${JSON.stringify(u && u.params)}`);
  if (
    o &&
    o.params.external === 1 &&
    o.params.subUnits === 1 &&
    o.params.fit === 2 &&
    near(o.params.sub, [0.5, null, 0.5, null])
  )
    ok(
      `objectBoundingBox feImage: sub ${fmt(o.params.sub)} (unstated y/height fall back to the region), fit none`,
    );
  else fail(`objectBoundingBox feImage node: ${JSON.stringify(o && o.params)}`);
  if (sv && sv.params.imageId === 0 && Array.isArray(sv.inputs) && sv.inputs.length === 0)
    ok(
      'an feImage href that cannot load (SVG) is a transparent source node (imageId 0, no inputs)',
    );
  else fail(`unloadable feImage node: ${JSON.stringify(sv)}`);
}

// ---- (b) the referencing element's CTM ----
{
  const b = await importSvg(
    svg(
      `<filter id="u"><feImage href="${PNG}" x="1" y="2" width="3" height="4"/></filter>`,
      `<rect transform="translate(5 7) scale(2)" width="10" height="10" filter="url(#u)"/>` +
        `<rect x="50" width="10" height="10" filter="url(#u)"/>`,
    ),
    {},
  );
  const m = b.filterPrimCtms || [];
  if (
    m.some((c) => near(c, [2, 0, 0, 2, 5, 7])) &&
    m.some((c) => c === null) &&
    feNodes(b).length === 2
  )
    ok(`filterPrimCtms: ${m.map(fmt).join(', ')} (one entry per CTM)`);
  else fail(`filterPrimCtms: ${JSON.stringify(m)}, feImage nodes ${feNodes(b).length}`);
}

// ---- (c) the placement ----
{
  const P = (over) =>
    Object.assign(
      { imgW: 10, imgH: 10, sub: [null, null, null, null], subUnits: 0, align: [1, 1], fit: 0 },
      over,
    );
  const cases = [
    [
      'no subregion: the region, meet, centered',
      P({}),
      { regionEm: [0, 0, 100, 50], boxEm: [0, 0, 100, 50] },
      [0, 0, 100, 50],
      [25, 0, 75, 50],
    ],
    [
      'userSpaceOnUse subregion through the CTM',
      P({ sub: [10, 20, 30, 40] }),
      { regionEm: [0, 0, 200, 200], boxEm: [0, 0, 1, 1], ctm: [2, 0, 0, 2, 5, 7] },
      [25, 47, 85, 127],
      [25, 57, 85, 117],
    ],
    [
      'objectBoundingBox x/width, region y/height, none',
      P({ sub: [0.5, null, 0.5, null], subUnits: 1, fit: 2 }),
      { regionEm: [-10, -4, 110, 44], boxEm: [0, 0, 100, 40] },
      [50, -4, 100, 44],
      [50, -4, 100, 44],
    ],
    [
      'xMaxYMax slice overflows the subregion',
      P({ sub: [0, 0, 40, 20], align: [2, 2], fit: 1 }),
      { regionEm: [0, 0, 100, 100], boxEm: [0, 0, 1, 1] },
      [0, 0, 40, 20],
      [0, -20, 40, 20],
    ],
    [
      'xMinYMid meet of a wide image',
      P({ imgW: 20, sub: [0, 0, 10, 40], align: [0, 1] }),
      { regionEm: [0, 0, 100, 100], boxEm: [0, 0, 1, 1] },
      [0, 0, 10, 40],
      [0, 17.5, 10, 22.5],
    ],
  ];
  for (const [what, p, env, sub, img] of cases) {
    const r = feImagePlacement(p, env);
    if (r && near(r.sub, sub) && near(r.img, img))
      ok(`${what}: sub ${fmt(r.sub)}, image ${fmt(r.img)}`);
    else
      fail(
        `${what}: got ${r ? 'sub ' + fmt(r.sub) + ', image ' + fmt(r.img) : 'null'}; want sub ${fmt(sub)}, image ${fmt(img)}`,
      );
  }
  if (feImagePlacement(P({}), { regionEm: [0, 0, 0, 10], boxEm: [0, 0, 1, 1] }) === null)
    ok('an empty region places nothing');
  else fail('an empty region placed an image');
}

// ---- (d) the renderer's pixels for a shape ----
// filterDraw.js on a minimal renderer context (as unifiedFilterSubRectCacheSmoke builds one): the fake
// GL, the bundle as the current handle's, no world matrix, and the renderer's own aspect fit.
{
  const F = createFakeGl({ width: 200, height: 100 });
  const arScale = (bbox, vw, vh) => {
    const cAR = vw / vh,
      sAR = bbox[2] / bbox[3];
    return sAR > cAR ? [1, cAR / sAR] : [sAR / cAR, 1];
  };
  const R = {
    gl: F.gl,
    coverVao: null,
    arScale,
    viewportSize: () => [200, 100],
    bindFb: () => {},
    ensurePingFbo: () => {},
    blurProg: {},
    feImageProg: {},
    draw: { worldM: null, overrides: null },
    mantleDebugFlag: () => false,
    _filterBboxEnabled: true,
  };
  attachFilterDraw(R);
  if (R._filterSourceMaterial(0, 1) !== null)
    fail('missing filter dispatch must decline material normalization');
  else ok('missing filter dispatch declines material normalization');
  // preserveViewport: the draw maps the 200x100 viewBox 1:1 onto a 200x100 canvas.
  const sections = await importSvg(
    svg(
      `<filter id="u" filterUnits="userSpaceOnUse" x="0" y="0" width="200" height="100">` +
        `<feImage href="${PNG}" x="10" y="20" width="30" height="40"/></filter>`,
      `<rect x="100" y="10" width="40" height="20" filter="url(#u)"/>`,
    ),
    { preserveViewport: true },
  );
  const bundle = createBundle(F.gl, sections, { occlusionCull: false });
  const graph = bundle.filterGraphs.find(Boolean);
  const idx = graph.nodes.findIndex((n) => n.type === 'feImage');
  const shape = bundle.drawList.find((op) => op.kind === 'fillShape').shapeIdx;
  R._handle = { bundle };
  const pl = R._feImagePlacements ? R._feImagePlacements(graph, shape, 200, 100) : null;
  const p = pl && pl[idx];
  // The subregion x 10..40, y 20..60 (top-left px); GL y = 100 - 60 = 40. A 20x10 image met into
  // 30x40: 30x15, centered at y 32.5..47.5 -> GL y 52.5.
  const near1 = (a, b) => near(a, b, 1e-3);
  if (p && near1(p.sub, [10, 40, 30, 40]) && near1(p.img, [10, 52.5, 30, 15]))
    ok(`renderer: subregion ${fmt(p.sub)}, image ${fmt(p.img)} (GL px)`);
  else fail(`renderer placement: ${JSON.stringify(pl)}`);
}

if (failures) {
  console.error(`\nFEIMAGE-EXTERNAL FAIL (${failures})`);
  process.exit(1);
}
console.log('\nFEIMAGE-EXTERNAL PASS');
