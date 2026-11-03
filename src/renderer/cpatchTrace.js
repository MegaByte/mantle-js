// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// CPatch decision traces as a BAKE: the search's decisions per contour (see convertContour's
// `opts.trace` and replayContour), keyed by the geometry they were recorded on, in a byte form.
//
// A trace is a list of small records -- which branch, which curve, which constructed candidate
// -- and it is what a prebaked shape carries instead of its patches: ~6 bytes per patch here
// against ~40 for a parametric layout, and the geometry is rebuilt by replaying the cuts on the
// runtime's own curves. The key is a hash of cpatchConvKey, which is the same geometry-valued
// string the conversion cache uses, so a bake made from different curves (a different decode
// precision, a re-exported asset) misses and the shape converts from scratch as before.
//
// Byte form, little-endian throughout:
//   'CPT5' | count varint | per entry: key hash (8 bytes) | trace bytes length varint | trace
//   trace record: op byte (low 4 bits op; for 'line' bit 4 = leak point present, bit 5 = past)
//     keep   row varint
//     line   tag byte, i varint, j varint, [leak point: two float64]
//     own / chord / sub   i varint
//     curve  i varint, then the crossing pair aj ak bj bk as varints
//     norm   k, ox, oy as three float64: the FRAME the search ran in
//     split  n varint, parts varint: the contour converted as its count-first pieces
//     frame  nothing: the search ran in the contour's own frame, derived from its curves
//     drop / term / resolve / skip   nothing
//
// 'CPT3' ADDED `norm`, AND THAT IS THE whole DIFFERENCE. A contour that came off the refusal
// ladder's normalized rung chose its cut lines in a scaled, translated frame, so replaying those
// coefficients against the caller's own geometry cuts in the wrong places -- and until the frame
// could travel with them, such a conversion recorded nothing and every bake missed on it. One
// record at the head of the trace carries it (see convertNormalized and replayContour). A 'CPT2'
// bake is still read, because nothing in it can contain the new op; a 'CPT2' READER handed a
// 'CPT3' bake will refuse it at the magic rather than mis-replay a frame it cannot see.
//
// 'CPT4' ADDED `split`: a contour above CP_SPLIT_ABOVE curves converts as its
// count-first pieces on every route, and its trace opens with the ear bound and the piece count,
// from which the replay re-derives the pieces. An older bake has no split record and replays the
// whole-contour decomposition it recorded, which is still the frame it was made from.
//
// 'CPT5' ADDED `frame`: every conversion runs in its contour's own frame -- origin at
// its box corner, scale a power of two -- and its trace opens with this record, which carries
// nothing because the frame is a function of the curves the bake is keyed on. An older bake has no
// frame record and replays the decisions it recorded in the caller's coordinates, a valid
// decomposition but not the framed one; a CPT4 reader refuses a CPT5 bake at the magic.

const OPS = [
  'drop',
  'keep',
  'line',
  'own',
  'chord',
  'curve',
  'sub',
  'term',
  'resolve',
  'skip',
  'extend',
  'ear',
  'slim',
  'norm',
  'split',
  'frame',
];
// The line candidates by construction tag (cutCandidates); the byte is the index here.
const TAGS = [
  'tan0',
  'nrm0',
  'tan1',
  'nrm1',
  'chord',
  'hull0:0',
  'hull0:1',
  'hull0:2',
  'hull1:0',
  'hull1:1',
  'hull1:2',
  'leakV',
  'leakM',
  'fanV:1:1',
  'fanM:1:1',
  'fanV:1:-1',
  'fanM:1:-1',
  'fanV:2:1',
  'fanM:2:1',
  'fanV:2:-1',
  'fanM:2:-1',
  'fanV:3:1',
  'fanM:3:1',
  'fanV:3:-1',
  'fanM:3:-1',
  'vchord:0',
  'vchord:1',
  'vchord:2',
  'vchord:3',
];
const TAG_INDEX = new Map(TAGS.map((t, i) => [t, i]));

