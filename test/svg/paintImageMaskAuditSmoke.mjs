// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// paintImageMaskAuditSmoke — gradient, pattern, image, mask and clip import contracts,
// GL-free: the meta rows, gradient records and stop LUT the importer emits, and the hit test as a clip/mask
// oracle.
//
//   a raster <image> is placed by preserveAspectRatio (default xMidYMid meet): meet fits inside the box, slice covers it
//          (the shape is the box, the image rect larger), none stretches. A matching ratio keeps the box exactly.
//   a missing or auto width/height is the intrinsic size (the bitmap's; an SVG image's root width/height or viewBox).
//   mix-blend-mode and isolation reach a raster <image> row.
//   a data: URL takes any ;param, reads base64 as UTF-8 and percent-decodes leniently; a binary href is passed through.
//   an href'd gradient keeps its parent's RAW attribute strings and resolves them last, in the child's units.
//   em in gradient coordinates, mask regions and pattern tiles is of the paint server's own font-size, not 16 and not
//          the referencing shape's.
//   a mask region still cuts an element whose clip already nests another clip.
//   a stop offset that 8 bits cannot place exactly takes the 24-bit form; multiples of 1/255 keep the byte layout.
//   a spreadMethod naming an Object.prototype member is pad; a non-finite gradient coordinate is not stored.
//   a pattern's href chain is cut by cycle detection, not at 8 links.
//   the mask-image longhand names a mask as the mask shorthand does.
import { makeChecker, wrap, imp } from './_importSemantics.mjs';

// Node has no Image or canvas: a stub that decodes "...W<w>H<h>" in an href to a w x h bitmap, and remembers every src.
const srcs = [];
globalThis.Image = class {
  set src(v) {
    this._s = v;
    srcs.push(v);
    const m = /W(\d+)H(\d+)/.exec(v || '');
    setTimeout(() => {
      if (!m) {
        this.onerror && this.onerror();
        return;
      }
      this.naturalWidth = +m[1];
      this.naturalHeight = +m[2];
      this.onload && this.onload();
    }, 0);
  }
  get src() {
    return this._s;
  }
};
globalThis.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage() {},
      getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(200) }),
    }),
  }),
};
const IMG = (w, h) => `data:image/png;base64,W${w}H${h}`;

const { decodeSvgDataUrl } = await import('../../src/svg/image.js');
const { fillHitShape, HitMode } = await import('../../src/hitTest/index.js');
const { ok, done } = makeChecker('PAINT-IMAGE-MASK-AUDIT');

const F = (b) => {
  if (!b.meta || b.meta.byteLength <= 32) return [];
  const m = new Float32Array(b.meta, 32),
    out = [];
  for (let r = 0; r < m.length / 48; r++) out.push(m.subarray(r * 48, r * 48 + 48));
  return out;
};
const drawn = (b) => F(b).filter((f) => !(f[27] & 0x100));
const near4 = (a, w, e = 1e-4) =>
  a.length === w.length && w.every((v, i) => Math.abs(a[i] - v) <= e * (1 + Math.abs(v)));
const r4 = (a) => [...a].map((v) => +v.toFixed(4));

// ---- raster <image> -----------------------------------------------------------------------------
const img = async (attrs, extra = '', vb = 'viewBox="0 0 200 200"') => {
  const b = await imp(wrap(`<image ${attrs}/>${extra}`, vb), { preserveViewport: true });
  return drawn(b).find((f) => f[35] > 0) || null;
};
const box = (f) => r4(f.subarray(0, 4)),
  rect = (f) => r4(f.subarray(36, 40));
