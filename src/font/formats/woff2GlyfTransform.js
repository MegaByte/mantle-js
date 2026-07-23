// woff2GlyfTransform.js — woff2 'glyf' + 'loca' untransform.
// Triplet decoding plus a TT simple-glyph re-encoder.

/**
 * @param {Uint8Array} src
 * @param {number} srcOff
 * @param {number} srcLen
 * @returns {{ glyf: Uint8Array, loca: Uint8Array }}
 */
export function untransformGlyfLoca(src, srcOff, srcLen) {
  let o = srcOff;
  o += 2; // reserved
  const optionFlags = readU16(src, o); o += 2;
  const numGlyphs   = readU16(src, o); o += 2;
  const indexFormat = readU16(src, o); o += 2;
  const nC_sz = readU32(src, o); o += 4;
  const nP_sz = readU32(src, o); o += 4;
  const fl_sz = readU32(src, o); o += 4;
  const gl_sz = readU32(src, o); o += 4;
  const cp_sz = readU32(src, o); o += 4;
  const bb_sz = readU32(src, o); o += 4;
  const in_sz = readU32(src, o); o += 4;

  const oNC = o;
  const oNP = oNC + nC_sz;
  const oFL = oNP + nP_sz;
  const oGL = oFL + fl_sz;
  const oCP = oGL + gl_sz;
  const oBM = oCP + cp_sz;
  // Spec: the bboxBitmap is padded to a 4-byte boundary — (n+7)>>3 starts
  // the bbox stream up to 3 bytes early for numGlyphs % 32 in 1..24,
  // corrupting every explicit bbox (all composites).
  const bmLen = 4 * ((numGlyphs + 31) >> 5);
  const oBS = oBM + bmLen;
  const oIN = oBM + bb_sz;
  const oOverlap = oIN + in_sz;
  const hasOverlap = (optionFlags & 0x0001) !== 0;

  let curNC = oNC, curNP = oNP, curFL = oFL, curGL = oGL;
  let curComp = oCP, curBS = oBS, curIN = oIN;

  const glyphBufs = new Array(numGlyphs);
  for (let gid = 0; gid < numGlyphs; gid++) {
    const nContours = readI16(src, curNC); curNC += 2;
    const hasBbox = ((src[oBM + (gid >> 3)] >> (7 - (gid & 7))) & 1) !== 0;

    if (nContours === 0) {
      glyphBufs[gid] = new Uint8Array(0);
      if (hasBbox) curBS += 8;
      continue;
    }
    if (nContours > 0) {
      // Simple glyph.
      const endPts = new Array(nContours);
      let total = 0;
      for (let i = 0; i < nContours; i++) {
        const r = read255U16(src, curNP);
        total += r.value; curNP = r.cursor;
        endPts[i] = total - 1;
      }
      const ttFlags = new Uint8Array(total);
      const xs = new Int32Array(total);
      const ys = new Int32Array(total);
      let xPrev = 0, yPrev = 0;
      for (let p = 0; p < total; p++) {
        const wFlag = src[curFL++];
        const onCurve = (wFlag & 0x80) === 0;
        const tIdx = wFlag & 0x7F;
        const t = kTriplets[tIdx];
        const d = decodeTriplet(src, curGL, t); curGL = d.cursor;
        xPrev += d.dx; yPrev += d.dy;
        xs[p] = xPrev; ys[p] = yPrev;
        ttFlags[p] = onCurve ? 0x01 : 0x00;
        if (hasOverlap && p === 0) {
          // The overlapSimpleBitmap is indexed by GLYPH ID (spec /
          // fontTools) — a sequential per-simple-glyph cursor drifts as
          // soon as any composite or empty glyph precedes a simple one.
          const byteIdx = gid >> 3;
          const bitIdx  = 7 - (gid & 7);
          if ((src[oOverlap + byteIdx] >> bitIdx) & 1) ttFlags[p] |= 0x40;
        }
      }
      const ilr = read255U16(src, curGL); curGL = ilr.cursor;
      const instrLen = ilr.value;
      let xMin, yMin, xMax, yMax;
      if (hasBbox) {
        xMin = readI16(src, curBS    );
        yMin = readI16(src, curBS + 2);
        xMax = readI16(src, curBS + 4);
        yMax = readI16(src, curBS + 6);
        curBS += 8;
      } else {
        xMin = 0x7FFF; yMin = 0x7FFF; xMax = -0x8000; yMax = -0x8000;
        for (let p = 0; p < total; p++) {
          if (xs[p] < xMin) xMin = xs[p];
          if (xs[p] > xMax) xMax = xs[p];
          if (ys[p] < yMin) yMin = ys[p];
          if (ys[p] > yMax) yMax = ys[p];
        }
      }
      glyphBufs[gid] = composeSimpleGlyph(
        nContours, xMin, yMin, xMax, yMax,
        endPts, ttFlags, xs, ys,
        src, curIN, instrLen);
      curIN += instrLen;
    } else {
      // Composite glyph.
      const start = curComp;
      let moreComp;
      let needInstr = false;
      do {
        const cflags = readU16(src, curComp); curComp += 2;
        moreComp = (cflags & 0x0020) !== 0;
        if (cflags & 0x0100) needInstr = true;
        curComp += 2; // glyphIndex
        const wordArgs = (cflags & 0x0001) !== 0;
        curComp += wordArgs ? 4 : 2;
        if      (cflags & 0x0008) curComp += 2;
        else if (cflags & 0x0040) curComp += 4;
        else if (cflags & 0x0080) curComp += 8;
      } while (moreComp);
      const compLen = curComp - start;
      let instrLen = 0;
      if (needInstr) {
        const r = read255U16(src, curGL); instrLen = r.value; curGL = r.cursor;
      }
      let xMin = 0, yMin = 0, xMax = 0, yMax = 0;
      if (hasBbox) {
        xMin = readI16(src, curBS    );
        yMin = readI16(src, curBS + 2);
        xMax = readI16(src, curBS + 4);
        yMax = readI16(src, curBS + 6);
        curBS += 8;
      }
      glyphBufs[gid] = composeCompositeGlyph(
        nContours, xMin, yMin, xMax, yMax,
        src, start, compLen,
        needInstr, src, curIN, instrLen);
      curIN += instrLen;
    }
  }

  // Stitch glyf + loca.
  let totalGlyf = 0;
  for (let i = 0; i < numGlyphs; i++) {
    let len = glyphBufs[i].length;
    if (len & 1) len++;
    totalGlyf += len;
  }
  const glyf = new Uint8Array(totalGlyf);
  const locaCount = numGlyphs + 1;
  const loca = indexFormat === 0
    ? new Uint8Array(locaCount * 2)
    : new Uint8Array(locaCount * 4);
  let w = 0;
  for (let i = 0; i < numGlyphs; i++) {
    writeLoca(loca, i, indexFormat, w);
    const len = glyphBufs[i].length;
    if (len > 0) glyf.set(glyphBufs[i], w);
    w += len;
    if (len & 1) w++;
  }
  writeLoca(loca, numGlyphs, indexFormat, w);
  return { glyf, loca };
}

