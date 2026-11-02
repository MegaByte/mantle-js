// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// strokeReachPadSmoke — everything sized from a stroke's PATH reaches the farthest ink of its SVG 2
// stroke shape (with its clipped miter).
//
// A square cap is halfW deep and halfW to either side, so its outer corners are sqrt(2) * halfW from
// the endpoint; a stroke at 45 degrees puts one of them that far along an axis. A pad of halfW for
// every join but miter on the stroke row's bands, its cover quad and the hit test's bbox cull
// leaves those corners outside: the hit test misses them, and in the renderer the cover quad
// and the band membership cut them. A clipped miter (miter-clip, and arcs
// on straight segments) reaches halfW * sqrt(miterLimit^2 + 1). src/bundle/strokeReach.js is the one
// bound; the shader's _reach is its GLSL twin.
//
//   (a) strokeReachFactor bounds the SVG 2 shape: every inside pixel center of the seeded polylines
//       (test/_strokeShapeRef.mjs) lies in the path's box padded by halfW * factor, and the exact
//       corner points of a 45-degree square cap and of a near-reversal clipped miter are within it;
//       the narrower pads (halfW for a square cap or miter-clip, miterLimit * halfW for arcs) are not;
//   (b) END TO END, importSvg's main stroke row: on adversarial strokes (square caps at 45 degrees
//       under round and bevel joins, near-reversal miter-clip and arcs at 45 degrees) every inside
//       sample is inside the cover quad and reached by the band walk (test/_strokeBandEmu.mjs), gates
//       on and off;
//   (c) the same strokes as MASK children (layer rows: no cover quad, their own band pad);
//   (d) the hit test (fillHitShape, Outline) answers SVG 2 at those samples, on a small shape and on
//       one big enough for the winding-tree prune;
//   (e) the shader's search radius carries the square cap, and the split-stroke route's segment quad
//       (_strokeVertexSetup.glsl) the square cap and the clipped miter;
//   (f) a stroke row's bands are binned through the meta bbox the shader indexes them by (binning a
//       miter row's through path + miterLimit * halfW leaves spike centers unpainted on a rising
//       sawtooth under limit 10).
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { svgInside, makeStrokeCases, pixels, JOINS } from './_strokeShapeRef.mjs';
import { makeStrokeEmu, strokeRowsOf } from './_strokeBandEmu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { fillHitShape, HitMode } = await import('../src/hitTest/hitTest.js');
const { strokeReachFactor } = await import('../src/bundle/strokeReach.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`  ${c ? 'ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const CAPS = ['butt', 'round', 'square'];
const box = (P) =>
  P.reduce(
    (b, p) => [
      Math.min(b[0], p[0]),
      Math.min(b[1], p[1]),
      Math.max(b[2], p[0]),
      Math.max(b[3], p[1]),
    ],
    [Infinity, Infinity, -Infinity, -Infinity],
  );
// how far past the path's box a point is, in the larger axis
const past = (b, q) => Math.max(b[0] - q[0], q[0] - b[2], b[1] - q[1], q[1] - b[3], 0);

// ---- (a) the bound ---------------------------------------------------------------------------------
{
  let n = 0,
    over = 0,
    worst = 0;
  const oldOver = { 'square cap': 0, 'miter-clip': 0, arcs: 0 };
  for (const cs of makeStrokeCases(0x51de, 360).concat(makeStrokeCases(0x7a11, 360))) {
    const b = box(cs.P),
      f = strokeReachFactor(cs.joinStyle, cs.miterLimit, cs.closed ? 1 : cs.cap);
    const L = Math.max(1, cs.miterLimit);
    const oldF = cs.joinStyle === 0 || cs.joinStyle === 4 ? L : 1; // the importer's strokePad before
    for (const c of pixels(cs)) {
      if (!svgInside(c, cs.P, cs.closed, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit)) continue;
      n++;
      const r = past(b, c) / cs.halfW;
      worst = Math.max(worst, r / f);
      if (r > f * (1 + 1e-12)) over++;
      if (r > oldF * (1 + 1e-12)) {
        if (cs.joinStyle === 3) oldOver['miter-clip']++;
        else if (cs.joinStyle === 4) oldOver.arcs++;
        else if (!cs.closed && cs.cap === 2) oldOver['square cap']++;
      }
    }
  }
  ok(
    over === 0,
    `(a) all ${n} inside centers of 720 seeded polylines lie within halfW * strokeReachFactor of the path's box (worst ${worst.toFixed(3)} of the bound)`,
  );
  ok(
    Object.values(oldOver).every((v) => v > 0),
    `(a) the narrower pads miss some: ${Object.entries(oldOver)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ')}`,
  );
  // exact corners: a square cap at 45 degrees, and a clipped miter at a near-reversal (turn of 179.5 deg)
  const sq = Math.SQRT1_2 + Math.SQRT1_2; // |t.x| + |n.x| at 45 degrees
  ok(
    strokeReachFactor(1, 4, 2) >= sq - 1e-12 && sq > 1,
    `(a) a 45-degree square cap's corner reaches ${sq.toFixed(4)} halfW along an axis; the bound is ${strokeReachFactor(1, 4, 2).toFixed(4)}`,
  );
  for (const L of [1, 1.5, 4, 10]) {
    const s = Math.sin((0.5 * Math.PI) / 180 / 2),
      c = Math.cos((0.5 * Math.PI) / 180 / 2); // theta = 0.5 deg
    const corner = Math.hypot(L, (1 - L * s) / c);
    ok(
      corner <= strokeReachFactor(3, L) && corner > L,
      `(a) limit ${L}: a clipped miter's corner is ${corner.toFixed(4)} halfW from the vertex, past the limit, within ${strokeReachFactor(3, L).toFixed(4)}`,
    );
  }
}

// ---- the adversarial strokes ------------------------------------------------------------------------
const rot45 = (P) => P.map(([x, y]) => [(x - y) * Math.SQRT1_2, (x + y) * Math.SQRT1_2]);
const SHAPES = [];
for (const hw of [3, 6.5])
  for (const join of [1, 2]) {
    // an open V at 45 degrees; its ends take square caps with a corner along an axis
    SHAPES.push({
      name: `square caps, ${JOINS[join]} join, halfW ${hw}`,
      P: [
        [10, 10],
        [40, 40],
        [70, 10],
      ],
      hw,
      cap: 2,
      join,
      L: 4,
    });
  }
for (const L of [1, 1.5, 4])
  for (const join of [3, 4]) {
    // a spike turning 176 degrees, rotated 45 degrees, so the clip line's corner leads along an axis
    const tip = [60, 0],
      back = [0, 60 * Math.tan((2 * Math.PI) / 180)];
    SHAPES.push({
      name: `${JOINS[join]} limit ${L}, near-reversal at 45 degrees`,
      P: rot45([[0, 0], tip, back]).map(([x, y]) => [x + 20, y + 20]),
      hw: 5,
      cap: 0,
      join,
      L,
    });
  }
const svgOf = (sh, asMask) => {
  const d = 'M ' + sh.P.map((p) => `${p[0]} ${p[1]}`).join(' L ');
  const stroke = `fill="none" stroke-width="${2 * sh.hw}" stroke-linecap="${CAPS[sh.cap]}" stroke-linejoin="${JOINS[sh.join]}" stroke-miterlimit="${sh.L}"`;
  return asMask
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 -60 240 240"><mask id="m" maskUnits="userSpaceOnUse" x="-60" y="-60" width="240" height="240"><path d="${d}" stroke="#fff" ${stroke}/></mask><rect x="-60" y="-60" width="240" height="240" fill="#000" mask="url(#m)"/></svg>`
    : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-60 -60 240 240"><path d="${d}" stroke="#000" ${stroke}/></svg>`;
};
function samples(sh, step = 0.5) {
  const b = box(sh.P),
    R = sh.hw * strokeReachFactor(sh.join, sh.L, sh.cap) + 1,
    out = [];
  for (let y = b[1] - R; y <= b[3] + R; y += step)
    for (let x = b[0] - R; x <= b[2] + R; x += step) {
      const q = [x + 0.125, y + 0.125];
      const inside = svgInside(q, sh.P, false, sh.hw, sh.cap, sh.join, sh.L);
      const e = 1e-4 * sh.hw;
      if (
        [
          [e, 0],
          [-e, 0],
          [0, e],
          [0, -e],
        ].some(
          ([dx, dy]) =>
            svgInside([q[0] + dx, q[1] + dy], sh.P, false, sh.hw, sh.cap, sh.join, sh.L) !== inside,
        )
      )
        continue;
      out.push({ q, inside, far: past(b, q) > sh.hw * (1 + 1e-9) });
    }
  return out;
}

// ---- (b) the main stroke row --------------------------------------------------------------------------
for (const sh of SHAPES) {
  const b = await importSvg(svgOf(sh, false));
  const row = strokeRowsOf(b)[0];
  const on = makeStrokeEmu(b, row, { gates: true }),
    off = makeStrokeEmu(b, row, { gates: false });
  let n = 0,
    far = 0,
    unOn = 0,
    unOff = 0,
    quad = 0,
    outside = 0;
  for (const s of samples(sh)) {
    const a = on.eval(s.q),
      z = off.eval(s.q);
    if (!s.inside) {
      if (a.inQuad && a.minD <= sh.hw) outside++;
      continue;
    }
    n++;
    if (s.far) far++;
    if (!a.inQuad) quad++;
    if (!(a.inQuad && a.minD <= sh.hw)) unOn++;
    if (!(z.inQuad && z.minD <= sh.hw)) unOff++;
  }
  ok(
    far > 0 && unOn + unOff + outside === 0,
    `(b) ${sh.name}: ${unOn} / ${unOff} of ${n} inside samples unpainted (gates on / off; ${quad} outside the cover quad; ${far} lie past halfW), ${outside} painted outside`,
  );
}

// ---- (c) mask children (layer rows) --------------------------------------------------------------------
for (const sh of SHAPES) {
  const b = await importSvg(svgOf(sh, true));
  const meta = new Float32Array(b.meta, 32),
    stride = b.metaFloatsPerShape || 48;
  const row = strokeRowsOf(b).find((r) => (Math.round(meta[r * stride + 27]) & 0x100) !== 0);
  if (row === undefined) {
    ok(false, `(c) ${sh.name}: no layer stroke row`);
    continue;
  }
  const emus = [makeStrokeEmu(b, row, { gates: true }), makeStrokeEmu(b, row, { gates: false })];
  let n = 0;
  const un = [0, 0];
  for (const s of samples(sh)) {
    if (!s.inside) continue;
    n++;
    emus.forEach((emu, k) => {
      if (!(emu.eval(s.q).minD <= sh.hw)) un[k]++;
    });
  }
  ok(
    un[0] + un[1] === 0,
    `(c) as a mask child, ${sh.name}: ${un[0]} / ${un[1]} of ${n} inside samples unreached by the band walk (gates on / off)`,
  );
}

// ...and the seeded polylines as mask children, every join and cap
{
  const tally = {};
  for (const cs of makeStrokeCases(0x51de, 360)) {
    const sh = { P: cs.P, hw: cs.halfW, cap: cs.cap, join: cs.joinStyle, L: cs.miterLimit };
    const d = 'M ' + cs.P.map((p) => `${p[0]} ${p[1]}`).join(' L ') + (cs.closed ? ' Z' : '');
    const b = await importSvg(svgOf(sh, true).replace(/ d="[^"]*"/, ` d="${d}"`)); // (not the mask's id="m")
    const meta = new Float32Array(b.meta, 32),
      stride = b.metaFloatsPerShape || 48;
    const row = strokeRowsOf(b).find((r) => (Math.round(meta[r * stride + 27]) & 0x100) !== 0);
    const key = `${JOINS[cs.joinStyle]}${!cs.closed && cs.cap === 2 ? ' + square cap' : ''}`;
    const t = (tally[key] ??= { n: 0, un: 0 });
    const emu = makeStrokeEmu(b, row, { gates: true });
    const eps = 1e-4 * cs.halfW;
    for (const c of pixels(cs)) {
      const inSvg = svgInside(c, cs.P, cs.closed, cs.halfW, cs.cap, cs.joinStyle, cs.miterLimit);
      if (!inSvg) continue;
      if (
        [
          [eps, 0],
          [-eps, 0],
          [0, eps],
          [0, -eps],
        ].some(
          ([dx, dy]) =>
            !svgInside(
              [c[0] + dx, c[1] + dy],
              cs.P,
              cs.closed,
              cs.halfW,
              cs.cap,
              cs.joinStyle,
              cs.miterLimit,
            ),
        )
      )
        continue;
      t.n++;
      if (!(emu.eval(c).minD <= cs.halfW)) t.un++;
    }
  }
  const un = Object.values(tally).reduce((a, t) => a + t.un, 0),
    n = Object.values(tally).reduce((a, t) => a + t.n, 0);
  ok(
    un === 0,
    `(c) 360 seeded polylines as mask children: ${un} of ${n} inside centers unreached (${
      Object.entries(tally)
        .filter(([, t]) => t.un)
        .map(([k, t]) => `${k} ${t.un}`)
        .join(', ') || 'none by join'
    })`,
  );
}

// ---- (d) the hit test ------------------------------------------------------------------------------------
{
  const big = [];
  // 60 teeth, each a near-reversal spike, with square caps at the ends: enough segments for the tree prune
  for (let k = 0; k <= 60; k++) big.push([k * 3, (k % 2) * 80]);
  const BIG = {
    name: '60 near-reversal teeth, miter-clip limit 4, square caps',
    P: rot45(big).map(([x, y]) => [x + 60, y]),
    hw: 4,
    cap: 2,
    join: 3,
    L: 4,
  };
  for (const sh of [...SHAPES, BIG]) {
    const b = await importSvg(svgOf(sh, false));
    let n = 0,
      wrong = 0,
      far = 0;
    for (const s of samples(sh, sh === BIG ? 1 : 0.5)) {
      if (!s.far) continue;
      n++;
      if (s.inside) far++;
      const hit = fillHitShape(b, s.q[0], s.q[1], { mode: HitMode.Outline }) >= 0;
      if (hit !== s.inside) wrong++;
    }
    ok(
      far > 0 && wrong === 0,
      `(d) hit test, ${sh.name}: ${wrong} of ${n} samples past halfW disagree with SVG 2 (${far} of them inside)`,
    );
  }
}

// ---- (f) the band grid is binned through the box the shader indexes it by ----------------------------------
// A rising sawtooth puts sharp teeth, and their long miter spikes, at every height of a many-banded
// grid. If the encoder binned a MITER stroke's bands through path + miterLimit * halfW while the
// shader indexes them through the meta bbox (path + halfW), the stripes would drift apart by up to
// (miterLimit - 1) * halfW and a spike could land in a stripe that does not list its segments.
// Sampled around each vertex, inside that vertex's own join (so inside the whole stroke).
{
  for (const [L, join] of [
    [10, 0],
    [20, 0],
    [3, 3],
  ]) {
    const hw = 6,
      P = [];
    for (let k = 0; k <= 80; k++) P.push([k * 6, (k % 2) * 60 + Math.floor(k / 2) * 40]);
    const sh = { P, hw, cap: 0, join, L };
    const b = await importSvg(
      svgOf(sh, false).replace('viewBox="-60 -60 240 240"', 'viewBox="-100 -100 700 1900"'),
    );
    const meta = new Float32Array(b.meta, 32);
    const emu = makeStrokeEmu(b, strokeRowsOf(b)[0], { gates: true });
    const R = Math.ceil(hw * strokeReachFactor(join, L)) + 1;
    let n = 0,
      un = 0;
    for (let v = 1; v < P.length - 1; v++) {
      const local = [P[v - 1], P[v], P[v + 1]];
      for (let y = Math.floor(P[v][1] - R); y <= P[v][1] + R; y++)
        for (let x = Math.floor(P[v][0] - R); x <= P[v][0] + R; x++) {
          const q = [x + 0.5, y + 0.5];
          if (!svgInside(q, local, false, hw, 0, join, L)) continue;
          const e = 1e-4 * hw;
          if (
            [
              [e, 0],
              [-e, 0],
              [0, e],
              [0, -e],
            ].some(([dx, dy]) => !svgInside([q[0] + dx, q[1] + dy], local, false, hw, 0, join, L))
          )
            continue;
          n++;
          const r = emu.eval(q);
          if (!(r.inQuad && r.minD <= hw)) un++;
        }
    }
    ok(
      n > 10000 && un === 0,
      `(f) rising sawtooth, ${JOINS[join]} limit ${L}, ${meta[19] + 1} bands: ${un} of ${n} join-region centers unpainted`,
    );
  }
}

// ---- (e) the shader text ----------------------------------------------------------------------------------
{
  const gl = readFileSync(path.join(ROOT, 'src/shaders/_coverage.glsl'), 'utf8');
  ok(
    /float _reach = halfW \* max\(\(joinStyle == 0 \? _ml\s*: \(joinStyle == 3 \|\| joinStyle == 4\) \? sqrt\(_ml \* _ml \+ 1\.0\) : 1\.0\),\s*\(startCap == 2 \|\| endCap == 2\) \? 1\.41421356 : 1\.0\) \+ aaEm;/.test(
      gl,
    ),
    '(e) _reach = halfW * max(join reach, sqrt(2) for a square cap) + the AA reach',
  );
  const vs = readFileSync(path.join(ROOT, 'src/shaders/_strokeVertexSetup.glsl'), 'utf8');
  ok(
    /if \(capStyle == 2\) reach = max\(reach, halfW \* 1\.41421356\);\s*if \(joinStyle == 3 \|\| joinStyle == 4\) \{\s*float ml = max\(miterLimit, 1\.0\);\s*reach = max\(reach, halfW \* sqrt\(ml \* ml \+ 1\.0\)\);\s*\}\s*(?:\/\/[^\n]*\n\s*)*float pxEm = emPerPx;[\s\S]*?reach \+= 3\.0 \* pxEm;/.test(
      vs,
    ),
    "(e) the split-stroke segment quad (_strokeVertexSetup.glsl) reaches a square cap's and a clipped miter's corners",
  );
}

if (fail) {
  console.error(`STROKE-REACH-PAD FAIL (${fail})`);
  process.exit(1);
}
console.log(`STROKE-REACH-PAD PASS (${(performance.now() / 1000).toFixed(1)} s)`);
