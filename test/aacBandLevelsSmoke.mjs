// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// aacBandLevelsSmoke.mjs — AAC band levels: coarser H pair bands that keep AAC's per-pixel work bounded
// when a shape is drawn a few pixels tall.
//
// AAC integrates a whole pixel cell, so without levels a cell taller than a stripe pair walks every pair
// it touches, and a glyph under a pixel re-reads every segment once per pair (roboto text at 64 px: 93.9 ms
// vs 2.3 at 1024). The encoder writes levels: level l's band b lists every segment overlapping fine stripes
// [b<<l, (b+2)<<l), and the shader walks the one level pair that holds the cell. No GPU here; this pins
// the table the shader relies on:
//   - band 0's header texel 1 records the level header slot (.y, even, past the H/V/GWN headers), the
//     top level (.z) and the first level (.w = 2: level 1 cost 41% of the level memory for the least
//     gain), and the top level has at most two bands;
//   - every level band is exactly the union of the finer bands inside its range (the property that
//     makes one walk exact), with type-grouped, xMax-descending entries like every band list;
//   - the stripe layout gets the same levels, and a Slug import carries none;
// and prints the entries a pixel walks at a tiny size before and after.
if (typeof DOMParser === 'undefined') {
  const x = await import('@xmldom/xmldom');
  globalThis.DOMParser = x.DOMParser;
  globalThis.XMLSerializer = x.XMLSerializer;
}
const { default: importSvg } = await import('../src/svg/importer.js');
const { parseMetaBin } = await import('../src/renderer/bundle.js');
const { META_GLYPH_LOC_X, META_GLYPH_LOC_Y, META_BAND_MAX_X, META_BAND_MAX_Y } =
  await import('../src/bundle/layout.js');

let fail = 0;
const ok = (c, m) => {
  console.log(`${c ? '  ok' : 'FAIL'} ${m}`);
  if (!c) fail++;
};
const f = (v) => v.toFixed(3);

function cubicStar(cx, cy, R, r, k) {
  const pts = [];
  for (let i = 0; i < 2 * k; i++) {
    const rad = i % 2 ? r : R,
      t = (Math.PI * i) / k;
    pts.push([cx + rad * Math.cos(t), cy + rad * Math.sin(t)]);
  }
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < 2 * k; i++) {
    const a = pts[i],
      b = pts[(i + 1) % (2 * k)];
    d += ` C${f(a[0] + (b[0] - a[0]) / 3)} ${f(a[1] + (b[1] - a[1]) / 3)} ${f(a[0] + (2 * (b[0] - a[0])) / 3)} ${f(a[1] + (2 * (b[1] - a[1])) / 3)} ${f(b[0])} ${f(b[1])}`;
  }
  return d + ' Z';
}
function comb(x0, y0, w, h, teeth) {
  // a tall comb of quads: long segments that span many stripes
  let d = `M${x0} ${y0 + h}`;
  for (let i = 0; i < teeth; i++) {
    const xa = x0 + (i * w) / teeth,
      xb = xa + w / teeth;
    d += ` L${f(xa)} ${y0} Q${f((xa + xb) / 2)} ${f(y0 - 3)} ${f(xb)} ${y0} L${f(xb - (0.3 * w) / teeth)} ${f(y0 + h * 0.8)}`;
  }
  return d + ` L${x0 + w} ${y0 + h} Z`;
}
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">
  <path d="${cubicStar(100, 100, 90, 30, 64)}"/>
  <path d="${comb(220, 20, 160, 160, 40)}"/>
  <path fill-rule="evenodd" d="M300 150 A40 40 0 1 0 300 151 Z M300 130 A20 20 0 1 0 300 131 Z"/>
