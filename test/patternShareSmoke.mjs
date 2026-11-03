// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// patternShareSmoke -- pattern content that depends on the referencing box is walked ONCE, not once per box size.
//
// SVG 2 §14.3: under the default patternUnits="objectBoundingBox" with a viewBox, or with patternContentUnits=
// "objectBoundingBox", the pattern's content is scaled (and aligned) per referencing element. Baking that content matrix
// into the child curves and keying the claim by it would walk the content once per distinct size (200 shapes: 1800 meta rows
// and 108,004 curve floats against 208 and 12,484 for a user-space tile). The content is stored once in canonical space and each carrier is an ordinary pattern in that space (the box's scale folded into its pattern inverse, tile origin
// and tile size; the alignment share into the origin): no shader code, no flag, no wire field.
//
// This checks, with no GPU:
//   * the rows and curve floats are O(1) in the number of shapes, and no flag is ever set;
//   * for every referencing shape, every child's box in the TILE's own units equals the control's: the same art with the
//     content PRE-RESOLVED per shape (one userSpaceOnUse pattern each, the content under an explicit matrix: today's output);
//   * the cases that must NOT share still walk per size and still agree (a non-uniform scale with a stroke, a clipped child,
//     a nested pattern, content inside a pattern or a mask);
//   * a bundle with no box-dependent pattern is untouched (no flag; one row set for any number of shapes);
//   * hit testing: the pattern carriers answer exactly as the control's do, and the content rows are never targets.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { fillHitShape, HitMode } = await import('../src/hitTest/index.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};

const FLAG = 32;
const N = 12;
const box = (i) => ({
  x: 4 + (i % 4) * 70 + (i % 3),
  y: 4 + Math.floor(i / 4) * 60,
  w: 20 + 5 * i,
  h: 14 + 3 * ((i * 5) % 7) + ((2 * i) % 11),
});

// A viewBox fit, written out here (the oracle does not call the importer's): returns [sx, sy, ex, ey] into a w x h tile.
function fit(vb, par, w, h) {
  const p = (par || 'xMidYMid meet').trim().split(/\s+/);
  const none = p[0] === 'none';
  let sx = w / vb[2],
    sy = h / vb[3],
    ex,
    ey;
  if (none) return [sx, sy, -sx * vb[0], -sy * vb[1]];
  const s = p[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
  const m = /^x(min|mid|max)y(min|mid|max)$/.exec(p[0].toLowerCase());
  const fx = { min: 0, mid: 0.5, max: 1 }[m[1]],
    fy = { min: 0, mid: 0.5, max: 1 }[m[2]];
  ex = (w - vb[2] * s) * fx - s * vb[0];
  ey = (h - vb[3] * s) * fy - s * vb[1];
  return [s, s, ex, ey];
}

// kind 'vb': default obb units, viewBox + par; kind 'cu': a user-space tile, patternContentUnits=objectBoundingBox.
function artOf(c) {
  const shapes = [...Array(N).keys()].map((i) => ({ i, ...box(i) }));
  const svgOf = (defs, body) =>
    `<svg viewBox="0 0 320 240" xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs>${body}</svg>`;
  const shared = svgOf(
    `<pattern id="p" ${c.attrs}>${c.content}</pattern>${c.extra || ''}`,
    shapes
      .map((s) => `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="url(#p)"/>`)
      .join(''),
  );
  const pats = [],
    body = [];
  for (const s of shapes) {
    let tile, m;
    if (c.kind === 'vb') {
      const tw = c.fw * s.w,
        th = c.fh * s.h;
      tile = [s.x + c.fx * s.w, s.y + c.fy * s.h, tw, th];
      const f = fit(c.vb, c.par, tw, th);
      m = f;
    } else {
      tile = [c.tx, c.ty, c.tw, c.th];
      m = [s.w, s.h, 0, 0];
    }
    pats.push(
      `<pattern id="p${s.i}" patternUnits="userSpaceOnUse" x="${tile[0]}" y="${tile[1]}" width="${tile[2]}" height="${tile[3]}">` +
        `<g transform="matrix(${m[0]} 0 0 ${m[1]} ${m[2]} ${m[3]})">${c.content}</g></pattern>`,
    );
    body.push(`<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="url(#p${s.i})"/>`);
  }
  return { shared, control: svgOf(pats.join('') + (c.extra || ''), body.join('')), shapes };
}

const imp = (svg) => importSvg(svg, { preserveViewport: true });
function view(b) {
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape),
    st = pm.floatsPerShape,
    rows = [];
  for (let s = 0; s < pm.numShapes; s++)
    rows.push(Array.from(pm.metaFloats.subarray(s * st, s * st + st)));
  const carriers = rows.filter((r) => r[43] === 2 && !(Math.round(r[27]) & 256));
  return { rows, carriers };
}
// A child's box in the TILE's own units (the control's frame): the carrier's pattern inverse is diag(1/sx, 1/sy) (no patternTransform
// here), its tile origin is the control's origin over the scale plus the alignment share dx, and a child sits at scale * (box + dx)
// from the control's tile origin. `share` is the alignment share the oracle expects, in canonical units.
function inTile(r, b, sx, sy, dx, dy) {
  return [sx * (b[0] + dx), sy * (b[1] + dy), sx * (b[2] + dx), sy * (b[3] + dy)];
}
const near = (a, b, e) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= e * (1 + Math.abs(b[i])));

