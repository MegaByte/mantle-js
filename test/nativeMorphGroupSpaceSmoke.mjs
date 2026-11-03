// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// nativeMorphGroupSpaceSmoke.mjs: a native morph draws in the COORDINATES of the element it lands on (node, CPU only).
//
// The bundle's curves are stored in bundle coordinates, after every ancestor transform and the shape's own. The morph decodes the
// lerped curves into a path `d`; the retained <path> sits inside those transforms again, so the `d` that lands on it has to be
// carried back through inverse(CTM) or the shape draws displaced (a <g transform="translate(30 10)"> moved it by (30, 10)).
//
// The oracle is independent of the morph code: resolve the drawn element's `d` through its REAL transform chain (every transform attribute
// from the scene root down to it) and compare the point set to the same pose imported as a STATIC svg (t = 0 and t = 1) and to a
// static pose authored at the average geometry (t = 0.5). Distances are polyline Hausdorff, so a re-parameterized arc is fine.
//   cases: one group, nested rotate/scale groups, skew + non-uniform scale with an own transform, an own transform alone, <use> (two
//   instances of one template, with x/y and a transform), a stroke width that moves under a scale (local units), local and group overrides
//   (a morph at t = 0 must equal the static draw with the same overrides).
import { M, wrap, imp, dom, els, check, finish } from './_exportHarness.mjs';
import { curveRangeToPathD } from '../src/fallback/curveToPathD.js';
import { parseTransform, matMul } from '../src/svg/transform.js';

