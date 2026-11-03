// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// paintReferenceSmoke — paint references and element ids.
//
// SVG 2 §13.2: a paint is `url(#id) fallback`. Where the reference names no paint server the fallback color is painted,
// and with none the paint is `none` (not black, and a trailing fallback does not make the whole value invalid). The reference is
// the cascade's value, so a url() set by a rule or inherited from a group resolves like an attribute's.
//
// Ids: a duplicate id resolves to the FIRST element in document order, as getElementById does in every
// browser (SVG 1.1 calls a duplicate an error, so there is no better rule), not the last. The same first
// element is the target of a <use>, a gradient, a filter, a clipPath, a marker and a pattern reference.
//
// GL-free: reads the meta rows and the parsed definitions.
import { imp, wrap, rows, painted, box, near, makeChecker } from './_importSemantics.mjs';
import { parseGradients } from '../../src/svg/gradient.js';
import { parseFilters } from '../../src/svg/filter.js';
import { parseMarkers } from '../../src/svg/marker.js';
import { parseClipsAndMasks } from '../../src/svg/clipMask.js';
import { parsePaintUrl, resolvePaintRef } from '../../src/svg/utils.js';

const { ok, done } = makeChecker('PAINT-REFERENCE');
const LIME = [0, 1, 0],
  BLUE = [0, 0, 1];
const G =
  '<linearGradient id="g"><stop stop-color="blue"/><stop offset="1" stop-color="blue"/></linearGradient>';
const rect = (attrs) => `<rect x="10" y="10" width="30" height="30" ${attrs}/>`;
const fillRow = async (body) => {
  const rs = painted(await imp(wrap(body)));
  return rs.length ? rs[0] : null;
};
const strokeRow = async (body) => {
  const rs = rows(await imp(wrap(body))).filter((r) => r.stroke[3] > 0 && r.sw > 0);
  return rs.length ? rs[0] : null;
};
const isFill = async (label, body, want, alpha = 1) => {
  const r = await fillRow(body);
  ok(
    r && near(r.fill.slice(0, 3), want, 1e-3) && Math.abs(r.fill[3] - alpha) < 1e-3,
    `${label}: ${r ? r.fill.map((v) => +v.toFixed(2)).join('/') : 'no fill'}`,
  );
};
const noFill = async (label, body) => ok(!(await fillRow(body)), `${label}: nothing painted`);

// ---- the grammar ----------------------------------------------------------------------------------------------------
{
  const p = parsePaintUrl('url( "#g" )  lime');
  ok(p && p.ref === 'g' && p.fallback === 'lime', 'url(), quotes and a trailing fallback parse');
  ok(
    parsePaintUrl('url(#g)').fallback === '' && parsePaintUrl('url(file.svg#g)').ref === null,
    'no fallback; an external reference has no local id',
  );
  ok(
    resolvePaintRef('url(#a) rgb(0 0 0 / .5)') === 'a' &&
      resolvePaintRef('#abc') === null &&
      resolvePaintRef('red') === null,
    'resolvePaintRef takes only url()',
  );
}