const CASES = [
  {
    name: 'viewBox, default meet/xMidYMid',
    kind: 'vb',
    fx: 0.05,
    fy: 0.1,
    fw: 0.3,
    fh: 0.4,
    vb: [0, 0, 10, 10],
    attrs: 'x=".05" y=".1" width=".3" height=".4" viewBox="0 0 10 10"',
    content:
      '<rect width="5" height="10" fill="#0090ff"/><circle cx="7" cy="5" r="2" fill="#e00"/>',
    share: true,
  },
  {
    name: 'viewBox, a tall tile (margin classes: the share is rounded down to 0, vb/32 ... 4 vb)',
    kind: 'vb',
    fx: 0.02,
    fy: 0.02,
    fw: 0.1,
    fh: 0.9,
    vb: [0, 0, 10, 10],
    attrs: 'x=".02" y=".02" width=".1" height=".9" viewBox="0 0 10 10"',
    content:
      '<rect width="5" height="10" fill="#0090ff"/><circle cx="7" cy="5" r="2" fill="#e00"/>',
    share: true,
  },
  {
    name: 'viewBox xMinYMin slice (no alignment share: shares)',
    kind: 'vb',
    fx: 0,
    fy: 0,
    fw: 0.25,
    fh: 0.5,
    vb: [0, 0, 8, 6],
    par: 'xMinYMin slice',
    attrs: 'width=".25" height=".5" viewBox="0 0 8 6" preserveAspectRatio="xMinYMin slice"',
    content:
      '<rect width="4" height="6" fill="#0090ff"/><rect x="4" width="4" height="3" fill="#0a0"/>',
    share: true,
  },
  {
    name: 'viewBox xMinYMax slice (a cropped window moves per box: per scale)',
    kind: 'vb',
    fx: 0,
    fy: 0,
    fw: 0.25,
    fh: 0.5,
    vb: [0, 0, 8, 6],
    par: 'xMinYMax slice',
    attrs: 'width=".25" height=".5" viewBox="0 0 8 6" preserveAspectRatio="xMinYMax slice"',
    content:
      '<rect width="4" height="6" fill="#0090ff"/><rect x="4" width="4" height="3" fill="#0a0"/>',
    share: false,
  },
  {
    name: 'meet, a child outside the viewBox on an aligned axis (per scale)',
    kind: 'vb',
    fx: 0,
    fy: 0,
    fw: 0.3,
    fh: 0.4,
    vb: [0, 0, 10, 10],
    attrs: 'width=".3" height=".4" viewBox="0 0 10 10"',
    content: '<rect x="-2" width="6" height="10" fill="#0090ff"/>',
    share: false,
  },
  {
    name: 'viewBox with a corner and xMaxYMid',
    kind: 'vb',
    fx: 0,
    fy: 0,
    fw: 0.4,
    fh: 0.3,
    vb: [5, -3, 12, 9],
    par: 'xMaxYMid meet',
    attrs: 'width=".4" height=".3" viewBox="5 -3 12 9" preserveAspectRatio="xMaxYMid meet"',
    content:
      '<rect x="5" y="-3" width="6" height="9" fill="#0090ff"/><path d="M11 6 L17 6 L14 0 Z" fill="#e00"/>',
    share: true,
  },
  {
    name: 'viewBox, none (non-uniform), fill only',
    kind: 'vb',
    fx: 0,
    fy: 0,
    fw: 0.3,
    fh: 0.4,
    vb: [0, 0, 10, 10],
    par: 'none',
    attrs: 'width=".3" height=".4" viewBox="0 0 10 10" preserveAspectRatio="none"',
    content:
      '<rect width="5" height="10" fill="#0090ff"/><circle cx="7" cy="5" r="2" fill="#e00"/>',
    share: true,
  },
  {
    name: 'patternContentUnits objectBoundingBox, fill only',
    kind: 'cu',
    tx: 0,
    ty: 0,
    tw: 30,
    th: 24,
    attrs:
      'width="30" height="24" patternUnits="userSpaceOnUse" patternContentUnits="objectBoundingBox"',
    content:
      '<rect width="0.1" height="0.2" fill="#0090ff"/><rect x="0.05" y="0.1" width="0.1" height="0.1" fill="#e00"/>',
    share: true,
  },
  {
    name: 'viewBox meet with a stroke (uniform: shares)',
    kind: 'vb',
    fx: 0,
    fy: 0,
    fw: 0.3,
    fh: 0.4,
    vb: [0, 0, 10, 10],
    attrs: 'width=".3" height=".4" viewBox="0 0 10 10"',
    content:
      '<rect x="2.5" y="2.5" width="5" height="5" fill="none" stroke="#000" stroke-width="1"/>',
    share: true,
  },
  {
    name: 'viewBox none with a stroke (non-uniform: per scale)',
    kind: 'vb',
    fx: 0,
    fy: 0,
    fw: 0.3,
    fh: 0.4,
    vb: [0, 0, 10, 10],
    par: 'none',
    attrs: 'width=".3" height=".4" viewBox="0 0 10 10" preserveAspectRatio="none"',
    content:
      '<rect x="1" y="1" width="8" height="8" fill="none" stroke="#000" stroke-width="1.5"/>',
    share: false,
  },
  {
    name: 'a clipped child (per scale)',
    kind: 'vb',
    fx: 0,
    fy: 0,
    fw: 0.3,
    fh: 0.4,
    vb: [0, 0, 10, 10],
    attrs: 'width=".3" height=".4" viewBox="0 0 10 10"',
    content: '<rect width="10" height="10" fill="#0090ff" clip-path="url(#k)"/>',
    share: false,
    extra: '<clipPath id="k"><rect width="6" height="10"/></clipPath>',
  },
  {
    name: 'a vector-effect child (per scale)',
    kind: 'vb',
    fx: 0,
    fy: 0,
    fw: 0.3,
    fh: 0.4,
    vb: [0, 0, 10, 10],
    attrs: 'width=".3" height=".4" viewBox="0 0 10 10"',
    content:
      '<path d="M1 1 L9 9" stroke="#000" stroke-width="2" vector-effect="non-scaling-stroke"/>',
    share: false,
  },
];