function composeSimpleGlyph(nContours, xMin, yMin, xMax, yMax,
                            endPts, ttFlags, xs, ys, src, instrSrc, instrLen) {
  const total = xs.length;
  const deltasX = new Int32Array(total);
  const deltasY = new Int32Array(total);
  const finalFlags = new Uint8Array(total);
  let xPrev = 0, yPrev = 0, xBytes = 0, yBytes = 0;
  for (let p = 0; p < total; p++) {
    const dx = xs[p] - xPrev, dy = ys[p] - yPrev;
    xPrev = xs[p]; yPrev = ys[p];
    deltasX[p] = dx; deltasY[p] = dy;
    let f = ttFlags[p];
    if (dx === 0) f |= 0x10;
    else if (dx > -256 && dx < 256) { f |= 0x02; if (dx > 0) f |= 0x10; xBytes += 1; }
    else xBytes += 2;
    if (dy === 0) f |= 0x20;
    else if (dy > -256 && dy < 256) { f |= 0x04; if (dy > 0) f |= 0x20; yBytes += 1; }
    else yBytes += 2;
    finalFlags[p] = f;
  }
  // RLE flag compression.
  const flagBytes = [];
  for (let p = 0; p < total;) {
    const f = finalFlags[p];
    let run = 1;
    while (p + run < total && finalFlags[p + run] === f && run < 255) run++;
    if (run > 1) { flagBytes.push(f | 0x08, run - 1); }
    else         { flagBytes.push(f); }
    p += run;
  }
  const headerLen = 10 + endPts.length * 2 + 2 + instrLen;
  const totalLen = headerLen + flagBytes.length + xBytes + yBytes;
  const buf = new Uint8Array(totalLen);
  let o = 0;
  writeI16(buf, o, nContours); o += 2;
  writeI16(buf, o, xMin); o += 2;
  writeI16(buf, o, yMin); o += 2;
  writeI16(buf, o, xMax); o += 2;
  writeI16(buf, o, yMax); o += 2;
  for (let i = 0; i < endPts.length; i++) { writeU16(buf, o, endPts[i]); o += 2; }
  writeU16(buf, o, instrLen); o += 2;
  if (instrLen > 0) { buf.set(src.subarray(instrSrc, instrSrc + instrLen), o); o += instrLen; }
  for (const fb of flagBytes) buf[o++] = fb;
  for (let p = 0; p < total; p++) {
    const dx = deltasX[p], f = finalFlags[p];
    if (f & 0x02) buf[o++] = Math.abs(dx);
    else if (!(f & 0x10)) { writeI16(buf, o, dx); o += 2; }
  }
  for (let p = 0; p < total; p++) {
    const dy = deltasY[p], f = finalFlags[p];
    if (f & 0x04) buf[o++] = Math.abs(dy);
    else if (!(f & 0x20)) { writeI16(buf, o, dy); o += 2; }
  }
  return buf;
}