class ByteWriter {
  constructor() {
    this.buf = new Uint8Array(1024);
    this.n = 0;
  }
  grow(k) {
    if (this.n + k > this.buf.length) {
      const b = new Uint8Array(Math.max(this.buf.length * 2, this.n + k));
      b.set(this.buf);
      this.buf = b;
    }
  }
  byte(v) {
    this.grow(1);
    this.buf[this.n++] = v & 255;
  }
  varint(v) {
    v = v >>> 0;
    do {
      let b = v & 127;
      v >>>= 7;
      if (v) b |= 128;
      this.byte(b);
    } while (v);
  }
  f64(v) {
    this.grow(8);
    new DataView(this.buf.buffer).setFloat64(this.n, v, true);
    this.n += 8;
  }
  bytes(u8) {
    this.grow(u8.length);
    this.buf.set(u8, this.n);
    this.n += u8.length;
  }
  done() {
    return this.buf.slice(0, this.n);
  }
}
class ByteReader {
  constructor(u8, at = 0) {
    this.u8 = u8;
    this.at = at;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  }
  byte() {
    return this.u8[this.at++];
  }
  varint() {
    let v = 0,
      s = 0;
    for (;;) {
      const b = this.u8[this.at++];
      v |= (b & 127) << s;
      if (!(b & 128)) return v >>> 0;
      s += 7;
    }
  }
  f64() {
    const v = this.dv.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }
}

export function encodeTrace(trace, w = new ByteWriter()) {
  for (const r of trace) {
    const op = OPS.indexOf(r.op);
    if (op < 0) throw new Error('cpatchTrace: unknown op ' + r.op);
    if (r.op === 'line') {
      const tg = TAG_INDEX.get(r.tag);
      if (tg === undefined) throw new Error('cpatchTrace: unknown tag ' + r.tag);
      w.byte(op | (r.lk ? 16 : 0) | (r.past ? 32 : 0));
      w.byte(tg);
      w.varint(r.i);
      w.varint(r.j);
      if (r.lk) {
        w.f64(r.point[0]);
        w.f64(r.point[1]);
      }
    } else if (r.op === 'norm') {
      w.byte(op);
      w.f64(r.k);
      w.f64(r.ox);
      w.f64(r.oy);
    } else if (r.op === 'split') {
      w.byte(op);
      w.varint(r.n);
      w.varint(r.parts);
    } else if (r.op === 'keep') {
      w.byte(op);
      w.varint(r.row | 0);
    } else if (r.op === 'curve') {
      const p = r.pr;
      if (!p) throw new Error('cpatchTrace: curve cut without its crossing pair');
      w.byte(op);
      w.varint(r.i);
      w.varint(p.aj);
      w.varint(p.ak);
      w.varint(p.bj);
      w.varint(p.bk);
    } else if (r.op === 'own' || r.op === 'chord' || r.op === 'sub') {
      w.byte(op);
      w.varint(r.i);
    } else if (r.op === 'ear') {
      // n, then the pick: 0 = a run (e, N follow), 1 = a node split (index follows), 2 = none
      w.byte(op);
      w.varint(r.n);
      if (r.e !== undefined) {
        w.byte(0);
        w.varint(r.e);
        w.varint(r.N);
      } else if (r.split >= 0) {
        w.byte(1);
        w.varint(r.split);
      } else w.byte(2);
    } else w.byte(op);
  }
  return w;
}

export function decodeTrace(rd, end) {
  const out = [];
  while (rd.at < end) {
    const b0 = rd.byte(),
      op = OPS[b0 & 15];
    if (op === 'line') {
      const lk = b0 & 16 ? 1 : 0,
        past = b0 & 32 ? 1 : 0,
        tag = TAGS[rd.byte()];
      const i = rd.varint(),
        j = rd.varint();
      const r = { op, i, j, tag };
      if (lk) {
        r.lk = 1;
        r.past = past;
        r.point = [rd.f64(), rd.f64()];
      }
      out.push(r);
    } else if (op === 'norm') out.push({ op, k: rd.f64(), ox: rd.f64(), oy: rd.f64() });
    else if (op === 'split') out.push({ op, n: rd.varint(), parts: rd.varint() });
    else if (op === 'keep') out.push({ op, row: rd.varint() });
    else if (op === 'curve') {
      const i = rd.varint();
      out.push({
        op,
        i,
        pr: { aj: rd.varint(), ak: rd.varint(), bj: rd.varint(), bk: rd.varint() },
      });
    } else if (op === 'own' || op === 'chord' || op === 'sub') out.push({ op, i: rd.varint() });
    else if (op === 'ear') {
      const n = rd.varint(),
        kind = rd.byte();
      if (kind === 0) {
        const e = rd.varint();
        out.push({ op, n, e, N: rd.varint() });
      } else if (kind === 1) out.push({ op, n, split: rd.varint() });
      else out.push({ op, n, split: -1 });
    } else if (op) out.push({ op });
    else throw new Error('cpatchTrace: bad op byte ' + b0);
  }
  return out;
}