const I = `href="${IMG(20, 10)}"`;
{
  let f = await img(`${I} x="10" y="10" width="100" height="100"`);
  ok(
    f && near4(box(f), [10, 35, 110, 85]) && near4(rect(f), [10, 35, 100, 50]),
    `the default is xMidYMid meet: a 20x10 bitmap in a 100x100 box is 100x50 centered (${f && rect(f)})`,
  );
  f = await img(`${I} x="10" y="10" width="100" height="100" preserveAspectRatio="xMidYMid meet"`);
  ok(f && near4(rect(f), [10, 35, 100, 50]), 'an explicit xMidYMid meet is the same');
  f = await img(`${I} x="10" y="10" width="100" height="100" preserveAspectRatio="xMinYMin meet"`);
  ok(f && near4(rect(f), [10, 10, 100, 50]), 'xMinYMin meet sits at the top');
  f = await img(`${I} x="10" y="10" width="100" height="100" preserveAspectRatio="xMaxYMax meet"`);
  ok(f && near4(rect(f), [10, 60, 100, 50]), 'xMaxYMax meet sits at the bottom');
  f = await img(`${I} x="10" y="10" width="100" height="100" preserveAspectRatio="xMidYMid slice"`);
  ok(
    f && near4(box(f), [10, 10, 110, 110]) && near4(rect(f), [-40, 10, 200, 100]),
    `slice covers the box and the shape is the box: the image rect is 200x100 centered (${f && rect(f)})`,
  );
  f = await img(`${I} x="10" y="10" width="100" height="100" preserveAspectRatio="xMinYMin slice"`);
  ok(
    f && near4(box(f), [10, 10, 110, 110]) && near4(rect(f), [10, 10, 200, 100]),
    'xMinYMin slice keeps the left edge',
  );
  f = await img(`${I} x="10" y="10" width="100" height="100" preserveAspectRatio="none"`);
  ok(
    f && near4(box(f), [10, 10, 110, 110]) && near4(rect(f), [10, 10, 100, 100]),
    'none stretches to the box',
  );
  f = await img(`href="${IMG(10, 10)}" x="3" y="7" width="50" height="50"`);
  ok(
    f && box(f).join() === '3,7,53,57' && rect(f).join() === '3,7,50,50',
    'a bitmap whose ratio matches is exactly the box',
  );
  f = await img(
    `href="${IMG(20, 10)}" preserveAspectRatio="defer xMinYMin meet" width="100" height="100"`,
  );
  ok(f && near4(rect(f), [0, 0, 100, 50]), 'a SVG 1.1 "defer" prefix is skipped');
  f = await img(
    `${I} x="10" y="10" width="100" height="100" transform="rotate(30)" preserveAspectRatio="xMinYMin slice"`,
  );
  ok(
    f && near4(rect(f), [10, 10, 200, 100]) && f[28] > 0,
    'under a rotation the affine map is kept and the rect is the slice rect in user space',
  );
  for (const k of [2 ** -20, 2 ** 20]) {
    f = await img(
      `${I} x="${10 * k}" y="${10 * k}" width="${100 * k}" height="${100 * k}"`,
      '',
      'viewBox="0 0 1 1"',
    );
    ok(
      f && near4([...f.subarray(36, 40)], [10 * k, 35 * k, 100 * k, 50 * k], 1e-5),
      `meet is the same fit at scale ${k}`,
    );
  }
}
{
  let f = await img(`${I} x="10" y="10"`);
  ok(f && near4(rect(f), [10, 10, 20, 10]), "a missing width and height are the bitmap's");
  f = await img(`${I} x="10" y="10" width="auto" height="auto"`);
  ok(f && near4(rect(f), [10, 10, 20, 10]), 'width and height "auto" are the bitmap\'s');
  f = await img(`${I} x="10" y="10" width="40"`);
  ok(f && near4(rect(f), [10, 10, 40, 20]), 'an auto height follows the ratio from the width');
  f = await img(`${I} x="10" y="10" height="5"`);
  ok(f && near4(rect(f), [10, 10, 10, 5]), 'an auto width follows the ratio from the height');
  f = await img(`${I} width="0" height="10"`);
  ok(!f, 'a stated zero width still draws nothing');
  f = await img(`${I} width="-10" height="10"`);
  ok(!f, 'a negative width still draws nothing');
  const svgImg = (root, w, h, attrs = '') =>
    `<image ${attrs} href="data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" ${root}><rect width="${w}" height="${h}" fill="red"/></svg>`)}"/>`;
  const painted = async (body) =>
    (await imp(wrap(body, 'viewBox="0 0 200 200"'), { preserveViewport: true })) && null;
  const bb = async (body) => {
    const b = await imp(wrap(body, 'viewBox="0 0 200 200"'), { preserveViewport: true });
    return drawn(b)
      .filter((f) => f[7] > 0)
      .map((f) => r4(f.subarray(0, 4)));
  };
  void painted;
  let r = await bb(svgImg('width="30" height="15" viewBox="0 0 100 50"', 100, 50, 'x="5" y="5"'));
  ok(
    r.length === 1 && near4(r[0], [5, 5, 35, 20]),
    `an SVG image with no size takes its root width/height (${JSON.stringify(r)})`,
  );
  r = await bb(svgImg('viewBox="0 0 40 20"', 40, 20, 'x="0" y="0"'));
  ok(r.length === 1 && near4(r[0], [0, 0, 40, 20]), `...or its viewBox (${JSON.stringify(r)})`);
}
{
  const multiply = await img(
    `href="${IMG(4, 4)}" width="50" height="50" style="mix-blend-mode:multiply"`,
  );
  const iso = await img(`href="${IMG(4, 4)}" width="50" height="50" style="isolation:isolate"`);
  const plain = await img(`href="${IMG(4, 4)}" width="50" height="50"`);
  ok(
    multiply && multiply[33] === 1 && multiply[34] === 0,
    `mix-blend-mode:multiply on an image is blend 1 (${multiply && multiply[33]})`,
  );
  ok(iso && iso[34] === 1, 'isolation:isolate on an image reaches the row');
  ok(plain && plain[33] === 0 && plain[34] === 0, 'a plain image stays blend 0, isolation 0');
}

