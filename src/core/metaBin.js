// metaBin.js — gl-free meta-section parsing.
//
// Kept separate from the GL pipeline so the no-WebGL fallback (which needs
// parseMetaBin for its morph adapter) doesn't transitively import the
// texture-upload code in bundle.js. ZERO imports and no side effects, so it
// tree-shakes cleanly into either the GL or the native build.
//
// renderer/bundle.js re-exports parseMetaBin from here.

export const META_STRIDE_V2 = 24;   // v2 meta record stride (floats/shape)

/**
 * Parse a meta-section ArrayBuffer into { numShapes, globalBBox,
 * metaFloats, floatsPerShape }. Auto-derives floats-per-shape from the
 * section size when the record was extended (v3+ = 48 floats).
 *
 * @param {ArrayBuffer} buf
 * @param {number} [floatsPerShape]  default META_STRIDE_V2
 */
export function parseMetaBin(buf, floatsPerShape) {
  floatsPerShape = floatsPerShape || META_STRIDE_V2;
  // Empty meta = zero-shape bundle (placeholder asset, empty overlay,
  // etc.). Synthesize a header-equivalent result instead of throwing;
  // the downstream texture builders + draw loop both skip when
  // numShapes === 0.
  if (buf.byteLength === 0) {
    return {
      numShapes: 0,
      globalBBox: [0, 0, 0, 0],
      metaFloats: new Float32Array(0),
      floatsPerShape,
    };
  }
  const dv = new DataView(buf);
  if (buf.byteLength < 32) throw new Error('meta.bin too small');
  const n = dv.getUint32(0, true);
  const gbb = [dv.getFloat32(4, true), dv.getFloat32(8, true),
               dv.getFloat32(12, true), dv.getFloat32(16, true)];
  // Auto-derive floats-per-shape from the actual section size when
  // possible. Bundle authors may extend the meta record (e.g. v3+1 with
  // 48 floats); self-description via section size avoids needing a new
  // bundle version for additive layout changes.
  if (n > 0) {
    const inferred = (buf.byteLength - 32) / (n * 4);
    if (Number.isInteger(inferred) && inferred >= floatsPerShape) {
      floatsPerShape = inferred;
    }
  }
  const need = 32 + n * floatsPerShape * 4;
  if (buf.byteLength < need)
    throw new Error('meta.bin size mismatch: got ' + buf.byteLength + ', need ≥' + need);
  const metaFloats = new Float32Array(buf, 32, n * floatsPerShape);
  return { numShapes: n, globalBBox: gbb, metaFloats, floatsPerShape };
}