const base = (b) => ({ rows: b.numShapes, floats: b.curves.byteLength / 4, flags: b.flags });
for (const c of CASES) {
  const art = artOf(c);
  const [bs, bc] = [await imp(art.shared), await imp(art.control)];
  const [vs, vc] = [view(bs), view(bc)];
  const rs = base(bs),
    rc = base(bc);
  ok(vs.carriers.length === N && vc.carriers.length === N, `${c.name}: ${N} carriers in both`);
  if (c.share) {
    ok(
      rs.rows < rc.rows,
      `${c.name}: content rows are shared (one set per margin class): ${rs.rows} rows for ${N} shapes (the control walks it per shape: ${rc.rows})`,
    );
    ok((rs.flags & FLAG) === 0, `${c.name}: no wire flag`);
  } else {
    ok(
      rs.rows > N + 3,
      `${c.name}: not (all) shareable, so the content walks per scale: ${rs.rows} rows`,
    );
  }
  // every child, in the tile's own units, equals the control's
  let bad = 0,
    checked = 0;
  for (let i = 0; i < N; i++) {
    const a = vs.carriers[i],
      k = vc.carriers[i];
    const ac = vs.rows.slice(a[40] - 1, a[41]),
      kc = vc.rows.slice(k[40] - 1, k[41]);
    if (ac.length !== kc.length) {
      bad++;
      continue;
    }
    // the carrier is a pattern in canonical space: inverse diag(1/sx, 1/sy), tile size = the control's over the scale, tile origin =
    // the control's over the scale plus the alignment share less the margin class the content was walked at (m: 0, vb/2, vb, 2 vb or
    // 4 vb, the share rounded down to a class)
    let sx = 1 / a[20],
      sy = 1 / a[23];
    let dx = 0,
      dy = 0;
    const s = art.shapes[i];
    const f = c.kind === 'vb' ? fit(c.vb, c.par, c.fw * s.w, c.fh * s.h) : [s.w, s.h];
    // folded (the carrier's inverse is 1/scale) or walked per box (its own frame)
    if (!near([sx, sy], [f[0], f[1]], 1e-5)) {
      sx = sy = 1;
      if (a[20] !== 1 || a[23] !== 1) {
        bad++;
        console.log('    inverse', i, a.slice(20, 24), f);
      }
    } else if (c.kind === 'vb') {
      const want = [c.vb[0] + f[2] / f[0], c.vb[1] + f[3] / f[1]]; // the alignment share, canonical units
      dx = a[36] - k[36] / sx;
      dy = a[37] - k[37] / sy; // what the carrier moved the window by
      for (const [d, w, e] of [
        [dx, want[0], c.vb[2]],
        [dy, want[1], c.vb[3]],
      ]) {
        const m = w - d; // the margin class the content sits at
        let q = 0;
        for (let t = 1 / 32; t <= 4 && t * e <= w + 1e-4 * e; t *= 2) q = t * e; // the share rounded down to a class
        if (Math.abs(m - q) > 1e-4 * e) {
          bad++;
          console.log('    margin', i, m, q, w, e);
        }
      }
    }
    const tileA = [(a[36] - dx) * sx, (a[37] - dy) * sy, a[38] * sx, a[39] * sy]; // back in the control's units
    if (!near(tileA, [k[36], k[37], k[38], k[39]], 1e-5) || a[21] !== 0 || a[22] !== 0) {
      bad++;
      console.log('    tile', i, tileA, k.slice(36, 40));
    }
    for (let j = 0; j < ac.length; j++) {
      checked++;
      const got = inTile(a, ac[j].slice(0, 4), sx, sy, dx, dy);
      if (!near(got, kc[j].slice(0, 4), 1e-4)) {
        bad++;
        if (bad < 4) console.log('    child', i, j, got, kc[j].slice(0, 4));
      }
    }
  }
  ok(
    bad === 0,
    `${c.name}: ${checked} children and ${N} tiles match the pre-resolved control in the tile's units`,
  );
  // hit testing: the carriers answer as the control's, at a grid of points
  let hdiff = 0,
    hits = 0;
  for (let y = 2; y < 240; y += 7)
    for (let x = 3; x < 320; x += 7) {
      for (const mode of [HitMode.Auto, HitMode.Coverage]) {
        const a = fillHitShape(bs, x, y, { mode, minAlpha: 0.5 }),
          k = fillHitShape(bc, x, y, { mode, minAlpha: 0.5 });
        // a shape index is the carrier's order; the pattern rows come first in the shared bundle, so compare "which carrier"
        const ia = a < 0 ? -1 : vs.carriers.indexOf(vs.rows[a]),
          ik = k < 0 ? -1 : vc.carriers.indexOf(vc.rows[k]);
        if (ia !== ik) hdiff++;
        if (ia >= 0) hits++;
      }
    }
  ok(
    hdiff === 0 && hits > 0,
    `${c.name}: hit testing agrees with the control at ${hits} hits (${hdiff} differ)`,
  );
}

