// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

const queue = () => ({ slots: [], future: 0, parked: 0 });

function next(q, cursor, frame) {
  if (!q) return null;
  while (
    q.future < q.slots.length &&
    (q.slots[q.future].position < cursor || q.slots[q.future].seenFrame === frame)
  )
    q.future++;
  while (q.parked < q.future && q.slots[q.parked].seenFrame === frame) q.parked++;
  return q.slots[q.future] || (q.parked < q.future ? q.slots[q.parked] : null);
}

// Index unused slots in draw order. Monotonic queue cursors keep matching
// linear across reorders, source changes and duplicate draws.
export function createSlotIndex(slots, frame, start = 0) {
  const kinds = new Map();
  for (let i = start; i < slots.length; i++) {
    const s = slots[i];
    if (s.seenFrame === frame) continue;
    s.position = i;
    let keys = kinds.get(s.kind);
    if (!keys) kinds.set(s.kind, (keys = new Map()));
    let q = keys.get(s.key);
    if (!q) keys.set(s.key, (q = queue()));
    if (s.streamSource) {
      const sources = q.sources || (q.sources = new Map());
      let stream = sources.get(s.streamSource);
      if (!stream) sources.set(s.streamSource, (stream = queue()));
      q = stream;
    }
    q.slots.push(s);
  }
  return (key, kind, source, cursor) => {
    const q = kinds.get(kind)?.get(key);
    const plain = next(q, cursor, frame);
    if (!source) return plain;
    const stream = next(q?.sources?.get(source), cursor, frame);
    if (!plain) return stream;
    if (!stream) return plain;
    // A matching slot ahead takes precedence over one already stepped over.
    if ((plain.position < cursor) !== (stream.position < cursor))
      return plain.position >= cursor ? plain : stream;
    return plain.position < stream.position ? plain : stream;
  };
}