// ---- data URLs --------------------------------------------------------------------------------------------------
{
  const S = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>é日本</text></svg>';
  const b64 = Buffer.from(S).toString('base64');
  ok(
    decodeSvgDataUrl('data:image/svg+xml;base64,' + b64) === S,
    'base64 is read as UTF-8, not Latin-1',
  );
  ok(
    decodeSvgDataUrl('data:image/svg+xml;charset=utf-8;base64,' + b64) === S,
    ';charset=utf-8;base64',
  );
  ok(
    decodeSvgDataUrl('data:image/svg+xml;name=a.svg;base64,' + b64) === S,
    'an unknown ;name= parameter is skipped',
  );
  ok(decodeSvgDataUrl('data:image/svg+xml;utf8,' + S) === S, ';utf8, with a raw body');
  ok(
    decodeSvgDataUrl('data:image/svg+xml,' + encodeURIComponent(S)) === S,
    'percent-encoded UTF-8',
  );
  ok(
    decodeSvgDataUrl("data:image/svg+xml,<svg data-x='50%'/>") === "<svg data-x='50%'/>",
    'a literal % stays',
  );
  ok(
    decodeSvgDataUrl('data:image/svg+xml,a%2Gb%41%') === 'a%2GbA%',
    'a bad escape stays, a good one decodes',
  );
  ok(
    decodeSvgDataUrl('data:image/svg+xml;base64,' + b64.slice(0, 12) + '\n ' + b64.slice(12)) === S,
    'base64 whitespace is ignored',
  );
  ok(
    decodeSvgDataUrl(
      'data:image/svg+xml;base64,' + b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    ) === S,
    'URL-safe, unpadded base64',
  );
  ok(decodeSvgDataUrl('data:image/png;base64,AAAA') === null, 'a raster data URL is not SVG text');
  srcs.length = 0;
  const href = `data:image/png;name=a.png;base64,W3H3%41%`;
  await imp(wrap(`<image href="${href}" width="10" height="10"/>`), { preserveViewport: true });
  ok(srcs.includes(href), 'a binary image href reaches the decoder byte for byte');
  const b = await imp(
    wrap(
      `<image width="100" height="100" href="data:image/svg+xml;utf8,${'<svg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 10 10%27><rect width=%2710%27 height=%2710%27 fill=%27red%27/></svg>'}"/>`,
    ),
    { preserveViewport: true },
  );
  ok(
    drawn(b).some((f) => f[7] > 0),
    'an image with a ;utf8, SVG data URL draws',
  );
}

