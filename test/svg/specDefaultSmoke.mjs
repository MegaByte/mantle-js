// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// specDefaultSmoke -- where Chrome (or a browser) departs from the spec text, importSvg draws the SPEC by default and Chrome's behavior
// only under importSvg({ compat: 'chrome' }) (the option the <image> fit and feSpecularLighting already had). GL-free: each case asserts
// what the importer writes (graph params, filter ids, curve records, glyph positions) under the default, an explicit 'spec' and 'chrome'.
//
//   *   Filter Effects 1, "Filter primitive subregion": a primitive subregion with a negative or zero width or height DISABLES the
//       primitive (transparent black). Chrome does not clip it: a zero-width feFlood floods the whole filter region.
//   *   Filter Effects 1, <filter-function-list> / url(): "If the filter references a non-existent object ... the whole filter chain is
//       ignored. No filter is applied to the object." Chrome skips only the stage that names no <filter>.
//   *   SVG 2, "Path implementation notes" (zero-length path segments): the square cap of a zero-length subpath is aligned to the path's
//       direction there (the closest preceding segment with length, else the closest following one, else the x axis). Chrome and Skia
//       draw it axis-aligned (to the user-space x axis) whatever the path does.
//   *   SVG 2, "Legacy white-space handling": an explicit xml:space="default" would REMOVE newlines before it collapses spaces; the
//       spec calls that processing legacy and deprecated and no browser does it. Mantle acts as browsers do (a
//       newline is a space, CSS white-space: normal) in both compat modes.
import fs from 'node:fs';
import { imp, wrap, painted, makeChecker, rows } from './_importSemantics.mjs';
import { MantleFontAsset, buildSvgTextGlyphs } from '../../src/font/index.js';
import { primitiveSubregions } from '../../src/filterGraph/feImagePlace.js';
import { setDiagnostics } from '../../src/core/diagnostics.js';

const { ok, done } = makeChecker('SPEC-DEFAULT');
const warnings = [];
setDiagnostics({ onWarn: (...a) => warnings.push(a.join(' ')) });
const MODES = [
  ['default', {}],
  ['spec', { compat: 'spec' }],
  ['chrome', { compat: 'chrome' }],
];
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ---- a subregion of no area --------------------------------------------------------------------------------------------------------
console.log('a zero or negative subregion extent');
{
  const REG = 'filterUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"';
  const svg = (attrs, units = '') =>
    wrap(
      `<filter id="f" ${REG} ${units}><feFlood flood-color="#2060d0" ${attrs}/></filter><rect x="16" y="16" width="32" height="32" fill="#e04020" filter="url(#f)"/>`,
      'viewBox="0 0 64 64"',
    );
  const node = async (attrs, opts, units) => {
    const b = await imp(svg(attrs, units), opts);
    return (b.filterGraphs || [])
      .filter(Boolean)
      .flatMap((g) => g.nodes)
      .find((n) => n.type === 'feFlood');
  };
  const env = { regionEm: [0, 0, 64, 64], boxEm: [16, 16, 48, 48], ctm: null };
  const sub = (n) => primitiveSubregions({ nodes: [n], rootOut: 0 }, env)[0];
  for (const [what, attrs, units] of [
    ['width="0"', 'x="10" y="10" width="0" height="20"', ''],
    ['height="0"', 'x="10" y="10" width="20" height="0"', ''],
    ['width="-5"', 'x="10" y="10" width="-5" height="20"', ''],
    [
      'width="0" in objectBoundingBox units',
      'x="0.1" y="0.1" width="0" height="0.5"',
      'primitiveUnits="objectBoundingBox"',
    ],
  ]) {
    for (const [name, opts] of MODES) {
      const n = await node(attrs, opts, units);
      ok(!!n, `${what} (${name}): the flood is in the graph`);
      if (!n) continue;
      const chrome = name === 'chrome';
      ok(
        chrome ? n.params.chromeZeroSub === 1 : !('chromeZeroSub' in n.params),
        `${what} (${name}): chromeZeroSub ${chrome ? 'is' : 'is not'} set`,
      );
      if (units) continue; // the box-unit graph is resolved against the element's box at finalize; the flag is what the import writes
      const r = sub(n);
      ok(
        chrome ? r === null : r === 'empty',
        `${what} (${name}): the subregion is ${chrome ? 'unclipped (the filter region)' : '"empty": transparent black'} (got ${JSON.stringify(r)})`,
      );
    }
  }
  // a positive extent is untouched by the mode
  for (const [name, opts] of MODES) {
    const n = await node('x="10" y="10" width="20" height="20"', opts);
    const r = sub(n);
    ok(
      !('chromeZeroSub' in n.params) && Array.isArray(r) && near(r[2], 30),
      `a positive subregion (${name}) is the same rect: ${JSON.stringify(r)}`,
    );
  }
  // what reads a disabled primitive: the union default of empty inputs is empty
  const g = {
    nodes: [
      { type: 'feFlood', inputs: [], params: { sub: [5, 5, 0, 10], subUnits: 0 } },
      { type: 'feOffset', inputs: [0], params: {} },
    ],
    rootOut: 1,
  };
  const r = primitiveSubregions(g, env);
  ok(r[0] === 'empty' && r[1] === 'empty', 'a primitive that reads a disabled one is empty too');
  g.nodes[0].params.chromeZeroSub = 1;
  const rc = primitiveSubregions(g, env);
  ok(
    rc[0] === null && rc[1] === null,
    "chromeZeroSub puts both back to the filter region (today's output)",
  );
}

