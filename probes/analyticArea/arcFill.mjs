// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Native-arc fill-rule fixtures and an independent exact-area oracle (raw AAC's fill rule on native arcs).
//
// A fixture is a list of contours written ONCE as geometry (lines and center-form elliptical arcs). From it:
//   svgOf(f)          the SVG a renderer imports (arcs as endpoint-form A commands, whole ellipses as two half turns);
//   referenceArea(f)  the exact filled area of every pixel under the fill rule: each contour is flattened to a polyline fine enough
//                     that its chordal error is 1e-9 of the radius, then every sub-scanline (512 per pixel row, midpoint) is cut
//                     exactly in x, the fill rule is applied to the sorted crossings, and the covered x-length is distributed to the
//                     pixel columns it spans. Nothing here reads the renderer, the importer or the certificate.
// Pixel (x, y) covers [x, x+1] x [y, y+1] of the 32x32 user square drawn at 32 px, y down.
export const SIZE = 32;
const D2R = Math.PI / 180;
const at = (a, deg) => {
  const t = deg * D2R,
    p = a.phi * D2R,
    c = Math.cos(t),
    s = Math.sin(t);
  return [
    a.cx + Math.cos(p) * a.rx * c - Math.sin(p) * a.ry * s,
    a.cy + Math.sin(p) * a.rx * c + Math.cos(p) * a.ry * s,
  ];
};
// whole ellipse as two half turns starting at parameter a0; rev travels the other way
export function ellipse(cx, cy, rx, ry, phi = 0, rev = false, a0 = 0) {
  const d = rev ? -180 : 180,
    a = { cx, cy, rx, ry, phi };
  return [{ A: { ...a, a0, a1: a0 + d } }, { A: { ...a, a0: a0 + d, a1: a0 + 2 * d } }];
}
export const circle = (cx, cy, r, rev = false, a0 = 0) => ellipse(cx, cy, r, r, 0, rev, a0);
export const poly = (pts) => pts.map((p) => ({ L: p }));
// a rounded rectangle, clockwise on screen (SVG y down), corner radius r
export function roundRect(x, y, w, h, r, rev = false) {
  const a = (cx, cy, a0, a1) => ({ A: { cx, cy, rx: r, ry: r, phi: 0, a0, a1 } });
  const cw = [
    { L: [x + w - r, y] },
    a(x + w - r, y + r, -90, 0),
    { L: [x + w, y + h - r] },
    a(x + w - r, y + h - r, 0, 90),
    { L: [x + r, y + h] },
    a(x + r, y + h - r, 90, 180),
    { L: [x, y + r] },
    a(x + r, y + r, 180, 270),
  ];
  return rev ? reverseContour(cw) : cw;
}
// a pie slice: apex, radius, parameter angles (degrees, circle); starts on the arc
export function pie(cx, cy, r, a0, a1) {
  return [
    { A: { cx, cy, rx: r, ry: r, phi: 0, a0, a1 } },
    { L: [cx, cy] },
    { L: at({ cx, cy, rx: r, ry: r, phi: 0 }, a0) },
  ];
}
// half disc: the arc from a0 to a0+180 and the diameter back
export function halfDisc(cx, cy, r, a0) {
  return [
    { A: { cx, cy, rx: r, ry: r, phi: 0, a0, a1: a0 + 180 } },
    { L: at({ cx, cy, rx: r, ry: r, phi: 0 }, a0) },
  ];
}
// the same closed contour traveled the other way: segment i goes from vertex i-1 to vertex i, so its reverse goes back
function reverseContour(segs) {
  const n = segs.length,
    pts = segs.map((s) => segEnd(s));
  return segs.map((_, k) => {
    const i = n - 1 - k,
      s = segs[i];
    return s.L ? { L: pts[(i - 1 + n) % n] } : { A: { ...s.A, a0: s.A.a1, a1: s.A.a0 } };
  });
}
const segEnd = (s) => (s.L ? s.L : at(s.A, s.A.a1));
const startOf = (c) => {
  if (c.start) return c.start;
  const s = c[0];
  return s.L ? segEnd(c[c.length - 1]) : at(s.A, s.A.a0);
};

const num = (x) => String(x);
export function svgOf(f, extra = '') {
  let d = '';
  for (const c of f.contours) {
    const st = startOf(c);
    d += `M${num(st[0])} ${num(st[1])}`;
    for (const s of c) {
      if (s.L) d += `L${num(s.L[0])} ${num(s.L[1])}`;
      else {
        const a = s.A,
          e = at(a, a.a1),
          large = Math.abs(a.a1 - a.a0) > 180 ? 1 : 0,
          sweep = a.a1 > a.a0 ? 1 : 0;
        d += `A${num(a.rx)} ${num(a.ry)} ${num(a.phi)} ${large} ${sweep} ${num(e[0])} ${num(e[1])}`;
      }
    }
    d += 'Z';
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}">${f.wrap ? `<g transform="${f.wrap}">` : ''}<path fill="#000" fill-rule="${f.rule}" ${extra} d="${d}"/>${f.wrap ? '</g>' : ''}</svg>`;
}