// ---- oracle ------------------------------------------------------------------------------------------------------------------
function flatten(d) {
  const pts = [],
    toks = d.match(/[MLQCAZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  let i = 0,
    cx = 0,
    cy = 0,
    sx = 0,
    sy = 0,
    cmd = '';
  const num = () => +toks[i++];
  const N = 48;
  while (i < toks.length) {
    if (/[MLQCAZ]/.test(toks[i])) cmd = toks[i++];
    if (cmd === 'Z') {
      for (let k = 1; k <= N; k++) pts.push([cx + ((sx - cx) * k) / N, cy + ((sy - cy) * k) / N]);
      cx = sx;
      cy = sy;
      continue;
    }
    if (cmd === 'M') {
      cx = sx = num();
      cy = sy = num();
      pts.push([cx, cy]);
      cmd = 'L';
      continue;
    }
    if (cmd === 'L') {
      const x = num(),
        y = num();
      for (let k = 1; k <= N; k++) pts.push([cx + ((x - cx) * k) / N, cy + ((y - cy) * k) / N]);
      cx = x;
      cy = y;
      continue;
    }
    if (cmd === 'Q') {
      const ax = num(),
        ay = num(),
        x = num(),
        y = num();
      for (let k = 1; k <= N; k++) {
        const t = k / N,
          u = 1 - t;
        pts.push([
          u * u * cx + 2 * u * t * ax + t * t * x,
          u * u * cy + 2 * u * t * ay + t * t * y,
        ]);
      }
      cx = x;
      cy = y;
      continue;
    }
    if (cmd === 'C') {
      const ax = num(),
        ay = num(),
        bx = num(),
        by = num(),
        x = num(),
        y = num();
      for (let k = 1; k <= N; k++) {
        const t = k / N,
          u = 1 - t;
        pts.push([
          u * u * u * cx + 3 * u * u * t * ax + 3 * u * t * t * bx + t * t * t * x,
          u * u * u * cy + 3 * u * u * t * ay + 3 * u * t * t * by + t * t * t * y,
        ]);
      }
      cx = x;
      cy = y;
      continue;
    }
    if (cmd === 'A') {
      // SVG F.6.5 endpoint -> center
      let rx = Math.abs(num()),
        ry = Math.abs(num());
      const phi = (num() * Math.PI) / 180,
        fa = num(),
        fs = num(),
        x = num(),
        y = num();
      const cp = Math.cos(phi),
        sp = Math.sin(phi),
        dx = (cx - x) / 2,
        dy = (cy - y) / 2;
      const x1 = cp * dx + sp * dy,
        y1 = -sp * dx + cp * dy;
      const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
      if (lam > 1) {
        rx *= Math.sqrt(lam);
        ry *= Math.sqrt(lam);
      }
      const sgn = fa === fs ? -1 : 1,
        num2 = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1,
        den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
      const co = sgn * Math.sqrt(Math.max(0, num2 / den)),
        cxp = (co * rx * y1) / ry,
        cyp = (-co * ry * x1) / rx;
      const ccx = cp * cxp - sp * cyp + (cx + x) / 2,
        ccy = sp * cxp + cp * cyp + (cy + y) / 2;
      const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
      const th1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
      let dth = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
      if (!fs && dth > 0) dth -= 2 * Math.PI;
      else if (fs && dth < 0) dth += 2 * Math.PI;
      for (let k = 1; k <= 4 * N; k++) {
        const th = th1 + (dth * k) / (4 * N);
        pts.push([
          ccx + rx * Math.cos(th) * cp - ry * Math.sin(th) * sp,
          ccy + rx * Math.cos(th) * sp + ry * Math.sin(th) * cp,
        ]);
      }
      cx = x;
      cy = y;
      continue;
    }
    throw new Error('flatten: ' + cmd);
  }
  return pts;
}
const hausdorff = (A, B) => {
  const one = (P, Q) => {
    let w = 0;
    for (const p of P) {
      let m = Infinity;
      for (const q of Q) {
        const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
        if (d < m) m = d;
      }
      if (m > w) w = m;
    }
    return w;
  };
  return Math.max(one(A, B), one(B, A));
};
/** The element's geometry in the scene's root space: its `d` through every transform attribute from the root down, and through
 *  the viewport fit of every nested <svg> on the way (an independent restatement: x/y, width/height (default: the 100x100 root),
 *  viewBox, preserveAspectRatio meet with none / xMin|xMid|xMax and YMin|YMid|YMax). */
function viewportFit(n) {
  const num = (a, d) => (n.getAttribute(a) == null ? d : parseFloat(n.getAttribute(a)));
  const x = num('x', 0),
    y = num('y', 0),
    w = num('width', 100),
    h = num('height', 100);
  const vb = (n.getAttribute('viewBox') || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (vb.length !== 4) return [1, 0, 0, 1, x, y];
  const par = (n.getAttribute('preserveAspectRatio') || 'xMidYMid meet').trim().split(/\s+/)[0];
  let sx = w / vb[2],
    sy = h / vb[3],
    ox = 0,
    oy = 0;
  if (par !== 'none') {
    sx = sy = Math.min(sx, sy);
    const fx = /xMin/.test(par) ? 0 : /xMax/.test(par) ? 1 : 0.5,
      fy = /YMin/.test(par) ? 0 : /YMax/.test(par) ? 1 : 0.5;
    ox = (w - vb[2] * sx) * fx;
    oy = (h - vb[3] * sy) * fy;
  }
  return [sx, 0, 0, sy, x + ox - vb[0] * sx, y + oy - vb[1] * sy];
}
function resolved(el, root) {
  let m = [1, 0, 0, 1, 0, 0];
  for (let n = el; n && n.nodeType === 1 && n !== root; n = n.parentNode) {
    let local = n.getAttribute('transform') ? parseTransform(n.getAttribute('transform')) : null;
    if (n !== el && n.localName === 'svg')
      local = local ? matMul(local, viewportFit(n)) : viewportFit(n);
    if (local) m = matMul(local, m);
  }
  return flatten(el.getAttribute('d')).map(([x, y]) => [
    m[0] * x + m[2] * y + m[4],
    m[1] * x + m[3] * y + m[5],
  ]);
}
/** A static pose's geometry for the shape with this data-oid, in bundle coordinates (what a correct morph endpoint must draw). */
function poseGeometry(bundle, id) {
  const row = bundle.shapeIds.indexOf(id),
    r = bundle.curveRangesByShape[row];
  return flatten(curveRangeToPathD(new Float32Array(bundle.curves), r.begin, r.end));
}
function draw(bundle, overrides, host) {
  const scene = M.createNativeScene(dom.createElement('div'), { document: dom });
  scene.setViewport(100, 100);
  scene.beginFrame([0, 0, 0, 0]);
  scene.drawBundle(bundle, { overrides });
  scene.endFrame();
  return scene;
}
const inDefs = (e) => {
  for (let n = e.parentNode; n && n.nodeType === 1; n = n.parentNode)
    if (n.localName === 'defs') return true;
  return false;
};
const byOid = (scene, oid) =>
  els(scene.svg, '*').filter((e) => e.getAttribute('data-oid') === oid && !inDefs(e));

import { CASES, PA, PB, MID, shapes } from './_nativeMorphGroupArt.mjs';

const bundles = {};
for (const [name, mk] of Object.entries(CASES)) {
  const [a, b, mid] = await Promise.all([imp(wrap(mk(PA))), imp(wrap(mk(PB))), imp(wrap(mk(MID)))]);
  bundles[name] = { a, b, mid };
  const nm = M.createNativeMorph(a, b);
  for (const [t, pose, label] of [
    [0, a, 'A'],
    [1, b, 'B'],
    [0.5, mid, 'mid'],
  ]) {
    nm.setT(t);
    const scene = draw(nm.bundle, nm.overrides);
    const worst = { p: 0, c: 0 },
      counts = {};
    for (const oid of ['p', 'c']) {
      const drawn = byOid(scene, oid);
      // a <use> case draws one element per instance: row k <-> instance k, in document order
      const rows = pose.shapeIds.map((id, i) => (id === oid ? i : -1)).filter((i) => i >= 0);
      counts[oid] = [drawn.length, rows.length];
      // geometry of a row: poseGeometry looks the first row up by id, so pick by row index
      rows.forEach((row, k) => {
        const r = pose.curveRangesByShape[row];
        const want = flatten(curveRangeToPathD(new Float32Array(pose.curves), r.begin, r.end));
        const el = drawn[k];
        worst[oid] = Math.max(
          worst[oid],
          el && el.getAttribute('d') ? hausdorff(resolved(el, scene.svg), want) : Infinity,
        );
      });
    }
    check(
      `${name} t=${t} (${label}): p within 0.1 of the static pose`,
      worst.p < 0.1,
      `Hausdorff ${worst.p} ${JSON.stringify(counts)}`,
    );
    check(
      `${name} t=${t} (${label}): circle within 0.1 of the static pose`,
      worst.c < 0.1,
      `Hausdorff ${worst.c} ${JSON.stringify(counts)}`,
    );
    scene.dispose();
  }
  nm.dispose();
}

// ---- stroke width is written in the element's own units ------------------------------------------------------------------------
for (const [name, wrapG, factor] of [
  ['scale 2', 'scale(2)', 2],
  ['scale 2x3 (sMax 3)', 'scale(2 3)', 3],
  ['rotate+scale', 'rotate(40) scale(1.5)', 1.5],
]) {
  const mk = (w) =>
    wrap(
      `<g transform="${wrapG}"><path id="s" d="M0 0L20 0L20 20" fill="none" stroke="#000" stroke-width="${w}"/></g>`,
    );
  const a = await imp(mk(2)),
    b = await imp(mk(6));
  const nm = M.createNativeMorph(a, b);
  nm.setT(0.5);
  const scene = draw(nm.bundle, nm.overrides);
  const el = byOid(scene, 's')[0];
  const got = +el.getAttribute('stroke-width');
  check(
    `stroke width under ${name}: local 4, drawn ${4 * factor} in bundle units`,
    Math.abs(got - 4) < 1e-4,
    `stroke-width ${got}`,
  );
  scene.dispose();
  nm.dispose();
}

// ---- overrides: at t = 0 a morph must draw exactly what the static pose draws with the same overrides ---------------------------
{
  const mk = (P) =>
    `<g id="g" transform="translate(12 4) scale(1.3 0.8)">${shapes(P, 'rotate(10)')}</g>`;
  const a = await imp(wrap(mk(PA))),
    b = await imp(wrap(mk(PB))),
    plain = await imp(wrap(mk(PA))); // `plain`: createNativeMorph stashes its geometry on its src bundle, so the static draw needs its own
  const rowP = a.shapeIds.indexOf('p');
  for (const [name, apply] of [
    ['local position', (ov) => ov.update(rowP, { localPosition: [7, -3] })],
    [
      'local rotation + scale',
      (ov) => ov.update(rowP, { localRotation: 0.4, localScale: [1.5, 0.6] }),
    ],
    [
      'group override (position)',
      (ov) => {
        const g = a.shapeIds.indexOf('g');
        ov.update(g >= 0 ? g : 0, { localPosition: [9, 5] });
      },
    ],
  ]) {
    const nm = M.createNativeMorph(a, b);
    nm.setT(0);
    apply(nm.overrides);
    const staticOv = M.createNativeOverrideTable(plain);
    apply(staticOv);
    const moved = draw(nm.bundle, nm.overrides),
      still = draw(plain, staticOv);
    const d = hausdorff(
      resolved(byOid(moved, 'p')[0], moved.svg),
      resolved(byOid(still, 'p')[0], still.svg),
    );
    if (process.env.DBG) {
      const { xmldom } = await import('./_domShim.mjs');
      console.log(
        new xmldom.XMLSerializer().serializeToString(moved.svg),
        '\n',
        new xmldom.XMLSerializer().serializeToString(still.svg),
      );
    }
    check(
      `override (${name}): the morph at t=0 draws where the static pose draws`,
      d < 0.1,
      `Hausdorff ${d}`,
    );
    moved.dispose();
    still.dispose();
    nm.dispose();
  }
}
// ---- the other geometry writers reach the instance the same way (pathD override, streamed segments, paint override) ------
{
  for (const name of ['nestedUse', 'symbol', 'svgTarget', 'nestedSymbol']) {
    const mk = CASES[name];
    const a = await imp(wrap(mk(PA))),
      b = await imp(wrap(mk(PB)));
    // pathD override: row r takes pose B's curves for that row (bundle coordinates, as the morph writes them)
    const ov = M.createNativeOverrideTable(a);
    a.shapeIds.forEach((id, row) => {
      if (id !== 'p' && id !== 'c') return;
      const r = b.curveRangesByShape[row];
      ov.update(row, { pathD: curveRangeToPathD(new Float32Array(b.curves), r.begin, r.end) });
    });
    const scene = draw(a, ov);
    let worst = 0,
      n = 0;
    for (const oid of ['p', 'c']) {
      const rows = b.shapeIds.map((id, i) => (id === oid ? i : -1)).filter((i) => i >= 0),
        drawn = byOid(scene, oid);
      rows.forEach((row, k) => {
        const r = b.curveRangesByShape[row];
        const want = flatten(curveRangeToPathD(new Float32Array(b.curves), r.begin, r.end));
        worst = Math.max(
          worst,
          drawn[k] && drawn[k].getAttribute('d')
            ? hausdorff(resolved(drawn[k], scene.svg), want)
            : Infinity,
        );
        n++;
      });
    }
    check(
      `${name}: a pathD override lands on every instance (${n} rows)`,
      worst < 0.1,
      `Hausdorff ${worst}`,
    );
    scene.dispose();
  }
}

// a morphed gradient paint reaches every instance of a symbol / nested use (each one's own <path> gets the tweened gradient)
for (const [name, body] of [
  [
    'symbol',
    (c1, c2) =>
      `<defs><linearGradient id="g"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient><symbol id="s" viewBox="0 0 100 100"><rect id="r" width="50" height="50" fill="url(#g)"/></symbol></defs><use href="#s" width="50" height="50"/><use href="#s" x="50" y="50" width="50" height="50"/>`,
  ],
  [
    'nested use',
    (c1, c2) =>
      `<defs><linearGradient id="g"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient><rect id="r" width="50" height="50" fill="url(#g)"/><g id="o"><use href="#r"/></g></defs><use href="#o"/><use href="#o" x="50" y="50"/>`,
  ],
]) {
  const a = await imp(wrap(body('#ff0000', '#0000ff'))),
    b = await imp(wrap(body('#00ff00', '#ffff00')));
  const nm = M.createNativeMorph(a, b);
  nm.setT(1);
  const scene = draw(nm.bundle, nm.overrides);
  const paths = byOid(scene, 'r');
  const first = paths.map((e) => {
    const id = (e.getAttribute('fill') || '').replace(/^url\(#(.*)\)$/, '$1');
    const g = els(scene.svg, '*').find((x) => x.getAttribute('id') === id);
    return g && els(g, 'stop')[0].getAttribute('stop-color');
  });
  check(
    `gradient paint morph, ${name}: both instances take the tweened gradient`,
    paths.length === 2 && first.every((c) => c === 'rgb(0,255,0)'),
    JSON.stringify(first),
  );
  scene.dispose();
  nm.dispose();
}
// the split must not renumber the shapes drawn after a <use> (the copies are the use's rows, not rendered leaves), and a <use> that also
// sits in a <clipPath> keeps its visible instance animated
for (const [name, body] of [
  [
    'rect after the use',
    (w, rw) =>
      `<defs><path id="s" d="M0 0L${w} 0L${w} 30Z"/></defs><use href="#s" x="10" y="10"/><rect id="r" x="30" y="60" width="${rw}" height="20"/>`,
  ],
  [
    'rect after a use that is also a clip',
    (w, rw) =>
      `<defs><path id="s" d="M0 0L${w} 0L${w} 30Z"/><clipPath id="c"><use href="#s"/></clipPath></defs><use href="#s" x="10" y="10"/><rect id="r" x="30" y="60" width="${rw}" height="20" clip-path="url(#c)"/>`,
  ],
]) {
  const a = await imp(wrap(body(40, 50))),
    b = await imp(wrap(body(60, 70)));
  const nm = M.createNativeMorph(a, b);
  nm.setT(1);
  const scene = draw(nm.bundle, nm.overrides);
  let worst = 0;
  for (const oid of ['s', 'r']) {
    const row = b.shapeIds.indexOf(oid),
      r = b.curveRangesByShape[row];
    const want = flatten(curveRangeToPathD(new Float32Array(b.curves), r.begin, r.end)),
      el = byOid(scene, oid)[0];
    // a rect is drawn as a path whose oid is the rect's (the clip case keeps no oid on the converted path: find it by its fill-less path after the use)
    const got =
      el && el.getAttribute('d')
        ? el
        : oid === 'r'
          ? els(scene.svg, 'path')
              .filter((e) => !inDefs(e))
              .pop()
          : null;
    worst = Math.max(
      worst,
      got && got.getAttribute('d')
        ? hausdorff(
            resolved(got, scene.svg),
            want.map(([x, y]) => [x, y]),
          )
        : Infinity,
    );
  }
  check(
    `${name}: the use and the rect after it both take pose B`,
    worst < 0.1,
    `Hausdorff ${worst}`,
  );
  scene.dispose();
  nm.dispose();
}
// Group keys move a filtered boundary and its leaves once, in bundle coordinates.
for (const [name, value, transform] of [
  ['translation', { localPosition: [12, 4] }, 'translate(12 4)'],
  ['scale', { localScale: [1.2, 0.8] }, 'scale(1.2 .8)'],
]) {
  const defs = '<defs><filter id="f"><feGaussianBlur stdDeviation="2"/></filter></defs>';
  const body =
    '<g transform="translate(5 3) rotate(10)"><g id="G" filter="url(#f)"><path id="a" d="M10 10L30 10L30 30L10 30Z" fill="red"/></g></g>';
  const source = await imp(wrap(defs + body));
  const expected = await imp(wrap(defs + '<g transform="' + transform + '">' + body + '</g>'));
  const table = M.createNativeOverrideTable(source);
  table.set('G', value);
  const scene = draw(source, table);
  const error = hausdorff(resolved(byOid(scene, 'a')[0], scene.svg), poseGeometry(expected, 'a'));
  check(
    'filtered native group ' + name + ' is applied once in bundle coordinates',
    error < 0.001,
    error,
  );
  scene.dispose();
  table.dispose();
}
finish('nativeMorphGroupSpaceSmoke');