// ---- a filter list naming no <filter> ---------------------------------------------------------------------------------------------
console.log('a url() in a filter list that names no filter');
{
  const filterIds = (b) =>
    rows(b)
      .filter((r) => r.filt > 0)
      .map((r) => r.filt);
  const svg = (value) =>
    wrap(
      `<filter id="g" x="0" y="0" width="1" height="1"><feOffset dx="3" dy="0"/></filter><rect x="16" y="16" width="32" height="32" fill="#e04020" style="filter: ${value}"/>`,
      'viewBox="0 0 64 64"',
    );
  const typesOf = (b) => {
    const ids = filterIds(b);
    return ids.length ? b.filterGraphs[ids[0] - 1].nodes.map((n) => n.type).join() : null;
  };
  for (const [name, opts] of MODES) {
    warnings.length = 0;
    const b1 = await imp(svg('blur(2px) url(#nope)'), opts),
      t1 = typesOf(b1);
    const b2 = await imp(svg('url(#nope) url(#g)'), opts),
      t2 = typesOf(b2);
    const b3 = await imp(svg('blur(2px) url(#g)'), opts),
      t3 = typesOf(b3);
    const chrome = name === 'chrome';
    ok(
      t1 === (chrome ? 'feGaussianBlur' : null),
      `blur(2px) url(#nope) (${name}): ${chrome ? 'only the blur applies' : 'the whole list is ignored, no filter'} (got ${t1})`,
    );
    ok(
      t2 === (chrome ? 'feOffset' : null),
      `url(#nope) url(#g) (${name}): ${chrome ? 'the offset stage applies' : 'the whole list is ignored'} (got ${t2})`,
    );
    ok(
      t3 === 'feGaussianBlur,feOffset',
      `blur(2px) url(#g) (${name}): a list whose urls all name filters is unchanged (got ${t3})`,
    );
    ok(
      warnings.some(
        (w) =>
          /not a <filter>; (the whole list is ignored|that stage is skipped)/.test(w) &&
          w.includes(chrome ? 'skipped' : 'ignored'),
      ),
      `(${name}) says which: ${JSON.stringify(warnings.filter((w) => /not a <filter>/.test(w)))}`,
    );
  }
}

