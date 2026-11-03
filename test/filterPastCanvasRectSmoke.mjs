// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterPastCanvasRectSmoke -- a filter's targets stop at what can reach the canvas, however far past it the shape runs.
//
// A pointwise filter gets no filter frame (nothing to pull in from past the edge), and outside a frame a node's rect running to the shape's far edge would be 4224 px at zoom 4, 141 MiB of targets
// for one shape, and 65664 px at zoom 64, past any device's limit (INVALID_VALUE: no target at all). A target needs only the canvas plus the reach of what reads it. CPU, recording GL stand-in: this says
// what is allocated; filterPastCanvasRenderSmoke compares the pixels.
globalThis.__MANTLE_DEBUG__ = true;
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
console.warn = () => {};
const { createFakeGl, taggedShaderSources } = await import('./_fakeGl.mjs');
const { createRenderer, createBundle, importSvg } = await import('../src/index.js');
const { graphSeenMargins } = await import('../src/renderer/filterFrame.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const SZ = 1024,
  LIMIT = 16384;
const doc = (flt) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs>${flt}</defs><path d="M0 0 L100 0 L100 100 L0 90 Z" fill="#d33" filter="url(#p)"/></svg>`;
const CASES = {
  'flood + composite, region':
    '<filter id="p" x="0" y="0" width="1" height="1"><feFlood flood-color="#0a0"/><feComposite in2="SourceAlpha" operator="in"/></filter>',
  'flood + composite':
    '<filter id="p"><feFlood flood-color="#0a0"/><feComposite in2="SourceAlpha" operator="in"/></filter>',
  'one color matrix (single kind)':
    '<filter id="p"><feColorMatrix type="saturate" values="0.2"/></filter>',
  'component transfer':
    '<filter id="p" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncR type="linear" slope="0.5"/></feComponentTransfer></filter>',
  'turbulence + composite':
    '<filter id="p" x="0" y="0" width="1" height="1"><feTurbulence baseFrequency="0.05"/><feComposite in2="SourceAlpha" operator="in"/></filter>',
  'tiny blur (framed, the control)':
    '<filter id="p"><feGaussianBlur stdDeviation="0.01"/></filter>',
};
const worst = async (flt, zoom) => {
  const F = createFakeGl({ width: SZ, height: SZ }),
    g = F.gl,
    gp = g.getParameter.bind(g);
  g.getParameter = (p) =>
    p === g.MAX_TEXTURE_SIZE || p === g.MAX_RENDERBUFFER_SIZE
      ? LIMIT
      : p === g.MAX_VIEWPORT_DIMS
        ? new Int32Array([LIMIT, LIMIT])
        : gp(p);
  const R = createRenderer(g, taggedShaderSources(), {});
  R.setViewport(SZ, SZ);
  const b = createBundle(g, await importSvg(doc(flt), { preserveViewport: true }));
  const sizes = [],
    ti = g.texImage2D;
  g.texImage2D = (...a) => {
    if (a[3] > 0 && a[4] > 0) sizes.push([a[3], a[4]]);
    return ti(...a);
  };
  // the art's top-left corner lands at the canvas center, and the rest runs past the far edges
  R.beginFrame([1, 1, 1, 1]);
  R.drawBundle(b, { worldMatrix: new Float32Array([zoom, 0, 0, 0, zoom, 0, zoom, -zoom, 1]) });
  R.endFrame();
  const evals = R.debugStats.filterEvalCount | 0;
  R.dispose();
  return {
    big: sizes.reduce((m, c) => Math.max(m, c[0], c[1]), 0),
    bytes: sizes.reduce((s, c) => s + c[0] * c[1] * 4, 0),
    evals,
  };
};
for (const [name, flt] of Object.entries(CASES))
  for (const zoom of name.includes('control') ? [4, 64] : [4, 64, 2 ** 20, 2 ** 28]) {
    // (the blur's own reach grows with the zoom: at 2^20 it is 750 px)
    const w = await worst(flt, zoom);
    ok(
      w.evals === 1 && w.big > 0 && w.big <= SZ + 128,
      `${name}, zoom ${zoom}: evaluated, largest target ${w.big} px (canvas ${SZ}), ${(w.bytes / 1048576).toFixed(1)} MiB`,
    );
  }

// The margins: what reads a target says how far past the canvas it can still matter.
const seen = (nodes, rootOut = nodes.length - 1) => graphSeenMargins({ nodes, rootOut });
ok(typeof graphSeenMargins === 'function', 'the margins exist');
if (typeof graphSeenMargins === 'function') {
  const PT = seen([
    { type: 'feFlood', inputs: [] },
    { type: 'feComposite', inputs: [0, -2] },
  ]);
  ok(
    PT.x.every((v) => v === 0) && PT.y.every((v) => v === 0) && PT.srcX === 0 && PT.srcY === 0,
    'a pointwise graph: nothing past the canvas matters',
  );
  const OFF = seen([
    { type: 'feFlood', inputs: [] },
    { type: 'feOffset', inputs: [0], params: { dx: 40, dy: 0 } },
  ]);
  ok(
    OFF.x[0] === 40 && OFF.x[1] === 40 && OFF.y[0] === 0,
    'an offset: its input matters out to the offset, and its own target counts its own reach',
  );
  const CHAIN = seen([
    { type: 'feGaussianBlur', inputs: [-1], params: { sigmaX: 2, sigmaY: 1 } },
    { type: 'feOffset', inputs: [0], params: { dx: 10, dy: 0 } },
    { type: 'feColorMatrix', inputs: [1] },
  ]);
  ok(
    CHAIN.srcX === 16 &&
      CHAIN.srcY === 3 &&
      CHAIN.x[0] === 16 &&
      CHAIN.x[1] === 10 &&
      CHAIN.x[2] === 0,
    'a chain sums the reach downstream of each target',
  );
  const BLUR = seen([{ type: 'feGaussianBlur', inputs: [-1], params: { sigmaX: 5, sigmaY: 5 } }]);
  ok(
    BLUR.x[0] === 15 && BLUR.y[0] === 15,
    'a blur at the root keeps its own reach: its later passes read what its earlier ones spread past the edge',
  );
  const TILE = seen([
    { type: 'feOffset', inputs: [-1], params: { dx: 1, dy: 1 } },
    { type: 'feTile', inputs: [0] },
  ]);
  ok(
    TILE.x[0] === Infinity && TILE.srcX === Infinity,
    'feTile reads from any distance: what it reads is not cut',
  );
}

console.log(fail ? `filterPastCanvasRectSmoke: ${fail} FAILED` : 'filterPastCanvasRectSmoke: PASS');
process.exit(fail ? 1 : 0);
