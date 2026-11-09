// SPDX-FileCopyrightText: 2026 Aaron Kaluszka
// SPDX-License-Identifier: Apache-2.0

// Per-item texture tables (meta: one row per shape; gradient, dash, filter: one row per record; override: one row per
// shape; mask row -> layer) cannot be plain `cols x N` textures, which stop existing at N = MAX_TEXTURE_SIZE (16384 on a desktop
// GPU, 4096 on much mobile hardware): createBundle would return normally, texImage2D raise GL 1281 and the bundle draw nothing.
//
// They wrap in BANDS. Row r lives in band `r >> TAB_SHIFT` at texel (col + cols * band, r & (TAB_H - 1)): the first
// TAB_H = 4096 rows are a plain `cols x min(N, 4096)` texture, and every further 4096 rows are a `cols`-wide strip appended to
// its right. A table of <= 4096 rows is therefore laid out exactly as a plain table (same dimensions, same bytes), so everything
// that fits is untouched, and a taller table needs `cols * ceil(N / 4096)` columns, not rows. 4096 is the one height every
// WebGL 2 device the renderer supports already provides (the curve/band planes are 4096 wide). The shaders address rows with
// metaAt / gradAt / dashAt / filterAt / ovAt / mrlAt (_bundleLayout.glsl): a shift, a mask and a multiply-add by constants.
//
// The CPU sections (the wire contract) are untouched: this is GPU upload addressing only.
export const TAB_SHIFT = 12;
export const TAB_H = 1 << TAB_SHIFT;

/// Texels per row of each table (the shader's `cols`).
export const META_COLS = 12,
  GRAD_COLS = 4,
  DASH_COLS = 16,
  FILTER_COLS = 6,
  OVERRIDE_COLS = 6,
  MRL_COLS = 2;

/// The device's MAX_TEXTURE_SIZE; 16384 when the context cannot say (stubs). A test caps it by wrapping getParameter.
export function maxTextureSize(gl) {
  try {
    const v = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (Number.isFinite(v) && v > 0) return v | 0;
  } catch {
    /* stub context */
  }
  return 16384;
}

/// Width and height of the texture that holds `n` rows of `cols` texels.
export function tableDims(cols, n) {
  const rows = Math.max(1, n | 0),
    bands = Math.ceil(rows / TAB_H);
  return { w: cols * bands, h: Math.min(rows, TAB_H), bands };
}

/// Most rows a table of `cols` texels per row can hold under `limit`.
export function tableCapacity(cols, limit) {
  return limit < TAB_H ? 0 : TAB_H * Math.floor(limit / cols);
}

/// Throw (naming the table, the count and the limit) when `n` rows cannot be stored. Nothing is allocated before this runs.
export function checkTableFits(gl, name, cols, n, who = 'createBundle') {
  const limit = maxTextureSize(gl);
  if (limit < TAB_H) {
    throw new Error(
      `${who}: this device's MAX_TEXTURE_SIZE is ${limit}; the renderer needs at least ${TAB_H} (the ${name} cannot be stored)`,
    );
  }
  const cap = tableCapacity(cols, limit);
  if (n > cap) {
    throw new Error(
      `${who}: the ${name} has ${n} rows but this device (MAX_TEXTURE_SIZE ${limit}) can store at most ${cap}; ` +
        `split the art into several bundles`,
    );
  }
}

/// Throw when a plain `w x h` texture would exceed the device limit (curve/band planes, image atlases).
export function checkPlaneFits(gl, name, w, h, who = 'createBundle') {
  const limit = maxTextureSize(gl);
  if (w > limit || h > limit) {
    throw new Error(
      `${who}: the ${name} needs a ${w} x ${h} texture but this device's MAX_TEXTURE_SIZE is ${limit}`,
    );
  }
}

/// True when a `w x h` texture fits the device. For builds that can DECLINE (the CPatch curve-plane extension, the blend planes):
/// they test this before allocating and take their documented decline instead of a GL error and a blank draw.
export function planeFits(gl, w, h) {
  const limit = maxTextureSize(gl);
  return w <= limit && h <= limit;
}

/// The device's MAX_ARRAY_TEXTURE_LAYERS; 256 (the WebGL 2 minimum) when the context cannot say. Read once per context: every bundle
/// handle checks it, and Safari answers each read with a round trip to its GPU process (1.6 ms; 1.3 s of a replay's loading call).
/// Only an answer is kept: a lost context reads null, and the same context object, restored, has its real limit.
const _arrayLayers = new WeakMap();
export function maxArrayLayers(gl) {
  const known = gl && typeof gl === 'object' ? _arrayLayers.get(gl) : undefined;
  if (known !== undefined) return known;
  try {
    const v = gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS);
    if (Number.isFinite(v) && v > 0) {
      _arrayLayers.set(gl, v | 0);
      return v | 0;
    }
  } catch {
    /* stub context */
  }
  return 256;
}

/// Throw (naming what is counted, the count and the limit) when `n` layers of a 2D texture array cannot be allocated.
export function checkLayersFit(gl, name, n, who = 'drawBundle') {
  const limit = maxArrayLayers(gl);
  if (n > limit) {
    throw new Error(
      `${who}: the bundle has ${n} ${name} but this device (MAX_ARRAY_TEXTURE_LAYERS ${limit}) can bake at most ${limit}; ` +
        'split the art into several bundles',
    );
  }
}

/// Texel position of column `col` of row `row`.
export function tableTexel(cols, col, row) {
  return [col + cols * (row >> TAB_SHIFT), row & (TAB_H - 1)];
}

/// texSubImage2D of rows lo..hi (inclusive) of a table. `src` is the rows lo..hi, row-major, `cols * 4` floats (or `elemPerRow`
/// bytes of any typed array) each. The bound texture is the table. One call per band the span touches.
export function uploadTableRows(
  gl,
  cols,
  lo,
  hi,
  src,
  format = gl.RGBA,
  type = gl.FLOAT,
  perRow = cols * 4,
) {
  if (hi < lo) return;
  for (let r = lo; r <= hi;) {
    const band = r >> TAB_SHIFT,
      last = Math.min(hi, ((band + 1) << TAB_SHIFT) - 1),
      rows = last - r + 1;
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      cols * band,
      r & (TAB_H - 1),
      cols,
      rows,
      format,
      type,
      src.subarray((r - lo) * perRow, (last - lo + 1) * perRow),
    );
    r = last + 1;
  }
}

/// The table's `n` rows as the wrapped plane (`w * h * 4` floats), for a consumer that wants whole planes (the morph lerp target).
/// A table of <= 4096 rows is returned as is.
export function packTable(data, cols, n) {
  const { w, h, bands } = tableDims(cols, n);
  if (bands === 1) return data;
  const out = new Float32Array(w * h * 4),
    rowF = cols * 4;
  for (let r = 0; r < n; r++) {
    const o = ((r & (TAB_H - 1)) * w + cols * (r >> TAB_SHIFT)) * 4;
    out.set(data.subarray(r * rowF, (r + 1) * rowF), o);
  }
  return out;
}