// ---- gradients ---------------------------------------------------------------------------------------------------------
const ST = '<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>';
const record = async (
  defs,
  vb = 'viewBox="0 0 200 100"',
  shape = '<rect x="50" y="10" width="100" height="40" fill="url(#g)"/>',
) => {
  const b = await imp(wrap(`<defs>${defs}</defs>${shape}`, vb), { preserveViewport: true });
  const f = drawn(b).find((r) => r[28] > 0);
  if (!f) return null;
  const G = new Float32Array(b.gradients),
    o = (f[28] - 1) * 16;
  return { b, g: [...G.subarray(o, o + 16)], row: f };
};
const coords = (r) => r && r.g.slice(12).map((v) => +v.toFixed(3));
{
  let r = await record(
    `<linearGradient id="p">${ST}</linearGradient><linearGradient id="g" href="#p" gradientUnits="userSpaceOnUse"/>`,
  );
  ok(
    r && r.g[2] === 0 && coords(r).join() === '0,0,200,0',
    `a stops-only parent: the child's default x2 is 100% of the viewport (${coords(r)})`,
  );
  r = await record(
    `<linearGradient id="p" gradientUnits="userSpaceOnUse">${ST}</linearGradient><linearGradient id="g" href="#p" gradientUnits="objectBoundingBox"/>`,
  );
  ok(
    r && r.g[2] === 1 && coords(r).join() === '0,0,1,0',
    `the reverse: the default is 1 (${coords(r)})`,
  );
  r = await record(
    `<linearGradient id="p" x2="50%">${ST}</linearGradient><linearGradient id="g" href="#p" gradientUnits="userSpaceOnUse"/>`,
  );
  ok(
    r && coords(r).join() === '0,0,100,0',
    `a parent's x2="50%" is half the viewport under userSpaceOnUse (${coords(r)})`,
  );
  r = await record(
    `<linearGradient id="p" gradientUnits="userSpaceOnUse" x2="80">${ST}</linearGradient><linearGradient id="g" href="#p" gradientUnits="objectBoundingBox"/>`,
  );
  ok(
    r && coords(r).join() === '0,0,80,0',
    "a parent's numeric x2 reads as its raw number in the child's units",
  );
  r = await record(
    `<radialGradient id="p">${ST}</radialGradient><radialGradient id="g" href="#p" gradientUnits="userSpaceOnUse"/>`,
  );
  ok(
    r && Math.abs(r.g[14] - 79.057) < 0.01 && r.g[12] === 100 && r.g[13] === 50,
    `a radial child's default r is 50% of the viewport diagonal (${coords(r)})`,
  );
  r = await record(
    `<linearGradient id="a" x1="10" x2="20">${ST}</linearGradient><linearGradient id="b" href="#a" x2="30"/><linearGradient id="g" href="#b" y2="5"/>`,
  );
  ok(
    r && coords(r).join() === '10,0,30,5',
    `attributes come from the first link that states them (${coords(r)})`,
  );
  r = await record(
    `<linearGradient id="a" x1="1" x2="2">${ST}</linearGradient><radialGradient id="r" href="#a" r="9"/><linearGradient id="g" href="#r"/>`,
  );
  ok(
    r && coords(r).join() === '1,0,2,0',
    `geometry passes through a link of the other kind (${coords(r)})`,
  );
  r = await record(`<linearGradient id="g" href="#g">${ST}</linearGradient>`);
  ok(r && coords(r).join() === '0,0,1,0', 'a self-referencing gradient resolves');
}
{
  const gx = async (extra, host = '') => {
    const r = await record(
      `<linearGradient id="g" gradientUnits="userSpaceOnUse" x2="5em" ${extra}>${ST}</linearGradient>`,
      'viewBox="0 0 200 200"',
      `<rect width="100" height="100" ${host} fill="url(#g)"/>`,
    );
    return r && r.g[14];
  };
  ok(
    (await gx('font-size="20"')) === 100,
    "em in a gradient coordinate is of the gradient's own font-size",
  );
  ok(
    (await gx('', 'font-size="20"')) === 80,
    "...not the referencing shape's (the default 16 applies)",
  );
  ok((await gx('style="font-size:25px"')) === 125, '...from a style declaration');
  const doc = wrap(
    `<style>svg{font-size:20px}</style><defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x2="5em">${ST}</linearGradient></defs><rect width="100" height="100" fill="url(#g)"/>`,
    'viewBox="0 0 200 200"',
  );
  const b = await imp(doc, { preserveViewport: true }),
    f = drawn(b).find((r) => r[28] > 0);
  ok(
    new Float32Array(b.gradients)[(f[28] - 1) * 16 + 14] === 100,
    "...or an ancestor's, set by a rule",
  );
}
{
  // the stop LUT of the first gradient: [{ off, c }]
  const stopsOf = (b) => {
    const g = new Float32Array(b.gradients),
      off = g[10],
      cnt = g[11],
      S = new Uint8Array(b.gradientStops),
      n = Math.abs(cnt),
      out = [];
    for (let i = 0; i < n; i++) {
      if (cnt < 0) out.push(S[(off + i) * 4 + 3] / 255);
      else {
        const p = (off + 2 * i) * 4 + 4;
        out.push(S[p] / 255 + S[p + 1] / 65025 + S[p + 2] / 16581375);
      }
    }
    return { cnt, offs: out };
  };
  const lut = async (stops) => {
    const b = await imp(
      wrap(
        `<defs><linearGradient id="g">${stops}</linearGradient></defs><rect width="100" height="10" fill="url(#g)"/>`,
      ),
      { preserveViewport: true },
    );
    return { b, ...stopsOf(b) };
  };
  const hard = (o) =>
    `<stop offset="0" stop-color="red"/><stop offset="${o}" stop-color="red"/><stop offset="${o}" stop-color="blue"/><stop offset="1" stop-color="blue"/>`;
  for (const o of [0.5, 0.1, 0.3, 0.7, 0.9]) {
    const r = await lut(hard(o));
    ok(
      r.cnt > 0 && r.offs.every((v, i) => Math.abs(v - [0, o, o, 1][i]) < 1e-7),
      `an opaque hard stop at ${o.toFixed(4)} is placed to 1e-7, not rounded to a byte (${r.offs.map((v) => v.toFixed(5))})`,
    );
  }
  let r = await lut(
    `<stop offset="0" stop-color="red"/><stop offset="0.2" stop-color="lime"/><stop offset="1" stop-color="blue"/>`,
  );
  ok(
    r.cnt === -3 && r.offs.join() === [0, 51 / 255, 1].join(),
    'offsets that are multiples of 1/255 keep the one-texel byte layout',
  );
  const bytes = (b) => [...new Uint8Array(b.gradientStops)].join();
  r = await lut(
    `<stop offset="0" stop-color="red"/><stop offset="0.5" stop-color="red" stop-opacity="0"/><stop offset="1" stop-color="blue"/>`,
  );
  ok(
    r.cnt === 3 && Math.abs(r.offs[1] - 0.5) < 1e-7,
    'a gradient with alpha stops places 0.5 exactly too',
  );
  const a = await lut(`<stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/>`);
  ok(
    a.cnt === -2 && bytes(a.b) === '255,0,0,0,0,0,255,255',
    'a plain two-stop gradient is unchanged',
  );
}
{
  const spread = async (sm) => {
    const r = await record(`<linearGradient id="g" spreadMethod="${sm}">${ST}</linearGradient>`);
    return r && r.g[1];
  };
  ok(
    (await spread('reflect')) === 1 &&
      (await spread('repeat')) === 2 &&
      (await spread('pad')) === 0,
    'the three spread methods',
  );
  for (const sm of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'bogus'])
    ok((await spread(sm)) === 0, `spreadMethod="${sm}" is pad`);
  for (const v of ['Infinity', '-Infinity', '1e999', 'NaN']) {
    const r = await record(
      `<radialGradient id="g" cx="${v}" cy="${v}" r="${v}" fx="${v}" fy="${v}">${ST}</radialGradient>`,
    );
    ok(r && r.g.every(Number.isFinite), `radial cx/cy/r/fx/fy = ${v} leaves finite record slots`);
    const l = await record(
      `<linearGradient id="g" x1="${v}" y1="${v}" x2="${v}" y2="${v}">${ST}</linearGradient>`,
    );
    ok(l && l.g.every(Number.isFinite), `linear x1/y1/x2/y2 = ${v} leaves finite record slots`);
  }
}

