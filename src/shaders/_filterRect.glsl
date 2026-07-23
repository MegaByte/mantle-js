// Rect addressing for filter-graph passes.
//
// Every filter RT covers a RECT of the canvas — an origin and a size in canvas
// pixels, always 1:1 with them. A filter pass may crop or translate its output,
// never rescale it. Nothing in an SVG filter graph resamples.
//
// `vUV` is 0..1 across the OUTPUT, and that much is sound: the cover quad fills
// the viewport, and the viewport is the output. What is NOT sound is reusing it
// to sample an INPUT, because an input has its own rect. That conflation — "0..1
// across the viewport" read as "0..1 across the texture" — is what let a pool
// that rounded RTs up to a 32px bucket silently rescale every pass in the graph,
// compounding, each step a bilinear filter. Filtered shapes came out soft and
// upscaled and nothing in the pipeline was doing anything obviously wrong.
//
// So an input's uv is an explicit affine remap of vUV, supplied per input:
//
//   uInMap.xy = outRect.size / inRect.size
//   uInMap.zw = (outRect.origin - inRect.origin) / inRect.size
//   uvIn      = vUV * uInMap.xy + uInMap.zw
//
// Both rects the whole canvas → (1, 1, 0, 0), and uvIn is vUV bit-for-bit.
//
// A primitive is transparent black OUTSIDE its subregion (Filter Effects §7), so
// a tap landing off the input's rect must read 0 — not the clamped edge texel,
// which would smear the border outward. sampleIn masks instead of branching;
// with premultiplied RGBA, 0 is the identity every downstream operator wants.
vec2 mapIn(vec2 uv, vec4 m) {
  return uv * m.xy + m.zw;
}

vec4 sampleIn(sampler2D tex, vec2 uv) {
  vec2 s = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return texture(tex, uv) * (s.x * s.y);
}
