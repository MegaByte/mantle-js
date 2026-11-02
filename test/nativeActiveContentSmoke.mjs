// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeActiveContentSmoke -- what the native scene's clone leaves of a retained source's active content.
//
// The clone removes script, event handlers and javascript: hrefs unless the caller trusts the source. A javascript: href spelled with a tab or a newline inside the scheme is the same
// scheme to the URL parser and is removed too; so is a <set> or <animate> that writes one onto an <a> at run time, and an HTML <iframe>, which loads its src wherever it is mounted.
// CPU (test/_exportHarness.mjs: the real scene on a DOM shim over xmldom). The claim is the markup.
const { M, wrap, imp, dom, els, check, finish } = await import('./_exportHarness.mjs');
const SOURCE = wrap(`
  <a id="tab" href="java&#9;script:alert(1)"><rect width="1" height="1"/></a>
  <a id="nl" href="java&#10;script:alert(2)"><rect width="1" height="1"/></a>
  <a id="lead" href="  javascript:alert(3)"><rect width="1" height="1"/></a>
  <a id="set"><set attributeName="href" to="javascript:alert(4)"/><rect width="1" height="1"/></a>
  <a id="anim"><animate attributeName="xlink:href" values="#a;javascript:alert(5)" dur="1s"/><rect width="1" height="1"/></a>
  <iframe xmlns="http://www.w3.org/1999/xhtml" src="javascript:alert(6)"/>
  <a id="safe" href="https://example.com/"><animate attributeName="href" to="https://example.org/" dur="1s"/><animate attributeName="opacity" to="0.5" dur="1s"/><rect id="r" width="1" height="1" onclick="alert(7)"/></a>`);
const bundle = await imp(SOURCE);
const draw = (opts) => {
  const scene = M.createNativeScene(dom.createElement('div'), { document: dom, ...opts });
  scene.setViewport(100, 100);
  scene.beginFrame();
  scene.drawBundle(bundle);
  scene.endFrame();
  return scene.svg;
};
const svg = draw({});
const oid = (e) => e.getAttribute('data-oid') || e.getAttribute('id');
const a = (id) => els(svg, 'a').find((e) => oid(e) === id);
for (const id of ['tab', 'nl', 'lead'])
  check(
    `${id}: the href is gone`,
    !!a(id) && a(id).getAttribute('href') == null,
    a(id) && a(id).getAttribute('href'),
  );
check('a <set> writing a script url is gone', els(a('set'), 'set').length === 0);
check('an <animate> writing a script url is gone', els(a('anim'), 'animate').length === 0);
check('an <iframe> is gone', els(svg, 'iframe').length === 0);
check('(control) a plain href stays', a('safe').getAttribute('href') === 'https://example.com/');
check('(control) animations that write no script url stay', els(a('safe'), 'animate').length === 2);
check(
  '(control) a handler is gone as it was',
  els(svg, 'rect').every((e) => e.getAttribute('onclick') == null),
);
const trusted = draw({ allowActiveContent: true });
check(
  '(control) allowActiveContent keeps it all',
  els(trusted, 'iframe').length === 1 && els(trusted, 'set').length === 1,
);
finish('nativeActiveContentSmoke');
