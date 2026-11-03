// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// exportIsolationSmoke.mjs: what a native scene or an export does with a bundle's retained source (node, CPU only).
//   <style> text is scoped to its bundle and follows renamed ids
//   <script>, on* handlers, javascript: hrefs and <foreignObject> are stripped unless opted in
//   an export is deterministic: ids restart per export, authored ids are kept, markers are removed
//   instanced draws share one template through <use>; float32 matrices print short
import {
  M,
  wrap,
  imp,
  dom,
  els,
  exportLog,
  mkRenderer,
  exportDetail,
  check,
  finish,
} from './_exportHarness.mjs';

const COUNTER = Symbol.for('@kontek/mantle.nativeResourceId');
const ids = (svg) =>
  els(svg)
    .map((e) => e.getAttribute('id'))
    .filter(Boolean);
const urlRefs = (svg) => [...svg.matchAll(/url\(\s*['"]?#([^'")\s]+)/g)].map((m) => m[1]);

// ────────────────────────────────────────────────────────────────────────────────────────────────
{
  const scopeCssText =
    (await import('../src/fallback/scopeCss.js').catch(() => ({}))).scopeCssText ||
    (() => '(scopeCss.js missing)');
  const scoped = scopeCssText(
    'rect, .k > path { fill: red } svg #a:hover { stroke: url(#mk) } @media (min-width: 1px) { g { opacity: .5 } } @font-face { font-family: f; src: url(x.woff) } /* c { x } */ :root { color: blue }',
    '_b7',
    new Map([
      ['a', 'a_b7'],
      ['mk', 'mk_b7'],
    ]),
  );
  check(
    'selectors are prefixed with the scope',
    /\[data-mantle-scope="_b7"\] rect, \[data-mantle-scope="_b7"\] \.k > path\{/.test(scoped),
    scoped,
  );
  check(
    'a leading svg compound is the scope itself and #id follows the id map',
    /\[data-mantle-scope="_b7"\] #a_b7:hover\{ stroke: url\(#mk_b7\)/.test(scoped),
    scoped,
  );
  check(
    '@media bodies are scoped, @font-face and comments pass through',
    /@media \(min-width: 1px\) \{ \[data-mantle-scope="_b7"\] g\{/.test(scoped) &&
      /@font-face \{ font-family: f; src: url\(x\.woff\) \}/.test(scoped) &&
      /\/\* c \{ x \} \*\//.test(scoped),
    scoped,
  );
  check(
    ':root is the scope itself',
    /\[data-mantle-scope="_b7"\]\{ color: blue \}/.test(scoped),
    scoped,
  );

  const A = await imp(wrap('<style>rect{fill:red}</style><rect id="a" width="10" height="10"/>'));
  const B = await imp(wrap('<rect id="b" x="20" width="10" height="10"/>'));
  const r = exportLog([{ bundle: A }, { bundle: B }]);
  const style = els(r.svg, 'style')[0];
  const host = style.parentNode;
  const scope = host.getAttribute('data-mantle-scope');
  check(
    'one bundle style is scoped to its own group',
    scope && style.textContent.startsWith(`[data-mantle-scope="${scope}"] rect`),
    r.svg,
  );
  const rectB = els(r.svg, 'rect').find((e) => e.getAttribute('id') === 'b');
  let inScope = false;
  for (let n = rectB; n; n = n.parentNode)
    if (n.getAttribute && n.getAttribute('data-mantle-scope') === scope) inScope = true;
  check('the other bundle is outside that scope', !inScope, r.svg);

  // The same bundle drawn twice: the second clone's ids are renamed, and its style follows.
  const C = await imp(
    wrap(
      '<style>#a{fill:red} #m{mask:url(#mk)}</style><defs><mask id="mk"><rect width="5" height="10" fill="#fff"/></mask></defs><rect id="a" width="10" height="10"/><rect id="m" x="20" width="10" height="10"/>',
    ),
  );
  const r2 = exportLog([
    { bundle: C },
    { bundle: C, opts: { overrides: M.createNativeOverrideTable(C) } },
  ]);
  const styles = els(r2.svg, 'style').map((s) => s.textContent);
  check(
    'first clone keeps #a and url(#mk)',
    /#a\{fill:red\}/.test(styles[0]) && /url\(#mk\)/.test(styles[0]),
    styles[0],
  );
  check(
    'second clone rewrites #a and url(#mk) to its renamed ids',
    /#a_b\d+\{/.test(styles[1]) && /url\(#mk_b\d+\)/.test(styles[1]),
    styles[1],
  );
  const all = ids(r2.svg);
  check(
    'every id is unique and every reference resolves',
    new Set(all).size === all.length && urlRefs(r2.svg).every((u) => all.includes(u)),
    JSON.stringify(all),
  );
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
{
  const hostile = wrap(
    '<script>alert(1)</script><rect id="a" width="10" height="10" onclick="alert(2)" onload="alert(3)"/>' +
      '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml" onmouseover="x()">hi</div></foreignObject>' +
      '<a href="javascript:alert(4)"><rect width="5" height="5"/></a><a xlink:href=" JavaScript:alert(5)"><rect width="5" height="5"/></a>',
  );
  const b = await imp(hostile);
  check(
    'precondition: the retained source still carries it',
    /<script/.test(b.svgSource) && /onclick/.test(b.svgSource),
    b.svgSource,
  );
  const bad = /<script|onclick|onload|onmouseover|foreignObject|javascript:/i;
  const r = exportLog([{ bundle: b }]);
  check('export strips active content', !bad.test(r.svg), r.svg);
  check(
    'export keeps the harmless shapes',
    els(r.svg, 'rect').filter((e) => e.getAttribute('id') === 'a').length === 1,
    r.svg,
  );
  const kept = exportLog([{ bundle: b }], { allowActiveContent: true });
  check(
    'allowActiveContent keeps it',
    /<script/.test(kept.svg) &&
      /onclick/.test(kept.svg) &&
      /foreignObject/.test(kept.svg) &&
      /javascript:/i.test(kept.svg),
    kept.svg,
  );
  const scene = M.createNativeScene(dom.createElement('div'), { document: dom });
  scene.setViewport(100, 100);
  scene.beginFrame([1, 1, 1, 1]);
  scene.drawBundle(b, {});
  scene.endFrame();
  check(
    'the native scene strips it by default',
    els(scene.svg, 'script').length === 0 &&
      els(scene.svg, 'foreignObject').length === 0 &&
      !els(scene.svg).some((e) => e.getAttribute('onclick') != null),
    '',
  );
  scene.dispose();
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
{
  const svg = wrap(
    '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient><clipPath id="c"><rect width="50" height="50"/></clipPath></defs><rect id="a" width="80" height="80" fill="url(#g)" clip-path="url(#c)"/>',
  );
  const b = await imp(svg);
  dom[COUNTER] = 41; // a document that has seen other native work
  const r1 = exportLog([{ bundle: b }]);
  const r2 = exportLog([{ bundle: b }]);
  const r3 = exportLog([{ bundle: await imp(svg) }]);
  check('two exports of one bundle are byte-identical', r1.svg === r2.svg, r1.svg + '\n' + r2.svg);
  check('a fresh import of the same SVG exports identically', r1.svg === r3.svg);
  check('the document counter is restored', dom[COUNTER] === 41, dom[COUNTER]);
  check(
    'authored ids are kept',
    ids(r1.svg).includes('a') && ids(r1.svg).includes('g') && ids(r1.svg).includes('c'),
    JSON.stringify(ids(r1.svg)),
  );
  check(
    'data-oid and data-mantle-rows are not exported',
    !/data-oid|data-mantle-rows/.test(r1.svg),
    r1.svg,
  );
  const two = exportLog([
    { bundle: b },
    { bundle: b, opts: { overrides: M.createNativeOverrideTable(b) } },
  ]);
  const all = ids(two.svg);
  check(
    'a second draw of the bundle renames only the colliding ids, uniquely',
    new Set(all).size === all.length &&
      all.includes('a') &&
      all.some((i) => /^a_b\d+$/.test(i)) &&
      urlRefs(two.svg).every((u) => all.includes(u)),
    JSON.stringify(all),
  );
  delete dom[COUNTER];
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
{
  const { R, bundle } = await mkRenderer();
  const art = wrap(
    '<defs><linearGradient id="g"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient></defs>' +
      '<rect width="10" height="10" fill="url(#g)"/><circle cx="20" cy="20" r="5" fill="url(#g)"/>',
  );
  const b = await bundle(art);
  const per = [];
  for (const n of [10, 100]) {
    const inst = [...Array(n)].map((_, i) => ({
      worldMatrix: new Float32Array([
        1,
        0,
        0,
        0,
        1,
        0,
        (i % 50) / 50 - 1,
        ((i / 50) | 0) / 50 - 1,
        1,
      ]),
    }));
    R.beginFrame([1, 1, 1, 1]);
    R.drawBundleInstanced(b, inst);
    R.endFrame();
    const r = await exportDetail(R);
    per.push(r.svg.length / n);
    check(
      `${n} instances share one gradient and one template`,
      (r.svg.match(/<linearGradient/g) || []).length === 1 &&
        (r.svg.match(/<use/g) || []).length === n &&
        r.drawn === n,
      r.svg.slice(0, 600),
    );
    if (n === 10)
      check('float32 matrices print short', !/\d\.\d{10,}/.test(r.svg), r.svg.slice(0, 900));
  }
  check(
    'per-instance size is small and flat',
    per[1] < 200 && per[1] < per[0],
    JSON.stringify(per),
  );
  // a viewport matrix that is a float32 widened to a double prints as its float32 shortest form
  const f = new Float32Array([1.8285714, 0, 0, 0, 1, 0, 0, 0, 1]);
  const r = exportLog([
    { bundle: await imp(wrap('<rect width="10" height="10"/>')), opts: { worldMatrix: f } },
  ]);
  check(
    'Float32Array matrix prints 1.8285714',
    /matrix\(1\.8285714,0,0,1,0,0\)/.test(r.svg),
    r.svg,
  );
}

finish('exportIsolationSmoke');
