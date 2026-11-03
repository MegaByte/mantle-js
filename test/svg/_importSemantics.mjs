// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _importSemantics.mjs — shared helpers for the importer-semantics smokes (GL-free): import a snippet, read the meta rows
// back, and count passes and failures.
//
// `rows(bundle)` is one record per emitted shape row: its bounding box, fill and stroke RGBA, stroke width and the
// clip / mask / filter ids. A fully transparent, zero-extent row (a culled shape) is kept: filter on `fill[3]` or `bbox`.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../../src/svg/importer.js');
const { parseMetaBin } = await import('../../src/renderer/bundle.js');

export const SVG_NS =
  'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
export const wrap = (body, attrs = 'viewBox="0 0 100 100"') =>
  `<svg ${SVG_NS} ${attrs}>${body}</svg>`;
export const imp = (svg, opts = {}) => importSvg(svg, opts);

export function rows(b) {
  if (!b.meta || !b.meta.byteLength) return [];
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const out = [];
  for (let s = 0; s < pm.numShapes; s++) {
    const f = (i) => pm.metaFloats[s * pm.floatsPerShape + i];
    out.push({
      s,
      bbox: [f(0), f(1), f(2), f(3)],
      fill: [f(4), f(5), f(6), f(7)],
      stroke: [f(8), f(9), f(10), f(11)],
      sw: f(12),
      eo: f(13),
      accum: f(14),
      clip: f(30),
      mask: f(31),
      filt: f(32),
      // flagsShape bit 6 / 7 mark a groupBegin / groupEnd row; a begin row keeps the group opacity in fill[3]
      flags: f(27),
      blend: f(33),
      iso: f(34),
    });
  }
  return out;
}

/// The scene as a sequence: `B(opacity,blend,isolation)` for a group begin, `E` for a group end, `S` for a shape row
/// that paints (resource rows of clips, masks and patterns excluded unless they paint).
export function sequence(b) {
  return rows(b)
    .map((r) => {
      if (r.flags & 256) return '-';
      if (r.flags & 64) return `B(${+r.fill[3].toFixed(3)},${r.blend},${r.iso})`;
      if (r.flags & 128) return 'E';
      return r.fill[3] > 0 || (r.stroke[3] > 0 && r.sw > 0) ? 'S' : '-';
    })
    .filter((x) => x !== '-');
}

/// Rows that paint something (a visible fill or stroke).
export const painted = (b) => rows(b).filter((r) => r.fill[3] > 0 || (r.stroke[3] > 0 && r.sw > 0));
const round = (v) => Math.round(v * 1e4) / 1e4;
export const box = (r) => r.bbox.map(round);
export const near = (a, b, e = 1e-4) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((v, i) => Math.abs(v - b[i]) <= e);

export function makeChecker(name) {
  let failures = 0;
  const ok = (cond, msg) => {
    console.log(`${cond ? '  ok' : 'FAIL'} ${msg}`);
    if (!cond) failures++;
  };
  const done = () => {
    console.log(failures ? `\n${name} FAIL (${failures})` : `\n${name} PASS`);
    process.exit(failures ? 1 : 0);
  };
  return {
    ok,
    done,
    get failures() {
      return failures;
    },
  };
}