// ---- the square cap of a zero-length subpath --------------------------------------------------------------------------------------
console.log('the square cap of a zero-length subpath');
{
  const records = (b) => {
    const f = new Float32Array(b.curves),
      out = [],
      size = { 0: 3, 1: 4, 2: 4, 3: 5 };
    for (let i = 4; i + 3 < f.length;) {
      const ty = f[i] & 3;
      out.push({ ty, skip: (f[i] & 4) !== 0, p: Array.from(f.slice(i + 4, i + 8)) });
      i += size[ty] * 4;
    }
    return out;
  };
  const live = async (d, opts, g = '') => {
    const b = await imp(
      wrap(
        `<g ${g}><path d="${d}" fill="none" stroke="#000" stroke-width="20" stroke-linecap="square"/></g>`,
        'viewBox="0 0 100 100"',
      ),
      { preserveViewport: true, ...opts },
    );
    return records(b).filter(
      (x) => !x.skip && x.ty === 0 && Math.hypot(x.p[2] - x.p[0], x.p[3] - x.p[1]) < 1e-2,
    );
  };
  const deg = (r) => (Math.atan2(r.p[3] - r.p[1], r.p[2] - r.p[0]) * 180) / Math.PI;
  // angle of a tiny line, modulo 180 (a line has no sense)
  const ang = (r) => ((deg(r) % 180) + 180) % 180;
  const cases = [
    ['after a diagonal segment', 'M10 10 L40 40 M70 20 h0', 45, 0],
    ['after a curve: its END direction (down)', 'M10 10 Q40 10 40 40 M70 20 h0', 90, 0],
    [
      'before a diagonal segment (no segment with length precedes it)',
      'M20 20 h0 M30 30 L60 90',
      (Math.atan2(60, 30) * 180) / Math.PI,
      0,
    ],
    ['alone (the whole path has no length): the x axis', 'M50 50 L50 50', 0, 0],
    ['M x y Z alone', 'M50 50 Z', 0, 0],
  ];
  for (const [what, d, want] of cases) {
    for (const [name, opts] of MODES) {
      const l = await live(d, opts);
      ok(l.length === 1, `${what} (${name}): one live square record (${l.length})`);
      if (l.length !== 1) continue;
      const chromeAxis = name === 'chrome';
      const expect = chromeAxis ? 0 : want;
      ok(
        near(ang(l[0]), expect, 0.05) || (expect === 0 && near(ang(l[0]), 180, 0.05)),
        `${what} (${name}): the square's axis is at ${expect.toFixed(2)} degrees (got ${ang(l[0]).toFixed(2)})`,
      );
    }
  }
  // under a rotating transform the document-space direction is the segment's, and Chrome's is the element's x axis
  for (const [name, opts] of MODES) {
    const l = await live('M10 10 L40 10 M70 70 h0', opts, 'transform="rotate(20 50 50)"');
    const a = ang(l[0]);
    ok(
      l.length === 1 && near(a, 20, 0.1),
      `a segment along user x under rotate(20) (${name}): both rules agree at 20 degrees (got ${a.toFixed(2)})`,
    );
  }
  // round and butt are unchanged by the mode
  for (const cap of ['round', 'butt']) {
    const sig = [];
    for (const [, opts] of MODES) {
      const b = await imp(
        wrap(
          `<path d="M10 10 L40 40 M70 20 h0" fill="none" stroke="#000" stroke-width="20" stroke-linecap="${cap}"/>`,
          'viewBox="0 0 100 100"',
        ),
        { preserveViewport: true, ...opts },
      );
      sig.push(JSON.stringify(records(b)));
    }
    ok(sig[0] === sig[1] && sig[1] === sig[2], `${cap} caps: the mode changes nothing`);
  }
}

