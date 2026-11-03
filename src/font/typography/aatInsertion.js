// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// The cursor partitions the logical glyph buffer into output and unread input.
// Moving that boundary retains numeric AAT marks without copying whole prefixes.
export function runAatInsertion(view, table, glyphs, source, reverse) {
  if (reverse) {
    glyphs.reverse();
    source.reverse();
  }
  let cursor = 0,
    mark = 0,
    state = 0;
  const guardMax = glyphs.length * 4 + 256;
  const moveTo = (position) => {
    if (position < 0 || position > glyphs.length) return false;
    cursor = position;
    return true;
  };
  const copyCurrent = () => {
    if (cursor >= glyphs.length) return;
    glyphs.splice(cursor, 0, glyphs[cursor]);
    source.splice(cursor, 0, source[cursor]);
    cursor++;
  };
  const skipCurrent = () => {
    if (cursor >= glyphs.length) return;
    glyphs.splice(cursor, 1);
    source.splice(cursor, 1);
  };
  const insert = (index, count) => {
    if (!count) return;
    const offset = table.actionOff + index * (table.indexScale ?? 2);
    const values = new Array(count);
    for (let k = 0; k < count; k++) values[k] = view.getUint16(offset + k * 2, false);
    const origin = source[Math.max(0, Math.min(cursor, source.length - 1))];
    glyphs.splice(cursor, 0, ...values);
    source.splice(cursor, 0, ...values.map(() => origin));
    cursor += count;
  };
  for (let guard = 0; guard < guardMax; guard++) {
    const atEnd = cursor >= glyphs.length;
    const cls = atEnd ? 0 : glyphs[cursor] === 0xffff ? 2 : table.classOf(glyphs[cursor]);
    const entry = table.classic
      ? view.getUint8(table.stateOff + state * table.nClasses + cls)
      : view.getUint16(table.stateOff + (state * table.nClasses + cls) * 2, false);
    const off = table.entryOff + entry * 8;
    const next = view.getUint16(off, false),
      flags = view.getUint16(off + 2, false);
    const current = view.getUint16(off + 4, false),
      marked = view.getUint16(off + 6, false);
    const markedCount = flags & 31,
      currentCount = (flags >> 5) & 31;
    const markLocation = cursor;
    if (marked !== (table.none ?? 0xffff) && markedCount) {
      const end = cursor,
        before = (flags & 0x0400) !== 0;
      if (!moveTo(mark)) break;
      if (!before) copyCurrent();
      insert(marked, markedCount);
      if (!before) skipCurrent();
      if (!moveTo(end + markedCount)) break;
    }
    if (flags & 0x8000) mark = markLocation;
    if (current !== (table.none ?? 0xffff) && currentCount) {
      const end = cursor,
        before = (flags & 0x0800) !== 0;
      if (!before) copyCurrent();
      insert(current, currentCount);
      if (!before) skipCurrent();
      if (!moveTo(end + (flags & 0x4000 ? 0 : currentCount))) break;
    }
    state = table.classic ? ((next - table.stateRelative) / table.nClasses) | 0 : next;
    if (atEnd) break;
    if (!(flags & 0x4000) && cursor < glyphs.length) cursor++;
  }
  if (reverse) {
    glyphs.reverse();
    source.reverse();
  }
}
