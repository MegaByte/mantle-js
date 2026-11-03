// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importSpecEdgesSmoke: edge cases the specs state, imported as stated.
//
// (a) A viewBox of zero width or height disables the rendering of the element (SVG 2 8.6): a root, a nested <svg>, a <symbol>, a <pattern>, a
//     <marker>, a referenced document. None is drawn with the viewBox ignored.
// (b) Marker content: a child with display:none or visibility:hidden, or a failed conditional test, is not drawn, and pathLength,
//     vector-effect and paint-order apply inside a marker. refX / refY keywords (left, center, right, top, bottom) resolve, not read as 0.
// (c) Selectors: a descendant or general-sibling step tries a farther candidate when the nearest fails; a <style> with a `type` that
//     is not CSS or a `media` that does not match is not applied; a class or id with a non-ASCII character or an escape matches.
// (d) The color grammar's compat mode is one module slot, and an import running beside another keeps its own mode.
// (e) An objectBoundingBox gradient on a shape with no width or height is no paint server: the url()'s fallback paints.
// (i) spreadMethod inherits through href under xmldom (Node) too, which answers '' for an absent attribute.
// (j) A <pattern> whose viewBox disables it applies no paint, even with a fallback in the url(); Chrome paints the fallback, so compat: 'chrome' does.
if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const L = await import('../src/bundle/layout.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const doc = (body, attrs = 'viewBox="0 0 100 100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const rows = (b) => {
  if (!b.numShapes) return [];
  const m = new Float32Array(b.meta, 32),
    s = b.metaFloatsPerShape || 48,
    out = [];
  for (let r = 0; r < b.numShapes; r++) out.push(m.subarray(r * s, (r + 1) * s));
  return out;
};
const imp = async (body, opts, attrs) => rows(await importSvg(doc(body, attrs), opts));
const page = (r) => r.filter((a) => !(a[L.META_FLAGS_SHAPE] & 0x100));
const R = '<rect width="9" height="9"/>';

console.log('(a) a viewBox of zero width or height');
ok((await imp(R, undefined, 'viewBox="0 0 0 10"')).length === 0, 'the root');
ok((await imp(R, undefined, 'viewBox="0 0 10 0"')).length === 0, 'the root, zero height');
ok(
  (await imp(R, undefined, 'viewBox="0 0 -10 10"')).length === 1,
  'a negative width is an error, so no viewBox: it draws',
);
ok(
  page(
    await imp(
      `<svg x="10" width="10" height="10" viewBox="0 0 0 10">${R}</svg><rect y="50" width="1" height="1"/>`,
    ),
  ).length === 1,
  'a nested <svg>',
);
ok(
  page(
    await imp(
      `<symbol id="s" viewBox="0 0 10 0">${R}</symbol><use href="#s" width="10" height="10"/><rect y="50" width="1" height="1"/>`,
    ),
  ).length === 1,
  'a <symbol>',
);
{
  const r = await imp(
    `<pattern id="p" viewBox="0 0 0 5" width="5" height="5" patternUnits="userSpaceOnUse">${R}</pattern><rect width="9" height="9" fill="url(#p)"/>`,
  );
  ok(
    r.every((a) => a[L.META_FILL_A] === 0 || a[L.META_BBOX_XMAX] !== 9) && r.length <= 1,
    'a <pattern>',
  );
}
const M = (attrs, kid = '<rect width="4" height="4" fill="lime"/>') =>
  `<marker id="m" markerWidth="4" markerHeight="4" ${attrs}>${kid}</marker><path d="M20 20L40 20" stroke="red" fill="none" marker-start="url(#m)"/>`;
ok((await imp(M('viewBox="0 0 0 10"'))).length === 1, 'a <marker>');
{
  const inner = doc(R, 'viewBox="0 0 0 10"');
  ok(
    (
      await imp(
        `<image href="data:image/svg+xml,${encodeURIComponent(inner)}" width="10" height="10"/>`,
      )
    ).filter((a) => !(a[L.META_FLAGS_SHAPE] & 0x100)).length === 0,
    'a referenced document',
  );
}
ok(
  page(await imp(`<svg width="10" height="10" viewBox="0 0 10 10">${R}</svg>`)).length === 1,
  'a usable viewBox draws',
);