/// 64-bit FNV-1a of the conversion key, as two 32-bit halves; the bake's entry key.
export function traceKeyHash(key) {
  let h1 = 0x811c9dc5 >>> 0,
    h2 = 0xcbf29ce4 >>> 0;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
    h2 = (h2 ^ (h2 >>> 15)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/// A bake: Map(key -> entry) to bytes. Two kinds of entry, told apart by the key: a contour's
/// decision trace (key = cpatchConvKey of the contour, stored as its hash), and a SHAPE's graph
/// cuts -- the front end's intersection parameters per segment, `{ cuts }` -- under the key
/// 'g' + hash of the shape's curves. Entry: hash (8 bytes) | kind byte | body length | body.
export function encodeTraceBake(map) {
  const w = new ByteWriter();
  w.byte(67);
  w.byte(80);
  w.byte(84);
  w.byte(53); // 'CPT5' -- see the `norm`, `split` and `frame` notes at the top
  w.varint(map.size);
  for (const [key, val] of map) {
    const graph = key.length === 17 && key[0] === 'g';
    const raw = graph ? key.slice(1) : key;
    const h = raw.length === 16 && /^[0-9a-f]{16}$/.test(raw) ? raw : traceKeyHash(raw);
    for (let k = 0; k < 16; k += 2) w.byte(parseInt(h.slice(k, k + 2), 16));
    w.byte(graph ? 1 : 0);
    let body;
    if (graph) {
      const bw = new ByteWriter();
      bw.varint(val.cuts.length);
      for (const ts of val.cuts) {
        bw.varint(ts.length);
        for (const t of ts) bw.f64(t);
      }
      body = bw.done();
    } else body = encodeTrace(val).done();
    w.varint(body.length);
    w.bytes(body);
  }
  return w.done();
}

/// Bytes back to Map(hash -> trace, 'g' + hash -> { cuts }). The packer looks entries up by
/// traceKeyHash of the geometry it is about to convert.
export function decodeTraceBake(u8) {
  const rd = new ByteReader(u8);
  // 'CPT2' TO 'CPT5'. Each adds one op (`norm`, `split`, then `frame`) that no older bake can
  // contain, so reading an old bake is exact rather than best-effort. Writing is always the newest,
  // which an old reader refuses at the magic instead of mis-replaying a record it cannot read.
  const m0 = rd.byte(),
    m1 = rd.byte(),
    m2 = rd.byte(),
    m3 = rd.byte();
  if (m0 !== 67 || m1 !== 80 || m2 !== 84 || !(m3 >= 50 && m3 <= 53))
    throw new Error('cpatchTrace: not a bake');
  const n = rd.varint(),
    map = new Map();
  for (let e = 0; e < n; e++) {
    let h = '';
    for (let k = 0; k < 8; k++) h += rd.byte().toString(16).padStart(2, '0');
    const kind = rd.byte(),
      len = rd.varint(),
      end = rd.at + len;
    if (kind === 1) {
      const m = rd.varint(),
        cuts = [];
      for (let i = 0; i < m; i++) {
        const c = rd.varint(),
          ts = new Array(c);
        for (let k = 0; k < c; k++) ts[k] = rd.f64();
        cuts.push(ts);
      }
      map.set('g' + h, { cuts });
      rd.at = end;
    } else map.set(h, decodeTrace(rd, end));
  }
  return map;
}