function composeCompositeGlyph(nContours, xMin, yMin, xMax, yMax,
                               compSrc, compOff, compLen,
                               needInstr, instrSrc, instrSrcOff, instrLen) {
  const total = 10 + compLen + (needInstr ? 2 + instrLen : 0);
  const buf = new Uint8Array(total);
  let o = 0;
  writeI16(buf, o, nContours); o += 2;
  writeI16(buf, o, xMin); o += 2;
  writeI16(buf, o, yMin); o += 2;
  writeI16(buf, o, xMax); o += 2;
  writeI16(buf, o, yMax); o += 2;
  buf.set(compSrc.subarray(compOff, compOff + compLen), o); o += compLen;
  if (needInstr) {
    writeU16(buf, o, instrLen); o += 2;
    if (instrLen > 0) buf.set(instrSrc.subarray(instrSrcOff, instrSrcOff + instrLen), o);
  }
  return buf;
}

function writeLoca(loca, gid, indexFormat, byteOffset) {
  if (indexFormat === 0) {
    const half = byteOffset >> 1, o = gid * 2;
    loca[o] = (half >> 8) & 0xFF; loca[o + 1] = half & 0xFF;
  } else {
    const o = gid * 4;
    loca[o]     = (byteOffset >>> 24) & 0xFF;
    loca[o + 1] = (byteOffset >>> 16) & 0xFF;
    loca[o + 2] = (byteOffset >>>  8) & 0xFF;
    loca[o + 3] = byteOffset & 0xFF;
  }
}

// Triplet table (WOFF2 §5.1.1).
const kTriplets = buildTriplets();

