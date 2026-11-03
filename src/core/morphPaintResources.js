// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Destination-only styles retain destination-local resources while fading in.
export function prepareMorphDashes(src, dst, plan, meta, stride) {
  const source =
    src.dashFloats || (src.dashes ? new Float32Array(src.dashes) : new Float32Array(0));
  const target =
    dst.dashFloats || (dst.dashes ? new Float32Array(dst.dashes) : new Float32Array(0));
  const ids = new Map(),
    chunks = [source];
  for (let k = 0; k < plan.dstOnly.length; k++) {
    const id = dst.metaFloats[plan.dstOnly[k].dstIdx * stride + 15];
    if (!(Number.isInteger(id) && id > 0 && id * 64 <= target.length)) continue;
    if (!ids.has(id)) {
      ids.set(id, source.length / 64 + ids.size + 1);
      chunks.push(target.subarray((id - 1) * 64, id * 64));
    }
    meta[(src.numShapes + k) * stride + 15] = ids.get(id);
  }
  if (!source.length && !ids.size) return null;
  const out = new Float32Array(source.length + ids.size * 64);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out.buffer;
}

function imageRects(bundle, stride) {
  if (bundle.imageAtlasRects) return bundle.imageAtlasRects.map((r) => r.slice());
  const rects = [];
  for (let i = 0; i < bundle.numShapes; i++) {
    const off = i * stride,
      id = bundle.metaFloats[off + 35] || bundle.metaFloats[off + 47];
    if (id > 0) rects[id - 1] = Array.from(bundle.metaFloats.subarray(off + 40, off + 43));
  }
  return Array.from({ length: rects.length }, (_, i) => rects[i] || [0, 0, 0]);
}

export function prepareMorphImages(src, dst, plan, meta, stride, extraIds = []) {
  if (!src.imageAtlas && !src.secondaryImageAtlas && !dst.imageAtlas && !dst.secondaryImageAtlas)
    return {
      imageAtlas: null,
      imageAtlasDim: null,
      secondaryImageAtlas: null,
      secondaryImageAtlasDim: null,
      imageAtlasRects: null,
      imageAtlasSources: null,
      targetImageIds: new Map(),
    };
  const plane = (b, secondary) => {
    const data = secondary ? b.secondaryImageAtlas : b.imageAtlas;
    const dim = secondary ? b.secondaryImageAtlasDim : b.imageAtlasDim;
    return data && dim ? { data, dim } : null;
  };
  const planes = [plane(src, false), plane(src, true)],
    targetPlanes = new Map();
  const rects = imageRects(src, stride),
    sources = src.imageAtlasSources
      ? src.imageAtlasSources.slice()
      : new Array(rects.length).fill(0);
  if (!src.imageAtlasSources)
    for (let i = 0; i < src.numShapes; i++) {
      const off = i * stride;
      for (const slot of [35, 47])
        if (src.metaFloats[off + slot] > 0)
          sources[(src.metaFloats[off + slot] | 0) - 1] =
            Math.round(src.metaFloats[off + 43]) & 8 ? 1 : 0;
    }
  const same = (a, b) => {
    if (!a || !b || a.dim[0] !== b.dim[0] || a.dim[1] !== b.dim[1]) return false;
    if (a.data === b.data) return true;
    const x = new Uint8Array(a.data),
      y = new Uint8Array(b.data);
    if (x.length !== y.length) return false;
    const n = x.length & ~3,
      xx = new Uint32Array(x.buffer, x.byteOffset, n / 4),
      yy = new Uint32Array(y.buffer, y.byteOffset, n / 4);
    for (let i = 0; i < xx.length; i++) if (xx[i] !== yy[i]) return false;
    for (let i = n; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  };
  const select = (which) => {
    if (targetPlanes.has(which)) return targetPlanes.get(which);
    const p = plane(dst, which === 1);
    if (!p) throw new Error('mantle: destination morph image has no atlas');
    let index = planes.findIndex((x) => same(x, p));
    if (index < 0) {
      index = planes.findIndex((x) => !x);
      if (index < 0)
        throw new Error(
          'mantle: morph requires more than two independent image atlases; use imported endpoints',
        );
      planes[index] = p;
    }
    targetPlanes.set(which, index);
    return index;
  };
  const targetRects = imageRects(dst, stride),
    ids = new Map();
  const appendImage = (id) => {
    if (ids.has(id)) return ids.get(id);
    const sourceIndex = dst.imageAtlasSources?.[id - 1] === 1 ? 1 : 0,
      index = select(sourceIndex),
      rect = targetRects[id - 1];
    if (!rect) throw new Error('mantle: destination filter image has no atlas rectangle');
    rects.push(rect.slice());
    sources.push(index);
    ids.set(id, rects.length);
    return rects.length;
  };
  for (const id of extraIds) appendImage(id);
  for (let k = 0; k < plan.dstOnly.length; k++) {
    const off = (src.numShapes + k) * stride;
    if (!(meta[off + 35] > 0 || meta[off + 47] > 0)) continue;
    const sourceIndex = Math.round(meta[off + 43]) & 8 ? 1 : 0,
      index = select(sourceIndex);
    meta[off + 43] = (Math.round(meta[off + 43]) & ~8) | (index << 3);
    for (const slot of [35, 47]) {
      const id = meta[off + slot];
      if (!(id > 0)) continue;
      if (!ids.has(id)) {
        const rect = targetRects[id - 1] || Array.from(meta.subarray(off + 40, off + 43));
        rects.push(rect.slice());
        sources.push(index);
        ids.set(id, rects.length);
      }
      meta[off + slot] = ids.get(id);
    }
  }
  return {
    imageAtlas: planes[0] ? planes[0].data.slice(0) : null,
    imageAtlasDim: planes[0] ? planes[0].dim.slice() : null,
    secondaryImageAtlas: planes[1] ? planes[1].data.slice(0) : null,
    secondaryImageAtlasDim: planes[1] ? planes[1].dim.slice() : null,
    imageAtlasRects: rects.length ? rects : null,
    imageAtlasSources: sources.length ? sources : null,
    targetImageIds: ids,
  };
}
