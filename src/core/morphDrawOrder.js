// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Scene order is separate from stable metadata/curve row addresses.
export function prepareMorphDrawOrder(src, dst, plan, stride) {
  if (!plan.dstOnly.length) return null;
  const markers = (bundle) => {
    const out = [];
    for (let i = 0; i < bundle.numShapes; i++) {
      const flags = Math.round(bundle.metaFloats[i * stride + 27]);
      if (!(flags & 256) && flags & (64 | 128)) out.push(i);
    }
    return out;
  };
  const a = markers(src),
    b = markers(dst);
  if (!a.length || a.length !== b.length) return null;
  const toSource = new Map(plan.matched.map((m) => [m.dstIdx, m.srcIdx]));
  // Changing group topology needs a composition policy beyond carried groups.
  if (
    b.some(
      (row, i) =>
        toSource.get(row) !== a[i] ||
        (Math.round(dst.metaFloats[row * stride + 27]) & (64 | 128)) !==
          (Math.round(src.metaFloats[a[i] * stride + 27]) & (64 | 128)),
    )
  )
    return null;
  const n = src.numShapes + plan.dstOnly.length,
    end = n;
  const next = new Int32Array(n + 1),
    previous = new Int32Array(n + 1);
  for (let i = 0; i < src.numShapes; i++) {
    next[i] = i + 1;
    previous[i] = i - 1;
  }
  next[src.numShapes - 1] = end;
  previous[end] = src.numShapes - 1;
  plan.dstOnly.forEach((e, k) => toSource.set(e.dstIdx, src.numShapes + k));
  let head = 0,
    anchor = end;
  for (let j = dst.numShapes - 1; j >= 0; j--) {
    const row = toSource.get(j);
    if (row === undefined) continue;
    if (row >= src.numShapes) {
      const before = previous[anchor];
      if (before < 0) head = row;
      else next[before] = row;
      previous[row] = before;
      next[row] = anchor;
      previous[anchor] = row;
    }
    anchor = row;
  }
  const order = new Int32Array(n);
  let row = head;
  for (let i = 0; i < n; i++) {
    order[i] = row;
    row = next[row];
  }
  return order;
}

// Alias rows (morphBindings.js) are metadata-only layer rows: they follow the scene order.
export function extendMorphDrawOrder(order, total) {
  if (!order || order.length === total) return order;
  const out = new Int32Array(total);
  out.set(order);
  for (let i = order.length; i < total; i++) out[i] = i;
  return out;
}
