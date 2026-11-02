// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// importerGeometryAuditSmoke -- the importer's geometry rules, checked on the CPU side.
//
// Every group asserts the record or table the importer writes (curve plane headers, dash table, meta rows, segments) and the CPU
// builders' decisions, never pixels. The pixel proofs are importerGeometryAuditRenderSmoke, on the GPU.
const { DOMParser: DP, XMLSerializer: XS } = await import('@xmldom/xmldom');
globalThis.DOMParser = globalThis.DOMParser || DP;
globalThis.XMLSerializer = globalThis.XMLSerializer || XS;
const { default: importSvg } = await import('../src/svg/importer.js');
const SEG = await import('../src/svg/segment.js');
const { parsePathD } = await import('../src/svg/path.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { buildLbShape, curveCrossesStraight } = await import('../src/renderer/lbBuildCore.js');
const { META_MITER_LIMIT } = await import('../src/bundle/layout.js');

let failures = 0;
const check = (good, msg) => {
  console.log(`  ${good ? 'ok' : 'FAIL'} ${msg}`);
  if (!good) failures++;
};
const warnings = [];
const _warn = console.warn;
console.warn = (...a) => {
  warnings.push(a.join(' '));
};

const wrap = (body, attrs = 'viewBox="0 0 100 100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;
const imp = (body, o = {}, attrs) => importSvg(wrap(body, attrs), { preserveViewport: true, ...o });
const strokePath = (d, extra = '') =>
  `<path d="${d}" fill="none" stroke="#000" ${/stroke-width/.test(extra) ? '' : 'stroke-width="6"'} ${extra}/>`;

// the stroke records of a bundle: one per segment, [header (type|bits, freeStart, freeEnd, startDist), p1.xy p2.xy, join tangents]
function records(b) {
  const f = new Float32Array(b.curves),
    out = [];
  const size = { 0: 3, 1: 4, 2: 4, 3: 5 };
  for (let i = 4; i + 3 < f.length;) {
    const ty = f[i] & 3;
    out.push({
      ty,
      skip: (f[i] & 4) !== 0,
      sub: (f[i] & 8) !== 0,
      fs: f[i + 1],
      fe: f[i + 2],
      sd: f[i + 3],
      p: Array.from(f.slice(i + 4, i + 8)),
    });
    i += size[ty] * 4;
  }
  return out;
}
const dashRow = (b) => {
  if (!b.dashes || !b.dashes.byteLength) return null;
  const f = new Float32Array(b.dashes);
  return { cycle: f[0], n: f[1], off: f[2], vals: Array.from(f.slice(4, 4 + Math.min(f[1], 60))) };
};

// ---- arc conversion without acos, without R^4 -------------------------------------------------------------------------
console.log('arc endpoint -> center');
{
  const at = (a, t) => {
    const c = Math.cos(a.phi),
      s = Math.sin(a.phi);
    return [
      a.cx + c * a.rx * Math.cos(t) - s * a.ry * Math.sin(t),
      a.cy + s * a.rx * Math.cos(t) + c * a.ry * Math.sin(t),
    ];
  };
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let worst = 0,
    bad = 0;
  for (let k = 0; k < 400; k++) {
    const p1 = [rnd() * 100, rnd() * 100],
      p2 = [rnd() * 100, rnd() * 100];
    const s = Math.pow(10, -2 + rnd() * 4);
    const a = SEG.arcToNative(
      p1,
      rnd() * 80 * s + 0.1,
      rnd() * 80 * s + 0.1,
      rnd() * 360,
      rnd() < 0.5 ? 1 : 0,
      rnd() < 0.5 ? 1 : 0,
      p2,
    );
    if (a.type !== SEG.SEG_ARC) continue;
    const e1 = at(a, a.theta_start),
      e2 = at(a, a.theta_end),
      chord = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const err =
      Math.max(Math.hypot(e1[0] - p1[0], e1[1] - p1[1]), Math.hypot(e2[0] - p2[0], e2[1] - p2[1])) /
      chord;
    worst = Math.max(worst, err);
    if (!(err < 1e-6)) bad++;
  }
  check(
    bad === 0,
    `400 random arcs (radii 0.1..8000): endpoints reproduced to 1e-6 of the chord (worst ${worst.toExponential(1)})`,
  );
  {
    const a7 = SEG.arcToNative([10, 50], 1e7, 1e7, 0, 0, 1, [90, 50]);
    const e1 = at(a7, a7.theta_start),
      e2 = at(a7, a7.theta_end);
    check(
      a7.type === SEG.SEG_ARC &&
        Math.hypot(e1[0] - 10, e1[1] - 50) < 1e-3 &&
        Math.hypot(e2[0] - 90, e2[1] - 50) < 1e-3,
      'R=1e7, chord 80: still an arc, endpoints within 1e-3',
    );
  }
  for (const R of [1e8, 1e9, 1e30, 1e77, 1e100, 1e154, 1e300]) {
    const a = SEG.arcToNative([10, 50], R, R, 0, 0, 1, [90, 50]);
    check(
      a.type === SEG.SEG_LINE && a.p1[0] === 10 && a.p2[0] === 90,
      `R=${R}: a chord-flat arc is its chord (line, endpoints exact)`,
    );
    const cu = SEG.arcToCubics([10, 50], R, R, 0, 0, 1, [90, 50]);
    check(cu.length === 1 && cu[0].type === SEG.SEG_LINE, `R=${R}: arcToCubics gives the line too`);
  }
  const c1 = SEG.arcEndpointToCenter([0, 0], 1e300, 1e300, 0, 1, 1, [10, 0]);
  check(
    [c1.cx, c1.cy, c1.rx, c1.theta1, c1.dtheta].every(Number.isFinite),
    'R=1e300 large arc: a finite center form (no R^4 overflow)',
  );
  const c2 = SEG.arcEndpointToCenter([0, 0], 1, 1, 0, 0, 1, [1e-160, 1e-160]);
  check(
    [c2.cx, c2.cy, c2.theta1, c2.dtheta].every(Number.isFinite),
    'endpoint gap 1e-160: a finite center form',
  );
  check(
    SEG.arcToNative([0, 0], 1, 1, 0, 0, 1, [1e-160, 1e-160]).type === SEG.SEG_LINE,
    'endpoint gap 1e-160: a line',
  );
  const mid = SEG.arcToNative([0, 0], 1e5, 1e5, 0, 0, 1, [10, 0]);
  check(
    mid.type === SEG.SEG_ARC &&
      Math.abs(mid.theta_end - mid.theta_start - 2 * Math.asin(5 / 1e5)) < 1e-14,
    'R=1e5, chord 10: still an arc, with the exact sweep 2*asin(5/R)',
  );
  const b = await imp(
    '<path d="M10 10 A1e80 1e80 0 0 1 90 10 L90 90 L10 90 Z" fill="#f00"/><rect width="5" height="5" fill="#00f"/>',
  );
  check(
    Array.from(new Float32Array(b.curves)).every(Number.isFinite),
    'a 1e80 radius leaves the curve table finite',
  );
}

// ---- arcToCubics piece accuracy ----------------------------------------------------------------------------------------
console.log('arcToCubics 4/3 tan(dt/4)');
{
  const bez = (g, t) => {
    const u = 1 - t,
      p = [g.p1, g.p2, g.p3, g.p4];
    return [0, 1].map(
      (k) =>
        u * u * u * p[0][k] +
        3 * u * u * t * p[1][k] +
        3 * u * t * t * p[2][k] +
        t * t * t * p[3][k],
    );
  };
  const r = 1000,
    segs = SEG.arcToCubics([r, 0], r, r, 0, 0, 1, [
      r * Math.cos(Math.PI / 2),
      r * Math.sin(Math.PI / 2),
    ]);
  let w = 0;
  for (const g of segs)
    for (let i = 0; i <= 200; i++) {
      const q = bez(g, i / 200);
      w = Math.max(w, Math.abs(Math.hypot(q[0], q[1]) - r));
    }
  check(
    segs.length === 1 && w < 3e-4 * r,
    `a 90 degree piece at r=1000 deviates ${(w / r).toExponential(2)} of r (bound 3e-4)`,
  );
}

// ---- points use the path number grammar --------------------------------------------------------------------------------
console.log('polygon / polyline points');
{
  const bbox = async (pts, tag = 'polygon') => {
    const b = await importSvg(
      wrap(`<${tag} points="${pts}" fill="#000"/>`, 'viewBox="-200 -200 400 400"'),
      { preserveViewport: true },
    );
    if (!b.numShapes) return null;
    const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
    return [0, 1, 2, 3].map((i) => +pm.metaFloats[i].toFixed(3)).join(',');
  };
  check((await bbox('10,10 80-10 80,80')) === '10,-10,80,80', '"80-10" is 80 and -10');
  check((await bbox('10,10 .5.5 80,80')) === '0.5,0.5,80,80', '".5.5" is .5 and .5');
  check((await bbox('1e1,10 +80,-10 80,80')) === '10,-10,80,80', 'exponents and a leading + read');
  check(
    (await bbox('10 10 20 10 20 20')) === '10,10,20,20' &&
      (await bbox('10,10,80,-10,80,80')) === '10,-10,80,80',
    'whitespace and comma lists read',
  );
  check(
    (await bbox('10,10 80px,-10 80,80')) === null,
    '"80px" is an error at that number: the list stops (one point: nothing drawn)',
  );
  check(
    (await bbox('10,10 80,-10 80,80 ,')) === '10,-10,80,80',
    'a trailing comma keeps the numbers before it',
  );
  check((await bbox('10,10 20,abc 30,30')) === null, 'a word ends the list (unchanged behavior)');
}

// ---- Z then a non-M command ---------------------------------------------------------------------------------------------
console.log('implicit subpath after Z');
{
  const segs = parsePathD('M25 25 L80 30 L45 80 Z L90 90');
  check(
    JSON.stringify(segs.map((s) => !!s.subStart)) === '[true,false,false,true]',
    'the segment after Z opens a subpath (subStart)',
  );
  check(segs[3].p1[0] === 25 && segs[3].p1[1] === 25, "it starts at the closed subpath's start");
  check(
    JSON.stringify(parsePathD('M0 0 L5 5 Z Z').map((s) => !!s.subStart)) === '[true,false]',
    'Z Z opens nothing',
  );
  const b = await imp(
    strokePath('M10 10 H50 V30 Z L10 60', 'stroke-dasharray="10 10" stroke-linecap="square"'),
  );
  const r = records(b);
  check(
    r.length === 4 && r[3].fs === 1 && r[3].sd === 0,
    `the implicit subpath has a free start and its own dash phase 0 (records ${JSON.stringify(r.map((x) => [x.fs, x.fe, x.sd]))})`,
  );
  const e = records(
    await imp(
      strokePath(
        'M10 10 H50 V30 Z M10 10 L10 60',
        'stroke-dasharray="10 10" stroke-linecap="square"',
      ),
    ),
  );
  check(
    JSON.stringify(r.map((x) => [x.fs, x.fe, x.sd])) ===
      JSON.stringify(e.map((x) => [x.fs, x.fe, x.sd])),
    'the same records as the explicit `M` form',
  );
}

// ---- zero-length segments are skipped when pairing ---------------------------------------------------------------------
console.log('zero-length segments inside a subpath');
{
  const ref = records(await imp(strokePath('M20 70 L50 30 L80 70')));
  for (const [name, d, live] of [
    ['dup mid vertex', 'M20 70 L50 30 L50 30 L80 70', [0, 2]],
    ['h0 mid', 'M20 70 L50 30 h0 L80 70', [0, 2]],
    ['dup start', 'M20 70 L20 70 L50 30 L80 70', [1, 2]],
    ['dup end', 'M20 70 L50 30 L80 70 L80 70', [0, 1]],
  ]) {
    const r = records(await imp(strokePath(d)));
    const skipped = r.map((x, i) => (x.skip ? i : -1)).filter((i) => i >= 0);
    const l0 = r[live[0]],
      l1 = r[live[1]];
    check(
      r.length === 3 && skipped.length === 1 && !live.includes(skipped[0]),
      `${name}: the zero-length record stays (3 records) and is skipped by the stroke walk`,
    );
    check(
      l0.fs === ref[0].fs && l0.fe === ref[0].fe && l1.fs === ref[1].fs && l1.fe === ref[1].fe,
      `${name}: the live records pair as the path without it (${JSON.stringify([
        [l0.fs, l0.fe],
        [l1.fs, l1.fe],
      ])})`,
    );
  }
  const c = records(await imp(strokePath('M20 70 L50 30 L50 30 L20 70')));
  check(
    c[0].fs === 1 && c[2].fe === 1,
    'an open subpath ending at its start (with a repeated vertex) keeps both caps',
  );
  const z = records(await imp(strokePath('M20 70 L50 30 L80 70 L80 70 Z')));
  check(
    z.filter((x) => !x.skip).every((x) => x.fs === 0 && x.fe === 0),
    'a closed subpath with a repeated vertex joins all round',
  );
}

// ---- zero-length subpaths ---------------------------------------------------------------------------------------------
console.log('zero-length subpaths');
{
  const rec = async (d, cap, ctm = '') =>
    records(
      await imp(`<g ${ctm}>${strokePath(d, `stroke-linecap="${cap}" stroke-width="20"`)}</g>`),
    );
  for (const d of [
    'M50 50 L50 50',
    'M50 50 Z',
    'M50 50 h0',
    'M50 50 l0 0 z',
    'M50 50 L50 50 L50 50',
    'M50 50 Q50 50 50 50',
    'M50 50 C50 50 50 50 50 50',
    'M50 50 A10 10 0 0 1 50 50',
    'M50 50 A0 0 0 0 1 50 50',
  ]) {
    const butt = await rec(d, 'butt'),
      round = await rec(d, 'round'),
      square = await rec(d, 'square');
    check(
      butt.every((x) => x.skip) && (d === 'M50 50 Z' || butt.length >= 1),
      `${d}: butt paints nothing (${butt.length} records, every one skipped)`,
    );
    check(
      round.filter((x) => !x.skip).length === 1 &&
        round.find((x) => !x.skip).fs === 1 &&
        round.find((x) => !x.skip).fe === 1,
      `${d}: round keeps ONE free record (the disc)`,
    );
    const live = square.filter((x) => !x.skip);
    const len =
      live.length === 1 && live[0].ty === 0
        ? Math.hypot(live[0].p[2] - live[0].p[0], live[0].p[3] - live[0].p[1])
        : -1;
    check(
      live.length === 1 &&
        live[0].ty === 0 &&
        live[0].fs === 1 &&
        live[0].fe === 1 &&
        len > 0 &&
        len < 20 * 2 ** -9 &&
        Math.abs(live[0].p[3] - live[0].p[1]) === 0,
      `${d}: square keeps ONE free line along the user x axis, ${(len / 20).toExponential(1)} of the width long (square caps make the box)`,
    );
  }
  const rot = await rec('M50 50 L50 50', 'square', 'transform="rotate(30 50 50)"');
  const lv = rot.find((x) => !x.skip),
    ang = (Math.atan2(lv.p[3] - lv.p[1], lv.p[2] - lv.p[0]) * 180) / Math.PI;
  check(
    Math.abs(ang - 30) < 0.1,
    `a rotated element's square cap turns with it (${ang.toFixed(3)} degrees)`,
  );
  const lone = await imp(strokePath('M50 50', 'stroke-linecap="round"'));
  check(!lone.numShapes || records(lone).length === 0, 'a lone moveto draws nothing');
  const two = await rec('M30 50 L30 50 M70 50 Z', 'round');
  check(two.filter((x) => !x.skip).length === 2, 'two zero-length subpaths keep one record each');
  const real = await rec('M30 50 L70 50 L70 50', 'square');
  check(
    real.filter((x) => !x.skip).length === 1 && real.length === 2,
    'a subpath that has length is unchanged by a repeated end point',
  );
}

// ---- dash table -------------------------------------------------------------------------------------------------
console.log('pathLength / dash table');
{
  const row = async (attrs, d = 'M0 50 H100') => dashRow(await imp(strokePath(d, attrs)));
  let r = await row('pathLength="50" stroke-dasharray="10 10"');
  check(
    r.cycle === 40 && r.vals[0] === 20,
    'pathLength=50 on a 100 long path doubles the pattern (20 20)',
  );
  r = await row('pathLength="200" stroke-dasharray="10 10" stroke-dashoffset="25"');
  check(
    r.cycle === 10 && r.vals[0] === 5 && r.off === 2.5,
    `pathLength=200 halves the pattern and the offset (offset ${r.off})`,
  );
  r = await row('pathLength="0" stroke-dasharray="10 10"');
  check(r.cycle === 20, 'a non-positive pathLength is ignored');
  const rr = dashRow(
    await imp(
      '<rect x="10" y="10" width="40" height="20" fill="none" stroke="#000" stroke-dasharray="10 10" pathLength="60"/>',
    ),
  );
  check(rr.cycle === 40, 'pathLength applies to a rect: perimeter 120 over 60 doubles the pattern');
  const cc = dashRow(
    await imp(
      '<circle cx="50" cy="50" r="10" fill="none" stroke="#000" stroke-dasharray="1 1" pathLength="10"/>',
    ),
  );
  check(
    Math.abs(cc.cycle - ((2 * Math.PI * 10) / 10) * 2) < 1e-4,
    `pathLength applies to a circle (cycle ${cc.cycle.toFixed(4)})`,
  );
  const sc = dashRow(
    await imp(
      '<g transform="scale(3)"><path d="M0 10 H20" fill="none" stroke="#000" stroke-dasharray="4 4" pathLength="10"/></g>',
      {},
      'viewBox="0 0 100 100"',
    ),
  );
  check(
    Math.abs(sc.cycle - 48) < 1e-4,
    `pathLength is measured in user space, then scaled by the CTM (cycle ${sc.cycle})`,
  );

  r = await row('stroke-dasharray="10 10" stroke-dashoffset="100000003"');
  check(r.off === 3, `an offset of 100000003 is stored as its phase 3 (${r.off})`);
  r = await row(
    'stroke-dasharray="10 10" stroke-dashoffset="-1e7-2"'.replace('-1e7-2', '-10000002'),
  );
  check(r.off === 18, `an offset of -10000002 is stored as its phase 18 (${r.off})`);
  r = await row('stroke-dasharray="10 10" stroke-dashoffset="-10"');
  check(r.off === -10, 'an offset inside one cycle is stored as authored');
  r = await row('stroke-dasharray="10 10" stroke-dashoffset="1e9"');
  check(r.off === 0, 'a 1e9 offset is a whole number of cycles: phase 0');

  const longArr = Array.from({ length: 64 }, (_, i) => (i % 2 ? 1 : 3) + (i >> 3)).join(' ');
  warnings.length = 0;
  const rl = await row(`stroke-dasharray="${longArr}"`);
  check(
    rl === null && warnings.some((w) => /dash table/.test(w)),
    '64 distinct values: declined with a warning, drawn solid (no row)',
  );
  const periodic = Array.from({ length: 64 }, (_, i) => (i % 2 ? 1 : 3)).join(' ');
  r = await row(`stroke-dasharray="${periodic}"`);
  check(
    r && r.n === 2 && r.cycle === 4,
    'a periodic 64-value array is stored as its period (cycle 4)',
  );
  const ok60 = Array.from({ length: 60 }, (_, i) => (i % 2 ? 1 : 3) + (i >> 3)).join(' ');
  r = await row(`stroke-dasharray="${ok60}"`);
  check(
    r && r.n === 60 && Math.abs(r.vals.reduce((a, b) => a + b, 0) - r.cycle) < 1e-3,
    '60 values are stored whole, and the cycle is their sum',
  );
}

// ---- float32 range -------------------------------------------------------------------------------------------------------
console.log('coordinates beyond float32');
{
  warnings.length = 0;
  for (const d of [
    'M0 0 L1e39 0 L1e39 50 Z',
    'M0 0 L1e300 0 L1e300 50 Z',
    'M-1e300 0 A1e300 1e300 0 0 1 1e300 0 Z',
  ]) {
    const b = await imp(
      `<path d="${d}" fill="#f00"/><rect x="10" y="10" width="20" height="20" fill="#00f"/>`,
    );
    const f = new Float32Array(b.curves),
      pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
    check(
      Array.from(f).every(Number.isFinite) &&
        Array.from(b.globalBBox).every(Number.isFinite) &&
        [0, 1, 2, 3].every((i) => Number.isFinite(pm.metaFloats[i])),
      `${d.slice(0, 30)}: curve table, row bbox and global bounds are finite`,
    );
    check(b.numShapes === 2, '  ... and the sibling shape survives');
  }
  check(
    warnings.some((w) => /float32 range/.test(w)),
    'the clamp is reported by a warning',
  );
  warnings.length = 0;
  await imp('<path d="M0 0 L50 0 L50 50 Z" fill="#f00"/>');
  check(warnings.length === 0, 'an ordinary file warns nothing');
  const ordinary = parsePathD('M0 0 L5 5 Q1 2 3 4');
  check(
    SEG.clampSegsToF32(ordinary) === ordinary,
    'an in-range list comes back as the same array (no copy)',
  );
}

// ---- miter limit equal to the corner ratio ---------------------------------------------------------------------------------
console.log('miter limit at equality');
{
  const lim = async (ml, d = 'M20 80 L50 80 L50 50') => {
    const b = await imp(strokePath(d, `stroke-linejoin="miter" stroke-miterlimit="${ml}"`));
    return parseMetaBin(b.meta, b.metaFloatsPerShape).metaFloats[META_MITER_LIMIT];
  };
  const L90 = await lim(Math.SQRT2);
  check(
    L90 > Math.SQRT2 && L90 < Math.SQRT2 * (1 + 2 ** -19),
    `limit = sqrt(2) at a 90 degree corner is stored just above the ratio (${L90})`,
  );
  check(
    (await lim(1.3)) === Math.fround(1.3),
    'a limit clearly below the ratio is stored as authored',
  );
  check(
    (await lim(4)) === (await lim(3)),
    'a limit clearly above the ratio is still clamped to the sharpest corner as before',
  );
}

// ---- Loop-Blinn declines a curve crossing a line -----------------------------------------------------------------------------
console.log('Loop-Blinn curve x line');
{
  const L = (a, b) => ({ type: SEG.SEG_LINE, p1: a, p2: b });
  const Q = (a, b, c) => ({ type: SEG.SEG_QUAD, p1: a, p2: b, p3: c });
  const C = (a, b, c, d) => ({ type: SEG.SEG_CUBIC, p1: a, p2: b, p3: c, p4: d });
  const cross = [
    Q([18.57, 12.03], [49.88, 15.18], [26.53, 88.68]),
    L([26.53, 88.68], [37.86, 82.35]),
    L([37.86, 82.35], [18.57, 12.03]),
  ];
  check(curveCrossesStraight([cross]) === true, 'the quad that crosses the closing line is found');
  check(
    buildLbShape([cross], false, false) === null,
    '... and the Loop-Blinn build declines it (to Slug)',
  );
  check(buildLbShape([cross], false, true) === null, '... under even-odd too');
  const noCross = [
    Q([10, 10], [50, 0], [90, 10]),
    L([90, 10], [90, 90]),
    L([90, 90], [10, 90]),
    L([10, 90], [10, 10]),
  ];
  check(
    curveCrossesStraight([noCross]) === false && buildLbShape([noCross], false, false) !== null,
    'a quad that only shares its end points with the lines builds',
  );
  const touch = [Q([10, 50], [50, 10], [90, 50]), L([90, 50], [10, 50])];
  check(curveCrossesStraight([touch]) === false, 'a quad and the chord closing it do not cross');
  const sc = 2 ** 30;
  check(
    curveCrossesStraight([
      cross.map((s) => ({
        ...s,
        p1: s.p1.map((v) => v * sc),
        p2: s.p2.map((v) => v * sc),
        p3: s.p3 && s.p3.map((v) => v * sc),
      })),
    ]) === true,
    'the decision is the same at scale 2^30',
  );
  check(
    curveCrossesStraight([
      cross.map((s) => ({
        ...s,
        p1: s.p1.map((v) => v / sc),
        p2: s.p2.map((v) => v / sc),
        p3: s.p3 && s.p3.map((v) => v / sc),
      })),
    ]) === true,
    'the decision is the same at scale 2^-30',
  );
  // a cubic crossing a line is built right by every route (as on three tiger shapes), so it is NOT declined
  const cubX = [
    C([10, 10], [90, 10], [10, 90], [90, 90]),
    L([90, 90], [50, 100]),
    L([50, 100], [50, 0]),
    L([50, 0], [10, 10]),
  ];
  check(
    curveCrossesStraight([cubX]) === false,
    'a cubic crossing a line is not declined (it builds right)',
  );
  // an arc (a rational quad after decoding) crossing a line: a circle over a rectangle
  const sec = await importSvg(
    wrap(
      '<path d="M10 30 H60 V70 H10 Z M80 50 A25 25 0 1 1 30 50 A25 25 0 1 1 80 50 Z" fill="#000"/>',
    ),
    { preserveViewport: true },
  );
  const { curveRangeToContours } = await import('../src/geom/lbContour.js');
  const r = sec.curveRangesByShape[0],
    contours = curveRangeToContours(new Float32Array(sec.curves), r.begin, r.end);
  check(
    curveCrossesStraight(contours) === true && buildLbShape(contours, false, false) === null,
    'a circle over a rectangle (arcs crossing lines) is declined to Slug',
  );
  const sec2 = await importSvg(
    wrap(
      '<path d="M10 10 H90 V90 H10 Z M80 50 A25 25 0 1 1 30 50 A25 25 0 1 1 80 50 Z" fill="#000"/>',
    ),
    { preserveViewport: true },
  );
  const r2 = sec2.curveRangesByShape[0],
    c2 = curveRangeToContours(new Float32Array(sec2.curves), r2.begin, r2.end);
  check(curveCrossesStraight(c2) === false, 'a circle wholly inside a rectangle crosses nothing');
}

// ---- GWN+SDF is vetoed for self-closing cubics, loops and cusps ----------------------------------------------------------
console.log('GWN veto marker');
{
  const flag = async (d) =>
    (await importSvg(wrap(`<path d="${d}" fill="#000"/>`), { gwnTree: true })).gwnUnsafe === true;
  check(await flag('M50 50 C100 0 100 100 50 50 Z'), 'a self-closing cubic marks the bundle');
  check(await flag('M20 80 C120 10 -20 10 80 80 Z'), 'a cubic loop marks the bundle');
  check(await flag('M20 70 C90 10 10 10 80 70 Z'), 'a cusp marks the bundle');
  check(!(await flag('M20 80 C20 10 80 10 80 80 Z')), 'a plain cubic does not');
  check(!(await flag('M10 10 L90 10 L90 90 Z')), 'a polygon does not');
}

console.warn = _warn;
if (failures) {
  console.error(`importerGeometryAuditSmoke: ${failures} FAILED`);
  process.exit(1);
}
console.log('importerGeometryAuditSmoke: ok');