console.log('(b) marker content');
ok(
  (await imp(M('', '<rect width="4" height="4" fill="lime" display="none"/>'))).length === 1,
  'a display:none child',
);
ok(
  (await imp(M('', '<rect width="4" height="4" fill="lime" visibility="hidden"/>'))).length === 1,
  'a visibility:hidden child',
);
ok(
  (await imp(M('visibility="hidden"'))).length === 1,
  'visibility:hidden on the <marker> reaches its content',
);
ok(
  (
    await imp(M('', '<rect width="4" height="4" fill="lime" systemLanguage="xx"/>'), {
      languages: ['en'],
    })
  ).length === 1,
  'a failed conditional test',
);
{
  const r = await imp(
    M('', '<rect width="4" height="4" fill="lime" stroke="blue" paint-order="stroke"/>'),
  );
  ok(r[1][L.META_STROKE_W] > 0 && r[2][L.META_STROKE_W] === 0, 'paint-order in marker content');
  const center = await imp(M('markerUnits="userSpaceOnUse" refX="center" refY="center"'));
  ok(
    center[1][L.META_BBOX_XMIN] === 18 && center[1][L.META_BBOX_YMIN] === 18,
    `refX / refY center: ${center[1][L.META_BBOX_XMIN]}`,
  );
  const far = await imp(M('markerUnits="userSpaceOnUse" refX="right" refY="bottom"'));
  ok(far[1][L.META_BBOX_XMIN] === 16 && far[1][L.META_BBOX_YMIN] === 16, 'refX right, refY bottom');
  const near = await imp(
    M(
      'markerUnits="userSpaceOnUse" refX="left" refY="top" viewBox="2 2 2 2"',
      '<rect x="2" y="2" width="2" height="2" fill="lime"/>',
    ),
  );
  ok(
    near[1][L.META_BBOX_XMIN] === 20 && near[1][L.META_BBOX_YMIN] === 20,
    "refX left is the viewBox's left edge",
  );
  const num = await imp(M('markerUnits="userSpaceOnUse" refX="1" refY="1"'));
  ok(num[1][L.META_BBOX_XMIN] === 19, 'a number still reads');
}

console.log('(c) selectors');
const red = (r) => r[0][L.META_FILL_R] === 1;
const rect = '<rect width="9" height="9"/>';
ok(
  red(
    await imp(
      `<style>.a > .b rect{fill:red}</style><g class="a"><g class="b"><g class="b">${rect}</g></g></g>`,
    ),
  ),
  '.a > .b rect: a farther .b',
);
ok(
  red(
    await imp(
      `<style>.a .b > rect{fill:red}</style><g class="a"><g class="c"><g class="b">${rect}</g></g></g>`,
    ),
  ),
  '.a .b > rect',
);
ok(
  !red(
    await imp(
      `<style>.a > .b rect{fill:red}</style><g class="c"><g class="b"><g class="b">${rect}</g></g></g>`,
    ),
  ),
  '.a > .b rect: no .a, no match',
);
ok(
  red(
    await imp(
      `<style>.a + .b ~ rect{fill:red}</style><g class="a"/><g class="b"/><g class="b"/>${rect}`,
    ),
  ),
  '.a + .b ~ rect: a farther .b',
);
ok(
  red(await imp(`<style>.a ~ .b + rect{fill:red}</style><g class="a"/><g class="b"/>${rect}`)),
  '.a ~ .b + rect',
);
ok(
  !red(await imp(`<style media="print">rect{fill:red}</style>${rect}`)),
  '<style media="print"> does not apply',
);
ok(
  red(await imp(`<style media="screen, print">rect{fill:red}</style>${rect}`)),
  '<style media="screen, print"> applies',
);
ok(
  !red(await imp(`<style type="text/less">rect{fill:red}</style>${rect}`)),
  '<style type="text/less"> does not apply',
);
ok(
  red(await imp(`<style type="text/css">rect{fill:red}</style>${rect}`)),
  '<style type="text/css"> applies',
);
ok(
  red(await imp(`<style>.é{fill:red}</style><rect class="é" width="9" height="9"/>`)),
  'a non-ASCII class',
);
ok(
  red(await imp(`<style>#日本{fill:red}</style><rect id="日本" width="9" height="9"/>`)),
  'a non-ASCII id',
);
ok(
  red(await imp(`<style>.a\\:b{fill:red}</style><rect class="a:b" width="9" height="9"/>`)),
  'an escaped class',
);
ok(
  red(await imp(`<style>.\\31x{fill:red}</style><rect class="1x" width="9" height="9"/>`)),
  'a hex escape',
);

