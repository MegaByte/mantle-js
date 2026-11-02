// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// filterScaleImportSmoke -- a filter's lengths follow the REFERENCING ELEMENT's transform. No GPU: it reads bundle.filterGraphs /
// filterTab / filterPrimCtms through each shape's filter id.
//
// SVG 1.1 section 15.7.1 and Filter Effects 1 section 3.2: with userSpaceOnUse units the filter works in the user coordinate system of the element that
// references it, which includes that element's transform. A stdDeviation, a radius, a displacement scale and a light's height are lengths in
// that system; a light's position and the noise field are places in it. If only dx / dy and a point light's x / y took the element's
// transform, a blur under transform="scale(2)" would reach half as far as Chrome's.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { setDiagnostics } = await import('../src/core/diagnostics.js');
const { MantleFontAsset } = await import('../src/font/fontAsset.js');
const { buildSvgTextGlyphs } = await import('../src/font/textRun.js');
const { fontFixture, readAsset } = await import('./_assets.mjs');
const font = new MantleFontAsset(new Uint8Array(readAsset(fontFixture('roboto-regular.ttf'))));
const TEXT_OPTS = { fonts: { Roboto: font }, svgTextLayout: buildSvgTextGlyphs };

const warnings = [];
setDiagnostics({ onWarn: (...a) => warnings.push(a.join(' ')) });

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const rel = (a, b, e = 1e-9) => Math.abs(a - b) <= e * Math.max(1, Math.abs(a), Math.abs(b));
const near = (a, b, e = 1e-9) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((v, i) => rel(v, b[i], e));
const doc = (body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${body}</svg>`;
const REG = 'filterUnits="userSpaceOnUse" x="-100" y="-100" width="200" height="200"';
const SQ = '<rect x="-8" y="-8" width="16" height="16" fill="#e04020"';
function filterIds(b) {
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const ids = [];
  for (let s = 0; s < pm.numShapes; s++) {
    const fid = Math.floor(pm.metaFloats[s * pm.floatsPerShape + 32] + 0.5);
    if (fid > 0) ids.push(fid);
  }
  return ids;
}
const graphOf = (b, k = 0) => {
  const ids = filterIds(b);
  return ids.length > k && b.filterGraphs ? b.filterGraphs[ids[k] - 1] : null;
};
const node = (b, type, k = 0) => {
  const g = graphOf(b, k);
  return g ? g.nodes.find((n) => n.type === type) : null;
};
// The single-kind record's (kind, sigmaX, sigmaY) from filterTab (6 texels per entry; texel 5 = kind, x, y).
const kindOf = (b, k = 0) => {
  const ids = filterIds(b);
  const f = new Float32Array(
    b.filterTab.buffer
      ? b.filterTab.buffer.slice(
          b.filterTab.byteOffset,
          b.filterTab.byteOffset + b.filterTab.byteLength,
        )
      : b.filterTab,
  );
  const o = (ids[k] - 1) * 24 + 20;
  return [f[o], f[o + 1], f[o + 2]];
};
// A lone blur of the source in the default linearRGB is the filterTab kind-7 record, not a graph node: either reads as { params: { sigmaX, sigmaY } }.
const blurNode = (b, k = 0) =>
  node(b, 'feGaussianBlur', k) ||
  (() => {
    if (filterIds(b).length <= k || !b.filterTab) return null;
    const [kind, sigmaX, sigmaY] = kindOf(b, k);
    return kind === 1 || kind === 7 ? { params: { sigmaX, sigmaY } } : null;
  })();
const withFilter = (inner, t, attrs = '', fattrs = '') =>
  doc(
    `<filter id="f" ${REG} ${fattrs}>${inner}</filter><g transform="${t}" filter="url(#f)">${SQ}/></g>`,
  );

console.log('blur');
{
  const b = await importSvg(
    withFilter('<feGaussianBlur stdDeviation="2"/>', 'translate(32 32) scale(2)'),
  );
  const n = blurNode(b);
  ok(
    n && rel(n.params.sigmaX, 4) && rel(n.params.sigmaY, 4) && !n.params.m,
    'scale(2): stdDeviation 2 is 4 root units (' + JSON.stringify(n && n.params) + ')',
  );
}
{
  const b = await importSvg(
    withFilter('<feGaussianBlur stdDeviation="2"/>', 'translate(32 32) scale(2 1)'),
  );
  const n = blurNode(b);
  ok(
    n && rel(n.params.sigmaX, 4) && rel(n.params.sigmaY, 2) && !n.params.m,
    'scale(2 1): an ellipse, 4 by 2',
  );
}
{
  const b = await importSvg(
    withFilter('<feGaussianBlur stdDeviation="2"/>', 'translate(32 32) scale(-1.5 1.5)'),
  );
  const n = blurNode(b);
  ok(n && rel(n.params.sigmaX, 3) && rel(n.params.sigmaY, 3), 'a flip keeps the length: 3');
}
{
  const b = await importSvg(
    withFilter('<feGaussianBlur stdDeviation="2"/>', 'translate(32 32) rotate(30) scale(1.5)'),
  );
  const n = blurNode(b);
  ok(
    n && rel(n.params.sigmaX, 3) && rel(n.params.sigmaY, 3) && !n.params.m,
    'a uniform blur under a similarity is a disc of the scaled radius: 3',
  );
}
{
  const b = await importSvg(
    withFilter('<feGaussianBlur stdDeviation="2"/>', 'translate(32 32) rotate(30) scale(2 1)'),
  );
  const n = blurNode(b);
  ok(
    n &&
      n.params.sigmaX === 2 &&
      n.params.sigmaY === 2 &&
      n.params.m &&
      rel(n.params.m[0], 2 * Math.cos(Math.PI / 6)),
    'a turned non-uniform scale: the blur follows the element axes (m), sigma as authored',
  );
}
{
  // The single-kind route (a lone blur on a shape) carries it in filterTab.
  const b = await importSvg(
    doc(
      `<filter id="f" ${REG} color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="2 3"/></filter><rect transform="translate(32 32) scale(2)" x="-8" y="-8" width="16" height="16" filter="url(#f)"/>`,
    ),
  );
  const [kind, sx, sy] = kindOf(b);
  ok(kind === 1 && rel(sx, 4) && rel(sy, 6), 'the single-kind blur: ' + [kind, sx, sy]);
  const m = await importSvg(
    doc(
      `<filter id="f" ${REG} color-interpolation-filters="sRGB"><feMorphology operator="dilate" radius="2 1"/></filter><rect transform="translate(32 32) scale(2 3)" x="-8" y="-8" width="16" height="16" filter="url(#f)"/>`,
    ),
  );
  const [mk, mx, my] = kindOf(m);
  ok(mk === 5 && rel(mx, 4) && rel(my, 3), 'the single-kind morphology: ' + [mk, mx, my]);
}
{
  // Correct at any scale: nothing depends on the size of the factor.
  for (const k of [1e-4, 1e-2, 1e3, 1e6]) {
    const b = await importSvg(withFilter('<feGaussianBlur stdDeviation="2 3"/>', `scale(${k})`));
    const n = blurNode(b);
    ok(
      n && rel(n.params.sigmaX, 2 * k) && rel(n.params.sigmaY, 3 * k),
      `scale(${k}): sigma ${n && n.params.sigmaX}, ${n && n.params.sigmaY}`,
    );
  }
}
console.log('other lengths');
{
  const b = await importSvg(
    withFilter('<feMorphology operator="dilate" radius="2 1"/>', 'translate(32 32) scale(2 3)'),
  );
  const g = graphOf(b);
  const n = g ? g.nodes[0] : null;
  const rec = n && n.params ? [n.params.radiusX, n.params.radiusY] : kindOf(b).slice(1);
  ok(near(rec, [4, 3]), 'feMorphology radius follows the axes: ' + JSON.stringify(rec));
}
{
  // A rotated element's morphology window is its own rectangle: the passes run along its axes (m), the radii as authored.
  const b = await importSvg(
    withFilter(
      '<feMorphology operator="dilate" radius="2 1"/>',
      'translate(32 32) rotate(30) scale(2)',
    ),
  );
  const n = node(b, 'feMorphology');
  ok(
    n &&
      n.params.radiusX === 2 &&
      n.params.radiusY === 1 &&
      n.params.m &&
      rel(n.params.m[0], 2 * Math.cos(Math.PI / 6)),
    'feMorphology under a turn: the window follows the element axes (m)',
  );
  const k = await importSvg(
    doc(
      `<filter id="f" ${REG} color-interpolation-filters="sRGB"><feMorphology operator="dilate" radius="2 1"/></filter><rect transform="translate(32 32) rotate(30)" x="-8" y="-8" width="16" height="16" filter="url(#f)"/>`,
    ),
  );
  ok(
    node(k, 'feMorphology') && node(k, 'feMorphology').params.m,
    'a lone morphology on a turned shape takes the graph route',
  );
}
{
  const b = await importSvg(
    withFilter('<feDropShadow dx="3" dy="2" stdDeviation="1.5"/>', 'translate(32 32) scale(2)'),
  );
  const bl = blurNode(b),
    of = node(b, 'feOffset');
  ok(
    bl && of && rel(bl.params.sigmaX, 3) && rel(of.params.dx, 6) && rel(of.params.dy, 4),
    'feDropShadow: blur 3, offset (6, 4)',
  );
}
{
  const b = await importSvg(
    withFilter(
      '<feTurbulence baseFrequency="0.05"/><feDisplacementMap in="SourceGraphic" scale="8"/>',
      'translate(32 32) scale(2 1)',
    ),
  );
  const d = node(b, 'feDisplacementMap');
  ok(
    d && near(d.params.m, [2, 0, 0, 1]) && d.params.scale === 8,
    'feDisplacementMap carries the linear part (the vector turns with the element), scale as authored',
  );
  const t = node(b, 'feTurbulence');
  ok(
    t && near(t.params.um, [0.5, 0, 0, 1, -16, -32]),
    'feTurbulence carries the inverse CTM (the field is a function of user space): ' +
      JSON.stringify(t && t.params.um),
  );
}
{
  // Translation alone moves the noise field (it is anchored to the user-space origin) and nothing else.
  const b = await importSvg(withFilter('<feTurbulence baseFrequency="0.05"/>', 'translate(10 20)'));
  const t = node(b, 'feTurbulence');
  ok(
    t && near(t.params.um, [1, 0, 0, 1, -10, -20]),
    'a translated element shifts the noise origin',
  );
  const c = await importSvg(withFilter('<feGaussianBlur stdDeviation="2"/>', 'translate(10 20)'));
  ok(
    !c.filterPrimCtms || c.filterPrimCtms.every((m) => !m),
    'a translation does not touch a blur entry (no ctm, no split): ' +
      JSON.stringify(c.filterPrimCtms),
  );
}
console.log('lights');
{
  const light =
    '<feDiffuseLighting in="SourceAlpha" surfaceScale="3" lighting-color="white"><fePointLight x="-4" y="-6" z="10"/></feDiffuseLighting>';
  const b = await importSvg(withFilter(light, 'translate(32 32) scale(2)'));
  const n = node(b, 'feDiffuseLighting');
  ok(
    n && near(n.params.lightPos, [24, 20, 20]),
    'a point light: position through the CTM, height scaled by the element: ' +
      JSON.stringify(n && n.params.lightPos),
  );
  const d =
    '<feDiffuseLighting in="SourceAlpha" surfaceScale="3" lighting-color="white"><feDistantLight azimuth="0" elevation="45"/></feDiffuseLighting>';
  const b2 = await importSvg(withFilter(d, 'translate(32 32) rotate(90)'));
  const n2 = node(b2, 'feDiffuseLighting');
  const c = Math.SQRT1_2;
  ok(
    n2 && near(n2.params.lightPos, [0, c, c], 1e-9),
    'a distant light turns with the element: ' + JSON.stringify(n2 && n2.params.lightPos),
  );
  const b3 = await importSvg(withFilter(d, 'translate(32 32) scale(3)'));
  ok(
    near(node(b3, 'feDiffuseLighting').params.lightPos, [3 * c, 0, 3 * c], 1e-9),
    "a uniform scale leaves a distant light's direction alone (its length scales; the pass normalizes it)",
  );
  const b4 = await importSvg(withFilter(d, 'translate(32 32) scale(2 1)'));
  const n4 = node(b4, 'feDiffuseLighting');
  ok(
    n4 &&
      near(n4.params.lightPos, [2 * c, 0, Math.SQRT2 * c], 1e-9) &&
      near(n4.params.ls, [Math.SQRT2, Math.SQRT2], 1e-9),
    'an anisotropic scale: the light is fixed in the scaled layer (l0 x, l1 y, g z), the relief scales by g: ' +
      JSON.stringify(n4 && [n4.params.lightPos, n4.params.ls]),
  );
}
console.log('instances');
{
  // <use> and an inherited group filter: the instance's own CTM.
  const u = doc(
    `<filter id="f" ${REG}><feGaussianBlur stdDeviation="2"/></filter><g id="s" filter="url(#f)">${SQ}/></g><use href="#s" transform="translate(32 32) scale(3)"/>`,
  );
  const b = await importSvg(u);
  const n = blurNode(b, filterIds(b).length - 1);
  ok(
    n && rel(n.params.sigmaX, 6),
    '<use> of a filtered group: the instance scale (6): ' + JSON.stringify(n && n.params),
  );
  const g = doc(
    `<filter id="f" ${REG}><feGaussianBlur stdDeviation="2"/></filter><g transform="scale(2)" filter="url(#f)"><g transform="scale(1.5)">${SQ}/></g></g>`,
  );
  const b2 = await importSvg(g);
  const n2 = blurNode(b2);
  ok(
    n2 && rel(n2.params.sigmaX, 4),
    "a filter on a group takes the GROUP's scale, not its children's (4): " +
      JSON.stringify(n2 && n2.params),
  );
  const e = doc(
    `<filter id="f" ${REG}><feGaussianBlur stdDeviation="2"/></filter><g transform="scale(2)"><rect transform="scale(1.5)" x="-8" y="-8" width="16" height="16" filter="url(#f)"/></g>`,
  );
  const b3 = await importSvg(e);
  const n3 = blurNode(b3);
  ok(
    n3 && rel(n3.params.sigmaX, 6),
    "an element's own transform composes with its parents' (6): " + JSON.stringify(n3 && n3.params),
  );
  const css = doc(`<g transform="scale(2)" style="filter: blur(2px)">${SQ}/></g>`);
  const b4 = await importSvg(css);
  const n4 = blurNode(b4);
  const k4 = n4 ? [n4.params.sigmaX] : kindOf(b4).slice(1, 2);
  ok(rel(k4[0], 4), 'a CSS blur() on a scaled element (4): ' + JSON.stringify(k4));
}
console.log('entries');
{
  // Two elements with the same translation-only placement share one entry; a scale splits it.
  const u = doc(
    `<filter id="f" ${REG}><feGaussianBlur stdDeviation="2"/></filter><rect x="0" y="0" width="8" height="8" filter="url(#f)" transform="translate(5 5)"/><rect x="20" y="0" width="8" height="8" filter="url(#f)" transform="translate(9 1)"/><rect x="40" y="0" width="8" height="8" filter="url(#f)" transform="scale(2)"/>`,
  );
  const b = await importSvg(u);
  const ids = filterIds(b);
  const pc = ids.map((i) => b.filterPrimCtms && b.filterPrimCtms[i - 1]);
  ok(
    ids.length === 3 && !pc[0] && !pc[1] && near(pc[2], [2, 0, 0, 2, 0, 0]),
    'a translation adds no ctm to the entry; a scale adds its linear part only: ' +
      JSON.stringify(pc),
  );
}
console.log('text and filter lists (an image needs a browser: filterScaleRenderSmoke)');
{
  const t = (tr, u = '') =>
    doc(
      `<filter id="f" ${REG} ${u}><feGaussianBlur stdDeviation="${u ? '0.1' : '2'}"/></filter><text transform="${tr}" x="0" y="20" font-family="Roboto" font-size="20" filter="url(#f)">Hi</text>`,
    );
  const n = blurNode(await importSvg(t('scale(2)'), TEXT_OPTS));
  ok(
    n && rel(n.params.sigmaX, 4),
    'text under scale(2): stdDeviation 2 is 4: ' + JSON.stringify(n && n.params),
  );
  const one = await importSvg(t('scale(1)', 'primitiveUnits="objectBoundingBox"'), TEXT_OPTS);
  const nb = blurNode(one);
  ok(
    nb &&
      !nb.params.obb &&
      nb.params.sigmaX > 0.5 &&
      nb.params.sigmaX < 10 &&
      rel(nb.params.sigmaX / nb.params.sigmaY, 1, 1e-9) === false,
    'text: objectBoundingBox units against the box of ALL its glyphs: ' +
      JSON.stringify(nb && nb.params),
  );
}
{
  // Each url() stage of a list is a filter of its own with its own region.
  const REG2 = 'filterUnits="userSpaceOnUse" x="16" y="16" width="24" height="24"';
  const b = await importSvg(
    doc(
      `<filter id="g" ${REG2}><feOffset dx="10"/></filter><filter id="h" ${REG}><feGaussianBlur stdDeviation="2"/></filter><g filter="url(#g) url(#h)">${SQ}/></g>`,
    ),
  );
  const g = graphOf(b);
  ok(
    g &&
      g.nodes.length === 3 &&
      g.nodes[1].type === 'feOffset' &&
      near(g.nodes[1].params.sub, [16, 16, 24, 24]),
    'the first stage is clipped to ITS region before the second reads it: ' +
      JSON.stringify(g && g.nodes.map((n) => [n.type, n.params.sub])),
  );
  const c = await importSvg(
    doc(
      `<filter id="g" ${REG2}><feOffset dx="10"/></filter><g filter="url(#g) blur(1px)">${SQ}/></g>`,
    ),
  );
  ok(
    !c.filterRegions || c.filterRegions.every((r) => !r),
    "a function after the last url() is not bounded by that stage's region",
  );
}
console.log('feImage names an element');
{
  const before = warnings.length;
  await importSvg(
    doc(
      `<filter id="f" ${REG}><feImage href="#r"/></filter><rect id="r" x="0" y="0" width="8" height="8"/><rect x="20" y="20" width="8" height="8" filter="url(#f)"/><rect x="40" y="20" width="8" height="8" filter="url(#f)"/>`,
    ),
  );
  const w = warnings.slice(before).filter((m) => /feImage href="#r"/.test(m));
  ok(
    w.length === 1,
    'feImage href="#rect" says once that only <image> references are rendered (the element half is not implemented): ' +
      w.join(' | '),
  );
}
if (fail) {
  console.error(fail + ' failure(s)');
  process.exit(1);
}
console.log('filterScaleImportSmoke: ok');
