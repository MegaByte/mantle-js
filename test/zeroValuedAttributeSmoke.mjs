// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// zeroValuedAttributeSmoke — a numeric attribute that is legitimately 0 stays 0.
//
// `x || default` reads a 0 as "absent". Where 0 is a real value it must not turn into the default:
//   (1) <g opacity="0"> -- a group opacity stored `groupOpacity || 1` would draw an invisible group
//       opaque;
//   (2) <image opacity="0"> -- an image's alpha taken as its FILL's (fill color x opacity x fill-opacity)
//       `|| 1` would draw opacity 0 opaque, let fill-opacity (which does not apply to an image) dim it,
//       and leave fill:none visible only through the `|| 1`. It is the element's opacity alone;
//   (3) a marker on a path with stroke-width="0" -- markerUnits="strokeWidth" scales a marker by the
//       stroke width, and `sw || 1` would draw the marker at stroke width 1. It scales to nothing
//       and emits no shapes;
//   (4) feDiffuseLighting / feSpecularLighting surfaceScale="0" (a flat surface), diffuseConstant="0"
//       and specularConstant="0" (no light) -- not uploaded as `|| 1`;
//   (5) a COLRv1 PaintSweepGradient ending at angle 0 -- `endAngle || 360` would sweep a full turn.
// Each check reads what the importer stored or what the handler uploaded.
// The other `|| n` defaults are on values that cannot be 0 or where 0 means "absent" (the
// convolve divisor is resolved to a nonzero value at import; stroke-miterlimit below 1 is invalid and
// takes the default 4; a zero feConvolveMatrix order is clamped to 1; option knobs and font metrics).
// Pixels against Chrome: test/zeroValuedAttributeRenderSmoke.mjs (render lane).
import { createFakeGl } from './_fakeGl.mjs';

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
// A raster <image> is decoded through Image + a 2D canvas, which node lacks: a stand-in that "decodes"
// any href to an opaque 4 x 4 bitmap is enough to reach the importer's image leaf.
globalThis.Image = class {
  set src(_v) {
    setTimeout(() => {
      this.naturalWidth = 4;
      this.naturalHeight = 4;
      this.onload && this.onload();
    }, 0);
  }
};
globalThis.document = {
  createElement: () => ({
    getContext: () => ({
      drawImage() {},
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
    }),
  }),
};
const { importSvg, createBundle } = await import('../src/index.js');
const { META_FILL_A, META_IMAGE_ID } = await import('../src/bundle/layout.js');
const svg = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><defs>${defs}</defs>${body}</svg>`;
const bundleOf = async (text) =>
  createBundle(
    createFakeGl({ width: 100, height: 100 }).gl,
    await importSvg(text, { preserveViewport: true }),
  );

// (1) group opacity
for (const op of ['0', '0.4']) {
  const b = await bundleOf(
    svg(
      `<g opacity="${op}"><rect width="40" height="40" fill="red"/><rect x="20" width="40" height="40" fill="blue"/></g>`,
    ),
  );
  const g = b.drawList.find((o) => o.kind === 'groupBegin');
  ok(
    g && g.opacity === Math.fround(+op),
    `(1) <g opacity="${op}"> stores opacity ${+op} (got ${g && g.opacity})`,
  );
}

// (2) image opacity: the element's opacity, and nothing of the fill
const IMG = 'data:image/png;base64,iVBORw0KGgo=';
for (const [attrs, want] of [
  ['opacity="0"', 0],
  ['opacity="0.5"', 0.5],
  ['fill-opacity="0"', 1],
  ['style="fill:none"', 1],
  ['opacity="0.5" fill-opacity="0.2"', 0.5],
]) {
  const b = await bundleOf(
    svg(`<image x="10" y="10" width="40" height="40" href="${IMG}" ${attrs}/>`),
  );
  const S = b.metaFloatsPerShape,
    M = b.metaFloats,
    n = M.length / S;
  let alpha = null;
  for (let s = 0; s < n; s++) if (M[s * S + META_IMAGE_ID] > 0) alpha = M[s * S + META_FILL_A];
  // An image at alpha 0 may be dropped as an invisible leaf (no row at all); the 0.5 case shows the
  // image path itself works.
  ok(
    want === 0 ? alpha === null || alpha === 0 : alpha !== null && Math.abs(alpha - want) < 1e-6,
    `(2) <image ${attrs}> draws at alpha ${want} (got ${alpha === null ? 'no image row: dropped as invisible' : alpha})`,
  );
}

// (3) markers at stroke-width 0
const MARKER =
  '<marker id="m" markerWidth="6" markerHeight="6" refX="3" refY="3"><circle cx="3" cy="3" r="3" fill="green"/></marker>';
{
  const { META_FILL_R, META_FILL_G, META_FILL_B } = await import('../src/bundle/layout.js');
  for (const [sw, want] of [
    ['0', 0],
    ['2', 1],
  ]) {
    const b = await bundleOf(
      svg(
        `<path d="M10 50 L90 50" fill="none" stroke="black" stroke-width="${sw}" marker-end="url(#m)"/>`,
        MARKER,
      ),
    );
    const S = b.metaFloatsPerShape,
      M = b.metaFloats;
    let green = 0; // the marker's rows: its circle is the only green paint
    for (let r = 0; r < M.length / S; r++) {
      if (
        M[r * S + META_FILL_R] === 0 &&
        Math.abs(M[r * S + META_FILL_G] - 128 / 255) < 1e-3 &&
        M[r * S + META_FILL_B] === 0
      )
        green++;
    }
    ok(
      green === want,
      `(3) a path at stroke-width ${sw} with marker-end: ${green} marker row(s) (want ${want})`,
    );
  }
}

// (4) lighting constants of 0, through the importer and the handler
{
  const { feLightingDispatch } = await import('../src/filterGraph/primitives/lighting.js');
  const upload = (params, type) => {
    const u = new Map();
    const gl = new Proxy(
      {},
      {
        get: (_t, k) =>
          typeof k === 'string' && k.startsWith('uniform')
            ? (l, ...v) => u.set(l, v.length === 1 ? v[0] : v)
            : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k)
              ? 0
              : () => {},
      },
    );
    feLightingDispatch(
      { type, params },
      [{ kind: 'rt', idx: 0 }],
      { fbo: {}, size: [16, 16] },
      {
        gl,
        pool: { get: () => ({ tex: {}, fbo: {}, size: [16, 16] }) },
        feLightingProg: {},
        feLightingU: new Proxy({}, { get: (_t, k) => k }),
        coverVao: {},
      },
    );
    return u;
  };
  const LIGHT = '<feDistantLight azimuth="45" elevation="30"/>';
  const defs =
    '<filter id="d"><feDiffuseLighting surfaceScale="0" diffuseConstant="0">' +
    LIGHT +
    '</feDiffuseLighting>' +
    '<feComposite in2="SourceGraphic" operator="in"/></filter>' +
    '<filter id="s"><feSpecularLighting surfaceScale="0" specularConstant="0" specularExponent="10">' +
    LIGHT +
    '</feSpecularLighting>' +
    '<feComposite in2="SourceGraphic" operator="in"/></filter>';
  const b = await bundleOf(
    svg(
      '<rect width="40" height="40" filter="url(#d)"/><rect x="50" width="40" height="40" filter="url(#s)"/>',
      defs,
    ),
  );
  const nodes = (b.filterGraphs || []).filter(Boolean).flatMap((g) => g.nodes);
  const dif = nodes.find((n) => n.type === 'feDiffuseLighting'),
    spec = nodes.find((n) => n.type === 'feSpecularLighting');
  ok(dif && spec, `(4) both lighting primitives import as graph nodes`);
  if (dif && spec) {
    const ud = upload(dif.params, 'feDiffuseLighting'),
      us = upload(spec.params, 'feSpecularLighting');
    ok(
      ud.get('uSurfaceScale') === 0 && ud.get('uK') === 0,
      `(4) feDiffuseLighting surfaceScale="0" diffuseConstant="0" uploads uSurfaceScale ${ud.get('uSurfaceScale')}, uK ${ud.get('uK')} (want 0, 0)`,
    );
    ok(
      us.get('uSurfaceScale') === 0 && us.get('uK') === 0,
      `(4) feSpecularLighting surfaceScale="0" specularConstant="0" uploads uSurfaceScale ${us.get('uSurfaceScale')}, uK ${us.get('uK')} (want 0, 0)`,
    );
  }
}

// (5) a COLRv1 sweep that ends at 0 degrees
{
  const { paintSweepGradient } = await import('../src/filterGraph/colr/paints.js');
  const u = new Map();
  const gl = new Proxy(
    {},
    {
      get: (_t, k) =>
        typeof k === 'string' && k.startsWith('uniform')
          ? (l, ...v) => u.set(l, v.length === 1 ? v[0] : v)
          : typeof k === 'string' && /^[A-Z_0-9]+$/.test(k)
            ? 0
            : () => {},
    },
  );
  const U = new Proxy({}, { get: (_t, k) => k });
  const node = {
    type: 'PaintSweepGradient',
    params: {
      center: [8, 8],
      startAngle: 180,
      endAngle: 0,
      extend: 0,
      stops: [
        { offset: 0, color: [1, 0, 0, 1] },
        { offset: 1, color: [0, 0, 1, 1] },
      ],
    },
  };
  paintSweepGradient(
    0,
    node,
    [],
    { fbo: {}, size: [16, 16] },
    {
      gl,
      paintSweepGradProg: {},
      paintSweepGradU: U,
      coverVao: {},
      bbox: [{ x: 0, y: 0, w: 16, h: 16 }],
    },
  );
  ok(
    u.get('uStartAngle') === 180 && u.get('uEndAngle') === 0,
    `(5) a sweep from 180 to 0 degrees uploads uStartAngle ${u.get('uStartAngle')}, uEndAngle ${u.get('uEndAngle')} (want 180, 0)`,
  );
}

console.log(fail ? `\nFAIL (${fail})` : '\nPASS');
process.exit(fail ? 1 : 0);