console.log('(d) concurrent imports with different compat');
{
  const body = '<rect width="9" height="9" fill="AccentColor"/>';
  const solo = (o) =>
    importSvg(doc(body), o)
      .then(rows)
      .then((r) => Array.from(r[0].subarray(L.META_FILL_R, L.META_FILL_A + 1)).join());
  const chrome = await solo({ compat: 'chrome' }),
    spec = await solo({});
  ok(chrome !== spec, `the two modes read AccentColor differently: ${chrome} / ${spec}`);
  const both = await Promise.all([
    solo({ compat: 'chrome' }),
    solo({}),
    solo({ compat: 'chrome' }),
  ]);
  ok(
    both[0] === chrome && both[1] === spec && both[2] === chrome,
    `each keeps its own: ${both.join(' | ')}`,
  );
  const flip = await Promise.all([solo({}), solo({ compat: 'chrome' })]);
  ok(flip[0] === spec && flip[1] === chrome, `in either order: ${flip.join(' | ')}`);
}

console.log('(e) an objectBoundingBox gradient on a shape with no height');
{
  const G = '<linearGradient id="g"><stop stop-color="red"/></linearGradient>';
  let r = await imp(`${G}<line x2="10" stroke="url(#g) lime"/>`);
  ok(
    r.some(
      (a) =>
        a[L.META_STROKE_W] > 0 &&
        a[L.META_STROKE_G] === 1 &&
        a[L.META_STROKE_A] === 1 &&
        a[L.META_STROKE_GRAD] === 0,
    ),
    'the fallback paints',
  );
  r = await imp(`${G}<line x2="10" stroke="url(#g) lime" stroke-opacity="0.5"/>`);
  ok(
    r.some((a) => a[L.META_STROKE_W] > 0 && a[L.META_STROKE_A] === 0.5),
    "at the stroke's opacity",
  );
  r = await imp(`${G}<line x2="10" stroke="url(#g)"/>`);
  ok(!r.some((a) => a[L.META_STROKE_W] > 0 && a[L.META_STROKE_A] > 0), 'no fallback: nothing');
  r = await imp(`${G}<line x2="10" y2="10" stroke="url(#g) lime"/>`);
  ok(
    r.some((a) => a[L.META_STROKE_GRAD] > 0),
    'a shape with a box keeps the gradient',
  );
}

console.log(
  '(f) transform-origin as a presentation attribute; a viewport unit in a filter function',
);
{
  const box = (a) =>
    [a[L.META_BBOX_XMIN], a[L.META_BBOX_YMIN], a[L.META_BBOX_XMAX], a[L.META_BBOX_YMAX]]
      .map((v) => Math.round(v * 1000) / 1000)
      .join();
  let r = await imp(
    '<rect x="10" width="10" height="10" transform="rotate(90)" transform-origin="15 5"/>',
  );
  ok(box(r[0]) === '10,0,20,10', `the attribute, bare numbers: ${box(r[0])}`);
  r = await imp(
    '<rect x="10" width="10" height="10" transform="rotate(90)" transform-origin="15px 5px"/>',
  );
  ok(box(r[0]) === '10,0,20,10', `the attribute, lengths: ${box(r[0])}`);
  r = await imp(
    '<rect x="10" width="10" height="10" transform="rotate(90)" transform-origin="15 5" style="transform-origin:0 0"/>',
  );
  ok(box(r[0]) === '-10,10,0,20', `a declaration beats it: ${box(r[0])}`);
  r = await imp('<rect x="10" width="10" height="10" transform="rotate(90)"/>');
  ok(box(r[0]) === '-10,10,0,20', `none: the origin of the user space: ${box(r[0])}`);
  const b = await importSvg(doc('<rect width="9" height="9" style="filter:blur(10vw)"/>'));
  const sigma = b.filterGraphs && b.filterGraphs[0] && b.filterGraphs[0].nodes[0].params.sigmaX;
  ok(sigma === 10, `blur(10vw) of a 100-wide root: ${sigma}`);
}

console.log('(g) names in filter primitives and clip-path');
for (const body of [
  '<filter id="f"><feComposite operator="constructor"/></filter><rect width="9" height="9" filter="url(#f)"/>',
  '<filter id="f"><feBlend mode="constructor"/></filter><rect width="9" height="9" filter="url(#f)"/>',
  '<filter id="f"><feDisplacementMap xChannelSelector="toString" yChannelSelector="valueOf"/></filter><rect width="9" height="9" filter="url(#f)"/>',
]) {
  const b = await importSvg(doc(body));
  const p = b.filterGraphs[0].nodes[0].params;
  ok(
    [p.op, p.mode, p.xChan, p.yChan].every((v) => v === undefined || typeof v === 'number'),
    body.slice(16, 50),
  );
}
{
  const r = await imp('<rect width="9" height="9" style="clip-path:constructor"/>');
  ok(r.length === 1 && r[0][L.META_CLIP_ID] === 0, 'clip-path: constructor is invalid, so no clip');
}

