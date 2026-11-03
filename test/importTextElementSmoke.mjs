// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importTextElementSmoke: <text> honors what a shape honors, on a stand-in layout whose glyphs are boxes, one per character, 6 wide.
//
// (a) mix-blend-mode and isolation on a <text> reach every glyph row (not blend 0).
// (b) paint-order applies: under stroke-first a halo's stroke is not drawn over the fill. A run's strokes go under ALL its fills.
// (c) An <a> inside <text> keeps its text, and its link.
// (d) A <tspan> or <a> with display:none, or a failed systemLanguage test, is not drawn; one with visibility:hidden is not painted.
// (e) fill="url(#nope) lime" and fill="url(#nope)" do not paint black: a reference to no paint server is the fallback, else none.
// (f) An objectBoundingBox clipPath or mask content on a <text> is bound to the text's box, not its FIRST GLYPH's (which cuts the rest away).
// (g) visibility inherits and a descendant can set it back: a visible <tspan> under a hidden <text> draws.
// (h) A custom layout that answers null does not throw; it is skipped, as the <textArea> path skips it.
if (typeof globalThis.DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { mkLine } = await import('../src/svg/segment.js');
const L = await import('../src/bundle/layout.js');
let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const layout = (text, font, x, y, fs) => {
  const glyphs = [];
  let pen = 0;
  for (const ch of text) {
    const w = fs * 0.6,
      X = x + pen,
      R = X + w * 0.8,
      T = y - fs;
    glyphs.push({
      segs:
        ch === ' '
          ? []
          : [
              mkLine([X, T], [R, T]),
              mkLine([R, T], [R, y]),
              mkLine([R, y], [X, y]),
              mkLine([X, y], [X, T]),
            ],
      penX: pen,
      advance: w,
      codepoint: ch.codePointAt(0),
    });
    pen += w;
  }
  return { glyphs, advance: pen, writingMode: 'horizontal-tb' };
};
const opts = {
  fonts: { F: { getMetrics() {}, ascent: 0.8, underlinePosition: -0.1, underlineThickness: 0.05 } },
  svgTextLayout: layout,
};
const doc = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;
const rows = (b) => {
  const m = new Float32Array(b.meta, 32),
    s = b.metaFloatsPerShape || 48,
    out = [];
  for (let r = 0; r < b.numShapes; r++) out.push(m.subarray(r * s, (r + 1) * s));
  return out;
};
const imp = async (body, o = {}) => {
  const b = await importSvg(doc(body), { ...opts, ...o });
  return { b, r: b.numShapes ? rows(b) : [] };
};
const T = (attrs, inner = 'AB') =>
  `<text font-family="F" font-size="10" x="10" y="20" ${attrs}>${inner}</text>`;
const page = (r) => r.filter((a) => !(a[L.META_FLAGS_SHAPE] & 0x100));
const glyphs = (r) =>
  page(r).filter((a) => !(a[L.META_FLAGS_SHAPE] & (L.FS_GROUP_BEGIN | L.FS_GROUP_END)));
const x0 = (a) => a[L.META_BBOX_XMIN];

console.log('(a) blend and isolation');
{
  const { r } = await imp(T('style="mix-blend-mode:multiply"'));
  ok(
    r[0][L.META_FLAGS_SHAPE] === L.FS_GROUP_BEGIN && r[0][L.META_BLEND_MODE] === 1,
    'mix-blend-mode composes the element as a group',
  );
  ok(
    glyphs(r).length === 2 && glyphs(r).every((a) => a[L.META_BLEND_MODE] === 0),
    'the glyphs inside it draw plain',
  );
  ok(r[r.length - 1][L.META_FLAGS_SHAPE] === L.FS_GROUP_END, 'and it closes');
  const i = await imp(`<style>.x{isolation:isolate}</style>` + T('class="x"'));
  ok(i.r[0][L.META_ISOLATION] === 1, 'isolation by a rule');
  const n = await imp(T(''));
  ok(n.r.length === 2 && n.r[0][L.META_FLAGS_SHAPE] === 0, 'a plain text opens no group');
}

console.log('(b) paint-order');
{
  const { r } = await imp(T('paint-order="stroke" stroke="red" fill="blue"'));
  ok(
    r.length === 4 &&
      r[0][L.META_STROKE_W] > 0 &&
      r[1][L.META_STROKE_W] > 0 &&
      r[2][L.META_STROKE_W] === 0 &&
      r[3][L.META_STROKE_W] === 0,
    'all strokes come before all fills',
  );
  ok(
    r[0][L.META_FILL_A] === 0 && r[2][L.META_FILL_B] === 1 && r[2][L.META_FILL_A] === 1,
    'the stroke rows paint no fill, the fill rows no stroke',
  );
  const n = await imp(T('stroke="red" fill="blue"'));
  ok(
    n.r.length === 4 && n.r[0][L.META_STROKE_W] === 0 && n.r[1][L.META_STROKE_W] > 0,
    'the default order keeps a fill and its stroke side by side',
  );
  const g = await imp(`<g style="paint-order:stroke fill">${T('stroke="red"')}</g>`);
  ok(g.r[0][L.META_STROKE_W] > 0, 'paint-order inherits');
  const s = await importSvg(doc(T('paint-order="stroke" stroke="red" fill="blue"')), {
    ...opts,
    retainSource: true,
  });
  ok(
    (s.svgSource.match(/<path/g) || []).length === 4,
    'the retained source has one path per record',
  );
}

console.log('(c) <a> in text');
{
  const { b, r } = await imp(T('', 'A<a href="http://x"><tspan>B</tspan>C</a>D'));
  ok(r.length === 4, 'its text is laid out');
  ok(
    b.shapeHrefs.join() === ',http://x,http://x,',
    `its glyphs carry the link: ${b.shapeHrefs.join()}`,
  );
  ok(x0(r[3]) === 28, 'the text after it follows');
  const p = await imp(`<a href="http://y">${T('', 'A')}</a>`);
  ok(p.b.shapeHrefs[0] === 'http://y', 'an <a> around the <text> still links');
}

console.log('(d) elements that do not render');
{
  let { r } = await imp(T('', 'A<tspan display="none">B</tspan>C'));
  ok(r.length === 2 && x0(r[1]) === 16, 'display:none takes no glyph and no place');
  ({ r } = await imp(T('', 'A<tspan systemLanguage="xx">B</tspan>C'), { languages: ['en'] }));
  ok(r.length === 2 && x0(r[1]) === 16, 'a failed systemLanguage test likewise');
  ({ r } = await imp(T('', 'A<tspan systemLanguage="en">B</tspan>C'), { languages: ['en'] }));
  ok(r.length === 3, 'a passed one is drawn');
  ({ r } = await imp(T('', 'A<tspan visibility="hidden">B</tspan>C')));
  ok(r.length === 2 && x0(r[1]) === 22, 'visibility:hidden paints nothing and keeps its place');
  ({ r } = await imp(T('', 'A<tspan visibility="hidden" text-decoration="underline">B</tspan>C')));
  ok(r.length === 2, '...and draws no decoration');
}

console.log('(e) a reference to no paint server');
{
  let { r } = await imp(T('fill="url(#nope) lime"'));
  ok(
    r[0][L.META_FILL_G] === 1 && r[0][L.META_FILL_R] === 0 && r[0][L.META_FILL_A] === 1,
    'fill: the fallback',
  );
  ({ r } = await imp(T('fill="url(#nope)"')));
  ok(r[0][L.META_FILL_A] === 0, 'fill with no fallback: none');
  ({ r } = await imp(T('fill="none" stroke="url(#nope) lime"')));
  ok(
    r.some((a) => a[L.META_STROKE_W] > 0 && a[L.META_STROKE_G] === 1),
    'stroke: the fallback',
  );
  ({ r } = await imp(T('', 'A<tspan fill="url(#nope) lime">B</tspan>')));
  ok(r[0][L.META_FILL_G] === 0 && r[1][L.META_FILL_G] === 1, 'on a tspan');
  ({ r } = await imp(
    `<defs>${T('id="t" fill="context-fill"', 'A')}</defs><use href="#t" fill="lime"/>`,
  ));
  ok(r[0][L.META_FILL_G] === 1, "context-fill takes the <use>'s paint");
}

console.log('(f) an objectBoundingBox reference binds to the whole text');
{
  const box = '<rect width="1" height="1"/>';
  let { r } = await imp(
    `<clipPath id="c" clipPathUnits="objectBoundingBox">${box}</clipPath>` +
      T('clip-path="url(#c)"', 'ABCD'),
  );
  let l = r.find((a) => a[L.META_FLAGS_SHAPE] & 0x100);
  ok(
    l[L.META_BBOX_XMIN] === 10 && Math.abs(l[L.META_BBOX_XMAX] - 32.8) < 1e-4,
    `clipPath: the unit square covers the text: ${l[L.META_BBOX_XMIN]}..${l[L.META_BBOX_XMAX]}`,
  );
  ({ r } = await imp(
    `<mask id="m" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="white"/></mask>` +
      T('mask="url(#m)"', 'ABCD'),
  ));
  l = r.find((a) => a[L.META_FLAGS_SHAPE] & 0x100);
  ok(
    l[L.META_BBOX_XMIN] === 10 && Math.abs(l[L.META_BBOX_XMAX] - 32.8) < 1e-4,
    `mask content: the unit square covers the text: ${l[L.META_BBOX_XMIN]}..${l[L.META_BBOX_XMAX]}`,
  );
  ({ r } = await imp(
    `<clipPath id="c" clipPathUnits="objectBoundingBox">${box}</clipPath><g clip-path="url(#c)">${T('', 'AB')}<rect x="50" y="50" width="10" height="10"/></g>`,
  ));
  l = r.find((a) => a[L.META_FLAGS_SHAPE] & 0x100);
  ok(
    l[L.META_BBOX_XMIN] === 10 && l[L.META_BBOX_XMAX] === 60,
    `a group's clip covers the text and its siblings: ${l[L.META_BBOX_XMIN]}..${l[L.META_BBOX_XMAX]}`,
  );
  const s = await importSvg(
    doc(
      `<clipPath id="c" clipPathUnits="objectBoundingBox">${box}</clipPath>` +
        T('clip-path="url(#c)"', 'ABCD'),
    ),
    { ...opts, computeSilhouette: true },
  );
  const q = rows(s).filter((a) => a[L.META_FLAGS_SHAPE] & 0x100)[0];
  ok(
    q[L.META_BBOX_XMIN] === 10 && Math.abs(q[L.META_BBOX_XMAX] - 32.8) < 1e-4,
    'and under a silhouette, whose row moves every index up',
  );
}

console.log('(g) a visible element under a hidden <text>');
{
  const H = 'visibility="hidden"';
  let { r } = await imp(T(H, 'A<tspan visibility="visible">B</tspan>C'));
  ok(
    r.length === 1 && x0(r[0]) === 16,
    `only the visible glyph paints, in its place: ${r.length} rows, x ${r.length ? x0(r[0]) : '-'}`,
  );
  ({ r } = await imp(`<g ${H}>${T('', 'A<tspan style="visibility:visible">B</tspan>')}</g>`));
  ok(r.length === 1 && x0(r[0]) === 16, 'hidden by an ancestor, and set back by a style');
  ({ r } = await imp(T(H, 'A<a href="http://x"><tspan visibility="visible">B</tspan></a>')));
  ok(r.length === 1, 'nested under an <a>');
  ({ r } = await imp(T(H, 'A<tspan visibility="visible" text-decoration="underline">B</tspan>')));
  ok(r.length === 2, 'its decoration too');
  ({ r } = await imp(T(H, 'A<tspan>B</tspan>')));
  ok(r.length === 0, 'with no visible element nothing paints');
  ({ r } = await imp(T(H, 'A<tspan visibility="visible" display="none">B</tspan>')));
  ok(r.length === 0, 'a visible element that does not render does not count');
  const k = await imp(T(H, 'A<tspan visibility="visible">B</tspan>C'), { keepHidden: true });
  const hiddenFlag = k.r.map((a) => (a[L.META_FLAGS_SHAPE] & L.FS_HIDDEN) !== 0);
  ok(
    k.r.length === 3 && hiddenFlag.join() === 'true,false,true',
    `keepHidden: the hidden glyphs keep flagged rows, the visible one draws: ${hiddenFlag.join()}`,
  );
  const v = await imp(T(H, 'A<tspan visibility="visible">B</tspan>'));
  ok((v.b.hitBits[0] & 3) !== 0, `the pointer finds the visible glyph: bits ${v.b.hitBits[0]}`);
  const s = await importSvg(
    doc(T('style="visibility:hidden"', 'A<tspan visibility="visible">B</tspan>')),
    { ...opts, retainSource: true },
  );
  ok(
    (s.svgSource.match(/<path/g) || []).length === 1 &&
      /<path[^>]*visibility="visible"/.test(s.svgSource),
    'the retained source has the visible glyph, visible under the carried style',
  );
  const a = await imp(
    T(`${H} pointer-events="all"`, 'A<tspan visibility="visible">B</tspan>') +
      '<rect x="50" y="50" width="5" height="5"/>',
  );
  ok(
    a.r.length === 2 && x0(a.r[0]) === 16 && x0(a.r[1]) === 50,
    `the second pass keeps the draw order and adds no drawn row: ${a.r.length}`,
  );
  // pointer-events="all" targets each glyph's fill and stroke regions; the visible glyph's fill is the row it draws, so only the hidden glyph has a hit-only fill.
  const bits = a.b.hitOnly ? Array.from(a.b.hitOnly.rows, (q) => a.b.hitOnly.hitBits[q]) : [];
  ok(
    bits.join() === '1,2,2' && a.b.hitOnly.before[0] === 0,
    `pointer-events=all: fill of the hidden glyph, stroke of both, under the drawn rows: ${bits.join()}`,
  );
}

console.log('(h) a layout that answers null');
{
  const nul = { fonts: opts.fonts, svgTextLayout: () => null };
  const n = await imp(T(''), nul);
  ok(n.r.length === 0, 'null: no rows, no throw');
  const g = await imp(T(''), { fonts: opts.fonts, svgTextLayout: () => ({}) });
  ok(g.r.length === 0, 'no glyphs: no rows, no throw');
  let calls = 0;
  const m = await imp(T('', 'A<tspan>B</tspan>'), {
    fonts: opts.fonts,
    svgTextLayout: (...p) => (calls++ === 0 ? null : layout(...p)),
  });
  ok(
    m.r.length === 1 && x0(m.r[0]) === 10,
    `a run with no layout takes no place: ${m.r.length} rows, x ${m.r.length ? x0(m.r[0]) : '-'}`,
  );
}

console.log(fail ? `\nimportTextElementSmoke: ${fail} failed` : '\nimportTextElementSmoke: passed');
process.exit(fail ? 1 : 0);
