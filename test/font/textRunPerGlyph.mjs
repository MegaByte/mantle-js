// Dump per-glyph (bandsX, bandsY, bbox).
import { readFileSync } from 'fs';
import { MantleFontAsset } from '../../src/font/fontAsset.js';
import { pathBbox, segBbox, makeTexelBuffer, texelAppend, buildTexturesShape } from '../../src/svg/importer.js';

const font = new MantleFontAsset(new Uint8Array(readFileSync('/System/Library/Fonts/Supplemental/Arial.ttf')));
font.getMetrics(0x20);
const invUpem = 1 / font.unitsPerEm;

function pickBandsAxis(n) {
  return Math.max(4, Math.min(96, Math.round(Math.sqrt(Math.max(1, n) * 32))));
}
function pickBandsXY(segs, bbox) {
  const w = Math.max(1e-6, bbox[2] - bbox[0]);
  const h = Math.max(1e-6, bbox[3] - bbox[1]);
  let nx = 0, ny = 0;
  for (const s of segs) {
    const sb = segBbox(s);
    if (!sb) { nx++; ny++; continue; }
    if (sb[3] - sb[1] > h * 0.005) nx++;
    if (sb[2] - sb[0] > w * 0.005) ny++;
  }
  if (nx === 0) nx = segs.length;
  if (ny === 0) ny = segs.length;
  return { bandsX: pickBandsAxis(ny), bandsY: pickBandsAxis(nx) };
}

const curveBuf = makeTexelBuffer();
const bandBuf  = makeTexelBuffer();
texelAppend(curveBuf, 0, 0, 0, 0);

let penX = 0;
for (const ch of 'Hello, World!') {
  const cp = ch.codePointAt(0);
  const m = font.getMetrics(cp);
  const src = font.getGlyphSegs(cp);
  if (src && src.length > 0) {
    const segs = src.map(s => ({
      ...s,
      p1: [penX + s.p1[0] * invUpem, -s.p1[1] * invUpem],
      p2: [penX + s.p2[0] * invUpem, -s.p2[1] * invUpem],
      ...(s.p3 ? { p3: [penX + s.p3[0] * invUpem, -s.p3[1] * invUpem] } : {}),
      ...(s.p4 ? { p4: [penX + s.p4[0] * invUpem, -s.p4[1] * invUpem] } : {}),
    }));
    const bb = pathBbox(segs);
    const { bandsX, bandsY } = pickBandsXY(segs, bb);
    const cb = curveBuf.count, bb0 = bandBuf.count;
    buildTexturesShape(segs, bandsX, bandsY, bb, curveBuf, bandBuf);
    const dC = curveBuf.count - cb, dB = bandBuf.count - bb0;
    console.log(`${ch}\tbX=${bandsX} bY=${bandsY}\tΔcurve=${dC} Δband=${dB}\tbbox=(${bb.map(v => v.toFixed(4)).join(', ')})`);
  } else {
    console.log(`${ch === ' ' ? '(sp)' : ch}\tempty`);
  }
  penX += m.advance;
}