console.log('(h) elements that never render');
for (const tag of ['title', 'desc', 'metadata', 'style', 'script']) {
  ok(
    (await imp(`<${tag}><rect width="9" height="9"/></${tag}><rect y="50" width="1" height="1"/>`))
      .length === 1,
    `what a <${tag}> holds`,
  );
}
ok(
  (
    await imp(
      '<x:wrap xmlns:x="urn:x"><rect width="9" height="9"/></x:wrap><rect y="50" width="1" height="1"/>',
    )
  ).length === 1,
  'what an element of another namespace holds',
);
{
  const b = await importSvg(
    '<html xmlns="http://www.w3.org/1999/xhtml"><body><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="9" height="9"/></svg></body></html>',
  );
  ok(page(rows(b)).length === 1, 'an <svg> in a host document still imports');
}

console.log('(i) spreadMethod through href');
{
  // xmldom answers '' for an absent attribute, so that answer must not end the search at the chain's first element (the template's value would be lost under Node).
  const spreadOf = async (body) =>
    new Float32Array(
      (await importSvg(doc(`${body}<rect width="9" height="9" fill="url(#g)"/>`))).gradients,
    )[L.GRAD_SPREAD];
  const S = '<stop stop-color="red"/><stop offset="1" stop-color="blue"/>';
  ok(
    (await spreadOf(
      `<linearGradient id="a" spreadMethod="reflect">${S}</linearGradient><linearGradient id="g" href="#a"/>`,
    )) === 1,
    'inherited: reflect',
  );
  ok(
    (await spreadOf(
      `<linearGradient id="a" spreadMethod="repeat">${S}</linearGradient><linearGradient id="g" href="#a"/>`,
    )) === 2,
    'inherited: repeat',
  );
  ok(
    (await spreadOf(
      `<radialGradient id="a" spreadMethod="reflect">${S}</radialGradient><linearGradient id="b" href="#a"/><linearGradient id="g" href="#b"/>`,
    )) === 1,
    'through two links',
  );
  ok(
    (await spreadOf(
      `<linearGradient id="a" spreadMethod="reflect">${S}</linearGradient><linearGradient id="g" href="#a" spreadMethod="repeat"/>`,
    )) === 2,
    'its own value wins',
  );
  ok((await spreadOf(`<linearGradient id="g">${S}</linearGradient>`)) === 0, 'none anywhere: pad');
}

console.log('(j) a <pattern> a zero viewBox disables, and a fallback');
{
  const P = (vb = 'viewBox="0 0 0 5" ') =>
    `<pattern id="p" ${vb}width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#0a0"/></pattern>`;
  const fill = `${P()}<rect width="60" height="60" fill="url(#p) #fa0"/>`,
    stroke = `${P()}<path d="M0 20H60" fill="none" stroke-width="8" stroke="url(#p) #fa0"/>`;
  const painted = (r, w) =>
    r.some((a) =>
      w
        ? a[L.META_STROKE_W] > 0 && a[L.META_STROKE_A] === 1 && a[L.META_STROKE_R] === 1
        : a[L.META_FILL_A] === 1 && a[L.META_FILL_R] === 1,
    );
  ok(!painted(await imp(fill), false), 'fill: no paint by default');
  ok(
    painted(await imp(fill, { compat: 'chrome' }), false),
    'fill: the fallback under compat: chrome',
  );
  ok(!painted(await imp(stroke), true), 'stroke: no paint by default');
  ok(
    painted(await imp(stroke, { compat: 'chrome' }), true),
    'stroke: the fallback under compat: chrome',
  );
  ok(
    !painted(
      await imp(`${P()}<rect width="60" height="60" fill="url(#p)"/>`, { compat: 'chrome' }),
      false,
    ),
    'no fallback: nothing in either mode',
  );
  ok(
    !painted(
      await imp(
        `<pattern id="a" viewBox="0 0 0 5"/><pattern id="p" href="#a" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#0a0"/></pattern><rect width="60" height="60" fill="url(#p) #fa0"/>`,
      ),
      false,
    ),
    'a viewBox reached through href: no paint',
  );
  ok(
    painted(
      await imp(
        `<pattern id="a" viewBox="0 0 0 5"/><pattern id="p" href="#a" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="#0a0"/></pattern><rect width="60" height="60" fill="url(#p) #fa0"/>`,
        { compat: 'chrome' },
      ),
      false,
    ),
    'and the fallback under compat: chrome',
  );
}

console.log(fail ? `\nimportSpecEdgesSmoke: ${fail} failed` : '\nimportSpecEdgesSmoke: passed');
process.exit(fail ? 1 : 0);
