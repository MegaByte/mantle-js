// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// _strokeSeamCases.mjs -- the closed-dashed-contour case set shared by strokeDashSeamSmoke.mjs and the dash-seam tables:
// closed shapes as oracle subpaths ({segs:[{t:'L'|'Q'|'C', p}], closed}), the SVG text
// that draws them, and the oracle's membership test for a dashed, capped, joined stroke of them (test/_strokeDashOracle.mjs
// dashClosed: SVG 2 semantics, one dash through the seam when it is on at both ends).
import * as O from './_strokeDashOracle.mjs';

const K = 0.5522847498307936; // the 4-cubic circle's handle
const f = (v) => String(+v.toPrecision(17));
const P = (x, y) => [x, y];

/// A path d string back to oracle subpaths. Absolute and relative M L H V Q C Z only (what the shapes and segsToPathD emit).
export function parsePathD(d) {
  const tok = d.match(/[MmLlHhVvQqCcZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const subs = [];
  let cur = null,
    pen = [0, 0],
    start = [0, 0],
    i = 0,
    cmd = '';
  const num = () => +tok[i++];
  const close = () => {
    if (cur && cur.segs.length) {
      if (Math.hypot(pen[0] - start[0], pen[1] - start[1]) > 0)
        cur.segs.push({ t: 'L', p: [pen, start] });
      cur.closed = true;
      pen = start;
    }
  };
  while (i < tok.length) {
    if (/[A-Za-z]/.test(tok[i])) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase(),
      C = cmd.toUpperCase(),
      ox = rel ? pen[0] : 0,
      oy = rel ? pen[1] : 0;
    if (C === 'M') {
      cur = { segs: [], closed: false };
      subs.push(cur);
      pen = [ox + num(), oy + num()];
      start = pen;
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L') {
      const q = [ox + num(), oy + num()];
      cur.segs.push({ t: 'L', p: [pen, q] });
      pen = q;
    } else if (C === 'H') {
      const q = [ox + num(), pen[1]];
      cur.segs.push({ t: 'L', p: [pen, q] });
      pen = q;
    } else if (C === 'V') {
      const q = [pen[0], oy + num()];
      cur.segs.push({ t: 'L', p: [pen, q] });
      pen = q;
    } else if (C === 'Q') {
      const c = [ox + num(), oy + num()],
        q = [ox + num(), oy + num()];
      cur.segs.push({ t: 'Q', p: [pen, c, q] });
      pen = q;
    } else if (C === 'C') {
      const c1 = [ox + num(), oy + num()],
        c2 = [ox + num(), oy + num()],
        q = [ox + num(), oy + num()];
      cur.segs.push({ t: 'C', p: [pen, c1, c2, q] });
      pen = q;
    } else if (C === 'Z') {
      close();
      cmd = 'M';
    } else throw new Error('parsePathD: ' + cmd);
  }
  return subs.filter((s) => s.segs.length);
}
const dOf = (subs) =>
  subs
    .map((s) => {
      let out = 'M' + s.segs[0].p[0].map(f).join(' ');
      for (const g of s.segs)
        out +=
          ' ' +
          g.t +
          g.p
            .slice(1)
            .map((p) => p.map(f).join(' '))
            .join(' ');
      return out + (s.closed ? ' Z' : '');
    })
    .join(' ');

function circleSegs(cx, cy, r, a0) {
  // (rounded to 1e-9 and closed exactly: a last point 1e-14 off the first would make the closing Z a tiny extra line)
  const rd = (p) => p.map((v) => Math.round(v * 1e9) / 1e9);
  const segs = [],
    pt = (a) => rd([cx + r * Math.cos(a), cy + r * Math.sin(a)]),
    dr = (a) => [-r * Math.sin(a), r * Math.cos(a)];
  const first = pt(a0);
  for (let k = 0; k < 4; k++) {
    const t0 = a0 + (k * Math.PI) / 2,
      t1 = t0 + Math.PI / 2,
      p0 = k ? segs[k - 1].p[3] : first,
      p3 = k === 3 ? first : pt(t1),
      d0 = dr(t0),
      d3 = dr(t1);
    segs.push({
      t: 'C',
      p: [
        p0,
        rd([p0[0] + K * d0[0], p0[1] + K * d0[1]]),
        rd([p3[0] - K * d3[0], p3[1] - K * d3[1]]),
        p3,
      ],
    });
  }
  return segs;
}
const closedPath = (segs) => ({ segs, closed: true });
const poly = (pts) =>
  closedPath(pts.map((p, k) => ({ t: 'L', p: [p, pts[(k + 1) % pts.length]] })));
function roundRect(x, y, w, h, r, startMid) {
  const k = K * r;
  const s = [
    { t: 'L', p: [P(x + r, y), P(x + w - r, y)] },
    { t: 'C', p: [P(x + w - r, y), P(x + w - r + k, y), P(x + w, y + r - k), P(x + w, y + r)] },
    { t: 'L', p: [P(x + w, y + r), P(x + w, y + h - r)] },
    {
      t: 'C',
      p: [
        P(x + w, y + h - r),
        P(x + w, y + h - r + k),
        P(x + w - r + k, y + h),
        P(x + w - r, y + h),
      ],
    },
    { t: 'L', p: [P(x + w - r, y + h), P(x + r, y + h)] },
    { t: 'C', p: [P(x + r, y + h), P(x + r - k, y + h), P(x, y + h - r + k), P(x, y + h - r)] },
    { t: 'L', p: [P(x, y + h - r), P(x, y + r)] },
    { t: 'C', p: [P(x, y + r), P(x, y + r - k), P(x + r - k, y), P(x + r, y)] },
  ];
  if (!startMid) return closedPath(s);
  // start at the middle of the top edge: split the first line
  const m = P(x + w / 2, y),
    a = s[0];
  return closedPath([{ t: 'L', p: [m, a.p[1]] }, ...s.slice(1), { t: 'L', p: [a.p[0], m] }]);
}

/// The shapes: { id, subs, seam: the seam vertex(es) (the window centers), what }. All in a 100 x 100 user box.
export function shapes() {
  const S = [];
  S.push({
    id: 'square',
    what: 'square, seam at a corner',
    exact: true,
    subs: [poly([P(25, 25), P(75, 25), P(75, 75), P(25, 75)])],
  });
  S.push({
    id: 'squareEdge',
    what: 'square, seam mid-edge (a straight edge)',
    exact: true,
    subs: [
      closedPath([
        { t: 'L', p: [P(50, 25), P(75, 25)] },
        { t: 'L', p: [P(75, 25), P(75, 75)] },
        { t: 'L', p: [P(75, 75), P(25, 75)] },
        { t: 'L', p: [P(25, 75), P(25, 25)] },
        { t: 'L', p: [P(25, 25), P(50, 25)] },
      ]),
    ],
  });
  S.push({
    id: 'tri',
    what: 'triangle, seam at a corner',
    subs: [poly([P(50, 20), P(80, 75), P(20, 75)])],
  });
  S.push({
    id: 'tri345',
    what: 'a 3-4-5 triangle (exact side lengths 30, 50, 40: L = 120), seam at a corner',
    exact: true,
    subs: [poly([P(30, 30), P(60, 30), P(30, 70)])],
  });
  S.push({
    id: 'triEdge',
    what: 'triangle, seam mid-edge',
    subs: [
      closedPath([
        { t: 'L', p: [P(65, 47.5), P(80, 75)] },
        { t: 'L', p: [P(80, 75), P(20, 75)] },
        { t: 'L', p: [P(20, 75), P(50, 20)] },
        { t: 'L', p: [P(50, 20), P(65, 47.5)] },
      ]),
    ],
  });
  S.push({
    id: 'circle',
    what: 'circle as 4 cubics, seam at a smooth cubic joint',
    subs: [closedPath(circleSegs(50, 50, 28, 0))],
  });
  S.push({
    id: 'circle37',
    what: 'circle as 4 cubics, seam at 37 degrees',
    subs: [closedPath(circleSegs(50, 50, 28, (37 * Math.PI) / 180))],
  });
  S.push({
    id: 'rrect',
    what: 'rounded rect, seam at the end of the top edge',
    subs: [roundRect(20, 30, 60, 40, 10, false)],
  });
  S.push({
    id: 'rrectMid',
    what: 'rounded rect, seam mid top edge',
    subs: [roundRect(20, 30, 60, 40, 10, true)],
  });
  S.push({
    id: 'loop',
    what: 'one closed cubic (a single segment that meets itself)',
    subs: [closedPath([{ t: 'C', p: [P(50, 72), P(8, 8), P(92, 8), P(50, 72)] }])],
  });
  // the same loop as two cubics (de Casteljau at t = 1/2): the seam is then a vertex between two segments, not one segment meeting itself
  {
    const [p0, p1, p2, p3] = S[S.length - 1].subs[0].segs[0].p,
      m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const a = m(p0, p1),
      b = m(p1, p2),
      c = m(p2, p3),
      ab = m(a, b),
      bc = m(b, c),
      mid = m(ab, bc);
    S.push({
      id: 'loop2',
      what: 'the loop as two cubics',
      subs: [
        closedPath([
          { t: 'C', p: [p0, a, ab, mid] },
          { t: 'C', p: [mid, bc, c, p3] },
        ]),
      ],
    });
  }
  return S;
}

/// The seam point(s) of a shape: the start of each closed subpath.
export const seamsOf = (subs) => subs.map((s) => s.segs[0].p[0]);

export function dOfSubs(subs, S = 1) {
  return dOf(S === 1 ? subs : scaleSubs(subs, S));
}
export function scaleSubs(subs, S) {
  return subs.map((s) => ({
    closed: s.closed,
    segs: s.segs.map((g) => ({ t: g.t, p: g.p.map((p) => [p[0] * S, p[1] * S]) })),
  }));
}

/// SVG text for one case (scale S: the whole picture is drawn S times larger in a viewBox 100 S wide; ePx = S then).
export function svgFor(c) {
  const S = c.S || 1,
    subs = c.subs,
    attrs =
      `stroke="#000" fill="none" stroke-width="${f(2 * c.hw * S)}" stroke-linecap="${c.cap}" stroke-linejoin="${c.join}" stroke-miterlimit="${c.ml || 4}"` +
      (c.dash
        ? ` stroke-dasharray="${c.dash.map((v) => f(v * S)).join(' ')}" stroke-dashoffset="${f(c.doff * S)}"`
        : '') +
      (c.pathLength ? ` pathLength="${f(c.pathLength * S)}"` : '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 ${f(100 * S)} ${f(100 * S)}"><path d="${dOf(scaleSubs(subs, S))}" ${attrs}/></svg>`;
}

/// The oracle's membership test for a case: the pieces of every subpath (each dashed from its own start), in user units.
export function insideFor(c) {
  const wp = O.wholeSubpaths(c.subs);
  if (!c.dash) return (p) => O.inside(p, wp, c.hw, c.cap, c.join, c.ml || 4);
  let dash = c.dash;
  if (c.pathLength) {
    // pathLength rescales every dash length (and the offset) by length / pathLength
    const tot = wp.reduce((a, s) => a + O.subLen(s), 0),
      k = tot / c.pathLength;
    dash = dash.map((v) => v * k);
  }
  const doff = c.pathLength
    ? c.doff * (wp.reduce((a, s) => a + O.subLen(s), 0) / c.pathLength)
    : c.doff;
  // c.mode 'chrome' (importSvg compat: 'chrome'; Chrome/Skia): a dash on at both ends of a closed subpath continues through the seam with a join. Otherwise 'spec'
  // (the default): SVG 2 13.5.7 lays the dashes along each subpath from its start to its end, each with its own caps and joins only between segments inside a
  // dash, so the seam is two dash ends (dashSub, which cuts the subpath as an open one).
  const pieces = wp.flatMap((s) =>
    s.closed && c.mode === 'chrome'
      ? O.dashClosed(s, dash, doff)
      : O.dashSub(s, dash, doff).filter((p) => !p.zero),
  );
  return (p) => O.inside(p, pieces, c.hw, c.cap, c.join, c.ml || 4);
}

/// The seam's dash state for a case, from the oracle's arithmetic: [F, E, L] -- on just after the start, on just before the end,
/// and the (first) subpath's length. It labels rows and proves a case set reaches every combination.
export function seamState(c) {
  const wp = O.wholeSubpaths(c.subs)[0],
    L = O.subLen(wp),
    k = c.pathLength ? L / c.pathLength : 1;
  const D0 = (c.dash.length % 2 ? c.dash.concat(c.dash) : c.dash).map((v) => v * k),
    T = D0.reduce((a, b) => a + b, 0);
  c = { ...c, doff: c.doff * k };
  const on = (pos, after) => {
    let d = ((pos % T) + T) % T;
    if (!after && d === 0) d = T;
    let a = 0;
    for (let k = 0; k < D0.length; k++) {
      if (k % 2 === 0 && D0[k] > 0 && (after ? d >= a && d < a + D0[k] : d > a && d <= a + D0[k]))
        return true;
      a += D0[k];
    }
    return false;
  };
  return [on(c.doff, true), on(L + c.doff, false), L];
}

/// [dash, offset] in TRUE length units (a pathLength rescales both by the subpaths' length over pathLength).
export function trueDash(c) {
  if (!c.pathLength) return [c.dash, c.doff];
  const k = O.wholeSubpaths(c.subs).reduce((a, s) => a + O.subLen(s), 0) / c.pathLength;
  return [c.dash.map((v) => v * k), c.doff * k];
}

/// importSvg options for a case: its compat mode.
export const importOpts = (c) => ({
  preserveViewport: true,
  compat: c.mode === 'chrome' ? 'chrome' : 'spec',
});