// ---- patterns ----------------------------------------------------------------------------------------------------------
const tileOf = async (
  defs,
  shape = '<rect x="20" y="10" width="60" height="40" fill="url(#p)"/>',
  attrs = 'viewBox="0 0 200 200"',
) => {
  const b = await imp(wrap(`<defs>${defs}</defs>${shape}`, attrs), { preserveViewport: true });
  const f = F(b).find((r) => Math.abs(r[43] - 2) < 0.5);
  return f ? r4(f.subarray(36, 40)) : null;
};
{
  const chain = (n) => {
    let d = '';
    for (let i = 0; i < n; i++)
      d += `<pattern id="c${i}" ${i < n - 1 ? `href="#c${i + 1}"` : 'width="10" height="10" patternUnits="userSpaceOnUse"'}>${i === 0 ? '<rect width="5" height="5" fill="red"/>' : ''}</pattern>`;
    return d;
  };
  for (const n of [3, 12, 100]) {
    const t = await tileOf(chain(n) + '<pattern id="p" href="#c0"/>');
    ok(
      t && t.join() === '0,0,10,10',
      `a ${n}-deep href chain keeps the width and height at its end (${t})`,
    );
  }
  const cyc = await tileOf(
    '<pattern id="p" href="#q" width="10" height="10" patternUnits="userSpaceOnUse"><rect width="5" height="5" fill="red"/></pattern><pattern id="q" href="#p" x="3"/>',
  );
  ok(cyc && cyc.join() === '3,0,10,10', `a cycle ends the chain with what it collected (${cyc})`);
  const P = (a) =>
    `<pattern id="p" width="1em" height="1em" patternUnits="userSpaceOnUse" ${a}><rect width="3" height="3" fill="red"/></pattern>`;
  let t = await tileOf(P('font-size="20"'));
  ok(t && t[2] === 20 && t[3] === 20, `a pattern tile in em is of the pattern's font-size (${t})`);
  t = await tileOf(P(''), '<rect width="100" height="100" font-size="30" fill="url(#p)"/>');
  ok(t && t[2] === 16, `...not of the referencing shape's (${t})`);
  t = await tileOf(P(''), '<rect width="100" height="100" fill="url(#p)"/>').then(async () =>
    tileOf('<g font-size="40">' + P('') + '</g>'),
  );
  ok(t && t[2] === 40, `...but of an ancestor's (${t})`);
}

