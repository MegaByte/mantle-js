// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// arcRebuildEquivarianceSmoke — transforming a native arc must carry its PARAMETERIZATION, not just its point set,
// so the same drawing imported at any scale is the scale-1 import scaled.
//
// THE DEFECT. transformArcNative eigendecomposes the conic to get the new (rx, ry, phi). The
// eigendecomposition names the AXES; it does not name which one is rx, nor which way each points, nor which turn
// theta is measured on. All four choices describe the same ellipse arc:
//     (rx, ry, phi, theta) == (ry, rx, phi + pi/2, theta - pi/2) == (rx, ry, phi + pi, theta + pi)
//     (theta_start, theta_end) == (theta_start + 2pi, theta_end + 2pi)
// and breaking the tie by putting the LARGER radius in rx with whatever sign the eigenvector comes out with, and
// by atan2, decides the turn at its branch cut on the SIGN OF A ZERO.
//
// That is not a free choice, because the IDENTITY is a fast path that does not rebuild at all: at scale 1 an arc
// keeps whatever the path parser gave it, and at every other scale it comes back rebuilt. With such a tie-break,
// wrapping a drawing in scale(S) — any S but 1 — swaps the radii of every arc authored rx < ry and turns its angles by
// pi/2, turns a rotated ellipse's phi by pi, and shifts every full circle's thetas by 2pi. Equivalent geometry,
// different floats, and the kernels read them differently: on the five-arc drawing below, 10,493 of 50,241 pixel
// centers under AAC (52 by more than 1/255) and 249 under Slug.
//
// THE RULE. The transform CARRIES the arc's rx axis: send (cos phi, sin phi) through m's linear part and keep the
// eigenvector it lands along, with its sign; then snap the turn to the one nearest the arc's own theta_start.
// Both are exact decisions (a |dot| comparison, a round), unchanged by a positive scale on m, so
// rebuild(arc, S*m) is rebuild(arc, m) scaled — and at m = S*I the arc comes back with its own phi and its own
// radii in its own order, which is what scale 1 leaves untouched.
//
// SCALE 1 MOVES, AND THE NEW OUTPUT IS SHOWN CORRECT, not merely identical: (b) the rebuilt arc traces the same
// curve as the mapped original, and (c) a drawing whose arcs really are rebuilt at scale 1 (they sit under a
// <g transform>) is read correctly at every pixel center by both kernels, against a reference that never touches
// the arc rebuild — the authored arcs flattened in their own space and the polyline mapped through the CTM.
//
// Mutation, required to FAIL: restore `rxNew = 1/sqrt(max(lamSmall, ...))`, `phiNew = atan2(vSmall[1],
// vSmall[0])` and `mkArc(..., tsNew, teNew, ...)` in svg/transform.js.
import path from 'path';
import { fileURLToPath } from 'url';
import {
  hasCxx,
  buildGlslEmu,
  fillShapes,
  scaleFillData,
  K_AAC,
  K_SLUG,
  AAC_HARD,
} from './_glslEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { transformArcNative, matMul, parseTransform } = await import('../src/svg/transform.js');
const { parsePathD } = await import('../src/svg/path.js');
const { SEG_ARC } = await import('../src/svg/segment.js');
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const M = await import('../src/bundle/layout.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

// Five arcs the tie-break decides differently: a circle (phi free, theta at the branch cut), an ellipse authored
// rx > ry with a rotation, one authored rx < ry (the swap), a very thin one, and a half arc of each sweep.
const ARC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200">
  <path d="M60 60 m -40 0 a 40 40 0 1 0 80 0 a 40 40 0 1 0 -80 0 Z"/>
  <path d="M110 30 A 40 24 30 0 1 190 30 A 40 24 30 0 1 110 30 Z"/>
  <path d="M210 20 A 18 30 0 0 1 280 60 A 12 55 -40 0 0 210 20 Z"/>
  <path d="M40 150 A 60 8 0 0 1 160 150 A 60 8 0 0 0 40 150 Z"/>
  <path d="M190 120 A 25 25 0 0 1 240 120 A 25 25 0 0 1 290 120 L 290 180 L 190 180 Z"/>
</svg>`;
// The same drawing under a <g transform>, so every arc IS rebuilt at scale 1. This is where the tie-break decides the
// scale-1 bundle, and where (c) shows that bundle correct.
const ARC_SVG_ROTATED = ARC_SVG.replace('">\n', '">\n<g transform="rotate(20 150 100)">').replace(
  '</svg>',
  '</g></svg>',
);

const ARCS = [];
for (const d of ARC_SVG.match(/d="[^"]+"/g).map((s) => s.slice(3, -1)))
  for (const s of parsePathD(d)) if (s.type === SEG_ARC) ARCS.push(s);
const MATS = [
  ['identity-scale', [1, 0, 0, 1, 0, 0]],
  ['rotate(20)', parseTransform('rotate(20)')],
  ['rotate(20 150 100)', parseTransform('rotate(20 150 100)')],
  ['skewX(25)', parseTransform('skewX(25)')],
  ['scale(-1 1)', parseTransform('scale(-1 1)')],
  ['scale(3 1) rotate(40)', parseTransform('scale(3 1) rotate(40)')],
  ['matrix', [1.3, 0.4, -0.7, 0.9, 12, -30]],
];
const P = (a, t) => {
  const c = Math.cos(a.phi),
    s = Math.sin(a.phi),
    ct = Math.cos(t),
    st = Math.sin(t);
  return [a.cx + c * a.rx * ct - s * a.ry * st, a.cy + s * a.rx * ct + c * a.ry * st];
};

// ------------------------------------------------------------------------------------------------
// (a) EQUIVARIANCE. rebuild(arc, S*m) is rebuild(arc, m) with the center and radii times S and every angle
//     equal, for S a power of two; and rebuild(arc, S*I) keeps the arc's own phi, radius order and thetas.
console.log('(a) the rebuild commutes with a scale');
{
  let bad = 0,
    first = '';
  for (const a of ARCS)
    for (const [name, m] of MATS)
      for (const lg of [-20, -1, 1, 20]) {
        const S = 2 ** lg;
        const r0 = transformArcNative(a, m);
        const rS = transformArcNative(a, matMul([S, 0, 0, S, 0, 0], m));
        const want = {
          cx: r0.cx * S,
          cy: r0.cy * S,
          rx: r0.rx * S,
          ry: r0.ry * S,
          theta_start: r0.theta_start,
          theta_end: r0.theta_end,
          phi: r0.phi,
        };
        for (const k of Object.keys(want)) {
          // Scaling by a power of two is exact; the angles must not move at all.
          const tol = k === 'phi' || k.startsWith('theta') ? 0 : 1e-12 * Math.abs(want[k]);
          if (!(Math.abs(rS[k] - want[k]) <= tol)) {
            bad++;
            if (!first) first = `${name} x 2^${lg}: ${k} ${rS[k]} != ${want[k]}`;
            break;
          }
        }
      }
  ok(
    bad === 0,
    `${ARCS.length} arcs x ${MATS.length} matrices x 4 scales: ${bad} rebuilds not covariant${first ? ' -- ' + first : ''}`,
  );
}
{
  // Under a pure scale the arc must come back as ITSELF: same phi branch, same radius ORDER (rx is still the
  // radius the author put first), same turn. Not bit-for-bit — the conic solve rounds — but within a few ulps,
  // which is what excludes the wrong ties: pi/2 (the swap), pi (the eigenvector sign) and 2pi.
  let bad = 0,
    first = '';
  const TOL = 1e-12;
  for (const a of ARCS)
    for (const lg of [-20, -1, 1, 20]) {
      const S = 2 ** lg,
        r = transformArcNative(a, [S, 0, 0, S, 0, 0]);
      const off = Math.max(
        Math.abs(r.phi - a.phi),
        Math.abs(r.theta_start - a.theta_start),
        Math.abs(r.theta_end - a.theta_end),
        Math.abs(r.rx / S - a.rx) / a.rx,
        Math.abs(r.ry / S - a.ry) / a.ry,
      );
      if (!(off <= TOL)) {
        bad++;
        if (!first)
          first = `2^${lg}: r (${a.rx}, ${a.ry}) -> (${r.rx / S}, ${r.ry / S}), phi ${a.phi} -> ${r.phi}, th0 ${a.theta_start} -> ${r.theta_start}`;
      }
    }
  ok(
    bad === 0,
    `a pure scale leaves phi, the radius ORDER and both thetas alone to ${TOL}: ${bad} of ${ARCS.length * 4} moved${first ? ' -- ' + first : ''}`,
  );
}

// ------------------------------------------------------------------------------------------------
// (b) ...and the representative it picks is the same CURVE: the rebuilt arc's points are the original's mapped.
console.log('(b) the rebuilt arc traces the mapped original');
{
  let worst = 0,
    whose = '';
  for (const a of ARCS)
    for (const [name, m] of MATS) {
      const r = transformArcNative(a, m);
      const scale = Math.hypot(a.rx, a.ry) * Math.hypot(m[0], m[1], m[2], m[3]);
      for (let i = 0; i <= 64; i++) {
        const u = i / 64;
        const [ox, oy] = P(a, a.theta_start + (a.theta_end - a.theta_start) * u);
        const want = [m[0] * ox + m[2] * oy + m[4], m[1] * ox + m[3] * oy + m[5]];
        const got = P(r, r.theta_start + (r.theta_end - r.theta_start) * u);
        const e = Math.hypot(got[0] - want[0], got[1] - want[1]) / scale;
        if (e > worst) {
          worst = e;
          whose = name;
        }
      }
    }
  ok(
    worst < 1e-12,
    `${ARCS.length * MATS.length} rebuilds sampled 65 ways: worst relative deviation ${worst.toExponential(2)} (${whose})`,
  );
}

// ------------------------------------------------------------------------------------------------
// (c) THE SCALE-1 BUNDLE IS CORRECT. The rotated drawing's arcs are all rebuilt at scale 1, so this is the output
//     the tie-break decides. Reference: the AUTHORED arcs flattened in their own space and the polyline mapped through
//     the same CTM — no arc rebuild anywhere in it. Every pixel center more than 1 px from that polyline must
//     read solid inside and empty outside, under both kernels.
if (!hasCxx()) {
  console.log(
    '(c), (d) SKIPPED: no C++ compiler ($CXX, clang++, g++, c++) for the kernel emulation',
  );
} else {
  console.log('(c) the rebuilt scale-1 bundle, against a reference that never rebuilds an arc');
  const CTM = parseTransform('rotate(20 150 100)');
  // One closed polyline per <path>, in document space.
  const REF = ARC_SVG.match(/d="[^"]+"/g)
    .map((s) => s.slice(3, -1))
    .map((d) => {
      const pts = [];
      for (const s of parsePathD(d)) {
        const add = (x, y) => {
          const q = [CTM[0] * x + CTM[2] * y + CTM[4], CTM[1] * x + CTM[3] * y + CTM[5]];
          if (
            !pts.length ||
            Math.hypot(q[0] - pts[pts.length - 1][0], q[1] - pts[pts.length - 1][1]) > 0
          )
            pts.push(q);
        };
        if (s.type === SEG_ARC) {
          const N = 4096;
          for (let i = 0; i <= N; i++)
            add(...P(s, s.theta_start + (s.theta_end - s.theta_start) * (i / N)));
        } else {
          const ps = [s.p1, s.p2, s.p3, s.p4].filter(Boolean);
          const N = 64;
          for (let i = 0; i <= N; i++) {
            const t = i / N;
            let x = 0,
              y = 0;
            const n = ps.length - 1;
            for (let k = 0; k <= n; k++) {
              let c = 1;
              for (let j = 0; j < k; j++) c = (c * (n - j)) / (j + 1);
              const w = c * Math.pow(1 - t, n - k) * Math.pow(t, k);
              x += w * ps[k][0];
              y += w * ps[k][1];
            }
            add(x, y);
          }
        }
      }
      return pts;
    });
  const wind = (pts, x, y) => {
    let w = 0;
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i],
        b = pts[(i + 1) % n];
      if (a[1] <= y) {
        if (b[1] > y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) > 0) w++;
      } else if (b[1] <= y && (b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1]) < 0) w--;
    }
    return w;
  };
  const distTo = (pts, x, y) => {
    let best = Infinity;
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i],
        b = pts[(i + 1) % n];
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        L = dx * dx + dy * dy;
      const t = L > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L)) : 0;
      const e = Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
      if (e < best) best = e;
    }
    return best;
  };

  const bR = await importSvg(ARC_SVG_ROTATED, { preserveViewport: true });
  const shR = fillShapes(bR, parseMetaBin, M);
  const bandR = new Float32Array(bR.bands),
    curveR = new Float32Array(bR.curves);
  const emu = buildGlslEmu(ROOT, { defines: AAC_HARD });
  ok(
    shR.length === REF.length,
    `${shR.length} fill shapes against ${REF.length} reference outlines`,
  );

  // WHAT THE CHANGED BYTES SAY. Read the arcs back out of that bundle: a 20-degree rotation must leave every
  // non-circular arc with the author's x-axis-rotation turned by 20 degrees and its radii still in the author's
  // order. (SVG enlarges radii that cannot span their endpoints, which scales both and keeps the order.)
  {
    const got = [];
    const f = new Float32Array(bR.curves);
    for (const r of bR.curveRangesByShape || []) {
      if (!r) continue;
      let hdr = r.begin | 0;
      const end = Math.min(r.end | 0, f.length);
      while (hdr + 4 <= end) {
        const hw = f[hdr];
        if (!(hw >= 0 && hw < 16 && hw === Math.floor(hw))) break;
        const t = (hw | 0) & 3,
          d = hdr + 4;
        if (t === 3) got.push({ rx: f[d + 2], ry: f[d + 3], phi: f[d + 6] });
        hdr = t === 0 ? d + 8 : t === 3 ? d + 16 : d + 12; // an arc's endpoints texel
      }
    }
    const wrapPi = (v) => {
      const TWO = 2 * Math.PI;
      return v - TWO * Math.round(v / TWO);
    };
    let bad = 0,
      first = '';
    got.forEach((g, i) => {
      const a = ARCS[i];
      if (!a || Math.abs(a.rx - a.ry) < 1e-9 * a.rx) return; // a circle has no phi to preserve
      const dphi = Math.abs(wrapPi(g.phi - (a.phi + (20 * Math.PI) / 180)));
      const order = Math.sign(g.rx - g.ry) === Math.sign(a.rx - a.ry);
      if (!(dphi < 1e-6) || !order) {
        bad++;
        if (!first)
          first = `arc ${i}: phi ${g.phi.toFixed(6)} vs authored ${a.phi.toFixed(6)} + 20deg, r (${g.rx.toFixed(3)}, ${g.ry.toFixed(3)}) vs authored (${a.rx}, ${a.ry})`;
      }
    });
    ok(
      got.length === ARCS.length && bad === 0,
      `${got.length} rebuilt arcs keep the author's rotation turned by 20 degrees and the author's radius order: ${bad} do not${first ? ' -- ' + first : ''}`,
    );
  }
  for (const [name, k] of [
    ['Slug', K_SLUG],
    ['AAC', K_AAC],
  ]) {
    let judged = 0,
      wrong = 0,
      first = '';
    for (let s = 0; s < Math.min(shR.length, REF.length); s++) {
      const sh = shR[s],
        pts = REF[s],
        qs = [],
        want = [];
      for (let y = Math.floor(sh.bb[1]) - 2; y <= Math.ceil(sh.bb[3]) + 2; y++)
        for (let x = Math.floor(sh.bb[0]) - 2; x <= Math.ceil(sh.bb[2]) + 2; x++) {
          const cx = x + 0.5,
            cy = y + 0.5;
          if (distTo(pts, cx, cy) <= 1) continue;
          qs.push({ k, GD: sh.GD, bb: sh.bb, eo: sh.eo, c: [cx, cy], ePx: [1, 1] });
          want.push(wind(pts, cx, cy) !== 0 ? 1 : 0);
        }
      const got = emu.run(bandR, curveR, qs);
      for (let i = 0; i < want.length; i++) {
        judged++;
        if (Math.abs(got[i] - want[i]) > 0.01) {
          wrong++;
          if (!first)
            first = `shape ${s} at (${qs[i].c.join(', ')}): kernel ${got[i].toFixed(3)}, reference ${want[i]}`;
        }
      }
    }
    ok(
      judged > 20000 && wrong === 0,
      `${name}: ${judged} pixel centers more than 1 px from the true outline, ${wrong} disagree with it${first ? ' -- ' + first : ''}`,
    );
  }

  // ------------------------------------------------------------------------------------------------
  // (d) ...and the drawing imported AT a scale reads exactly as the scale-1 import scaled exactly.
  console.log('(d) imported at a scale, against the scale-1 import scaled exactly');
  const wrap = (raw, S) => {
    const m = raw.match(/<svg\b[^>]*>/),
      vb = m[0]
        .match(/viewBox="([^"]+)"/)[1]
        .trim()
        .split(/[\s,]+/)
        .map(Number);
    const open = m[0].replace(/viewBox="[^"]+"/, `viewBox="${vb.map((v) => v * S).join(' ')}"`);
    const i0 = raw.indexOf(m[0]) + m[0].length,
      i1 = raw.lastIndexOf('</svg>');
    return open + `<g transform="scale(${S})">` + raw.slice(i0, i1) + '</g></svg>';
  };
  for (const [label, svg] of [
    ['plain', ARC_SVG],
    ['under rotate(20 150 100)', ARC_SVG_ROTATED],
  ]) {
    const b1 = await importSvg(svg, { preserveViewport: true });
    const sh1 = fillShapes(b1, parseMetaBin, M);
    const band1 = new Float32Array(b1.bands),
      curve1 = new Float32Array(b1.curves);
    const cells = [];
    for (const sh of sh1)
      for (let y = Math.floor(sh.bb[1]) - 2; y <= Math.ceil(sh.bb[3]) + 2; y++)
        for (let x = Math.floor(sh.bb[0]) - 2; x <= Math.ceil(sh.bb[2]) + 2; x++)
          cells.push([sh, x + 0.5, y + 0.5]);
    for (const [name, k] of [
      ['Slug', K_SLUG],
      ['AAC', K_AAC],
    ]) {
      const out = [];
      for (const lg of [-20, 20]) {
        const S = 2 ** lg;
        const sc = scaleFillData(band1, curve1, sh1, S);
        const A = emu.run(
          sc.band,
          sc.curve,
          cells.map(([sh, cx, cy]) => ({
            k,
            GD: sh.GD,
            bb: sh.bb.map((v) => Math.fround(v * S)),
            eo: sh.eo,
            c: [Math.fround(cx * S), Math.fround(cy * S)],
            ePx: [S, S],
          })),
        );
        const bS = await importSvg(wrap(svg, S), { preserveViewport: true });
        const shS = fillShapes(bS, parseMetaBin, M);
        const B = emu.run(
          new Float32Array(bS.bands),
          new Float32Array(bS.curves),
          cells.map(([sh, cx, cy]) => {
            const d = shS[sh1.indexOf(sh)];
            return {
              k,
              GD: d.GD,
              bb: d.bb,
              eo: d.eo,
              c: [Math.fround(cx * S), Math.fround(cy * S)],
              ePx: [S, S],
            };
          }),
        );
        let n = 0;
        for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) n++;
        out.push(`2^${lg}: ${n}`);
      }
      ok(
        out.every((s) => s.endsWith(' 0')),
        `${label}, ${name}: differing pixel centers ${out.join(', ')} of ${cells.length}`,
      );
    }
  }
}

console.log(
  fail ? `arcRebuildEquivarianceSmoke FAIL (${fail})` : 'arcRebuildEquivarianceSmoke PASS',
);
process.exit(fail ? 1 : 0);