function flatten(c) {
  const pts = [];
  for (const s of c) {
    if (s.L) {
      pts.push(s.L);
      continue;
    }
    const a = s.A,
      n = Math.max(8, Math.ceil((Math.abs(a.a1 - a.a0) / 360) * 100000));
    for (let i = 0; i < n; i++) pts.push(at(a, a.a0 + ((a.a1 - a.a0) * i) / n));
    pts.push(at(a, a.a1));
  }
  // the start of the first segment is where the previous one ended; the polygon closes on itself
  return pts;
}
// mode 'fill': the exact area under the fixture's fill rule. mode 'winding': the pixel's MEAN SIGNED WINDING (what the winding
// integrators of raw AAC and Slug see before they fold it), absolute value taken only by the caller.
export function referenceArea(f, size = SIZE, rows = 512, mode = 'fill') {
  const R = rows,
    area = new Float64Array(size * size);
  const lines = Array.from({ length: size * R }, () => []);
  for (const c of f.contours) {
    const pts = flatten(c),
      st = startOf(c);
    const all = [st, ...pts, st];
    for (let i = 0; i + 1 < all.length; i++) {
      const p = all[i],
        q = all[i + 1];
      if (p[1] === q[1]) continue;
      const lo = Math.min(p[1], q[1]),
        hi = Math.max(p[1], q[1]),
        dir = q[1] > p[1] ? 1 : -1;
      const k0 = Math.max(0, Math.ceil(lo * R - 0.5)),
        k1 = Math.min(size * R - 1, Math.ceil(hi * R - 0.5) - 1);
      for (let k = k0; k <= k1; k++) {
        const Y = (k + 0.5) / R,
          t = (Y - p[1]) / (q[1] - p[1]);
        lines[k].push([p[0] + (q[0] - p[0]) * t, dir]);
      }
    }
  }
  for (let k = 0; k < size * R; k++) {
    const ev = lines[k].sort((a, b) => a[0] - b[0]);
    const row = Math.floor(k / R);
    let w = 0;
    for (let i = 0; i + 1 < ev.length; i++) {
      w += ev[i][1];
      const filled =
        mode === 'winding' ? w !== 0 : f.rule === 'evenodd' ? ((i + 1) & 1) === 1 : w !== 0;
      if (!filled) continue;
      const weight = mode === 'winding' ? w : 1;
      const xa = Math.min(size, Math.max(0, ev[i][0])),
        xb = Math.min(size, Math.max(0, ev[i + 1][0]));
      if (xb <= xa) continue;
      for (let px = Math.floor(xa); px <= Math.min(size - 1, Math.ceil(xb) - 1); px++)
        area[row * size + px] += (weight * (Math.min(xb, px + 1) - Math.max(xa, px))) / R;
    }
  }
  return area;
}
// px over 1 byte / over 8 bytes / max byte of a 0..255 alpha image (row 0 at the top) against the exact area
export function score(alpha, ref) {
  let o1 = 0,
    o8 = 0,
    max = 0,
    at = null;
  for (let i = 0; i < ref.length; i++) {
    const e = Math.abs(alpha[i] - ref[i] * 255);
    if (e > 1) o1++;
    if (e > 8) o8++;
    if (e > max) {
      max = e;
      at = [i % SIZE, Math.floor(i / SIZE)];
    }
  }
  return { over1: o1, over8: o8, max: +max.toFixed(3), at };
}