</svg>`;

function decode(b) {
  const pm = parseMetaBin(b.meta, b.metaFloatsPerShape);
  const MF = pm.metaFloats,
    ST = pm.floatsPerShape;
  const T = new Float32Array(b.bands);
  const tex = (i) => [T[i * 4], T[i * 4 + 1], T[i * 4 + 2], T[i * 4 + 3]];
  const shapes = [];
  for (let s = 0; s < b.numShapes; s++) {
    const o = s * ST;
    const g = (MF[o + META_GLYPH_LOC_Y] | 0) * 4096 + (MF[o + META_GLYPH_LOC_X] | 0);
    const bandsY = (MF[o + META_BAND_MAX_Y] | 0) + 1,
      bandsX = (MF[o + META_BAND_MAX_X] | 0) + 1;
    const list = (slot) => {
      const h = tex(g + slot),
        arr = tex(g + slot + 1)[0] | 0;
      const n = [h[0] | 0, h[1] | 0, h[2] | 0, h[3] | 0],
        ents = [];
      let k = 0;
      for (let t = 0; t < 4; t++)
        for (let i = 0; i < n[t]; i++, k++) {
          const e = tex(g + arr + k);
          ents.push({ loc: e[0], maxX: e[1], t });
        }
      return ents;
    };
    const t1 = tex(g + 1);
    // .y carries the ray-lane bit in bit 0 (the level slot itself is even)
    shapes.push({
      s,
      bandsY,
      bandsX,
      levelSlot: (t1[1] | 0) & ~1,
      nLv: t1[2],
      lFirst: t1[3],
      list,
    });
  }
  return shapes;
}
const setOf = (ents) => new Set(ents.map((e) => e.loc));
const sortedOk = (ents) =>
  ents.every(
    (e, i) =>
      i === 0 || e.t > ents[i - 1].t || (e.t === ents[i - 1].t && e.maxX <= ents[i - 1].maxX),
  );

for (const [name, opts, pair] of [
  ['pair layout (default import)', {}, true],
  ['stripe layout with levels', { pairBands: false, aacLevels: true }, false],
]) {
  const b = await importSvg(SVG, opts);
  const shapes = decode(b).filter((sh) => sh.bandsY > 2);
  ok(shapes.length >= 2, `${name}: ${shapes.length} shapes with more than two stripes`);
  for (const sh of shapes) {
    const tag = `${name} s${sh.s} (bandsY ${sh.bandsY})`;
    let expectLv = 0;
    for (let l = 2; ; l++) {
      expectLv = l;
      if ((sh.bandsY + (1 << l) - 1) >> l <= 2) break;
    }
    ok(
      sh.lFirst === 2 && sh.nLv === expectLv,
      `${tag}: levels ${sh.lFirst}..${sh.nLv} recorded, 2..${expectLv} expected`,
    );
    ok(
      sh.levelSlot % 2 === 0 && sh.levelSlot >= (sh.bandsY + sh.bandsX) * 2,
      `${tag}: level headers start at an even slot past the H/V headers (${sh.levelSlot})`,
    );
    // the finer bands: the fine H bands first (band j covers [j, j+w) stripes, w = 2 pair / 1 stripe),
    // then each emitted level (band j of level m covers [j<<m, (j+2)<<m))
    let prev = [],
      slot = sh.levelSlot,
      allExact = true,
      allSorted = true;
    for (let j = 0; j < sh.bandsY; j++) prev.push(sh.list(j * 2));
    let prevLo = (j) => j,
      prevHi = (j) => Math.min(j + (pair ? 2 : 1), sh.bandsY);
    for (let l = sh.lFirst; l <= sh.nLv; l++) {
      const nb = (sh.bandsY + (1 << l) - 1) >> l,
        cur = [];
      for (let bi = 0; bi < nb; bi++, slot += 2) {
        const ents = sh.list(slot);
        cur.push(ents);
        if (!sortedOk(ents)) allSorted = false;
        // union of the finer bands whose range lies inside [bi<<l, (bi+2)<<l)
        const lo = bi << l,
          hi = Math.min((bi + 2) << l, sh.bandsY);
        const want = new Set();
        for (let j = 0; j < prev.length; j++) {
          if (prevLo(j) >= lo && prevHi(j) <= hi) for (const e of prev[j]) want.add(e.loc);
        }
        const got = setOf(ents);
        if (got.size !== want.size || [...want].some((v) => !got.has(v))) {
          allExact = false;
          console.log(
            `   ${tag}: level ${l} band ${bi} lists ${got.size}, finer bands inside it ${want.size}`,
          );
        }
      }
      if (l === sh.nLv)
        ok(nb <= 2, `${tag}: the top level (${l}) has ${nb} band(s), so it covers the whole shape`);
      prev = cur;
      {
        const m = l;
        prevLo = (j) => j << m;
        prevHi = (j) => Math.min((j + 2) << m, sh.bandsY);
      }
    }
    ok(allExact, `${tag}: every level band is exactly the union of the finer bands inside it`);
    ok(allSorted, `${tag}: level lists are type-grouped, xMax descending`);
  }
}

const slugB = await importSvg(SVG, { engine: 'slug' });
ok(
  decode(slugB).every((sh) => sh.nLv === 0 && sh.levelSlot === 0),
  'a Slug import carries no levels',
);

// Work a pixel walks: entries visited by the stripe-pair walk vs with levels (two pair walks or fewer are unchanged).
{
  const b = await importSvg(SVG, {});
  const sh = decode(b).find((x) => x.bandsY > 8);
  for (const cellStripes of [3, 8, sh.bandsY]) {
    let old = 0,
      neu = 0,
      cells = 0;
    for (let b0 = 0; b0 + cellStripes - 1 < sh.bandsY; b0++, cells++) {
      const b1 = b0 + cellStripes - 1;
      let pairs = 0;
      for (let j = b0; j <= b1; j += 2) {
        old += sh.list(j * 2).length;
        pairs++;
      }
      if (pairs <= 2) {
        for (let j = b0; j <= b1; j += 2) neu += sh.list(j * 2).length;
        continue;
      }
      let l = sh.lFirst,
        first = sh.levelSlot / 2;
      while (l < sh.nLv && b1 >> l > (b0 >> l) + 1) {
        first += (sh.bandsY + (1 << l) - 1) >> l;
        l++;
      }
      neu += sh.list((first + (b0 >> l)) * 2).length;
    }
    console.log(
      `   s${sh.s}: a cell spanning ${cellStripes} of ${sh.bandsY} stripes walks ${f(old / cells)} entries by stripe pairs, ${f(neu / cells)} by level`,
    );
  }
}

if (fail) {
  console.log(`\n${fail} failure(s)`);
  process.exit(1);
}
console.log(
  "\naacBandLevelsSmoke: level bands are exact unions of the finer bands, recorded in band 0's header",
);