// A box-independent pattern is unchanged: no flag, one content row set for any number of shapes.
{
  const body = [...Array(40).keys()]
    .map((i) => `<rect x="0" y="${i}" width="${20 + i}" height="${10 + (i % 7)}" fill="url(#p)"/>`)
    .join('');
  const b = await imp(
    `<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="p" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="red"/></pattern></defs>${body}</svg>`,
  );
  ok(
    (b.flags & FLAG) === 0 && b.numShapes === 41,
    `a user-space pattern: flag clear, ${b.numShapes} rows for 40 shapes`,
  );
  const b2 = await imp(
    `<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg"><rect width="9" height="9" fill="red"/></svg>`,
  );
  ok((b2.flags & FLAG) === 0, 'a bundle with no pattern: flag clear');
}

// 200 shapes of distinct size: 208-ish rows, not 1800.
for (const [label, attrs] of [
  ['default units + viewBox', 'width=".2" height=".2" viewBox="0 0 10 10"'],
  [
    'patternContentUnits=objectBoundingBox',
    'width="10" height="10" patternUnits="userSpaceOnUse" patternContentUnits="objectBoundingBox"',
  ],
]) {
  const content = [...Array(8)]
    .map((_, i) => `<rect x="${i}" y="${i}" width="1" height="1" fill="red"/>`)
    .join('');
  const body = [...Array(200)]
    .map(
      (_, i) => `<rect x="0" y="${i}" width="${20 + i}" height="${10 + (i % 7)}" fill="url(#p)"/>`,
    )
    .join('');
  const b = await imp(
    `<svg viewBox="0 0 300 300" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="p" ${attrs}>${content}</pattern></defs>${body}</svg>`,
  );
  // 200 shapes + the 8 content rows, once per margin class of the alignment share (at most 8 per aligned axis; `patternContentUnits` has none)
  const fl = b.curves.byteLength / 4;
  ok(
    b.numShapes >= 208 && b.numShapes <= 208 + 8 * 5 * 8 && (b.numShapes - 200) % 8 === 0,
    `200 distinct-size shapes, ${label}: ${b.numShapes} rows (200 + 8 per margin class, want <= ${208 + 8 * 5 * 8}), ${fl} curve floats (1 class: 12484)`,
  );
}

console.log(fail ? `\n${fail} failure(s)` : '\nPATTERN-SHARE PASS');
process.exit(fail ? 1 : 0);