// ---- masks and clips, through the hit test in Coverage mode (the rendered coverage; Auto follows the SVG pointer-events model, where a mask never matters) -------------------------------------------------------------
const W = '<rect x="-1000" y="-1000" width="3000" height="3000" fill="white"/>';
const sq = (x, w) => `<rect x="${x}" y="0" width="${w}" height="100"/>`;
const alphaGrid = async (body, pts, vb = 'viewBox="0 0 100 100"') => {
  const b = await imp(wrap(body, vb), { preserveViewport: true });
  return pts.map(([x, y]) =>
    fillHitShape(b, x, y, { mode: HitMode.Coverage, minAlpha: 0.5 }) >= 0 ? 1 : 0,
  );
};
const R = '<rect width="100" height="40" fill="red"';
{
  const REG = `<mask id="m" maskUnits="userSpaceOnUse" x="30" y="0" width="20" height="100">${W}</mask>`;
  const pts = [
    [20, 20],
    [40, 20],
    [60, 20],
    [85, 20],
  ];
  let v = await alphaGrid(
    `<defs><clipPath id="c">${sq(10, 80)}</clipPath>${REG}</defs>${R} clip-path="url(#c)" mask="url(#m)"/>`,
    pts,
  );
  ok(v.join() === '0,1,0,0', `control: a single clip and a mask region (${v})`);
  v = await alphaGrid(
    `<defs><clipPath id="d">${sq(0, 80)}</clipPath><clipPath id="c" clip-path="url(#d)">${sq(10, 80)}</clipPath>${REG}</defs>${R} clip-path="url(#c)" mask="url(#m)"/>`,
    pts,
  );
  ok(v.join() === '0,1,0,0', `clip-of-clip plus a mask region (${v})`);
  v = await alphaGrid(
    `<defs><clipPath id="a">${sq(0, 80)}</clipPath><clipPath id="c">${sq(10, 80)}</clipPath>${REG}</defs><g clip-path="url(#a)">${R} clip-path="url(#c)" mask="url(#m)"/></g>`,
    pts,
  );
  ok(v.join() === '0,1,0,0', `a group clip, an own clip and a mask region (${v})`);
  v = await alphaGrid(
    `<defs><clipPath id="c3">${sq(0, 60)}</clipPath><clipPath id="c2" clip-path="url(#c3)">${sq(10, 70)}</clipPath><clipPath id="c1" clip-path="url(#c2)">${sq(20, 70)}</clipPath>${REG}</defs>${R} clip-path="url(#c1)" mask="url(#m)"/>`,
    pts,
  );
  ok(v.join() === '0,1,0,0', `a three-deep clip chain and a mask region (${v})`);
  v = await alphaGrid(
    `<defs><clipPath id="d">${sq(0, 80)}</clipPath><clipPath id="c" clip-path="url(#d)">${sq(10, 80)}</clipPath>${REG}</defs>${R} clip-path="url(#c)" mask="url(#m)" style="stroke:blue;stroke-width:0"/>`,
    pts,
  );
  ok(v.join() === '0,1,0,0', 'the same through a style attribute');
  v = await alphaGrid(
    `<defs><clipPath id="d">${sq(0, 80)}</clipPath><clipPath id="c" clip-path="url(#d)">${sq(10, 80)}</clipPath><mask id="m" maskUnits="userSpaceOnUse" x="30" y="0" width="20" height="100"><rect x="-1000" y="-1000" width="3000" height="3000" fill="white"/><rect x="35" width="10" height="100" fill="black"/></mask></defs>${R} clip-path="url(#c)" mask="url(#m)"/>`,
    [
      [32, 20],
      [40, 20],
      [47, 20],
      [60, 20],
    ],
  );
  ok(v.join() === '1,0,1,0', `the mask's own content still masks inside the region (${v})`);
  v = await alphaGrid(
    `<defs><clipPath id="d">${sq(0, 80)}</clipPath><clipPath id="c" clip-path="url(#d)">${sq(10, 80)}</clipPath><mask id="m">${W}</mask></defs>${R} clip-path="url(#c)" mask="url(#m)"/>`,
    pts,
  );
  ok(
    v.join() === '1,1,1,0',
    `a mask whose region holds the element leaves the nested clip as it was (${v})`,
  );
}
{
  const MASK = `<mask id="m"><rect width="30" height="100" fill="white"/></mask>`;
  let v = await alphaGrid(
    `<defs>${MASK}</defs><rect width="100" height="40" fill="red" style="mask-image:url(#m)"/>`,
    [
      [10, 20],
      [60, 20],
    ],
  );
  ok(v.join() === '1,0', `the mask-image longhand names the mask (${v})`);
  v = await alphaGrid(
    `<defs>${MASK}<style>.k{mask-image:url(#m)}</style></defs><rect class="k" width="100" height="40" fill="red"/>`,
    [
      [10, 20],
      [60, 20],
    ],
  );
  ok(v.join() === '1,0', `...from a stylesheet rule (${v})`);
  v = await alphaGrid(
    `<defs>${MASK}</defs><rect width="100" height="40" fill="red" style="mask-image:none"/>`,
    [
      [10, 20],
      [60, 20],
    ],
  );
  ok(v.join() === '1,1', `mask-image:none masks nothing (${v})`);
  v = await alphaGrid(
    `<defs>${MASK}</defs><rect width="100" height="40" fill="red" style="mask:url(#m)"/>`,
    [
      [10, 20],
      [60, 20],
    ],
  );
  ok(v.join() === '1,0', 'the mask shorthand is unchanged');
  const mr = await alphaGrid(
    `<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="5em" height="100" font-size="20">${W}</mask></defs><rect width="200" height="40" fill="red" mask="url(#m)"/>`,
    [
      [90, 20],
      [110, 20],
    ],
    'viewBox="0 0 200 100"',
  );
  ok(mr.join() === '1,0', `a mask region in em is of the mask's font-size (${mr})`);
}

done();