// ---- fallbacks ------------------------------------------------------------------------------------------------------
await isFill('a missing reference paints the fallback', rect('fill="url(#zz) lime"'), LIME);
await noFill('a missing reference with fallback none', rect('fill="url(#zz) none"'));
await noFill('a missing reference with no fallback is none', rect('fill="url(#zz)"'));
await isFill(
  'a reference to an element that is not a paint server',
  `<rect id="q" width="1" height="1" fill="none"/>${rect('fill="url(#q) lime"')}`,
  LIME,
);
await isFill('an external reference falls back', rect('fill="url(file.svg#g) lime"'), LIME);
await isFill(
  'currentColor as the fallback',
  `<g color="blue">${rect('fill="url(#zz) currentColor"')}</g>`,
  BLUE,
);
await isFill(
  'a fallback with alpha keeps its alpha',
  rect('fill="url(#zz) rgb(0 255 0 / 50%)"'),
  LIME,
  0.5,
);
await isFill(
  'an inherited url() falls back for the child',
  `<g fill="url(#zz) lime">${rect('')}</g>`,
  LIME,
);
await isFill('a style value falls back too', rect('style="fill:url(#zz) lime"'), LIME);
{
  const r = await strokeRow(rect('fill="none" stroke="url(#zz) lime" stroke-width="2"'));
  ok(r && near(r.stroke.slice(0, 3), LIME, 1e-3), 'a stroke falls back');
  ok(
    !(await strokeRow(rect('fill="none" stroke="url(#zz)" stroke-width="2"'))),
    'a missing stroke reference with no fallback paints no stroke',
  );
}
{
  // a reference that resolves is the paint server whatever the fallback says
  const b = await imp(wrap(G + rect('fill="url(#g) lime"')));
  const r = painted(b)[0];
  ok(
    r && near(r.fill.slice(0, 3), [1, 1, 1], 1e-3) && b.gradients,
    'a resolved reference paints the gradient, not the fallback',
  );
  const rule = await imp(wrap(`<style>rect{fill:url(#g)}</style>${G}${rect('')}`));
  const rr = painted(rule)[0];
  ok(
    rr && near(rr.fill.slice(0, 3), [1, 1, 1], 1e-3) && rule.gradients,
    'a url() fill set by a stylesheet rule resolves',
  );
  const inh = await imp(wrap(`${G}<g fill="url(#g)">${rect('')}</g>`));
  ok(
    painted(inh)[0] && near(painted(inh)[0].fill.slice(0, 3), [1, 1, 1], 1e-3),
    'an inherited url() resolves',
  );
}

// ---- the first element with an id ------------------------------------------------------------------------------------
{
  const b = await imp(
    wrap(
      '<rect id="d" width="3" height="3" fill="red"/><rect id="d" width="9" height="9" fill="blue"/><use href="#d" x="50"/>',
    ),
  );
  const rs = painted(b);
  ok(
    rs.length === 3 && near(box(rs[2]), [50, 0, 53, 3]),
    `a <use> instantiates the first element with the id (${rs.length ? JSON.stringify(box(rs[rs.length - 1])) : 'none'})`,
  );
}
{
  const doc = new DOMParser().parseFromString(
    wrap(
      '<linearGradient id="g"><stop stop-color="red"/></linearGradient><linearGradient id="g"><stop stop-color="blue"/></linearGradient>',
    ),
    'image/svg+xml',
  );
  ok(
    near(parseGradients(doc.documentElement).g.stops[0].color, [1, 0, 0, 1], 1e-6),
    'the first of two gradients with one id',
  );
}
await isFill(
  'an id held first by a rect is not a gradient later in the document',
  `<rect id="g" width="1" height="1" fill="none"/>${G}${rect('fill="url(#g) lime"')}`,
  LIME,
);
{
  const doc = new DOMParser().parseFromString(
    wrap(
      '<filter id="f"><feOffset dx="5"/></filter><filter id="f"><feOffset dx="9"/></filter>' +
        '<marker id="m" markerWidth="1" markerHeight="1"><path d="M0 0h1v1z"/></marker><marker id="m" markerWidth="7" markerHeight="7"/>' +
        '<clipPath id="c"><rect width="1" height="1"/></clipPath><clipPath id="c"><rect width="9" height="9"/></clipPath>',
    ),
    'image/svg+xml',
  );
  const root = doc.documentElement;
  const f = parseFilters(root, null, {});
  ok(f.f && f.f.graph && f.f.graph.nodes[0].params.dx === 5, 'the first filter with the id');
  ok(parseMarkers(root).m.mw === 1, 'the first marker with the id');
  const cp = parseClipsAndMasks(root).clipPaths.c;
  ok(
    cp.element.getElementsByTagName('rect')[0].getAttribute('width') === '1',
    'the first clipPath with the id',
  );
}
{
  const b = await imp(
    wrap(
      '<filter id="f"><feOffset dx="5"/></filter><filter id="f"><feOffset dx="9"/></filter><rect width="10" height="10" filter="url(#f)"/>',
    ),
  );
  const dx = b.filterGraphs && b.filterGraphs[0] ? b.filterGraphs[0].nodes[0].params.dx : null;
  ok(dx === 5, `an import uses the first filter with the id (dx ${dx})`);
}

done();
