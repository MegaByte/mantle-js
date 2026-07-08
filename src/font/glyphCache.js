// glyphCache.js — LRU glyph cache.
//
// Caches {segs, metrics} per codepoint. Map iteration order is the
// LRU order; refresh on hit by delete+set (cheap on V8). Bounded by
// approximate byte cost (~96B per seg + 64B overhead).

export class MantleGlyphCache {
  constructor(byteBudget = 64 * 1024 * 1024) {
    this.byteBudget = byteBudget;
    this._bytes = 0;
    this._map = new Map();  // codepoint → { segs, metrics, byteCost }
  }

  tryGet(codepoint) {
    const e = this._map.get(codepoint);
    if (!e) return null;
    this._map.delete(codepoint);
    this._map.set(codepoint, e);
    return e;
  }

  put(codepoint, segs, metrics) {
    const cost = _approxCost(segs);
    this._map.set(codepoint, { segs, metrics, byteCost: cost });
    this._bytes += cost;
    while (this._bytes > this.byteBudget) {
      const oldest = this._map.keys().next();
      if (oldest.done) break;
      const k = oldest.value;
      const victim = this._map.get(k);
      this._map.delete(k);
      this._bytes -= victim.byteCost;
    }
  }

  clear() { this._map.clear(); this._bytes = 0; }
}

function _approxCost(segs) {
  if (!segs) return 0;
  return segs.length * 96 + 64;
}