// ---- the fixtures ----
// `expect`: 'fix' = the certificate normalizes this paint (raw coverage must reach <= 1 byte against the exact area);
//           'keep' = it must stay as authored (a negative or control case: nothing may change).
const F = (name, rule, contours, expect, extra = {}) => ({
  name,
  rule,
  contours,
  expect,
  ...extra,
});
export const fixtures = [
  F('nested-circles-same-nz', 'nonzero', [circle(16, 16, 12), circle(16, 16, 11.6)], 'fix'),
  F(
    'nested-ellipses-same-nz',
    'nonzero',
    [ellipse(16, 16, 13, 8, 30), ellipse(16, 16, 12.6, 7.7, 30)],
    'fix',
  ),
  F('thin-ring-circles-eo', 'evenodd', [circle(16, 16, 12), circle(16, 16, 11.7)], 'fix'),
  F(
    'thin-ring-ellipses-eo',
    'evenodd',
    [ellipse(16, 16, 13, 8, 30), ellipse(16, 16, 12.75, 7.75, 30)],
    'fix',
  ),
  F(
    'thin-ring-circles-eo-opposite',
    'evenodd',
    [circle(16, 16, 12), circle(16, 16, 11.7, true)],
    'keep',
  ),
  F(
    'nested-circles-opposite-nz',
    'nonzero',
    [circle(16, 16, 12), circle(16, 16, 11.6, true)],
    'keep',
  ),
  F(
    'rounded-rects-nested-nz',
    'nonzero',
    [roundRect(4, 6, 24, 20, 5), roundRect(4.3, 6.3, 23.4, 19.4, 4.7)],
    'fix',
  ),
  F(
    'rounded-rect-frame-eo',
    'evenodd',
    [roundRect(4, 6, 24, 20, 5), roundRect(4.25, 6.25, 23.5, 19.5, 4.75)],
    'fix',
  ),
  F(
    'pies-nested-nz',
    'nonzero',
    [pie(16, 16, 13, -20, 250), pie(16 - 0.126, 16 + 0.272, 12.6, -5, 235)],
    'fix',
  ),
  F('tangent-circles-nz', 'nonzero', [circle(16, 16, 12), circle(15.6, 16, 11.6)], 'fix'),
  F('tangent-circles-eo', 'evenodd', [circle(16, 16, 12), circle(15.6, 16, 11.6)], 'fix'),
  F(
    'tangent-diagonal-eo',
    'evenodd',
    [circle(16, 16, 12), circle(16 - 0.4 * Math.SQRT1_2, 16 - 0.4 * Math.SQRT1_2, 11.6)],
    'fix',
  ),
  F(
    'tangent-diagonal-nz',
    'nonzero',
    [circle(16, 16, 12), circle(16 - 0.4 * Math.SQRT1_2, 16 - 0.4 * Math.SQRT1_2, 11.6)],
    'fix',
  ),
  F(
    'triple-nested-eo',
    'evenodd',
    [circle(16, 16, 12), circle(16, 16, 11.7), circle(16, 16, 11.4)],
    'fix',
  ),
  F(
    'disjoint-opposite-tiny-nz',
    'nonzero',
    [circle(15.3, 16.5, 0.15), circle(15.7, 16.5, 0.15, true)],
    'fix',
  ),
  F('nested-tiny-nz', 'nonzero', [circle(16.5, 16.5, 0.45), circle(16.5, 16.5, 0.3)], 'fix'),
  F(
    'ring-tiny-eo',
    'evenodd',
    [ellipse(16.5, 16.5, 0.45, 0.4, 25), ellipse(16.5, 16.5, 0.35, 0.3, 25)],
    'fix',
  ),
  F(
    'tangent-tiny-eo',
    'evenodd',
    [circle(16.5, 16.5, 0.45), circle(16.5 - 0.1, 16.5, 0.35)],
    'fix',
  ),
  F(
    'half-discs-nested-nz',
    'nonzero',
    [halfDisc(16, 16, 12, 0), halfDisc(16, 16.3, 11.6, 0)],
    'fix',
  ),
  F('crossing-circles-eo', 'evenodd', [circle(14, 16, 8), circle(18, 16, 8)], 'keep'),
  F('separate-circles-nz', 'nonzero', [circle(10, 16, 6), circle(22, 16, 6)], 'keep'),
];

// ---- the same geometry as the importer's segment list (so the certificate can be driven without an SVG round trip) ----
// Arcs carry the importer's center form plus the path endpoints; every contour ends with the zero-length closing marker.
import { mkLine } from '../../src/primitives/seg.js';
import { mkArc } from '../../src/svg/segment.js';
export function segsOf(f) {
  const out = [];
  for (const c of f.contours) {
    const st = startOf(c);
    let pen = st;
    c.forEach((s, i) => {
      const last = i === c.length - 1,
        end = last ? st : segEnd(s);
      if (s.L) out.push(mkLine(pen, end));
      else {
        const a = s.A;
        out.push(
          mkArc(
            a.cx,
            a.cy,
            a.rx,
            a.ry,
            a.a0 * D2R,
            a.a1 * D2R,
            a.phi * D2R,
            Math.abs(a.a1 - a.a0) > 180 ? 1 : 0,
            a.a1 > a.a0 ? 1 : 0,
            pen,
            end,
          ),
        );
      }
      pen = end;
    });
    out.push(mkLine(st, st, true));
  }
  return out;
}
// a segment list (closed contours, each ending in a fill-only marker) back to a fixture, for the oracle
export function fixtureOf(segs, rule) {
  const contours = [];
  let cur = [];
  for (const g of segs) {
    if (g.is_fill_only === true) {
      if (cur.length) contours.push(cur);
      cur = [];
      continue;
    }
    if (!cur.length) cur.start = g.p1;
    if (g.type === 0) cur.push({ L: g.p2 });
    else
      cur.push({
        A: {
          cx: g.cx,
          cy: g.cy,
          rx: g.rx,
          ry: g.ry,
          phi: g.phi / D2R,
          a0: g.theta_start / D2R,
          a1: g.theta_end / D2R,
        },
      });
  }
  if (cur.length) contours.push(cur);
  return { rule, contours };
}