function buildTriplets() {
  const t = new Array(128);
  const yPairs1 = [0, 0, 256, 256, 512, 512, 768, 768, 1024, 1024];
  const ySign1  = [-1, +1, -1, +1, -1, +1, -1, +1, -1, +1];
  for (let i = 0; i < 10; i++) {
    t[i] = { coordBytes: 1, xBits: 0, yBits: 8, deltaX: 0, deltaY: yPairs1[i], signX: 0, signY: ySign1[i] };
  }
  for (let i = 0; i < 10; i++) {
    t[10 + i] = { coordBytes: 1, xBits: 8, yBits: 0, deltaX: yPairs1[i], deltaY: 0, signX: ySign1[i], signY: 0 };
  }
  const band4 = [1, 17, 33, 49];
  const signs = [[-1, -1], [+1, -1], [-1, +1], [+1, +1]];
  for (let xi = 0; xi < 4; xi++)
    for (let yi = 0; yi < 4; yi++)
      for (let s = 0; s < 4; s++) {
        const idx = 20 + xi * 16 + yi * 4 + s;
        t[idx] = { coordBytes: 1, xBits: 4, yBits: 4,
          deltaX: band4[xi], deltaY: band4[yi],
          signX: signs[s][0], signY: signs[s][1] };
      }
  const band8 = [1, 257, 513];
  for (let xi = 0; xi < 3; xi++)
    for (let yi = 0; yi < 3; yi++)
      for (let s = 0; s < 4; s++) {
        const idx = 84 + xi * 12 + yi * 4 + s;
        t[idx] = { coordBytes: 2, xBits: 8, yBits: 8,
          deltaX: band8[xi], deltaY: band8[yi],
          signX: signs[s][0], signY: signs[s][1] };
      }
  for (let s = 0; s < 4; s++)
    t[120 + s] = { coordBytes: 3, xBits: 12, yBits: 12, deltaX: 0, deltaY: 0,
      signX: signs[s][0], signY: signs[s][1] };
  for (let s = 0; s < 4; s++)
    t[124 + s] = { coordBytes: 4, xBits: 16, yBits: 16, deltaX: 0, deltaY: 0,
      signX: signs[s][0], signY: signs[s][1] };
  return t;
}

function decodeTriplet(src, cursor, t) {
  let packed = 0;
  for (let i = 0; i < t.coordBytes; i++) {
    packed = (packed << 8) | src[cursor++];
  }
  const xMask = t.xBits === 0 ? 0 : ((1 << t.xBits) - 1);
  const yMask = t.yBits === 0 ? 0 : ((1 << t.yBits) - 1);
  const xRaw = t.xBits === 0 ? 0 : ((packed >>> t.yBits) & xMask);
  const yRaw = packed & yMask;
  const xMag = xRaw + t.deltaX;
  const yMag = yRaw + t.deltaY;
  return { dx: t.signX < 0 ? -xMag : xMag, dy: t.signY < 0 ? -yMag : yMag, cursor };
}

function readU16(b, o) { return (b[o] << 8) | b[o + 1]; }
function readI16(b, o) { const v = (b[o] << 8) | b[o + 1]; return v >= 0x8000 ? v - 0x10000 : v; }
function readU32(b, o) {
  return ((b[o] * 0x1000000) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]) >>> 0;
}
function writeU16(b, o, v) { b[o] = (v >> 8) & 0xFF; b[o + 1] = v & 0xFF; }
function writeI16(b, o, v) {
  if (v < 0) v = v + 0x10000;
  b[o] = (v >> 8) & 0xFF; b[o + 1] = v & 0xFF;
}

// 255UInt16: 253 → next u16; 254 → next byte + 506; 255 → next byte + 253; else literal.
function read255U16(b, cursor) {
  const first = b[cursor++];
  if (first === 253) return { value: (b[cursor] << 8) | b[cursor + 1], cursor: cursor + 2 };
  if (first === 254) return { value: b[cursor] + 506, cursor: cursor + 1 };
  if (first === 255) return { value: b[cursor] + 253, cursor: cursor + 1 };
  return { value: first, cursor };
}