// ---- an explicit xml:space="default" ----------------------------------------------------------------------------------------------
console.log('xml:space="default" and a newline');
{
  const ROBOTO = new URL('../font/fixtures/roboto-regular.ttf', import.meta.url);
  const roboto = new MantleFontAsset(new Uint8Array(fs.readFileSync(ROBOTO)));
  roboto.getMetrics(0x41);
  const VB = 'viewBox="-300 -100 900 400"';
  const T = (attrs, inner) =>
    `<text x="20" y="100" font-family="Roboto" font-size="40" ${attrs}>${inner}</text>`;
  const xs = async (attrs, inner, opts = {}) => {
    const b = await imp(wrap(T(attrs, inner), VB), {
      fonts: { Roboto: roboto },
      svgTextLayout: buildSvgTextGlyphs,
      ...opts,
    });
    return painted(b).map((r) => +r.bbox[0].toFixed(3));
  };
  const same = (a, b) => a.length === b.length && a.every((v, i) => near(v, b[i], 1e-3));
  for (const [name, opts] of MODES) {
    const chrome = name === 'chrome';
    const nl = await xs('xml:space="default"', 'a\nb', opts),
      ab = await xs('', 'ab', opts),
      aSb = await xs('', 'a b', opts);
    ok(ab.length === 2 && aSb.length === 2, `(${name}) controls draw two glyphs`);
    ok(
      same(nl, aSb),
      `(${name}) xml:space="default": a\\nb draws as "a b" (a newline is a space, as in every browser)`,
    );
    const nl2 = await xs('xml:space="default"', 'a\n  b', opts);
    ok(
      same(nl2, aSb),
      `(${name}) xml:space="default": a newline with indentation after it still gives one space`,
    );
    const inh = await xs('', 'a\nb', opts);
    ok(same(inh, aSb), `(${name}) no xml:space (CSS white-space: normal): a newline is a space`);
    const prs = await xs('xml:space="preserve"', 'a\nb', opts);
    ok(
      same(prs, aSb),
      `(${name}) xml:space="preserve": a newline is one space (SVG 2 and 1.1 agree)`,
    );
    const tspan = await xs('', 'a<tspan xml:space="default">\nb</tspan>', opts);
    ok(
      same(tspan, aSb),
      `(${name}) xml:space="default" on a tspan: the newline at its start is a space`,
    );
    const g = await imp(wrap(`<g xml:space="default">${T('', 'a\nb')}</g>`, VB), {
      fonts: { Roboto: roboto },
      svgTextLayout: buildSvgTextGlyphs,
      ...opts,
    });
    ok(
      same(
        painted(g).map((r) => +r.bbox[0].toFixed(3)),
        aSb,
      ),
      `(${name}) xml:space="default" inherited from a <g>`,
    );
  }
}

// ---- AccentColor / AccentColorText ---------------------------------------------------------------------------------------------
console.log('AccentColor and AccentColorText');
{
  const { isColorValue } = await import('../../src/svg/cssDecl.js');
  const { parseColorStrict } = await import('../../src/svg/color.js');
  const one = async (v, opts) => {
    const b = await imp(wrap(`<rect width="10" height="10" fill="${v}"/>`), opts);
    return painted(b).map((r) => r.fill.map((x) => Math.round(x * 255)));
  };
  for (const kw of ['AccentColor', 'accentcolortext', 'ACCENTCOLOR']) {
    ok(
      isColorValue(kw) && parseColorStrict(kw.toLowerCase()) !== null,
      `${kw} is a valid color by default (CSS Color 4 section 6.2)`,
    );
  }
  const d = await one('AccentColor', {}),
    s = await one('AccentColor', { compat: 'spec' }),
    c = await one('AccentColor', { compat: 'chrome' });
  const t = await one('AccentColorText', {});
  ok(
    d.length === 1 && d[0].join() === '0,117,255,255' && s[0].join() === d[0].join(),
    `fill="AccentColor" paints the UA accent by default and under 'spec': ${JSON.stringify(d)}`,
  );
  ok(
    t.length === 1 && t[0].join() === '255,255,255,255',
    `AccentColorText is white: ${JSON.stringify(t)}`,
  );
  ok(
    c.length === 1 && c[0].join() === '0,0,0,255',
    `compat 'chrome': the keyword is invalid as in Chrome, the fill stays the default black: ${JSON.stringify(c)}`,
  );
  // the mode is put back after an import (and never leaks into the next one)
  ok(isColorValue('AccentColor'), 'after a compat: chrome import the parser is back in spec mode');
  const b2 = await imp(wrap('<rect width="10" height="10" fill="AccentColor"/>'), {});
  ok(
    painted(b2)[0]
      .fill.map((x) => Math.round(x * 255))
      .join() === '0,117,255,255',
    'and the next default import paints the accent',
  );
}

done();
